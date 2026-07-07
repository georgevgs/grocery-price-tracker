/**
 * Local price scrape — the residential-IP counterpart of the Worker's
 * runScrape (apps/worker/src/scrape.ts).
 *
 * WHY THIS EXISTS: the retailers' bot protection (Akamai on AB, a WAF on
 * Sklavenitis, a CDN on Kritikos) blocks Cloudflare's Worker egress IPs,
 * so the deployed cron gets 403/503 from them. The exact same requests
 * succeed from a residential IP. This script runs the scrape from THIS
 * machine — outbound fetches leave over your home connection, not
 * Cloudflare's edge — and reads/writes the *remote* D1 through wrangler
 * (already authenticated), so production data stays the single source of
 * truth. Cloudflare keeps hosting the PWA and read API; only the fetching
 * moves here.
 *
 * It reuses the adapters and the worker's pure helpers (unit-price sanity,
 * failure classification) verbatim, so behaviour matches the cron exactly.
 *
 *   npm run scrape:local --workspace apps/worker                # scrape + write
 *   npm run scrape:local --workspace apps/worker -- --dry-run   # fetch only
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RetailerId } from '@grocery/core/types';
import { adapterRegistry } from '@grocery/scrapers/registry';
import { buildCatalogIndex, type KritikosCatalogEntry } from '@grocery/scrapers/kritikos';
import { buildAbCatalogIndex, type AbCatalogEntry } from '@grocery/scrapers/ab';
import { scrapeFailureOutcome, unitPriceSanityWarning } from '../src/scrape';

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE = 'grocery-prices';
const CONCURRENCY = 4;
const DRY_RUN = process.argv.includes('--dry-run');

const TARGET_QUERY =
  `SELECT l.id, l.retailer, l.url, p.id AS product_id, ` +
  `p.brand AS product_brand, p.title AS product_title, p.image_url AS product_image ` +
  `FROM retailer_listings l JOIN products p ON p.id = l.product_id`;

interface TargetRow {
  id: number;
  retailer: string;
  url: string;
  product_id: number;
  product_brand: string;
  product_title: string;
  product_image: string | null;
}

interface PriceWrite {
  listingId: number;
  pricePiece: number | null;
  priceUnit: number | null;
  unitLabel: string | null;
}

interface ImageBackfill {
  productId: number;
  imageUrl: string;
}

/** Shelf prices belong to the shopper's Athens day, not UTC's — matches the Worker. */
const athensDate = (): string => {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Athens' });
};

/**
 * Run wrangler against the remote D1. cwd is the worker dir so it picks up
 * wrangler.toml; stderr is inherited so its banners/warnings land in the log.
 */
const wrangler = (args: readonly string[]): string => {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: WORKER_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
};

/** wrangler --json prints the query result; tolerate any leading banner text. */
const parseWranglerJson = (raw: string): unknown => {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');

  if (-1 === start || -1 === end || end < start) {
    throw new Error(`wrangler did not return JSON:\n${raw.slice(0, 500)}`);
  }

  return JSON.parse(raw.slice(start, end + 1));
};

const loadTargets = (): TargetRow[] => {
  const raw = wrangler(['d1', 'execute', DATABASE, '--remote', '--json', '--command', TARGET_QUERY]);
  const parsed = parseWranglerJson(raw);
  const results = Array.isArray(parsed) ? parsed[0]?.results : undefined;

  if (false === Array.isArray(results)) {
    throw new Error('unexpected wrangler d1 output shape (expected [{ results: [...] }])');
  }

  return results as TargetRow[];
};

/** Bounded-concurrency map — gentler on the retailers than the Worker's unbounded fan-out. */
const mapPool = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

interface Outcome {
  price?: PriceWrite;
  image?: ImageBackfill;
  error?: string;
  warning?: string;
}

const scrapeOne = async (target: TargetRow): Promise<Outcome> => {
  const adapter = adapterRegistry.get(target.retailer as RetailerId);

  if (undefined === adapter) {
    return { error: `listing ${target.id}: no adapter for retailer "${target.retailer}"` };
  }

  try {
    const scraped = await adapter.scrapeProduct(target.url, fetch, {
      productTitle: `${target.product_brand} ${target.product_title}`.trim(),
      productBrand: target.product_brand,
    });

    const price: PriceWrite = {
      listingId: target.id,
      pricePiece: scraped.pricePiece,
      priceUnit: scraped.priceUnit,
      unitLabel: scraped.unitLabel,
    };

    // Backfill the product shot the first time a listing exposes one — same
    // IS NULL guard as the Worker, so a manual/earlier image is never lost.
    const image: ImageBackfill | undefined =
      null === target.product_image && 'string' === typeof scraped.imageUrl && 0 < scraped.imageUrl.length
        ? { productId: target.product_id, imageUrl: scraped.imageUrl }
        : undefined;

    const warning = unitPriceSanityWarning(
      { id: target.id, retailer: target.retailer, product_title: target.product_title },
      scraped,
    );

    return undefined === warning ? { price, image } : { price, image, warning };
  } catch (error) {
    return scrapeFailureOutcome(target.id, error);
  }
};

// --- SQL literal builders (D1's CLI has no bind params, so escape by hand) ---

/** Replace control chars (newlines, NUL) with spaces so a scraped value can't break the .sql file. */
const clean = (value: string): string => {
  let out = '';

  for (const ch of value) {
    const code = ch.charCodeAt(0);
    out += 32 > code || 127 === code ? ' ' : ch;
  }

  return out;
};

const sqlStr = (value: string | null): string => {
  return null === value ? 'NULL' : `'${clean(value).replace(/'/g, "''")}'`;
};

const sqlNum = (value: number | null): string => {
  return null === value || false === Number.isFinite(value) ? 'NULL' : String(value);
};

const buildSql = (
  prices: readonly PriceWrite[],
  images: readonly ImageBackfill[],
  scrapedDate: string,
  scrapedAt: string,
): string => {
  const statements: string[] = [];

  for (const p of prices) {
    statements.push(
      `INSERT OR REPLACE INTO price_history ` +
        `(listing_id, scraped_date, scraped_at, price_piece, price_unit, unit_label) VALUES (` +
        `${p.listingId}, ${sqlStr(scrapedDate)}, ${sqlStr(scrapedAt)}, ` +
        `${sqlNum(p.pricePiece)}, ${sqlNum(p.priceUnit)}, ${sqlStr(p.unitLabel)});`,
    );
  }

  for (const img of images) {
    statements.push(
      `UPDATE products SET image_url = ${sqlStr(img.imageUrl)} ` +
        `WHERE id = ${img.productId} AND image_url IS NULL;`,
    );
  }

  return statements.join('\n');
};

const writeResults = (sql: string): void => {
  const file = join(mkdtempSync(join(tmpdir(), 'grocery-scrape-')), 'write.sql');
  writeFileSync(file, sql, 'utf8');
  wrangler(['d1', 'execute', DATABASE, '--remote', '--file', file]);
};

// --- Kritikos catalog index -------------------------------------------------
//
// Kritikos ships no server-side search, so the edge can't scan its ~29 MB
// catalog within the Workers CPU budget (see apps/worker/schema.sql). This job
// runs from a residential IP with no such limit: fetch the catalog once, flatten
// it (buildCatalogIndex reuses the adapter's parsing), and mirror it into the
// kritikos_catalog table so the edge can answer a search with a cheap LIKE.

/** ~29 MB of INSERTs won't fit one D1 request; upload in modest batches. */
const CATALOG_INDEX_CHUNK = 200;

const catalogInsert = (entry: KritikosCatalogEntry, indexedAt: string): string => {
  // Pipe-delimit barcodes (|a|b|) so the edge can match an EAN hint exactly
  // via LIKE '%|<ean>|%' without one barcode's digits bleeding into another's.
  const barcodes = 0 < entry.barcodes.length ? `|${entry.barcodes.join('|')}|` : '';

  return (
    'INSERT OR REPLACE INTO kritikos_catalog ' +
    '(sku, name, url, haystack, barcodes, ean, price_piece, price_unit, unit_label, image_url, indexed_at) ' +
    `VALUES (${sqlStr(entry.sku)}, ${sqlStr(entry.name)}, ${sqlStr(entry.url)}, ${sqlStr(entry.haystack)}, ` +
    `${sqlStr(barcodes)}, ${sqlStr(entry.ean)}, ${sqlNum(entry.pricePiece)}, ${sqlNum(entry.priceUnit)}, ` +
    `${sqlStr(entry.unitLabel)}, ${sqlStr(entry.imageUrl)}, ${sqlStr(indexedAt)});`
  );
};

const writeCatalogIndex = (entries: readonly KritikosCatalogEntry[], indexedAt: string): void => {
  const statements = entries.map((entry) => catalogInsert(entry, indexedAt));

  for (let start = 0; start < statements.length; start += CATALOG_INDEX_CHUNK) {
    const chunk = statements.slice(start, start + CATALOG_INDEX_CHUNK);
    writeResults(chunk.join('\n'));
    console.log(`[scrape-local]   indexed ${Math.min(start + chunk.length, statements.length)}/${statements.length}`);
  }

  // Prune products that dropped out of the catalog: this run stamped every
  // current row with indexedAt, so anything older wasn't re-touched. Runs only
  // after every insert chunk succeeded (execFileSync throws otherwise), so a
  // mid-run failure can never delete live rows.
  writeResults(`DELETE FROM kritikos_catalog WHERE indexed_at < ${sqlStr(indexedAt)};`);
};

const runCatalogIndex = async (indexedAt: string): Promise<void> => {
  // Fully self-contained: any failure here (catalog fetch, a chunk upload) is
  // logged and swallowed so it can never sink the price scrape that already ran
  // or mark the job fatal — the edge just keeps serving the previous index.
  try {
    console.log('[scrape-local] building Kritikos catalog index...');
    const entries = await buildCatalogIndex(fetch);
    console.log(`[scrape-local] Kritikos catalog: ${entries.length} product(s)`);

    if (DRY_RUN) {
      const sample = entries.slice(0, 3).map((entry) => `  - ${entry.sku} ${entry.name}`).join('\n');
      console.log(`[scrape-local] dry run — would index ${entries.length} Kritikos product(s):\n${sample}`);
      return;
    }

    if (0 === entries.length) {
      // Never prune against an empty parse — that would wipe the whole index.
      console.log('[scrape-local] Kritikos catalog came back empty — leaving the existing index in place.');
      return;
    }

    writeCatalogIndex(entries, indexedAt);
    console.log('[scrape-local] Kritikos catalog index updated.');
  } catch (error) {
    console.error(
      `[scrape-local] Kritikos catalog index failed (prices unaffected): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

// --- AB catalog index -------------------------------------------------------
//
// AB blocks Cloudflare's edge (403) AND its API is unreachable through the proxy,
// so the edge could only reach AB via the paid Scrape.do render tier. This
// residential job reaches AB's GraphQL directly and free, so — exactly like the
// Kritikos index above — it crawls AB's whole catalog once a day into ab_catalog,
// and the edge answers AB search with a cheap LIKE (searchAbCatalog in index.ts).
// Same batched-upsert-then-prune-stale contract; same self-contained try/catch so
// an AB failure never sinks the price scrape or the Kritikos index.

const AB_CATALOG_CHUNK = 200;

const abCatalogInsert = (entry: AbCatalogEntry, indexedAt: string): string => {
  return (
    'INSERT OR REPLACE INTO ab_catalog ' +
    '(sku, name, url, haystack, brand, price_piece, price_unit, unit_label, image_url, indexed_at) ' +
    `VALUES (${sqlStr(entry.sku)}, ${sqlStr(entry.name)}, ${sqlStr(entry.url)}, ${sqlStr(entry.haystack)}, ` +
    `${sqlStr(entry.brand)}, ${sqlNum(entry.pricePiece)}, ${sqlNum(entry.priceUnit)}, ` +
    `${sqlStr(entry.unitLabel)}, ${sqlStr(entry.imageUrl)}, ${sqlStr(indexedAt)});`
  );
};

const writeAbCatalogIndex = (entries: readonly AbCatalogEntry[], indexedAt: string): void => {
  const statements = entries.map((entry) => abCatalogInsert(entry, indexedAt));

  for (let start = 0; start < statements.length; start += AB_CATALOG_CHUNK) {
    const chunk = statements.slice(start, start + AB_CATALOG_CHUNK);
    writeResults(chunk.join('\n'));
    console.log(`[scrape-local]   indexed ${Math.min(start + chunk.length, statements.length)}/${statements.length} (ab)`);
  }

  // Same prune-stale as the Kritikos index: this run stamped every current row
  // with indexedAt, so anything older dropped out of the catalog. Runs only after
  // every insert chunk succeeded (execFileSync throws otherwise).
  writeResults(`DELETE FROM ab_catalog WHERE indexed_at < ${sqlStr(indexedAt)};`);
};

const runAbCatalogIndex = async (indexedAt: string): Promise<void> => {
  try {
    console.log('[scrape-local] building AB catalog index...');
    const entries = await buildAbCatalogIndex(fetch);
    console.log(`[scrape-local] AB catalog: ${entries.length} product(s)`);

    if (DRY_RUN) {
      const sample = entries.slice(0, 3).map((entry) => `  - ${entry.sku} ${entry.name}`).join('\n');
      console.log(`[scrape-local] dry run — would index ${entries.length} AB product(s):\n${sample}`);
      return;
    }

    if (0 === entries.length) {
      // Never prune against an empty crawl — that would wipe the whole index.
      console.log('[scrape-local] AB catalog came back empty — leaving the existing index in place.');
      return;
    }

    writeAbCatalogIndex(entries, indexedAt);
    console.log('[scrape-local] AB catalog index updated.');
  } catch (error) {
    console.error(
      `[scrape-local] AB catalog index failed (prices unaffected): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/** Write today's prices and image backfills — no-op when there's nothing to write. */
const writePrices = (
  prices: readonly PriceWrite[],
  images: readonly ImageBackfill[],
  scrapedDate: string,
  scrapedAt: string,
): void => {
  if (0 === prices.length && 0 === images.length) {
    console.log('[scrape-local] nothing to write.');
    return;
  }

  const sql = buildSql(prices, images, scrapedDate, scrapedAt);

  if (DRY_RUN) {
    console.log(`[scrape-local] dry run — would run ${prices.length + images.length} statement(s):\n${sql}`);
    return;
  }

  console.log(`[scrape-local] writing ${prices.length + images.length} statement(s) to remote D1...`);
  writeResults(sql);
  console.log('[scrape-local] done.');
};

const main = async (): Promise<void> => {
  console.log(`[scrape-local] loading targets from remote D1${DRY_RUN ? ' (dry run)' : ''}...`);
  const targets = loadTargets();
  console.log(`[scrape-local] ${targets.length} listing(s) to scrape (concurrency ${CONCURRENCY})`);

  const scrapedDate = athensDate();
  const scrapedAt = new Date().toISOString();

  const outcomes = await mapPool(targets, CONCURRENCY, scrapeOne);

  const prices = outcomes.map((o) => o.price).filter((p): p is PriceWrite => undefined !== p);
  const images = outcomes.map((o) => o.image).filter((i): i is ImageBackfill => undefined !== i);
  const errors = outcomes.map((o) => o.error).filter((e): e is string => undefined !== e);
  const warnings = outcomes.map((o) => o.warning).filter((w): w is string => undefined !== w);

  console.log(
    `[scrape-local] ${prices.length} priced, ${errors.length} failed, ${warnings.length} suspect`,
  );
  for (const warning of warnings) {
    console.warn(`  ! ${warning}`);
  }
  for (const error of errors) {
    console.error(`  x ${error}`);
  }

  writePrices(prices, images, scrapedDate, scrapedAt);

  // The catalog indexes are discovery data, independent of the tracked listings
  // above, so they rebuild every run regardless of whether any price was written.
  // Each is self-contained (its own try/catch), so one failing never sinks the
  // other or the prices already written.
  await runCatalogIndex(scrapedAt);
  await runAbCatalogIndex(scrapedAt);
};

main().catch((error: unknown) => {
  console.error('[scrape-local] fatal:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

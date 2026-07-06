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

main().catch((error: unknown) => {
  console.error('[scrape-local] fatal:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

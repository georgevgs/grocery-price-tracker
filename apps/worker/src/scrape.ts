import type { RetailerId, ScrapedListing } from '@grocery/core/types';
import { extractSize } from '@grocery/core/normalize';
import { withPoliteness } from '@grocery/scrapers/polite';
import { adapterRegistry } from '@grocery/scrapers/registry';
import { ListingGoneError } from '@grocery/scrapers/types';

export interface Env {
  DB: D1Database;
  /**
   * Optional shared secret. When set (wrangler secret), every mutating
   * API route requires it as a Bearer token; unset leaves the guard inert
   * so existing deployments keep working. See the guard in index.ts.
   */
  WRITE_TOKEN?: string;
}

/**
 * Politeness budget for LIVE edge fetches (interactive search, resolve-url,
 * scrape/run): a short timeout and a single retry keep interactive latency
 * bounded while still absorbing a transient 5xx or WAF-scoring hiccup —
 * Cloudflare's shared egress IPs are reputation-scored, so one jittered,
 * delayed re-attempt beats an instant re-hit that feeds the score.
 */
export const edgeFetch = withPoliteness(fetch, {
  timeoutMs: 10_000,
  retries: 1,
  baseDelayMs: 400,
  forbiddenDelayMs: 1_000,
});

interface ListingRow {
  id: number;
  retailer: string;
  retailer_sku: string;
  url: string;
  product_id: number;
  product_brand: string;
  product_title: string;
  product_image: string | null;
}

export interface ScrapeRunResult {
  ok: number;
  failed: number;
  errors: string[];
  /** Recorded prices that look wrong (unit-price sanity) — not failures. */
  warnings: string[];
}

/**
 * Live edge fetches run at most this many at once. The old unbounded
 * Promise.all fired every listing simultaneously from one shared egress IP —
 * exactly the burst shape retailer WAFs rate-score — and it also diverged from
 * the local job's politeness (its pool of 4). Same bound on both paths.
 */
const EDGE_SCRAPE_CONCURRENCY = 4;

/** Bounded-concurrency map — mirrors the local scrape's pool. */
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

export const runScrape = async (env: Env): Promise<ScrapeRunResult> => {
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.retailer, l.retailer_sku, l.url, p.id AS product_id,
            p.brand AS product_brand, p.title AS product_title, p.image_url AS product_image
     FROM retailer_listings l
     JOIN products p ON p.id = l.product_id`,
  ).all<ListingRow>();

  const scrapedDate = athensDate();
  const scrapedAt = new Date().toISOString();

  const outcomes = await mapPool(results, EDGE_SCRAPE_CONCURRENCY, (listing) =>
    scrapeOne(env, listing, scrapedDate, scrapedAt),
  );

  const errors = outcomes
    .map((outcome) => outcome.error)
    .filter((error): error is string => undefined !== error);
  const warnings = outcomes
    .map((outcome) => outcome.warning)
    .filter((warning): warning is string => undefined !== warning);

  // errors[] only reaches the caller's JSON response; mirror them to the log
  // so Workers Logs can attribute which chain fails (and how often) without
  // anyone watching the UI.
  for (const error of errors) {
    console.error(`[scrape] ${error}`);
  }
  for (const warning of warnings) {
    console.warn(`[scrape] ${warning}`);
  }

  return {
    ok: outcomes.length - errors.length,
    failed: errors.length,
    errors,
    warnings,
  };
};

/**
 * Shelf prices belong to the shopper's calendar day, not UTC's —
 * the 05:15 UTC cron runs at 07:15/08:15 in Greece.
 */
export const athensDate = (): string => {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Athens' });
};

export interface ScrapeOutcome {
  error?: string;
  warning?: string;
}

/**
 * Chains whose WAF/CDN blocks Cloudflare's egress IPs (403/503 on every edge
 * fetch) — a live scrape from here is a GUARANTEED failure, so their prices
 * come from the D1 catalog indexes the off-edge daily crawl maintains instead.
 * The row is at most a day old — the same freshness the daily scrape gives.
 */
const CATALOG_PRICED: ReadonlySet<RetailerId> = new Set<RetailerId>(['ab', 'kritikos']);

interface CatalogPriceRow {
  name: string;
  price_piece: number | null;
  price_unit: number | null;
  unit_label: string | null;
  image_url: string | null;
}

/**
 * Price one edge-blocked listing from its chain's catalog index. Throws (like
 * an adapter would) when the SKU isn't indexed — delisted, or the daily crawl
 * hasn't seen it yet — or when the table itself is missing/unmigrated, so the
 * failure surfaces in errors[] instead of writing nothing silently.
 */
const scrapeFromCatalog = async (env: Env, listing: ListingRow): Promise<ScrapedListing> => {
  const table = 'ab' === listing.retailer ? 'ab_catalog' : 'kritikos_catalog';

  let row: CatalogPriceRow | null;

  try {
    row =
      (await env.DB.prepare(
        `SELECT name, price_piece, price_unit, unit_label, image_url FROM ${table} WHERE sku = ?`,
      )
        .bind(listing.retailer_sku)
        .first<CatalogPriceRow>()) ?? null;
  } catch {
    throw new Error(`[${listing.retailer}] catalog index table missing — run the daily scrape once to build it`);
  }

  if (null === row) {
    throw new Error(
      `[${listing.retailer}] sku ${listing.retailer_sku} not in the catalog index — ` +
        'delisted, or not yet crawled by the daily scrape',
    );
  }

  return {
    name: row.name,
    sku: listing.retailer_sku,
    pricePiece: row.price_piece,
    priceUnit: row.price_unit,
    unitLabel: row.unit_label,
    imageUrl: row.image_url,
  };
};

const scrapeOne = async (
  env: Env,
  listing: ListingRow,
  scrapedDate: string,
  scrapedAt: string,
): Promise<ScrapeOutcome> => {
  const adapter = adapterRegistry.get(listing.retailer as RetailerId);

  if (undefined === adapter) {
    return { error: `listing ${listing.id}: no adapter for retailer "${listing.retailer}"` };
  }

  try {
    // Same query shape as discovery — titles alone ("Light σε φέτες
    // 175g") are too generic for the AB search to surface the SKU.
    const scraped = CATALOG_PRICED.has(adapter.id)
      ? await scrapeFromCatalog(env, listing)
      : await adapter.scrapeProduct(listing.url, edgeFetch, {
          productTitle: `${listing.product_brand} ${listing.product_title}`.trim(),
          productBrand: listing.product_brand,
        });

    const priceError = missingPriceError(listing.id, listing.retailer, scraped);

    if (undefined !== priceError) {
      return { error: priceError };
    }

    await env.DB.prepare(
      'INSERT OR REPLACE INTO price_history ' +
        '(listing_id, scraped_date, scraped_at, price_piece, price_unit, unit_label) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        listing.id,
        scrapedDate,
        scrapedAt,
        scraped.pricePiece,
        scraped.priceUnit,
        scraped.unitLabel,
      )
      .run();

    // Backfill the product shot the first time any listing exposes one —
    // covers the chains (My Market, Lidl) whose search tiles carry no
    // image, so their image only surfaces on the product page. Guarded on
    // IS NULL so a manual/earlier image is never overwritten.
    if (
      null === listing.product_image &&
      'string' === typeof scraped.imageUrl &&
      0 < scraped.imageUrl.length
    ) {
      await env.DB.prepare(
        'UPDATE products SET image_url = ? WHERE id = ? AND image_url IS NULL',
      )
        .bind(scraped.imageUrl, listing.product_id)
        .run();
    }

    const warning = unitPriceSanityWarning(listing, scraped);

    return undefined === warning ? {} : { warning };
  } catch (error) {
    return scrapeFailureOutcome(listing.id, error);
  }
};

/**
 * A vanished page is listing lifecycle, not a scrape fault — Lidl promo
 * pages die when the offer week ends. Those become warnings (the listing
 * wants unlinking); everything else stays a failure.
 */
export const scrapeFailureOutcome = (listingId: number, error: unknown): ScrapeOutcome => {
  if (error instanceof ListingGoneError) {
    return {
      warning:
        `listing ${listingId} (${error.retailer}): page gone — offer likely ended; ` +
        'unlink the listing to stop tracking it',
    };
  }

  if (error instanceof Error) {
    return { error: `listing ${listingId}: ${error.message}` };
  }

  return { error: `listing ${listingId}: unknown error` };
};

/**
 * A resolved product carrying NO price at all — neither a piece price nor a
 * per-unit price — means the price selector silently broke. Retailers rename
 * price fields without notice, and the adapters' guards only check name/SKU,
 * so a break otherwise writes a null-null row that flat-lines the chart and
 * hides the failure. Surfacing it as an error instead keeps the last good
 * price and makes a chain-wide break show up in the run's errors[]. Weight-
 * priced items are unaffected: they carry a per-unit price, so only the
 * genuinely price-less case trips this.
 */
export const missingPriceError = (
  listingId: number,
  retailer: string,
  scraped: Pick<ScrapedListing, 'pricePiece' | 'priceUnit'>,
): string | undefined => {
  if (null === scraped.pricePiece && null === scraped.priceUnit) {
    return `listing ${listingId} (${retailer}): resolved but no price found — selector may have changed`;
  }

  return undefined;
};

const SANITY_DIVERGENCE = 0.2;

const UNIT_LABEL_BASES = new Map<string, { unit: 'g' | 'ml'; per: number }>([
  ['κιλό', { unit: 'g', per: 1000 }],
  ['λίτρο', { unit: 'ml', per: 1000 }],
]);

/**
 * Cross-check the retailer's own per-kg/L figure against the one implied
 * by our parsed pack size. Divergence beyond 20% means the size parse,
 * the listing link, or the retailer's data is wrong — the price is still
 * recorded, but silently trusting it hides exactly the mismatches this
 * tracker exists to avoid.
 */
export const unitPriceSanityWarning = (
  listing: Pick<ListingRow, 'id' | 'retailer' | 'product_title'>,
  scraped: Pick<ScrapedListing, 'pricePiece' | 'priceUnit' | 'unitLabel'>,
): string | undefined => {
  if (null === scraped.pricePiece || null === scraped.priceUnit || null == scraped.unitLabel) {
    return undefined;
  }

  const base = UNIT_LABEL_BASES.get(scraped.unitLabel);

  if (undefined === base) {
    return undefined;
  }

  const size = extractSize(listing.product_title);

  if (null === size || base.unit !== size.unit || 0 === size.value) {
    return undefined;
  }

  const computed = (scraped.pricePiece / size.value) * base.per;
  const divergence = Math.abs(computed - scraped.priceUnit) / scraped.priceUnit;

  if (divergence <= SANITY_DIVERGENCE) {
    return undefined;
  }

  return (
    `listing ${listing.id} (${listing.retailer}): reported ${scraped.priceUnit.toFixed(2)} €/${scraped.unitLabel} ` +
    `but ${scraped.pricePiece.toFixed(2)} € for "${listing.product_title}" computes to ` +
    `${computed.toFixed(2)} — check the size parse or the linked product`
  );
};

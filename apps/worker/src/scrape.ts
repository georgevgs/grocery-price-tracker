import type { RetailerId, ScrapedListing } from '@grocery/core/types';
import { extractSize } from '@grocery/core/normalize';
import { adapterRegistry } from '@grocery/scrapers/registry';
import { ListingGoneError } from '@grocery/scrapers/types';

export interface Env {
  DB: D1Database;
  /**
   * Scrape.do API token (a Worker secret: `wrangler secret put RESIDENTIAL_PROXY_TOKEN`).
   * Enables residential egress for the chains that block Cloudflare's edge
   * (see residential-fetch.ts). Optional: unset in local dev / the scrape
   * script, where fetches already leave from a residential IP.
   */
  RESIDENTIAL_PROXY_TOKEN?: string;
}

interface ListingRow {
  id: number;
  retailer: string;
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

export const runScrape = async (env: Env): Promise<ScrapeRunResult> => {
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.retailer, l.url, p.id AS product_id,
            p.brand AS product_brand, p.title AS product_title, p.image_url AS product_image
     FROM retailer_listings l
     JOIN products p ON p.id = l.product_id`,
  ).all<ListingRow>();

  const scrapedDate = athensDate();
  const scrapedAt = new Date().toISOString();

  // Listings are independent — scrape them concurrently. Basket-sized
  // workloads stay far below Workers' subrequest limits.
  const outcomes = await Promise.all(
    results.map((listing) => scrapeOne(env, listing, scrapedDate, scrapedAt)),
  );

  const errors = outcomes
    .map((outcome) => outcome.error)
    .filter((error): error is string => undefined !== error);
  const warnings = outcomes
    .map((outcome) => outcome.warning)
    .filter((warning): warning is string => undefined !== warning);

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
    const scraped = await adapter.scrapeProduct(listing.url, fetch, {
      productTitle: `${listing.product_brand} ${listing.product_title}`.trim(),
      productBrand: listing.product_brand,
    });

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

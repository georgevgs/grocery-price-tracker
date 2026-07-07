import type { RetailerId, RetailerSearchResult, ScrapedListing } from '@grocery/core/types';

export interface ScrapeHints {
  /** Product title from the tracker DB — used by adapters that scrape via search. */
  productTitle?: string;
  /**
   * Product brand from the tracker DB — search-driven adapters (AB) fall
   * back to a brand-only query when the full title stops surfacing the
   * SKU in their index.
   */
  productBrand?: string;
}

export interface SearchHints {
  /**
   * Pack barcode (EAN-13/8). Adapters whose backends resolve barcodes
   * (Galaxias SKU = EAN, Kritikos barcodes[], Masoutis & My Market
   * accept EANs as search text) surface the exact product first.
   */
  ean?: string;
}

export interface RetailerAdapter {
  id: RetailerId;
  // NOTE: there is no residential-egress/render flag anymore. The two chains
  // that block Cloudflare's edge (AB, Kritikos) are served entirely from their
  // off-edge D1 catalog indexes, and every other chain answers the edge
  // directly, so the Worker always calls adapters on the free global fetch and
  // no chain needs a paid proxy. See apps/worker/src/index.ts (searchAbCatalog /
  // searchKritikosCatalog / resolveFromCatalog).
  scrapeProduct(url: string, fetchImpl: typeof fetch, hints?: ScrapeHints): Promise<ScrapedListing>;
  searchProducts(
    query: string,
    fetchImpl: typeof fetch,
    hints?: SearchHints,
  ): Promise<RetailerSearchResult[]>;
}

export class AdapterError extends Error {
  readonly retailer: RetailerId;
  readonly url: string;

  constructor(retailer: RetailerId, url: string, message: string) {
    super(`[${retailer}] ${message} (${url})`);
    this.name = 'AdapterError';
    this.retailer = retailer;
    this.url = url;
  }
}

/**
 * The listing's page no longer exists — expected lifecycle, not a fault:
 * Lidl promo pages die when the offer week ends. The scrape loop reports
 * these as warnings (the listing wants unlinking) instead of failing the
 * run every day.
 */
export class ListingGoneError extends AdapterError {
  constructor(retailer: RetailerId, url: string, message: string) {
    super(retailer, url, message);
    this.name = 'ListingGoneError';
  }
}

export const toGreekFloat = (raw: string): number | null => {
  let normalized = raw.trim();

  // Greek format ('1.234,56') only when a comma is present;
  // dot-decimal values ('2.15') must pass through untouched.
  if (normalized.includes(',')) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  }

  const value = Number(normalized);

  if (Number.isNaN(value)) {
    return null;
  }

  return value;
};

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
  /** See SearchHints.rendered — propagated into the search-driven scrape path. */
  rendered?: boolean;
}

export interface SearchHints {
  /**
   * Pack barcode (EAN-13/8). Adapters whose backends resolve barcodes
   * (Galaxias SKU = EAN, Kritikos barcodes[], Masoutis & My Market
   * accept EANs as search text) surface the exact product first.
   */
  ean?: string;
  /**
   * True when this search runs through the residential *render* proxy — the
   * edge path for a needsRenderedSearch chain. Adapters that have both a
   * direct-API and a rendered-HTML search strategy switch to parsing the
   * rendered page when this is set; unset (the off-edge scrape, which reaches
   * the API directly) keeps the fast, free direct path. See RetailerAdapter.
   */
  rendered?: boolean;
}

export interface RetailerAdapter {
  id: RetailerId;
  /**
   * This chain's WAF/CDN blocks Cloudflare's Worker egress IPs (403/503/429)
   * but serves the exact same requests fine from a residential IP — the same
   * reason the daily scrape runs off-edge (scripts/scrape-local.ts). When set,
   * the Worker routes this adapter's fetches through a residential egress
   * (a scraping API — see apps/worker/src/residential-fetch.ts) instead of the
   * global fetch, so interactive search works from the deployed edge too.
   * Cloudflare's fetch can't tunnel a raw HTTP CONNECT proxy and its socket
   * startTls() can't present a target SNI through one, so a per-GB proxy is
   * not an option here; a fetch-native unblocker API is.
   *
   * Leave unset for chains that answer the Worker directly — those stay on the
   * free global fetch and cost nothing.
   */
  needsResidentialEgress?: boolean;
  /**
   * This chain hides its search results behind client-side JS *and* the API the
   * page calls is blocked through the residential proxy (AB's Akamai 502s
   * /api/v1 at the connection level), while the server-rendered HTML is only a
   * shell. When set, the Worker fetches this chain's search *page* through the
   * residential proxy in headless-render mode (Scrape.do render=true) so the
   * in-page app makes its own cookie'd API call, then the adapter parses the
   * rendered product tiles. Implies needsResidentialEgress. Only affects the
   * edge search/resolve path — the off-edge scrape reaches the API directly, so
   * it never pays for render. Render is the priciest, slowest proxy tier
   * (~20-30s/call), so flag it only for chains that genuinely need it.
   */
  needsRenderedSearch?: boolean;
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

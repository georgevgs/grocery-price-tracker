export type RetailerId =
  | 'sklavenitis'
  | 'ab'
  | 'lidl'
  | 'masoutis'
  | 'mymarket'
  | 'kritikos'
  | 'galaxias';

export interface Product {
  id: number;
  ean: string | null;
  brand: string;
  title: string;
  sizeValue: number | null;
  sizeUnit: string | null;
  /** Hotlinked retailer product shot — captured at save time or backfilled by the scrape. */
  imageUrl: string | null;
}

export interface RetailerListing {
  id: number;
  productId: number;
  retailer: RetailerId;
  retailerSku: string;
  url: string;
}

export interface PricePoint {
  listingId: number;
  scrapedDate: string;
  pricePiece: number | null;
  priceUnit: number | null;
  unitLabel: string | null;
}

export interface ListingWithLatestPrice extends RetailerListing {
  latestPrice: PricePoint | null;
}

export interface ProductWithListings extends Product {
  listings: ListingWithLatestPrice[];
}

export interface ScrapedListing {
  name: string | null;
  sku: string | null;
  pricePiece: number | null;
  priceUnit: number | null;
  unitLabel: string | null;
  /** Pack barcode when the product page exposes one (Lidl JSON-LD gtin13). */
  ean?: string | null;
  /** Product shot when the page exposes one — used to backfill products.image_url. */
  imageUrl?: string | null;
}

export interface RetailerSearchResult {
  retailer: RetailerId;
  sku: string;
  title: string;
  url: string;
  brand: string | null;
  /** Pack barcode when the retailer exposes one — the cross-chain identity. */
  ean: string | null;
  pricePiece: number | null;
  priceUnit: number | null;
  unitLabel: string | null;
  /**
   * Product shot when the retailer's search payload carries one (AB,
   * Galaxias, Kritikos). Absent for chains whose search tiles omit it —
   * those products get their image from a co-listing or the scrape.
   */
  imageUrl?: string | null;
}

export interface CreateProductPayload {
  ean: string | null;
  brand: string;
  title: string;
  sizeValue: number | null;
  sizeUnit: string | null;
  imageUrl: string | null;
  listings: CreateListingPayload[];
}

export interface CreateListingPayload {
  retailer: RetailerId;
  retailerSku: string;
  url: string;
  // The price the user just saw for this listing (from search or resolve-url).
  // Seeded into price_history at save so the product shows today's price
  // immediately — the post-save edge scrape can't reach the WAF-blocked chains
  // (AB/Kritikos/Sklavenitis), so without this they'd read "—" until the next
  // off-edge daily scrape. Null when the source carried no price; the daily
  // scrape backfills.
  pricePiece: number | null;
  priceUnit: number | null;
  unitLabel: string | null;
}

/**
 * Partial edit for an existing product — every field is optional so callers
 * send only what changed. An omitted key is left untouched; an explicit
 * `null` clears a nullable column. `brand`/`title` must stay non-empty.
 */
export interface UpdateProductPayload {
  ean?: string | null;
  brand?: string;
  title?: string;
  sizeValue?: number | null;
  sizeUnit?: string | null;
  imageUrl?: string | null;
}

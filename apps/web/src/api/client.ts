import type {
  CreateListingPayload,
  CreateProductPayload,
  ProductWithListings,
  RetailerId,
  RetailerSearchResult,
} from '@grocery/core/types';

export interface RetailerSearchResponse {
  results: Partial<Record<RetailerId, RetailerSearchResult[]>>;
  errors: string[];
}

export interface HistoryPoint {
  listingId: number;
  retailer: RetailerId;
  scrapedDate: string;
  pricePiece: number | null;
  priceUnit: number | null;
  unitLabel: string | null;
}

export const fetchProducts = async (): Promise<ProductWithListings[]> => {
  const response = await fetch('/api/products');

  if (false === response.ok) {
    throw new Error(`GET /api/products failed: ${response.status}`);
  }

  return response.json();
};

export const fetchProductHistory = async (productId: number): Promise<HistoryPoint[]> => {
  const response = await fetch(`/api/products/${productId}/history`);

  if (false === response.ok) {
    throw new Error(`GET /api/products/${productId}/history failed: ${response.status}`);
  }

  return response.json();
};

export const createProduct = async (payload: CreateProductPayload): Promise<{ id: number }> => {
  const response = await fetch('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (false === response.ok) {
    throw new Error(`POST /api/products failed: ${response.status}`);
  }

  return response.json();
};

export interface BarcodeInfo {
  name: string | null;
  brand: string | null;
  quantity: string | null;
  imageUrl: string | null;
}

/**
 * Look up a scanned barcode in Open Food Facts (via the worker). Returns
 * nulls when the barcode is unknown; the caller then falls back to the
 * retailer chains. Never throws — a flaky lookup must not break the scan.
 */
export const lookupBarcode = async (ean: string): Promise<BarcodeInfo> => {
  const empty: BarcodeInfo = { name: null, brand: null, quantity: null, imageUrl: null };

  try {
    const response = await fetch(`/api/barcode/${ean}`);

    if (false === response.ok) {
      return empty;
    }

    return await response.json();
  } catch {
    return empty;
  }
};

export const searchRetailers = async (
  query: string,
  retailers?: readonly RetailerId[],
  ean?: string | null,
): Promise<RetailerSearchResponse> => {
  const params = new URLSearchParams({ q: query });

  if (undefined !== retailers && 0 < retailers.length) {
    params.set('retailers', retailers.join(','));
  }

  if (null != ean && 0 < ean.length) {
    params.set('ean', ean);
  }

  const response = await fetch(`/api/retailer-search?${params.toString()}`);

  if (false === response.ok) {
    throw new Error(`GET /api/retailer-search failed: ${response.status}`);
  }

  return response.json();
};

export interface ResolvedListing {
  retailer: RetailerId;
  sku: string;
  name: string | null;
  url: string;
  pricePiece: number | null;
  priceUnit: number | null;
  unitLabel: string | null;
}

export const resolveProductUrl = async (
  url: string,
  productTitle?: string,
): Promise<ResolvedListing> => {
  const response = await fetch('/api/resolve-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, productTitle }),
  });

  if (false === response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `POST /api/resolve-url failed: ${response.status}`);
  }

  return response.json();
};

export const updateProductEan = async (
  productId: number,
  ean: string | null,
): Promise<void> => {
  const response = await fetch(`/api/products/${productId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ean }),
  });

  if (false === response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `PATCH /api/products/${productId} failed: ${response.status}`);
  }
};

export const addListings = async (
  productId: number,
  listings: CreateListingPayload[],
): Promise<{ added: number }> => {
  const response = await fetch(`/api/products/${productId}/listings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ listings }),
  });

  if (false === response.ok) {
    throw new Error(`POST /api/products/${productId}/listings failed: ${response.status}`);
  }

  return response.json();
};

export const triggerScrape = async (): Promise<{ ok: number; failed: number }> => {
  const response = await fetch('/api/scrape/run', { method: 'POST' });

  if (false === response.ok) {
    throw new Error(`POST /api/scrape/run failed: ${response.status}`);
  }

  return response.json();
};

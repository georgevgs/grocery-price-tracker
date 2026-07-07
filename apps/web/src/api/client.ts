import type {
  CreateListingPayload,
  CreateProductPayload,
  ProductWithListings,
  RetailerId,
  RetailerSearchResult,
  UpdateProductPayload,
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

// Every retailer id, forced exhaustive against the RetailerId union: adding a
// chain to the union makes this literal fail to compile until it's listed here
// too, so the fan-out below can never silently skip a new chain.
const RETAILER_PRESENCE: Record<RetailerId, true> = {
  sklavenitis: true,
  ab: true,
  lidl: true,
  masoutis: true,
  mymarket: true,
  kritikos: true,
  galaxias: true,
};

const ALL_RETAILERS = Object.keys(RETAILER_PRESENCE) as RetailerId[];

/**
 * Search a single chain. One retailer per request is deliberate: the Worker
 * parses each chain's catalog within the invocation, so fanning every chain
 * out in one request blows the Workers free-plan per-request CPU budget
 * (Cloudflare error 1102). One chain per request gives each its own budget
 * and isolates a heavy/failing chain so it can't sink the whole search.
 */
const searchOneRetailer = async (
  query: string,
  retailer: RetailerId,
  ean?: string | null,
): Promise<RetailerSearchResponse> => {
  const params = new URLSearchParams({ q: query, retailers: retailer });

  if (null != ean && 0 < ean.length) {
    params.set('ean', ean);
  }

  const response = await fetch(`/api/retailer-search?${params.toString()}`);

  if (false === response.ok) {
    // A chain over the CPU budget returns 5xx (1102). Surface it as that
    // chain's error and let the others through instead of failing the search.
    return { results: {}, errors: [`[${retailer}] search failed: HTTP ${response.status}`] };
  }

  return response.json();
};

/**
 * Fan search out across chains, one request each, and merge. Signature and
 * shape match a single combined call, so callers are unaffected; a subset
 * (weak-chain retries, EAN passes) narrows the fan-out. Per-chain failures
 * become entries in `errors` rather than throwing, so one bad chain never
 * loses the rest.
 */
export const searchRetailers = async (
  query: string,
  retailers?: readonly RetailerId[],
  ean?: string | null,
  // Notified the moment each chain's request settles (with its result
  // count), so a live UI can fill chains in one-by-one as they land rather
  // than waiting for the whole fan-out. Optional — callers that don't
  // render progress omit it.
  onChain?: (retailer: RetailerId, count: number) => void,
): Promise<RetailerSearchResponse> => {
  const targets = undefined !== retailers && 0 < retailers.length ? retailers : ALL_RETAILERS;

  const responses = await Promise.all(
    targets.map((retailer) =>
      searchOneRetailer(query, retailer, ean)
        .catch(
          (error): RetailerSearchResponse => ({
            results: {},
            errors: [`[${retailer}] ${error instanceof Error ? error.message : String(error)}`],
          }),
        )
        .then((response) => {
          onChain?.(retailer, response.results[retailer]?.length ?? 0);
          return response;
        }),
    ),
  );

  const merged: RetailerSearchResponse = { results: {}, errors: [] };

  for (const response of responses) {
    Object.assign(merged.results, response.results);
    merged.errors.push(...response.errors);
  }

  return merged;
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

/**
 * Partial edit of a product. Send only changed fields; the worker leaves
 * omitted columns untouched. Surfaces the worker's error message (e.g. a
 * duplicate-EAN conflict) so the UI can show something meaningful.
 */
export const updateProduct = async (
  productId: number,
  patch: UpdateProductPayload,
): Promise<void> => {
  const response = await fetch(`/api/products/${productId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });

  if (false === response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `PATCH /api/products/${productId} failed: ${response.status}`);
  }
};

export const updateProductEan = async (
  productId: number,
  ean: string | null,
): Promise<void> => {
  await updateProduct(productId, { ean });
};

export const deleteProduct = async (productId: number): Promise<void> => {
  const response = await fetch(`/api/products/${productId}`, { method: 'DELETE' });

  if (false === response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `DELETE /api/products/${productId} failed: ${response.status}`);
  }
};

export const deleteListing = async (
  productId: number,
  listingId: number,
): Promise<void> => {
  const response = await fetch(`/api/products/${productId}/listings/${listingId}`, {
    method: 'DELETE',
  });

  if (false === response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(
      body?.error ?? `DELETE /api/products/${productId}/listings/${listingId} failed: ${response.status}`,
    );
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

/**
 * Open Food Facts — a free, open, barcode-keyed product database
 * (openfoodfacts.org, data under the ODbL). Used to turn a scanned EAN
 * into a clean product name/brand without typing.
 *
 * Coverage is uneven for the Greek catalogue: popular items carry a tidy
 * `product_name_el` (better than the retailers' abbreviated titles), but
 * many barcodes are photo-only stubs with no name. So the caller treats a
 * null `name` as "not found here" and falls back to the retailer chains —
 * while `imageUrl` is often present even on the stubs and is worth keeping.
 */
export interface BarcodeInfo {
  name: string | null;
  brand: string | null;
  quantity: string | null;
  imageUrl: string | null;
}

const API_HOST = 'https://world.openfoodfacts.org';
const FIELDS =
  'product_name,product_name_el,generic_name,brands,quantity,image_front_small_url,image_url';

// Open Food Facts asks callers to identify themselves with a descriptive
// User-Agent rather than a generic one.
const USER_AGENT = 'timoula-price-tracker/1.0 (dev@vagdas.eu)';

const EMPTY: BarcodeInfo = { name: null, brand: null, quantity: null, imageUrl: null };

interface JsonObject {
  [key: string]: unknown;
}

const isObject = (value: unknown): value is JsonObject => {
  return 'object' === typeof value && null !== value && false === Array.isArray(value);
};

const firstText = (...values: readonly unknown[]): string | null => {
  for (const value of values) {
    if ('string' === typeof value && 0 < value.trim().length) {
      return value.trim();
    }
  }

  return null;
};

export const normalizeOpenFoodFacts = (body: unknown): BarcodeInfo => {
  // v2 answers `status: 1` when the barcode is known, `0` otherwise.
  if (false === isObject(body) || 1 !== body['status']) {
    return EMPTY;
  }

  const product = body['product'];

  if (false === isObject(product)) {
    return EMPTY;
  }

  const rawBrand = firstText(product['brands']);

  return {
    // Prefer the Greek name, then the generic international one.
    name: firstText(product['product_name_el'], product['product_name'], product['generic_name']),
    // `brands` is a comma-separated list — the first is the primary brand.
    brand: null === rawBrand ? null : firstText(rawBrand.split(',')[0]),
    quantity: firstText(product['quantity']),
    imageUrl: firstText(product['image_front_small_url'], product['image_url']),
  };
};

export const lookupBarcode = async (
  ean: string,
  fetchImpl: typeof fetch,
): Promise<BarcodeInfo> => {
  const url = `${API_HOST}/api/v2/product/${ean}.json?fields=${FIELDS}`;

  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });

    if (false === response.ok) {
      return EMPTY;
    }

    return normalizeOpenFoodFacts(await response.json());
  } catch {
    // A flaky third-party lookup must never break the scan flow — the
    // caller falls back to the retailer chains.
    return EMPTY;
  }
};

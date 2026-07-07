import type { RetailerSearchResult } from '@grocery/core/types';
import { AdapterError, type RetailerAdapter } from './types';

const GRAPHQL_URL = 'https://magento2.galaxias.shop/graphql';
const BASE_URL = 'https://galaxias.shop';
// Canonical product URLs are /product/<sku>; the SKU is USUALLY the EAN-13
// barcode, but the pattern also admits non-numeric SKUs, so validate before
// trusting one as the cross-chain identity (see EAN_PATTERN below).
const SKU_FROM_URL_PATTERN = /\/product\/([A-Za-z0-9_-]+)/;

// Only a barcode-shaped SKU may become products.ean (the cross-chain join
// key); an alphanumeric/internal SKU would be a false identity. Matches the
// validation @grocery/core applies to user-pasted EANs.
const EAN_PATTERN = /^\d{8,14}$/;

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) personal-price-watch/1.0';

const ITEM_FIELDS =
  'sku name unit_measurement cost_per_unit small_image{ url } ' +
  'price_range{ minimum_price{ final_price{ value } } } ' +
  'catalog_rules{ action_name actions{ amount } tags }';

/**
 * galaxias.shop is an Angular shell over a Magento 2 GraphQL API that
 * answers unauthenticated catalog queries (verified live 2026-07-05).
 * Product pages render nothing server-side, so both scraping and search
 * go through the API: products(filter:{sku:{eq}}) for the daily scrape,
 * products(search:) for discovery. final_price is the payable
 * (post-discount) price; cost_per_unit/unit_measurement carry the
 * €-per-unit figure but are null on many items (multipacks etc.).
 */
export const galaxiasAdapter: RetailerAdapter = {
  id: 'galaxias',

  async scrapeProduct(url, fetchImpl) {
    const skuMatch = url.match(SKU_FROM_URL_PATTERN);

    if (null === skuMatch || undefined === skuMatch[1]) {
      throw new AdapterError('galaxias', url, 'could not derive SKU from URL (expected /product/<sku>)');
    }

    const sku = skuMatch[1];
    const query =
      `{ products(filter:{sku:{eq:${JSON.stringify(sku)}}} pageSize:1){ items{ ${ITEM_FIELDS} } } }`;
    const body = await runQuery(query, url, fetchImpl);
    const [listing] = mapProductsResponse(body, url);

    if (undefined === listing) {
      throw new AdapterError('galaxias', url, `API returned no product for SKU ${sku}`);
    }

    return {
      name: listing.title,
      sku: listing.sku,
      pricePiece: listing.pricePiece,
      priceUnit: listing.priceUnit,
      unitLabel: listing.unitLabel,
      imageUrl: listing.imageUrl ?? null,
    };
  },

  async searchProducts(query, fetchImpl, hints) {
    const ean = hints?.ean;
    const textGql =
      `{ products(search:${JSON.stringify(query)} pageSize:20 currentPage:1){ items{ ${ITEM_FIELDS} } } }`;
    // SKUs here ARE the pack barcodes, so a known EAN resolves the exact
    // product even when the store abbreviates its title beyond recognition
    // ("H.Η.ΓΚΡΑΝΟΛΑ ΦΥΣΤΙΚ/ΤΥΡΟ ΜΑΥΡ.ΣΟΚ.").
    const eanGql =
      undefined !== ean && 0 < ean.length
        ? `{ products(filter:{sku:{eq:${JSON.stringify(ean)}}} pageSize:1){ items{ ${ITEM_FIELDS} } } }`
        : null;

    const [textBody, eanBody] = await Promise.all([
      runQuery(textGql, GRAPHQL_URL, fetchImpl),
      null !== eanGql ? runQuery(eanGql, GRAPHQL_URL, fetchImpl) : Promise.resolve(null),
    ]);

    const textResults = mapProductsResponse(textBody, GRAPHQL_URL);
    const eanResults = null !== eanBody ? mapProductsResponse(eanBody, GRAPHQL_URL) : [];
    const seenSkus = new Set(eanResults.map((result) => result.sku));

    return [
      ...eanResults,
      ...textResults.filter((result) => false === seenSkus.has(result.sku)),
    ];
  },
};

const runQuery = async (query: string, url: string, fetchImpl: typeof fetch): Promise<unknown> => {
  const response = await fetchImpl(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (false === response.ok) {
    throw new AdapterError('galaxias', url, `HTTP ${response.status}`);
  }

  return response.json();
};

interface JsonObject {
  [key: string]: unknown;
}

const isObject = (value: unknown): value is JsonObject => {
  return 'object' === typeof value && null !== value && false === Array.isArray(value);
};

export const mapProductsResponse = (body: unknown, url: string): RetailerSearchResult[] => {
  if (isObject(body) && Array.isArray(body['errors']) && 0 < body['errors'].length) {
    const first: unknown = body['errors'][0];
    const message = isObject(first) && 'string' === typeof first['message'] ? first['message'] : 'GraphQL error';
    throw new AdapterError('galaxias', url, message);
  }

  const data = isObject(body) ? body['data'] : undefined;
  const products = isObject(data) ? data['products'] : undefined;
  const items = isObject(products) ? products['items'] : undefined;

  if (false === Array.isArray(items)) {
    throw new AdapterError('galaxias', url, 'unexpected response shape: data.products.items missing');
  }

  const results: RetailerSearchResult[] = [];

  for (const item of items) {
    if (false === isObject(item)) {
      continue;
    }

    const sku = item['sku'];
    const name = item['name'];

    if ('string' !== typeof sku || 'string' !== typeof name) {
      continue;
    }

    const basePrice = extractFinalPrice(item);
    const pricePiece = applyCatalogRules(basePrice, item['catalog_rules']);

    results.push({
      retailer: 'galaxias',
      sku,
      title: name,
      url: `${BASE_URL}/product/${sku}`,
      brand: null,
      // Galaxias SKUs are USUALLY the pack barcode (EAN-13) — but only stamp
      // one that actually looks like a barcode, so a non-numeric SKU can't
      // poison the cross-chain identity.
      ean: EAN_PATTERN.test(sku) ? sku : null,
      pricePiece,
      priceUnit: toUnitPrice(item['cost_per_unit'], basePrice, pricePiece),
      unitLabel: toUnitLabel(item['unit_measurement']),
      imageUrl: extractImageUrl(item['small_image']),
    });
  }

  return results;
};

/**
 * small_image.url is the catalog thumbnail. Magento serves a generic
 * "/placeholder/…default_image…" for imageless products (verified live
 * 2026-07-05) — treat that as no image rather than store the placeholder.
 */
const extractImageUrl = (raw: unknown): string | null => {
  const url = isObject(raw) ? raw['url'] : undefined;

  if ('string' !== typeof url || 0 === url.length || url.includes('/placeholder/')) {
    return null;
  }

  return url;
};

const extractFinalPrice = (item: JsonObject): number | null => {
  const priceRange = isObject(item['price_range']) ? item['price_range'] : undefined;
  const minimum = isObject(priceRange?.['minimum_price']) ? priceRange['minimum_price'] : undefined;
  const finalPrice = isObject(minimum?.['final_price']) ? minimum['final_price'] : undefined;
  const value = finalPrice?.['value'];

  return 'number' === typeof value ? value : null;
};

/**
 * Leaflet promos ("ΦΥΛΛΑΔΙΟ") are NOT baked into final_price — the
 * storefront applies catalog_rules client-side. This mirrors the exact
 * algorithm from their JS bundle, including the odd fixed-rule tag guard
 * and the floor-to-cents rounding.
 */
const applyCatalogRules = (price: number | null, rawRules: unknown): number | null => {
  if (null === price || false === Array.isArray(rawRules)) {
    return price;
  }

  let discounted = price;

  for (const rule of rawRules) {
    if (false === isObject(rule)) {
      continue;
    }

    const actions = isObject(rule['actions']) ? rule['actions'] : {};
    const amount = Number(actions['amount']);

    if (Number.isNaN(amount)) {
      continue;
    }

    const tags = rule['tags'];
    const firstTag = Array.isArray(tags) && 'string' === typeof tags[0] ? tags[0] : null;

    if ('fixed' === rule['action_name'] && null !== firstTag && false === firstTag.includes('aDiscount:')) {
      discounted -= amount;
    }

    if ('percent' === rule['action_name']) {
      discounted -= discounted * (amount / 100);
      discounted = Math.floor(100 * discounted + 1e-8) / 100;
    }
  }

  // Clamp to ≥0: a malformed rule (fixed amount larger than the price) or
  // several stacked rules must never store a negative/nonsense price — a
  // storefront never shows one. Faithful to the mirrored algorithm otherwise.
  return Math.max(0, Math.round(discounted * 100) / 100);
};

/**
 * cost_per_unit arrives as a full-precision string ("3.7111111111111")
 * derived from the UNDISCOUNTED price — rescale it when catalog rules
 * lowered the piece price.
 */
const toUnitPrice = (
  raw: unknown,
  basePrice: number | null,
  discountedPrice: number | null,
): number | null => {
  if ('string' !== typeof raw && 'number' !== typeof raw) {
    return null;
  }

  let value = Number(raw);

  if (Number.isNaN(value)) {
    return null;
  }

  if (null !== basePrice && null !== discountedPrice && 0 < basePrice) {
    value *= discountedPrice / basePrice;
  }

  return Math.round(value * 100) / 100;
};

/** Magento capitalizes ("Κιλό", "Λίτρο"); align with the Sklavenitis-style labels. */
const toUnitLabel = (raw: unknown): string | null => {
  if ('string' !== typeof raw || 0 === raw.length) {
    return null;
  }

  return raw.toLowerCase();
};

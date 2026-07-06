import type { RetailerSearchResult } from '@grocery/core/types';
import { AdapterError, toGreekFloat, type RetailerAdapter } from './types';

const GRAPHQL_URL = 'https://www.ab.gr/api/v1/';
const BASE_URL = 'https://www.ab.gr';
const SKU_FROM_URL_PATTERN = /\/p\/(\d+)/;
const UNIT_LABEL_PATTERN = /([\d.,]+)\s*€\s*\/\s*(\S+)/;

/**
 * Persisted-query hash for GetProductSearch, captured from the live site
 * (2026-07-05). AB deploys may rotate it; on "PersistedQueryNotFound"
 * re-capture it from DevTools → Network while searching on ab.gr.
 */
const PRODUCT_SEARCH_HASH = '1aed18b70ca933de3c1352038f798f0b8375ac515e9d0f93a23556402015418a';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) personal-price-watch/1.0';

/**
 * ab.gr renders search results client-side through a GraphQL gateway that
 * answers plain unauthenticated GETs — verified live. The GetProductSearch
 * tile carries code (SKU), name, canonical URL, brand and current prices,
 * so the same call powers both discovery and the daily price scrape.
 *
 * The gateway 400s on numeric-only queries, so scraping by SKU alone is
 * impossible: scrapeProduct needs the product title as a search query
 * (hints.productTitle), then picks the result whose code equals the SKU
 * from the /p/<sku> URL segment.
 *
 * No barcode anywhere: the product page (probed 2026-07-06) has no JSON-LD
 * Product block and no gtin/ean field in its embedded state — AB identity
 * stays SKU-only, so cross-chain matching for AB always goes through the
 * fuzzy path or a barcode learned from another chain.
 */
export const abAdapter: RetailerAdapter = {
  id: 'ab',

  async scrapeProduct(url, fetchImpl, hints) {
    const skuMatch = url.match(SKU_FROM_URL_PATTERN);

    if (null === skuMatch || undefined === skuMatch[1]) {
      throw new AdapterError('ab', url, 'could not derive SKU from URL (expected /p/<digits>)');
    }

    const sku = skuMatch[1];
    const query = hints?.productTitle;

    if (undefined === query || 0 === query.length) {
      throw new AdapterError(
        'ab',
        url,
        'scraping ab requires hints.productTitle (the search API rejects numeric-only queries)',
      );
    }

    const results = await this.searchProducts(query, fetchImpl);
    let listing = results.find((result) => sku === result.sku);

    // Index churn: generic titles stop surfacing the SKU in the top
    // results. A brand-only listing is broader and often still carries
    // it — the exact-SKU pick below makes the retry mismatch-proof.
    if (undefined === listing) {
      const brandQuery = hints?.productBrand?.trim() ?? '';

      if (3 <= brandQuery.length && brandQuery !== query) {
        const brandResults = await this.searchProducts(brandQuery, fetchImpl);
        listing = brandResults.find((result) => sku === result.sku);
      }
    }

    if (undefined === listing) {
      throw new AdapterError(
        'ab',
        url,
        `search for "${query}" (and brand retry) returned no product with code ${sku}`,
      );
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

  async searchProducts(query, fetchImpl) {
    const variables = {
      lang: 'gr',
      searchQuery: query,
      pageNumber: 0,
      pageSize: 20,
      filterFlag: true,
      fields: 'PRODUCT_TILE',
      plainChildCategories: true,
      useSpellingSuggestion: true,
    };
    const extensions = {
      persistedQuery: { version: 1, sha256Hash: PRODUCT_SEARCH_HASH },
    };

    const params = new URLSearchParams({
      operationName: 'GetProductSearch',
      variables: JSON.stringify(variables),
      extensions: JSON.stringify(extensions),
    });
    const url = `${GRAPHQL_URL}?${params.toString()}`;

    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        // Apollo Server's CSRF guard 400s GETs without one of these.
        'x-apollo-operation-name': 'GetProductSearch',
      },
    });

    if (false === response.ok) {
      throw new AdapterError('ab', url, `HTTP ${response.status}`);
    }

    const body: unknown = await response.json();

    return mapSearchResponse(body, url);
  },
};

interface JsonObject {
  [key: string]: unknown;
}

const isObject = (value: unknown): value is JsonObject => {
  return 'object' === typeof value && null !== value && false === Array.isArray(value);
};

export const mapSearchResponse = (body: unknown, url: string): RetailerSearchResult[] => {
  if (isObject(body) && Array.isArray(body['errors']) && 0 < body['errors'].length) {
    const first: unknown = body['errors'][0];
    const message = isObject(first) && 'string' === typeof first['message'] ? first['message'] : 'GraphQL error';
    throw new AdapterError('ab', url, `${message} — the persisted-query hash may have rotated`);
  }

  const data = isObject(body) ? body['data'] : undefined;
  const productSearch = isObject(data) ? data['productSearch'] : undefined;
  const products = isObject(productSearch) ? productSearch['products'] : undefined;

  if (false === Array.isArray(products)) {
    throw new AdapterError('ab', url, 'unexpected response shape: data.productSearch.products missing');
  }

  const results: RetailerSearchResult[] = [];

  for (const product of products) {
    if (false === isObject(product)) {
      continue;
    }

    const code = product['code'];
    const name = product['name'];

    if ('string' !== typeof code || 'string' !== typeof name) {
      continue;
    }

    const relativeUrl = 'string' === typeof product['url'] ? product['url'] : `/el/eshop/p/${code}`;
    const price = isObject(product['price']) ? product['price'] : {};
    const brand = product['manufacturerName'];
    const unitInfo = parseUnitLabel(price['supplementaryPriceLabel1']);

    results.push({
      retailer: 'ab',
      sku: code,
      title: name,
      url: `${BASE_URL}${relativeUrl}`,
      brand: 'string' === typeof brand && 0 < brand.length ? brand : null,
      ean: null,
      pricePiece: 'number' === typeof price['value'] ? price['value'] : null,
      priceUnit: unitInfo.priceUnit,
      unitLabel: unitInfo.unitLabel,
      imageUrl: pickImageUrl(product['images']),
    });
  }

  return results;
};

/**
 * The tile's `images` array holds several formats of the PRIMARY shot
 * (verified live: respListGrid/small/zoom/xlarge) plus occasional
 * secondary imagery. Prefer a small PRIMARY format for a light thumbnail;
 * the URLs are site-relative ("/medias/…"), so absolutize them.
 */
const IMAGE_FORMAT_PREFERENCE = ['small', 'respListGrid', 'zoom', 'xlarge'];

const pickImageUrl = (raw: unknown): string | null => {
  if (false === Array.isArray(raw)) {
    return null;
  }

  const primaries = raw.filter(
    (image): image is JsonObject =>
      isObject(image) && 'PRIMARY' === image['imageType'] && 'string' === typeof image['url'],
  );

  if (0 === primaries.length) {
    return null;
  }

  let chosen: JsonObject | undefined;

  for (const format of IMAGE_FORMAT_PREFERENCE) {
    chosen = primaries.find((image) => format === image['format']);

    if (undefined !== chosen) {
      break;
    }
  }

  const url = (chosen ?? primaries[0])?.['url'];

  if ('string' !== typeof url || 0 === url.length) {
    return null;
  }

  return url.startsWith('http') ? url : `${BASE_URL}${url}`;
};

const parseUnitLabel = (
  raw: unknown,
): Pick<RetailerSearchResult, 'priceUnit' | 'unitLabel'> => {
  if ('string' !== typeof raw) {
    return { priceUnit: null, unitLabel: null };
  }

  const match = raw.match(UNIT_LABEL_PATTERN);

  if (null === match || undefined === match[1] || undefined === match[2]) {
    return { priceUnit: null, unitLabel: null };
  }

  return {
    priceUnit: toGreekFloat(match[1]),
    // AB abbreviates ("κιλ"); align with the Sklavenitis label.
    unitLabel: 'κιλ' === match[2] ? 'κιλό' : match[2],
  };
};

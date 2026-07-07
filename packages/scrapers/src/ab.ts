import type { RetailerSearchResult } from '@grocery/core/types';
import { AdapterError, toGreekFloat, type RetailerAdapter } from './types';

const GRAPHQL_URL = 'https://www.ab.gr/api/v1/';
const BASE_URL = 'https://www.ab.gr';
// Server-rendered search page (/search 301s here). Reachable through the
// residential render proxy where the GraphQL API is not — see searchRendered.
const SEARCH_PAGE_URL = 'https://www.ab.gr/eshop/search';
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
  needsResidentialEgress: true,
  // AB's Akamai hard-blocks the residential proxy at the *connection* level on
  // its /api/v1/ GraphQL endpoint (502 "cannot connect target url", even with a
  // headless browser pointed straight at the API), while a clean consumer IP
  // (your home connection / the launchd scrape) gets through. So the two
  // contexts take different paths to the SAME data:
  //   • Off-edge scrape (plain fetch, residential IP): the fast, free GraphQL
  //     API — hints.rendered is unset, so searchProducts/scrapeProduct use it.
  //   • Edge search/resolve (residential render proxy): the GraphQL API is
  //     unreachable, but rendering the search *page* works — Akamai's sensor JS
  //     sets cookies, the in-page app makes its own API call, and the tiles
  //     paint into the DOM. hints.rendered switches to parsing that HTML.
  // needsRenderedSearch makes the Worker use render mode (see residential-fetch)
  // and set hints.rendered for this adapter. Render is slow/pricey, so the D1
  // search cache matters more here than for any other chain.
  needsRenderedSearch: true,

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

    // Propagate the transport so the internal search takes the same path the
    // caller is on: rendered HTML on the edge, direct GraphQL for the scrape.
    const searchHints = { rendered: hints?.rendered };
    const results = await this.searchProducts(query, fetchImpl, searchHints);
    let listing = results.find((result) => sku === result.sku);

    // Index churn: generic titles stop surfacing the SKU in the top
    // results. A brand-only listing is broader and often still carries
    // it — the exact-SKU pick below makes the retry mismatch-proof.
    if (undefined === listing) {
      const brandQuery = hints?.productBrand?.trim() ?? '';

      if (3 <= brandQuery.length && brandQuery !== query) {
        const brandResults = await this.searchProducts(brandQuery, fetchImpl, searchHints);
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

  async searchProducts(query, fetchImpl, hints) {
    // Edge path: the GraphQL API is unreachable through the render proxy, so
    // fetch the rendered search page and parse its product tiles instead.
    if (true === hints?.rendered) {
      return searchRendered(query, fetchImpl);
    }

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

/**
 * Rendered-search path (edge). AB paints results client-side and the GraphQL
 * API is blocked through the proxy, so we render the search page (Scrape.do
 * render=true, wired in residential-fetch) and parse the tiles Scrape.do
 * returns. Fields map 1:1 onto mapSearchResponse so discovery and the off-edge
 * scrape produce identical listings.
 */
const searchRendered = async (
  query: string,
  fetchImpl: typeof fetch,
): Promise<RetailerSearchResult[]> => {
  const url = `${SEARCH_PAGE_URL}?q=${encodeURIComponent(query)}`;
  const response = await fetchImpl(url);

  if (false === response.ok) {
    throw new AdapterError('ab', url, `HTTP ${response.status} (rendered search)`);
  }

  return parseRenderedSearch(await response.text());
};

// Stable per-tile hooks. The styled-components class names (sc-y4jrw3-…) rotate
// every build and MUST NOT be matched; AB's own data-testid attributes (used by
// their e2e tests) are the durable anchors. Each is unambiguous because the
// testid is matched with its closing quote — e.g. "product-block-price" cannot
// match "product-block-price-per-unit" or "…-supplementary-price".
const NAME_PATTERN = /data-testid="product-name"[^>]*>([^<]*)</;
const BRAND_PATTERN = /data-testid="product-brand"[^>]*>([^<]*)</;
const PRODUCT_ID_PATTERN = /data-testid="product-id"[^>]*>(\d+)</;
const HREF_PATTERN = /data-testid="product-block-(?:image-link|name-link)"[^>]*?\bhref="([^"]+)"/;
const IMAGE_PATTERN = /data-testid="product-block-image"[^>]*?\ssrc="([^"]+)"/;
const PRICE_LABEL_PATTERN = /data-testid="product-block-price"[^>]*?\baria-label="([^"]+)"/;
const UNIT_PRICE_LABEL_PATTERN = /data-testid="product-block-price-per-unit"[^>]*?\baria-label="([^"]+)"/;

/**
 * Parse AB's rendered search page. Splitting on the exact container testid
 * (note the closing quote — the -image/-price/-name testids share the prefix
 * but not the quote) yields one chunk per product tile.
 */
export const parseRenderedSearch = (html: string): RetailerSearchResult[] => {
  const results: RetailerSearchResult[] = [];
  const seen = new Set<string>();
  const tiles = html.split('data-testid="product-block"');

  // tiles[0] is the pre-list markup (header/facets) — skip it.
  for (let index = 1; index < tiles.length; index += 1) {
    const tile = tiles[index];

    if (undefined === tile) {
      continue;
    }

    const result = parseRenderedTile(tile);

    if (null === result || seen.has(result.sku)) {
      continue;
    }

    seen.add(result.sku);
    results.push(result);
  }

  return results;
};

const parseRenderedTile = (tile: string): RetailerSearchResult | null => {
  const href = HREF_PATTERN.exec(tile)?.[1];
  const sku =
    PRODUCT_ID_PATTERN.exec(tile)?.[1] ??
    (undefined !== href ? SKU_FROM_URL_PATTERN.exec(href)?.[1] : undefined);

  if (undefined === sku) {
    return null;
  }

  const name = decodeEntities(NAME_PATTERN.exec(tile)?.[1] ?? '').trim();

  if (0 === name.length) {
    return null;
  }

  const brand = decodeEntities(BRAND_PATTERN.exec(tile)?.[1] ?? '').trim();
  const image = IMAGE_PATTERN.exec(tile)?.[1];
  const unitInfo = parseRenderedUnit(UNIT_PRICE_LABEL_PATTERN.exec(tile)?.[1]);
  const relativeUrl = href ?? `/el/eshop/p/${sku}`;

  return {
    retailer: 'ab',
    sku,
    title: name,
    url: relativeUrl.startsWith('http') ? relativeUrl : `${BASE_URL}${relativeUrl}`,
    brand: 0 < brand.length ? brand : null,
    ean: null,
    pricePiece: parseEuroLabel(PRICE_LABEL_PATTERN.exec(tile)?.[1]),
    priceUnit: unitInfo.priceUnit,
    unitLabel: unitInfo.unitLabel,
    imageUrl: undefined !== image ? decodeEntities(image) : null,
  };
};

/**
 * AB spells prices out in the tile's aria-label ("Τιμή: 1 ευρώ και 05 λεπτά"),
 * locale-explicit and independent of the split-span digit markup. Whole euros
 * omit the "και … λεπτά" tail.
 */
const EURO_LABEL_PATTERN = /(\d+)\s*ευρώ(?:\s*και\s*(\d+)\s*λεπτ)?/;

const parseEuroLabel = (raw: string | undefined): number | null => {
  if (undefined === raw) {
    return null;
  }

  const match = EURO_LABEL_PATTERN.exec(raw);

  if (null === match || undefined === match[1]) {
    return null;
  }

  const euros = Number(match[1]);
  const cents = undefined !== match[2] ? Number(match[2]) : 0;

  if (Number.isNaN(euros) || Number.isNaN(cents)) {
    return null;
  }

  return euros + cents / 100;
};

/**
 * "Τιμή τεμαχίου: 1 ευρώ και 05 λεπτά ανά λιτ" → { priceUnit: 1.05,
 * unitLabel: 'λιτ' }. Mirrors parseUnitLabel's 'κιλ' → 'κιλό' folding.
 */
const parseRenderedUnit = (
  raw: string | undefined,
): Pick<RetailerSearchResult, 'priceUnit' | 'unitLabel'> => {
  if (undefined === raw) {
    return { priceUnit: null, unitLabel: null };
  }

  const token = /ανά\s+(\S+)/.exec(raw)?.[1];

  return {
    priceUnit: parseEuroLabel(raw),
    unitLabel: undefined === token ? null : 'κιλ' === token ? 'κιλό' : token,
  };
};

const ENTITY_MAP = new Map<string, string>([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&nbsp;', ' '],
]);

const decodeEntities = (raw: string): string => {
  return raw.replace(/&[a-z#0-9]+;/gi, (entity) => ENTITY_MAP.get(entity) ?? entity);
};

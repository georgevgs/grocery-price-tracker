import type { RetailerSearchResult } from '@grocery/core/types';
import { normalizeTitle } from '@grocery/core/normalize';
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

    // Direct GraphQL — the off-edge scrape (residential IP) and any non-render
    // caller. One page of tiles; the whole-catalog crawl (buildAbCatalogIndex)
    // reuses the same request via fetchProductSearchPage.
    const page = await fetchProductSearchPage(query, fetchImpl, 0, SEARCH_PAGE_SIZE);
    return page.results;
  },
};

/** GetProductSearch page size for live search. The catalog crawl pages larger. */
const SEARCH_PAGE_SIZE = 20;

interface ProductSearchPage {
  results: RetailerSearchResult[];
  /** From the response's `pagination.totalPages` — drives the catalog crawl loop. */
  totalPages: number;
}

/**
 * Fetch and parse ONE page of GetProductSearch. Shared by live search (page 0)
 * and the off-edge catalog crawl (every page), so both hit the exact same
 * request shape / CSRF header / persisted hash and build identical listings via
 * mapSearchResponse. Throws on a non-2xx (the caller surfaces it as a per-chain
 * error / a failed crawl).
 */
const fetchProductSearchPage = async (
  query: string,
  fetchImpl: typeof fetch,
  pageNumber: number,
  pageSize: number,
): Promise<ProductSearchPage> => {
  const variables = {
    lang: 'gr',
    searchQuery: query,
    pageNumber,
    pageSize,
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

  return { results: mapSearchResponse(body, url), totalPages: extractTotalPages(body) };
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

// --- AB catalog discovery index (the off-edge D1 path) ---------------------
//
// AB's Akamai hard-blocks Cloudflare's egress IPs (403 on every Worker fetch,
// re-verified 2026-07-07) AND its GraphQL API is unreachable through the
// residential proxy, so the edge could previously only reach AB via Scrape.do's
// priciest render tier. So AB gets the same treatment as Kritikos: the off-edge
// daily scrape (residential IP, where AB's API answers directly and free) crawls
// the whole catalog into a D1 table once a day, and the edge answers AB search
// with a cheap `haystack LIKE ?` over ~12k rows — no proxy, no render, no credits
// (searchAbCatalog in apps/worker/src/index.ts).

/**
 * Whole-catalog crawl controls. AB is SAP Hybris: an EMPTY free-text query with
 * the ":relevance" sort browses EVERY product (verified live 2026-07-07:
 * ~12,100 results), and `pageSize` is capped just under 100 (100 → HTTP 500
 * "UserInputError"), so we page at 50. Used only off-edge — the edge never crawls.
 */
const CATALOG_QUERY = ':relevance';
const CATALOG_PAGE_SIZE = 50;
/** Backstop so a bogus totalPages can't loop forever (~12k/50 ≈ 243 real pages). */
const CATALOG_MAX_PAGES = 1000;

const extractTotalPages = (body: unknown): number => {
  const data = isObject(body) ? body['data'] : undefined;
  const productSearch = isObject(data) ? data['productSearch'] : undefined;
  const pagination = isObject(productSearch) ? productSearch['pagination'] : undefined;
  const totalPages = isObject(pagination) ? pagination['totalPages'] : undefined;

  return 'number' === typeof totalPages && 0 < totalPages ? totalPages : 1;
};

/**
 * The folded string an AB query's tokens are LIKE-matched against: brand + name
 * in @grocery/core's shared comparison form (normalizeTitle), so the D1 index and
 * the client-side matcher fold identically and an indexed row matches the same
 * queries the live search would.
 */
export const abHaystack = (brand: string | null, name: string): string =>
  normalizeTitle(`${brand ?? ''} ${name}`.trim());

/**
 * Tokenize a query into the AND-terms matched against an AB catalog haystack.
 * Same fold as abHaystack so both sides agree; drops empty tokens. Shared by the
 * edge index query (index.ts) and this module so they tokenize identically.
 */
export const abQueryTokens = (query: string): string[] =>
  normalizeTitle(query)
    .split(' ')
    .filter((token) => 0 < token.length);

/** One AB product flattened for the D1 discovery index (AB carries no EAN/barcode). */
export interface AbCatalogEntry {
  sku: string;
  name: string;
  url: string;
  /** Folded brand + name — the LIKE target (see abHaystack). */
  haystack: string;
  brand: string | null;
  pricePiece: number | null;
  priceUnit: number | null;
  unitLabel: string | null;
  imageUrl: string | null;
}

const toAbCatalogEntry = (result: RetailerSearchResult): AbCatalogEntry => ({
  sku: result.sku,
  name: result.title,
  url: result.url,
  haystack: abHaystack(result.brand, result.title),
  brand: result.brand,
  pricePiece: result.pricePiece,
  priceUnit: result.priceUnit,
  unitLabel: result.unitLabel,
  imageUrl: result.imageUrl ?? null,
});

/**
 * Crawl AB's WHOLE catalog into index entries — the off-edge counterpart to
 * searchProducts, run from a residential IP by the daily scrape (where AB's
 * GraphQL answers directly and free). Pages the empty-free-text browse
 * (CATALOG_QUERY) at CATALOG_PAGE_SIZE until every page is read, deduping by SKU
 * (a product can recur across pages as the backing result set shifts). Reuses
 * mapSearchResponse via fetchProductSearchPage so index rows match live-search
 * listings field-for-field. Sequential on purpose — one gentle daily crawl, not
 * a burst that trips AB's WAF.
 */
export const buildAbCatalogIndex = async (
  fetchImpl: typeof fetch,
): Promise<AbCatalogEntry[]> => {
  const entries: AbCatalogEntry[] = [];
  const seen = new Set<string>();

  const collect = (results: readonly RetailerSearchResult[]): void => {
    for (const result of results) {
      if (false === seen.has(result.sku)) {
        seen.add(result.sku);
        entries.push(toAbCatalogEntry(result));
      }
    }
  };

  const first = await fetchProductSearchPage(CATALOG_QUERY, fetchImpl, 0, CATALOG_PAGE_SIZE);
  collect(first.results);

  const totalPages = Math.min(first.totalPages, CATALOG_MAX_PAGES);

  for (let pageNumber = 1; pageNumber < totalPages; pageNumber += 1) {
    const page = await fetchProductSearchPage(CATALOG_QUERY, fetchImpl, pageNumber, CATALOG_PAGE_SIZE);
    collect(page.results);
  }

  return entries;
};

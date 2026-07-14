import type { RetailerSearchResult, ScrapedListing } from '@grocery/core/types';
import { normalizeTitle } from '@grocery/core/normalize';
import { jittered, sleep } from './polite';
import { AdapterError, toGreekFloat, type RetailerAdapter } from './types';

// Live markup interleaves tags: "3,14 €<span>/τεμ.</span>" — allow tags
// and whitespace between the € sign and the /label.
const PRICE_PATTERN = /(\d[\d.]*,\d{2})\s*€\s*(?:<[^>]*>\s*)*\/\s*([^\s<&"]+)/g;
const H1_PATTERN = /<h1[^>]*>([\s\S]*?)<\/h1>/;
const SKU_PATTERN = /Κωδικός:\s*(?:<[^>]+>\s*)*(\d+)/;
const TAG_PATTERN = /<[^>]+>/g;
// One pass over both identity carriers, in document order: the tile's
// wishlist icon exposes data-productsku BEFORE the title anchor. Not
// every slug ends in the numeric code (granola: "...-350gr-1599382/",
// but the ΟΛΥΜΠΟΣ milk: "...-lipara-1lt/") — slug first, data attribute
// as the fallback, else the product is invisible to search.
const SEARCH_ITEM_PATTERN =
  /data-productsku="(\d+)"|<h4 class="product__title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const SKU_FROM_SLUG_PATTERN = /-(\d{6,})\/?$/;

const BASE_URL = 'https://www.sklavenitis.gr';
const SEARCH_PATH = '/apotelesmata-anazitisis/';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) personal-price-watch/1.0';

/**
 * Sklavenitis pages are fully server-rendered: name in <h1>,
 * internal SKU after "Κωδικός:", prices as "3,14 €<span>/τεμ.</span>"
 * literals in the markup. Search results are also server-rendered
 * (tiles carry title + URL; prices there load client-side, so search
 * yields identity only — prices come from the product page).
 */
export const sklavenitisAdapter: RetailerAdapter = {
  id: 'sklavenitis',
  // sklavenitis.gr's WAF USED to block Cloudflare egress IPs, so this once needed
  // the residential proxy. Re-probed from a real Worker egress IP on 2026-07-07
  // (wrangler dev --remote): search returns results AND the product page parses a
  // price, 3/3, HTTP 200 — the block is gone. So it answers the edge directly on
  // the free global fetch and costs nothing. If it starts 403/503-ing again, it
  // would need the same off-edge D1-catalog-index treatment AB and Kritikos get
  // (the Scrape.do render proxy has been retired) — not a per-request proxy.

  async scrapeProduct(url, fetchImpl) {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });

    if (false === response.ok) {
      throw new AdapterError('sklavenitis', url, `HTTP ${response.status}`);
    }

    const html = await response.text();
    const listing = parseProductHtml(html);

    if (null === listing.name && null === listing.pricePiece) {
      throw new AdapterError('sklavenitis', url, 'page did not match any known selector');
    }

    return listing;
  },

  async searchProducts(query, fetchImpl) {
    const url = `${BASE_URL}${SEARCH_PATH}?Query=${encodeURIComponent(query)}`;

    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });

    if (false === response.ok) {
      throw new AdapterError('sklavenitis', url, `HTTP ${response.status}`);
    }

    return parseSearchHtml(await response.text());
  },
};

export const parseSearchHtml = (html: string): RetailerSearchResult[] => {
  const results: RetailerSearchResult[] = [];
  const seenSkus = new Set<string>();
  let pendingSku: string | null = null;

  for (const match of html.matchAll(SEARCH_ITEM_PATTERN)) {
    if (undefined !== match[1]) {
      pendingSku = match[1];
      continue;
    }

    const href = match[2];
    const rawTitle = match[3];
    const tileSku = pendingSku;
    pendingSku = null;

    if (undefined === href || undefined === rawTitle) {
      continue;
    }

    const sku = href.match(SKU_FROM_SLUG_PATTERN)?.[1] ?? tileSku;

    if (null === sku || undefined === sku || seenSkus.has(sku)) {
      continue;
    }

    seenSkus.add(sku);

    results.push({
      retailer: 'sklavenitis',
      sku,
      title: decodeEntities(rawTitle.replace(TAG_PATTERN, '')).trim(),
      url: `${BASE_URL}${href}`,
      brand: null,
      ean: null,
      pricePiece: null,
      priceUnit: null,
      unitLabel: null,
    });
  }

  return results;
};

export const parseProductHtml = (html: string): ScrapedListing => {
  const { pricePiece, priceUnit, unitLabel } = extractPrices(html);

  return {
    name: extractName(html),
    sku: extractSku(html),
    pricePiece,
    priceUnit,
    unitLabel,
  };
};

const extractName = (html: string): string | null => {
  const match = html.match(H1_PATTERN);

  if (null === match || undefined === match[1]) {
    return null;
  }

  return decodeEntities(match[1].replace(TAG_PATTERN, '')).trim();
};

const extractSku = (html: string): string | null => {
  const match = html.match(SKU_PATTERN);

  if (null === match || undefined === match[1]) {
    return null;
  }

  return match[1];
};

const extractPrices = (
  html: string,
): Pick<ScrapedListing, 'pricePiece' | 'priceUnit' | 'unitLabel'> => {
  const piecePrices: number[] = [];
  const unitPrices: number[] = [];
  let unitLabel: string | null = null;

  for (const match of html.matchAll(PRICE_PATTERN)) {
    const rawValue = match[1];
    const rawLabel = match[2];

    if (undefined === rawValue || undefined === rawLabel) {
      continue;
    }

    const value = toGreekFloat(rawValue);

    if (null === value) {
      continue;
    }

    const label = decodeEntities(rawLabel).replace(/[.,;]+$/, '');

    if (label.startsWith('τεμ')) {
      piecePrices.push(value);
    } else {
      unitPrices.push(value);

      if (null === unitLabel) {
        unitLabel = label;
      }
    }
  }

  return {
    // Discounted products render initial + final price; the final
    // (payable) price is the lowest.
    pricePiece: pickLowest(piecePrices),
    priceUnit: pickLowest(unitPrices),
    unitLabel,
  };
};

const pickLowest = (prices: readonly number[]): number | null => {
  if (0 === prices.length) {
    return null;
  }

  return Math.min(...prices);
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
  return raw.replace(/&[a-z#0-9]+;/gi, (entity) => {
    const decoded = ENTITY_MAP.get(entity);

    if (undefined === decoded) {
      return entity;
    }

    return decoded;
  });
};

// --- Sklavenitis catalog discovery index (the off-edge D1 path) -------------
//
// Sklavenitis's WAF intermittently 403s Cloudflare's edge IPs again (re-observed
// 2026-07-14: ~24 search failures/day in prod, ~30% of them 403 — reputation
// flagging, not a hard block, so a single probe sails through while production
// accumulates them). So Sklavenitis gets the same treatment AB and Kritikos do:
// the off-edge daily scrape (residential IP, where sklavenitis.gr answers fine)
// crawls the whole catalog into a D1 table once a day, and the edge answers
// search with a cheap `haystack LIKE ?` (searchSklavenitisCatalog in index.ts) —
// no live edge egress, so the whole live-search failure tail disappears, not
// just the 403s.
//
// Unlike AB (a JSON browse API) the catalog is walked as HTML: the Products
// sitemap only lists URLs (Latin-transliterated slugs that won't match Greek
// queries, 39% without an embedded SKU), so we crawl the CATEGORY pages instead,
// whose server-rendered tiles parse with the very same parseSearchHtml the live
// search uses — clean Greek names + real SKUs.

const BASE_HEADERS = { 'User-Agent': USER_AGENT, Accept: 'text/html' } as const;

/** Leaf category pages render 24 tiles; pagination is `?pg=N` (verified live). */
const CATALOG_PAGE_SIZE = 24;
/** Per-category page backstop so a runaway can't loop (24×100 = 2400 products). */
const CATALOG_MAX_PAGES_PER_CATEGORY = 100;
/**
 * Gap between category-page fetches (jittered ±25%). ~800 pages back-to-back is
 * the burst shape a WAF rate-scores; ~350ms apart keeps it a browser-paced
 * trickle and stretches the crawl by only a few minutes. Tests pass 0.
 */
const CATALOG_PAGE_DELAY_MS = 350;
/**
 * A few category pages may fail without failing the whole crawl (a transient
 * 5xx on one of ~800 pages must not leave the entire index stale). The budget is
 * small so systemic breakage (every page 403-ing) still fails loudly instead of
 * silently shipping a decimated index that the empty-guard won't catch.
 */
const CATALOG_MAX_FAILED_PAGES = 20;

/** ProductCategories sitemap → every category URL; the crawl walks the leaves. */
const CATEGORY_SITEMAP_INDEX = `${BASE_URL}/sitemap/ProductCategories/sitemap_index.xml`;
const LOC_PATTERN = /<loc>([^<]+)<\/loc>/g;

/**
 * The folded string a query's tokens are LIKE-matched against. Sklavenitis
 * search yields no separate brand field, but the tile title already leads with
 * the brand, so the name alone — run through @grocery/core's shared
 * normalizeTitle, exactly as abHaystack does — is the whole haystack. Same fold
 * as the client matcher, so an indexed row matches the same queries live search
 * would.
 */
export const sklavenitisHaystack = (name: string): string => normalizeTitle(name);

/**
 * Tokenize a query into the AND-terms matched against a catalog haystack — same
 * fold as sklavenitisHaystack so both sides agree. Shared by the edge index
 * query (index.ts) and this module so they tokenize identically.
 */
export const sklavenitisQueryTokens = (query: string): string[] =>
  normalizeTitle(query)
    .split(' ')
    .filter((token) => 0 < token.length);

/** One Sklavenitis product flattened for the D1 discovery index (no EAN/price). */
export interface SklavenitisCatalogEntry {
  sku: string;
  name: string;
  url: string;
  /** Folded name — the LIKE target (see sklavenitisHaystack). */
  haystack: string;
}

const toSklavenitisCatalogEntry = (result: RetailerSearchResult): SklavenitisCatalogEntry => ({
  sku: result.sku,
  name: result.title,
  url: result.url,
  haystack: sklavenitisHaystack(result.title),
});

const extractLocs = (xml: string): string[] =>
  [...xml.matchAll(LOC_PATTERN)].map((match) => match[1]).filter((loc): loc is string => undefined !== loc);

/**
 * A category is a leaf (has products directly) when its path is ≥3 segments deep
 * — e.g. /anapsyktika.../anapsyktika-sodes.../lemonades-gkazozes/. Shallower URLs
 * are pure navigation whose products all live in leaves, so skipping them keeps
 * the crawl to ~800 pages instead of re-paging every parent's full subtree.
 */
const isLeafCategory = (url: string): boolean => {
  try {
    return 3 <= new URL(url).pathname.split('/').filter((segment) => 0 < segment.length).length;
  } catch {
    return false;
  }
};

const fetchText = async (url: string, fetchImpl: typeof fetch): Promise<string> => {
  const response = await fetchImpl(url, { headers: BASE_HEADERS });

  if (false === response.ok) {
    throw new AdapterError('sklavenitis', url, `HTTP ${response.status}`);
  }

  return response.text();
};

/** Every leaf category URL, read from the two-level ProductCategories sitemap. */
const fetchCategoryUrls = async (fetchImpl: typeof fetch): Promise<string[]> => {
  const indexXml = await fetchText(CATEGORY_SITEMAP_INDEX, fetchImpl);
  const categoryUrls: string[] = [];

  for (const childSitemap of extractLocs(indexXml)) {
    categoryUrls.push(...extractLocs(await fetchText(childSitemap, fetchImpl)));
  }

  return categoryUrls.filter(isLeafCategory);
};

/** One category page (page 1 is the bare URL; page N is `?pg=N`). */
const fetchCategoryPage = async (
  categoryUrl: string,
  fetchImpl: typeof fetch,
  pageNumber: number,
): Promise<RetailerSearchResult[]> => {
  const url = 1 === pageNumber ? categoryUrl : `${categoryUrl}?pg=${pageNumber}`;
  return parseSearchHtml(await fetchText(url, fetchImpl));
};

/**
 * Crawl the WHOLE Sklavenitis catalog into index entries — the off-edge
 * counterpart to searchProducts, run from a residential IP by the daily scrape
 * (where sklavenitis.gr answers directly). Walks every leaf category, paging
 * `?pg=N` until a page comes back short or empty (an out-of-range page returns
 * zero tiles — verified live), deduping by SKU across the whole catalog (a
 * product recurs across categories/cross-sell widgets). Sequential AND paced on
 * purpose — one gentle daily crawl, not a burst that re-trips the WAF (tests
 * pass pageDelayMs: 0 to stay instant).
 */
export const buildSklavenitisCatalogIndex = async (
  fetchImpl: typeof fetch,
  options?: {
    pageDelayMs?: number;
    /** Fired per skipped page so the caller can log it — the crawl stays pure. */
    onPageError?: (categoryUrl: string, pageNumber: number, error: unknown) => void;
  },
): Promise<SklavenitisCatalogEntry[]> => {
  const pageDelayMs = options?.pageDelayMs ?? CATALOG_PAGE_DELAY_MS;
  const entries: SklavenitisCatalogEntry[] = [];
  const seen = new Set<string>();
  let failedPages = 0;

  const collect = (results: readonly RetailerSearchResult[]): void => {
    for (const result of results) {
      if (false === seen.has(result.sku)) {
        seen.add(result.sku);
        entries.push(toSklavenitisCatalogEntry(result));
      }
    }
  };

  const categories = await fetchCategoryUrls(fetchImpl);

  for (const categoryUrl of categories) {
    for (let pageNumber = 1; pageNumber <= CATALOG_MAX_PAGES_PER_CATEGORY; pageNumber += 1) {
      if (0 < pageDelayMs) {
        await sleep(jittered(pageDelayMs));
      }

      let results: RetailerSearchResult[];

      try {
        results = await fetchCategoryPage(categoryUrl, fetchImpl, pageNumber);
      } catch (error) {
        failedPages += 1;
        options?.onPageError?.(categoryUrl, pageNumber, error);

        if (CATALOG_MAX_FAILED_PAGES < failedPages) {
          throw error;
        }

        break; // give up on this category; move to the next
      }

      if (0 === results.length) {
        break; // past the last page (an out-of-range ?pg=N renders zero tiles)
      }

      collect(results);

      // A page short of a full grid is the last one, so stop before the empty
      // fetch; a category that is an exact multiple of the grid takes one more
      // (empty) page, caught above.
      if (results.length < CATALOG_PAGE_SIZE) {
        break;
      }
    }
  }

  return entries;
};

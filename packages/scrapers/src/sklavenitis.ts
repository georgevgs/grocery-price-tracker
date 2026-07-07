import type { RetailerSearchResult, ScrapedListing } from '@grocery/core/types';
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
  // sklavenitis.gr's WAF USED to block Cloudflare egress IPs, so this carried
  // needsResidentialEgress and every edge search/resolve cost a proxy credit.
  // Re-probed from a real Worker egress IP on 2026-07-07 (wrangler dev --remote,
  // src/probe.ts): search returns results AND the product page parses a price,
  // 3/3, HTTP 200 — the block is gone. So it now answers the edge directly on
  // the free global fetch and costs nothing. If it starts 403/503-ing again,
  // set `needsResidentialEgress: true` here to route it back through the proxy.
  // (AB, re-probed the same way, still 403s the edge — it keeps its flag.)

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

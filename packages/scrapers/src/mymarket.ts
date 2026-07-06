import type { RetailerSearchResult, ScrapedListing } from '@grocery/core/types';
import { AdapterError, toGreekFloat, type RetailerAdapter } from './types';

const BASE_URL = 'https://www.mymarket.gr';
const JSON_LD_PATTERN = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
// <div class="measure-label-wrapper"><span class="font-semibold">4,82€</span><span>Τιμή κιλού</span>
const MEASURE_PATTERN =
  /measure-label-wrapper">\s*<span class="font-semibold">([\d.,]+)\s*€<\/span>\s*<span>Τιμή\s+(\S+)<\/span>/;
// Sold-by-weight products carry the suffix in their name ("... Τιμή Κιλού").
const WEIGHED_NAME_PATTERN = /Τιμή\s+(Κιλού|Λίτρου)/i;
// Search tiles: <a href="https://www.mymarket.gr/<slug>" rel="bookmark" ...
// data-google-analytics-item-param="{...}">. Intervening attribute values
// contain ">" (data-action="click->..."), so quoted values must be
// consumed atomically rather than excluded with [^>].
const SEARCH_TILE_PATTERN =
  /<a href="(https:\/\/www\.mymarket\.gr\/[^"]+)"\s+rel="bookmark"(?:[^>"]|"[^"]*")*?data-google-analytics-item-param="([^"]+)"/g;

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) personal-price-watch/1.0';

/**
 * mymarket.gr (Laravel + Turbo) is fully server-rendered: product pages
 * carry a JSON-LD @graph with name/sku/offers.price, and the €/unit
 * figure sits in a "measure-label-wrapper" div. Search results are
 * server-rendered tiles whose analytics attribute holds sku/name/price
 * as JSON (verified live 2026-07-05, no auth or bot challenge).
 *
 * A LiteSpeed cache serves pages up to 6h stale, so the price scrape
 * appends a cache-busting param to force a fresh render.
 *
 * Sold-by-weight products (name suffixed "Τιμή Κιλού") are special:
 * JSON-LD offers.price is a minimum-portion price, not a piece price —
 * only the per-kg figure is meaningful for them.
 */
export const mymarketAdapter: RetailerAdapter = {
  id: 'mymarket',

  async scrapeProduct(url, fetchImpl) {
    const separator = url.includes('?') ? '&' : '?';
    const freshUrl = `${url}${separator}fresh=${Date.now()}`;

    const response = await fetchImpl(freshUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });

    if (false === response.ok) {
      throw new AdapterError('mymarket', url, `HTTP ${response.status}`);
    }

    const listing = parseProductHtml(await response.text());

    if (null === listing.name) {
      throw new AdapterError('mymarket', url, 'page did not contain a JSON-LD Product block');
    }

    return listing;
  },

  async searchProducts(query, fetchImpl, hints) {
    const ean = hints?.ean;
    const [textResults, eanResults] = await Promise.all([
      runSearch(query, fetchImpl),
      undefined !== ean && 0 < ean.length ? runSearch(ean, fetchImpl) : Promise.resolve([]),
    ]);

    // Their search resolves barcodes to the exact product — when the
    // tracker knows the EAN, that beats fuzzy title matching. A unique
    // hit is barcode-confirmed, so stamp it as such.
    if (1 === eanResults.length && undefined !== eanResults[0] && undefined !== ean) {
      eanResults[0] = { ...eanResults[0], ean };
    }

    const results: RetailerSearchResult[] = [];
    const seenSkus = new Set<string>();

    for (const result of [...eanResults, ...textResults]) {
      if (seenSkus.has(result.sku)) {
        continue;
      }

      seenSkus.add(result.sku);
      results.push(result);
    }

    return results;
  },
};

const runSearch = async (
  term: string,
  fetchImpl: typeof fetch,
): Promise<RetailerSearchResult[]> => {
  const url = `${BASE_URL}/search?query=${encodeURIComponent(term)}`;

  const response = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
  });

  if (false === response.ok) {
    throw new AdapterError('mymarket', url, `HTTP ${response.status}`);
  }

  return parseSearchHtml(await response.text());
};

interface JsonObject {
  [key: string]: unknown;
}

const isObject = (value: unknown): value is JsonObject => {
  return 'object' === typeof value && null !== value && false === Array.isArray(value);
};

export const parseProductHtml = (html: string): ScrapedListing => {
  const product = findProductJsonLd(html);

  if (null === product) {
    return { name: null, sku: null, pricePiece: null, priceUnit: null, unitLabel: null };
  }

  const name = 'string' === typeof product['name'] ? product['name'] : null;
  const offers = isObject(product['offers']) ? product['offers'] : {};
  const measure = parseMeasureLabel(html);

  let pricePiece: number | null = null;

  // Weighed products advertise the per-kg figure as the display price;
  // their JSON-LD price is a serving-size fraction — skip it.
  if (null === name || false === WEIGHED_NAME_PATTERN.test(name)) {
    const rawPrice = offers['price'];

    if ('number' === typeof rawPrice) {
      pricePiece = rawPrice;
    } else if ('string' === typeof rawPrice) {
      pricePiece = toGreekFloat(rawPrice);
    }
  }

  return {
    name,
    sku: 'string' === typeof product['sku'] ? product['sku'] : null,
    pricePiece,
    priceUnit: measure.priceUnit,
    unitLabel: measure.unitLabel,
    imageUrl: extractJsonLdImage(product['image']),
  };
};

/**
 * schema.org `image` on a JSON-LD Product is polymorphic: a bare URL
 * string, an array of them, or an ImageObject with a `url` (My Market
 * serves the last — verified live 2026-07-05). Unwrap all three.
 */
export const extractJsonLdImage = (raw: unknown): string | null => {
  const first = Array.isArray(raw) ? raw[0] : raw;

  if ('string' === typeof first && 0 < first.length) {
    return first;
  }

  if (isObject(first) && 'string' === typeof first['url'] && 0 < first['url'].length) {
    return first['url'];
  }

  return null;
};

const findProductJsonLd = (html: string): JsonObject | null => {
  for (const match of html.matchAll(JSON_LD_PATTERN)) {
    if (undefined === match[1]) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }

    if (false === isObject(parsed) || false === Array.isArray(parsed['@graph'])) {
      continue;
    }

    const first: unknown = parsed['@graph'][0];

    if (isObject(first) && 'Product' === first['@type']) {
      return first;
    }
  }

  return null;
};

const parseMeasureLabel = (
  html: string,
): Pick<ScrapedListing, 'priceUnit' | 'unitLabel'> => {
  const match = html.match(MEASURE_PATTERN);

  if (null === match || undefined === match[1] || undefined === match[2]) {
    return { priceUnit: null, unitLabel: null };
  }

  return {
    priceUnit: toGreekFloat(match[1]),
    unitLabel: toUnitLabel(match[2]),
  };
};

/** The label is genitive ("Τιμή κιλού"); align with the Sklavenitis-style nominative. */
const toUnitLabel = (raw: string): string => {
  const lowered = raw.toLowerCase();

  if ('κιλού' === lowered) {
    return 'κιλό';
  }

  if ('λίτρου' === lowered) {
    return 'λίτρο';
  }

  return lowered;
};

export const parseSearchHtml = (html: string): RetailerSearchResult[] => {
  const results: RetailerSearchResult[] = [];
  const seenSkus = new Set<string>();

  for (const match of html.matchAll(SEARCH_TILE_PATTERN)) {
    const href = match[1];
    const rawParam = match[2];

    if (undefined === href || undefined === rawParam) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(decodeEntities(rawParam));
    } catch {
      continue;
    }

    if (false === isObject(parsed)) {
      continue;
    }

    const sku = parsed['id'];
    const name = parsed['name'];

    if ('string' !== typeof sku || 'string' !== typeof name || seenSkus.has(sku)) {
      continue;
    }

    seenSkus.add(sku);

    const brand = parsed['brand'];
    const price = parsed['price'];

    results.push({
      retailer: 'mymarket',
      sku,
      title: name,
      url: href,
      brand: 'string' === typeof brand && 0 < brand.length ? brand : null,
      ean: null,
      pricePiece: 'string' === typeof price ? toGreekFloat(price) : null,
      priceUnit: null,
      unitLabel: null,
    });
  }

  return results;
};

const ENTITY_MAP = new Map<string, string>([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#039;', "'"],
  ['&#39;', "'"],
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

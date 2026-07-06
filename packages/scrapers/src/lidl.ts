import type { RetailerSearchResult, ScrapedListing } from '@grocery/core/types';
import { AdapterError, ListingGoneError, toGreekFloat, type RetailerAdapter } from './types';

const BASE_URL = 'https://www.lidl-hellas.gr';
const SEARCH_API = `${BASE_URL}/q/api/search`;
const JSON_LD_PATTERN = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
// "1 Kg = 3,58€" and the promo variant "1 kg = Από 11,30€ σε 9,30€".
const BASE_PRICE_PATTERN = /1\s*(Kg|kg|Lt|lt|L|l)\s*=([^<]*)/;
const EURO_AMOUNT_PATTERN = /(\d[\d.,]*)\s*€/g;

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) personal-price-watch/1.0';

/**
 * lidl-hellas.gr is NOT a full e-shop: it lists only the weekly in-store
 * promotions, so listings track advertised offers, not shelf prices, and
 * product pages churn with the promo calendar. Pages are Nuxt-SSR:
 * name/SKU/price live in a JSON-LD Product block, the unit price only in
 * rendered HTML ("1 Kg = 3,58€"). Search is a public JSON API (verified
 * live 2026-07-05, no auth or bot protection).
 *
 * Products carry two prices — the regular promo price first, then the
 * Lidl Plus app price (starred). JSON-LD and price.price both hold the
 * regular one; the first base-price match in HTML is the regular one too.
 */
export const lidlAdapter: RetailerAdapter = {
  id: 'lidl',

  async scrapeProduct(url, fetchImpl) {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });

    if (404 === response.status || 410 === response.status) {
      throw new ListingGoneError('lidl', url, 'offer week ended — the promo page is gone');
    }

    if (false === response.ok) {
      throw new AdapterError('lidl', url, `HTTP ${response.status}`);
    }

    const listing = parseProductHtml(await response.text());

    if (null === listing.name && null === listing.pricePiece) {
      throw new AdapterError('lidl', url, 'page did not contain a JSON-LD Product block');
    }

    return listing;
  },

  async searchProducts(query, fetchImpl, hints) {
    const textResults = await runSearchQuery(query, fetchImpl);

    if (undefined === hints?.ean || false === /^\d{8,14}$/.test(hints.ean)) {
      return textResults;
    }

    // A numeric query answers {"type":"redirect"} pointing at the product
    // page — Lidl resolving the barcode IS the identity assertion. Best
    // effort: a failed lookup must not cost the text results.
    let eanResult: RetailerSearchResult | null = null;

    try {
      eanResult = await searchByEan(hints.ean, fetchImpl);
    } catch {
      eanResult = null;
    }

    if (null === eanResult) {
      return textResults;
    }

    const eanSku = eanResult.sku;

    return [eanResult, ...textResults.filter((result) => eanSku !== result.sku)];
  },
};

const runSearchQuery = async (
  query: string,
  fetchImpl: typeof fetch,
): Promise<RetailerSearchResult[]> => {
  const params = new URLSearchParams({
    q: query,
    assortment: 'GR',
    locale: 'el_GR',
    version: '2.1.0',
    fetchsize: '20',
  });
  const url = `${SEARCH_API}?${params.toString()}`;

  const response = await fetchImpl(url, {
    // The endpoint 406s on "Accept: application/json" — only */* passes.
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
  });

  if (false === response.ok) {
    throw new AdapterError('lidl', url, `HTTP ${response.status}`);
  }

  return mapSearchResponse(await response.json(), url);
};

const searchByEan = async (
  ean: string,
  fetchImpl: typeof fetch,
): Promise<RetailerSearchResult | null> => {
  const params = new URLSearchParams({
    q: ean,
    assortment: 'GR',
    locale: 'el_GR',
    version: '2.1.0',
    fetchsize: '1',
  });
  const url = `${SEARCH_API}?${params.toString()}`;

  const response = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
  });

  if (false === response.ok) {
    return null;
  }

  const body: unknown = await response.json();

  if (false === isObject(body) || 'redirect' !== body['type'] || 'string' !== typeof body['redirectURL']) {
    return null;
  }

  const redirectUrl = body['redirectURL'].startsWith('http')
    ? body['redirectURL']
    : `${BASE_URL}${body['redirectURL']}`;

  const pageResponse = await fetchImpl(redirectUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
  });

  if (false === pageResponse.ok) {
    return null;
  }

  const listing = parseProductHtml(await pageResponse.text());

  if (null === listing.sku || null === listing.name) {
    return null;
  }

  return {
    retailer: 'lidl',
    sku: listing.sku,
    title: listing.name,
    url: redirectUrl,
    brand: null,
    // The page's own gtin13 is authoritative; the resolved query is the
    // fallback identity when the JSON-LD omits it.
    ean: listing.ean ?? ean,
    pricePiece: listing.pricePiece,
    priceUnit: listing.priceUnit,
    unitLabel: listing.unitLabel,
    imageUrl: listing.imageUrl ?? null,
  };
};

interface JsonObject {
  [key: string]: unknown;
}

const isObject = (value: unknown): value is JsonObject => {
  return 'object' === typeof value && null !== value && false === Array.isArray(value);
};

export const parseProductHtml = (html: string): ScrapedListing => {
  const product = findProductJsonLd(html);
  const basePrice = parseBasePriceText(html);

  if (null === product) {
    return { name: null, sku: null, pricePiece: null, priceUnit: null, unitLabel: null, ean: null };
  }

  const offers = Array.isArray(product['offers']) ? product['offers'] : [];
  const firstOffer: unknown = offers[0];
  const price = isObject(firstOffer) ? firstOffer['price'] : undefined;

  return {
    name: 'string' === typeof product['name'] ? product['name'] : null,
    sku: 'string' === typeof product['sku'] ? product['sku'] : null,
    pricePiece: 'number' === typeof price ? price : null,
    priceUnit: basePrice.priceUnit,
    unitLabel: basePrice.unitLabel,
    ean: extractGtin(product['gtin13']),
    imageUrl: extractJsonLdImage(product['image']),
  };
}

/** JSON-LD `image`: a URL string, an array of them, or an ImageObject. */
const extractJsonLdImage = (raw: unknown): string | null => {
  const first = Array.isArray(raw) ? raw[0] : raw;

  if ('string' === typeof first && 0 < first.length) {
    return first;
  }

  if (isObject(first) && 'string' === typeof first['url'] && 0 < first['url'].length) {
    return first['url'];
  }

  return null;
};

// JSON-LD carries gtin13 as either a bare string or a one-element array.
const extractGtin = (raw: unknown): string | null => {
  const value = Array.isArray(raw) ? raw[0] : raw;

  if ('string' === typeof value && /^\d{8,14}$/.test(value)) {
    return value;
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

    if (isObject(parsed) && 'Product' === parsed['@type']) {
      return parsed;
    }
  }

  return null;
};

export const mapSearchResponse = (body: unknown, url: string): RetailerSearchResult[] => {
  if (false === isObject(body)) {
    throw new AdapterError('lidl', url, 'unexpected non-object search response');
  }

  const items = body['items'];

  if (false === Array.isArray(items)) {
    // Numeric queries answer {"type":"redirect"}, empty ones {"type":"empty"}.
    if ('string' === typeof body['type']) {
      return [];
    }

    throw new AdapterError('lidl', url, 'unexpected response shape: items missing');
  }

  const results: RetailerSearchResult[] = [];

  for (const item of items) {
    if (false === isObject(item)) {
      continue;
    }

    const gridbox = isObject(item['gridbox']) ? item['gridbox'] : undefined;
    const data = isObject(gridbox?.['data']) ? gridbox['data'] : undefined;

    if (undefined === data) {
      continue;
    }

    const erpNumber = data['erpNumber'];
    const fullTitle = data['fullTitle'];
    const canonicalUrl = data['canonicalUrl'];

    if ('string' !== typeof erpNumber || 'string' !== typeof fullTitle || 'string' !== typeof canonicalUrl) {
      continue;
    }

    const price = isObject(data['price']) ? data['price'] : {};
    const brandObj = isObject(data['brand']) ? data['brand'] : undefined;
    const brand = brandObj?.['name'];
    const basePriceObj = isObject(price['basePrice']) ? price['basePrice'] : undefined;
    const basePriceText = basePriceObj?.['text'];
    const basePrice = parseBasePriceText('string' === typeof basePriceText ? basePriceText : '');

    results.push({
      retailer: 'lidl',
      sku: erpNumber,
      title: fullTitle,
      url: `${BASE_URL}${canonicalUrl}`,
      brand: 'string' === typeof brand && 0 < brand.length ? brand : null,
      ean: null,
      pricePiece: 'number' === typeof price['price'] ? price['price'] : null,
      priceUnit: basePrice.priceUnit,
      unitLabel: basePrice.unitLabel,
    });
  }

  return results;
};

/**
 * The unit price is a localized free-text string. The promo variant
 * ("Από 11,30€ σε 9,30€") lists old-then-current — the last € amount
 * is the payable one.
 */
export const parseBasePriceText = (
  text: string,
): Pick<ScrapedListing, 'priceUnit' | 'unitLabel'> => {
  const match = text.match(BASE_PRICE_PATTERN);

  if (null === match || undefined === match[1] || undefined === match[2]) {
    return { priceUnit: null, unitLabel: null };
  }

  let lastAmount: string | null = null;

  for (const amount of match[2].matchAll(EURO_AMOUNT_PATTERN)) {
    lastAmount = amount[1] ?? lastAmount;
  }

  if (null === lastAmount) {
    return { priceUnit: null, unitLabel: null };
  }

  return {
    priceUnit: toGreekFloat(lastAmount),
    unitLabel: 'k' === match[1].toLowerCase().charAt(0) ? 'κιλό' : 'λίτρο',
  };
};

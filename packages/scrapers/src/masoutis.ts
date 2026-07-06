import type { RetailerSearchResult, ScrapedListing } from '@grocery/core/types';
import { AdapterError, toGreekFloat, type RetailerAdapter } from './types';

const BASE_URL = 'https://www.masoutis.gr';
const CRED_URL = `${BASE_URL}/api/eshop/GetCred`;
const ITEM_URL = `${BASE_URL}/api/eshop/GetOfferItemCustWithCoupons`;
const SEARCH_URL = `${BASE_URL}/api/eshop/SearchAllItemsWithCouponsV2`;

/**
 * Anonymous-session passphrase hardcoded in the site's JS bundle
 * (main-*.js, captured 2026-07-05). Rotates only on app redeploys;
 * if POSTs start failing with valid creds, re-extract it from the bundle.
 */
const PASS_KEY = 'Sc@NnSh0p';

// Product URLs put the item code in the query-string KEY: ...item/<slug>?2660512=
const SKU_FROM_URL_PATTERN = /[?&](\d{6,8})(?=[=&]|$)/;
// "88,50€/κιλ" (detail, comma decimal) and "0.990€/λιτ" (search, dot decimal).
const UNIT_LABEL_PATTERN = /([\d.,]+)\s*€\s*\/\s*(\S+)/;

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) personal-price-watch/1.0';

interface MasoutisCred {
  uid: string;
  usl: string;
  key: string;
}

/**
 * masoutis.gr is an Angular shell over an ASP.NET JSON API. Every data
 * call is a POST guarded by three headers (Uid/Usl/Key) that a free,
 * anonymous GET /api/eshop/GetCred hands out — no login, no cookies.
 * The product page HTML carries no data; the item code embedded in the
 * page URL keys the GetOfferItemCustWithCoupons endpoint instead.
 * Search field names are misleading: Itemcode = query text,
 * IfWeight = 1-based page number (50 rows/page).
 */
export const masoutisAdapter: RetailerAdapter = {
  id: 'masoutis',

  async scrapeProduct(url, fetchImpl) {
    const skuMatch = url.match(SKU_FROM_URL_PATTERN);

    if (null === skuMatch || undefined === skuMatch[1]) {
      throw new AdapterError('masoutis', url, 'could not derive item code from URL (expected ?<digits>=)');
    }

    const cred = await getCred(fetchImpl, url);
    const body: unknown = await postJson(
      fetchImpl,
      ITEM_URL,
      { Itemcode: skuMatch[1], PassKey: PASS_KEY, Zip: '' },
      cred,
      url,
    );

    if (false === isObject(body) || 'string' !== typeof body['ItemDescr']) {
      throw new AdapterError('masoutis', url, `API returned no item for code ${skuMatch[1]}`);
    }

    return mapItem(body, url);
  },

  async searchProducts(query, fetchImpl, hints) {
    const cred = await getCred(fetchImpl, SEARCH_URL);
    const ean = hints?.ean;

    const [textResults, eanResults] = await Promise.all([
      runSearch(query, fetchImpl, cred),
      undefined !== ean && 0 < ean.length
        ? runSearch(ean, fetchImpl, cred)
        : Promise.resolve([]),
    ]);

    // Their search resolves barcodes — a unique hit for the EAN query is
    // barcode-confirmed, so stamp it for exact-match ranking.
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
  cred: MasoutisCred,
): Promise<RetailerSearchResult[]> => {
  const body: unknown = await postJson(
    fetchImpl,
    SEARCH_URL,
    {
      PassKey: PASS_KEY,
      Itemcode: term,
      ItemDescr: '0',
      IfWeight: '1',
      ServiceResponse: '',
      Token: '',
      Zip: '',
      BrandName: '',
      TeamId: '',
      ExtraFilter: '',
    },
    cred,
    SEARCH_URL,
  );

  return mapSearchResponse(body, SEARCH_URL);
};

const getCred = async (fetchImpl: typeof fetch, context: string): Promise<MasoutisCred> => {
  const response = await fetchImpl(CRED_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });

  if (false === response.ok) {
    throw new AdapterError('masoutis', context, `GetCred HTTP ${response.status}`);
  }

  const body: unknown = await response.json();

  if (
    false === isObject(body) ||
    'string' !== typeof body['Uid'] ||
    'string' !== typeof body['Usl'] ||
    'string' !== typeof body['Key']
  ) {
    throw new AdapterError('masoutis', context, 'GetCred returned an unexpected shape');
  }

  return { uid: body['Uid'], usl: body['Usl'], key: body['Key'] };
};

const postJson = async (
  fetchImpl: typeof fetch,
  url: string,
  payload: unknown,
  cred: MasoutisCred,
  context: string,
): Promise<unknown> => {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Uid: cred.uid,
      Usl: cred.usl,
      Key: cred.key,
    },
    body: JSON.stringify(payload),
  });

  if (false === response.ok) {
    throw new AdapterError('masoutis', context, `HTTP ${response.status} — anonymous creds may have expired or the PassKey rotated`);
  }

  return response.json();
};

interface JsonObject {
  [key: string]: unknown;
}

const isObject = (value: unknown): value is JsonObject => {
  return 'object' === typeof value && null !== value && false === Array.isArray(value);
};

const mapItem = (item: JsonObject, url: string): ScrapedListing => {
  const unitInfo = parseItemVolume(item['ItemVolume']);
  const name = item['ItemDescr'];
  const posPrice = item['PosPrice'];

  return {
    name: 'string' === typeof name ? name.trim() : null,
    sku: 'string' === typeof item['Itemcode'] ? item['Itemcode'] : skuFromUrl(url),
    pricePiece: 'number' === typeof posPrice ? posPrice : null,
    priceUnit: unitInfo.priceUnit,
    unitLabel: unitInfo.unitLabel,
  };
};

const skuFromUrl = (url: string): string | null => {
  const match = url.match(SKU_FROM_URL_PATTERN);

  return match?.[1] ?? null;
};

export const mapSearchResponse = (body: unknown, url: string): RetailerSearchResult[] => {
  if (false === Array.isArray(body)) {
    throw new AdapterError('masoutis', url, 'unexpected response shape: expected an array of items');
  }

  const results: RetailerSearchResult[] = [];

  for (const item of body) {
    if (false === isObject(item)) {
      continue;
    }

    const sku = item['Itemcode'];
    const name = item['ItemDescr'];

    if ('string' !== typeof sku || 0 === sku.length || 'string' !== typeof name) {
      continue;
    }

    const link = item['ItemDescrLink'];
    const brand = item['BrandNameDesciption'];
    const posPrice = item['PosPrice'];
    const unitInfo = parseItemVolume(item['ItemVolume']);

    results.push({
      retailer: 'masoutis',
      sku,
      title: name.trim(),
      url: toAbsoluteUrl(link, sku),
      brand: 'string' === typeof brand && 0 < brand.length ? brand : null,
      ean: null,
      pricePiece: 'number' === typeof posPrice ? posPrice : null,
      priceUnit: unitInfo.priceUnit,
      unitLabel: unitInfo.unitLabel,
    });
  }

  return results;
};

/** Search rows carry absolute links; the detail endpoint returns a bare slug. */
const toAbsoluteUrl = (link: unknown, sku: string): string => {
  if ('string' !== typeof link || 0 === link.length) {
    return `${BASE_URL}/categories/item/?${sku}=`;
  }

  if (link.startsWith('http')) {
    return link;
  }

  return `${BASE_URL}/categories/item/${link}${link.includes('?') ? '' : `?${sku}`}=`;
};

const parseItemVolume = (
  raw: unknown,
): Pick<ScrapedListing, 'priceUnit' | 'unitLabel'> => {
  if ('string' !== typeof raw) {
    return { priceUnit: null, unitLabel: null };
  }

  const match = raw.match(UNIT_LABEL_PATTERN);

  if (null === match || undefined === match[1] || undefined === match[2]) {
    return { priceUnit: null, unitLabel: null };
  }

  return {
    priceUnit: toGreekFloat(match[1]),
    unitLabel: toUnitLabel(match[2]),
  };
};

/** Masoutis abbreviates ("κιλ", "λιτ"); align with the Sklavenitis labels. */
const toUnitLabel = (raw: string): string => {
  if (raw.startsWith('κιλ')) {
    return 'κιλό';
  }

  if (raw.startsWith('λιτ')) {
    return 'λίτρο';
  }

  return raw;
};

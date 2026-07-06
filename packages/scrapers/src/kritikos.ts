import type { RetailerSearchResult, ScrapedListing } from '@grocery/core/types';
import { AdapterError, type RetailerAdapter } from './types';

const BASE_URL = 'https://kritikos-sm.gr';
const CATALOG_URL =
  'https://kritikos-cxm-production.herokuapp.com/api/v2/products?collection_eq=static-web';
const NEXT_DATA_PATTERN =
  /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) personal-price-watch/1.0';
const MAX_SEARCH_RESULTS = 100;

/**
 * kritikos-sm.gr is Next.js SSG: product pages embed the full product
 * object (prices in integer euro-cents) in __NEXT_DATA__, so the daily
 * scrape is one plain GET. There is NO server-side search — the site
 * ships the whole ~29 MB catalog (8.5k products) and filters in the
 * browser against pre-transliterated greeklish `searchTerms`. Search
 * here replicates that: stream the catalog, brace-scan out one product
 * at a time (bounded memory), and keep those whose searchTerms contain
 * every transliterated query token. Heavy (~5 MB compressed, tens of
 * seconds) but it is the only discovery path the platform offers.
 *
 * Weighed items (isWeighed) price the kilo, not a piece: finalPrice IS
 * the €/kg figure and unitOfMeasurementFinalPrice is 0.
 */
export const kritikosAdapter: RetailerAdapter = {
  id: 'kritikos',

  async scrapeProduct(url, fetchImpl) {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });

    if (false === response.ok) {
      throw new AdapterError('kritikos', url, `HTTP ${response.status}`);
    }

    const html = await response.text();
    const match = html.match(NEXT_DATA_PATTERN);

    if (null === match || undefined === match[1]) {
      throw new AdapterError('kritikos', url, 'page did not contain __NEXT_DATA__');
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(match[1]);
    } catch {
      throw new AdapterError('kritikos', url, '__NEXT_DATA__ is not valid JSON');
    }

    const props = isObject(parsed) ? parsed['props'] : undefined;
    const pageProps = isObject(props) ? props['pageProps'] : undefined;
    const product = isObject(pageProps) ? pageProps['productSelected'] : undefined;

    if (false === isObject(product)) {
      throw new AdapterError('kritikos', url, '__NEXT_DATA__ has no productSelected');
    }

    const prices = mapPrices(product);

    return {
      name: cleanName(product['name']),
      sku: 'string' === typeof product['sku'] ? product['sku'] : null,
      ...prices,
      imageUrl: extractImageUrl(product['images']),
    };
  },

  async searchProducts(query, fetchImpl, hints) {
    // Punctuation-only tokens ("&" in "Φιστικοβούτυρο & Σοκολάτα") can
    // never appear in searchTerms and would zero out every match.
    const tokens = transliterate(query)
      .split(/\s+/)
      .filter((token) => /[a-z0-9]/.test(token));
    const ean = undefined !== hints?.ean && 0 < hints.ean.length ? hints.ean : null;

    if (0 === tokens.length && null === ean) {
      return [];
    }

    const response = await fetchImpl(CATALOG_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        appId: 'kritikos-web',
      },
    });

    if (false === response.ok) {
      throw new AdapterError('kritikos', CATALOG_URL, `HTTP ${response.status}`);
    }

    // Every catalog entry carries its barcodes, so an EAN hit is exact —
    // it ranks ahead of the text matches and the scan only stops early
    // once it has been found (or the text cap is full and no EAN is due).
    const exactMatches: RetailerSearchResult[] = [];
    const textMatches: RetailerSearchResult[] = [];

    const wantMore = (): boolean => {
      const textFull = textMatches.length >= MAX_SEARCH_RESULTS;
      const eanPending = null !== ean && 0 === exactMatches.length;

      return false === textFull || eanPending;
    };

    const onProduct = (raw: string): boolean => {
      // Cheap substring pre-filter before paying for JSON.parse.
      const lowered = raw.toLowerCase();
      const mayMatchText =
        0 < tokens.length && tokens.every((token) => lowered.includes(token));
      const mayMatchEan = null !== ean && lowered.includes(ean);

      if (false === mayMatchText && false === mayMatchEan) {
        return wantMore();
      }

      let product: unknown;

      try {
        product = JSON.parse(raw);
      } catch {
        return wantMore();
      }

      if (false === isObject(product)) {
        return wantMore();
      }

      if (true === mayMatchEan && null !== ean && hasBarcode(product, ean)) {
        const mapped = mapSearchResult(product, ean);

        if (null !== mapped) {
          exactMatches.push(mapped);
        }
      } else if (
        true === mayMatchText &&
        textMatches.length < MAX_SEARCH_RESULTS &&
        matchesSearchTerms(product, tokens)
      ) {
        const mapped = mapSearchResult(product, null);

        if (null !== mapped) {
          textMatches.push(mapped);
        }
      }

      return wantMore();
    };

    if (null !== response.body) {
      await scanStream(response.body, onProduct);
    } else {
      scanText(await response.text(), createProductScanner(onProduct));
    }

    const seenSkus = new Set(exactMatches.map((result) => result.sku));

    return [
      ...exactMatches,
      ...textMatches.filter((result) => false === seenSkus.has(result.sku)),
    ];
  },
};

const hasBarcode = (product: JsonObject, ean: string): boolean => {
  const barcodes = product['barcodes'];

  return Array.isArray(barcodes) && barcodes.includes(ean);
};

interface JsonObject {
  [key: string]: unknown;
}

const isObject = (value: unknown): value is JsonObject => {
  return 'object' === typeof value && null !== value && false === Array.isArray(value);
};

/** Raw names carry column-padding runs of spaces. */
const cleanName = (raw: unknown): string | null => {
  if ('string' !== typeof raw) {
    return null;
  }

  return raw.replace(/\s+/g, ' ').trim();
};

const mapPrices = (
  product: JsonObject,
): Pick<ScrapedListing, 'pricePiece' | 'priceUnit' | 'unitLabel'> => {
  const finalPrice = centsToEuros(product['finalPrice']);
  const unitPrice = centsToEuros(product['unitOfMeasurementFinalPrice']);
  const unitLabel = toUnitLabel(product['unitOfMeasurement']);

  if (true === product['isWeighed']) {
    return { pricePiece: null, priceUnit: finalPrice, unitLabel: unitLabel ?? 'κιλό' };
  }

  return {
    pricePiece: finalPrice,
    priceUnit: null !== unitPrice && 0 < unitPrice ? unitPrice : null,
    unitLabel,
  };
};

const centsToEuros = (raw: unknown): number | null => {
  if ('number' !== typeof raw) {
    return null;
  }

  return Math.round(raw) / 100;
};

const UNIT_LABELS = new Map<string, string>([
  ['ΚΙΛ', 'κιλό'],
  ['ΛΙΤ', 'λίτρο'],
  ['ΤΕΜ', 'τεμ.'],
]);

const toUnitLabel = (raw: unknown): string | null => {
  if ('string' !== typeof raw || 0 === raw.length) {
    return null;
  }

  return UNIT_LABELS.get(raw) ?? raw.toLowerCase();
};

const matchesSearchTerms = (product: JsonObject, tokens: readonly string[]): boolean => {
  const searchTerms = isObject(product['searchTerms']) ? product['searchTerms'] : {};

  const haystack = [
    searchTerms['name'],
    searchTerms['brand'],
    searchTerms['type'],
    searchTerms['categoryKind'],
    searchTerms['categories'],
    searchTerms['reduced'],
    searchTerms['sku'],
  ]
    .filter((value): value is string => 'string' === typeof value)
    .join(' ')
    .toLowerCase();

  return tokens.every((token) => haystack.includes(token));
};

const mapSearchResult = (
  product: JsonObject,
  matchedEan: string | null,
): RetailerSearchResult | null => {
  const sku = product['sku'];
  const slug = product['slug'];
  const name = cleanName(product['name']);

  if ('string' !== typeof sku || 'string' !== typeof slug || null === name) {
    return null;
  }

  const prices = mapPrices(product);
  const barcodes = product['barcodes'];
  const firstBarcode =
    Array.isArray(barcodes) && 'string' === typeof barcodes[0] ? barcodes[0] : null;

  return {
    retailer: 'kritikos',
    sku,
    title: name,
    url: `${BASE_URL}/${slug}/`,
    brand: null,
    ean: matchedEan ?? firstBarcode,
    pricePiece: prices.pricePiece,
    priceUnit: prices.priceUnit,
    unitLabel: prices.unitLabel,
    imageUrl: extractImageUrl(product['images']),
  };
};

/**
 * Catalog entries carry images as { primary, baseUrl, alternatives }
 * (verified live 2026-07-05) — the shot lives at baseUrl + primary.
 */
const extractImageUrl = (raw: unknown): string | null => {
  if (false === isObject(raw)) {
    return null;
  }

  const primary = raw['primary'];
  const baseUrl = raw['baseUrl'];

  if ('string' !== typeof primary || 0 === primary.length || 'string' !== typeof baseUrl) {
    return null;
  }

  return `${baseUrl}${primary}`;
};

/**
 * Greek → greeklish, matching the primary variant of the site's own
 * pre-generated searchTerms (η→h, υ→y, ω→w, β→b, χ→x, ξ→ks — derived
 * from live catalog data). Tokens are matched as substrings, so the
 * catalog's extra spelling variants absorb the remaining ambiguity.
 */
const GREEKLISH_MAP = new Map<string, string>([
  ['α', 'a'], ['β', 'b'], ['γ', 'g'], ['δ', 'd'], ['ε', 'e'],
  ['ζ', 'z'], ['η', 'h'], ['θ', 'th'], ['ι', 'i'], ['κ', 'k'],
  ['λ', 'l'], ['μ', 'm'], ['ν', 'n'], ['ξ', 'ks'], ['ο', 'o'],
  ['π', 'p'], ['ρ', 'r'], ['σ', 's'], ['ς', 's'], ['τ', 't'],
  ['υ', 'y'], ['φ', 'f'], ['χ', 'x'], ['ψ', 'ps'], ['ω', 'w'],
]);

export const transliterate = (raw: string): string => {
  const deaccented = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

  let output = '';

  for (const char of deaccented) {
    output += GREEKLISH_MAP.get(char) ?? char;
  }

  return output;
};

/**
 * Incrementally extracts the product objects out of the catalog JSON
 * ({"payload":{"products":[{...},{...},...]}}) without ever holding the
 * whole body: a product is any object opening at container depth 3
 * whose enclosing containers are object→object→array. The callback
 * returns false to stop early.
 */
export const createProductScanner = (onProduct: (raw: string) => boolean) => {
  const stack: string[] = [];
  let buffer = '';
  let scanned = 0;
  let productStart = -1;
  let inString = false;
  let escaped = false;
  let done = false;

  const isProductDepth = (): boolean => {
    return 3 === stack.length && '{' === stack[0] && '{' === stack[1] && '[' === stack[2];
  };

  return {
    push(chunk: string): boolean {
      if (true === done) {
        return false;
      }

      buffer += chunk;

      for (; scanned < buffer.length; scanned += 1) {
        const char = buffer[scanned];

        if (true === inString) {
          if (true === escaped) {
            escaped = false;
          } else if ('\\' === char) {
            escaped = true;
          } else if ('"' === char) {
            inString = false;
          }

          continue;
        }

        if ('"' === char) {
          inString = true;
        } else if ('{' === char || '[' === char) {
          if ('{' === char && -1 === productStart && isProductDepth()) {
            productStart = scanned;
          }

          stack.push(char);
        } else if ('}' === char || ']' === char) {
          stack.pop();

          if (-1 !== productStart && isProductDepth()) {
            const raw = buffer.slice(productStart, scanned + 1);
            productStart = -1;

            if (false === onProduct(raw)) {
              done = true;
              return false;
            }
          }
        }
      }

      // Drop consumed text; keep any partially-scanned product.
      const keepFrom = -1 === productStart ? scanned : productStart;
      buffer = buffer.slice(keepFrom);
      scanned -= keepFrom;

      if (-1 !== productStart) {
        productStart = 0;
      }

      return true;
    },
  };
};

type ProductScanner = ReturnType<typeof createProductScanner>;

const scanStream = async (
  body: ReadableStream<Uint8Array>,
  onProduct: (raw: string) => boolean,
): Promise<void> => {
  const scanner = createProductScanner(onProduct);
  const reader = body.getReader();
  const decoder = new TextDecoder();

  for (;;) {
    const { done, value } = await reader.read();

    if (true === done) {
      break;
    }

    if (false === scanner.push(decoder.decode(value, { stream: true }))) {
      await reader.cancel();
      break;
    }
  }
};

const scanText = (text: string, scanner: ProductScanner): void => {
  scanner.push(text);
};

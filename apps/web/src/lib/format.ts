import type {
  ListingWithLatestPrice,
  ProductWithListings,
  RetailerId,
} from '@grocery/core/types';

export type View = 'home' | 'results' | 'product' | 'stores' | 'add';

export type ResultSort = 'price' | 'saving' | 'name';

/** Two-letter marks for the retailer avatar squares. */
export const RETAILER_MARKS = new Map<RetailerId, string>([
  ['sklavenitis', 'SK'],
  ['ab', 'AB'],
  ['lidl', 'LI'],
  ['masoutis', 'MA'],
  ['mymarket', 'MM'],
  ['kritikos', 'KR'],
  ['galaxias', 'GA'],
]);

/**
 * Greek convention: comma decimal, thousands dot, trailing euro sign —
 * "7,49 €", "1.234,50 €". Intl also normalizes -0 → "0,00 €".
 */
const EURO_FORMAT = new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR' });

export const formatEuro = (value: number): string => {
  // `|| 0` folds -0 and NaN to a clean 0 so they never render as "-0,00 €".
  return EURO_FORMAT.format(value || 0);
};

export const priceOf = (listing: ListingWithLatestPrice): number | null => {
  if (null === listing.latestPrice) {
    return null;
  }

  return listing.latestPrice.pricePiece;
};

/** "3,20 €/κιλό" for a listing that carries a per-unit price, else null. */
export const unitPriceLabel = (listing: ListingWithLatestPrice): string | null => {
  const latest = listing.latestPrice;

  if (null === latest || null === latest.priceUnit) {
    return null;
  }

  const suffix = null !== latest.unitLabel && 0 < latest.unitLabel.length ? `/${latest.unitLabel}` : '';

  return `${formatEuro(latest.priceUnit)}${suffix}`;
};

/**
 * A price scraped more than this many days ago is shown as stale. The daily
 * scrape keeps healthy prices 0–1 days old; WAF-blocked chains seeded once at
 * save and never re-scraped drift far past this — and must not read as "live".
 */
export const STALE_AFTER_DAYS = 2;

export interface PriceFreshness {
  /** Scrape date (YYYY-MM-DD) of the shown price, or null when there's none. */
  date: string | null;
  /** Whole days since that scrape (Athens calendar), or null. */
  ageDays: number | null;
  isStale: boolean;
}

const athensToday = (): string =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Athens' });

const daysBetween = (fromIso: string, toIso: string): number | null => {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);

  if (Number.isNaN(from) || Number.isNaN(to)) {
    return null;
  }

  return Math.round((to - from) / 86_400_000);
};

/** How old the listing's latest price is, and whether that makes it stale. */
export const priceFreshness = (listing: ListingWithLatestPrice): PriceFreshness => {
  const date = listing.latestPrice?.scrapedDate ?? null;

  if (null === date) {
    return { date: null, ageDays: null, isStale: false };
  }

  const ageDays = daysBetween(date, athensToday());

  return { date, ageDays, isStale: null !== ageDays && ageDays > STALE_AFTER_DAYS };
};

/** "σήμερα" / "χθες" / "πριν N ημέρες" for a scrape date, or null. */
export const freshnessLabel = (freshness: PriceFreshness): string | null => {
  if (null === freshness.date || null === freshness.ageDays) {
    return null;
  }

  if (0 >= freshness.ageDays) {
    return 'σήμερα';
  }

  if (1 === freshness.ageDays) {
    return 'χθες';
  }

  return `πριν ${freshness.ageDays} ημέρες`;
};

/** Cheapest listing that currently has a piece price, or null. */
export const bestListing = (
  listings: readonly ListingWithLatestPrice[],
): ListingWithLatestPrice | null => {
  let best: ListingWithLatestPrice | null = null;
  let bestPrice = Number.POSITIVE_INFINITY;

  for (const listing of listings) {
    const price = priceOf(listing);

    if (null === price) {
      continue;
    }

    if (price < bestPrice) {
      best = listing;
      bestPrice = price;
    }
  }

  return best;
};

export interface PriceRange {
  min: number;
  max: number;
}

export const priceRange = (
  listings: readonly ListingWithLatestPrice[],
): PriceRange | null => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const listing of listings) {
    const price = priceOf(listing);

    if (null === price) {
      continue;
    }

    if (price < min) {
      min = price;
    }

    if (price > max) {
      max = price;
    }
  }

  if (Number.POSITIVE_INFINITY === min) {
    return null;
  }

  return { min, max };
};

/** Initials for a product avatar — brand first, title as fallback. */
export const productMark = (product: { brand: string; title: string }): string => {
  const source = 0 < product.brand.trim().length ? product.brand : product.title;
  const words = source
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => 0 < word.length);

  const [first, second] = words;

  if (undefined === first) {
    return '??';
  }

  if (undefined !== second) {
    return `${first[0] ?? ''}${second[0] ?? ''}`.toUpperCase();
  }

  return (first.slice(0, 2) || '??').toUpperCase();
};

export const sizeLabel = (product: {
  sizeValue: number | null;
  sizeUnit: string | null;
}): string | null => {
  if (null === product.sizeValue) {
    return null;
  }

  return `${product.sizeValue}${product.sizeUnit ?? ''}`;
};

/** Substring match over "brand title" — the Home/Results text filter. */
export const matchesQuery = (product: ProductWithListings, query: string): boolean => {
  const needle = query.trim().toLowerCase();

  if (0 === needle.length) {
    return true;
  }

  return `${product.brand} ${product.title}`.toLowerCase().includes(needle);
};

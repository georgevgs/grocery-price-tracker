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

/** Greek convention: comma decimal, trailing euro sign — "7,49 €". */
export const formatEuro = (value: number): string => {
  return `${value.toFixed(2).replace('.', ',')} €`;
};

export const priceOf = (listing: ListingWithLatestPrice): number | null => {
  if (null === listing.latestPrice) {
    return null;
  }

  return listing.latestPrice.pricePiece;
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

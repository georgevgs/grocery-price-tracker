export interface ExtractedSize {
  /** Total content of the pack (count × per-piece for multipacks). */
  value: number;
  unit: 'g' | 'ml' | 'piece';
  /** Pieces in the pack — 1 unless the title uses NxM syntax ("5x42g"). */
  count: number;
}

// \b is ASCII-only, so Greek units ("γρ", "τεμ") need an explicit
// not-a-letter-or-digit lookahead instead.
const SIZE_PATTERN = /(\d+(?:[.,]\d+)?)\s?(kg|gr|g|lt|ml|l|τεμ|γρ)(?![\p{L}\p{N}])/u;

// Multipacks: "5x42g", "4*250ML", "3 χ 100γρ" (retailers use Latin x,
// Greek χ, ×, or *). Must be tried before SIZE_PATTERN, whose first hit
// would otherwise read the per-piece size as the pack size.
const MULTIPACK_PATTERN =
  /(\d+)\s?[x×χ*]\s?(\d+(?:[.,]\d+)?)\s?(kg|gr|g|lt|ml|l|τεμ|γρ)(?![\p{L}\p{N}])/u;

// "3,5%" — fat content and friends. An attribute, not a size.
const PERCENT_PATTERN = /(\d+(?:[.,]\d+)?)\s?%/;

/**
 * Greek letters folded to their Latin uppercase-homoglyph's lowercase.
 * Retailers freely mix scripts for the same brand ("NOYNOY" in a brand
 * field, "ΝΟΥΝΟΥ" in the title); after this fold both spell "noynoy".
 * Letters without a Latin homoglyph (γ δ θ λ ξ π σ φ ψ ω) stay Greek, so
 * genuinely different words keep their distinctness.
 */
const HOMOGLYPH_FOLD = new Map<string, string>([
  ['α', 'a'],
  ['β', 'b'],
  ['ε', 'e'],
  ['ζ', 'z'],
  ['η', 'h'],
  ['ι', 'i'],
  ['κ', 'k'],
  ['μ', 'm'],
  ['ν', 'n'],
  ['ο', 'o'],
  ['ρ', 'p'],
  ['τ', 't'],
  ['υ', 'y'],
  ['χ', 'x'],
  ['ς', 'σ'],
]);

const foldHomoglyphs = (text: string): string => {
  let folded = '';

  for (const char of text) {
    folded += HOMOGLYPH_FOLD.get(char) ?? char;
  }

  return folded;
};

const UNIT_FACTORS = new Map<string, { unit: ExtractedSize['unit']; factor: number }>([
  ['kg', { unit: 'g', factor: 1000 }],
  ['gr', { unit: 'g', factor: 1 }],
  ['γρ', { unit: 'g', factor: 1 }],
  ['g', { unit: 'g', factor: 1 }],
  ['lt', { unit: 'ml', factor: 1000 }],
  ['l', { unit: 'ml', factor: 1000 }],
  ['ml', { unit: 'ml', factor: 1 }],
  ['τεμ', { unit: 'piece', factor: 1 }],
]);

/**
 * Canonical comparison form: lowercase, diacritics stripped, punctuation
 * to spaces, Greek homoglyphs folded to Latin. The output is internal —
 * it feeds tokenize/titleContainsBrand, never the UI.
 */
export const normalizeTitle = (raw: string): string => {
  return foldHomoglyphs(
    raw
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, ''),
  )
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Extra lossy fold for token COMPARISON only (never storage or scoring
 * keys): collapses the Greek iota-sound spellings (η ι υ ει οι) that
 * retailers legitimately disagree on — Φυστικο/Φιστικο — onto one class.
 * Operates on normalizeTitle output, i.e. after the homoglyph fold.
 */
export const foldForComparison = (normalizedToken: string): string => {
  return normalizedToken
    .replace(/ei/g, 'i')
    .replace(/oi/g, 'i')
    .replace(/ai/g, 'e')
    .replace(/[hy]/g, 'i')
    .replace(/ω/g, 'o');
};

export const tokenize = (normalizedTitle: string): Set<string> => {
  const tokens = normalizedTitle.split(' ').filter((token) => 0 < token.length);
  return new Set(tokens);
};

export const extractSize = (title: string): ExtractedSize | null => {
  // Deliberately NOT normalizeTitle(): that strips punctuation and would
  // turn the decimal in '1,5lt' into '1 5lt', matching '5lt' → 5000ml.
  const normalized = title.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

  const multipack = normalized.match(MULTIPACK_PATTERN);

  if (null !== multipack && undefined !== multipack[1]) {
    const count = Number(multipack[1]);
    const perPiece = toSize(multipack[2], multipack[3]);

    if (null !== perPiece && false === Number.isNaN(count) && 0 < count) {
      return { value: perPiece.value * count, unit: perPiece.unit, count };
    }
  }

  const single = normalized.match(SIZE_PATTERN);

  if (null === single) {
    return null;
  }

  const size = toSize(single[1], single[2]);

  if (null === size) {
    return null;
  }

  return { ...size, count: 1 };
};

const toSize = (
  rawValue: string | undefined,
  rawUnit: string | undefined,
): Pick<ExtractedSize, 'value' | 'unit'> | null => {
  if (undefined === rawValue || undefined === rawUnit) {
    return null;
  }

  const factorEntry = UNIT_FACTORS.get(rawUnit);

  if (undefined === factorEntry) {
    return null;
  }

  const numericValue = Number(rawValue.replace(',', '.'));

  if (Number.isNaN(numericValue)) {
    return null;
  }

  return {
    value: numericValue * factorEntry.factor,
    unit: factorEntry.unit,
  };
};

/**
 * "3,5%" → 3.5. Fat content and similar percentages are attributes that
 * distinguish otherwise identical titles (3,5% vs 1,5% milk) — never
 * part of the size and worthless as loose numeric tokens.
 */
export const extractPercent = (title: string): number | null => {
  const match = title.match(PERCENT_PATTERN);

  if (null === match || undefined === match[1]) {
    return null;
  }

  const value = Number(match[1].replace(',', '.'));

  return Number.isNaN(value) ? null : value;
};

/**
 * Accepts what people actually paste into an EAN field: the bare barcode
 * (with stray spaces) or a galaxias.shop product URL, whose SKU segment
 * IS the pack EAN. Returns null when nothing barcode-like is found.
 */
export const extractEanFromInput = (raw: string): string | null => {
  const trimmed = raw.trim();

  if (0 === trimmed.length) {
    return null;
  }

  const urlMatch = trimmed.match(/\/product\/(\d{8,14})(?:[/?#]|$)/);

  if (null !== urlMatch && undefined !== urlMatch[1]) {
    return urlMatch[1];
  }

  const digits = trimmed.replace(/[\s-]/g, '');

  if (/^\d{8,14}$/.test(digits)) {
    return digits;
  }

  return null;
};

/** Folded comparison form with the Greek plural/case ending (-σ) stripped. */
export const stemFold = (normalizedToken: string): string => {
  const folded = foldForComparison(normalizedToken);

  return 3 < folded.length && true === folded.endsWith('σ') ? folded.slice(0, -1) : folded;
};

/**
 * Every brand token must appear as a whole title token (compared through
 * the spelling fold). Substring matching is wrong in both directions:
 * brand "ΒΙΟ" is not present in "Βιολογικό", and token boundaries are
 * what keeps it that way.
 */
export const titleContainsBrand = (title: string, brand: string): boolean => {
  const titleTokens = new Set([...tokenize(normalizeTitle(title))].map(stemFold));
  const brandTokens = tokenize(normalizeTitle(brand));

  for (const token of brandTokens) {
    if (false === titleTokens.has(stemFold(token))) {
      return false;
    }
  }

  return true;
};

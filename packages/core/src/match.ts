import {
  extractPercent,
  extractSize,
  normalizeTitle,
  stemFold,
  titleContainsBrand,
  tokenize,
  type ExtractedSize,
} from './normalize';

export interface MatchCandidate {
  id: number;
  title: string;
  brand: string;
  /** Authoritative pack size when known (products.size_value/size_unit). */
  sizeValue?: number | null;
  sizeUnit?: string | null;
}

export interface MatchOptions {
  /**
   * 'hard' (default): a candidate whose brand is missing from the scraped
   * title is excluded — right when the scraped side is known to carry the
   * brand (an explicit retailer brand field was folded into the title).
   * 'soft': brand presence depends on free retailer title text, which
   * some chains abbreviate beyond recognition — a miss only penalizes,
   * so the right product stays visible for the human, ranked low.
   */
  brandGate?: 'hard' | 'soft';
}

export interface MatchSuggestion {
  candidateId: number;
  score: number;
  sizeMatched: boolean;
  /** Exactly one side declared a size — plausible but unverified. */
  sizeUnverified: boolean;
}

const SIZE_MATCH_BONUS = 0.2;
const SIZE_UNVERIFIED_PENALTY = 0.1;
// Deep enough that a brand-less lookalike can't clear SUGGESTION_THRESHOLD
// on shared tokens alone, shallow enough to stay visible in the ranking.
const BRAND_MISS_PENALTY = 0.5;
const MAX_SCORE = 1;

/** Tokens this short are too noisy for edit-distance-1 equivalence. */
const MIN_FUZZY_TOKEN_LENGTH = 4;

const GENERIC_TOKEN_WEIGHT = 0.4;
const STOPWORD_WEIGHT = 0.05;

// Connective words carry no product identity at all…
const STOPWORDS = buildFoldedSet(['με', 'και', 'σε', 'για', 'από', 'το', 'τα', 'του', 'της']);

// …and category nouns/adjectives appear in half the aisle: two different
// milks share γάλα/φρέσκο/ελληνικό, so those tokens must not be able to
// carry a match on their own.
const GENERIC_TOKENS = buildFoldedSet([
  'γάλα',
  'φρέσκο',
  'φρέσκια',
  'ελληνικό',
  'ελληνική',
  'παραδοσιακό',
  'παραδοσιακή',
  'κλασικό',
  'κλασική',
  'νέο',
  'extra',
  'λιπαρά',
]);

/**
 * Variant attributes: synonym groups per class. Two titles naming
 * DIFFERENT groups of the same class describe different shelf products
 * (full-fat vs light milk, goat vs cow), no matter how similar the rest
 * of the title is. Naming the same group (or only one side naming any)
 * is never a contradiction — titles routinely omit the default variant.
 */
const VARIANT_CLASSES: readonly (readonly ReadonlySet<string>[])[] = [
  // fat level
  [
    buildFoldedSet(['πλήρες', 'πλήρης']),
    buildFoldedSet(['ελαφρύ', 'ελαφρύς', 'light']),
    buildFoldedSet(['άπαχο', 'άπαχη']),
  ],
  // milk source
  [
    buildFoldedSet(['αγελαδινό']),
    buildFoldedSet(['κατσικίσιο', 'γίδινο']),
    buildFoldedSet(['πρόβειο']),
  ],
];

/**
 * Suggest which existing products a scraped title likely refers to.
 *
 * Hard gates (candidate excluded entirely):
 *   - brand tokens must appear in the scraped title (unless brandGate is
 *     'soft', where a miss becomes a heavy penalty)
 *   - declared sizes must agree on unit, total content AND pack count
 *   - percentages (fat) declared on both sides must be equal
 *   - variant attributes (full-fat/light, goat/cow) must not contradict
 *
 * Remaining candidates rank by weighted fuzzy token-set Jaccard: tokens
 * compare through the spelling fold plus edit distance 1, bare numbers
 * are excluded, stopwords and category words are down-weighted. This is
 * a suggestion engine — the user confirms the mapping; scores never
 * auto-link products.
 */
export const suggestMatches = (
  scrapedTitle: string,
  candidates: readonly MatchCandidate[],
  options?: MatchOptions,
): MatchSuggestion[] => {
  const brandGate = options?.brandGate ?? 'hard';
  const scrapedTokens = weighTokens(tokenize(normalizeTitle(scrapedTitle)));
  const scrapedSize = extractSize(scrapedTitle);
  const scrapedPercent = extractPercent(scrapedTitle);

  const suggestions = candidates
    .map((candidate) =>
      scoreCandidate(candidate, scrapedTitle, scrapedTokens, scrapedSize, scrapedPercent, brandGate),
    )
    .filter((suggestion): suggestion is MatchSuggestion => null !== suggestion);

  return suggestions.sort((a, b) => b.score - a.score);
};

interface WeightedToken {
  token: string;
  folded: string;
  weight: number;
}

const scoreCandidate = (
  candidate: MatchCandidate,
  scrapedTitle: string,
  scrapedTokens: readonly WeightedToken[],
  scrapedSize: ExtractedSize | null,
  scrapedPercent: number | null,
  brandGate: 'hard' | 'soft',
): MatchSuggestion | null => {
  let brandMissed = false;

  if (false === titleContainsBrand(scrapedTitle, candidate.brand)) {
    if ('hard' === brandGate) {
      return null;
    }

    brandMissed = true;
  }

  const candidatePercent = extractPercent(candidate.title);

  if (null !== scrapedPercent && null !== candidatePercent && scrapedPercent !== candidatePercent) {
    return null;
  }

  const candidateSize = resolveCandidateSize(candidate);
  let sizeMatched = false;
  let sizeUnverified = false;

  if (null !== scrapedSize && null !== candidateSize) {
    const sameUnit = scrapedSize.unit === candidateSize.unit;
    const sameValue = scrapedSize.value === candidateSize.value;
    // A 2x500g multipack is a different shelf product from a 1kg single
    // even though the total content matches.
    const sameCount = scrapedSize.count === candidateSize.count;

    if (false === sameUnit || false === sameValue || false === sameCount) {
      return null;
    }

    sizeMatched = true;
  } else if (null !== scrapedSize || null !== candidateSize) {
    sizeUnverified = true;
  }

  const candidateTokens = weighTokens(tokenize(normalizeTitle(candidate.title)));

  if (true === variantsContradict(scrapedTokens, candidateTokens)) {
    return null;
  }

  let score = weightedFuzzyJaccard(scrapedTokens, candidateTokens);

  if (true === sizeMatched) {
    score = Math.min(score + SIZE_MATCH_BONUS, MAX_SCORE);
  }

  if (true === sizeUnverified) {
    score = Math.max(score - SIZE_UNVERIFIED_PENALTY, 0);
  }

  if (true === brandMissed) {
    score = Math.max(score - BRAND_MISS_PENALTY, 0);
  }

  return {
    candidateId: candidate.id,
    score,
    sizeMatched,
    sizeUnverified,
  };
};

/**
 * The stored size (parsed once at creation) is authoritative when the
 * title text carries none — but a parseable title wins because it also
 * knows the pack count, which the DB does not store.
 */
const resolveCandidateSize = (candidate: MatchCandidate): ExtractedSize | null => {
  const fromTitle = extractSize(candidate.title);

  if (null !== fromTitle) {
    return fromTitle;
  }

  if (
    null !== candidate.sizeValue &&
    undefined !== candidate.sizeValue &&
    ('g' === candidate.sizeUnit || 'ml' === candidate.sizeUnit || 'piece' === candidate.sizeUnit)
  ) {
    return { value: candidate.sizeValue, unit: candidate.sizeUnit, count: 1 };
  }

  return null;
};

const weighTokens = (tokens: ReadonlySet<string>): WeightedToken[] => {
  const weighted: WeightedToken[] = [];

  for (const token of tokens) {
    // Bare numbers are attribute debris ("3,5%" tokenizes to 3 and 5) —
    // percentages and sizes are gated explicitly, so loose digits only
    // fake similarity.
    if (/^\d+$/.test(token)) {
      continue;
    }

    const folded = stemFold(token);
    let weight = 1;

    if (true === STOPWORDS.has(folded)) {
      weight = STOPWORD_WEIGHT;
    } else if (true === GENERIC_TOKENS.has(folded)) {
      weight = GENERIC_TOKEN_WEIGHT;
    }

    weighted.push({ token, folded, weight });
  }

  return weighted;
};

const variantsContradict = (
  a: readonly WeightedToken[],
  b: readonly WeightedToken[],
): boolean => {
  for (const variantClass of VARIANT_CLASSES) {
    const groupOfA = variantGroup(variantClass, a);
    const groupOfB = variantGroup(variantClass, b);

    if (-1 !== groupOfA && -1 !== groupOfB && groupOfA !== groupOfB) {
      return true;
    }
  }

  return false;
};

const variantGroup = (
  variantClass: readonly ReadonlySet<string>[],
  tokens: readonly WeightedToken[],
): number => {
  for (const { folded } of tokens) {
    for (let group = 0; group < variantClass.length; group += 1) {
      if (true === (variantClass[group]?.has(folded) ?? false)) {
        return group;
      }
    }
  }

  return -1;
};

const weightedFuzzyJaccard = (
  a: readonly WeightedToken[],
  b: readonly WeightedToken[],
): number => {
  if (0 === a.length && 0 === b.length) {
    return 0;
  }

  const matchedB = new Set<number>();
  let intersectionWeight = 0;

  for (const tokenA of a) {
    for (let i = 0; i < b.length; i += 1) {
      const tokenB = b[i];

      if (undefined === tokenB || true === matchedB.has(i)) {
        continue;
      }

      if (true === tokensEquivalent(tokenA, tokenB)) {
        matchedB.add(i);
        intersectionWeight += (tokenA.weight + tokenB.weight) / 2;
        break;
      }
    }
  }

  const totalWeight = (tokens: readonly WeightedToken[]): number => {
    return tokens.reduce((sum, entry) => sum + entry.weight, 0);
  };

  const unionWeight = totalWeight(a) + totalWeight(b) - intersectionWeight;

  return 0 === unionWeight ? 0 : intersectionWeight / unionWeight;
};

const tokensEquivalent = (a: WeightedToken, b: WeightedToken): boolean => {
  if (a.token === b.token || a.folded === b.folded) {
    return true;
  }

  // Digits demand exactness: "350g" and "450g" are one edit apart and
  // entirely different products.
  if (/\d/.test(a.token) || /\d/.test(b.token)) {
    return false;
  }

  if (a.folded.length < MIN_FUZZY_TOKEN_LENGTH || b.folded.length < MIN_FUZZY_TOKEN_LENGTH) {
    return false;
  }

  return withinEditDistanceOne(a.folded, b.folded);
};

/** Damerau-Levenshtein ≤ 1: one substitution, adjacent swap, or indel. */
const withinEditDistanceOne = (a: string, b: string): boolean => {
  if (a === b) {
    return true;
  }

  const gap = a.length - b.length;

  if (1 < Math.abs(gap)) {
    return false;
  }

  if (0 === gap) {
    let i = 0;

    while (i < a.length && a[i] === b[i]) {
      i += 1;
    }

    if (a.slice(i + 1) === b.slice(i + 1)) {
      return true;
    }

    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }

  const longer = 0 < gap ? a : b;
  const shorter = 0 < gap ? b : a;
  let i = 0;

  while (i < shorter.length && longer[i] === shorter[i]) {
    i += 1;
  }

  return longer.slice(i + 1) === shorter.slice(i);
};

function buildFoldedSet(words: readonly string[]): ReadonlySet<string> {
  return new Set(words.map((word) => stemFold(normalizeTitle(word))));
}

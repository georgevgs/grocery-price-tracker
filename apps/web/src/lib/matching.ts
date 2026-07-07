import type { RetailerId, RetailerSearchResult } from '@grocery/core/types';
import { suggestMatches } from '@grocery/core/match';
import { searchRetailers, type RetailerSearchResponse } from '../api/client';

export interface RankedResult {
  result: RetailerSearchResult;
  score: number | null;
  /** Only one side declared a pack size — plausible match, unverified. */
  sizeUnverified: boolean;
}

export const RETAILER_LABELS = new Map<RetailerId, string>([
  ['sklavenitis', 'Sklavenitis'],
  ['ab', 'AB Vassilopoulos'],
  ['lidl', 'Lidl (μόνο προσφορές)'],
  ['masoutis', 'Masoutis'],
  ['mymarket', 'My Market'],
  ['kritikos', 'Kritikos'],
  ['galaxias', 'Galaxias'],
]);

// Re-derived from the golden set (tests/golden.ts) after the Phase 2+3
// matcher work: true pairs score ≥ 0.8, the worst surviving lookalike
// 0.30 — 0.45 sits mid-gap. Re-measure before touching.
export const SUGGESTION_THRESHOLD = 0.45;

/** A match this strong that carries a barcode is trusted as the product's identity. */
export const EAN_DISCOVERY_THRESHOLD = 0.6;

/** Chains whose backends resolve barcodes (see SearchHints in @grocery/scrapers). */
const EAN_CAPABLE_RETAILERS: ReadonlySet<RetailerId> = new Set<RetailerId>([
  'galaxias',
  'kritikos',
  'lidl',
  'masoutis',
  'mymarket',
]);

/**
 * Barcode-resolving chains that are also FAST and return a usable product
 * name — used to identify a scanned product before any title is known.
 * Kritikos is deliberately excluded (its search streams the whole ~29 MB
 * catalogue); the full search that follows a prefill already covers it.
 * Galaxias resolves sku=EAN exactly; My Market and Masoutis resolve the
 * EAN as search text and also carry the brand.
 */
const IDENTITY_CHAINS: readonly RetailerId[] = ['galaxias', 'mymarket', 'masoutis'];

/**
 * Score each search result against the product being linked.
 *
 * A barcode match is identity, not similarity: when the product's EAN
 * equals the result's, the result scores 1 outright — retailers love to
 * abbreviate titles beyond what token matching can survive
 * ("H.Η.ΓΚΡΑΝΟΛΑ ΦΥΣΤΙΚ/ΤΥΡΟ ΜΑΥΡ.ΣΟΚ.").
 *
 * Otherwise suggestMatches gates on brand and size, so mismatched
 * results (wrong brand, 400g vs 350g) rank as unmatched rather than
 * close. Some retailers carry the brand in a separate field rather than
 * in the title, so fold a known result brand into the compared title
 * (and the user's brand into the target) to keep the brand gate and
 * Jaccard symmetric.
 */
export const rankResults = (
  results: readonly RetailerSearchResult[],
  title: string,
  brand: string,
  ean?: string | null,
): RankedResult[] => {
  const target = [{ id: 0, title: `${brand} ${title}`.trim(), brand }];

  const ranked = results.map((result): RankedResult => {
    if (null != ean && 0 < ean.length && result.ean === ean) {
      return { result, score: 1, sizeUnverified: false };
    }

    const comparedTitle =
      null !== result.brand ? `${result.brand} ${result.title}` : result.title;
    // With an explicit retailer brand field folded in, a missing brand is
    // a real mismatch (hard gate). Brand-in-title-only chains abbreviate,
    // so there a miss only penalizes (soft).
    const [suggestion] = suggestMatches(comparedTitle, target, {
      brandGate: null !== result.brand ? 'hard' : 'soft',
    });

    return {
      result,
      score: undefined === suggestion ? null : suggestion.score,
      sizeUnverified: suggestion?.sizeUnverified ?? false,
    };
  });

  return ranked.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
};

export const collectSelectedListings = (
  candidates: Map<RetailerId, RankedResult[]> | null,
  selectedSkus: Map<RetailerId, string | null>,
) => {
  if (null === candidates) {
    return [];
  }

  const listings = [];

  for (const [retailer, ranked] of candidates) {
    const sku = selectedSkus.get(retailer);

    if (null === sku || undefined === sku) {
      continue;
    }

    const picked = ranked.find((entry) => sku === entry.result.sku);

    if (undefined === picked) {
      continue;
    }

    listings.push({
      retailer,
      retailerSku: picked.result.sku,
      url: picked.result.url,
    });
  }

  return listings;
};

/**
 * A single product shot for the saved product, taken from the best-scored
 * confirmed pick that carries one (AB, Galaxias and Kritikos surface it in
 * search; the others backfill from the post-save scrape). The strongest
 * match is the safest image, so ties break on score.
 */
export const collectProductImage = (
  candidates: Map<RetailerId, RankedResult[]> | null,
  selectedSkus: Map<RetailerId, string | null>,
): string | null => {
  if (null === candidates) {
    return null;
  }

  let best: { imageUrl: string; score: number } | null = null;

  for (const [retailer, ranked] of candidates) {
    const sku = selectedSkus.get(retailer);

    if (null === sku || undefined === sku) {
      continue;
    }

    const picked = ranked.find((entry) => sku === entry.result.sku);
    const imageUrl = picked?.result.imageUrl;

    if (undefined === imageUrl || null === imageUrl || 0 === imageUrl.length) {
      continue;
    }

    const score = picked?.score ?? -1;

    if (null === best || score > best.score) {
      best = { imageUrl, score };
    }
  }

  return null === best ? null : best.imageUrl;
};

/**
 * The barcode carried by the user's confirmed picks — but only when all
 * picks that expose one agree, so a mis-selected candidate can't stamp a
 * wrong identity on the product.
 */
export const collectConfirmedEan = (
  candidates: Map<RetailerId, RankedResult[]> | null,
  selectedSkus: Map<RetailerId, string | null>,
): string | null => {
  if (null === candidates) {
    return null;
  }

  const eans = new Set<string>();

  for (const [retailer, ranked] of candidates) {
    const sku = selectedSkus.get(retailer);

    if (null === sku || undefined === sku) {
      continue;
    }

    const picked = ranked.find((entry) => sku === entry.result.sku);

    if (undefined !== picked && null !== picked.result.ean) {
      eans.add(picked.result.ean);
    }
  }

  if (1 !== eans.size) {
    return null;
  }

  return [...eans][0] ?? null;
};

export interface OrchestratedSearch {
  ranked: Map<RetailerId, RankedResult[]>;
  errors: string[];
  discoveredEan: string | null;
}

/**
 * The progressively looser query shapes searchAndRank walks through (see
 * its doc comment). Emitted as progress so the UI can narrate the current
 * pass — language-neutral on purpose: the view layer owns the Greek copy,
 * no user-facing string leaks into the matcher.
 */
export type SearchPass = 'full' | 'brand-stripped' | 'stripped' | 'brand' | 'ean';

/**
 * Live telemetry for a "what am I doing right now" search board. A `pass`
 * marks a new query shape starting against a set of chains; a `chain` fires
 * as each chain's request resolves (with its raw result count — ranking is
 * downstream); an `ean` surfaces a barcode discovered mid-search.
 */
export type SearchProgress =
  | { kind: 'pass'; pass: SearchPass; retailers: readonly RetailerId[] }
  | { kind: 'chain'; retailer: RetailerId; count: number }
  | { kind: 'ean'; ean: string };

export type SearchProgressListener = (event: SearchProgress) => void;

type SearchFn = (
  query: string,
  retailers?: readonly RetailerId[],
  ean?: string | null,
  // Fires per chain as its request settles, so the caller can paint live
  // per-chain progress during a fan-out. Optional: test stubs and the
  // scan-to-prefill path (resolveIdentityByEan) simply omit it.
  onChain?: (retailer: RetailerId, count: number) => void,
) => Promise<RetailerSearchResponse>;

/**
 * Multi-pass retailer search. Chains still below SUGGESTION_THRESHOLD
 * after a pass get the next, progressively looser query shape:
 *
 * 1. Full brand+title query (plus the known EAN, if any).
 * 2. Brand + title with digit-bearing tokens stripped — several engines
 *    AND every query token, and the numeric ones ("1,7%", "1lt") are the
 *    usual poison: verified live on sklavenitis, where the full query
 *    returns nothing but "ΟΛΥΜΠΟΣ Φρέσκο Γάλα Ελαφρύ" finds the product.
 * 3. The stripped title alone — rescues brand-spelling mismatches; the
 *    ranker's gates keep the broader result set honest.
 * 4. Brand-only — the widest net our ranker can still pick from.
 * 5. When no EAN was known but a ≥60% match carries one (Galaxias,
 *    Kritikos and Lidl results do), re-query the barcode-capable chains
 *    that still lack a match with it — a barcode hit is identity and
 *    outranks anything fuzzy.
 *
 * Passes MERGE per chain (best score per SKU wins), so a retry can add
 * candidates but never displace a better-scored one from an earlier
 * pass — and a wrong high scorer can't block a correct later find.
 */
export const searchAndRank = async (
  title: string,
  brand: string,
  ean: string | null,
  retailers?: readonly RetailerId[],
  searchFn: SearchFn = searchRetailers,
  onProgress?: SearchProgressListener,
): Promise<OrchestratedSearch> => {
  const query = `${brand} ${title}`.trim();
  const ranked = new Map<RetailerId, RankedResult[]>();
  const errors: string[] = [];
  // The canonical chain list, used when a pass targets "everyone" (subset
  // undefined) so the progress board knows which rows to light up.
  const allRetailers: readonly RetailerId[] = [...RETAILER_LABELS.keys()];

  const topScore = (retailer: RetailerId): number => {
    return ranked.get(retailer)?.[0]?.score ?? -1;
  };

  const runPass = async (
    passQuery: string,
    subset: readonly RetailerId[] | undefined,
    passEan: string | null,
    pass: SearchPass,
  ): Promise<void> => {
    onProgress?.({ kind: 'pass', pass, retailers: subset ?? allRetailers });

    const response = await searchFn(passQuery, subset, passEan, (retailer, count) =>
      onProgress?.({ kind: 'chain', retailer, count }),
    );
    errors.push(...response.errors);

    for (const [retailer, results] of Object.entries(response.results)) {
      const id = retailer as RetailerId;
      const list = rankResults(results, title, brand, passEan);

      ranked.set(id, mergeRanked(ranked.get(id) ?? [], list));
    }
  };

  await runPass(query, retailers, ean, 'full');

  const strippedTitle = stripNumericTokens(title);
  const usedQueries = new Set([query]);
  const retryPasses: { query: string; pass: SearchPass }[] = [
    { query: `${brand} ${strippedTitle}`.trim(), pass: 'brand-stripped' },
    { query: strippedTitle, pass: 'stripped' },
    { query: brand.trim(), pass: 'brand' },
  ];

  for (const { query: retryQuery, pass } of retryPasses) {
    if (retryQuery.length < 3 || true === usedQueries.has(retryQuery)) {
      continue;
    }

    const weakChains = [...ranked.keys()].filter(
      (retailer) => topScore(retailer) < SUGGESTION_THRESHOLD,
    );

    if (0 === weakChains.length) {
      break;
    }

    usedQueries.add(retryQuery);
    await runPass(retryQuery, weakChains, ean, pass);
  }

  let discoveredEan: string | null = null;

  if (null === ean || 0 === ean.length) {
    let bestScore = EAN_DISCOVERY_THRESHOLD;

    for (const list of ranked.values()) {
      for (const { result, score } of list) {
        if (null !== score && bestScore <= score && null !== result.ean) {
          bestScore = score;
          discoveredEan = result.ean;
        }
      }
    }

    if (null !== discoveredEan) {
      const eanChains = [...ranked.keys()].filter(
        (retailer) =>
          EAN_CAPABLE_RETAILERS.has(retailer) && topScore(retailer) < EAN_DISCOVERY_THRESHOLD,
      );

      if (0 < eanChains.length) {
        onProgress?.({ kind: 'ean', ean: discoveredEan });
        await runPass(query, eanChains, discoveredEan, 'ean');
      }
    }
  }

  return { ranked, errors: [...new Set(errors)], discoveredEan };
};

/**
 * Identify a product from a scanned barcode alone — the scan-to-prefill
 * path so a barcode doesn't require typing the name. Queries the fast
 * barcode-capable chains with the EAN as both the search text and the
 * hint, and returns the barcode-confirmed title/brand (a result whose
 * own `ean` equals the scan). Returns null when none of them carry it,
 * in which case the user still types the name by hand.
 */
export const resolveIdentityByEan = async (
  ean: string,
  searchFn: SearchFn = searchRetailers,
): Promise<{ title: string; brand: string | null } | null> => {
  const { results } = await searchFn(ean, IDENTITY_CHAINS, ean);

  let title = '';
  let brand: string | null = null;

  for (const list of Object.values(results)) {
    for (const result of list ?? []) {
      // Only trust a barcode-confirmed row — the EAN query can also return
      // near-matches the chain thinks are relevant.
      if (result.ean !== ean) {
        continue;
      }

      // Prefer the most descriptive name: chains abbreviate differently
      // (Galaxias caps-truncates to "ΦΑΓΕ TOTAL 2% 1KG"; My Market spells
      // out "ΦΑΓΕ Total Στραγγιστό Γιαούρτι 2% Λιπαρά 1kg"), and this title
      // becomes the product's canonical name plus the matcher's size gate.
      if (result.title.length > title.length) {
        title = result.title;
      }

      if (null === brand && null !== result.brand) {
        brand = result.brand;
      }
    }
  }

  return 0 < title.length ? { title, brand } : null;
};

/**
 * AND-search poison control: sizes, percentages and pack counts are the
 * tokens retailers spell differently ("1,7%" vs "1.7", "1lt" vs "1λτ"),
 * so a retry query drops everything digit-bearing and lets the ranker's
 * size/percent gates do the disambiguation instead.
 */
const stripNumericTokens = (text: string): string => {
  return text
    .split(/\s+/)
    .filter((token) => 0 < token.length && false === /[\d%]/.test(token))
    .join(' ');
};

const mergeRanked = (
  existing: readonly RankedResult[],
  incoming: readonly RankedResult[],
): RankedResult[] => {
  const bySku = new Map<string, RankedResult>();

  for (const entry of [...existing, ...incoming]) {
    const previous = bySku.get(entry.result.sku);

    if (undefined === previous || (entry.score ?? -1) > (previous.score ?? -1)) {
      bySku.set(entry.result.sku, entry);
    }
  }

  return [...bySku.values()].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
};

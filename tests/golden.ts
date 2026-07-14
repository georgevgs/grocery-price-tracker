import { rankResults, SUGGESTION_THRESHOLD } from '../apps/web/src/lib/matching';
import type { RetailerSearchResult } from '../packages/core/src/types';

/**
 * Golden matching set: labeled cross-retailer pairs, including adversarial
 * negatives, evaluated through the real ranking path (rankResults).
 *
 * A case "matches" when its score clears SUGGESTION_THRESHOLD — the same
 * bar the UI uses to preselect a candidate. Precision/recall over this set
 * is the regression metric for every matcher change: floors in run.ts
 * start at the measured baseline and only ever ratchet up.
 */
export interface GoldenCase {
  name: string;
  /** The user's canonical product, as entered in AddProductForm. */
  product: { title: string; brand: string };
  /** The scraped search result being ranked against it. */
  result: { title: string; brand: string | null };
  shouldMatch: boolean;
  /** Which plan hole this case guards (docs/matching-plan.md). */
  note: string;
}

export const GOLDEN_CASES: readonly GoldenCase[] = [
  // --- true pairs -------------------------------------------------------
  {
    name: 'granola cross-retailer retitle',
    product: {
      title: 'Granola Βρώμης με Φιστικοβούτυρο & Μαύρη Σοκολάτα 350g',
      brand: 'HEALTHY HABITS',
    },
    result: {
      title: 'Δημητριακά Granola Φυστικοβούτυρο Μαύρη Σοκολάτα 350g',
      brand: 'HEALTHY HABITS',
    },
    shouldMatch: true,
    note: 'word-order + spelling variant survives on remaining tokens',
  },
  {
    name: 'homoglyph brand NOYNOY(latin) vs ΝΟΥΝΟΥ(greek)',
    product: { title: 'Γάλα Εβαπορέ Πλήρες 170g', brand: 'NOYNOY' },
    result: { title: 'ΝΟΥΝΟΥ Γάλα Εβαπορέ Πλήρες 170g', brand: null },
    shouldMatch: true,
    note: 'hole 3: latin brand codepoints never substring-match greek title',
  },
  {
    name: 'spelling variant φυστίκια/φιστίκια',
    product: { title: 'Φυστίκια Αιγίνης 200g', brand: 'ΣΕΡΑΝΟ' },
    result: { title: 'ΣΕΡΑΝΟ Φιστίκια Αιγίνης 200g', brand: null },
    shouldMatch: true,
    note: 'hole 5: disjoint tokens under exact jaccard, carried by the rest',
  },
  {
    name: 'kg vs gr unit equivalence',
    product: { title: 'Ρύζι Καρολίνα 1kg', brand: 'AGRINO' },
    result: { title: 'AGRINO Ρύζι Καρολίνα 1000gr', brand: null },
    shouldMatch: true,
    note: 'size normalization to canonical grams',
  },
  {
    name: 'same fat % on both sides',
    product: { title: 'Ελληνικό Γάλα 3,5% Λιπαρά 1lt', brand: 'ΜΑΣΟΥΤΗΣ' },
    result: { title: 'Μασούτης Ελληνικό Γάλα 3,5% Λιπαρά 1lt.', brand: null },
    shouldMatch: true,
    note: 'control: the % attribute gate must not fire on equal percentages',
  },
  {
    name: 'multipack on both sides',
    product: { title: 'Granola Μπάρες 5x42g', brand: 'ΠΑΠΑΔΟΠΟΥΛΟΥ' },
    result: { title: 'ΠΑΠΑΔΟΠΟΥΛΟΥ Μπάρες Granola 5x42gr', brand: null },
    shouldMatch: true,
    note: 'control: multipack parsing must treat equal packs as equal',
  },
  {
    name: 'hyphenated brand across scripts of writing',
    product: { title: 'Αναψυκτικό Cola 330ml', brand: 'Coca-Cola' },
    result: { title: 'COCA COLA Αναψυκτικό Can 330ml', brand: null },
    shouldMatch: true,
    note: 'punctuation folding in brand tokens',
  },
  {
    name: 'cross-script brand FAGE(latin) vs ΦΑΓΕ(greek)',
    product: { title: 'Γιαούρτι Στραγγιστό 2% 200g', brand: 'ΦΑΓΕ' },
    result: { title: 'FAGE Total Γιαούρτι Στραγγιστό 2% 200g', brand: 'FAGE' },
    shouldMatch: true,
    note: 'phonetic brand fold bridges Φ/Γ, which lack a Latin homoglyph (hard gate)',
  },
  {
    name: 'promo % must not poison the fat-% gate',
    product: { title: 'Γάλα Φρέσκο 3,5% 1lt', brand: 'ΝΟΥΝΟΥ' },
    result: { title: 'ΝΟΥΝΟΥ Γάλα Φρέσκο -20% 3,5% 1lt', brand: null },
    shouldMatch: true,
    note: 'extractPercent must read the fat 3,5%, not the leading promo -20%',
  },
  {
    name: 'synonym: στραγγιστό ≡ στραγγισμένο (would miss without the alias)',
    product: { title: 'Γιαούρτι Στραγγιστό', brand: 'ΦΑΓΕ' },
    result: { title: 'ΦΑΓΕ Γιαούρτι Στραγγισμένο', brand: null },
    shouldMatch: true,
    note: 'synonym table: too far apart for the fold/edit-distance; sizeless + generic γιαούρτι drops it to 0.41 (< threshold) without the alias',
  },
  {
    name: 'synonym: ανθρακούχο ≡ αεριούχο (carbonated water)',
    product: { title: 'Νερό Μεταλλικό Ανθρακούχο 1lt', brand: 'ΣΟΥΡΩΤΗ' },
    result: { title: 'ΣΟΥΡΩΤΗ Νερό Μεταλλικό Αεριούχο 1lt', brand: null },
    shouldMatch: true,
    note: 'synonym table guard: the two carbonation words name the same attribute',
  },

  // --- adversarial negatives ---------------------------------------------
  {
    name: 'fat % variant: 3,5% vs 1,5% same brand/size',
    product: { title: 'Ελληνικό Γάλα 3,5% Λιπαρά 1lt', brand: 'ΜΑΣΟΥΤΗΣ' },
    result: { title: 'Μασούτης Ελληνικό Γάλα 1,5% Λιπαρά 1lt', brand: null },
    shouldMatch: false,
    note: 'hole 6: percentages tokenize as noise, near-identical jaccard',
  },
  {
    name: 'multipack vs single: 5x42g vs 42g',
    product: { title: 'Granola Μπάρα Βρώμης 42g', brand: 'ΠΑΠΑΔΟΠΟΥΛΟΥ' },
    result: { title: 'ΠΑΠΑΔΟΠΟΥΛΟΥ Granola Μπάρες 5x42g', brand: null },
    shouldMatch: false,
    note: 'hole 4: first-hit size regex reads 5x42g as 42g',
  },
  {
    name: 'different multipack counts: 4x250ml vs 9x250ml',
    product: { title: 'Χυμός Πορτοκάλι 4x250ml', brand: 'AMITA' },
    result: { title: 'AMITA Χυμός Πορτοκάλι 9x250ml', brand: null },
    shouldMatch: false,
    note: 'hole 4: per-piece size matches, totals differ wildly',
  },
  {
    name: 'same brand, different size, both declared',
    product: { title: 'Granola Βρώμης με Φιστικοβούτυρο 350g', brand: 'HEALTHY HABITS' },
    result: { title: 'HEALTHY HABITS Granola Βρώμης με Φιστικοβούτυρο 400g', brand: null },
    shouldMatch: false,
    note: 'regression: the existing size gate must keep excluding this',
  },
  {
    name: 'full-fat vs light: one-token difference',
    product: { title: 'Φρέσκο Γάλα Πλήρες 1lt', brand: 'ΔΕΛΤΑ' },
    result: { title: 'ΔΕΛΤΑ Φρέσκο Γάλα Ελαφρύ 1lt', brand: null },
    shouldMatch: false,
    note: 'hole 9: generic tokens (γάλα, φρέσκο) outweigh the distinguishing one',
  },
  {
    name: 'variant contradiction: goat milk vs cow milk',
    product: { title: 'Γάλα Κατσικίσιο 1lt', brand: 'ΟΛΥΜΠΟΣ' },
    result: { title: 'ΟΛΥΜΠΟΣ Γάλα Αγελαδινό 1lt', brand: null },
    shouldMatch: false,
    note: 'variant-attribute gate: different members of the milk-source class',
  },
  {
    name: 'variant contradiction: buffalo milk vs cow milk',
    product: { title: 'Γάλα Βουβαλίσιο 1lt', brand: 'ΟΛΥΜΠΟΣ' },
    result: { title: 'ΟΛΥΜΠΟΣ Γάλα Αγελαδινό 1lt', brand: null },
    shouldMatch: false,
    note: 'variant-attribute gate: βουβαλίσιο is a fourth milk-source group',
  },
  {
    name: 'variant contradiction: ground coffee vs whole beans',
    product: { title: 'Καφές Espresso Αλεσμένος 250g', brand: 'ΛΟΥΜΙΔΗΣ' },
    result: { title: 'ΛΟΥΜΙΔΗΣ Καφές Espresso Κόκκοι 250g', brand: null },
    shouldMatch: false,
    note: 'variant-attribute gate: ground/beans are different shelf products despite same brand+size+espresso',
  },
  {
    name: 'brand substring: ΒΙΟ inside Βιολογικό',
    product: { title: 'Γιαούρτι Πρόβειο 200g', brand: 'ΒΙΟ' },
    result: { title: 'Βιολογικό Γιαούρτι Πρόβειο 200g', brand: null },
    shouldMatch: false,
    note: 'hole 8: substring brand check, no token boundary',
  },
  {
    name: 'unrelated brand and product',
    product: { title: 'Granola Βρώμης 350g', brand: 'HEALTHY HABITS' },
    result: { title: 'AGRINO Ρύζι Basmati 500g', brand: 'AGRINO' },
    shouldMatch: false,
    note: 'regression: the brand gate must keep excluding this',
  },
];

export interface GoldenOutcome {
  goldenCase: GoldenCase;
  score: number | null;
  matched: boolean;
  correct: boolean;
}

export interface GoldenMetrics {
  outcomes: GoldenOutcome[];
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number;
  recall: number;
}

export const evaluateGoldenSet = (): GoldenMetrics => {
  const outcomes = GOLDEN_CASES.map((goldenCase): GoldenOutcome => {
    const searchResult: RetailerSearchResult = {
      retailer: 'sklavenitis',
      sku: 'golden',
      title: goldenCase.result.title,
      url: 'test://golden',
      brand: goldenCase.result.brand,
      ean: null,
      pricePiece: null,
      priceUnit: null,
      unitLabel: null,
    };

    const [ranked] = rankResults(
      [searchResult],
      goldenCase.product.title,
      goldenCase.product.brand,
      null,
    );

    const score = ranked?.score ?? null;
    const matched = null !== score && SUGGESTION_THRESHOLD <= score;

    return {
      goldenCase,
      score,
      matched,
      correct: matched === goldenCase.shouldMatch,
    };
  });

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;

  for (const outcome of outcomes) {
    if (true === outcome.goldenCase.shouldMatch) {
      if (true === outcome.matched) {
        truePositives += 1;
      } else {
        falseNegatives += 1;
      }
    } else if (true === outcome.matched) {
      falsePositives += 1;
    } else {
      trueNegatives += 1;
    }
  }

  const precision =
    0 === truePositives + falsePositives ? 1 : truePositives / (truePositives + falsePositives);
  const recall =
    0 === truePositives + falseNegatives ? 1 : truePositives / (truePositives + falseNegatives);

  return {
    outcomes,
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    precision,
    recall,
  };
};

export const formatGoldenReport = (metrics: GoldenMetrics): string => {
  const lines = ['--- golden matching set ---'];

  for (const outcome of metrics.outcomes) {
    const verdict = outcome.correct ? 'ok  ' : 'MISS';
    const expected = outcome.goldenCase.shouldMatch ? 'match' : 'no-match';
    const scoreText = null === outcome.score ? 'gated' : outcome.score.toFixed(3);

    lines.push(`${verdict} [want ${expected}, score ${scoreText}] ${outcome.goldenCase.name}`);
  }

  lines.push(
    `precision ${metrics.precision.toFixed(3)} ` +
      `(FP ${metrics.falsePositives}) — recall ${metrics.recall.toFixed(3)} ` +
      `(FN ${metrics.falseNegatives})`,
  );

  return lines.join('\n');
};

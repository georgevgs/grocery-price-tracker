import { abHaystack, abQueryTokens } from '../packages/scrapers/src/ab';
import {
  sklavenitisHaystack,
  sklavenitisQueryTokens,
} from '../packages/scrapers/src/sklavenitis';
import { buildHaystack, queryTokens } from '../packages/scrapers/src/kritikos';

/**
 * Golden RETRIEVAL set — the sibling of golden.ts for the OTHER half of search.
 *
 * golden.ts measures the RANKER (precision): given the right row was fetched,
 * does the fuzzy matcher score it correctly? It hands rankResults a row directly,
 * so it never touches discovery. This set measures RETRIEVAL (recall): does a
 * chain's tokenizer + D1 `haystack` actually SURFACE the target row for a query?
 * That is where a real "it didn't find my product" comes from, and it used to be
 * untested — the catalog haystack was only normalizeTitle'd, leaving retrieval
 * STRICTER than the matcher (the ranker equates Φυστίκια/Φιστίκια; the substring
 * index did not), so a matchable product could be un-retrievable. The positive
 * cases below all FAILED before the foldHaystack/foldQueryTokens change and pass
 * after it; the negatives prove token-AND still discriminates.
 *
 * A case "retrieves" exactly as the edge does: every folded query token must be a
 * substring of the folded haystack (the LIKE-AND rule; FTS5 prefix matching is a
 * strict superset, so a row that clears this clears MATCH too).
 */
export interface RetrievalCase {
  name: string;
  chain: 'ab' | 'sklavenitis' | 'kritikos';
  /**
   * The product as the off-edge crawl indexed it. AB/Sklavenitis index a Greek
   * title (+ AB brand); Kritikos indexes the site's own pre-transliterated
   * greeklish searchTerms, so its fixture is greeklish.
   */
  indexed: { title?: string; brand?: string | null; greeklish?: string };
  /** What the user (or the multi-pass orchestrator) sends to the edge. */
  query: string;
  shouldRetrieve: boolean;
  note: string;
}

export const RETRIEVAL_CASES: readonly RetrievalCase[] = [
  // --- iota-class fold: matchable ⇒ now retrievable ----------------------
  {
    name: 'ab: φυστίκια query retrieves φιστίκια row',
    chain: 'ab',
    indexed: { title: 'ΣΕΡΑΝΟ Φιστίκια Αιγίνης 200g', brand: 'ΣΕΡΑΝΟ' },
    query: 'ΣΕΡΑΝΟ Φυστίκια Αιγίνης 200g',
    shouldRetrieve: true,
    note: 'the exact φυστίκια/φιστίκια pair golden.ts matches — now also retrievable',
  },
  {
    name: 'sklavenitis: φυστικοβούτυρο query retrieves φιστικοβούτυρο row',
    chain: 'sklavenitis',
    indexed: { title: 'HEALTHY HABITS Granola με Φιστικοβούτυρο 350g' },
    query: 'Φυστικοβούτυρο',
    shouldRetrieve: true,
    note: 'iota fold on both sides collapses the spelling the retailer disagrees on',
  },
  {
    name: 'kritikos: greeklish iota fold (fystikia ≡ fistikia)',
    chain: 'kritikos',
    indexed: { greeklish: 'gkranola fistikia aiginhs' },
    query: 'Γκρανόλα Φυστίκια',
    shouldRetrieve: true,
    note: 'foldForComparison over the transliterated tokens unifies η/υ → i',
  },
  // --- stem: plural/case endings tolerated -------------------------------
  {
    name: 'sklavenitis: Ελληνικός query retrieves Ελληνικό row',
    chain: 'sklavenitis',
    indexed: { title: 'ΟΛΥΜΠΟΣ Επιλεγμένο Γάλα Ελληνικό 1lt' },
    query: 'Ελληνικός',
    shouldRetrieve: true,
    note: 'stem strips the -ς ending; substring match absorbs the fuller indexed form',
  },
  // --- negatives: token-AND must still gate a genuinely absent token ------
  {
    name: 'ab: an absent content token gates the row out',
    chain: 'ab',
    indexed: { title: 'ΣΕΡΑΝΟ Φιστίκια Αιγίνης 200g', brand: 'ΣΕΡΑΝΟ' },
    query: 'ΣΕΡΑΝΟ Κάσιους 200g',
    shouldRetrieve: false,
    note: 'AND semantics: κάσιους is nowhere in the haystack, so the row is not surfaced',
  },
  {
    name: 'kritikos: wrong flavour token gates the row out',
    chain: 'kritikos',
    indexed: { greeklish: 'gkranola fistikia aiginhs' },
    query: 'Γκρανόλα Σοκολάτα',
    shouldRetrieve: false,
    note: 'σοκολάτα absent → not every token matches → correctly not retrieved',
  },
];

const haystackFor = (c: RetrievalCase): string => {
  if ('ab' === c.chain) {
    return abHaystack(c.indexed.brand ?? null, c.indexed.title ?? '');
  }

  if ('sklavenitis' === c.chain) {
    return sklavenitisHaystack(c.indexed.title ?? '');
  }

  // Kritikos indexes the site's greeklish searchTerms — buildHaystack folds them.
  return buildHaystack({ searchTerms: { name: c.indexed.greeklish ?? '' } } as Parameters<
    typeof buildHaystack
  >[0]);
};

const tokensFor = (c: RetrievalCase): string[] => {
  if ('ab' === c.chain) {
    return abQueryTokens(c.query);
  }

  if ('sklavenitis' === c.chain) {
    return sklavenitisQueryTokens(c.query);
  }

  return queryTokens(c.query);
};

/** The edge rule: a row is retrieved when every folded query token substring-hits. */
export const retrieves = (c: RetrievalCase): boolean => {
  const haystack = haystackFor(c);
  const tokens = tokensFor(c);

  return 0 < tokens.length && tokens.every((token) => haystack.includes(token));
};

export interface RetrievalOutcome {
  retrievalCase: RetrievalCase;
  retrieved: boolean;
  correct: boolean;
}

export interface RetrievalMetrics {
  outcomes: RetrievalOutcome[];
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number;
  recall: number;
}

export const evaluateRetrievalSet = (): RetrievalMetrics => {
  const outcomes = RETRIEVAL_CASES.map((retrievalCase): RetrievalOutcome => {
    const retrieved = retrieves(retrievalCase);

    return {
      retrievalCase,
      retrieved,
      correct: retrieved === retrievalCase.shouldRetrieve,
    };
  });

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;

  for (const outcome of outcomes) {
    if (true === outcome.retrievalCase.shouldRetrieve) {
      if (true === outcome.retrieved) {
        truePositives += 1;
      } else {
        falseNegatives += 1;
      }
    } else if (true === outcome.retrieved) {
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

export const formatRetrievalReport = (metrics: RetrievalMetrics): string => {
  const lines = ['--- golden retrieval set ---'];

  for (const outcome of metrics.outcomes) {
    const verdict = outcome.correct ? 'ok  ' : 'MISS';
    const expected = outcome.retrievalCase.shouldRetrieve ? 'retrieve' : 'skip';
    const got = outcome.retrieved ? 'retrieved' : 'skipped';

    lines.push(`${verdict} [want ${expected}, got ${got}] ${outcome.retrievalCase.name}`);
  }

  lines.push(
    `precision ${metrics.precision.toFixed(3)} ` +
      `(FP ${metrics.falsePositives}) — recall ${metrics.recall.toFixed(3)} ` +
      `(FN ${metrics.falseNegatives})`,
  );

  return lines.join('\n');
};

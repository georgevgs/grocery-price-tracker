import { useCallback, useEffect, useRef, useState } from 'react';
import type { RetailerId } from '@grocery/core/types';
import {
  RETAILER_LABELS,
  type SearchPass,
  type SearchProgress,
} from '../lib/matching';

/**
 * A live, terminal-styled "what am I doing right now" board shown while a
 * multi-pass retailer search runs. searchAndRank fans out one chain per
 * request across several progressively looser passes; instead of a bare
 * "ΑΝΑΖΗΤΗΣΗ…" the user watches each chain land and reads the running
 * narrative of which query shape is being tried. Purely cosmetic — it
 * renders the SearchProgress events, it does not drive the search.
 */

type ChainStatus = { state: 'searching' | 'done'; count: number };

export interface SearchProgressState {
  pass: SearchPass | null;
  ean: string | null;
  chains: ReadonlyMap<RetailerId, ChainStatus>;
}

const EMPTY_PROGRESS: SearchProgressState = {
  pass: null,
  ean: null,
  chains: new Map(),
};

/**
 * Folds the flat SearchProgress event stream into board state. Returns the
 * `onProgress` listener to hand to searchAndRank and a `reset` to clear the
 * board before each new search. Functional setState throughout — the seven
 * chain events of a fan-out arrive in a burst.
 */
export const useSearchProgress = () => {
  const [progress, setProgress] = useState<SearchProgressState>(EMPTY_PROGRESS);

  const onProgress = useCallback((event: SearchProgress) => {
    setProgress((prev) => {
      if ('pass' === event.kind) {
        // A new pass re-arms its target chains as "searching" while keeping
        // any count an earlier pass already found for them.
        const chains = new Map(prev.chains);

        for (const retailer of event.retailers) {
          chains.set(retailer, {
            state: 'searching',
            count: chains.get(retailer)?.count ?? 0,
          });
        }

        return { ...prev, pass: event.pass, chains };
      }

      if ('chain' === event.kind) {
        const chains = new Map(prev.chains);
        chains.set(event.retailer, { state: 'done', count: event.count });
        return { ...prev, chains };
      }

      return { ...prev, ean: event.ean };
    });
  }, []);

  const reset = useCallback(() => setProgress(EMPTY_PROGRESS), []);

  return { progress, onProgress, reset };
};

// Braille spinner frames — the Claude-Code / terminal idiom. Cycled by a
// single interval and reused for the header and every in-flight chain.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Greek narration per pass. Kept here in the view layer (the matcher stays
// language-neutral). Playful but honest about what each pass actually does.
const PASS_LABELS: Record<SearchPass, string> = {
  full: 'Σαρώνω τα ράφια…',
  'brand-stripped': 'Χαλαρώνω λίγο την αναζήτηση…',
  stripped: 'Ψάχνω μόνο με το όνομα του προϊόντος…',
  brand: 'Ρίχνω πλατύτερο δίχτυ — μόνο με τη μάρκα…',
  ean: 'Βρήκα barcode — κλειδώνω το ακριβές προϊόν…',
};

export const SearchProgressBoard = ({ progress }: { progress: SearchProgressState }) => {
  const [frame, setFrame] = useState(0);
  // Anchored once at mount so the elapsed clock counts a single search.
  const startRef = useRef(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setFrame((f) => f + 1), 90);
    return () => window.clearInterval(id);
  }, []);

  const spinner = SPINNER[frame % SPINNER.length] ?? '⠋';
  const elapsed = Math.max(0, Math.floor((Date.now() - startRef.current) / 1000));
  // Before the first pass event (e.g. the scan-to-prefill barcode lookup)
  // there's no pass yet — still show life, not a blank box.
  const headline = null === progress.pass ? 'Ετοιμάζω την αναζήτηση…' : PASS_LABELS[progress.pass];

  // Only the chains this search has touched, in canonical order — so the
  // add form shows all seven while the "add more stores" panel shows only
  // the ones it's actually querying.
  const rows = [...RETAILER_LABELS.entries()].filter(([retailer]) =>
    progress.chains.has(retailer),
  );

  return (
    <div
      className="rounded-xl border-2 border-ink bg-ink p-3 font-mono text-white shadow-hard-sm"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="text-accent" aria-hidden="true">
          {spinner}
        </span>
        <span className="flex-1 tracking-wide">{headline}</span>
        <span className="tabular-nums text-faint">{elapsed}s</span>
      </div>

      {null !== progress.ean && (
        <div className="mt-1.5 text-[11px] tracking-wide text-accent">
          barcode {progress.ean}
        </div>
      )}

      {0 < rows.length && (
        <ul className="mt-2.5 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {rows.map(([retailer, label]) => {
            const status = progress.chains.get(retailer);
            const searching = 'searching' === status?.state;
            const found = 'done' === status?.state && 0 < status.count;

            let marker = '·';

            if (true === searching) {
              marker = spinner;
            } else if (true === found) {
              marker = '✓';
            }

            return (
              <li key={retailer} className="flex items-center gap-2 text-[11px]">
                <span
                  className={`w-3 text-center ${true === found ? 'text-accent' : 'text-faint'}`}
                  aria-hidden="true"
                >
                  {marker}
                </span>
                <span className={true === searching ? 'text-white' : 'text-faint'}>{label}</span>
                {'done' === status?.state && (
                  <span className="ml-auto tabular-nums text-faint">
                    {0 < status.count ? status.count : '—'}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

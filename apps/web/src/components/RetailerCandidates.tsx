import type { RetailerId } from '@grocery/core/types';
import { RETAILER_LABELS, type RankedResult } from '../lib/matching';

interface CandidateGroupsProps {
  candidates: Map<RetailerId, RankedResult[]>;
  selectedSkus: Map<RetailerId, string | null>;
  onSelect: (retailer: RetailerId, sku: string | null) => void;
}

export const CandidateGroups = ({ candidates, selectedSkus, onSelect }: CandidateGroupsProps) => {
  return (
    <>
      {[...candidates.entries()].map(([retailer, ranked]) => (
        <fieldset key={retailer} className="rounded-xl border-2 border-ink bg-white p-3">
          <legend className="px-1 font-mono text-[11px] uppercase tracking-wide text-muted">
            {RETAILER_LABELS.get(retailer) ?? retailer}
          </legend>

          {0 === ranked.length ? (
            <p className="text-sm text-muted">Κανένα αποτέλεσμα σε αυτό το κατάστημα.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {ranked.map(({ result, score, sizeUnverified }) => (
                <label key={result.sku} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    className="mt-1 accent-ink"
                    name={`candidate-${retailer}`}
                    checked={selectedSkus.get(retailer) === result.sku}
                    onChange={() => onSelect(retailer, result.sku)}
                  />
                  <span>
                    {result.title}
                    {null !== result.pricePiece && (
                      <span className="ml-1 font-mono font-bold text-ink">
                        {result.pricePiece.toFixed(2).replace('.', ',')} €
                      </span>
                    )}
                    {null !== score && (
                      <span className="ml-1 font-mono text-xs text-muted">
                        ({Math.round(score * 100)}% αντιστοιχία)
                      </span>
                    )}
                    {true === sizeUnverified && (
                      <span className="ml-1 font-mono text-xs text-warn">μη επιβεβαιωμένο μέγεθος</span>
                    )}
                  </span>
                </label>
              ))}

              <label className="flex items-center gap-2 text-sm text-muted">
                <input
                  type="radio"
                  className="accent-ink"
                  name={`candidate-${retailer}`}
                  checked={null === (selectedSkus.get(retailer) ?? null)}
                  onChange={() => onSelect(retailer, null)}
                />
                Κανένα από αυτά — παράλειψη
              </label>
            </div>
          )}
        </fieldset>
      ))}
    </>
  );
};

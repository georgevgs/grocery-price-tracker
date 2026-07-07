import { useState, type FormEvent } from 'react';
import type { ProductWithListings, RetailerId } from '@grocery/core/types';
import { suggestMatches, type MatchSuggestion } from '@grocery/core/match';
import { extractEanFromInput, extractSize } from '@grocery/core/normalize';
import { createProduct, lookupBarcode, triggerScrape } from '../api/client';
import { BarcodeScannerModal } from './BarcodeScannerModal';
import { ErrorNotice } from './ErrorNotice';
import { CandidateGroups } from './RetailerCandidates';
import { SearchProgressBoard, useSearchProgress } from './SearchProgressBoard';
import {
  AUTO_PICK_THRESHOLD,
  collectConfirmedEan,
  collectProductImage,
  collectSelectedListings,
  resolveIdentityByEan,
  searchAndRank,
  SUGGESTION_THRESHOLD,
  type RankedResult,
} from '../lib/matching';

interface AddProductFormProps {
  existingProducts: ProductWithListings[];
  onCreated: () => void;
}

const MAX_CANDIDATES = 5;

const INPUT_CLASS =
  'rounded-xl border-2 border-ink bg-white px-3.5 py-2.5 text-sm outline-none placeholder:text-muted';

export const AddProductForm = ({ existingProducts, onCreated }: AddProductFormProps) => {
  const [brand, setBrand] = useState('');
  const [title, setTitle] = useState('');
  const [ean, setEan] = useState('');
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [searchErrors, setSearchErrors] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<Map<RetailerId, RankedResult[]> | null>(null);
  const [selectedSkus, setSelectedSkus] = useState<Map<RetailerId, string | null>>(new Map());
  // Product shot from Open Food Facts (populated on scan) — a fallback for
  // products no retailer candidate carries an image for.
  const [scanImageUrl, setScanImageUrl] = useState<string | null>(null);
  // Live search telemetry for the progress board shown while isSearching.
  const { progress, onProgress, reset: resetProgress } = useSearchProgress();

  // Derived during render — never synced into state via effects.
  const duplicateSuggestions = computeSuggestions(brand, title, existingProducts);

  const handleSearch = async (eanOverride?: string) => {
    setIsSearching(true);
    setSubmitError(null);
    setSearchErrors([]);
    resetProgress();

    try {
      const scanned = extractEanFromInput(eanOverride ?? ean);
      let effectiveTitle = title;
      let effectiveBrand = brand;

      // Scan-to-prefill: a barcode alone identifies the product, so recover
      // its name (and brand) instead of making the user type them. This is
      // what lets a scan drive the search at all — the title gate below and
      // the cross-chain ranker both need a name to work with.
      if (effectiveTitle.trim().length < 4 && null !== scanned) {
        // Open Food Facts first — cleaner canonical Greek names, and it
        // covers products not sold at our fast chains. Keep its image even
        // when it has no name (many Greek entries are photo-only stubs).
        const off = await lookupBarcode(scanned);
        let resolvedTitle = off.name;
        let resolvedBrand = off.brand;

        if (null !== off.imageUrl) {
          setScanImageUrl(off.imageUrl);
        }

        // Fall back to the retailer chains when Open Food Facts has no name.
        if (null === resolvedTitle) {
          const identity = await resolveIdentityByEan(scanned);

          if (null !== identity) {
            resolvedTitle = identity.title;
            resolvedBrand = resolvedBrand ?? identity.brand;
          }
        }

        if (null === resolvedTitle) {
          setSearchErrors([
            'Δεν βρέθηκε προϊόν από το barcode — συμπλήρωσε μάρκα και τίτλο και δοκίμασε ξανά.',
          ]);
          return;
        }

        effectiveTitle = resolvedTitle;
        setTitle(resolvedTitle);

        if (0 === effectiveBrand.trim().length && null !== resolvedBrand) {
          effectiveBrand = resolvedBrand;
          setBrand(resolvedBrand);
        }
      }

      if (effectiveTitle.trim().length < 4) {
        setSearchErrors(['Χρειάζεται τίτλος (4+ χαρακτήρες) ή σκανάρισμα barcode.']);
        return;
      }

      const { ranked, errors } = await searchAndRank(
        effectiveTitle,
        effectiveBrand,
        scanned,
        undefined,
        undefined,
        onProgress,
      );
      const sliced = new Map<RetailerId, RankedResult[]>();
      const preselected = new Map<RetailerId, string | null>();

      for (const [retailer, list] of ranked) {
        const top = list.slice(0, MAX_CANDIDATES);
        sliced.set(retailer, top);

        // Only pre-select a confident, size-verified top match; weaker or
        // size-unverified ones stay visible but unchecked so the user
        // consciously confirms them rather than blind-linking a lookalike.
        const best = top[0];
        const autoPick =
          undefined !== best &&
          null !== best.score &&
          AUTO_PICK_THRESHOLD <= best.score &&
          false === best.sizeUnverified
            ? best.result.sku
            : null;
        preselected.set(retailer, autoPick);
      }

      // NOTE: a barcode discovered from a single fuzzy match is deliberately
      // NOT written into the EAN field here — that would persist an unverified
      // identity from one ≥0.6 guess. The EAN is instead taken at save time
      // from what the user typed/scanned, or from collectConfirmedEan (which
      // requires the confirmed picks to AGREE on a barcode).

      setCandidates(sliced);
      setSelectedSkus(preselected);
      setSearchErrors(errors);
    } catch (error) {
      setSearchErrors([error instanceof Error ? error.message : 'Η αναζήτηση απέτυχε.']);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // No typed/scanned barcode? The confirmed picks may still carry one
      // (Galaxias/Kritikos/Lidl expose them) — persist that identity now
      // so every later search runs the exact EAN path instead of fuzzy.
      // The parsed pack size becomes the product's authoritative size —
      // titles at other chains may omit it, and the matcher needs one
      // trustworthy side for its size gate.
      const parsedSize = extractSize(title);

      await createProduct({
        ean: extractEanFromInput(ean) ?? collectConfirmedEan(candidates, selectedSkus),
        brand,
        title,
        sizeValue: parsedSize?.value ?? null,
        sizeUnit: parsedSize?.unit ?? null,
        imageUrl: collectProductImage(candidates, selectedSkus) ?? scanImageUrl,
        listings: collectSelectedListings(candidates, selectedSkus),
      });

      // Record today's prices for the freshly linked listings right away.
      await triggerScrape().catch(() => {});
      onCreated();
    } catch (error) {
      if (error instanceof Error) {
        setSubmitError(error.message);
      } else {
        setSubmitError('Αποτυχία δημιουργίας προϊόντος.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEanDetected = (detected: string) => {
    setEan(detected);
    setIsScannerOpen(false);
    // A scan is enough to identify the product — resolve and search right
    // away so the user reviews matches instead of transcribing a name.
    void handleSearch(detected);
  };

  const handleSelect = (retailer: RetailerId, sku: string | null) => {
    setSelectedSkus((prev) => new Map(prev).set(retailer, sku));
  };

  // A 4+ char title OR a valid barcode is enough to search — the scan
  // path recovers the title from the barcode before ranking.
  const canSearch =
    false === isSearching &&
    (4 <= title.trim().length || null !== extractEanFromInput(ean));

  let searchLabel = 'ΒΡΕΣ ΣΤΑ ΚΑΤΑΣΤΗΜΑΤΑ';

  if (true === isSearching) {
    searchLabel = 'ΑΝΑΖΗΤΗΣΗ…';
  }

  let submitLabel = 'ΑΠΟΘΗΚΕΥΣΗ';

  if (true === isSubmitting) {
    submitLabel = 'ΑΠΟΘΗΚΕΥΣΗ & ΛΗΨΗ ΤΙΜΩΝ…';
  }

  const errorBlock = <ErrorNotice messages={null !== submitError ? [submitError] : []} />;

  return (
    <form
      className="flex flex-col gap-3 rounded-2xl border-2 border-ink bg-white p-5 shadow-hard"
      onSubmit={handleSubmit}
    >
      <span className="font-mono text-[11px] tracking-wide text-muted">ΣΤΟΙΧΕΙΑ ΠΡΟΪΟΝΤΟΣ</span>

      <input
        className={INPUT_CLASS}
        placeholder="Μάρκα (π.χ. HEALTHY HABITS)"
        value={brand}
        required
        onChange={(event) => setBrand(event.target.value)}
      />

      <input
        className={INPUT_CLASS}
        placeholder="Τίτλος (π.χ. Granola Φιστικοβούτυρο & Μαύρη Σοκολάτα 350g)"
        value={title}
        required
        onChange={(event) => setTitle(event.target.value)}
      />

      {renderSuggestions(duplicateSuggestions, existingProducts)}

      <div className="flex gap-2">
        <input
          className={`flex-1 ${INPUT_CLASS}`}
          placeholder="EAN (προαιρετικό — σκάναρέ το)"
          value={ean}
          onChange={(event) => setEan(event.target.value)}
        />
        <button
          type="button"
          className="rounded-xl border-2 border-ink bg-white px-3.5 py-2 font-mono text-xs font-bold tracking-wide hover:bg-linen"
          onClick={() => setIsScannerOpen(true)}
        >
          ΣΚΑΝ
        </button>
      </div>

      <button
        type="button"
        className="rounded-xl border-2 border-ink bg-white px-3.5 py-2.5 font-mono text-xs font-bold tracking-wide hover:bg-accent disabled:opacity-50"
        disabled={false === canSearch}
        onClick={() => handleSearch()}
      >
        {searchLabel}
      </button>

      {true === isSearching && <SearchProgressBoard progress={progress} />}

      {/* When NOTHING was found, the per-chain errors are the whole story, so
          show them as a real failure (red), not an amber "hiccup". */}
      <ErrorNotice
        messages={searchErrors}
        tone={null !== candidates && 0 === countCandidates(candidates) ? 'danger' : 'warn'}
      />

      {null !== candidates &&
        (0 === countCandidates(candidates) ? (
          <p className="rounded-xl border-2 border-dashed border-ink bg-white px-3.5 py-3 text-sm text-muted">
            Δεν βρέθηκαν αντιστοιχίες σε κανένα κατάστημα
            {0 < searchErrors.length
              ? ' — δες τα σφάλματα πιο πάνω.'
              : '. Δοκίμασε διαφορετικό τίτλο ή σκάναρε το barcode.'}
          </p>
        ) : (
          <CandidateGroups
            candidates={candidates}
            selectedSkus={selectedSkus}
            onSelect={handleSelect}
          />
        ))}

      {errorBlock}

      <button
        type="submit"
        className="rounded-xl border-2 border-ink bg-ink px-3.5 py-2.5 font-mono text-xs font-bold tracking-wide text-white hover:bg-black disabled:opacity-50"
        disabled={isSubmitting}
      >
        {submitLabel}
      </button>

      <BarcodeScannerModal
        isOpen={isScannerOpen}
        onDetected={handleEanDetected}
        onClose={() => setIsScannerOpen(false)}
      />
    </form>
  );
};

const countCandidates = (candidates: Map<RetailerId, RankedResult[]>): number => {
  let total = 0;

  for (const list of candidates.values()) {
    total += list.length;
  }

  return total;
};

const computeSuggestions = (
  brand: string,
  title: string,
  existingProducts: readonly ProductWithListings[],
): MatchSuggestion[] => {
  if (title.length < 4) {
    return [];
  }

  const candidates = existingProducts.map((product) => {
    return {
      id: product.id,
      title: product.title,
      brand: product.brand,
      sizeValue: product.sizeValue,
      sizeUnit: product.sizeUnit,
    };
  });

  // Brand folded in so the brand gate sees it even when the typed title
  // omits it — the same symmetry rankResults maintains.
  return suggestMatches(`${brand} ${title}`.trim(), candidates).filter(
    (suggestion) => SUGGESTION_THRESHOLD <= suggestion.score,
  );
};

const renderSuggestions = (
  suggestions: readonly MatchSuggestion[],
  existingProducts: readonly ProductWithListings[],
) => {
  if (0 === suggestions.length) {
    return null;
  }

  const productsById = new Map(existingProducts.map((product) => [product.id, product]));

  return (
    <div className="rounded-xl border-2 border-ink bg-accent/25 p-3 text-sm">
      <p className="mb-1 font-mono text-[11px] font-bold tracking-wide text-ink">
        ΠΙΘΑΝΑ ΔΙΠΛΟΤΥΠΑ ΠΟΥ ΗΔΗ ΠΑΡΑΚΟΛΟΥΘΕΙΣ:
      </p>
      <ul className="flex flex-col gap-1">
        {suggestions.map((suggestion) => {
          const product = productsById.get(suggestion.candidateId);

          if (undefined === product) {
            return null;
          }

          return (
            <li key={suggestion.candidateId} className="text-soft">
              {product.title}{' '}
              <span className="font-mono text-xs text-muted">
                ({Math.round(suggestion.score * 100)}% αντιστοιχία)
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

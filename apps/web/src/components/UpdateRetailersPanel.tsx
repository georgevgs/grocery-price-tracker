import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ProductWithListings, RetailerId } from '@grocery/core/types';
import { extractEanFromInput } from '@grocery/core/normalize';
import {
  addListings,
  resolveProductUrl,
  triggerScrape,
  updateProductEan,
} from '../api/client';
import { BarcodeScannerModal } from './BarcodeScannerModal';
import { CandidateGroups } from './RetailerCandidates';
import {
  collectConfirmedEan,
  collectSelectedListings,
  RETAILER_LABELS,
  searchAndRank,
  SUGGESTION_THRESHOLD,
  type RankedResult,
} from '../lib/matching';

interface UpdateRetailersPanelProps {
  product: ProductWithListings;
}

const MAX_CANDIDATES = 5;

/**
 * Links an existing product to supermarkets it isn't tracked at yet.
 *
 * Three paths, sharpest first:
 * - a known EAN (typed, scanned, or a pasted galaxias.shop link) pins
 *   the exact product at barcode-capable chains;
 * - the multi-pass search (full query → brand-only retry → EAN
 *   discovered from a ≥60% match) covers the rest;
 * - a pasted product-page URL bypasses search entirely — needed when a
 *   chain's search index doesn't list a product its site carries.
 */
export const UpdateRetailersPanel = ({ product }: UpdateRetailersPanelProps) => {
  const queryClient = useQueryClient();
  const [ean, setEan] = useState(product.ean ?? '');
  const [listingUrl, setListingUrl] = useState('');
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [candidates, setCandidates] = useState<Map<RetailerId, RankedResult[]> | null>(null);
  const [selectedSkus, setSelectedSkus] = useState<Map<RetailerId, string | null>>(new Map());
  const [isSearching, setIsSearching] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isResolvingUrl, setIsResolvingUrl] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const tracked = new Set(product.listings.map((listing) => listing.retailer));
  const missing = [...RETAILER_LABELS.keys()].filter((id) => false === tracked.has(id));

  if (0 === missing.length) {
    return (
      <p className="font-mono text-[11px] tracking-wide text-muted">
        ΠΑΡΑΚΟΛΟΥΘΕΙΤΑΙ ΣΕ ΟΛΑ ΤΑ ΥΠΟΣΤΗΡΙΖΟΜΕΝΑ ΣΟΥΠΕΡ ΜΑΡΚΕΤ.
      </p>
    );
  }

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['products'] }),
      queryClient.invalidateQueries({ queryKey: ['history', product.id] }),
    ]);
  };

  const handleSearch = async () => {
    setIsSearching(true);
    setErrors([]);
    setNotice(null);

    try {
      // The field accepts a bare barcode or a galaxias.shop product link
      // (its SKU segment IS the EAN).
      const searchEan = extractEanFromInput(ean);

      if (0 < ean.trim().length && null === searchEan) {
        setErrors(['Δεν βρέθηκε EAN — επικόλλησε τα ψηφία του barcode ή έναν σύνδεσμο προϊόντος galaxias.shop.']);
        return;
      }

      if (null !== searchEan && ean.trim() !== searchEan) {
        setEan(searchEan);
      }

      // Persist a newly entered/scanned barcode so future searches and
      // the add-form duplicate check know it too.
      if (searchEan !== (product.ean ?? null)) {
        await updateProductEan(product.id, searchEan);
        await queryClient.invalidateQueries({ queryKey: ['products'] });
      }

      const { ranked, errors: searchErrors, discoveredEan } = await searchAndRank(
        product.title,
        product.brand,
        searchEan,
        missing,
      );

      const sliced = new Map<RetailerId, RankedResult[]>();
      const preselected = new Map<RetailerId, string | null>();

      for (const [retailer, list] of ranked) {
        const top = list.slice(0, MAX_CANDIDATES);
        sliced.set(retailer, top);

        const best = top[0];
        const autoPick =
          undefined !== best && null !== best.score && SUGGESTION_THRESHOLD <= best.score
            ? best.result.sku
            : null;
        preselected.set(retailer, autoPick);
      }

      // Surface an EAN discovered from a strong match — saving a pick
      // that carries it will persist it (collectConfirmedEan).
      if (null !== discoveredEan && 0 === ean.trim().length) {
        setEan(discoveredEan);
      }

      setCandidates(sliced);
      setSelectedSkus(preselected);
      setErrors(searchErrors);
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Η αναζήτηση απέτυχε.']);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSave = async () => {
    const listings = collectSelectedListings(candidates, selectedSkus);

    if (0 === listings.length) {
      return;
    }

    setIsSaving(true);
    setErrors([]);

    try {
      const { added } = await addListings(product.id, listings);

      // Adopt the barcode from a user-confirmed pick: chains like
      // Galaxias and Kritikos expose it, and once stored every future
      // search resolves the product exactly instead of fuzzily.
      if (null === (product.ean ?? null) && null === extractEanFromInput(ean)) {
        const confirmed = collectConfirmedEan(candidates, selectedSkus);

        if (null !== confirmed) {
          await updateProductEan(product.id, confirmed).catch(() => {});
          setEan(confirmed);
        }
      }

      // Record today's prices for the freshly linked listings right away.
      await triggerScrape().catch(() => {});
      await refresh();

      setCandidates(null);
      setSelectedSkus(new Map());
      setNotice(`Συνδέθηκε ${added} ${1 === added ? 'νέο κατάστημα' : 'νέα καταστήματα'}.`);
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Αποτυχία αποθήκευσης.']);
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddByUrl = async () => {
    const url = listingUrl.trim();

    if (0 === url.length) {
      return;
    }

    setIsResolvingUrl(true);
    setErrors([]);
    setNotice(null);

    try {
      const resolved = await resolveProductUrl(url, `${product.brand} ${product.title}`.trim());

      if (tracked.has(resolved.retailer)) {
        setErrors([`Ήδη παρακολουθείται στο ${RETAILER_LABELS.get(resolved.retailer) ?? resolved.retailer}.`]);
        return;
      }

      await addListings(product.id, [
        { retailer: resolved.retailer, retailerSku: resolved.sku, url: resolved.url },
      ]);
      await triggerScrape().catch(() => {});
      await refresh();

      setListingUrl('');
      setNotice(
        `Συνδέθηκε ${RETAILER_LABELS.get(resolved.retailer) ?? resolved.retailer}: ${resolved.name ?? resolved.sku}`,
      );
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Δεν ήταν δυνατή η επίλυση του URL.']);
    } finally {
      setIsResolvingUrl(false);
    }
  };

  const handleSelect = (retailer: RetailerId, sku: string | null) => {
    setSelectedSkus((prev) => new Map(prev).set(retailer, sku));
  };

  const handleEanDetected = (detected: string) => {
    setEan(detected);
    setIsScannerOpen(false);
  };

  const selectedCount = collectSelectedListings(candidates, selectedSkus).length;

  let searchLabel = `Βρες σε ${missing.length} ακόμα ${1 === missing.length ? 'κατάστημα' : 'καταστήματα'}`;

  if (true === isSearching) {
    searchLabel = 'Αναζήτηση… (οι επαναλήψεις αργούν)';
  }

  let saveLabel = `Σύνδεσε ${selectedCount} ${1 === selectedCount ? 'κατάστημα' : 'καταστήματα'} & ανανέωση`;

  if (true === isSaving) {
    saveLabel = 'Αποθήκευση & λήψη τιμών…';
  }

  return (
    <div className="flex flex-col gap-3">
      {/* EAN + ΣΚΑΝ share the top row; the long search button drops to its
          own full-width line on mobile and rejoins inline from `sm` up. */}
      <div className="flex flex-wrap gap-2">
        <input
          className="min-w-[55%] flex-1 rounded-xl border-2 border-ink bg-white px-3.5 py-2 text-sm outline-none placeholder:text-muted"
          placeholder="EAN (εντοπίζει το ακριβές προϊόν — σκάναρέ το)"
          value={ean}
          onChange={(event) => setEan(event.target.value)}
        />
        <button
          type="button"
          className="rounded-xl border-2 border-ink bg-white px-3 py-2 font-mono text-xs font-bold tracking-wide hover:bg-linen"
          onClick={() => setIsScannerOpen(true)}
        >
          ΣΚΑΝ
        </button>
        <button
          type="button"
          className="w-full rounded-xl border-2 border-ink bg-white px-3 py-2 font-mono text-xs font-bold tracking-wide hover:bg-accent disabled:opacity-50 sm:w-auto"
          disabled={isSearching}
          onClick={handleSearch}
        >
          {searchLabel}
        </button>
      </div>

      <div className="flex gap-2">
        <input
          className="flex-1 rounded-xl border-2 border-ink bg-white px-3.5 py-2 text-sm outline-none placeholder:text-muted"
          placeholder="Ή επικόλλησε το URL σελίδας προϊόντος (όταν η αναζήτηση δεν το βρίσκει)"
          value={listingUrl}
          onChange={(event) => setListingUrl(event.target.value)}
        />
        <button
          type="button"
          className="rounded-xl border-2 border-ink bg-white px-3 py-2 font-mono text-xs font-bold tracking-wide hover:bg-linen disabled:opacity-50"
          disabled={isResolvingUrl || 0 === listingUrl.trim().length}
          onClick={handleAddByUrl}
        >
          {isResolvingUrl ? 'ΕΠΙΛΥΣΗ…' : 'ΠΡΟΣΘΗΚΗ ΜΕ URL'}
        </button>
      </div>

      {errors.map((error) => (
        <p key={error} className="text-sm text-warn">
          {error}
        </p>
      ))}

      {null !== notice && <p className="text-sm font-medium text-ok">{notice}</p>}

      {null !== candidates && (
        <>
          <CandidateGroups
            candidates={candidates}
            selectedSkus={selectedSkus}
            onSelect={handleSelect}
          />
          <button
            type="button"
            className="self-start rounded-xl border-2 border-ink bg-ink px-3.5 py-2 font-mono text-xs font-bold tracking-wide text-white hover:bg-black disabled:opacity-50"
            disabled={isSaving || 0 === selectedCount}
            onClick={handleSave}
          >
            {saveLabel}
          </button>
        </>
      )}

      <BarcodeScannerModal
        isOpen={isScannerOpen}
        onDetected={handleEanDetected}
        onClose={() => setIsScannerOpen(false)}
      />
    </div>
  );
};

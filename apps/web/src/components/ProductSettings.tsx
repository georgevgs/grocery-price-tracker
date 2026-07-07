import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ProductWithListings } from '@grocery/core/types';
import { deleteListing, deleteProduct, updateProduct } from '../api/client';
import { RETAILER_LABELS } from '../lib/matching';
import { ErrorNotice } from './ErrorNotice';

interface ProductSettingsProps {
  product: ProductWithListings;
  /** Called after the product itself is deleted — the caller navigates away. */
  onDeleted: () => void;
}

// The two-tap delete reverts to its safe label if the second tap doesn't come.
const CONFIRM_WINDOW_MS = 4000;

/**
 * The recover-from-a-mistake panel: rename a product, unlink a store that was
 * matched wrong, or delete the product outright. Collapsed by default so the
 * product page stays read-focused; destructive actions sit behind the toggle
 * and (for delete) a second confirming tap.
 */
export const ProductSettings = ({ product, onDeleted }: ProductSettingsProps) => {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);

  const [title, setTitle] = useState(product.title);
  const [brand, setBrand] = useState(product.brand);
  const [sizeValue, setSizeValue] = useState(
    null === product.sizeValue ? '' : String(product.sizeValue),
  );
  const [sizeUnit, setSizeUnit] = useState(product.sizeUnit ?? '');

  const [isSaving, setIsSaving] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (null !== confirmTimer.current) {
        clearTimeout(confirmTimer.current);
      }
    };
  }, []);

  // Unlinking a store removes its price_history too, so the product's
  // cheapest-per-day chart changes — refresh both.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['products'] }),
      queryClient.invalidateQueries({ queryKey: ['history', product.id] }),
    ]);

  const dirty =
    title.trim() !== product.title ||
    brand.trim() !== product.brand ||
    sizeValue.trim() !== (null === product.sizeValue ? '' : String(product.sizeValue)) ||
    sizeUnit.trim() !== (product.sizeUnit ?? '');

  const handleSave = async () => {
    setErrors([]);
    setNotice(null);

    if (0 === title.trim().length) {
      setErrors(['Ο τίτλος δεν μπορεί να είναι κενός.']);
      return;
    }

    if (0 === brand.trim().length) {
      setErrors(['Η μάρκα δεν μπορεί να είναι κενή.']);
      return;
    }

    const rawSize = sizeValue.trim();
    let parsedSize: number | null = null;

    if (0 < rawSize.length) {
      const asNumber = Number(rawSize.replace(',', '.'));

      if (false === Number.isFinite(asNumber)) {
        setErrors(['Το μέγεθος πρέπει να είναι αριθμός (π.χ. 1, 0.75, 500).']);
        return;
      }

      parsedSize = asNumber;
    }

    setIsSaving(true);

    try {
      await updateProduct(product.id, {
        title: title.trim(),
        brand: brand.trim(),
        sizeValue: parsedSize,
        sizeUnit: 0 < sizeUnit.trim().length ? sizeUnit.trim() : null,
      });
      await refresh();
      setNotice('Αποθηκεύτηκε.');
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Αποτυχία αποθήκευσης.']);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveStore = async (listingId: number) => {
    setErrors([]);
    setNotice(null);
    setRemovingId(listingId);

    try {
      await deleteListing(product.id, listingId);
      await refresh();
      setNotice('Το κατάστημα αφαιρέθηκε.');
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Αποτυχία αφαίρεσης καταστήματος.']);
    } finally {
      setRemovingId(null);
    }
  };

  const handleDeleteClick = async () => {
    if (false === confirmDelete) {
      // Arm the confirm and disarm it shortly after, so a stray tap can't
      // later count as the second one.
      setConfirmDelete(true);
      setErrors([]);
      setNotice(null);

      if (null !== confirmTimer.current) {
        clearTimeout(confirmTimer.current);
      }

      confirmTimer.current = setTimeout(() => setConfirmDelete(false), CONFIRM_WINDOW_MS);
      return;
    }

    if (null !== confirmTimer.current) {
      clearTimeout(confirmTimer.current);
    }

    setConfirmDelete(false);
    setIsDeleting(true);
    setErrors([]);

    try {
      await deleteProduct(product.id);
      await refresh();
      onDeleted();
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Αποτυχία διαγραφής.']);
      setIsDeleting(false);
    }
  };

  const stores = product.listings;

  return (
    <div className="overflow-hidden rounded-2xl border-2 border-ink bg-white">
      <button
        type="button"
        onClick={() => setIsOpen((open) => false === open)}
        className="flex w-full items-center justify-between px-[18px] py-3.5 font-mono text-xs tracking-wide hover:bg-linen"
        aria-expanded={isOpen}
      >
        <span>✏ ΕΠΕΞΕΡΓΑΣΙΑ ΠΡΟΪΟΝΤΟΣ</span>
        <span aria-hidden className="text-muted">
          {isOpen ? '▲' : '▼'}
        </span>
      </button>

      {isOpen && (
        <div className="flex flex-col gap-4 border-t-[1.5px] border-ink px-[18px] py-4">
          {/* Rename */}
          <div className="flex flex-col gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] tracking-wide text-muted">ΤΙΤΛΟΣ</span>
              <input
                className="rounded-xl border-2 border-ink bg-white px-3.5 py-2 text-sm outline-none placeholder:text-muted"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] tracking-wide text-muted">ΜΑΡΚΑ</span>
              <input
                className="rounded-xl border-2 border-ink bg-white px-3.5 py-2 text-sm outline-none placeholder:text-muted"
                value={brand}
                onChange={(event) => setBrand(event.target.value)}
              />
            </label>
            <div className="flex items-end gap-2">
              <label className="flex flex-1 flex-col gap-1">
                <span className="font-mono text-[11px] tracking-wide text-muted">ΜΕΓΕΘΟΣ</span>
                <input
                  inputMode="decimal"
                  className="w-full rounded-xl border-2 border-ink bg-white px-3.5 py-2 text-sm outline-none placeholder:text-muted"
                  placeholder="π.χ. 1"
                  value={sizeValue}
                  onChange={(event) => setSizeValue(event.target.value)}
                />
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="font-mono text-[11px] tracking-wide text-muted">ΜΟΝΑΔΑ</span>
                <input
                  className="w-full rounded-xl border-2 border-ink bg-white px-3.5 py-2 text-sm outline-none placeholder:text-muted"
                  placeholder="π.χ. L, ml, g"
                  value={sizeUnit}
                  onChange={(event) => setSizeUnit(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="rounded-xl border-2 border-ink bg-accent px-3.5 py-2 font-mono text-xs font-bold tracking-wide hover:bg-ink hover:text-white disabled:opacity-50"
                disabled={isSaving || false === dirty}
                onClick={handleSave}
              >
                {isSaving ? 'ΑΠΟΘΗΚΕΥΣΗ…' : 'ΑΠΟΘΗΚΕΥΣΗ'}
              </button>
            </div>
          </div>

          {/* Manage stores */}
          {0 < stores.length && (
            <div className="flex flex-col gap-1.5 border-t-[1.5px] border-rowline pt-4">
              <span className="font-mono text-[11px] tracking-wide text-muted">ΚΑΤΑΣΤΗΜΑΤΑ</span>
              {stores.map((listing) => (
                <div
                  key={listing.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-rowline px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm font-medium">
                    {RETAILER_LABELS.get(listing.retailer) ?? listing.retailer}
                  </span>
                  <button
                    type="button"
                    className="flex-none rounded-lg border-2 border-danger px-2.5 py-1 font-mono text-[11px] font-bold tracking-wide text-danger hover:bg-danger hover:text-white disabled:opacity-50"
                    disabled={null !== removingId}
                    onClick={() => handleRemoveStore(listing.id)}
                  >
                    {removingId === listing.id ? 'ΑΦΑΙΡΕΣΗ…' : 'ΑΦΑΙΡΕΣΗ'}
                  </button>
                </div>
              ))}
            </div>
          )}

          <ErrorNotice messages={errors} />
          {null !== notice && (
            <p className="text-sm font-medium text-ok [overflow-wrap:anywhere]">{notice}</p>
          )}

          {/* Danger zone */}
          <div className="border-t-[1.5px] border-rowline pt-4">
            <button
              type="button"
              className={`w-full rounded-xl border-2 px-3.5 py-2.5 font-mono text-xs font-bold tracking-wide disabled:opacity-50 ${
                confirmDelete
                  ? 'border-danger bg-danger text-white'
                  : 'border-danger text-danger hover:bg-danger hover:text-white'
              }`}
              disabled={isDeleting}
              onClick={handleDeleteClick}
            >
              {deleteLabel(isDeleting, confirmDelete)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const deleteLabel = (isDeleting: boolean, confirmDelete: boolean): string => {
  if (isDeleting) {
    return 'ΔΙΑΓΡΑΦΗ…';
  }

  if (confirmDelete) {
    return '⚠ ΣΙΓΟΥΡΑ; ΠΑΤΗΣΕ ΞΑΝΑ';
  }

  return 'ΔΙΑΓΡΑΦΗ ΠΡΟΪΟΝΤΟΣ';
};

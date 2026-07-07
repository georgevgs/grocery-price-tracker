import type {
  ListingWithLatestPrice,
  ProductWithListings,
} from '@grocery/core/types';
import { RETAILER_LABELS } from '../lib/matching';
import { PriceHistoryChart } from '../components/PriceHistoryChart';
import { ProductImage } from '../components/ProductImage';
import { ProductSettings } from '../components/ProductSettings';
import { UpdateRetailersPanel } from '../components/UpdateRetailersPanel';
import { bestListing, formatEuro, priceOf, sizeLabel } from '../lib/format';

interface ProductViewProps {
  product: ProductWithListings;
  onGoResults: () => void;
  onDeleted: () => void;
}

export const ProductView = ({ product, onGoResults, onDeleted }: ProductViewProps) => {
  const best = bestListing(product.listings);
  const bestPrice = null !== best ? priceOf(best) : null;
  const size = sizeLabel(product);
  const rows = sortedRows(product.listings);
  const bestId = null !== best ? best.id : null;

  const metaLine = [product.brand, size, product.ean].filter(
    (part): part is string => null !== part && undefined !== part && 0 < part.length,
  );

  return (
    <section className="py-8">
      <div className="mb-5 font-mono text-[11px] tracking-wide text-muted">
        <button type="button" onClick={onGoResults} className="text-muted">
          ← ΑΠΟΤΕΛΕΣΜΑΤΑ
        </button>{' '}
        / ΠΡΟΪΟΝ
      </div>

      <div className="grid grid-cols-1 items-start gap-7 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <ProductImage
            src={product.imageUrl}
            alt={product.title}
            className="aspect-square w-full rounded-2xl border-2 border-ink bg-white object-contain p-3.5"
            fallback={
              <div className="hatch flex aspect-square items-end rounded-2xl border-2 border-ink p-3.5">
                <span className="rounded border border-hairline bg-white px-1.5 py-1 font-mono text-[10px] tracking-wide text-faint">
                  {shotTag(product)}
                </span>
              </div>
            }
          />
          <div>
            <div className="font-mono text-xs uppercase tracking-wide text-muted">
              {metaLine.length > 0 ? metaLine.join(' · ') : 'ΠΡΟΪΟΝ'}
            </div>
            <h1 className="m-0 mt-2 text-[clamp(28px,4vw,40px)] font-bold leading-[1.02] tracking-[-0.02em]">
              {product.title}
            </h1>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <CheapestPanel best={best} bestPrice={bestPrice} />

          <PriceHistoryChart productId={product.id} />

          <div className="overflow-hidden rounded-2xl border-2 border-ink bg-white">
            <div className="border-b-[1.5px] border-ink px-[18px] py-3.5 font-mono text-xs tracking-wide">
              ΟΛΕΣ ΟΙ ΤΙΜΕΣ
            </div>
            {0 === rows.length ? (
              <p className="px-[18px] py-4 text-sm text-muted">Δεν υπάρχουν καταστήματα ακόμα.</p>
            ) : (
              rows.map((listing) => (
                <PriceRow
                  key={listing.id}
                  listing={listing}
                  isCheapest={listing.id === bestId}
                />
              ))
            )}
          </div>

          <div className="rounded-2xl border-2 border-ink bg-white p-5">
            <div className="mb-1 font-mono text-xs tracking-wide">ΠΡΟΣΘΕΣΕ ΚΑΤΑΣΤΗΜΑΤΑ</div>
            <UpdateRetailersPanel product={product} />
          </div>

          <ProductSettings product={product} onDeleted={onDeleted} />
        </div>
      </div>
    </section>
  );
};

interface CheapestPanelProps {
  best: ListingWithLatestPrice | null;
  bestPrice: number | null;
}

const CheapestPanel = ({ best, bestPrice }: CheapestPanelProps) => {
  if (null === best || null === bestPrice) {
    return (
      <div className="rounded-2xl border-2 border-ink bg-ink px-6 py-6 text-white shadow-hard-accent">
        <div className="font-mono text-[11px] tracking-[0.15em] text-[#b9b9b0]">
          ΦΘΗΝΟΤΕΡΑ ΤΩΡΑ
        </div>
        <div className="mt-2 font-mono text-2xl font-bold">χωρίς τιμή ακόμα</div>
        <div className="mt-2 text-sm text-[#b9b9b0]">
          Κάνε ανανέωση ή πρόσθεσε καταστήματα για να συγκεντρωθούν τιμές.
        </div>
      </div>
    );
  }

  const retailer = RETAILER_LABELS.get(best.retailer) ?? best.retailer;

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border-2 border-ink bg-ink px-6 py-[22px] text-white shadow-hard-accent">
      <div>
        <div className="font-mono text-[11px] tracking-[0.15em] text-[#b9b9b0]">
          ΦΘΗΝΟΤΕΡΑ ΤΩΡΑ
        </div>
        <div className="mt-1.5 font-mono text-[52px] font-bold leading-none tracking-[-2px]">
          {formatEuro(bestPrice)}
        </div>
        <div className="mt-2 text-sm">
          στο <b>{retailer}</b>
        </div>
      </div>
      <a
        href={best.url}
        target="_blank"
        rel="noreferrer"
        className="max-w-[160px] rounded-xl border-2 border-accent px-4 py-3 text-left font-mono text-xs font-bold leading-tight tracking-wide text-white transition-colors hover:bg-accent hover:text-ink"
      >
        ΑΝΟΙΓΜΑ {retailer.toUpperCase()} →
      </a>
    </div>
  );
};

interface PriceRowProps {
  listing: ListingWithLatestPrice;
  isCheapest: boolean;
}

const PriceRow = ({ listing, isCheapest }: PriceRowProps) => {
  const price = priceOf(listing);
  const retailer = RETAILER_LABELS.get(listing.retailer) ?? listing.retailer;

  return (
    <a
      href={listing.url}
      target="_blank"
      rel="noreferrer"
      className={`flex items-center justify-between border-b border-rowline px-[18px] py-3.5 last:border-b-0 ${
        isCheapest ? 'bg-accent' : 'bg-white'
      }`}
    >
      <span className="flex items-center gap-2.5 text-[15px] font-medium">
        <span
          className={`h-[9px] w-[9px] rounded-full border-[1.5px] border-ink ${
            isCheapest ? 'bg-accent' : 'bg-white'
          }`}
        />
        {retailer}
      </span>
      <span className="font-mono text-[18px] font-bold">
        {null !== price ? formatEuro(price) : '—'}
      </span>
    </a>
  );
};

const sortedRows = (
  listings: readonly ListingWithLatestPrice[],
): ListingWithLatestPrice[] => {
  return listings.slice().sort((a, b) => {
    const priceA = priceOf(a) ?? Number.POSITIVE_INFINITY;
    const priceB = priceOf(b) ?? Number.POSITIVE_INFINITY;

    return priceA - priceB;
  });
};

const shotTag = (product: { brand: string; title: string }): string => {
  const source = 0 < product.brand.trim().length ? product.brand : product.title;

  return source.toUpperCase().slice(0, 18);
};

import type {
  ListingWithLatestPrice,
  ProductWithListings,
  RetailerId,
} from '@grocery/core/types';
import { RETAILER_LABELS } from '../lib/matching';
import { ProductImage } from '../components/ProductImage';
import {
  bestListing,
  formatEuro,
  matchesQuery,
  priceRange,
  productMark,
  sizeLabel,
  type PriceRange,
  type ResultSort,
} from '../lib/format';

interface ResultsViewProps {
  products: ProductWithListings[];
  query: string;
  sort: ResultSort;
  onSortChange: (sort: ResultSort) => void;
  catalogRetailers: RetailerId[];
  selectedRetailers: Set<RetailerId>;
  onToggleRetailer: (retailer: RetailerId) => void;
  onSelectProduct: (productId: number) => void;
  onGoHome: () => void;
}

interface ResultRow {
  product: ProductWithListings;
  listings: ListingWithLatestPrice[];
  best: ListingWithLatestPrice | null;
  range: PriceRange | null;
}

const SORTS: ReadonlyArray<{ key: ResultSort; label: string }> = [
  { key: 'price', label: 'ΦΘΗΝΟΤΕΡΑ' },
  { key: 'saving', label: 'ΜΕΓΑΛΥΤΕΡΟ ΟΦΕΛΟΣ' },
  { key: 'name', label: 'Α–Ω' },
];

export const ResultsView = ({
  products,
  query,
  sort,
  onSortChange,
  catalogRetailers,
  selectedRetailers,
  onToggleRetailer,
  onSelectProduct,
  onGoHome,
}: ResultsViewProps) => {
  const rows = buildRows(products, query, selectedRetailers, sort);
  const cheapestId = cheapestProductId(rows);
  const maxSaving = biggestSaving(rows);

  return (
    <section className="py-8">
      <div className="mb-2 font-mono text-[11px] tracking-wide text-muted">
        <button type="button" onClick={onGoHome} className="text-muted">
          ΑΡΧΙΚΗ
        </button>{' '}
        / ΑΠΟΤΕΛΕΣΜΑΤΑ
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <h1 className="m-0 text-[clamp(30px,5vw,50px)] font-bold leading-none tracking-[-0.02em]">
            {0 < query.trim().length ? query : 'Όλα τα προϊόντα'}
          </h1>
          <p className="mb-0 mt-3 font-mono text-[13px] text-soft">
            {rows.length} {1 === rows.length ? 'αποτέλεσμα' : 'αποτελέσματα'}
            {null !== maxSaving && (
              <>
                {' '}
                · γλίτωσε έως{' '}
                <span className="rounded-[3px] bg-accent px-1.5 py-px font-bold shadow-[0_0_0_1.5px_#0e0e0c]">
                  {formatEuro(maxSaving)}
                </span>{' '}
                σε ένα προϊόν
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SORTS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => onSortChange(option.key)}
              className={`rounded-full border-[1.5px] border-ink px-3.5 py-2 font-mono text-[11px] font-bold tracking-wide ${
                sort === option.key ? 'bg-accent' : 'bg-white'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Mobile store filter — a horizontal chip row instead of the desktop
          sidebar, so it doesn't push results down the page. */}
      {0 < catalogRetailers.length && (
        <div className="-mx-4 mt-4 flex gap-2 overflow-x-auto px-4 pb-1 md:hidden">
          {catalogRetailers.map((retailer) => {
            const checked = selectedRetailers.has(retailer);

            return (
              <button
                key={retailer}
                type="button"
                onClick={() => onToggleRetailer(retailer)}
                aria-pressed={checked}
                className={`flex-none rounded-full border-2 border-ink px-3.5 py-1.5 font-mono text-[11px] font-bold tracking-wide ${
                  checked ? 'bg-accent' : 'bg-white'
                }`}
              >
                {RETAILER_LABELS.get(retailer) ?? retailer}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 items-start gap-6 md:grid-cols-[230px_1fr]">
        <aside className="top-[86px] hidden flex-col gap-4 md:sticky md:flex">
          <div className="rounded-2xl border-2 border-ink bg-white p-4">
            <div className="mb-3 font-mono text-[11px] tracking-wide">ΚΑΤΑΣΤΗΜΑΤΑ</div>
            {0 === catalogRetailers.length ? (
              <p className="text-sm text-muted">Δεν παρακολουθείς κανένα κατάστημα ακόμα.</p>
            ) : (
              catalogRetailers.map((retailer) => {
                const checked = selectedRetailers.has(retailer);

                return (
                  <label
                    key={retailer}
                    className="flex cursor-pointer items-center gap-2.5 py-1.5 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={() => onToggleRetailer(retailer)}
                    />
                    <span
                      className={`flex h-[17px] w-[17px] flex-none items-center justify-center rounded-md border-[1.5px] border-ink ${
                        checked ? 'bg-accent' : 'bg-white'
                      }`}
                    >
                      {checked && <span className="h-[7px] w-[7px] rounded-sm bg-ink" />}
                    </span>
                    {RETAILER_LABELS.get(retailer) ?? retailer}
                  </label>
                );
              })
            )}
          </div>
        </aside>

        <div className="flex flex-col gap-3">
          {0 === rows.length ? (
            <div className="rounded-2xl border-2 border-dashed border-ink bg-white p-8 text-center font-mono text-sm text-muted">
              Κανένα προϊόν δεν ταιριάζει με την αναζήτηση και τα φίλτρα καταστημάτων.
            </div>
          ) : (
            rows.map((row) => (
              <ResultRowCard
                key={row.product.id}
                row={row}
                isCheapest={row.product.id === cheapestId}
                onSelect={() => onSelectProduct(row.product.id)}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
};

interface ResultRowCardProps {
  row: ResultRow;
  isCheapest: boolean;
  onSelect: () => void;
}

const ResultRowCard = ({ row, isCheapest, onSelect }: ResultRowCardProps) => {
  const { product, best, range } = row;
  const size = sizeLabel(product);

  let priceLabel = '—';

  if (null !== best && null !== best.latestPrice && null !== best.latestPrice.pricePiece) {
    priceLabel = formatEuro(best.latestPrice.pricePiece);
  }

  const bestRetailer =
    null !== best ? (RETAILER_LABELS.get(best.retailer) ?? best.retailer) : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative grid grid-cols-[48px_1fr_auto] items-center gap-3 rounded-2xl border-2 border-ink bg-white px-3.5 py-4 text-left transition-transform hover:translate-x-[3px] sm:grid-cols-[56px_1fr_auto] sm:gap-4 sm:px-[18px] ${
        isCheapest ? 'shadow-pop' : ''
      }`}
    >
      {isCheapest && (
        <span className="absolute -top-[11px] left-4 rounded-md border-2 border-ink bg-accent px-2.5 py-0.5 font-mono text-[10px] font-bold tracking-wide">
          ΦΘΗΝΟΤΕΡΟ
        </span>
      )}
      <ProductImage
        src={product.imageUrl}
        alt={product.title}
        className="h-12 w-12 flex-none rounded-xl border-2 border-ink bg-white object-contain p-1 sm:h-14 sm:w-14"
        fallback={
          <span className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-ink bg-linen font-mono text-xl font-bold sm:h-14 sm:w-14">
            {productMark(product)}
          </span>
        }
      />
      <span className="min-w-0">
        <span className="block text-[17px] font-semibold">{product.title}</span>
        <span className="mt-0.5 block text-[13px] text-muted">
          {product.brand}
          {null !== bestRetailer ? ` · φθηνότερα στο ${bestRetailer}` : ''}
        </span>
        <span className="mt-1.5 block font-mono text-[11px] text-soft">
          {null !== size ? `${size} · ` : ''}
          {product.listings.length} {1 === product.listings.length ? 'κατάστημα' : 'καταστήματα'}
          {null !== range && range.max > range.min
            ? ` · έως ${formatEuro(range.max)}`
            : ''}
        </span>
      </span>
      <span className="flex flex-col items-end gap-1.5 text-right">
        <span className="font-mono text-[22px] font-bold tracking-[-1px] sm:text-[26px]">
          {priceLabel}
        </span>
        <span className="rounded-full border-[1.5px] border-ink px-2.5 py-1 font-mono text-[11px] tracking-wide">
          ΔΕΣ →
        </span>
      </span>
    </button>
  );
};

const buildRows = (
  products: ProductWithListings[],
  query: string,
  selectedRetailers: Set<RetailerId>,
  sort: ResultSort,
): ResultRow[] => {
  const rows: ResultRow[] = [];

  for (const product of products) {
    if (false === matchesQuery(product, query)) {
      continue;
    }

    const listings = product.listings.filter((listing) =>
      selectedRetailers.has(listing.retailer),
    );

    if (0 === listings.length) {
      continue;
    }

    rows.push({
      product,
      listings,
      best: bestListing(listings),
      range: priceRange(listings),
    });
  }

  return sortRows(rows, sort);
};

const sortRows = (rows: ResultRow[], sort: ResultSort): ResultRow[] => {
  const withPrice = (row: ResultRow): number => row.range?.min ?? Number.POSITIVE_INFINITY;
  const saving = (row: ResultRow): number =>
    null !== row.range ? row.range.max - row.range.min : -1;

  return rows.slice().sort((a, b) => {
    if ('name' === sort) {
      return a.product.title.localeCompare(b.product.title);
    }

    if ('saving' === sort) {
      return saving(b) - saving(a);
    }

    return withPrice(a) - withPrice(b);
  });
};

const cheapestProductId = (rows: ResultRow[]): number | null => {
  let id: number | null = null;
  let min = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    if (null !== row.range && row.range.min < min) {
      min = row.range.min;
      id = row.product.id;
    }
  }

  return id;
};

const biggestSaving = (rows: ResultRow[]): number | null => {
  let max = 0;

  for (const row of rows) {
    if (null !== row.range) {
      const spread = row.range.max - row.range.min;

      if (spread > max) {
        max = spread;
      }
    }
  }

  return 0 < max ? max : null;
};

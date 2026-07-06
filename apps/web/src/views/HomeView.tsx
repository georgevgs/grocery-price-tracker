import type { KeyboardEvent } from 'react';
import type { ProductWithListings } from '@grocery/core/types';
import { bestListing, formatEuro } from '../lib/format';
import { ProductImage } from '../components/ProductImage';

interface HomeViewProps {
  products: ProductWithListings[];
  query: string;
  onQueryChange: (query: string) => void;
  onSubmitSearch: () => void;
  onSearchTerm: (term: string) => void;
  onSelectProduct: (productId: number) => void;
  onAdd: () => void;
  isLoading: boolean;
  hasError: boolean;
}

const MAX_TRENDING = 6;

export const HomeView = ({
  products,
  query,
  onQueryChange,
  onSubmitSearch,
  onSearchTerm,
  onSelectProduct,
  onAdd,
  isLoading,
  hasError,
}: HomeViewProps) => {
  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if ('Enter' === event.key) {
      onSubmitSearch();
    }
  };

  const retailerCount = countRetailers(products);
  const trending = products.slice(0, MAX_TRENDING);

  return (
    <section className="py-8 md:py-12">
      <div className="mb-6 flex items-center gap-3 font-mono text-xs tracking-[0.15em] text-muted">
        <span className="inline-block h-0.5 w-8 bg-ink" />
        {statusLine(products.length, retailerCount, isLoading, hasError)}
      </div>

      <h1 className="m-0 mb-5 max-w-[16ch] text-[clamp(30px,7vw,92px)] font-bold leading-[1.08] tracking-[-0.02em] md:mb-8 md:leading-[0.94] md:tracking-[-0.03em]">
        Βρες τη{' '}
        <span className="box-decoration-clone rounded-[3px] bg-accent px-1.5 shadow-[0_0_0_2px_#0e0e0c]">
          φθηνότερη
        </span>{' '}
        τιμή σε κάθε&nbsp;προϊόν.
      </h1>

      <p className="m-0 mb-6 max-w-[54ch] text-[16px] leading-normal text-soft md:mb-8 md:text-[19px]">
        Μία αναζήτηση σε όλα τα ελληνικά σούπερ μάρκετ που παρακολουθείς — ταξινομημένα
        ανά τιμή. Χωρίς εφαρμογές, χωρίς κάρτες, χωρίς περιττά.
      </p>

      {/* The sticky header already carries a search field on mobile — showing a
          second one here just stacks two identical bars. Keep the big hero
          search for md+ where the header search is one of several inline items. */}
      <div className="hidden max-w-[640px] items-center gap-3 rounded-2xl border-[2.5px] border-ink bg-white py-3 pl-6 pr-3 shadow-hard md:flex">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          className="flex-none text-ink"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </svg>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleKey}
          placeholder="π.χ. ελαιόλαδο, γάλα, καφές…"
          className="min-w-[40px] flex-1 bg-transparent text-[19px] font-medium text-ink outline-none placeholder:text-muted"
        />
        <button
          type="button"
          onClick={onSubmitSearch}
          className="flex-none rounded-xl bg-ink px-5 py-3 font-mono text-sm font-bold tracking-widest text-white"
        >
          ΑΝΑΖΗΤΗΣΗ
        </button>
      </div>

      {0 < trending.length && (
        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <span className="font-mono text-[11px] tracking-wide text-muted">ΔΗΜΟΦΙΛΗ</span>
          {trending.map((product) => (
            <button
              key={product.id}
              type="button"
              onClick={() => onSearchTerm(product.title)}
              className="rounded-full border-[1.5px] border-ink bg-white px-3.5 py-1.5 text-[13px] font-medium transition-colors hover:bg-ink hover:text-white"
            >
              {product.title}
            </button>
          ))}
        </div>
      )}

      {renderGrid(products, isLoading, hasError, onSelectProduct, onAdd)}
    </section>
  );
};

const statusLine = (
  productCount: number,
  retailerCount: number,
  isLoading: boolean,
  hasError: boolean,
): string => {
  if (hasError) {
    return 'ΕΚΤΟΣ ΣΥΝΔΕΣΗΣ · ΤΡΕΧΕΙ Ο WORKER;';
  }

  if (isLoading) {
    return 'ΖΩΝΤΑΝΕΣ ΤΙΜΕΣ · ΦΟΡΤΩΝΕΙ…';
  }

  const products = `${productCount} ${1 === productCount ? 'ΠΡΟΪΟΝ' : 'ΠΡΟΪΟΝΤΑ'}`;
  const retailers = `${retailerCount} ${1 === retailerCount ? 'ΚΑΤΑΣΤΗΜΑ' : 'ΚΑΤΑΣΤΗΜΑΤΑ'}`;

  return `ΖΩΝΤΑΝΕΣ ΤΙΜΕΣ · ${products} · ${retailers}`;
};

const renderGrid = (
  products: ProductWithListings[],
  isLoading: boolean,
  hasError: boolean,
  onSelectProduct: (productId: number) => void,
  onAdd: () => void,
) => {
  if (isLoading) {
    return (
      <p className="mt-11 font-mono text-sm text-muted">Φόρτωση προϊόντων…</p>
    );
  }

  if (hasError) {
    return (
      <p className="mt-11 font-mono text-sm text-danger">
        Αποτυχία φόρτωσης προϊόντων. Τρέχει ο worker;
      </p>
    );
  }

  if (0 === products.length) {
    return (
      <div className="mt-11 rounded-2xl border-2 border-dashed border-ink bg-white p-10 text-center">
        <p className="m-0 text-lg font-semibold">Δεν παρακολουθείς κανένα προϊόν ακόμα.</p>
        <p className="mx-auto mb-6 mt-2 max-w-[44ch] text-sm text-soft">
          Πρόσθεσε το πρώτο σου προϊόν για να ξεκινήσεις να συγκεντρώνεις καθημερινές τιμές
          από τα σούπερ μάρκετ.
        </p>
        <button
          type="button"
          onClick={onAdd}
          className="rounded-full border-2 border-ink bg-accent px-5 py-2.5 font-mono text-xs font-bold tracking-wide"
        >
          + ΠΡΟΣΘΕΣΕ ΠΡΟΪΟΝ
        </button>
      </div>
    );
  }

  return (
    <div className="mt-8 grid grid-cols-2 gap-3 sm:gap-3.5 md:mt-11 md:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
      {products.map((product) => (
        <ProductCard
          key={product.id}
          product={product}
          onSelect={() => onSelectProduct(product.id)}
        />
      ))}
    </div>
  );
};

interface ProductCardProps {
  product: ProductWithListings;
  onSelect: () => void;
}

const ProductCard = ({ product, onSelect }: ProductCardProps) => {
  const best = bestListing(product.listings);

  let priceLabel = 'χωρίς τιμή ακόμα';

  if (null !== best && null !== best.latestPrice && null !== best.latestPrice.pricePiece) {
    priceLabel = `από ${formatEuro(best.latestPrice.pricePiece)}`;
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      className="overflow-hidden rounded-2xl border-2 border-ink bg-white p-0 text-left transition-transform hover:-translate-y-[3px]"
    >
      <ProductImage
        src={product.imageUrl}
        alt={product.title}
        className="h-24 w-full border-b-2 border-ink bg-white object-contain p-2"
        fallback={
          <div className="hatch flex h-24 items-end border-b-2 border-ink p-2">
            <span className="rounded border border-hairline bg-white px-1.5 py-0.5 font-mono text-[9px] tracking-wide text-faint">
              {(product.brand || product.title).toUpperCase().slice(0, 16)}
            </span>
          </div>
        }
      />
      <div className="flex flex-col gap-1 px-3.5 py-3">
        <span className="line-clamp-2 text-[15px] font-semibold leading-snug">{product.title}</span>
        <span className="font-mono text-[13px] font-bold text-soft">{priceLabel}</span>
      </div>
    </button>
  );
};

const countRetailers = (products: ProductWithListings[]): number => {
  const seen = new Set<string>();

  for (const product of products) {
    for (const listing of product.listings) {
      seen.add(listing.retailer);
    }
  }

  return seen.size;
};

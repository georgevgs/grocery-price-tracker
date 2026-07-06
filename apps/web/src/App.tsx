import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProductWithListings, RetailerId } from '@grocery/core/types';
import { fetchProducts, triggerScrape } from './api/client';
import { RETAILER_LABELS } from './lib/matching';
import type { ResultSort, View } from './lib/format';
import { Header } from './components/Header';
import { BottomNav } from './components/BottomNav';
import { Footer } from './components/Footer';
import { AddProductForm } from './components/AddProductForm';
import { HomeView } from './views/HomeView';
import { ResultsView } from './views/ResultsView';
import { ProductView } from './views/ProductView';
import { StoresView } from './views/StoresView';

export const App = () => {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>('home');
  const [query, setQuery] = useState('');
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const [sort, setSort] = useState<ResultSort>('price');
  const [selectedRetailers, setSelectedRetailers] = useState<Set<RetailerId>>(
    () => new Set(RETAILER_LABELS.keys()),
  );
  const [isScraping, setIsScraping] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['products'],
    queryFn: fetchProducts,
  });

  const products = useMemo(() => data ?? [], [data]);

  const catalogRetailers = useMemo(() => {
    const present = new Set<RetailerId>();

    for (const product of products) {
      for (const listing of product.listings) {
        present.add(listing.retailer);
      }
    }

    return [...RETAILER_LABELS.keys()].filter((retailer) => present.has(retailer));
  }, [products]);

  const selectedProduct =
    null === selectedProductId
      ? null
      : (products.find((product) => product.id === selectedProductId) ?? null);

  const handleScrape = async () => {
    setIsScraping(true);

    try {
      await triggerScrape();
      await queryClient.invalidateQueries({ queryKey: ['products'] });
    } finally {
      setIsScraping(false);
    }
  };

  const handleSubmitSearch = () => {
    setView('results');
  };

  const handleSearchTerm = (term: string) => {
    setQuery(term);
    setView('results');
  };

  const handleSelectProduct = (productId: number) => {
    setSelectedProductId(productId);
    setView('product');
  };

  const handleToggleRetailer = (retailer: RetailerId) => {
    setSelectedRetailers((prev) => {
      const next = new Set(prev);

      if (next.has(retailer)) {
        next.delete(retailer);
      } else {
        next.add(retailer);
      }

      return next;
    });
  };

  const handlePickRetailer = (retailer: RetailerId) => {
    setSelectedRetailers(new Set([retailer]));
    setQuery('');
    setView('results');
  };

  const handleCreated = () => {
    queryClient.invalidateQueries({ queryKey: ['products'] });
    setView('home');
  };

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <Header
        view={view}
        query={query}
        onQueryChange={setQuery}
        onSubmitSearch={handleSubmitSearch}
        onNavigate={setView}
        onAdd={() => setView('add')}
        onScrape={handleScrape}
        isScraping={isScraping}
      />

      <main className="mx-auto w-full max-w-[1180px] flex-1 px-4 md:px-5">
        {renderView({
          view,
          products,
          isLoading,
          hasError: null != error,
          query,
          sort,
          catalogRetailers,
          selectedRetailers,
          selectedProduct,
          onQueryChange: setQuery,
          onSubmitSearch: handleSubmitSearch,
          onSearchTerm: handleSearchTerm,
          onSelectProduct: handleSelectProduct,
          onSortChange: setSort,
          onToggleRetailer: handleToggleRetailer,
          onPickRetailer: handlePickRetailer,
          onAdd: () => setView('add'),
          onGoHome: () => setView('home'),
          onGoResults: () => setView('results'),
          onCreated: handleCreated,
        })}
      </main>

      <Footer />

      <BottomNav view={view} onNavigate={setView} onAdd={() => setView('add')} />
    </div>
  );
};

interface RenderArgs {
  view: View;
  products: ProductWithListings[];
  isLoading: boolean;
  hasError: boolean;
  query: string;
  sort: ResultSort;
  catalogRetailers: RetailerId[];
  selectedRetailers: Set<RetailerId>;
  selectedProduct: ProductWithListings | null;
  onQueryChange: (query: string) => void;
  onSubmitSearch: () => void;
  onSearchTerm: (term: string) => void;
  onSelectProduct: (productId: number) => void;
  onSortChange: (sort: ResultSort) => void;
  onToggleRetailer: (retailer: RetailerId) => void;
  onPickRetailer: (retailer: RetailerId) => void;
  onAdd: () => void;
  onGoHome: () => void;
  onGoResults: () => void;
  onCreated: () => void;
}

const renderView = (args: RenderArgs) => {
  if ('add' === args.view) {
    return (
      <section className="py-8">
        <div className="mb-5 font-mono text-[11px] tracking-wide text-muted">
          <button type="button" onClick={args.onGoHome} className="text-muted">
            ΑΡΧΙΚΗ
          </button>{' '}
          / ΠΡΟΣΘΗΚΗ ΠΡΟΪΟΝΤΟΣ
        </div>
        <h1 className="m-0 mb-6 text-[clamp(30px,5vw,50px)] font-bold leading-none tracking-[-0.02em]">
          Παρακολούθησε ένα νέο{' '}
          <span className="rounded-[3px] bg-accent px-1.5 shadow-[0_0_0_2px_#0e0e0c]">
            προϊόν
          </span>
        </h1>
        <div className="max-w-[640px]">
          <AddProductForm existingProducts={args.products} onCreated={args.onCreated} />
        </div>
      </section>
    );
  }

  if ('stores' === args.view) {
    return (
      <StoresView
        products={args.products}
        onGoHome={args.onGoHome}
        onPickRetailer={args.onPickRetailer}
      />
    );
  }

  if ('product' === args.view && null !== args.selectedProduct) {
    return <ProductView product={args.selectedProduct} onGoResults={args.onGoResults} />;
  }

  if ('results' === args.view || 'product' === args.view) {
    return (
      <ResultsView
        products={args.products}
        query={args.query}
        sort={args.sort}
        onSortChange={args.onSortChange}
        catalogRetailers={args.catalogRetailers}
        selectedRetailers={args.selectedRetailers}
        onToggleRetailer={args.onToggleRetailer}
        onSelectProduct={args.onSelectProduct}
        onGoHome={args.onGoHome}
      />
    );
  }

  return (
    <HomeView
      products={args.products}
      query={args.query}
      onQueryChange={args.onQueryChange}
      onSubmitSearch={args.onSubmitSearch}
      onSearchTerm={args.onSearchTerm}
      onSelectProduct={args.onSelectProduct}
      onAdd={args.onAdd}
      isLoading={args.isLoading}
      hasError={args.hasError}
    />
  );
};

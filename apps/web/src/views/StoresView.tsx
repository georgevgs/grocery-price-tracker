import type { ProductWithListings, RetailerId } from '@grocery/core/types';
import { RETAILER_LABELS } from '../lib/matching';
import { RETAILER_MARKS, bestListing } from '../lib/format';

interface StoresViewProps {
  products: ProductWithListings[];
  onGoHome: () => void;
  onPickRetailer: (retailer: RetailerId) => void;
}

interface RetailerStat {
  retailer: RetailerId;
  label: string;
  mark: string;
  listings: number;
  cheapest: number;
}

export const StoresView = ({ products, onGoHome, onPickRetailer }: StoresViewProps) => {
  const stats = buildStats(products);
  const totalListings = stats.reduce((sum, stat) => sum + stat.listings, 0);
  const activeStores = stats.filter((stat) => 0 < stat.listings).length;

  return (
    <section className="py-8">
      <div className="mb-2 font-mono text-[11px] tracking-wide text-muted">
        <button type="button" onClick={onGoHome} className="text-muted">
          ΑΡΧΙΚΗ
        </button>{' '}
        / ΚΑΤΑΣΤΗΜΑΤΑ
      </div>
      <h1 className="m-0 mb-6 text-[clamp(30px,5vw,50px)] font-bold leading-none tracking-[-0.02em]">
        Καταστήματα που{' '}
        <span className="rounded-[3px] bg-accent px-1.5 shadow-[0_0_0_2px_#0e0e0c]">
          παρακολουθούμε
        </span>
      </h1>

      <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div className="flex flex-col gap-4 rounded-2xl border-2 border-ink bg-ink px-6 py-6 text-white shadow-hard-accent md:sticky md:top-[86px]">
          <div className="font-mono text-[11px] tracking-[0.15em] text-[#b9b9b0]">
            ΚΑΛΥΨΗ
          </div>
          <SummaryRow value={String(products.length)} label="προϊόντα" />
          <SummaryRow value={String(totalListings)} label="καταχωρίσεις" />
          <SummaryRow
            value={`${activeStores} / ${stats.length}`}
            label="ενεργά σούπερ μάρκετ"
          />
          <p className="m-0 mt-1 text-[13px] leading-normal text-[#b9b9b0]">
            Οι τιμές ανανεώνονται σε κάθε ανανέωση. Διάλεξε κατάστημα για να δεις μόνο
            τις δικές του τιμές.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {stats.map((stat) => (
            <StoreCard key={stat.retailer} stat={stat} onPick={() => onPickRetailer(stat.retailer)} />
          ))}
        </div>
      </div>
    </section>
  );
};

interface SummaryRowProps {
  value: string;
  label: string;
}

const SummaryRow = ({ value, label }: SummaryRowProps) => {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[#2a2a26] pb-3 last:border-b-0 last:pb-0">
      <span className="font-mono text-[32px] font-bold leading-none tracking-[-1px]">
        {value}
      </span>
      <span className="text-[13px] text-[#b9b9b0]">{label}</span>
    </div>
  );
};

interface StoreCardProps {
  stat: RetailerStat;
  onPick: () => void;
}

const StoreCard = ({ stat, onPick }: StoreCardProps) => {
  const isActive = 0 < stat.listings;

  return (
    <button
      type="button"
      onClick={onPick}
      className="flex flex-col gap-3.5 rounded-2xl border-2 border-ink bg-white p-4 text-left transition-transform hover:-translate-y-[3px]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 flex-none items-center justify-center rounded-xl border-2 border-ink bg-linen font-mono text-sm font-bold">
            {stat.mark}
          </span>
          <span className="text-[17px] font-bold leading-tight">{stat.label}</span>
        </div>
        <span className="whitespace-nowrap rounded-full border-[1.5px] border-ink px-2.5 py-1 font-mono text-[11px] font-bold">
          {stat.listings} {1 === stat.listings ? 'προϊόν' : 'προϊόντα'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="rounded-md border-[1.5px] border-ink bg-accent px-2 py-0.5 font-mono text-[11px] font-bold">
          {stat.cheapest} {1 === stat.cheapest ? 'προϊόν φθηνότερο' : 'προϊόντα φθηνότερα'} εδώ
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-soft">
          <span
            className={`h-[7px] w-[7px] rounded-full ${isActive ? 'bg-ok' : 'bg-danger'}`}
          />
          {isActive ? 'ΕΝΕΡΓΟ' : 'ΑΝΕΝΕΡΓΟ'}
        </span>
      </div>
    </button>
  );
};

const buildStats = (products: ProductWithListings[]): RetailerStat[] => {
  const listingCounts = new Map<RetailerId, number>();
  const cheapestCounts = new Map<RetailerId, number>();

  for (const product of products) {
    for (const listing of product.listings) {
      listingCounts.set(listing.retailer, (listingCounts.get(listing.retailer) ?? 0) + 1);
    }

    const best = bestListing(product.listings);

    if (null !== best) {
      cheapestCounts.set(best.retailer, (cheapestCounts.get(best.retailer) ?? 0) + 1);
    }
  }

  const stats: RetailerStat[] = [];

  for (const [retailer, label] of RETAILER_LABELS) {
    stats.push({
      retailer,
      label,
      mark: RETAILER_MARKS.get(retailer) ?? '??',
      listings: listingCounts.get(retailer) ?? 0,
      cheapest: cheapestCounts.get(retailer) ?? 0,
    });
  }

  return stats.sort((a, b) => b.listings - a.listings);
};

import { useQuery } from '@tanstack/react-query';
import { fetchProductHistory, type HistoryPoint } from '../api/client';
import { formatEuro } from '../lib/format';

interface PriceHistoryChartProps {
  productId: number;
}

interface Bucket {
  date: string;
  label: string;
  price: number;
}

const MAX_BARS = 14;

export const PriceHistoryChart = ({ productId }: PriceHistoryChartProps) => {
  const { data: history, isLoading, isError } = useQuery({
    queryKey: ['history', productId],
    queryFn: () => fetchProductHistory(productId),
  });

  const buckets = undefined === history ? [] : toBuckets(history);

  return (
    <div className="rounded-2xl border-2 border-ink bg-white p-5">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="font-mono text-xs tracking-wide">ΙΣΤΟΡΙΚΟ ΤΙΜΩΝ</span>
        <span className="font-mono text-xs text-ink">{deltaLabel(buckets, isLoading)}</span>
      </div>
      {/* Be explicit about what the bars are: the lowest price found each day
          across all tracked chains — so a gap in the usually-cheapest chain
          reads honestly, not as a price spike for one store. */}
      <div className="mb-4 font-mono text-[10px] tracking-wide text-faint">
        χαμηλότερη τιμή ανά ημέρα σε όλα τα καταστήματα
      </div>
      {renderBody(buckets, isLoading, isError)}
    </div>
  );
};

const renderBody = (buckets: Bucket[], isLoading: boolean, isError: boolean) => {
  if (isLoading) {
    return <p className="font-mono text-sm text-muted">Φόρτωση ιστορικού…</p>;
  }

  if (isError) {
    return (
      <p className="font-mono text-sm text-danger">Δεν φορτώθηκε το ιστορικό — δοκίμασε ξανά.</p>
    );
  }

  if (0 === buckets.length) {
    return <p className="font-mono text-sm text-muted">Χωρίς ιστορικό τιμών ακόμα.</p>;
  }

  const prices = buckets.map((bucket) => bucket.price);
  const max = Math.max(...prices);
  const lastIndex = buckets.length - 1;

  return (
    <>
      <div className="flex h-[150px] items-end gap-1.5 border-b-2 border-ink pb-0.5">
        {buckets.map((bucket, index) => {
          const isLast = index === lastIndex;

          return (
            <div
              key={bucket.date}
              className="flex h-full flex-1 flex-col items-center justify-end gap-1.5"
            >
              {isLast && (
                <span className="font-mono text-[9px] text-muted">
                  {formatEuro(bucket.price)}
                </span>
              )}
              <div
                className={`w-full rounded-t-md border-[1.5px] border-b-0 border-ink ${
                  isLast ? 'bg-accent' : 'bg-ink'
                }`}
                style={{ height: barHeight(bucket.price, max) }}
                title={`${bucket.label}: ${formatEuro(bucket.price)}`}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {buckets.map((bucket) => (
          <span
            key={bucket.date}
            className="flex-1 text-center font-mono text-[9px] text-faint"
          >
            {bucket.label}
          </span>
        ))}
      </div>
    </>
  );
};

const barHeight = (price: number, max: number): string => {
  if (0 >= max) {
    return '0%';
  }

  // Zero-based: bar height is proportional to the actual price, so a 1–2% move
  // reads as a 1–2% move (the old min→max rescale exaggerated it into a
  // "doubling"). Precision lives in the numeric delta label above.
  return `${((price / max) * 100).toFixed(1)}%`;
};

const deltaLabel = (buckets: Bucket[], isLoading: boolean): string => {
  if (isLoading || 2 > buckets.length) {
    return '';
  }

  const first = buckets[0];
  const last = buckets[buckets.length - 1];

  if (undefined === first || undefined === last || 0 === first.price) {
    return '';
  }

  const change = ((last.price - first.price) / first.price) * 100;
  const magnitude = Math.abs(change).toFixed(0);

  if (0.5 > Math.abs(change)) {
    return `σταθερή σε ${buckets.length} σημεία`;
  }

  if (change < 0) {
    return `▼ πτώση ${magnitude}% από ${first.label}`;
  }

  return `▲ άνοδος ${magnitude}% από ${first.label}`;
};

/** Cheapest price per date across all retailers, oldest→newest, capped. */
const toBuckets = (history: readonly HistoryPoint[]): Bucket[] => {
  const byDate = new Map<string, number>();

  for (const point of history) {
    if (null === point.pricePiece) {
      continue;
    }

    const current = byDate.get(point.scrapedDate);

    if (undefined === current || point.pricePiece < current) {
      byDate.set(point.scrapedDate, point.pricePiece);
    }
  }

  const buckets = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, price]) => ({ date, label: shortDate(date), price }));

  return buckets.slice(-MAX_BARS);
};

const shortDate = (isoDate: string): string => {
  const parts = isoDate.split('-');
  const month = parts[1];
  const day = parts[2];

  if (undefined === month || undefined === day) {
    return isoDate;
  }

  return `${Number(day)}/${Number(month)}`;
};

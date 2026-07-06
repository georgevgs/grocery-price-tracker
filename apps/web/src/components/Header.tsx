import type { KeyboardEvent } from 'react';
import type { View } from '../lib/format';
import { Logomark, Wordmark } from './BrandLogo';

interface HeaderProps {
  view: View;
  query: string;
  onQueryChange: (query: string) => void;
  onSubmitSearch: () => void;
  onNavigate: (view: View) => void;
  onAdd: () => void;
  onScrape: () => void;
  isScraping: boolean;
}

const TABS: ReadonlyArray<{ view: View; label: string }> = [
  { view: 'home', label: 'ΑΡΧΙΚΗ' },
  { view: 'stores', label: 'ΚΑΤΑΣΤΗΜΑΤΑ' },
];

export const Header = ({
  view,
  query,
  onQueryChange,
  onSubmitSearch,
  onNavigate,
  onAdd,
  onScrape,
  isScraping,
}: HeaderProps) => {
  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if ('Enter' === event.key) {
      onSubmitSearch();
    }
  };

  return (
    <header className="sticky top-0 z-30 border-b-2 border-ink bg-paper pt-safe-top">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-2.5 px-4 py-3 md:flex-row md:flex-nowrap md:items-center md:gap-4 md:px-5">
        {/* Logo + refresh share one row on mobile; `md:contents` dissolves
            this wrapper on desktop so both become cells of the header row. */}
        <div className="flex items-center justify-between gap-3 md:contents">
          <button
            type="button"
            onClick={() => onNavigate('home')}
            aria-label="Τιμούλα — αρχική"
            className="flex flex-none items-center gap-2 text-ink"
          >
            <Logomark className="h-[26px] w-[26px]" />
            <Wordmark className="h-[22px] w-auto" />
          </button>

          <button
            type="button"
            onClick={onScrape}
            disabled={isScraping}
            aria-label="Ανανέωση τιμών"
            className="flex flex-none items-center gap-2 rounded-full border-2 border-ink bg-transparent px-3 py-2 font-mono text-[11px] font-bold tracking-wide text-ink disabled:opacity-60 md:order-last md:py-1.5"
          >
            <span
              className={`h-2 w-2 rounded-full border-[1.5px] border-ink bg-accent ${
                isScraping ? 'animate-blink' : ''
              }`}
            />
            {isScraping ? 'ΑΝΑΝΕΩΣΗ…' : 'ΑΝΑΝΕΩΣΗ'}
          </button>
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-full border-2 border-ink bg-white py-2 pl-4 pr-2">
          <SearchIcon />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={handleKey}
            placeholder="Ψάξε οποιοδήποτε προϊόν…"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
          />
          <button
            type="button"
            onClick={onSubmitSearch}
            className="flex-none rounded-full bg-ink px-4 py-2 font-mono text-xs font-bold tracking-widest text-white"
          >
            ΨΑΞΕ
          </button>
        </div>

        {/* Tab navigation lives in the bottom bar on mobile (see BottomNav). */}
        <nav className="hidden gap-1.5 md:flex">
          {TABS.map((tab) => (
            <button
              key={tab.view}
              type="button"
              onClick={() => onNavigate(tab.view)}
              className={`rounded-full border-2 border-ink px-3.5 py-1.5 font-mono text-[11px] font-bold tracking-wide text-ink transition-colors hover:bg-accent ${
                view === tab.view ? 'bg-accent' : 'bg-transparent'
              }`}
            >
              {tab.label}
            </button>
          ))}
          <button
            type="button"
            onClick={onAdd}
            className={`rounded-full border-2 border-ink px-3.5 py-1.5 font-mono text-[11px] font-bold tracking-wide text-ink transition-colors hover:bg-accent ${
              'add' === view ? 'bg-accent' : 'bg-transparent'
            }`}
          >
            + ΠΡΟΣΘΗΚΗ
          </button>
        </nav>
      </div>
    </header>
  );
};

const SearchIcon = () => {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      className="flex-none text-ink"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" />
    </svg>
  );
};

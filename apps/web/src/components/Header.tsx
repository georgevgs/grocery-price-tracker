import type { KeyboardEvent } from 'react';
import type { View } from '../lib/format';

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
    <header className="sticky top-0 z-30 border-b-2 border-ink bg-paper">
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-4 px-5 py-3">
        <button
          type="button"
          onClick={() => onNavigate('home')}
          className="flex items-center gap-2 font-mono text-xl font-bold tracking-tight text-ink"
        >
          <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border-2 border-ink bg-accent text-[15px] leading-none">
            Τ
          </span>
          Τιμούλα
        </button>

        <div className="flex min-w-[220px] flex-1 items-center gap-2.5 rounded-full border-2 border-ink bg-white py-2 pl-4 pr-2">
          <SearchIcon />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={handleKey}
            placeholder="Ψάξε οποιοδήποτε προϊόν…"
            className="min-w-[60px] flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
          />
          <button
            type="button"
            onClick={onSubmitSearch}
            className="rounded-full bg-ink px-4 py-2 font-mono text-xs font-bold tracking-widest text-white"
          >
            ΨΑΞΕ
          </button>
        </div>

        <nav className="flex gap-1.5">
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

        <button
          type="button"
          onClick={onScrape}
          disabled={isScraping}
          className="flex items-center gap-2 rounded-full border-2 border-ink bg-transparent px-3 py-1.5 font-mono text-[11px] font-bold tracking-wide text-ink disabled:opacity-60"
        >
          <span
            className={`h-2 w-2 rounded-full border-[1.5px] border-ink bg-accent ${
              isScraping ? 'animate-blink' : ''
            }`}
          />
          {isScraping ? 'ΑΝΑΝΕΩΣΗ…' : 'ΑΝΑΝΕΩΣΗ'}
        </button>
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

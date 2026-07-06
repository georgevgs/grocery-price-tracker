import type { ReactNode } from 'react';
import type { View } from '../lib/format';

interface BottomNavProps {
  view: View;
  onNavigate: (view: View) => void;
  onAdd: () => void;
}

/**
 * Fixed mobile tab bar — the primary navigation for the PWA on phones,
 * where most visits happen. Hidden from `md` up, where the header carries
 * the same tabs inline. `results`/`product` are sub-states reached from a
 * home search, so they keep the ΑΡΧΙΚΗ tab lit.
 */
export const BottomNav = ({ view, onNavigate, onAdd }: BottomNavProps) => {
  const homeActive = 'home' === view || 'results' === view || 'product' === view;

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-ink bg-paper pb-safe-bottom md:hidden"
      aria-label="Κύρια πλοήγηση"
    >
      <div className="mx-auto grid max-w-[520px] grid-cols-3">
        <Tab
          label="ΑΡΧΙΚΗ"
          active={homeActive}
          onClick={() => onNavigate('home')}
          icon={<HomeIcon />}
        />
        <Tab
          label="ΚΑΤΑΣΤΗΜΑΤΑ"
          active={'stores' === view}
          onClick={() => onNavigate('stores')}
          icon={<StoreIcon />}
        />
        <Tab
          label="ΠΡΟΣΘΗΚΗ"
          active={'add' === view}
          onClick={onAdd}
          icon={<PlusIcon />}
          accent
        />
      </div>
    </nav>
  );
};

interface TabProps {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  accent?: boolean;
}

const Tab = ({ label, active, onClick, icon, accent = false }: TabProps) => {
  const iconBox = active
    ? 'border-ink bg-accent'
    : accent
      ? 'border-ink bg-accent/40'
      : 'border-transparent bg-transparent';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className="flex min-h-[56px] flex-col items-center justify-center gap-1 py-2"
    >
      <span
        className={`flex h-8 w-9 items-center justify-center rounded-lg border-2 text-ink transition-colors ${iconBox}`}
      >
        {icon}
      </span>
      <span
        className={`font-mono text-[9px] tracking-wide ${active ? 'font-bold text-ink' : 'text-muted'}`}
      >
        {label}
      </span>
    </button>
  );
};

const HomeIcon = () => (
  <svg
    width="19"
    height="19"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 11.5 12 4l9 7.5" />
    <path d="M5 10v9h14v-9" />
  </svg>
);

const StoreIcon = () => (
  <svg
    width="19"
    height="19"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 9h16l-1-4H5L4 9Z" />
    <path d="M5 9v10h14V9" />
    <path d="M10 19v-5h4v5" />
  </svg>
);

const PlusIcon = () => (
  <svg
    width="19"
    height="19"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.6"
    strokeLinecap="round"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

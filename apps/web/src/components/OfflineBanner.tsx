import { useOnlineStatus } from '../lib/useOnlineStatus';

/**
 * Persistent "you are offline" toast. The service worker serves the cached
 * shell even with no network, so the app *loads* but every `/api/*` call fails
 * — without this cue an empty list or a spinner-that-never-resolves reads as a
 * broken app rather than a dropped connection.
 *
 * Rendered as a `fixed` toast (not an in-flow bar) so it never reshuffles the
 * sticky header/content layout, and it sits above the mobile tab bar
 * (`bottom-tabbar` clears bar height + the iOS home-indicator inset) rather
 * than under it. `aria-live="assertive"` announces the state change to screen
 * readers the moment connectivity drops.
 */
export const OfflineBanner = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) {
    return null;
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-tabbar z-40 flex justify-center px-4 md:bottom-4"
      role="status"
      aria-live="assertive"
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-2.5 rounded-full border-2 border-ink bg-warn py-2.5 pl-3.5 pr-4 text-white shadow-hard-sm">
        <span className="h-2.5 w-2.5 flex-none animate-blink rounded-full border-[1.5px] border-ink bg-white" />
        <span className="min-w-0 font-mono text-[11px] font-bold tracking-wide">
          ΕΙΣΑΙ ΕΚΤΟΣ ΣΥΝΔΕΣΗΣ · ΟΙ ΤΙΜΕΣ ΜΠΟΡΕΙ ΝΑ ΜΗΝ ΕΝΗΜΕΡΩΝΟΝΤΑΙ
        </span>
      </div>
    </div>
  );
};

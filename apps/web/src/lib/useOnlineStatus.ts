import { useEffect, useState } from 'react';

/**
 * Tracks browser connectivity via `navigator.onLine` and the `online`/`offline`
 * events. `navigator.onLine` only reports whether a network interface is up (it
 * can't tell whether the internet is genuinely reachable), but it's the cheap,
 * universal signal — enough to tell a user "you appear offline" so that a
 * failed `/api/*` fetch reads as *a connectivity problem* rather than *a broken
 * app*. The service worker keeps serving the cached shell while offline, which
 * is precisely why the shell needs to own up to the fact.
 *
 * SSR/no-`navigator` default is `true` (assume online) so nothing flashes the
 * banner during the first paint.
 */
export const useOnlineStatus = (): boolean => {
  const [isOnline, setIsOnline] = useState(() =>
    'undefined' === typeof navigator ? true : navigator.onLine,
  );

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    // Re-sync once listeners are attached: the status may have flipped between
    // the initial `useState` read and this effect running.
    setIsOnline(navigator.onLine);

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return isOnline;
};

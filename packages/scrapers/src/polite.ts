/**
 * Politeness layer every adapter fetch should run through: a hung socket must
 * not stall a scrape slot forever, and a transient failure (429/5xx, network
 * blip, WAF hiccup) must not cost a listing its daily price point — without a
 * retry the next chance is +24h. Applied by the CALLERS that provide fetchImpl
 * (the Worker's endpoints, the local scrape job), never inside adapters, so
 * tests keep injecting plain stubs and each caller tunes its own budget
 * (interactive edge search wants short timeouts; the local job streaming a
 * ~29 MB catalog wants long ones).
 */

export interface PolitenessOptions {
  /**
   * Per-attempt ceiling, headers AND body — AbortSignal.timeout keeps running
   * while a response streams, so callers that download big bodies (the
   * Kritikos catalog) must size this to the whole transfer, not the TTFB.
   */
  timeoutMs?: number;
  /** Extra attempts after the first, spent on 429/5xx and network errors. */
  retries?: number;
  /** First backoff step; doubles per attempt, ±25% jitter. */
  baseDelayMs?: number;
  /** Cap on any single wait, including a server-sent Retry-After. */
  maxDelayMs?: number;
  /**
   * Wait before the single 403 retry. WAF 403s are sometimes transient
   * reputation scoring rather than a hard block, so one cautious, delayed
   * retry is worth it — but only one: hammering a real block just feeds it.
   */
  forbiddenDelayMs?: number;
}

const DEFAULTS: Required<PolitenessOptions> = {
  timeoutMs: 20_000,
  retries: 2,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  forbiddenDelayMs: 2_000,
};

export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/** ±25% so simultaneous failers don't re-hit a struggling host in lockstep. */
export const jittered = (ms: number): number => {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
};

/** Retry-After arrives as delta-seconds or an HTTP-date; either → ms, else null. */
const retryAfterMs = (response: Response): number | null => {
  const raw = response.headers.get('retry-after');

  if (null === raw) {
    return null;
  }

  const seconds = Number(raw);

  if (false === Number.isNaN(seconds)) {
    return Math.max(0, 1000 * seconds);
  }

  const date = Date.parse(raw);

  if (false === Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
};

/**
 * Free the connection before a retry — an unconsumed body keeps the socket
 * (and, on Workers, the subrequest) alive.
 */
const discard = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed/canceled — nothing to free.
  }
};

/**
 * Wrap a fetch with per-attempt timeout + bounded, jittered retries.
 *
 * Retry policy: 429 and 5xx (honoring Retry-After, capped at maxDelayMs) and
 * thrown network errors/timeouts retry up to `retries` times with exponential
 * backoff; 403 gets exactly ONE delayed retry regardless of `retries` (see
 * forbiddenDelayMs); every other status returns as-is for the adapter to
 * classify. Retries re-send `init` verbatim, which is safe because adapters
 * only pass string bodies — a stream body would be consumed by attempt one.
 */
export const withPoliteness = (
  fetchImpl: typeof fetch,
  options: PolitenessOptions = {},
): typeof fetch => {
  const { timeoutMs, retries, baseDelayMs, maxDelayMs, forbiddenDelayMs } = {
    ...DEFAULTS,
    ...options,
  };

  const backoff = (attempt: number): number => {
    return Math.min(maxDelayMs, jittered(baseDelayMs * 2 ** attempt));
  };

  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let attempt = 0;
    let forbiddenRetried = false;

    for (;;) {
      let response: Response;

      try {
        response = await fetchImpl(input, {
          ...init,
          // A caller-supplied signal wins — merging would need AbortSignal.any
          // and no adapter passes one today.
          signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (attempt >= retries) {
          throw error;
        }

        await sleep(backoff(attempt));
        attempt += 1;
        continue;
      }

      const transient = 429 === response.status || 500 <= response.status;

      if (transient && attempt < retries) {
        const serverWait = retryAfterMs(response);
        await discard(response);
        await sleep(null === serverWait ? backoff(attempt) : Math.min(maxDelayMs, serverWait));
        attempt += 1;
        continue;
      }

      if (403 === response.status && false === forbiddenRetried) {
        forbiddenRetried = true;
        await discard(response);
        await sleep(jittered(forbiddenDelayMs));
        continue;
      }

      return response;
    }
  }) as typeof fetch;
};

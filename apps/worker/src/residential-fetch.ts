/**
 * Residential egress for the Worker — a `fetch`-compatible shim that routes an
 * adapter's request through a scraping/unblocker API so it leaves from a
 * residential Greek IP instead of Cloudflare's edge.
 *
 * WHY THIS EXISTS: the retailers' WAFs (Akamai on AB, a CDN on Kritikos, a WAF
 * on Sklavenitis) block Cloudflare Worker egress IPs with 403/503/429 — the
 * same reason the daily scrape runs off-edge (scripts/scrape-local.ts). For
 * interactive search we can't lean on a residential machine (it would have to
 * be always-on), and a per-GB CONNECT proxy is unusable from a Worker:
 * `fetch()` has no proxy option, and `cloudflare:sockets` `startTls()` can't
 * present the *target's* SNI through a CONNECT tunnel (it reuses the proxy
 * hostname), which the Cloudflare docs/community confirm fails in production.
 * A scraping API is the one Worker-native residential path: a plain HTTPS
 * request to the provider, who fetches the retailer for us and returns the
 * response.
 *
 * ONLY the chains flagged `needsResidentialEgress` are routed here (AB,
 * Kritikos, Sklavenitis) — every other chain answers the Worker directly and
 * stays on the free global fetch, so we only pay per request for the ones that
 * actually block us.
 *
 * PROVIDER: Scrape.do. It's a transparent forwarder — `customHeaders=true`
 * passes our exact request headers to the retailer (AB's `x-apollo-operation-name`
 * CSRF header, the per-chain User-Agents) and it returns the retailer's raw
 * body with its real status code, so the adapters (which only read
 * .ok/.status/.json()/.text()) work unchanged. `super=true` selects residential
 * IPs; `geoCode=gr` pins them to Greece. Everything provider-specific lives in
 * this one function — swapping to Zyte/ScraperAPI later is a local change.
 */

const SCRAPE_DO_ENDPOINT = 'https://api.scrape.do';

/** Pull the target URL string out of fetch's polymorphic first argument. */
const targetUrl = (input: Parameters<typeof fetch>[0]): string => {
  if ('string' === typeof input) {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  // A Request object — adapters don't use this form today, but be robust.
  return input.url;
};

/**
 * Build a `fetch`-compatible function bound to a Scrape.do token. Returns
 * `typeof fetch` so it drops straight into `adapter.searchProducts(query, fetchImpl)`.
 */
export const makeResidentialFetch = (token: string): typeof fetch => {
  return (async (input, init) => {
    const target = targetUrl(input);

    const params = new URLSearchParams({
      token,
      url: target,
      // Residential IPs, pinned to Greece — retailers geo-gate and datacenter-block.
      super: 'true',
      geoCode: 'gr',
      // Forward our headers verbatim (CSRF header, User-Agent) rather than
      // letting Scrape.do substitute its own — the adapters depend on them.
      customHeaders: 'true',
      // Cap Scrape.do's own attempt so a hard-blocked target fails fast instead
      // of tarpitting for ~57s (observed on AB's Akamai) before it gives up.
      timeout: '30000',
    });

    // The retailer's method/headers/body ride on OUR request to Scrape.do;
    // with customHeaders=true it relays them to the target. init may be
    // undefined (adapters default to GET), which is fine. A belt-and-braces
    // client-side abort guarantees the subrequest can't hang the search even if
    // Scrape.do ignores its own timeout.
    const response = await fetch(`${SCRAPE_DO_ENDPOINT}/?${params.toString()}`, {
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
      signal: AbortSignal.timeout(35000),
    });

    // Scrape.do proxies the target's status + body, so the adapter's
    // `response.ok` / `response.status` / `.json()` / `.text()` all see the
    // retailer's real response. A Scrape.do-level failure (bad token → 401,
    // quota → 429) surfaces as a non-ok status and lands in the search
    // `errors[]` array like any other per-chain failure — it never throws the
    // whole fan-out.
    return response;
  }) as typeof fetch;
};

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
 * passes our exact request headers to the retailer (Kritikos/Sklavenitis
 * User-Agents) and it returns the retailer's raw body with its real status
 * code, so the adapters (which only read .ok/.status/.json()/.text()) work
 * unchanged. `super=true` selects residential IPs; `geoCode=gr` pins them to
 * Greece. Everything provider-specific lives in this one function — swapping to
 * Zyte/ScraperAPI later is a local change.
 *
 * RENDER MODE (`options.render`): AB's search *API* (/api/v1) is blocked through
 * the proxy at the connection level (Akamai 502 "cannot connect target url",
 * even with a headless browser pointed straight at it), and its search *page* is
 * a client-rendered shell. The one path that works: render the search PAGE in a
 * real headless browser — Akamai's sensor JS sets `_abck`/`bm_sz`, the in-page
 * app then makes its own cookie'd API call, and the results paint into the DOM,
 * which Scrape.do returns as HTML for the adapter to parse. Render swaps
 * `customHeaders`/`timeout` for `render=true` + a `customWait` settle and runs
 * far slower (~20-30s), so it's opt-in per adapter (needsRenderedSearch).
 */

const SCRAPE_DO_ENDPOINT = 'https://api.scrape.do';

export interface ResidentialFetchOptions {
  /**
   * Route through Scrape.do's headless browser (render=true) rather than the
   * plain forwarder. Only for chains whose data exists solely after client-side
   * JS runs and whose API is unreachable through the proxy (AB). See the RENDER
   * MODE note above; it is the priciest, slowest tier, so keep it opt-in.
   */
  render?: boolean;
}

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
export const makeResidentialFetch = (
  token: string,
  options: ResidentialFetchOptions = {},
): typeof fetch => {
  const render = true === options.render;

  return (async (input, init) => {
    const target = targetUrl(input);

    const params = new URLSearchParams({
      token,
      url: target,
      // Residential IPs, pinned to Greece — retailers geo-gate and datacenter-block.
      super: 'true',
      geoCode: 'gr',
    });

    if (render) {
      // Headless browser: it navigates the page, Akamai's sensor JS runs, and
      // the in-page app fetches the results. customWait lets that async call
      // settle before capture; customHeaders/timeout don't apply to render.
      params.set('render', 'true');
      params.set('customWait', '8000');
    } else {
      // Forward our headers verbatim (CSRF header, User-Agent) rather than
      // letting Scrape.do substitute its own — the adapters depend on them.
      params.set('customHeaders', 'true');
      // Cap Scrape.do's own attempt so a hard-blocked target fails fast instead
      // of tarpitting for ~57s (observed on AB's Akamai) before it gives up.
      params.set('timeout', '30000');
    }

    // The retailer's method/headers/body ride on OUR request to Scrape.do;
    // with customHeaders=true it relays them to the target. init may be
    // undefined (adapters default to GET), which is fine. A belt-and-braces
    // client-side abort guarantees the subrequest can't hang the search even if
    // Scrape.do ignores its own timeout — sized larger for render's browser spin-up.
    const response = await fetch(`${SCRAPE_DO_ENDPOINT}/?${params.toString()}`, {
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
      signal: AbortSignal.timeout(render ? 75000 : 35000),
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

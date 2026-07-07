# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Τιμούλα is a Greek-language PWA tracking daily grocery prices for the same product across seven Greek supermarket chains. The UI ships in Greek; code, comments, and docs are in English.

## Commands

```bash
npm install                        # installs all workspaces

# Dev (two terminals)
npm run dev:worker                 # wrangler dev → :8787 (API + local D1)
npm run dev:web                    # vite → :5173, proxies /api → :8787

# Quality gates
npm run typecheck                  # tsc across all workspaces (--if-present)
npm test                           # tsx tests/run.ts — see note below

# Database (D1)
npm run db:migrate:local           # apply schema.sql to the local dev DB
npm run db:migrate:remote          # apply schema.sql to production

# Ship
npm run build                      # build the PWA to apps/web/dist
npm run deploy                     # build web THEN wrangler deploy (worker + assets)

# Daily scrape (runs locally, not on the edge — see Architecture)
npm run scrape:local --workspace apps/worker              # write today's prices to remote D1
npm run scrape:local --workspace apps/worker -- --dry-run # fetch only, print, don't write
```

**Tests:** `npm test` runs a single assertion script (`tests/run.ts`, using `node:assert`) whose centrepiece is the **golden matching set** (`tests/golden.ts`) — labelled product pairs asserting the fuzzy matcher's precision/recall stay at 1.000. There is no test framework and no per-test filter: it's all-or-nothing. When you change `@grocery/core` normalization/matching or any scraper parser, run the whole suite and keep the golden set green. Add cases to `tests/golden.ts` rather than loosening the gates.

## Architecture

**Monorepo (npm workspaces):** `packages/*` + `apps/*`.
- `@grocery/core` — types (`RetailerId` union is the source of truth), `normalize.ts` (size/percent/EAN extraction, Greek folding), `match.ts` (the fuzzy matcher).
- `@grocery/scrapers` — one adapter per chain + `registry.ts` (`adapterRegistry: Map<RetailerId, RetailerAdapter>`). Each adapter implements `searchProducts(query, fetch, hints)` (discovery) and `scrapeProduct(url, fetch, hints)` (daily prices).
- `apps/worker` — Cloudflare Worker (Hono) + D1. Also the host (see below).
- `apps/web` — Vite + React 19 + Tailwind v4 PWA (TanStack Query, Recharts).

**Single-origin Worker.** `apps/worker/wrangler.toml` has `[assets] directory = "../web/dist"`, so the deployed Worker serves the built PWA *and* the `/api/*` backend from one origin. Static assets match first; any unmatched path (i.e. `/api/*`) falls through to the Hono app in `apps/worker/src/index.ts`. There is **no** separate Cloudflare Pages project. The web app calls `/api/*` with relative URLs, which "just work" in both dev (Vite proxy) and prod.

**Product identity is the core model.** Retailer SKUs never match across chains, so identity lives in the `products` table:
- `products.ean` — canonical when known; bypasses fuzzy matching at barcode-capable chains (Galaxias `sku=EAN`, Kritikos, Masoutis, My Market).
- `retailer_listings (retailer, retailer_sku)` — the deterministic per-store join key once mapped.
- `@grocery/core/match` is a **suggester, never an auto-linker**: brand + size are hard gates, then token-Jaccard ranking. A human confirms the pick before a listing is saved.

**Search fan-out is client-side, one chain per request.** `apps/web/src/lib/matching.ts` + `apps/web/src/api/client.ts` fan `/api/retailer-search` out to one retailer per request and merge. This is deliberate: the Worker parses each chain's catalog within the invocation, and fanning all chains out in a single request blows the **Workers Free-plan per-request CPU budget** (Cloudflare error 1102). Per-chain failures become entries in an `errors[]` array rather than throwing, so one bad chain never sinks the whole search. Search is multi-pass (full query → brand-only retry for chains that AND every token → EAN re-query when a ≥60% match reveals a barcode). Escape hatch for products a chain's search index omits: paste a product-page URL → `POST /api/resolve-url` resolves it through the adapter directly.

**The daily scrape runs off-edge.** Retailer WAFs (Akamai, etc.) block Cloudflare Worker egress IPs with 403/503, so the edge cron in `wrangler.toml` is **disabled** and the scrape runs from a residential IP via a launchd job (`apps/worker/scripts/scrape-local.ts`, reusing the Worker's adapters, writing straight to remote D1). The same job also **rebuilds the `kritikos_catalog` search index**: Kritikos has no server-side search, and scanning its ~29 MB catalog on the edge blows the free-plan CPU budget (a 1102/5xx), so the off-edge job (no CPU limit) flattens the catalog into that table once a day and the edge answers Kritikos search with a cheap `LIKE` over ~8.5k rows (`searchKritikosCatalog` in `index.ts`). This makes the local job the **single writer** to both `price_history` and `kritikos_catalog` — do not re-enable the edge cron without accounting for write races. See `apps/worker/scripts/README.md`.

**Frontend has no router.** `apps/web/src/App.tsx` is a view state machine (`view: 'home' | 'results' | 'product' | 'add' | 'stores'`) driving `views/*`. Product data comes from one TanStack Query (`['products']`) invalidated after every mutation. Barcode scans resolve via Open Food Facts (`GET /api/barcode/:ean`), memoized in the `barcode_cache` D1 table.

## Conventions

- **Yoda conditionals, consistently.** The whole codebase writes the constant on the left: `null === x`, `0 === arr.length`, `false === response.ok`, `'add' === view`. Match this — it is not accidental.
- **`RetailerId` is exhaustive by construction.** Adding a chain means extending the union in `packages/core/src/types.ts`; literals like `RETAILER_PRESENCE` in the client are typed `Record<RetailerId, true>` so they fail to compile until the new chain is handled everywhere.
- **Comments explain *why*, densely.** Non-obvious decisions (CPU-budget fan-out, WAF workaround, cache TTLs, per-retailer quirks) carry paragraph-length rationale. Preserve and extend that when touching those areas.
- **No migration framework.** `apps/worker/schema.sql` is idempotent (`CREATE TABLE IF NOT EXISTS`); new columns on existing DBs need a manual `ALTER TABLE` (SQLite has no `ADD COLUMN IF NOT EXISTS`). FK cascades (`retailer_listings→products`, `price_history→listing`) exist, but delete handlers in `index.ts` also delete children explicitly so removal never depends on FK enforcement being on.
- **Per-retailer scraping gotchas** are documented at length in `README.md` (Retailer adapters section) — read it before editing any adapter; each chain has hard-won quirks (persisted-query hashes, CSRF headers, promo-price recomputation, weight-priced items with null piece price).

## Hard constraints

- **Cloudflare Workers Free plan only.** Never suggest or introduce paid features (larger CPU limits, paid D1 tiers, etc.). Much of the fan-out/scrape architecture exists specifically to stay within free-tier limits.

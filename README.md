# Τιμούλα — Grocery Price Tracker

**Τιμούλα** (a play on _τιμή_, "price" — the affectionate diminutive doubles as a
friendly first name, so the app is "little Miss Price" who finds you the best
deal) is a Greek-language PWA tracking daily prices for the same product across
Greek supermarkets (Sklavenitis, AB Vassilopoulos, Masoutis, My Market, Kritikos,
Galaxias, and Lidl offers). The UI ships in Greek; this README stays in English as
developer docs.

## Stack

- **Web**: Vite + React 19 + TypeScript + Tailwind v4, `vite-plugin-pwa` (Workbox), TanStack Query, Recharts
- **API + host**: Cloudflare Worker (Hono) + D1; the same Worker also serves the built PWA (`apps/web/dist`) as static assets, so the site and `/api/*` share one origin
- **Daily scrape**: a launchd job on a **residential IP** (`apps/worker/scripts/`) writes prices straight to the remote D1 — retailer WAFs block Cloudflare Worker egress, so the edge cron is disabled
- **Shared**: `@grocery/core` (types, normalization, fuzzy matcher), `@grocery/scrapers` (adapter per retailer)

## Product identity model

Retailer SKUs are internal and never match across chains (`1599382` @ Sklavenitis vs `7703411` @ AB for the same granola). Identity lives in **your `products` table**:

- `products.ean` — canonical when known (scan the physical barcode in the PWA).
  Worth capturing: it resolves the exact product at Galaxias (SKU = EAN),
  Kritikos (`barcodes[]`), Masoutis and My Market (their search accepts
  barcodes) — bypassing fuzzy title matching entirely, which retailers
  defeat with abbreviations ("H.Η.ΓΚΡΑΝΟΛΑ ΦΥΣΤΙΚ/ΤΥΡΟ ΜΑΥΡ.ΣΟΚ.")
- `retailer_listings (retailer, retailer_sku)` — deterministic join key per store after you map once
- `@grocery/core/match` — brand + size hard gates, token-Jaccard ranking; a **suggester**, never an auto-linker

## Setup

```bash
npm install

# D1
npx wrangler d1 create grocery-prices          # paste id into apps/worker/wrangler.toml
npm run db:migrate:local                        # local dev DB
npm run db:migrate:remote                       # production DB

# One-off, only on DBs created before products.image_url existed
# (SQLite has no ADD COLUMN IF NOT EXISTS — skip if already present):
npx wrangler d1 execute grocery-prices --local  --command "ALTER TABLE products ADD COLUMN image_url TEXT"
npx wrangler d1 execute grocery-prices --remote --command "ALTER TABLE products ADD COLUMN image_url TEXT"

# Dev (two terminals)
npm run dev:worker                              # wrangler dev → :8787
npm run dev:web                                 # vite → :5173, proxies /api → :8787

# Tests / typecheck
npm test
npm run typecheck

# Deploy
npm run deploy                                  # worker deploy + web build
```

`npm run deploy` builds the PWA to `apps/web/dist` and runs `wrangler deploy`;
the Worker serves those static assets **and** handles `/api/*` from the same
origin (see `[assets]` in `apps/worker/wrangler.toml`) — no separate Cloudflare
Pages project or route needed.

Brand + PWA icons: the Τιμούλα logomark and handwritten wordmark live in
`apps/web/src/components/BrandLogo.tsx` (used in the header and Home hero). The
installed-app icons — `pwa-192.png`, `pwa-512.png`, `pwa-maskable-512.png`,
`apple-touch-icon.png`, `favicon.svg` — ship in `apps/web/public/`; regenerate
them with `python3 apps/web/scripts/generate-icons.py` (needs Pillow).

## Adding products

Type brand + title in the PWA and hit **Find at retailers** — all adapters
search live, results are ranked by `@grocery/core/match` (brand + size hard
gates), the top match per retailer is preselected, and saving links the
listings and scrapes today's prices immediately.
(Kritikos search reads a D1 index the off-edge daily scrape rebuilds — see
the Kritikos row under **Retailer adapters** for why.)

**Editing & removing**: a product's own page has a collapsible edit panel to
rename it (title/brand/size), unlink a store that was matched wrong, or delete
the product entirely behind a two-tap confirm. Backed by `PATCH`/`DELETE
/api/products/:id` and `DELETE /api/products/:id/listings/:listingId`; deletes
cascade to price history.

**Scan-to-prefill**: a barcode alone is enough — no title needed. Scanning
(or pasting an EAN) resolves the product's name and brand from **Open Food
Facts** (`GET /api/barcode/:ean`, proxied so we send a proper User-Agent, and
**cached in D1** — see `barcode_cache` below), then runs the normal
cross-chain search with the recovered title. OFF has
clean Greek names (`product_name_el`) for annotated products but leaves many
Greek barcodes as photo-only stubs, so a null name falls back to the fast
barcode-capable chains (Galaxias `sku=EAN`, My Market and Masoutis resolve
the EAN as search text). OFF also yields a product image — kept as a
fallback when no retailer listing carries one. Data is ODbL-licensed
(openfoodfacts.org).

The `barcode_cache` table memoizes these lookups so each EAN hits OFF at most
once — resolved names stay 90 days, misses/stubs only 14 (so a barcode that
later gets annotated is re-checked). It's a pure cache, safe to drop.
Production DBs pick it up by re-running `npm run db:migrate:remote` (a new
`CREATE TABLE IF NOT EXISTS` — no manual `ALTER` this time).

## Product images

One shot per product (`products.image_url`), **hotlinked** from the
retailer CDN — no bytes stored, and `ProductImage` falls back to the
existing hatch/initials placeholder when a product has no image or the
CDN rejects the hotlink. It's captured at save time from the best-scored
confirmed pick that carries one, then kept fresh/backfilled by the daily
scrape (`UPDATE ... WHERE image_url IS NULL`, so a value is never
clobbered). Which chains supply it (verified live 2026-07-06):

| Retailer | Source | In search? | On scrape? |
|---|---|---|---|
| AB | tile `images[]` (PRIMARY, relative → absolutized) | ✅ | ✅ |
| Galaxias | `small_image.url` (Magento `/placeholder/` filtered out) | ✅ | ✅ |
| Kritikos | catalog `images.baseUrl + images.primary` | ✅ | ✅ |
| My Market | product-page JSON-LD `image` (ImageObject) | — tiles omit it | ✅ |
| Lidl | product-page JSON-LD `image` | via EAN-resolve only | ✅ |
| Sklavenitis, Masoutis | no verified image field yet | — | — |

Because most products are linked across chains, the search-time trio
(AB/Galaxias/Kritikos) covers the common case immediately; the rest fill
in on the first scrape after saving.

Search is multi-pass (`apps/web/src/lib/matching.ts`): full brand+title
query first; a brand-only retry for chains whose engines AND every token
and return nothing for long titles (Sklavenitis, Masoutis); and when a
≥60% match carries a barcode, an EAN re-query of the barcode-capable
chains. Escape hatch for products a chain's search index omits entirely
(observed live: an unavailable Skip on Sklavenitis had a product page but
appeared in no query): paste the product-page URL in a product's
"Update retailers" panel — `POST /api/resolve-url` resolves it through
the adapter and links it directly.

## Retailer adapters

Each adapter implements `searchProducts(query)` (discovery) and
`scrapeProduct(url, fetch, hints)` (daily prices).

| Retailer | Strategy | Status |
|---|---|---|
| Sklavenitis | Search + product pages are server-rendered; tiles via `h4.product__title`, prices as `3,14 €<span>/τεμ.</span>` literals (tags between `€` and label) | Verified live 2026-07-05 |
| AB | GraphQL gateway (`/api/v1/`, persisted query `GetProductSearch`) answers plain GETs; tiles carry SKU, name, URL, brand and current prices, so it powers the daily scrape. **Akamai 403s Cloudflare's edge** and the API is blocked through any proxy, so — like Kritikos — the off-edge daily job crawls the whole catalog (empty-free-text `:relevance` SAP-Hybris browse, ~12k products) into the `ab_catalog` D1 table that the edge searches with a cheap `LIKE`; no residential proxy on the edge | Verified live 2026-07-07 |
| Masoutis | Angular shell over an ASP.NET JSON API: `GET /api/eshop/GetCred` hands out anonymous `Uid/Usl/Key` headers, then POSTs to `GetOfferItemCustWithCoupons` (by item code from the page URL's `?<digits>=`) and `SearchAllItemsWithCouponsV2` | Verified live 2026-07-05 |
| My Market | Laravel, fully server-rendered: JSON-LD `@graph` Product on product pages, `measure-label-wrapper` for €/unit, search tiles carry sku/name/price in an analytics attribute. LiteSpeed cache serves up to 6h stale → scrape busts it with a query param | Verified live 2026-07-05 |
| Kritikos | Next.js SSG: product pages embed full product JSON (`__NEXT_DATA__`, prices in euro-cents). **No server-side search** — so the ~29 MB catalog API is streamed and brace-scanned against greeklish-transliterated `searchTerms` **off-edge** (that scan blows the Workers free-plan CPU budget), and the off-edge daily scrape flattens it into the `kritikos_catalog` D1 table that the edge searches with a cheap `LIKE` | Verified live 2026-07-05 |
| Galaxias | Angular shell over Magento 2 GraphQL (`magento2.galaxias.shop/graphql`), unauthenticated: `products(filter:{sku:{eq}})` for the scrape, `products(search:)` for discovery; SKU = EAN-13 | Verified live 2026-07-05 |
| Lidl | Nuxt SSR + public search API (`/q/api/search`). **Promo-only**: lidl-hellas.gr lists weekly in-store offers, not a shelf catalog — listings track advertised promos and product pages churn with the promo calendar | Verified live 2026-07-05 |

### Per-retailer gotchas (learned the hard way)

- **Masoutis**: POSTs also need `"PassKey":"Sc@NnSh0p"` in the body — hardcoded
  in their JS bundle, so it can rotate on redeploys. Search field names lie:
  `Itemcode` = query text, `IfWeight` = page number.
- **My Market / Kritikos**: sold-by-weight products have no piece price — the
  adapters store `pricePiece = null` and the per-kg figure as `priceUnit`
  (My Market marks them with a "Τιμή Κιλού" name suffix; Kritikos with
  `isWeighed`).
- **Lidl**: search 406s on `Accept: application/json` (send `*/*`), numeric
  queries answer a redirect envelope, and each product carries a second
  starred Lidl-Plus-app price the adapter deliberately ignores.
- **Galaxias**: leaflet promos ("ΦΥΛΛΑΔΙΟ") are NOT in `final_price` — the
  storefront applies `catalog_rules` client-side (percent + guarded fixed
  discounts, floor-to-cents). The adapter mirrors that algorithm; without it
  promo prices read ~25% high. `cost_per_unit`/`unit_measurement` are null on
  many items (multipacks) — piece price only for those.

### AB gotchas (learned the hard way)

- GETs need an `x-apollo-operation-name` header or Apollo's CSRF guard 400s.
- The gateway 400s numeric-only queries, so there is no scrape-by-SKU:
  `scrapeProduct` searches by product title (`hints.productTitle`, passed by
  the worker from `products.title`) and picks the result with the matching code.
- The persisted-query sha256 is pinned in `packages/scrapers/src/ab.ts`; if AB
  rotates it the adapter throws with "hash may have rotated" — re-capture it
  from DevTools → Network while searching on ab.gr.
- AB spells "Φυστικοβούτυρο" (Sklavenitis: "Φιστικοβούτυρο") — token matching
  survives this only because the remaining tokens carry the score; keep it in
  mind when match percentages look lower than expected.

**WAF note**: retailers block Cloudflare datacenter egress IPs, so the Worker cron got 403/503s. This is already handled — the daily scrape runs off-edge from a residential IP (`apps/worker/scripts/scrape-local.ts` via launchd), reusing the Worker's adapters and writing straight to the remote D1, with the edge cron in `wrangler.toml` disabled. See `apps/worker/scripts/README.md` for the launchd setup.

## Alternative data source worth probing

`e-katanalotis.gov.gr` (ministry price observatory) already matches products **by barcode across chains**. If its API is usable, it replaces both adapters and gives you EANs for free.

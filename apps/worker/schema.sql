CREATE TABLE IF NOT EXISTS products (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ean        TEXT UNIQUE,
    brand      TEXT NOT NULL,
    title      TEXT NOT NULL,
    size_value REAL,
    size_unit  TEXT,
    image_url  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- image_url was added after launch; existing databases need this once.
-- (SQLite has no ADD COLUMN IF NOT EXISTS — safe to ignore "duplicate
-- column" when re-running against a DB that already has it.)
-- ALTER TABLE products ADD COLUMN image_url TEXT;

CREATE TABLE IF NOT EXISTS retailer_listings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id   INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    retailer     TEXT NOT NULL,
    retailer_sku TEXT NOT NULL,
    url          TEXT NOT NULL,
    UNIQUE (retailer, retailer_sku)
);

CREATE TABLE IF NOT EXISTS price_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id   INTEGER NOT NULL REFERENCES retailer_listings (id) ON DELETE CASCADE,
    scraped_date TEXT NOT NULL,
    scraped_at   TEXT NOT NULL,
    price_piece  REAL,
    price_unit   REAL,
    unit_label   TEXT,
    UNIQUE (listing_id, scraped_date)
);

CREATE INDEX IF NOT EXISTS idx_price_history_listing
    ON price_history (listing_id, scraped_date);

-- Memoized Open Food Facts barcode lookups. Product data is near-static,
-- so a scanned EAN is fetched from OFF once and served locally after.
-- `found` = 1 when a name was resolved; negatives are cached too (with a
-- shorter re-check window) so we neither re-hit OFF on every scan nor miss
-- a stub that later gets annotated. This table is a pure cache — safe to
-- drop and let it repopulate.
CREATE TABLE IF NOT EXISTS barcode_cache (
    ean       TEXT PRIMARY KEY,
    name      TEXT,
    brand     TEXT,
    quantity  TEXT,
    image_url TEXT,
    source    TEXT NOT NULL DEFAULT 'openfoodfacts',
    found     INTEGER NOT NULL,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Memoized retailer search results, keyed by (retailer, query, EAN hint).
-- Its reason for existing is cost: the chains flagged needsResidentialEgress
-- fan out through a paid residential scraping API (see residential-fetch.ts),
-- so serving a repeat query from here instead of re-hitting the provider is
-- what keeps usage inside the free tier (it also spares every chain a live
-- round-trip). Catalog listings change slowly, so a short TTL — enforced in
-- the read query, not stored — keeps discovery fresh enough. Only successful
-- results are ever written, so a blocked/transient chain never caches a miss.
-- Pure cache: safe to drop and let it repopulate; if the table is missing
-- entirely, search still works — the helpers swallow the error and fetch live.
CREATE TABLE IF NOT EXISTS search_cache (
    retailer  TEXT NOT NULL,
    query     TEXT NOT NULL,
    ean       TEXT NOT NULL DEFAULT '',
    results   TEXT NOT NULL,
    cached_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (retailer, query, ean)
);

-- Kritikos discovery index. Kritikos ships NO server-side search: the site
-- downloads its entire ~29 MB catalog and filters in the browser. Replicating
-- that on the edge means fetching 29 MB through the paid residential proxy and
-- scanning it in-invocation, which blows the Workers free-plan CPU budget (a
-- 1102/5xx) — so the edge can't do it. Instead the off-edge daily scrape
-- (residential IP, no CPU limit — scripts/scrape-local.ts) flattens the catalog
-- into these rows once a day, and the edge answers a search with a cheap
-- `haystack LIKE ?` over ~8.5k rows (no proxy fetch, trivial CPU).
--
-- `haystack` is the product's lowercased greeklish searchTerms (the LIKE
-- target); `barcodes` is pipe-delimited (|a|b|) so an EAN hint matches exactly
-- via LIKE '%|<ean>|%' without crossing barcode boundaries; `url` is prebuilt so
-- a row maps straight to a search result. `indexed_at` is set to the run's
-- timestamp on every upsert, so rows a later run doesn't re-touch (products
-- pulled from the catalog) are pruned by a trailing DELETE.
--
-- Pure cache: safe to drop and let the next scrape repopulate. If the table is
-- missing entirely (not migrated yet), Kritikos search degrades to no results —
-- the edge query swallows the error rather than 5xx-ing.
CREATE TABLE IF NOT EXISTS kritikos_catalog (
    sku         TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    haystack    TEXT NOT NULL,
    barcodes    TEXT NOT NULL DEFAULT '',
    ean         TEXT,
    price_piece REAL,
    price_unit  REAL,
    unit_label  TEXT,
    image_url   TEXT,
    indexed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AB discovery index. AB's Akamai WAF hard-blocks Cloudflare's egress IPs (403
-- on every Worker fetch) AND its GraphQL API is unreachable through the
-- residential proxy, so the edge could only reach AB via the paid Scrape.do
-- render tier (the priciest, slowest one). AB is SAP Hybris with an empty-
-- free-text catalog browse, so — exactly like kritikos_catalog above — the
-- off-edge daily scrape (residential IP, no block, no CPU limit) crawls AB's
-- whole ~12k-product catalog into these rows once a day, and the edge answers
-- AB search with a cheap `haystack LIKE ?` (searchAbCatalog in index.ts). No
-- proxy fetch, no render credits.
--
-- `haystack` is the folded brand + name (abHaystack — the same @grocery/core
-- comparison fold the client matcher uses, so an indexed row matches the same
-- queries); `url` is prebuilt so a row maps straight to a search result. No
-- barcode column: AB exposes no EAN. `indexed_at` is stamped on every upsert so
-- rows a later run doesn't re-touch (products dropped from the catalog) are
-- pruned by a trailing DELETE.
--
-- Pure cache: safe to drop and let the next scrape repopulate. Missing/empty →
-- searchAbCatalog returns null and the edge falls back to the live search rather
-- than 5xx-ing.
CREATE TABLE IF NOT EXISTS ab_catalog (
    sku         TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    haystack    TEXT NOT NULL,
    brand       TEXT,
    price_piece REAL,
    price_unit  REAL,
    unit_label  TEXT,
    image_url   TEXT,
    indexed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

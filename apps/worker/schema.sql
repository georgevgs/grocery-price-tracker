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

-- product_id is the FK joined/filtered on by every listing read, the two
-- delete handlers, and the daily scrape's JOIN; without this it's a full scan.
CREATE INDEX IF NOT EXISTS idx_retailer_listings_product
    ON retailer_listings (product_id);

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
-- into these rows once a day, and the edge answers a search from the BM25-ranked
-- kritikos_catalog_fts index below (LIKE-scan fallback) over ~8.5k rows (no proxy
-- fetch, trivial CPU).
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
-- AB search from the BM25-ranked ab_catalog_fts index (searchAbCatalog in
-- index.ts, LIKE-scan fallback). No proxy fetch, no render credits.
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

-- Sklavenitis discovery index — same rationale as ab_catalog/kritikos_catalog,
-- added 2026-07-14 when sklavenitis.gr's WAF began intermittently 403-ing the
-- edge again (~24 search failures/day in prod, ~30% 403). The off-edge daily
-- scrape (residential IP, unblocked) crawls the whole catalog by walking the
-- CATEGORY pages — the Products sitemap lists only URLs, so category tiles are
-- the only bulk source of Greek names + SKUs — and the edge answers search with
-- the BM25-ranked sklavenitis_catalog_fts index (searchSklavenitisCatalog in
-- index.ts, LIKE-scan fallback). No live edge
-- egress, so the whole live-search failure tail goes away, not only the 403s.
--
-- DISCOVERY-ONLY: only sku/name/url/haystack are populated. Sklavenitis stays
-- LIVE-priced (its listings are scraped per product page daily), so brand/price/
-- image_url stay NULL here — the price columns exist only to mirror ab_catalog's
-- shape so the row-read path is uniform. `haystack` is the folded name
-- (sklavenitisHaystack) and `url` is the prebuilt product URL a search row maps
-- straight to. `indexed_at` drives the same upsert-then-prune-stale contract.
-- Only SEARCH reads this table; a pasted URL still resolves via a live scrape,
-- because resolve's price seeds the new listing and this price-less index can't
-- supply it (unlike ab_catalog/kritikos_catalog, which carry prices).
--
-- Pure cache: safe to drop and let the next scrape repopulate. Missing/empty →
-- searchSklavenitisCatalog returns [] and the edge falls back to live search.
CREATE TABLE IF NOT EXISTS sklavenitis_catalog (
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

-- Full-text search indexes over the three catalogs' `haystack` columns. These
-- exist to fix the retrieval flaw that the plain `haystack LIKE '%tok%'` scan had
-- NO relevance ranking: it took an arbitrary `LIMIT 100` in rowid order, so a
-- broad query (e.g. brand-only over a prolific brand) could truncate away the
-- one row the user wanted before it was ever ranked. FTS5 ranks by BM25 (which
-- is TF·IDF — it also gives us the corpus-derived term weighting the pairwise
-- matcher can't), so the edge asks for the MOST RELEVANT N, not an arbitrary N.
--
-- EXTERNAL-CONTENT (`content='…'`): the index stores no text of its own, only
-- postings into the base table's rowid — cheap, and the base row supplies every
-- returned column. It MUST stay in lock-step with the base table, which is why:
--
--   1. The daily writer UPSERTs (INSERT … ON CONFLICT(sku) DO UPDATE), NOT
--      INSERT OR REPLACE. REPLACE deletes+reinserts the row under a NEW rowid,
--      and — with PRAGMA recursive_triggers OFF, which is D1's default — the
--      REPLACE-induced DELETE does NOT fire the AFTER DELETE trigger, orphaning
--      the old posting and corrupting the index over time. UPSERT keeps the
--      rowid stable and fires the AFTER UPDATE trigger, which resyncs cleanly.
--      (See scrape-local.ts — do not revert the writer to REPLACE.)
--
--   2. The 'rebuild' below backfills the index from rows that already existed
--      when this migration first ran (triggers only fire on FUTURE writes), and
--      re-runs harmlessly on every idempotent migrate, repairing any drift.
--
-- The tokenizer runs over the already-folded haystack, so it only has to split
-- on whitespace/punctuation; the fold (foldHaystack / greeklish) has done the
-- diacritic/homoglyph/iota work already. Pure cache like the base tables: safe to
-- drop and let the next migrate 'rebuild' + next scrape repopulate. If a table is
-- missing entirely (not migrated yet), the edge's MATCH query throws and the
-- search helpers fall back to the LIKE scan, so search never 5xx-es.

CREATE VIRTUAL TABLE IF NOT EXISTS ab_catalog_fts USING fts5(
    haystack,
    content='ab_catalog',
    tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS ab_catalog_ai AFTER INSERT ON ab_catalog BEGIN
    INSERT INTO ab_catalog_fts (rowid, haystack) VALUES (new.rowid, new.haystack);
END;
CREATE TRIGGER IF NOT EXISTS ab_catalog_ad AFTER DELETE ON ab_catalog BEGIN
    INSERT INTO ab_catalog_fts (ab_catalog_fts, rowid, haystack) VALUES ('delete', old.rowid, old.haystack);
END;
CREATE TRIGGER IF NOT EXISTS ab_catalog_au AFTER UPDATE ON ab_catalog BEGIN
    INSERT INTO ab_catalog_fts (ab_catalog_fts, rowid, haystack) VALUES ('delete', old.rowid, old.haystack);
    INSERT INTO ab_catalog_fts (rowid, haystack) VALUES (new.rowid, new.haystack);
END;
INSERT INTO ab_catalog_fts (ab_catalog_fts) VALUES ('rebuild');

CREATE VIRTUAL TABLE IF NOT EXISTS kritikos_catalog_fts USING fts5(
    haystack,
    content='kritikos_catalog',
    tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS kritikos_catalog_ai AFTER INSERT ON kritikos_catalog BEGIN
    INSERT INTO kritikos_catalog_fts (rowid, haystack) VALUES (new.rowid, new.haystack);
END;
CREATE TRIGGER IF NOT EXISTS kritikos_catalog_ad AFTER DELETE ON kritikos_catalog BEGIN
    INSERT INTO kritikos_catalog_fts (kritikos_catalog_fts, rowid, haystack) VALUES ('delete', old.rowid, old.haystack);
END;
CREATE TRIGGER IF NOT EXISTS kritikos_catalog_au AFTER UPDATE ON kritikos_catalog BEGIN
    INSERT INTO kritikos_catalog_fts (kritikos_catalog_fts, rowid, haystack) VALUES ('delete', old.rowid, old.haystack);
    INSERT INTO kritikos_catalog_fts (rowid, haystack) VALUES (new.rowid, new.haystack);
END;
INSERT INTO kritikos_catalog_fts (kritikos_catalog_fts) VALUES ('rebuild');

CREATE VIRTUAL TABLE IF NOT EXISTS sklavenitis_catalog_fts USING fts5(
    haystack,
    content='sklavenitis_catalog',
    tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS sklavenitis_catalog_ai AFTER INSERT ON sklavenitis_catalog BEGIN
    INSERT INTO sklavenitis_catalog_fts (rowid, haystack) VALUES (new.rowid, new.haystack);
END;
CREATE TRIGGER IF NOT EXISTS sklavenitis_catalog_ad AFTER DELETE ON sklavenitis_catalog BEGIN
    INSERT INTO sklavenitis_catalog_fts (sklavenitis_catalog_fts, rowid, haystack) VALUES ('delete', old.rowid, old.haystack);
END;
CREATE TRIGGER IF NOT EXISTS sklavenitis_catalog_au AFTER UPDATE ON sklavenitis_catalog BEGIN
    INSERT INTO sklavenitis_catalog_fts (sklavenitis_catalog_fts, rowid, haystack) VALUES ('delete', old.rowid, old.haystack);
    INSERT INTO sklavenitis_catalog_fts (rowid, haystack) VALUES (new.rowid, new.haystack);
END;
INSERT INTO sklavenitis_catalog_fts (sklavenitis_catalog_fts) VALUES ('rebuild');

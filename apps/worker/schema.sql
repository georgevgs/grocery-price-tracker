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

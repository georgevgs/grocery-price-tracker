import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type {
  CreateListingPayload,
  CreateProductPayload,
  ListingWithLatestPrice,
  PricePoint,
  ProductWithListings,
  RetailerId,
  RetailerSearchResult,
  UpdateProductPayload,
} from '@grocery/core/types';
import { adapterRegistry } from '@grocery/scrapers/registry';
import { queryTokens } from '@grocery/scrapers/kritikos';
import { abQueryTokens } from '@grocery/scrapers/ab';
import type { RetailerAdapter, SearchHints } from '@grocery/scrapers/types';
import { athensDate, runScrape, type Env } from './scrape';
import { makeResidentialFetch } from './residential-fetch';
import { lookupBarcode, type BarcodeInfo } from './openfoodfacts';

interface ProductRow {
  id: number;
  ean: string | null;
  brand: string;
  title: string;
  size_value: number | null;
  size_unit: string | null;
  image_url: string | null;
}

interface ListingLatestRow {
  id: number;
  product_id: number;
  retailer: string;
  retailer_sku: string;
  url: string;
  scraped_date: string | null;
  price_piece: number | null;
  price_unit: number | null;
  unit_label: string | null;
}

interface HistoryRow {
  listing_id: number;
  retailer: string;
  scraped_date: string;
  price_piece: number | null;
  price_unit: number | null;
  unit_label: string | null;
}

interface BarcodeCacheRow {
  name: string | null;
  brand: string | null;
  quantity: string | null;
  image_url: string | null;
  found: number;
  is_fresh: number;
}

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

app.get('/', (c) => {
  return c.json({
    service: 'grocery-price-tracker-api',
    hint: 'API only — the PWA runs on the Vite dev server (http://localhost:5173)',
    endpoints: [
      'GET /api/health',
      'GET /api/products',
      'GET /api/products/:id/history',
      'GET /api/retailer-search?q=<title>',
      'GET /api/barcode/:ean',
      'POST /api/products',
      'PATCH /api/products/:id',
      'DELETE /api/products/:id',
      'DELETE /api/products/:id/listings/:listingId',
      'POST /api/scrape/run',
    ],
  });
});

app.get('/api/health', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1 FROM products LIMIT 1').run();
    return c.json({ ok: true, db: 'migrated' });
  } catch {
    return c.json({ ok: false, db: 'missing tables — run: npm run db:migrate:local' }, 500);
  }
});

app.get('/api/products', async (c) => {
  const [productsResult, listingsResult] = await Promise.all([
    c.env.DB.prepare('SELECT id, ean, brand, title, size_value, size_unit, image_url FROM products').all<ProductRow>(),
    c.env.DB.prepare(
      `SELECT l.id, l.product_id, l.retailer, l.retailer_sku, l.url,
              ph.scraped_date, ph.price_piece, ph.price_unit, ph.unit_label
       FROM retailer_listings l
       LEFT JOIN price_history ph ON ph.listing_id = l.id
         AND ph.scraped_date = (
           SELECT MAX(scraped_date) FROM price_history WHERE listing_id = l.id
         )`,
    ).all<ListingLatestRow>(),
  ]);

  const listingsByProduct = groupListingsByProduct(listingsResult.results);

  const products: ProductWithListings[] = productsResult.results.map((row) => {
    const listings = listingsByProduct.get(row.id);

    return {
      id: row.id,
      ean: row.ean,
      brand: row.brand,
      title: row.title,
      sizeValue: row.size_value,
      sizeUnit: row.size_unit,
      imageUrl: row.image_url,
      listings: listings ?? [],
    };
  });

  return c.json(products);
});

app.get('/api/products/:id/history', async (c) => {
  const productId = Number(c.req.param('id'));

  if (Number.isNaN(productId)) {
    return c.json({ error: 'invalid product id' }, 400);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT ph.listing_id, l.retailer, ph.scraped_date, ph.price_piece, ph.price_unit, ph.unit_label
     FROM price_history ph
     JOIN retailer_listings l ON l.id = ph.listing_id
     WHERE l.product_id = ?
     ORDER BY ph.scraped_date ASC`,
  )
    .bind(productId)
    .all<HistoryRow>();

  const history = results.map((row) => {
    return {
      listingId: row.listing_id,
      retailer: row.retailer as RetailerId,
      scrapedDate: row.scraped_date,
      pricePiece: row.price_piece,
      priceUnit: row.price_unit,
      unitLabel: row.unit_label,
    };
  });

  return c.json(history);
});

app.get('/api/retailer-search', async (c) => {
  const query = c.req.query('q')?.trim() ?? '';

  if (query.length < 3) {
    return c.json({ error: 'q must be at least 3 characters' }, 400);
  }

  let adapters = [...adapterRegistry.values()];

  // ?retailers=lidl,masoutis limits the fan-out — used when linking an
  // existing product to only its not-yet-tracked chains.
  const retailersParam = c.req.query('retailers')?.trim();

  if (undefined !== retailersParam && 0 < retailersParam.length) {
    const wanted = new Set(retailersParam.split(',').map((id) => id.trim()));
    adapters = adapters.filter((adapter) => wanted.has(adapter.id));

    if (0 === adapters.length) {
      return c.json({ error: `no known retailers among "${retailersParam}"` }, 400);
    }
  }

  const rawEan = c.req.query('ean')?.trim();
  const eanHint = undefined !== rawEan && /^\d{8,14}$/.test(rawEan) ? rawEan : undefined;

  // Chains flagged needsResidentialEgress (AB, Kritikos, Sklavenitis) 403/503
  // from Cloudflare's edge, so route them through the residential scraping API
  // when a token is configured; everyone else uses the free global fetch.
  // AB additionally needs headless render (needsRenderedSearch) — its search API
  // is blocked through the proxy, so we render its search page and the adapter
  // parses the tiles (hints.rendered). Without a token the flagged chains just
  // fail into errors[] as before — search degrades, never crashes.
  const proxyToken = c.env.RESIDENTIAL_PROXY_TOKEN;
  const hasProxy = undefined !== proxyToken && 0 < proxyToken.length;

  const fetchFor = (adapter: RetailerAdapter): typeof fetch => {
    if (true !== adapter.needsResidentialEgress || undefined === proxyToken || 0 === proxyToken.length) {
      return fetch;
    }

    return makeResidentialFetch(proxyToken, { render: true === adapter.needsRenderedSearch });
  };

  const hintsFor = (adapter: RetailerAdapter): SearchHints => ({
    ean: eanHint,
    rendered: true === adapter.needsRenderedSearch && hasProxy,
  });

  // '' when no EAN hint — part of the cache key so an EAN-guided search (which
  // surfaces the exact product first) never collides with the plain query. The
  // rendered/direct transport is NOT part of the key: both paths yield the same
  // listings, so a cache entry is reusable regardless of how it was fetched.
  const eanKey = eanHint ?? '';

  const searchOne = async (adapter: RetailerAdapter): Promise<RetailerSearchResult[]> => {
    // Kritikos has no server-side search: its live adapter downloads the whole
    // ~29 MB catalog and scans it in-invocation, which blows the Workers
    // free-plan CPU budget on the edge (a 1102/5xx) and re-fetches 29 MB through
    // the paid proxy on every retry pass. So the edge doesn't run it — it reads
    // the D1 discovery index the off-edge daily scrape builds instead (a cheap
    // LIKE over ~8.5k rows). No proxy fetch, so no residential-fetch cache to
    // consult; the query itself is the cheap part.
    if ('kritikos' === adapter.id) {
      return searchKritikosCatalog(c.env, query, eanHint);
    }

    // AB: same off-edge D1-index treatment as Kritikos (its Akamai WAF 403s the
    // edge and its API is blocked through the proxy too, so live edge search
    // means the priciest Scrape.do render tier). searchAbCatalog returns null
    // until the daily crawl has populated ab_catalog, so during rollout we fall
    // through to the live proxy search; once populated it serves AB for free.
    if ('ab' === adapter.id) {
      const indexed = await searchAbCatalog(c.env, query);

      if (null !== indexed) {
        return indexed;
      }
    }

    const cached = await readSearchCache(c.env, adapter.id, query, eanKey);

    if (null !== cached) {
      return cached;
    }

    // A throw here (blocked/failed chain) skips the write below and surfaces in
    // errors[], so failures always retry live and never poison the cache.
    const found = await adapter.searchProducts(query, fetchFor(adapter), hintsFor(adapter));
    await writeSearchCache(c.env, adapter.id, query, eanKey, found);
    return found;
  };

  const outcomes = await Promise.allSettled(adapters.map(searchOne));

  const results: Partial<Record<RetailerId, RetailerSearchResult[]>> = {};
  const errors: string[] = [];

  outcomes.forEach((outcome, index) => {
    const adapter = adapters[index];

    if (undefined === adapter) {
      return;
    }

    if ('fulfilled' === outcome.status) {
      results[adapter.id] = outcome.value;
    } else {
      errors.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
    }
  });

  return c.json({ results, errors });
});

/**
 * Resolve a scanned barcode to a product name/brand via Open Food Facts —
 * the scan-to-prefill identity source, proxied here so we send a proper
 * User-Agent and keep the client simple. Results are cached in D1
 * (barcode_cache): product data is near-static, so each EAN hits OFF once
 * and is served locally after. Returns nulls (never errors) when the
 * barcode is unknown, so the web falls back to the retailer chains.
 */
app.get('/api/barcode/:ean', async (c) => {
  const ean = c.req.param('ean');

  if (false === /^\d{8,14}$/.test(ean)) {
    return c.json({ error: 'ean must be 8-14 digits' }, 400);
  }

  const cached = await readBarcodeCache(c.env, ean);

  if (null !== cached && 1 === cached.is_fresh) {
    return c.json(cacheRowToInfo(cached));
  }

  const info = await lookupBarcode(ean, fetch);

  // OFF gave no name this time — keep a previously cached name rather than
  // clobbering it with an empty result (OFF may be transiently down, or the
  // product simply isn't annotated yet). The stale row's short re-check
  // window means we'll try OFF again on the next scan.
  if (null === info.name && null !== cached && null !== cached.name) {
    return c.json(cacheRowToInfo(cached));
  }

  await writeBarcodeCache(c.env, ean, info);
  return c.json(info);
});

/**
 * Seed today's price_history for freshly linked listings from the price the
 * client already observed (search tile / resolve-url). Without this, the price
 * shown after saving depends on the immediate /api/scrape/run, which runs on the
 * edge with a plain fetch and so 403/503s on the WAF-blocked chains (AB,
 * Kritikos, Sklavenitis) — they'd read "—" until the next off-edge daily scrape.
 *
 * Resolves each listing's id by its (product_id, retailer, retailer_sku) unique
 * key via INSERT…SELECT, so it works whether the listings were just batch- or
 * OR-IGNORE-inserted. Listings with no price are skipped (the daily scrape fills
 * them); INSERT OR REPLACE keeps it idempotent with a same-day scrape.
 */
const seedListingPrices = async (
  env: Env,
  productId: number,
  listings: readonly CreateListingPayload[],
): Promise<void> => {
  const scrapedDate = athensDate();
  const scrapedAt = new Date().toISOString();

  const statements: D1PreparedStatement[] = [];

  for (const listing of listings) {
    const pricePiece = listing.pricePiece ?? null;
    const priceUnit = listing.priceUnit ?? null;

    // Nothing observed → let the daily scrape record the first price.
    if (null === pricePiece && null === priceUnit) {
      continue;
    }

    statements.push(
      env.DB.prepare(
        'INSERT OR REPLACE INTO price_history ' +
          '(listing_id, scraped_date, scraped_at, price_piece, price_unit, unit_label) ' +
          'SELECT id, ?, ?, ?, ?, ? FROM retailer_listings ' +
          'WHERE product_id = ? AND retailer = ? AND retailer_sku = ?',
      ).bind(
        scrapedDate,
        scrapedAt,
        pricePiece,
        priceUnit,
        listing.unitLabel ?? null,
        productId,
        listing.retailer,
        listing.retailerSku,
      ),
    );
  }

  if (0 < statements.length) {
    await env.DB.batch(statements);
  }
};

app.post('/api/products', async (c) => {
  const payload = await c.req.json<CreateProductPayload>();

  if ('string' !== typeof payload.brand || 0 === payload.brand.length) {
    return c.json({ error: 'brand is required' }, 400);
  }

  if ('string' !== typeof payload.title || 0 === payload.title.length) {
    return c.json({ error: 'title is required' }, 400);
  }

  const imageUrl = 'string' === typeof payload.imageUrl && 0 < payload.imageUrl.length ? payload.imageUrl : null;

  const insertProduct = await c.env.DB.prepare(
    'INSERT INTO products (ean, brand, title, size_value, size_unit, image_url) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(payload.ean, payload.brand, payload.title, payload.sizeValue, payload.sizeUnit, imageUrl)
    .run();

  const productId = insertProduct.meta.last_row_id;

  if (0 < payload.listings.length) {
    const statements = payload.listings.map((listing) => {
      return c.env.DB.prepare(
        'INSERT INTO retailer_listings (product_id, retailer, retailer_sku, url) VALUES (?, ?, ?, ?)',
      ).bind(productId, listing.retailer, listing.retailerSku, listing.url);
    });

    await c.env.DB.batch(statements);
    await seedListingPrices(c.env, Number(productId), payload.listings);
  }

  return c.json({ id: productId }, 201);
});

const RETAILER_HOSTS: ReadonlyArray<readonly [string, RetailerId]> = [
  ['sklavenitis.gr', 'sklavenitis'],
  ['ab.gr', 'ab'],
  ['lidl-hellas.gr', 'lidl'],
  ['masoutis.gr', 'masoutis'],
  ['mymarket.gr', 'mymarket'],
  ['kritikos-sm.gr', 'kritikos'],
  ['galaxias.shop', 'galaxias'],
];

/**
 * Resolve a pasted product-page URL into listing identity via the
 * matching adapter — the escape hatch for products a chain's search
 * index doesn't return (observed live on sklavenitis: the product page
 * exists but no query surfaces it).
 */
app.post('/api/resolve-url', async (c) => {
  const payload = await c.req.json<{ url: string; productTitle?: string }>();

  if ('string' !== typeof payload.url) {
    return c.json({ error: 'url is required' }, 400);
  }

  let parsed: URL;

  try {
    parsed = new URL(payload.url);
  } catch {
    return c.json({ error: 'not a valid URL' }, 400);
  }

  const host = parsed.hostname;
  const entry = RETAILER_HOSTS.find(
    ([suffix]) => host === suffix || host.endsWith(`.${suffix}`),
  );

  if (undefined === entry) {
    return c.json({ error: `no adapter for host "${host}"` }, 400);
  }

  const adapter = adapterRegistry.get(entry[1]);

  if (undefined === adapter) {
    return c.json({ error: `no adapter for retailer "${entry[1]}"` }, 400);
  }

  parsed.hash = '';
  const url = parsed.toString();

  // Same residential-egress routing as /api/retailer-search: a blocked chain's
  // product page 403s from the edge, so resolve it through the scraping API
  // when a token is set; unflagged chains stay on the free global fetch. AB's
  // search-driven scrape needs render mode + hints.rendered, exactly as search does.
  const proxyToken = c.env.RESIDENTIAL_PROXY_TOKEN;
  const canProxy =
    true === adapter.needsResidentialEgress && undefined !== proxyToken && 0 < proxyToken.length;
  const render = canProxy && true === adapter.needsRenderedSearch;
  const scrapeFetch =
    canProxy && undefined !== proxyToken ? makeResidentialFetch(proxyToken, { render }) : fetch;

  try {
    const scraped = await adapter.scrapeProduct(url, scrapeFetch, {
      productTitle: payload.productTitle,
      rendered: render,
    });

    if (null === scraped.sku) {
      return c.json({ error: 'page did not expose a SKU' }, 422);
    }

    return c.json({
      retailer: adapter.id,
      sku: scraped.sku,
      name: scraped.name,
      url,
      pricePiece: scraped.pricePiece,
      priceUnit: scraped.priceUnit,
      unitLabel: scraped.unitLabel,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'scrape failed';
    return c.json({ error: message }, 502);
  }
});

app.patch('/api/products/:id', async (c) => {
  const productId = Number(c.req.param('id'));

  if (Number.isNaN(productId)) {
    return c.json({ error: 'invalid product id' }, 400);
  }

  const payload = await c.req.json<UpdateProductPayload>();

  // Build the SET clause from only the keys the caller actually sent, so a
  // rename touches `title` without clobbering `ean`, and vice versa. An
  // omitted key is left as-is; an explicit `null` clears a nullable column.
  const columns: string[] = [];
  const values: (string | number | null)[] = [];

  if ('ean' in payload) {
    if (null !== payload.ean && ('string' !== typeof payload.ean || false === /^\d{8,14}$/.test(payload.ean))) {
      return c.json({ error: 'ean must be 8-14 digits or null' }, 400);
    }

    columns.push('ean = ?');
    values.push(payload.ean);
  }

  if ('brand' in payload) {
    if ('string' !== typeof payload.brand || 0 === payload.brand.trim().length) {
      return c.json({ error: 'brand must be a non-empty string' }, 400);
    }

    columns.push('brand = ?');
    values.push(payload.brand.trim());
  }

  if ('title' in payload) {
    if ('string' !== typeof payload.title || 0 === payload.title.trim().length) {
      return c.json({ error: 'title must be a non-empty string' }, 400);
    }

    columns.push('title = ?');
    values.push(payload.title.trim());
  }

  if ('sizeValue' in payload) {
    if (null !== payload.sizeValue && ('number' !== typeof payload.sizeValue || false === Number.isFinite(payload.sizeValue))) {
      return c.json({ error: 'sizeValue must be a number or null' }, 400);
    }

    columns.push('size_value = ?');
    values.push(payload.sizeValue);
  }

  if ('sizeUnit' in payload) {
    if (null !== payload.sizeUnit && 'string' !== typeof payload.sizeUnit) {
      return c.json({ error: 'sizeUnit must be a string or null' }, 400);
    }

    const unit = null === payload.sizeUnit ? null : payload.sizeUnit.trim();
    columns.push('size_unit = ?');
    values.push(null !== unit && 0 === unit.length ? null : unit);
  }

  if ('imageUrl' in payload) {
    if (null !== payload.imageUrl && 'string' !== typeof payload.imageUrl) {
      return c.json({ error: 'imageUrl must be a string or null' }, 400);
    }

    columns.push('image_url = ?');
    values.push(payload.imageUrl);
  }

  if (0 === columns.length) {
    return c.json({ error: 'no editable fields provided' }, 400);
  }

  try {
    const result = await c.env.DB.prepare(`UPDATE products SET ${columns.join(', ')} WHERE id = ?`)
      .bind(...values, productId)
      .run();

    if (0 === result.meta.changes) {
      return c.json({ error: `no product with id ${productId}` }, 404);
    }
  } catch (error) {
    // products.ean is UNIQUE — a duplicate means the barcode is already
    // on another tracked product.
    if (error instanceof Error && error.message.includes('UNIQUE')) {
      return c.json({ error: 'another product already has this EAN' }, 409);
    }

    throw error;
  }

  return c.json({ ok: true });
});

/**
 * Delete a product and everything hanging off it. The schema cascades
 * (listings → product, price_history → listing), but we delete children
 * first in an explicit batch so removal never depends on foreign-key
 * enforcement being on for the connection.
 */
app.delete('/api/products/:id', async (c) => {
  const productId = Number(c.req.param('id'));

  if (Number.isNaN(productId)) {
    return c.json({ error: 'invalid product id' }, 400);
  }

  const [, , productDelete] = await c.env.DB.batch([
    c.env.DB.prepare(
      'DELETE FROM price_history WHERE listing_id IN (SELECT id FROM retailer_listings WHERE product_id = ?)',
    ).bind(productId),
    c.env.DB.prepare('DELETE FROM retailer_listings WHERE product_id = ?').bind(productId),
    c.env.DB.prepare('DELETE FROM products WHERE id = ?').bind(productId),
  ]);

  // The product delete is the last statement; no rows changed means it
  // never existed.
  if (undefined === productDelete || 0 === productDelete.meta.changes) {
    return c.json({ error: `no product with id ${productId}` }, 404);
  }

  return c.json({ ok: true });
});

/**
 * Unlink one store from a product — the fix for a wrong fuzzy match. Scoped
 * to the product so a mismatched id can't delete a listing on another one;
 * its price history goes with it.
 */
app.delete('/api/products/:id/listings/:listingId', async (c) => {
  const productId = Number(c.req.param('id'));
  const listingId = Number(c.req.param('listingId'));

  if (Number.isNaN(productId) || Number.isNaN(listingId)) {
    return c.json({ error: 'invalid product or listing id' }, 400);
  }

  const [, listingDelete] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM price_history WHERE listing_id = ?').bind(listingId),
    c.env.DB.prepare('DELETE FROM retailer_listings WHERE id = ? AND product_id = ?').bind(
      listingId,
      productId,
    ),
  ]);

  if (undefined === listingDelete || 0 === listingDelete.meta.changes) {
    return c.json({ error: `no listing ${listingId} on product ${productId}` }, 404);
  }

  return c.json({ ok: true });
});

app.post('/api/products/:id/listings', async (c) => {
  const productId = Number(c.req.param('id'));

  if (Number.isNaN(productId)) {
    return c.json({ error: 'invalid product id' }, 400);
  }

  const payload = await c.req.json<{ listings: CreateListingPayload[] }>();

  if (false === Array.isArray(payload.listings) || 0 === payload.listings.length) {
    return c.json({ error: 'listings must be a non-empty array' }, 400);
  }

  for (const listing of payload.listings) {
    if (
      'string' !== typeof listing.retailer ||
      'string' !== typeof listing.retailerSku ||
      'string' !== typeof listing.url
    ) {
      return c.json({ error: 'each listing needs retailer, retailerSku and url' }, 400);
    }
  }

  const product = await c.env.DB.prepare('SELECT id FROM products WHERE id = ?')
    .bind(productId)
    .first();

  if (null === product) {
    return c.json({ error: `no product with id ${productId}` }, 404);
  }

  // OR IGNORE: re-linking an already-tracked (retailer, sku) is a no-op,
  // so the endpoint is safe to retry.
  const statements = payload.listings.map((listing) => {
    return c.env.DB.prepare(
      'INSERT OR IGNORE INTO retailer_listings (product_id, retailer, retailer_sku, url) VALUES (?, ?, ?, ?)',
    ).bind(productId, listing.retailer, listing.retailerSku, listing.url);
  });

  const outcomes = await c.env.DB.batch(statements);
  const added = outcomes.reduce((sum, outcome) => sum + outcome.meta.changes, 0);

  // Seed today's price for the linked listings from what the client observed.
  // Re-linking an already-tracked listing just refreshes today's price to the
  // same current value (harmless), so seeding all of them is fine.
  await seedListingPrices(c.env, productId, payload.listings);

  return c.json({ added }, 201);
});

app.post('/api/scrape/run', async (c) => {
  const result = await runScrape(c.env);
  return c.json(result);
});

const cacheRowToInfo = (row: BarcodeCacheRow): BarcodeInfo => {
  return {
    name: row.name,
    brand: row.brand,
    quantity: row.quantity,
    imageUrl: row.image_url,
  };
};

/**
 * A row is fresh while within its re-check window: a resolved name lasts
 * 90 days (product data barely changes); a miss/stub only 14, so a barcode
 * that later gets annotated on OFF gets picked up on a subsequent scan.
 */
const readBarcodeCache = async (env: Env, ean: string): Promise<BarcodeCacheRow | null> => {
  const row = await env.DB.prepare(
    `SELECT name, brand, quantity, image_url, found,
            (cached_at > datetime('now', CASE WHEN found = 1 THEN '-90 days' ELSE '-14 days' END)) AS is_fresh
     FROM barcode_cache
     WHERE ean = ?`,
  )
    .bind(ean)
    .first<BarcodeCacheRow>();

  return row ?? null;
};

const writeBarcodeCache = async (env: Env, ean: string, info: BarcodeInfo): Promise<void> => {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO barcode_cache
       (ean, name, brand, quantity, image_url, source, found, cached_at)
     VALUES (?, ?, ?, ?, ?, 'openfoodfacts', ?, datetime('now'))`,
  )
    .bind(ean, info.name, info.brand, info.quantity, info.imageUrl, null !== info.name ? 1 : 0)
    .run();
};

/**
 * How long a cached retailer search stays servable. Discovery listings change
 * slowly, so a few hours spares the residential scraping API most repeat
 * queries (the whole point — those chains bill per request) while keeping
 * results fresh enough. Enforced in the read below via datetime('now', ...).
 */
const SEARCH_CACHE_TTL = '-6 hours';

/**
 * Both helpers are best-effort: any DB error — most importantly the table not
 * being migrated yet — degrades to null/no-op so search always falls through to
 * a live fetch. Never throws into the search fan-out.
 */
const readSearchCache = async (
  env: Env,
  retailer: RetailerId,
  query: string,
  ean: string,
): Promise<RetailerSearchResult[] | null> => {
  try {
    const row = await env.DB.prepare(
      `SELECT results FROM search_cache
       WHERE retailer = ? AND query = ? AND ean = ?
         AND cached_at > datetime('now', ?)`,
    )
      .bind(retailer, query, ean, SEARCH_CACHE_TTL)
      .first<{ results: string }>();

    if (null === row || undefined === row) {
      return null;
    }

    const parsed: unknown = JSON.parse(row.results);
    return Array.isArray(parsed) ? (parsed as RetailerSearchResult[]) : null;
  } catch {
    return null;
  }
};

const writeSearchCache = async (
  env: Env,
  retailer: RetailerId,
  query: string,
  ean: string,
  results: RetailerSearchResult[],
): Promise<void> => {
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO search_cache (retailer, query, ean, results, cached_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
      .bind(retailer, query, ean, JSON.stringify(results))
      .run();
  } catch {
    // A cache write must never fail the search — swallow and move on.
  }
};

interface KritikosCatalogRow {
  sku: string;
  name: string;
  url: string;
  ean: string | null;
  price_piece: number | null;
  price_unit: number | null;
  unit_label: string | null;
  image_url: string | null;
}

const KRITIKOS_MAX_RESULTS = 100;
const KRITIKOS_COLUMNS = 'sku, name, url, ean, price_piece, price_unit, unit_label, image_url';

/** Escape LIKE metacharacters so a query token matches literally (ESCAPE '\'). */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

const kritikosRowToResult = (
  row: KritikosCatalogRow,
  matchedEan: string | null,
): RetailerSearchResult => ({
  retailer: 'kritikos',
  sku: row.sku,
  title: row.name,
  url: row.url,
  brand: null,
  ean: matchedEan ?? row.ean,
  pricePiece: row.price_piece,
  priceUnit: row.price_unit,
  unitLabel: row.unit_label,
  imageUrl: row.image_url,
});

/**
 * Answer a Kritikos search from the D1 discovery index (built off-edge — see
 * schema.sql and scrape-local.ts) instead of downloading the live 29 MB catalog
 * on the edge. An EAN hint matches exactly against the pipe-delimited barcodes
 * and ranks first (a barcode is identity — Kritikos's abbreviated titles often
 * defeat token matching); each text token becomes a `haystack LIKE ?` AND-term,
 * mirroring the live adapter's every-token substring rule. Best-effort: if the
 * table is missing (not migrated yet) or the query errors, return no results
 * rather than failing — this path must never 5xx (that was the whole problem).
 */
const searchKritikosCatalog = async (
  env: Env,
  query: string,
  ean: string | undefined,
): Promise<RetailerSearchResult[]> => {
  const tokens = queryTokens(query);
  const hasEan = undefined !== ean && 0 < ean.length;

  if (0 === tokens.length && false === hasEan) {
    return [];
  }

  try {
    const exact: RetailerSearchResult[] = [];

    if (hasEan && undefined !== ean) {
      const { results } = await env.DB.prepare(
        `SELECT ${KRITIKOS_COLUMNS} FROM kritikos_catalog
         WHERE barcodes LIKE ('%|' || ? || '|%') LIMIT ?`,
      )
        .bind(ean, KRITIKOS_MAX_RESULTS)
        .all<KritikosCatalogRow>();

      exact.push(...results.map((row) => kritikosRowToResult(row, ean)));
    }

    const text: RetailerSearchResult[] = [];

    if (0 < tokens.length) {
      const clause = tokens
        .map(() => `haystack LIKE ('%' || ? || '%') ESCAPE '\\'`)
        .join(' AND ');
      const { results } = await env.DB.prepare(
        `SELECT ${KRITIKOS_COLUMNS} FROM kritikos_catalog WHERE ${clause} LIMIT ?`,
      )
        .bind(...tokens.map(escapeLike), KRITIKOS_MAX_RESULTS)
        .all<KritikosCatalogRow>();

      text.push(...results.map((row) => kritikosRowToResult(row, null)));
    }

    // Exact-EAN matches lead; drop any text row that duplicates one.
    const seen = new Set(exact.map((result) => result.sku));

    return [...exact, ...text.filter((result) => false === seen.has(result.sku))];
  } catch {
    return [];
  }
};

interface AbCatalogRow {
  sku: string;
  name: string;
  url: string;
  brand: string | null;
  price_piece: number | null;
  price_unit: number | null;
  unit_label: string | null;
  image_url: string | null;
}

const AB_MAX_RESULTS = 100;
const AB_COLUMNS = 'sku, name, url, brand, price_piece, price_unit, unit_label, image_url';

const abRowToResult = (row: AbCatalogRow): RetailerSearchResult => ({
  retailer: 'ab',
  sku: row.sku,
  title: row.name,
  url: row.url,
  brand: row.brand,
  ean: null,
  pricePiece: row.price_piece,
  priceUnit: row.price_unit,
  unitLabel: row.unit_label,
  imageUrl: row.image_url,
});

/**
 * Answer an AB search from the D1 discovery index (built off-edge — schema.sql,
 * scrape-local.ts) instead of the paid Scrape.do render path. Each query token
 * becomes a `haystack LIKE ?` AND-term (same fold as the client matcher, via the
 * shared abQueryTokens), mirroring searchKritikosCatalog. AB carries no barcode,
 * so there is no EAN branch.
 *
 * Returns null — NOT [] — when the index is empty or the table is missing (not
 * crawled yet / not migrated), so searchOne can fall back to the live proxy
 * search during the rollout window. Once the daily job has populated ab_catalog,
 * this serves every AB search for free. A genuine no-match returns []. Never
 * throws — this path must not 5xx.
 */
const searchAbCatalog = async (
  env: Env,
  query: string,
): Promise<RetailerSearchResult[] | null> => {
  try {
    // Empty/unmigrated index → signal "fall back to live search" (null), never
    // a false "no products" ([]). One cheap probe row distinguishes the two.
    const probe = await env.DB.prepare('SELECT 1 FROM ab_catalog LIMIT 1').first();

    if (null === probe || undefined === probe) {
      return null;
    }

    const tokens = abQueryTokens(query);

    if (0 === tokens.length) {
      return [];
    }

    const clause = tokens
      .map(() => `haystack LIKE ('%' || ? || '%') ESCAPE '\\'`)
      .join(' AND ');
    const { results } = await env.DB.prepare(
      `SELECT ${AB_COLUMNS} FROM ab_catalog WHERE ${clause} LIMIT ?`,
    )
      .bind(...tokens.map(escapeLike), AB_MAX_RESULTS)
      .all<AbCatalogRow>();

    return results.map(abRowToResult);
  } catch {
    // Table missing (not migrated yet) or any query error → fall back to live.
    return null;
  }
};

const groupListingsByProduct = (
  rows: readonly ListingLatestRow[],
): Map<number, ListingWithLatestPrice[]> => {
  const grouped = new Map<number, ListingWithLatestPrice[]>();

  for (const row of rows) {
    const listing: ListingWithLatestPrice = {
      id: row.id,
      productId: row.product_id,
      retailer: row.retailer as RetailerId,
      retailerSku: row.retailer_sku,
      url: row.url,
      latestPrice: toPricePoint(row),
    };

    const existing = grouped.get(row.product_id);

    if (undefined === existing) {
      grouped.set(row.product_id, [listing]);
    } else {
      existing.push(listing);
    }
  }

  return grouped;
};

const toPricePoint = (row: ListingLatestRow): PricePoint | null => {
  if (null === row.scraped_date) {
    return null;
  }

  return {
    listingId: row.id,
    scrapedDate: row.scraped_date,
    pricePiece: row.price_piece,
    priceUnit: row.price_unit,
    unitLabel: row.unit_label,
  };
};

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(logScrapeRun(env));
  },
};

const logScrapeRun = async (env: Env): Promise<void> => {
  const result = await runScrape(env);
  console.log(
    `scrape complete: ${result.ok} ok, ${result.failed} failed, ${result.warnings.length} suspect`,
    result.errors,
    result.warnings,
  );
};

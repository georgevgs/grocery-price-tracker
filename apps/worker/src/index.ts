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
import { sklavenitisQueryTokens } from '@grocery/scrapers/sklavenitis';
import type { RetailerAdapter, SearchHints } from '@grocery/scrapers/types';
import { athensDate, edgeFetch, runScrape, type Env } from './scrape';
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

/**
 * Optional write guard. The API is public (the PWA is served same-origin and
 * calls it with relative URLs), but the mutating routes must not be an open
 * free-for-all — otherwise anyone can create, edit, delete or trigger a
 * scrape. When WRITE_TOKEN is configured, every non-GET request must present
 * it as a Bearer token; when it is unset the guard is inert, so a deployment
 * keeps working until the secret and the matching client header are rolled
 * out together. NOTE: a token baked into a public PWA bundle only deters
 * casual/automated abuse — Cloudflare Access in front of the Worker is the
 * real fix for a genuine multi-user threat model.
 */
app.use('/api/*', async (c, next) => {
  const method = c.req.method;

  if ('GET' === method || 'HEAD' === method || 'OPTIONS' === method) {
    return next();
  }

  const required = c.env.WRITE_TOKEN;

  if (undefined === required || 0 === required.length) {
    return next();
  }

  const header = c.req.header('Authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (presented !== required) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  return next();
});

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

  // No chain needs the residential render proxy anymore: AB and Kritikos (which
  // 403/503 the edge) are served entirely from their off-edge D1 catalog indexes
  // below, and every other chain — Sklavenitis included, since its WAF stopped
  // blocking Cloudflare egress — answers the edge directly on the free global
  // fetch. So Scrape.do is fully retired; the live path just uses `fetch`.
  const searchHints: SearchHints = { ean: eanHint };

  // '' when no EAN hint — part of the cache key so an EAN-guided search (which
  // surfaces the exact product first) never collides with the plain query.
  const eanKey = eanHint ?? '';

  const searchOne = async (adapter: RetailerAdapter): Promise<RetailerSearchResult[]> => {
    // Kritikos, AB and Sklavenitis are all served from the D1 discovery index the
    // off-edge daily scrape builds — a cheap LIKE, no live edge egress. Kritikos
    // and AB have no viable live edge search at all (Kritikos ships none and
    // streaming its ~29 MB catalog blows the CPU budget; AB's API is unreachable);
    // Sklavenitis's live search works but its WAF intermittently 403s the edge
    // (~30% of ~24 failures/day), so it's indexed too — killing the whole
    // live-search failure tail, not just the 403s.
    if ('kritikos' === adapter.id) {
      return searchKritikosCatalog(c.env, query, eanHint);
    }

    if ('ab' === adapter.id) {
      return searchAbCatalog(c.env, query);
    }

    if ('sklavenitis' === adapter.id) {
      return searchSklavenitisCatalog(c.env, query);
    }

    const cached = await readSearchCache(c.env, adapter.id, query, eanKey);

    if (null !== cached) {
      return cached;
    }

    // A throw here (a failed chain) skips the write below and surfaces in
    // errors[], so failures always retry live and never poison the cache.
    // edgeFetch adds timeout + one polite retry (see scrape.ts) so a
    // transient WAF/5xx blip doesn't cost the chain this search.
    const found = await adapter.searchProducts(query, edgeFetch, searchHints);
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
      const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      errors.push(message);
      // errors[] only reaches the requesting client; mirror to the log so
      // Workers Logs can show WHICH chain 403s/5xxes and how often.
      console.error(`[retailer-search] q="${query}": ${message}`);
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
 * shown after saving depends on the immediate /api/scrape/run — which now
 * prices the edge-blocked chains (AB, Kritikos) from their D1 catalog indexes
 * instead of 403-ing, but still can't cover a SKU the daily crawl hasn't seen
 * yet — so seeding from what the client just saw stays the instant, reliable
 * path.
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

  if ('string' !== typeof payload.brand || 0 === payload.brand.trim().length) {
    return c.json({ error: 'brand is required' }, 400);
  }

  if ('string' !== typeof payload.title || 0 === payload.title.trim().length) {
    return c.json({ error: 'title is required' }, 400);
  }

  // Validate the barcode on create too (PATCH already does) — a malformed
  // EAN would otherwise become a bogus cross-chain identity.
  const ean = payload.ean ?? null;

  if (null !== ean && ('string' !== typeof ean || false === /^\d{8,14}$/.test(ean))) {
    return c.json({ error: 'ean must be 8-14 digits or null' }, 400);
  }

  const listings = Array.isArray(payload.listings) ? payload.listings : [];

  for (const listing of listings) {
    if (
      'string' !== typeof listing.retailer ||
      'string' !== typeof listing.retailerSku ||
      'string' !== typeof listing.url
    ) {
      return c.json({ error: 'each listing needs retailer, retailerSku and url' }, 400);
    }
  }

  const imageUrl = 'string' === typeof payload.imageUrl && 0 < payload.imageUrl.length ? payload.imageUrl : null;

  let productId: number | bigint;

  try {
    // Optionals may arrive undefined; D1 .bind() rejects undefined, so coalesce.
    const insertProduct = await c.env.DB.prepare(
      'INSERT INTO products (ean, brand, title, size_value, size_unit, image_url) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        ean,
        payload.brand.trim(),
        payload.title.trim(),
        payload.sizeValue ?? null,
        payload.sizeUnit ?? null,
        imageUrl,
      )
      .run();

    productId = insertProduct.meta.last_row_id;
  } catch (error) {
    // products.ean is UNIQUE — a duplicate barcode is a conflict, not a 500.
    if (error instanceof Error && error.message.includes('UNIQUE')) {
      return c.json({ error: 'a product with this barcode already exists' }, 409);
    }

    throw error;
  }

  if (0 < listings.length) {
    // OR IGNORE: a (retailer, sku) already tracked by another product is
    // skipped rather than throwing UNIQUE and leaving this product an orphan
    // with no listings (matches POST /:id/listings).
    const statements = listings.map((listing) => {
      return c.env.DB.prepare(
        'INSERT OR IGNORE INTO retailer_listings (product_id, retailer, retailer_sku, url) VALUES (?, ?, ?, ?)',
      ).bind(productId, listing.retailer, listing.retailerSku, listing.url);
    });

    await c.env.DB.batch(statements);
    await seedListingPrices(c.env, Number(productId), listings);
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

  // AB and Kritikos 403/503 the edge, but their whole catalogs are mirrored into
  // D1 by the off-edge daily crawl — so resolve a pasted URL straight from that
  // index (by the SKU the URL embeds) instead of paying the render proxy to fetch
  // the blocked page. Every other chain (Sklavenitis included) answers the edge
  // directly, so scrape the page live on the free global fetch.
  const indexed = await resolveFromCatalog(c.env, adapter.id, url);

  if (null !== indexed) {
    return c.json(indexed);
  }

  if ('ab' === adapter.id || 'kritikos' === adapter.id) {
    // Index-backed but the SKU isn't in the catalog (dropped, or brand-new and
    // not yet crawled). We no longer keep a proxy to fetch the blocked page, and
    // a direct edge fetch would just 403/503 — so say so rather than 502.
    return c.json(
      { error: 'product not in the catalog index — it should appear after the next daily update' },
      404,
    );
  }

  try {
    const scraped = await adapter.scrapeProduct(url, edgeFetch, {
      productTitle: payload.productTitle,
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
    console.error(`[resolve-url] ${url}: ${message}`);
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
    // Scope the history delete to the listing ONLY when it belongs to this
    // product. The two statements commit atomically as one batch, so the
    // history delete must carry the same (id, product_id) guard as the
    // listing delete below — otherwise a wrong/stale product id wipes the
    // listing's entire price history while the listing row survives.
    c.env.DB.prepare(
      'DELETE FROM price_history WHERE listing_id IN (SELECT id FROM retailer_listings WHERE id = ? AND product_id = ?)',
    ).bind(listingId, productId),
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
  try {
    const row = await env.DB.prepare(
      `SELECT name, brand, quantity, image_url, found,
              (cached_at > datetime('now', CASE WHEN found = 1 THEN '-90 days' ELSE '-14 days' END)) AS is_fresh
       FROM barcode_cache
       WHERE ean = ?`,
    )
      .bind(ean)
      .first<BarcodeCacheRow>();

    return row ?? null;
  } catch {
    // Missing/unmigrated barcode_cache must degrade to a live OFF lookup, not
    // 500 the route — it's a pure cache (mirrors the search_cache helpers).
    return null;
  }
};

const writeBarcodeCache = async (env: Env, ean: string, info: BarcodeInfo): Promise<void> => {
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO barcode_cache
         (ean, name, brand, quantity, image_url, source, found, cached_at)
       VALUES (?, ?, ?, ?, ?, 'openfoodfacts', ?, datetime('now'))`,
    )
      .bind(ean, info.name, info.brand, info.quantity, info.imageUrl, null !== info.name ? 1 : 0)
      .run();
  } catch {
    // A cache write must never fail the lookup — swallow and move on.
  }
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
 * so there is no EAN branch. Best-effort: a missing table (not migrated) or any
 * query error returns [] so this path never 5xx-es.
 */
const searchAbCatalog = async (
  env: Env,
  query: string,
): Promise<RetailerSearchResult[]> => {
  const tokens = abQueryTokens(query);

  if (0 === tokens.length) {
    return [];
  }

  try {
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
    return [];
  }
};

interface SklavenitisCatalogRow {
  sku: string;
  name: string;
  url: string;
  brand: string | null;
  price_piece: number | null;
  price_unit: number | null;
  unit_label: string | null;
  image_url: string | null;
}

const SKLAVENITIS_MAX_RESULTS = 100;
const SKLAVENITIS_COLUMNS = 'sku, name, url, brand, price_piece, price_unit, unit_label, image_url';

const sklavenitisRowToResult = (row: SklavenitisCatalogRow): RetailerSearchResult => ({
  retailer: 'sklavenitis',
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
 * Answer a Sklavenitis search from the D1 discovery index the off-edge scrape
 * builds (schema.sql, scrape-local.ts) instead of a live edge fetch its WAF
 * intermittently 403s. Each query token becomes a `haystack LIKE ?` AND-term
 * (same fold as the client matcher, via the shared sklavenitisQueryTokens),
 * mirroring searchAbCatalog. Discovery-only: brand/price/image come back null and
 * the tracked listing still gets live prices from its daily product-page scrape.
 * Best-effort: a missing table (not migrated) or any query error returns [] so
 * this path never 5xx-es.
 */
const searchSklavenitisCatalog = async (
  env: Env,
  query: string,
): Promise<RetailerSearchResult[]> => {
  const tokens = sklavenitisQueryTokens(query);

  if (0 === tokens.length) {
    return [];
  }

  try {
    const clause = tokens
      .map(() => `haystack LIKE ('%' || ? || '%') ESCAPE '\\'`)
      .join(' AND ');
    const { results } = await env.DB.prepare(
      `SELECT ${SKLAVENITIS_COLUMNS} FROM sklavenitis_catalog WHERE ${clause} LIMIT ?`,
    )
      .bind(...tokens.map(escapeLike), SKLAVENITIS_MAX_RESULTS)
      .all<SklavenitisCatalogRow>();

    return results.map(sklavenitisRowToResult);
  } catch {
    return [];
  }
};

/**
 * Which chains RESOLVE a pasted URL from the D1 catalog index rather than a live
 * scrape. Sklavenitis is deliberately absent: its catalog is discovery-only (no
 * prices), and resolve-url's price seeds the new listing's first point
 * (UpdateRetailersPanel), so a pasted Sklavenitis product still live-scrapes to
 * carry today's price. Only its SEARCH is catalog-served (the dispatch above) —
 * that's where the intermittent multi-request 403s actually bite; a single
 * resolve fetch rarely does.
 */
const CATALOG_TABLES: Partial<Record<RetailerId, string>> = {
  ab: 'ab_catalog',
  kritikos: 'kritikos_catalog',
};

/** Pull the numeric SKU a catalog-backed chain embeds in its product URL. */
const skuFromCatalogUrl = (retailer: RetailerId, url: string): string | null => {
  if ('ab' === retailer) {
    return url.match(/\/p\/(\d+)/)?.[1] ?? null; // .../p/<sku>
  }

  if ('kritikos' === retailer) {
    return url.match(/-(\d+)\/?(?:[?#]|$)/)?.[1] ?? null; // slug ends -<sku>/
  }

  return null;
};

interface CatalogResolveRow {
  sku: string;
  name: string;
  price_piece: number | null;
  price_unit: number | null;
  unit_label: string | null;
}

/**
 * Resolve a pasted URL for a catalog-backed chain (AB, Kritikos) from its D1
 * index by the SKU the URL embeds — no proxy, no live fetch of the blocked page.
 * Returns null when the chain isn't index-backed, the URL carries no SKU, or the
 * SKU isn't indexed, so the caller decides how to respond.
 */
const resolveFromCatalog = async (
  env: Env,
  retailer: RetailerId,
  url: string,
): Promise<Record<string, unknown> | null> => {
  const table = CATALOG_TABLES[retailer];

  if (undefined === table) {
    return null;
  }

  const sku = skuFromCatalogUrl(retailer, url);

  if (null === sku) {
    return null;
  }

  try {
    // `table` comes from the fixed CATALOG_TABLES allowlist above, never input.
    const row = await env.DB.prepare(
      `SELECT sku, name, price_piece, price_unit, unit_label FROM ${table} WHERE sku = ?`,
    )
      .bind(sku)
      .first<CatalogResolveRow>();

    if (null === row || undefined === row) {
      return null;
    }

    return {
      retailer,
      sku: row.sku,
      name: row.name,
      url,
      pricePiece: row.price_piece,
      priceUnit: row.price_unit,
      unitLabel: row.unit_label,
    };
  } catch {
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

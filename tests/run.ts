import assert from 'node:assert/strict';
import {
  extractEanFromInput,
  extractPercent,
  extractSize,
  foldForComparison,
  normalizeTitle,
} from '../packages/core/src/normalize';
import { suggestMatches } from '../packages/core/src/match';
import { parseProductHtml, parseSearchHtml } from '../packages/scrapers/src/sklavenitis';
import {
  abHaystack,
  abQueryTokens,
  buildAbCatalogIndex,
  mapSearchResponse,
} from '../packages/scrapers/src/ab';
import { toGreekFloat } from '../packages/scrapers/src/types';
import {
  mapSearchResponse as mapLidlSearchResponse,
  parseBasePriceText,
  parseProductHtml as parseLidlProductHtml,
} from '../packages/scrapers/src/lidl';
import {
  mymarketAdapter,
  parseProductHtml as parseMymarketProductHtml,
  parseSearchHtml as parseMymarketSearchHtml,
} from '../packages/scrapers/src/mymarket';
import {
  mapSearchResponse as mapMasoutisSearchResponse,
  masoutisAdapter,
} from '../packages/scrapers/src/masoutis';
import {
  buildCatalogIndex,
  buildHaystack,
  createProductScanner,
  kritikosAdapter,
  parseCatalogEntry,
  queryTokens,
  transliterate,
} from '../packages/scrapers/src/kritikos';
import { mapProductsResponse as mapGalaxiasProductsResponse } from '../packages/scrapers/src/galaxias';
import { normalizeOpenFoodFacts } from '../apps/worker/src/openfoodfacts';
import {
  collectConfirmedEan,
  resolveIdentityByEan,
  searchAndRank,
  SUGGESTION_THRESHOLD,
  type RankedResult,
} from '../apps/web/src/lib/matching';
import type { RetailerId, RetailerSearchResult } from '../packages/core/src/types';
import { evaluateGoldenSet, formatGoldenReport } from './golden';

// --- normalize ---------------------------------------------------------

// Output is the internal comparison form: Greek homoglyphs fold to Latin
// so "NOYNOY" (brand field) and "ΝΟΥΝΟΥ" (title) collide.
assert.equal(
  normalizeTitle('HEALTHY HABITS | Δημητριακά Granola Φυστικοβούτυρο Μαύρη Σοκολάτα 350g'),
  'healthy habits δhmhtpiaka granola φyσtikoboytypo mayph σokoλata 350g',
);
assert.equal(normalizeTitle('ΝΟΥΝΟΥ'), normalizeTitle('NOYNOY'));
assert.equal(normalizeTitle('Ελληνικός'), normalizeTitle('Ελληνικοσ'));

// The comparison fold collapses the iota-sound spellings retailers
// disagree on — but must NOT collapse ου onto ι/οι.
assert.equal(
  foldForComparison(normalizeTitle('Φυστικοβούτυρο')),
  foldForComparison(normalizeTitle('Φιστικοβούτυρο')),
);
assert.notEqual(foldForComparison(normalizeTitle('ζουμί')), foldForComparison(normalizeTitle('ζυμή')));

assert.deepEqual(extractSize('Granola 350g'), { value: 350, unit: 'g', count: 1 });
assert.deepEqual(extractSize('Ρύζι 1kg'), { value: 1000, unit: 'g', count: 1 });
assert.deepEqual(extractSize('Γάλα 1,5lt'), { value: 1500, unit: 'ml', count: 1 });
assert.equal(extractSize('no size here'), null);
// Greek unit suffixes (Kritikos "680ΓΡ", Masoutis "20γρ.").
assert.deepEqual(extractSize('Φρουί Ζελέ Φράουλα 20γρ.'), { value: 20, unit: 'g', count: 1 });
assert.deepEqual(extractSize('ΨΩΜΙ ΤΟΣΤ ΦΟΡΜΑ 680ΓΡ'), { value: 680, unit: 'g', count: 1 });
assert.deepEqual(extractSize('Αυγά 6 τεμ'), { value: 6, unit: 'piece', count: 1 });

// Multipacks: total content + pack count, whatever the separator glyph.
assert.deepEqual(extractSize('ΠΑΠΑΔΟΠΟΥΛΟΥ Granola Μπάρες 5x42g'), {
  value: 210,
  unit: 'g',
  count: 5,
});
assert.deepEqual(extractSize('Milko γάλα με κακάο 4*250ML'), { value: 1000, unit: 'ml', count: 4 });
assert.deepEqual(extractSize('Κρουασάν 3 χ 100γρ'), { value: 300, unit: 'g', count: 3 });
// Decimal per-piece sizes inside multipacks parse too, and the pack
// reading beats the bare first-hit size.
assert.deepEqual(extractSize('Νερό Φυσικό Μεταλλικό 6x1,5lt'), {
  value: 9000,
  unit: 'ml',
  count: 6,
});

// Percent attribute — never a size, always the distinguishing fat figure.
assert.equal(extractPercent('Ελληνικό Γάλα 3,5% Λιπαρά 1lt'), 3.5);
assert.equal(extractPercent('Γάλα light 1.5 % '), 1.5);
assert.equal(extractPercent('Granola 350g'), null);

// --- extractEanFromInput ------------------------------------------------

assert.equal(extractEanFromInput('5202535179175'), '5202535179175');
assert.equal(extractEanFromInput('  520 2535 179175 '), '5202535179175');
assert.equal(
  extractEanFromInput('https://galaxias.shop/product/5202535179175'),
  '5202535179175',
);
assert.equal(
  extractEanFromInput('https://galaxias.shop/product/5202535179175?utm=x'),
  '5202535179175',
);
// Kritikos slugs end in internal SKUs, not barcodes — must NOT be mistaken for one.
assert.equal(
  extractEanFromInput('https://kritikos-sm.gr/products/manabikh/laxanika/tomates-tsampi-1505/'),
  null,
);
assert.equal(extractEanFromInput('not a barcode'), null);
assert.equal(extractEanFromInput(''), null);

// --- toGreekFloat ------------------------------------------------------

assert.equal(toGreekFloat('3,14'), 3.14);
assert.equal(toGreekFloat('1.234,56'), 1234.56);
assert.equal(toGreekFloat('2.15'), 2.15);
assert.equal(toGreekFloat('garbage'), null);

// --- matcher: real cross-retailer titles for the granola --------------

const sklavenitisTitle = 'HEALTHY HABITS Granola Βρώμης με Φιστικοβούτυρο & Μαύρη Σοκολάτα 350g';
const abTitle = 'HEALTHY HABITS | Δημητριακά Granola Φυστικοβούτυρο Μαύρη Σοκολάτα 350g';

const candidates = [
  { id: 1, title: sklavenitisTitle, brand: 'HEALTHY HABITS' },
  { id: 2, title: 'HEALTHY HABITS Granola Βρώμης με Μέλι & Αμύγδαλα 350g', brand: 'HEALTHY HABITS' },
  { id: 3, title: 'AGRINO Ρύζι Basmati 500g', brand: 'AGRINO' },
];

const suggestions = suggestMatches(abTitle, candidates);

assert.ok(0 < suggestions.length, 'expected at least one suggestion');
const top = suggestions[0];
assert.ok(undefined !== top);
assert.equal(top.candidateId, 1, 'granola variant must rank first');
assert.equal(top.sizeMatched, true);

// AGRINO must be excluded by the brand gate.
const agrinoSuggestion = suggestions.find((s) => 3 === s.candidateId);
assert.equal(agrinoSuggestion, undefined, 'brand gate must exclude AGRINO');

// Different size must be excluded entirely.
const sizeGate = suggestMatches('HEALTHY HABITS Granola Φυστικοβούτυρο 400g', candidates);
const wrongSize = sizeGate.find((s) => 1 === s.candidateId);
assert.equal(wrongSize, undefined, 'size gate must exclude 350g when scraping 400g');

// --- sklavenitis parser fixture ----------------------------------------
// Mirrors live markup (captured 2026-07-05): tags between € and /label.

const FIXTURE = `
<div class="priceWrp">
  <div class="priceKil">8,97 €<span>/κιλό</span></div>
  <div class="main-price main-price--previous">
    <div class="price" data-price="3,14">3,14 €<span>/τεμ.</span></div>
  </div>
</div>
<h1>HEALTHY HABITS Granola Βρώμης με Φιστικοβούτυρο &amp; Μαύρη Σοκολάτα 350g</h1>
<p>Κωδικός: <strong>1599382</strong></p>
`;

const parsed = parseProductHtml(FIXTURE);
assert.equal(parsed.name, 'HEALTHY HABITS Granola Βρώμης με Φιστικοβούτυρο & Μαύρη Σοκολάτα 350g');
assert.equal(parsed.sku, '1599382');
assert.equal(parsed.pricePiece, 3.14);
assert.equal(parsed.priceUnit, 8.97);
assert.equal(parsed.unitLabel, 'κιλό');

// The pre-fix flat format must keep parsing too.
const FLAT_FIXTURE = `
<h1>X 350g</h1>
<div class="price kilo">8,97 €/κιλό</div>
<div class="price">3,14 €/τεμ.</div>
`;
const flat = parseProductHtml(FLAT_FIXTURE);
assert.equal(flat.pricePiece, 3.14);
assert.equal(flat.priceUnit, 8.97);

// Discount: two piece prices → lowest wins.
const DISCOUNT_FIXTURE = `
<h1>X 350g</h1>
<span class="deleted">4,10 €/τεμ.</span>
<span>3,49 €/τεμ.</span>
`;
const discounted = parseProductHtml(DISCOUNT_FIXTURE);
assert.equal(discounted.pricePiece, 3.49);

// --- sklavenitis search parser ------------------------------------------
// Tile shape captured live from /apotelesmata-anazitisis/?Query=granola.

// The third tile mirrors live markup (captured 2026-07-06) for products
// whose slug does NOT end in the numeric code — identity then comes from
// the tile's data-productsku (wishlist icon, precedes the title anchor).

const SEARCH_FIXTURE = `
<h4 class="product__title">
  <a href="/eidi-proinoy-rofimata/dimitriaka-mpares/dimitriaka-vromis-muesli/healthy-habits-granola-vromis-me-fistikovouturo--mauri-sokolata-350gr-1599382/">HEALTHY HABITS Granola Βρώμης με Φιστικοβούτυρο &amp; Μαύρη Σοκολάτα 350g</a>
</h4>
<h4 class="product__title">
  <a href="/x/papadopoulou-granola-bares-1694078/">ΠΑΠΑΔΟΠΟΥΛΟΥ Granola Μπάρες 5x42g</a>
</h4>
<div class="icon-fav icon-cartFav" data-productsku="9811456" data-role="WishlistIconClickHandler"></div>
<h4 class="product__title">
  <a href="/galata-rofimata-chymoi-psygeioy/galata-psygeioy/galata-agelados-freska/olubos-epilegmeno-fresko-gala-elafru-17-lipara-1lt/">ΟΛΥΜΠΟΣ Επιλεγμένο Φρέσκο Γάλα Ελαφρύ 1,7% Λιπαρά 1lt</a>
</h4>
`;

const searchResults = parseSearchHtml(SEARCH_FIXTURE);
assert.equal(searchResults.length, 3);
const [firstResult, , milkResult] = searchResults;
assert.ok(undefined !== firstResult && undefined !== milkResult);
assert.equal(firstResult.sku, '1599382');
assert.equal(
  firstResult.title,
  'HEALTHY HABITS Granola Βρώμης με Φιστικοβούτυρο & Μαύρη Σοκολάτα 350g',
);
assert.ok(firstResult.url.startsWith('https://www.sklavenitis.gr/'));
// Slug carries no code — data-productsku must fill in.
assert.equal(milkResult.sku, '9811456');
assert.equal(milkResult.title, 'ΟΛΥΜΠΟΣ Επιλεγμένο Φρέσκο Γάλα Ελαφρύ 1,7% Λιπαρά 1lt');

// --- ab search response mapper ------------------------------------------
// Shape captured live from the GetProductSearch GraphQL call.

const AB_RESPONSE = {
  data: {
    productSearch: {
      products: [
        {
          code: '7703411',
          name: 'Δημητριακά Granola Φυστικοβούτυρο Μαύρη Σοκολάτα 350g',
          url: '/el/eshop/Dimitriaka-Granola-Fystikovoytyro-Mayri-Sokolata-350g/p/7703411',
          manufacturerName: 'HEALTHY HABITS',
          price: {
            value: 3.72,
            supplementaryPriceLabel1: '10,63 €/ κιλ',
          },
        },
      ],
    },
  },
};

const abResults = mapSearchResponse(AB_RESPONSE, 'test://fixture');
assert.equal(abResults.length, 1);
const [abResult] = abResults;
assert.ok(undefined !== abResult);
assert.equal(abResult.sku, '7703411');
assert.equal(abResult.brand, 'HEALTHY HABITS');
assert.equal(abResult.pricePiece, 3.72);
assert.equal(abResult.priceUnit, 10.63);
assert.equal(abResult.unitLabel, 'κιλό');
assert.equal(
  abResult.url,
  'https://www.ab.gr/el/eshop/Dimitriaka-Granola-Fystikovoytyro-Mayri-Sokolata-350g/p/7703411',
);

// A GraphQL error payload (rotated persisted-query hash) must throw loudly.
assert.throws(() => {
  mapSearchResponse({ errors: [{ message: 'PersistedQueryNotFound' }] }, 'test://fixture');
}, /PersistedQueryNotFound/);

// --- ab catalog index (the off-edge D1 discovery path) -------------------

// abQueryTokens and abHaystack share @grocery/core's normalizeTitle, so the D1
// index and the edge query fold identically (punctuation → spaces, homoglyphs
// folded), which is the whole point: an indexed row matches the same queries.
assert.deepEqual(abQueryTokens('   '), []);
assert.equal(abQueryTokens('Γάλα & Φρέσκο').length, 2); // '&' folds away, no empty token
// Homoglyph fold makes the Greek-script brand and a Latin-typed query agree.
assert.ok(abQueryTokens('ΝΟΥΝΟΥ').every((token) => abHaystack('ΝΟΥΝΟΥ', 'Γάλα').includes(token)));

// buildAbCatalogIndex pages the empty-free-text browse to its pagination.totalPages
// and dedupes by SKU (a product recurs across pages as the backing set shifts).
const abCatalogPage = (pageNumber: number) => ({
  data: {
    productSearch: {
      pagination: { currentPage: pageNumber, totalResults: 3, totalPages: 2 },
      products:
        0 === pageNumber
          ? [
              {
                code: '100',
                name: 'Γάλα Φρέσκο Πλήρες 1lt',
                url: '/el/eshop/gala-fresko-plires-1lt/p/100',
                manufacturerName: 'ΝΟΥΝΟΥ',
                price: { value: 1.55, supplementaryPriceLabel1: '1,55 €/ λιτ' },
              },
              {
                code: '200',
                name: 'Ψωμί Τοστ 720g',
                url: '/el/eshop/psomi-tost-720g/p/200',
                manufacturerName: '7DAYS',
                price: { value: 1.2 },
              },
            ]
          : [
              // sku 200 repeats — must be deduped, not double-counted.
              {
                code: '200',
                name: 'Ψωμί Τοστ 720g',
                url: '/el/eshop/psomi-tost-720g/p/200',
                manufacturerName: '7DAYS',
                price: { value: 1.2 },
              },
              {
                code: '300',
                name: 'Τυρί Φέτα ΠΟΠ 400g',
                url: '/el/eshop/tyri-feta-pop-400g/p/300',
                manufacturerName: 'ΔΩΔΩΝΗ',
                price: { value: 4.1 },
              },
            ],
    },
  },
});
const abCatalogFetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = 'string' === typeof input ? input : input.toString();
  const rawVars = new URL(url).searchParams.get('variables') ?? '{}';
  const pageNumber = Number(JSON.parse(rawVars).pageNumber ?? 0);
  return new Response(JSON.stringify(abCatalogPage(pageNumber)));
}) as typeof fetch;

const abIndex = await buildAbCatalogIndex(abCatalogFetch);
assert.equal(abIndex.length, 3); // 4 tiles across 2 pages, sku 200 deduped

const abMilk = abIndex.find((entry) => '100' === entry.sku);
assert.ok(undefined !== abMilk);
assert.equal(abMilk.name, 'Γάλα Φρέσκο Πλήρες 1lt');
assert.equal(abMilk.brand, 'ΝΟΥΝΟΥ');
assert.equal(abMilk.pricePiece, 1.55);
assert.equal(abMilk.priceUnit, 1.55);
assert.equal(abMilk.unitLabel, 'λιτ');
assert.equal(abMilk.url, 'https://www.ab.gr/el/eshop/gala-fresko-plires-1lt/p/100');
// The row's haystack matches the same tokens a user's query folds to.
assert.ok(abQueryTokens('Γάλα Φρέσκο').every((token) => abMilk.haystack.includes(token)));

// --- ab scrape: brand-only retry when the full title stops surfacing ------
// the SKU (index churn). The exact-SKU pick keeps the retry mismatch-proof.

const AB_OTHER = {
  data: {
    productSearch: {
      products: [
        {
          code: '9999999',
          name: 'Άλλο Προϊόν',
          url: '/el/eshop/x/p/9999999',
          manufacturerName: 'HEALTHY HABITS',
          price: { value: 1.0, supplementaryPriceLabel1: '1,00 €/ κιλ' },
        },
      ],
    },
  },
};

const abRetryFetch = (async (input: string | URL | Request) => {
  const decoded = decodeURIComponent(String(input));

  // Brand-only query (exact, closing quote) carries the wanted SKU…
  if (decoded.includes('"searchQuery":"HEALTHY+HABITS"')) {
    return new Response(JSON.stringify(AB_RESPONSE));
  }

  // …the full-title query no longer does.
  return new Response(JSON.stringify(AB_OTHER));
}) as typeof fetch;

const abScraped = await (await import('../packages/scrapers/src/ab')).abAdapter.scrapeProduct(
  'https://www.ab.gr/el/eshop/Dimitriaka-Granola-Fystikovoytyro-Mayri-Sokolata-350g/p/7703411',
  abRetryFetch,
  {
    productTitle: 'HEALTHY HABITS Δημητριακά Granola Φυστικοβούτυρο Μαύρη Σοκολάτα 350g',
    productBrand: 'HEALTHY HABITS',
  },
);
assert.equal(abScraped.sku, '7703411');
assert.equal(abScraped.pricePiece, 3.72);

// --- lidl product page (JSON-LD + rendered unit price) -------------------
// Mirrors live markup captured 2026-07-05 from /p/italiamo-lazania/p11145712.

const LIDL_PRODUCT_FIXTURE = `
<script type="application/ld+json">{"@context":"http://schema.org","@type":"Product","sku":"11145712","gtin13":["4056489893011"],"name":"Λαζάνια","brand":{"@type":"Brand","name":"ITALIAMO"},"offers":[{"@type":"Offer","price":1.79,"priceCurrency":"EUR","availability":"InStock"}]}</script>
<div class="ods-price__value" data-v-b273d44f>1,79€*</div>
<div class="ods-price__footer" data-v-b273d44f><span data-v-ce55b84b>500 g<br data-v-ce55b84b></span>1 Kg = 3,58€<br data-v-476c1ce4>
`;

const lidlProduct = parseLidlProductHtml(LIDL_PRODUCT_FIXTURE);
assert.equal(lidlProduct.name, 'Λαζάνια');
assert.equal(lidlProduct.sku, '11145712');
assert.equal(lidlProduct.pricePiece, 1.79);
assert.equal(lidlProduct.priceUnit, 3.58);
assert.equal(lidlProduct.unitLabel, 'κιλό');
// gtin13 (array form in the JSON-LD) is the pack barcode — must survive.
assert.equal(lidlProduct.ean, '4056489893011');

// Promo "from-to" base-price variant: the last € amount is the payable one.
assert.deepEqual(parseBasePriceText('1 kg = Από 11,30€ σε 9,30€'), {
  priceUnit: 9.3,
  unitLabel: 'κιλό',
});
assert.deepEqual(parseBasePriceText('1 Lt = 2,15€'), { priceUnit: 2.15, unitLabel: 'λίτρο' });

// --- lidl search API ------------------------------------------------------

const LIDL_SEARCH_RESPONSE = {
  numFound: 1,
  items: [
    {
      code: '11145712',
      gridbox: {
        data: {
          fullTitle: 'ITALIAMO Λαζάνια',
          erpNumber: '11145712',
          productId: 11145712,
          canonicalUrl: '/p/italiamo-lazania/p11145712',
          brand: { name: 'ITALIAMO' },
          price: {
            price: 1.79,
            basePrice: { prefix: false, text: '1 Kg = 3,58€' },
            packaging: { text: '500 g' },
            currencyCode: 'EUR',
          },
        },
      },
    },
  ],
};

const lidlResults = mapLidlSearchResponse(LIDL_SEARCH_RESPONSE, 'test://fixture');
assert.equal(lidlResults.length, 1);
const [lidlResult] = lidlResults;
assert.ok(undefined !== lidlResult);
assert.equal(lidlResult.sku, '11145712');
assert.equal(lidlResult.title, 'ITALIAMO Λαζάνια');
assert.equal(lidlResult.brand, 'ITALIAMO');
assert.equal(lidlResult.pricePiece, 1.79);
assert.equal(lidlResult.priceUnit, 3.58);
assert.equal(lidlResult.url, 'https://www.lidl-hellas.gr/p/italiamo-lazania/p11145712');

// Numeric queries answer a redirect envelope — must map to "no results".
assert.deepEqual(
  mapLidlSearchResponse({ type: 'redirect', redirectURL: '/p/x/p1' }, 'test://fixture'),
  [],
);

// An EAN hint resolves via the redirect envelope to the product page,
// whose JSON-LD confirms the barcode; the hit ranks first and the text
// result with the same SKU is dropped.
const lidlEanFetch = (async (input: string | URL | Request) => {
  const url = String(input);

  if (url.includes('q=4056489893011')) {
    return new Response(
      JSON.stringify({ type: 'redirect', redirectURL: '/p/italiamo-lazania/p11145712' }),
    );
  }

  if (url.includes('/p/italiamo-lazania/p11145712')) {
    return new Response(LIDL_PRODUCT_FIXTURE);
  }

  return new Response(JSON.stringify(LIDL_SEARCH_RESPONSE));
}) as typeof fetch;

const { lidlAdapter } = await import('../packages/scrapers/src/lidl');
const lidlByEan = await lidlAdapter.searchProducts('λαζάνια', lidlEanFetch, {
  ean: '4056489893011',
});
assert.equal(lidlByEan.length, 1, 'EAN hit must replace the same-SKU text result');
assert.equal(lidlByEan[0]?.sku, '11145712');
assert.equal(lidlByEan[0]?.ean, '4056489893011');
assert.ok(lidlByEan[0]?.url.endsWith('/p/italiamo-lazania/p11145712'));

// A failing EAN lookup must not cost the text results.
const lidlEanDownFetch = (async (input: string | URL | Request) => {
  const url = String(input);

  if (url.includes('q=4056489893011')) {
    return new Response('upstream sad', { status: 500 });
  }

  return new Response(JSON.stringify(LIDL_SEARCH_RESPONSE));
}) as typeof fetch;

const lidlEanDown = await lidlAdapter.searchProducts('λαζάνια', lidlEanDownFetch, {
  ean: '4056489893011',
});
assert.equal(lidlEanDown.length, 1);
assert.equal(lidlEanDown[0]?.ean, null);

// --- mymarket product page ------------------------------------------------
// Mirrors live markup captured 2026-07-05 from /nounou-evapore-gala-170gr.

const MYMARKET_PRODUCT_FIXTURE = `
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","url":"https://www.mymarket.gr/nounou-evapore-gala-170gr","name":"ΝΟΥΝΟΥ Εβαπορέ Γάλα 170gr","sku":"250001","mpn":"250001","offers":{"@type":"Offer","price":"0.82","priceCurrency":"EUR","availability":"InStock"}}]}</script>
<p class="text-gray-500 text-xs md:text-sm mb-2.5">Κωδικός: 250001</p>
<div class="measure-label-wrapper">
  <span class="font-semibold">4,82€</span>
  <span>Τιμή κιλού</span>
</div>
`;

const mymarketProduct = parseMymarketProductHtml(MYMARKET_PRODUCT_FIXTURE);
assert.equal(mymarketProduct.name, 'ΝΟΥΝΟΥ Εβαπορέ Γάλα 170gr');
assert.equal(mymarketProduct.sku, '250001');
assert.equal(mymarketProduct.pricePiece, 0.82);
assert.equal(mymarketProduct.priceUnit, 4.82);
assert.equal(mymarketProduct.unitLabel, 'κιλό');

// Sold-by-weight: JSON-LD price is a portion, not a piece price — only the
// per-kg figure is real.
const MYMARKET_WEIGHED_FIXTURE = `
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"My Gusto Τυρί Gouda Φραντζόλα Προέλευσης Ε.Ε. Τιμή Κιλού","sku":"125010","offers":{"@type":"Offer","price":"1.33","priceCurrency":"EUR"}}]}</script>
<div class="measure-label-wrapper">
  <span class="font-semibold">5,30€</span>
  <span>Τιμή κιλού</span>
</div>
`;

const mymarketWeighed = parseMymarketProductHtml(MYMARKET_WEIGHED_FIXTURE);
assert.equal(mymarketWeighed.pricePiece, null);
assert.equal(mymarketWeighed.priceUnit, 5.3);
assert.equal(mymarketWeighed.unitLabel, 'κιλό');

// --- mymarket search tiles --------------------------------------------------
// data-action contains ">" inside the attribute value — the tile pattern
// must not choke on it.

const MYMARKET_SEARCH_FIXTURE = `
<article data-google-analytics-item-value="{&quot;id&quot;:&quot;250001&quot;}" data-id="324" class="product--teaser bg-white h-full w-full">
  <header><div class="tooltip"><h3>
    <a href="https://www.mymarket.gr/nounou-evapore-gala-170gr" rel="bookmark" aria-label="ΝΟΥΝΟΥ Εβαπορέ Γάλα 170gr teaser"
       data-action="click->google-analytics#selectItem"
       data-google-analytics-item-param="{&quot;id&quot;:&quot;250001&quot;,&quot;name&quot;:&quot;\\u039d\\u039f\\u03a5\\u039d\\u039f\\u03a5 \\u0395\\u03b2\\u03b1\\u03c0\\u03bf\\u03c1\\u03ad \\u0393\\u03ac\\u03bb\\u03b1 170gr&quot;,&quot;price&quot;:&quot;0.82&quot;,&quot;brand&quot;:&quot;NOYNOY&quot;,&quot;quantity&quot;:1,&quot;currency&quot;:&quot;EUR&quot;}">ΝΟΥΝΟΥ Εβαπορέ Γάλα 170gr</a>
  </h3></div></header>
</article>
`;

const mymarketResults = parseMymarketSearchHtml(MYMARKET_SEARCH_FIXTURE);
assert.equal(mymarketResults.length, 1);
const [mymarketResult] = mymarketResults;
assert.ok(undefined !== mymarketResult);
assert.equal(mymarketResult.sku, '250001');
assert.equal(mymarketResult.title, 'ΝΟΥΝΟΥ Εβαπορέ Γάλα 170gr');
assert.equal(mymarketResult.brand, 'NOYNOY');
assert.equal(mymarketResult.pricePiece, 0.82);
assert.equal(mymarketResult.url, 'https://www.mymarket.gr/nounou-evapore-gala-170gr');

// --- masoutis ---------------------------------------------------------------
// Search rows use dot decimals, the detail endpoint comma decimals; both
// shapes captured live 2026-07-05.

const MASOUTIS_SEARCH_RESPONSE = [
  {
    Itemcode: '4089678',
    ItemDescr: 'Μασούτης Ελληνικό Γάλα 3,5% Λιπαρά 1lt. ',
    StartPrice: 0.99,
    PosPrice: 0.99,
    ItemVolume: '0.990€/λιτ',
    PassKey: 673,
    BrandNameDesciption: 'ΜΑΣΟΥΤΗΣ',
    ItemDescrLink:
      'https://www.masoutis.gr/categories/item/masouths-ellhniko-gala-35--lipara-1lt?4089678',
  },
];

const masoutisResults = mapMasoutisSearchResponse(MASOUTIS_SEARCH_RESPONSE, 'test://fixture');
assert.equal(masoutisResults.length, 1);
const [masoutisResult] = masoutisResults;
assert.ok(undefined !== masoutisResult);
assert.equal(masoutisResult.sku, '4089678');
assert.equal(masoutisResult.title, 'Μασούτης Ελληνικό Γάλα 3,5% Λιπαρά 1lt.');
assert.equal(masoutisResult.pricePiece, 0.99);
assert.equal(masoutisResult.priceUnit, 0.99);
assert.equal(masoutisResult.unitLabel, 'λίτρο');
assert.ok(masoutisResult.url.startsWith('https://www.masoutis.gr/'));

// scrapeProduct drives GetCred + the item endpoint; fake both.
const masoutisFakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);

  if (url.endsWith('/GetCred')) {
    return new Response(JSON.stringify({ Uid: 'u', Usl: '2026-07-05 14:11', Key: 'k' }));
  }

  return new Response(
    JSON.stringify({
      Itemcode: '2660512',
      ItemDescr: 'Γιώτης Sweet & Balance Φρουί Ζελέ Φράουλα 20γρ. ',
      StartPrice: 1.77,
      PosPrice: 1.77,
      ItemVolume: '88,50€/κιλ',
      BrandNameDesciption: 'ΓΙΩΤΗΣ',
    }),
  );
}) as typeof fetch;

const masoutisScraped = await masoutisAdapter.scrapeProduct(
  'https://www.masoutis.gr/categories/item/giwths-sweet---balance-froui-zele-fraoula-20gr?2660512=',
  masoutisFakeFetch,
);
assert.equal(masoutisScraped.name, 'Γιώτης Sweet & Balance Φρουί Ζελέ Φράουλα 20γρ.');
assert.equal(masoutisScraped.sku, '2660512');
assert.equal(masoutisScraped.pricePiece, 1.77);
assert.equal(masoutisScraped.priceUnit, 88.5);
assert.equal(masoutisScraped.unitLabel, 'κιλό');

// --- kritikos ---------------------------------------------------------------

assert.equal(transliterate('Γάλα'), 'gala');
// υ→y matches the catalog's "oy" variant; their generator always emits
// both "giaoyrti" and "giaourti" spellings (verified on the live catalog).
assert.equal(transliterate('ΓΙΩΤΗΣ Φρουί Ζελέ'), 'giwths froyi zele');
assert.equal(transliterate('Λαχανικά'), 'laxanika');

// The scanner must isolate product objects even though nested objects also
// contain "_id" keys, and survive chunk boundaries mid-product.
const KRITIKOS_CATALOG = JSON.stringify({
  payload: {
    products: [
      {
        _id: 'a1',
        sku: '30083',
        name: 'ΚΑΡΑΜΟΛΕΓΚΟΣ ΨΩΜΙ ΤΟΣΤ  ΦΟΡΜΑ 680ΓΡ',
        isWeighed: false,
        finalPrice: 148,
        beginPrice: 243,
        unitOfMeasurementFinalPrice: 217,
        unitOfMeasurement: 'ΚΙΛ',
        barcodes: ['5205711123456'],
        slug: 'products/artozymes/psomi-tost/karamolegkos-psomi-tost-forma-680gr-30083',
        searchTerms: {
          name: 'karamolegkos pswmi tost forma 680gr psomi',
          brand: 'karamolegkos',
          reduced: 'karamolegkos pswmi tost 30083',
          sku: '30083',
        },
        nested: { _id: 'inner', tags: ['{', '}"'] },
      },
      {
        _id: 'b2',
        sku: '1505',
        name: 'ΤΟΜΑΤΕΣ ΤΣΑΜΠI',
        isWeighed: true,
        finalPrice: 198,
        unitOfMeasurementFinalPrice: 0,
        unitOfMeasurement: 'ΚΙΛ',
        slug: 'products/manabikh/laxanika/tomates-tsampi-1505',
        searchTerms: { name: 'tomates tsampi', reduced: 'tomates tsampi 1505', sku: '1505' },
      },
    ],
  },
  extraInfo: {},
});

const scannedProducts: string[] = [];
const scanner = createProductScanner((raw) => {
  scannedProducts.push(raw);
  return true;
});
// Push in awkward chunks to exercise boundary handling.
scanner.push(KRITIKOS_CATALOG.slice(0, 100));
scanner.push(KRITIKOS_CATALOG.slice(100, 101));
scanner.push(KRITIKOS_CATALOG.slice(101));
assert.equal(scannedProducts.length, 2);
assert.equal(JSON.parse(scannedProducts[0] ?? '{}').sku, '30083');
assert.equal(JSON.parse(scannedProducts[1] ?? '{}').sku, '1505');

// End-to-end search over a streamed catalog body.
const kritikosFakeFetch = (async () => new Response(KRITIKOS_CATALOG)) as typeof fetch;
const kritikosResults = await kritikosAdapter.searchProducts('ψωμί τοστ', kritikosFakeFetch);
assert.equal(kritikosResults.length, 1);
const [kritikosResult] = kritikosResults;
assert.ok(undefined !== kritikosResult);
assert.equal(kritikosResult.sku, '30083');
assert.equal(kritikosResult.title, 'ΚΑΡΑΜΟΛΕΓΚΟΣ ΨΩΜΙ ΤΟΣΤ ΦΟΡΜΑ 680ΓΡ');
assert.equal(kritikosResult.pricePiece, 1.48);
assert.equal(kritikosResult.priceUnit, 2.17);
assert.equal(kritikosResult.unitLabel, 'κιλό');
assert.ok(kritikosResult.url.endsWith('karamolegkos-psomi-tost-forma-680gr-30083/'));

// Punctuation-only tokens ("&") must not zero out the match.
const kritikosAmpersand = await kritikosAdapter.searchProducts('ψωμί & τοστ', kritikosFakeFetch);
assert.equal(kritikosAmpersand.length, 1);

// An EAN hint matches via barcodes even when NO text token matches (the
// store's abbreviated titles defeat token matching), and the hit is
// stamped with the barcode for exact-match ranking.
const kritikosByEan = await kritikosAdapter.searchProducts('άσχετος όρος', kritikosFakeFetch, {
  ean: '5205711123456',
});
assert.equal(kritikosByEan.length, 1);
assert.equal(kritikosByEan[0]?.sku, '30083');
assert.equal(kritikosByEan[0]?.ean, '5205711123456');

// Weighed items: finalPrice IS the per-kg price.
const kritikosWeighed = await kritikosAdapter.searchProducts('τομάτες', kritikosFakeFetch);
assert.equal(kritikosWeighed.length, 1);
assert.equal(kritikosWeighed[0]?.pricePiece, null);
assert.equal(kritikosWeighed[0]?.priceUnit, 1.98);

// --- kritikos catalog index (the off-edge D1 discovery path) ---------------

// queryTokens is shared by the live scan and the edge index query, so both
// tokenize identically: transliterate, split, drop punctuation-only tokens.
assert.deepEqual(queryTokens('ψωμί & τοστ'), ['pswmi', 'tost']);
assert.deepEqual(queryTokens('   '), []);

// buildHaystack is the shared LIKE target — the lowercased greeklish the live
// scan matches against, so an indexed row matches the same queries a scan would.
const kritikosBread = JSON.parse(KRITIKOS_CATALOG).payload.products[0];
const breadHaystack = buildHaystack(kritikosBread);
assert.ok(breadHaystack.includes('pswmi'));
assert.ok(breadHaystack.includes('tost'));
assert.ok(breadHaystack.includes('karamolegkos'));

// buildCatalogIndex flattens the WHOLE catalog into index rows (never early-exits).
const kritikosIndex = await buildCatalogIndex(kritikosFakeFetch);
assert.equal(kritikosIndex.length, 2);

const breadEntry = kritikosIndex.find((entry) => '30083' === entry.sku);
assert.ok(undefined !== breadEntry);
// Fields map 1:1 onto a scanned search result so discovery is source-agnostic.
assert.equal(breadEntry.name, 'ΚΑΡΑΜΟΛΕΓΚΟΣ ΨΩΜΙ ΤΟΣΤ ΦΟΡΜΑ 680ΓΡ');
assert.ok(breadEntry.url.endsWith('karamolegkos-psomi-tost-forma-680gr-30083/'));
assert.deepEqual(breadEntry.barcodes, ['5205711123456']);
assert.equal(breadEntry.ean, '5205711123456');
assert.equal(breadEntry.pricePiece, 1.48);
assert.equal(breadEntry.priceUnit, 2.17);
assert.equal(breadEntry.unitLabel, 'κιλό');
assert.ok(breadEntry.haystack.includes('pswmi'));

// Weighed item: per-kg price only, and no barcode → empty barcodes / null ean.
const tomatoEntry = kritikosIndex.find((entry) => '1505' === entry.sku);
assert.ok(undefined !== tomatoEntry);
assert.equal(tomatoEntry.pricePiece, null);
assert.equal(tomatoEntry.priceUnit, 1.98);
assert.deepEqual(tomatoEntry.barcodes, []);
assert.equal(tomatoEntry.ean, null);

// An entry missing an identity field (sku/slug/name) is dropped, not indexed.
assert.equal(parseCatalogEntry({ name: 'no sku or slug' }), null);

// scrapeProduct reads __NEXT_DATA__ from the product page.
const KRITIKOS_PRODUCT_HTML = `
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"productSelected":{"_id":"5ab37","sku":"1505","name":"ΤΟΜΑΤΕΣ ΤΣΑΜΠI","isWeighed":true,"finalPrice":198,"beginPrice":198,"itemPrice":99,"unitOfMeasurementFinalPrice":0,"unitOfMeasurement":"ΚΙΛ","quantity":"Κιλό"}}},"page":"/products/[...slug]"}</script>
`;
const kritikosFakePageFetch = (async () => new Response(KRITIKOS_PRODUCT_HTML)) as typeof fetch;
const kritikosScraped = await kritikosAdapter.scrapeProduct(
  'https://kritikos-sm.gr/products/manabikh/laxanika/tomates-tsampi-1505/',
  kritikosFakePageFetch,
);
assert.equal(kritikosScraped.name, 'ΤΟΜΑΤΕΣ ΤΣΑΜΠI');
assert.equal(kritikosScraped.sku, '1505');
assert.equal(kritikosScraped.pricePiece, null);
assert.equal(kritikosScraped.priceUnit, 1.98);
assert.equal(kritikosScraped.unitLabel, 'κιλό');

// --- galaxias ---------------------------------------------------------------
// Magento GraphQL response shape captured live 2026-07-05.

const GALAXIAS_RESPONSE = {
  data: {
    products: {
      total_count: 154,
      items: [
        {
          sku: '5201037509237',
          name: 'Milko γάλα με κακάο 450ml',
          unit_measurement: 'Λίτρο',
          cost_per_unit: '3.7111111111111',
          price_range: { minimum_price: { final_price: { value: 1.67, currency: 'EUR' } } },
        },
        {
          sku: '5201037501576',
          name: 'Milko γάλα με κακάο 4*250ML',
          unit_measurement: null,
          cost_per_unit: null,
          price_range: { minimum_price: { final_price: { value: 4.66, currency: 'EUR' } } },
        },
      ],
    },
  },
};

const galaxiasResults = mapGalaxiasProductsResponse(GALAXIAS_RESPONSE, 'test://fixture');
assert.equal(galaxiasResults.length, 2);
const [galaxiasFirst, galaxiasSecond] = galaxiasResults;
assert.ok(undefined !== galaxiasFirst && undefined !== galaxiasSecond);
assert.equal(galaxiasFirst.sku, '5201037509237');
assert.equal(galaxiasFirst.pricePiece, 1.67);
assert.equal(galaxiasFirst.priceUnit, 3.71);
assert.equal(galaxiasFirst.unitLabel, 'λίτρο');
assert.equal(galaxiasFirst.url, 'https://galaxias.shop/product/5201037509237');
assert.equal(galaxiasSecond.priceUnit, null);
assert.equal(galaxiasSecond.unitLabel, null);

assert.throws(() => {
  mapGalaxiasProductsResponse({ errors: [{ message: 'Internal server error' }] }, 'test://fixture');
}, /Internal server error/);

// Galaxias SKU doubles as the pack EAN.
assert.equal(galaxiasFirst.ean, '5201037509237');

// Leaflet promos live in catalog_rules, NOT in final_price — captured
// live 2026-07-05: 4.47 € with a 25% "ΦΥΛΛΑΔΙΟ" rule renders as 3.35 €
// on the storefront, and the derived unit price rescales with it.
const GALAXIAS_PROMO_RESPONSE = {
  data: {
    products: {
      items: [
        {
          sku: '5202535179175',
          name: 'H.Η.ΓΚΡΑΝΟΛΑ ΦΥΣΤΙΚ/ΤΥΡΟ ΜΑΥΡ.ΣΟΚ. 350Γ',
          unit_measurement: 'Τεμάχιο',
          cost_per_unit: '12.771428571429',
          price_range: { minimum_price: { final_price: { value: 4.47 } } },
          catalog_rules: [
            { action_name: 'percent', actions: { amount: '25' }, tags: ['ΦΥΛΛΑΔΙΟ'] },
          ],
        },
      ],
    },
  },
};

const [galaxiasPromo] = mapGalaxiasProductsResponse(GALAXIAS_PROMO_RESPONSE, 'test://fixture');
assert.ok(undefined !== galaxiasPromo);
assert.equal(galaxiasPromo.pricePiece, 3.35);
assert.equal(galaxiasPromo.priceUnit, 9.57);

// Internal "aDiscount:"-tagged fixed rules must NOT apply (mirrors the
// storefront's own guard); untagged fixed rules must.
const GALAXIAS_FIXED_RESPONSE = {
  data: {
    products: {
      items: [
        {
          sku: '1',
          name: 'X',
          unit_measurement: null,
          cost_per_unit: null,
          price_range: { minimum_price: { final_price: { value: 5 } } },
          catalog_rules: [
            { action_name: 'fixed', actions: { amount: '1' }, tags: ['ΦΥΛΛΑΔΙΟ'] },
            { action_name: 'fixed', actions: { amount: '2' }, tags: ['aDiscount:xyz'] },
          ],
        },
      ],
    },
  },
};

const [galaxiasFixed] = mapGalaxiasProductsResponse(GALAXIAS_FIXED_RESPONSE, 'test://fixture');
assert.equal(galaxiasFixed?.pricePiece, 4);

// --- mymarket EAN merge -------------------------------------------------
// The EAN query's unique hit is stamped and ranked first; duplicates
// from the text search are dropped.

const MYMARKET_EAN_TILE = MYMARKET_SEARCH_FIXTURE;
const mymarketEanFetch = (async (input: string | URL | Request) => {
  const url = String(input);

  if (url.includes('5202535179175')) {
    return new Response(MYMARKET_EAN_TILE);
  }

  return new Response(MYMARKET_SEARCH_FIXTURE);
}) as typeof fetch;

const mymarketMerged = await mymarketAdapter.searchProducts('γάλα εβαπορέ', mymarketEanFetch, {
  ean: '5202535179175',
});
assert.equal(mymarketMerged.length, 1);
assert.equal(mymarketMerged[0]?.ean, '5202535179175');

// --- multi-pass search orchestrator ---------------------------------------
// Pass 1: full query — sklavenitis's engine ANDs every token and returns
// nothing; galaxias returns an exact-title match carrying a barcode.
// Pass 2: brand-only retry rescues sklavenitis.
// Pass 3: the barcode discovered from galaxias (score ≥ 0.6) re-queries
// masoutis, whose text search had nothing.

const SKIP_TITLE = 'Απορρυπαντικό Πλυντηρίου Ρούχων Υγρό Active Clean';
const SKIP_BRAND = 'SKIP';

const mkResult = (
  retailer: RetailerId,
  sku: string,
  title: string,
  ean: string | null,
): RetailerSearchResult => ({
  retailer,
  sku,
  title,
  url: `https://example.test/${retailer}/${sku}`,
  brand: null,
  ean,
  pricePiece: 1,
  priceUnit: null,
  unitLabel: null,
});

const passQueries: Array<{ q: string; retailers?: readonly string[]; ean?: string | null }> = [];

const stubSearch = async (
  q: string,
  retailers?: readonly RetailerId[],
  ean?: string | null,
) => {
  passQueries.push({ q, retailers, ean });

  // Pass 3: EAN re-pass (only fires with the discovered barcode).
  if ('5290001000001' === ean) {
    return {
      results: {
        masoutis: [mkResult('masoutis', 'M9', 'Skip Υγρό Active Clean 52μεζ', '5290001000001')],
      },
      errors: [],
    };
  }

  // Pass 2: brand-only retry.
  if (SKIP_BRAND === q) {
    return {
      results: {
        sklavenitis: [
          mkResult('sklavenitis', 'S1', `${SKIP_BRAND} ${SKIP_TITLE}`, null),
        ],
        masoutis: [],
      },
      errors: [],
    };
  }

  // Pass 1: full query.
  return {
    results: {
      sklavenitis: [],
      masoutis: [mkResult('masoutis', 'M1', 'ΑΛΛΟ ΠΡΟΪΟΝ ΑΣΧΕΤΟ', null)],
      galaxias: [mkResult('galaxias', '5290001000001', `${SKIP_BRAND} ${SKIP_TITLE}`, '5290001000001')],
    },
    errors: [],
  };
};

const orchestrated = await searchAndRank(SKIP_TITLE, SKIP_BRAND, null, undefined, stubSearch);

// Ladder: full → stripped-title-only (brand+stripped dedupes into the
// full query here — no digits in the title) → brand-only → EAN re-pass.
assert.equal(passQueries.length, 4, 'expected exactly four passes');
assert.deepEqual(passQueries[1]?.q, SKIP_TITLE);
assert.deepEqual(passQueries[2]?.q, SKIP_BRAND);
assert.equal(passQueries[3]?.ean, '5290001000001');
assert.equal(orchestrated.discoveredEan, '5290001000001');
// Brand retry rescued sklavenitis…
assert.equal(orchestrated.ranked.get('sklavenitis')?.[0]?.result.sku, 'S1');
assert.ok(0.6 <= (orchestrated.ranked.get('sklavenitis')?.[0]?.score ?? 0));
// …and the EAN re-pass rescued masoutis with an exact (score 1) hit.
assert.equal(orchestrated.ranked.get('masoutis')?.[0]?.result.sku, 'M9');
assert.equal(orchestrated.ranked.get('masoutis')?.[0]?.score, 1);

// With a strong match everywhere, no retries fire.
passQueries.length = 0;
const oneShot = await searchAndRank(SKIP_TITLE, SKIP_BRAND, null, ['galaxias'], async (q, r, e) => {
  passQueries.push({ q, retailers: r, ean: e });
  return {
    results: {
      galaxias: [mkResult('galaxias', 'G1', `${SKIP_BRAND} ${SKIP_TITLE}`, null)],
    },
    errors: [],
  };
});
assert.equal(passQueries.length, 1, 'strong pass-1 match must not trigger retries');
assert.equal(oneShot.discoveredEan, null);

// --- numeric-token poison: the ΟΛΥΜΠΟΣ milk case ---------------------------
// Captured live from sklavenitis.gr (2026-07-06): the full brand+title
// query returns nothing (their engine ANDs every token and chokes on the
// numeric ones), brand-only buries the milk beyond page one — but brand
// plus the digit-stripped title surfaces it. The retry ladder must find
// it and the ranker must clear the suggestion threshold.

const MILK_TITLE = 'Φρέσκο Γάλα Ελαφρύ 1,7% 1lt';
const MILK_BRAND = 'ΟΛΥΜΠΟΣ';
const MILK_STORE_TITLE = 'ΟΛΥΜΠΟΣ Επιλεγμένο Φρέσκο Γάλα Ελαφρύ 1,7% Λιπαρά 1lt';

passQueries.length = 0;
const milkSearch = await searchAndRank(MILK_TITLE, MILK_BRAND, null, ['sklavenitis'], async (q, r, e) => {
  passQueries.push({ q, retailers: r, ean: e });

  // Only the digit-stripped brand+title query surfaces the product.
  if ('ΟΛΥΜΠΟΣ Φρέσκο Γάλα Ελαφρύ' === q) {
    return {
      results: { sklavenitis: [mkResult('sklavenitis', '392040', MILK_STORE_TITLE, null)] },
      errors: [],
    };
  }

  return { results: { sklavenitis: [] }, errors: [] };
});

assert.deepEqual(passQueries[1]?.q, 'ΟΛΥΜΠΟΣ Φρέσκο Γάλα Ελαφρύ');
const milkTop = milkSearch.ranked.get('sklavenitis')?.[0];

if (undefined === milkTop) {
  throw new Error('stripped-title retry must surface the milk');
}

assert.equal(milkTop.result.sku, '392040');
assert.ok(
  null !== milkTop.score && SUGGESTION_THRESHOLD <= milkTop.score,
  `milk must clear the suggestion threshold (got ${milkTop.score})`,
);

// --- resolveIdentityByEan: scan-to-prefill ----------------------------------
// A scanned barcode alone must recover the product's name/brand from the
// fast barcode-capable chains, so the add form fills itself instead of
// forcing the user to type a title. The most descriptive confirmed title
// wins; unconfirmed near-matches and non-barcode chains are ignored.

const PREFILL_EAN = '5290001000001';
const idCalls: Array<{ q: string; retailers?: readonly string[]; ean?: string | null }> = [];

const withBrand = (result: RetailerSearchResult, brand: string): RetailerSearchResult => ({
  ...result,
  brand,
});

const identity = await resolveIdentityByEan(PREFILL_EAN, async (q, r, e) => {
  idCalls.push({ q, retailers: r, ean: e });
  return {
    results: {
      // Galaxias caps-truncates; My Market spells it out and carries the brand.
      galaxias: [mkResult('galaxias', PREFILL_EAN, 'ΦΑΓΕ TOTAL 2% 1KG', PREFILL_EAN)],
      mymarket: [
        withBrand(
          mkResult('mymarket', 'MM1', 'ΦΑΓΕ Total Στραγγιστό Γιαούρτι 2% Λιπαρά 1kg', PREFILL_EAN),
          'ΦΑΓΕ',
        ),
      ],
      // A row the chain thinks is relevant but is NOT the scanned barcode.
      masoutis: [mkResult('masoutis', 'MA9', 'Άλλο γιαούρτι 2% 1kg', null)],
    },
    errors: [],
  };
});

assert.equal(idCalls[0]?.q, PREFILL_EAN, 'resolve queries the chains with the EAN as text');
assert.equal(idCalls[0]?.ean, PREFILL_EAN, 'resolve also passes the EAN as a hint');
assert.deepEqual(idCalls[0]?.retailers, ['galaxias', 'mymarket', 'masoutis'], 'only the fast barcode chains');
assert.ok(null !== identity, 'a scanned barcode resolves an identity');
assert.equal(
  identity?.title,
  'ΦΑΓΕ Total Στραγγιστό Γιαούρτι 2% Λιπαρά 1kg',
  'the most descriptive confirmed title wins',
);
assert.equal(identity?.brand, 'ΦΑΓΕ', 'brand is adopted from whichever chain exposes it');

// No barcode-confirmed row anywhere → null, so the user types the name.
const unresolved = await resolveIdentityByEan(PREFILL_EAN, async () => ({
  results: { galaxias: [mkResult('galaxias', 'G9', 'Κάτι εντελώς άσχετο', null)] },
  errors: [],
}));
assert.equal(unresolved, null, 'no confirmed barcode row resolves to null');

// --- Open Food Facts normalization ------------------------------------------
// Annotated products give a clean Greek name (preferred over the generic /
// international one); photo-only stubs give no name but keep an image; an
// unknown barcode is all-null so the caller falls back to the retailers.

const offFull = normalizeOpenFoodFacts({
  status: 1,
  product: {
    product_name_el: 'ΦΑΓΕ Total Γιαούρτι Στραγγιστό 2% 1kg',
    product_name: 'FAGE Total 2%',
    brands: 'ΦAGE, Fage',
    quantity: '1kg',
    image_front_small_url: 'https://images.openfoodfacts.org/x/front_el.22.200.jpg',
  },
});
assert.equal(offFull.name, 'ΦΑΓΕ Total Γιαούρτι Στραγγιστό 2% 1kg', 'prefers product_name_el');
assert.equal(offFull.brand, 'ΦAGE', 'takes the first of the comma-separated brands');
assert.equal(offFull.quantity, '1kg');
assert.ok(null !== offFull.imageUrl, 'keeps the image');

const offStub = normalizeOpenFoodFacts({
  status: 1,
  product: { image_front_small_url: 'https://images.openfoodfacts.org/x/front_el.7.200.jpg' },
});
assert.equal(offStub.name, null, 'a photo-only stub resolves to no name');
assert.ok(null !== offStub.imageUrl, 'but its image is still usable');

assert.deepEqual(
  normalizeOpenFoodFacts({ status: 0, status_verbose: 'product not found' }),
  { name: null, brand: null, quantity: null, imageUrl: null },
  'an unknown barcode is all-null',
);
assert.equal(
  normalizeOpenFoodFacts({ status: 1, product: { generic_name: 'Στραγγιστό γιαούρτι' } }).name,
  'Στραγγιστό γιαούρτι',
  'falls back to generic_name',
);

// --- collectConfirmedEan ----------------------------------------------------
// Confirmed picks that agree on a barcode stamp the product's identity;
// disagreement (a mis-selected candidate) must stamp nothing.

const confirmedCandidates = new Map<RetailerId, RankedResult[]>([
  ['galaxias', [{ result: mkResult('galaxias', 'G1', 'X', '5290001000001'), score: 1, sizeUnverified: false }]],
  ['kritikos', [{ result: mkResult('kritikos', 'K1', 'X', '5290001000001'), score: 0.8, sizeUnverified: false }]],
  ['sklavenitis', [{ result: mkResult('sklavenitis', 'S1', 'X', null), score: 0.7, sizeUnverified: false }]],
]);

const confirmedPicks = new Map<RetailerId, string | null>([
  ['galaxias', 'G1'],
  ['kritikos', 'K1'],
  ['sklavenitis', 'S1'],
]);

assert.equal(collectConfirmedEan(confirmedCandidates, confirmedPicks), '5290001000001');

const conflictedCandidates = new Map<RetailerId, RankedResult[]>([
  ['galaxias', [{ result: mkResult('galaxias', 'G1', 'X', '5290001000001'), score: 1, sizeUnverified: false }]],
  ['kritikos', [{ result: mkResult('kritikos', 'K1', 'X', '5290009999999'), score: 0.8, sizeUnverified: false }]],
]);

assert.equal(collectConfirmedEan(conflictedCandidates, confirmedPicks), null);

// --- lidl offer expiry: gone pages are lifecycle, not failures --------------

const { ListingGoneError } = await import('../packages/scrapers/src/types');
const { lidlAdapter: lidlForExpiry } = await import('../packages/scrapers/src/lidl');

const gone404 = (async () => new Response('not found', { status: 404 })) as typeof fetch;
await assert.rejects(
  lidlForExpiry.scrapeProduct('https://www.lidl-hellas.gr/p/x/p11145712', gone404),
  ListingGoneError,
);

// Anything else stays a real failure.
const flaky500 = (async () => new Response('oops', { status: 500 })) as typeof fetch;
await assert.rejects(
  lidlForExpiry.scrapeProduct('https://www.lidl-hellas.gr/p/x/p11145712', flaky500),
  (error: unknown) => error instanceof Error && false === (error instanceof ListingGoneError),
);

// The scrape loop routes gone-pages to warnings, real faults to errors.
const { scrapeFailureOutcome } = await import('../apps/worker/src/scrape');

const goneOutcome = scrapeFailureOutcome(
  42,
  new ListingGoneError('lidl', 'https://example.test', 'offer week ended'),
);
assert.equal(goneOutcome.error, undefined);
assert.ok(goneOutcome.warning?.includes('listing 42 (lidl)'));

const faultOutcome = scrapeFailureOutcome(42, new Error('HTTP 500'));
assert.equal(faultOutcome.warning, undefined);
assert.ok(faultOutcome.error?.includes('HTTP 500'));

// --- unit-price sanity check -------------------------------------------------
// The retailer's own €/kg figure must roughly agree with the one implied
// by our parsed pack size; big divergence flags a mis-parse or mislink.

const { unitPriceSanityWarning } = await import('../apps/worker/src/scrape');

const sanityListing = { id: 7, retailer: 'sklavenitis', product_title: 'Granola 350g' };

// 3.14 € / 350 g → 8.97 €/κιλό: agrees with the reported figure.
assert.equal(
  unitPriceSanityWarning(sanityListing, { pricePiece: 3.14, priceUnit: 8.97, unitLabel: 'κιλό' }),
  undefined,
);

// Reported 15 €/κιλό against a computed 8.97 → flagged.
const sanityWarning = unitPriceSanityWarning(sanityListing, {
  pricePiece: 3.14,
  priceUnit: 15,
  unitLabel: 'κιλό',
});
assert.ok(undefined !== sanityWarning && sanityWarning.includes('listing 7'));

// Weighed items (no piece price) and piece-unit labels are out of scope.
assert.equal(
  unitPriceSanityWarning(sanityListing, { pricePiece: null, priceUnit: 5.3, unitLabel: 'κιλό' }),
  undefined,
);
assert.equal(
  unitPriceSanityWarning(
    { id: 8, retailer: 'ab', product_title: 'Αυγά 6 τεμ' },
    { pricePiece: 2.5, priceUnit: 0.42, unitLabel: 'τεμ' },
  ),
  undefined,
);

// --- golden matching set ---------------------------------------------------
// Precision/recall over labeled cross-retailer pairs (tests/golden.ts).
// Floors are ratchets: they start at the measured baseline and must only
// ever be raised as matcher phases land (docs/matching-plan.md). A drop
// below a floor means a matcher change regressed known-good behavior.

// Ratchet history: baseline 0.545/0.857 → Phase 2 normalization 0.70/1.0
// → Phase 3 scoring 1.0/1.0. Any regression from here fails the build.
const GOLDEN_PRECISION_FLOOR = 1;
const GOLDEN_RECALL_FLOOR = 1;

const goldenMetrics = evaluateGoldenSet();
console.log(formatGoldenReport(goldenMetrics));

assert.ok(
  GOLDEN_PRECISION_FLOOR <= goldenMetrics.precision,
  `golden precision ${goldenMetrics.precision.toFixed(3)} fell below floor ${GOLDEN_PRECISION_FLOOR}`,
);
assert.ok(
  GOLDEN_RECALL_FLOOR <= goldenMetrics.recall,
  `golden recall ${goldenMetrics.recall.toFixed(3)} fell below floor ${GOLDEN_RECALL_FLOOR}`,
);

console.log('ALL TESTS PASSED');

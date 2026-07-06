# Product Matching Improvement Plan

**Status:** implemented 2026-07-06 (all phases; see deviations in 1.3, 1.4, 3.2) · **Date:** 2026-07-06
**Result:** golden-set precision 0.545 → 1.000, recall 0.857 → 1.000 (`npm test` prints the current numbers; floors in `tests/run.ts` ratchet them).
**Goal:** correct cross-store product matching — fewer false matches (different product linked), fewer missed matches (same product not found).

## Background

The matcher today: `suggestMatches()` (`packages/core/src/match.ts`) applies a brand hard gate and a size hard gate, then ranks by token-set Jaccard. `rankResults()`/`searchAndRank()` (`apps/web/src/lib/matching.ts`) wrap it with an EAN-equality bypass, a 3-pass search (full query → brand-only retry → EAN discovery), and thresholds (0.35 suggest / 0.6 EAN discovery). A human confirms every match.

Industry practice (price-comparison vendors, Delivery Hero, entity-resolution literature) converges on the same layered pipeline, and we already have its skeleton:

1. **Hard identifiers first** — GTIN/EAN match is identity; fuzzy is only the fallback.
2. **Aggressive normalization** — brand, size, unit, multipack, attributes parsed out of titles; canonical units; script/diacritic folding.
3. **Blocking** — cheap candidate generation (our retailer search suffices at this scale).
4. **Deterministic scoring with hard guardrails** — fuzzy similarity plus attribute agreement; a size or brand contradiction kills the match. Deterministic beats LLM/ML here: explainable, no hallucination.
5. **Golden labeled set** — measure precision/recall so changes don't silently regress.

We are *not* adding embeddings or LLM matching: with 7 retailers and a human in the loop, deterministic + identifiers is the correct depth.

## Identified holes

| # | Hole | Where |
|---|------|-------|
| 1 | Lidl's `gtin13` from JSON-LD is discarded; Lidl not in `EAN_CAPABLE_RETAILERS` | `packages/scrapers/src/lidl.ts:171`, `apps/web/src/lib/matching.ts:26` |
| 2 | EAN discovery is chicken-and-egg: Masoutis/MyMarket only stamp an EAN if given one; discovery only fires if Galaxias/Kritikos fuzzy-score ≥ 0.6 | `apps/web/src/lib/matching.ts:216-240` |
| 3 | No Greek↔Latin homoglyph folding: Latin `NOYNOY` never matches Greek `ΝΟΥΝΟΥ`, silently failing the brand gate | `packages/core/src/normalize.ts:21`, `match.ts:50` |
| 4 | Multipacks mis-parsed: `5x42g` reads as 42 g (first regex hit, no multiplier) | `packages/core/src/normalize.ts:8,36` |
| 5 | Spelling variants (`Φιστικο`/`Φυστικο`) are disjoint tokens under exact Jaccard | `packages/core/src/match.ts:84-100` |
| 6 | Numbers are plain tokens: 3,5% vs 1,5% milk (same brand/size) score near-identical → false match | `normalize.ts:21` (tokenization) |
| 7 | Size gate skipped when either side lacks a parseable size → 350 g matches 500 g | `packages/core/src/match.ts:57-66` |
| 8 | `titleContainsBrand` is substring-based: `bio` matches `biscota` (false pos); codepoint diffs (false neg) | `packages/core/src/normalize.ts:98-104` |
| 9 | No token weighting: generic tokens (γάλα, φρέσκο) count as much as distinguishing ones | `match.ts:84-100` |
| 10 | `searchAndRank` replaces a chain's list only if the new top score is higher — a wrong high scorer blocks a correct later pass | `apps/web/src/lib/matching.ts:199` |
| 11 | AB daily scrape re-searches by title instead of using the stored SKU/URL — index churn silently drops prices | `packages/scrapers/src/ab.ts:32-58` |
| 12 | `products.size_value`/`size_unit` never populated; size re-parsed from title on every compare | `apps/web/src/components/AddProductForm.tsx:87-88`, `apps/worker/schema.sql` |
| 13 | No adversarial matching tests; no precision/recall measurement | `tests/run.ts` |

---

## Phase 1 — Harvest every identifier

*Biggest correctness win per hour. EAN equality already bypasses all fuzzy logic; make it reachable.*

**1.1 Keep Lidl's GTIN.** Map JSON-LD `gtin13` into `ean` in the Lidl search/scrape mappers (`lidl.ts:171`). Add `lidl` to `EAN_CAPABLE_RETAILERS` (`matching.ts:26`).

**1.2 Break the chicken-and-egg.** Whenever *any* source yields an EAN — Galaxias, Kritikos, Lidl, or the user's barcode scan — persist it to `products.ean` immediately and re-run EAN queries against all EAN-capable chains, including chains with already-confirmed listings (re-verification: if the confirmed listing's EAN disagrees, flag it in the UI rather than silently keep it).

**1.3 AB GTIN probe.** ~~Check whether AB's product detail page exposes a GTIN.~~ **Done 2026-07-06: it doesn't.** The full product page has no JSON-LD Product block and no gtin/ean in embedded state (only loyalty-app "barcode" UI strings). AB stays SKU-only; documented in the adapter header.

**1.4 Evaluate `e-katanalotis.gov.gr`.** **Spike outcome 2026-07-06:** the portal now redirects to `posokanei.gov.gr`, and both 403 requests from non-Greek IPs. Re-probe from a Greek network (or the deployed Worker) before investing further; parked until then.

**Acceptance:** for a product carried by Lidl or Galaxias/Kritikos, adding it from any chain ends with `products.ean` populated and all EAN-capable chains matched via EAN, not fuzzy.

## Phase 2 — Fix normalization

*All in `packages/core/src/normalize.ts`; pure functions, easy to test.*

**2.1 Script folding.** In `normalizeTitle`, fold Latin↔Greek homoglyphs to one canonical script (A/Α, B/Β, E/Ε, H/Η, I/Ι, K/Κ, M/Μ, N/Ν, O/Ο, P/Ρ, T/Τ, X/Χ, Y/Υ, Z/Ζ). Handle final sigma (ς→σ) explicitly.

**2.2 Vowel-class fold for comparison only.** A `foldForComparison(token)` that maps η/ι/υ/ει/οι → a single vowel class (and ο/ω → one), used *only* when comparing tokens — never for display. This makes Φιστικο ≈ Φυστικο without touching stored titles.

**2.3 Multipack parsing.** Extend `SIZE_PATTERN` to `N x M unit` / `N*M unit` / `N × M unit`: total size = N·M, pack count = N. Return `{ value, unit, count }`. A multipack (count > 1) must not size-match a single of the per-piece size.

**2.4 Percentage as attribute.** Extract `\d+(,\d+)?\s*%` as a distinct attribute; remove it from the general token pool.

**2.5 Populate `products.size_value`/`size_unit` at creation.** Pre-fill from the parsed title in `AddProductForm`, user-confirmable, sent to the API (`index.ts:200` binding already exists). Stored size becomes the authoritative side of the size gate.

## Phase 3 — Fix scoring

*All in `packages/core/src/match.ts` + thresholds in `apps/web/src/lib/matching.ts`.*

**3.1 Fuzzy token equality.** Inside the Jaccard intersection, treat tokens as equal if identical after `foldForComparison` or within Damerau-Levenshtein distance 1 (min token length 4, to avoid short-token noise).

**3.2 Token weighting.** *(Adjusted during implementation.)* Bare-number tokens leave the general pool as planned. Instead of a runtime document-frequency table (needs corpus infrastructure the client doesn't have), two deterministic mechanisms landed: a static down-weight list for stopwords/category words (γάλα, φρέσκο, …) and a **variant-attribute contradiction gate** — synonym groups per class (full-fat/light/skim; cow/goat/sheep) where naming *different* groups kills the match. The gate encodes the actual failure mode (ΔΕΛΤΑ Πλήρες vs ΔΕΛΤΑ Ελαφρύ) more directly than frequency weighting, which measurably could not push those pairs under the threshold. Revisit DF weighting only if new golden cases demand it.

**3.3 Attribute gate.** Percentage attribute present on both sides and unequal → drop candidate (same semantics as the size gate). Pack count present on both sides and unequal → drop.

**3.4 Brand gate rework.** `titleContainsBrand` matches on token boundaries after script folding, not substrings. When the candidate's `brand` field is null (title-derived brands: Sklavenitis, Galaxias, Kritikos), a failed brand check becomes a heavy score penalty instead of a hard drop — the human still sees the candidate, ranked low.

**3.5 One-sided size penalty.** When exactly one side has a parseable size, apply a fixed penalty and mark the suggestion "size unverified" in `RetailerCandidates`, instead of silently skipping the gate. Both-sides-present behavior (exact match required) is unchanged.

**3.6 Merge passes.** `searchAndRank` merges candidates across passes by retailer SKU (keeping each candidate's best score) instead of replace-only-if-higher-top (`matching.ts:199`).

**3.7 Re-tune thresholds.** After 3.1–3.6 the score distribution shifts; re-derive `SUGGESTION_THRESHOLD` / `EAN_DISCOVERY_THRESHOLD` from the golden set (Phase 4) rather than keeping 0.35/0.6 by inertia.

## Phase 4 — Safety net

**4.1 Golden test set** (do this *first*, alongside Phase 1, to measure before/after). In `tests/run.ts`: labeled true pairs plus adversarial negatives — fat-% variants, multipack vs single, same brand different size, homoglyph brands, spelling variants — drawn from the real fixtures we already have. Assert precision = 1.0 on gated drops and a recall floor on true pairs; print both metrics so every future change is measured.

**4.2 Unit-price sanity check.** At scrape time, compute €/kg (or €/L) from parsed pack size and compare against the retailer's own `priceUnit`; divergence > 20% flags the listing (mis-parse or wrong match) instead of silently recording.

**4.3 AB scrape by SKU.** Daily scrape uses the stored SKU/URL (`retailer_listings.retailer_sku`) rather than re-searching by title (`ab.ts:32`); title re-search remains only as a logged fallback.

---

## Order of work

1. **4.1 golden set** — baseline metrics first.
2. **Phase 1** (1.1–1.3 code, 1.4 spike) — most wrong matches removed per hour spent.
3. **Phase 2** — normalization; each function change validated against the golden set.
4. **Phase 3** — scoring + threshold re-tune.
5. **4.2, 4.3** — scrape-time guards.

## Out of scope

- Embeddings / LLM-judge matching (unwarranted at this scale; revisit only if the golden set shows fuzzy recall stuck below target after Phase 3).
- A full `e-katanalotis.gov.gr` adapter (1.4 is a spike; adapter is follow-up).
- Product merge tooling for existing duplicate rows (worth doing later; this plan prevents new ones).

## References

- Delivery Hero — Semantic Product Matching: https://tech.deliveryhero.com/blog/semantic-product-matching/
- Width.ai — Product Matching in Ecommerce: https://www.width.ai/post/product-matching-in-ecommerce
- Intelligence Node — Product Matching: https://www.intelligencenode.com/solutions/product-matching/
- Block-SCL (blocking + contrastive learning for product matching): https://arxiv.org/pdf/2207.02008
- Towards Data Science — The Rise of Semantic Entity Resolution: https://towardsdatascience.com/the-rise-of-semantic-entity-resolution/
- Multi-signal entity matching with LLM embeddings: https://medium.com/@akulkarni5208/ai-powered-entity-matching-how-i-built-a-multi-signal-matching-system-using-llm-embeddings-and-763c039220da

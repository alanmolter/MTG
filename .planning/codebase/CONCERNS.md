# Codebase Concerns

**Analysis Date:** 2026-04-12

---

## Tech Debt

**Boolean columns stored as integers:**
- Issue: `isArena` and `isPublic` are stored as `integer` (0/1) in the schema instead of native PostgreSQL `boolean`. This leaks SQL semantics into TypeScript — callers must compare `=== 1` or `=== 0` instead of truthy checks.
- Files: `drizzle/schema.ts` (lines 47, 71), `server/db-decks.ts` (line 22)
- Impact: Subtle bugs when using truthiness checks on card/deck objects, inconsistency with the already-correct `isSynthetic: boolean` column on `competitiveDecks`
- Fix approach: Migrate `is_arena` and `is_public` columns to `boolean`, update schema types, fix all callers

**Deck mutation endpoints lack ownership checks:**
- Issue: `decks.addCard`, `decks.removeCard`, and `decks.delete` are `protectedProcedure` (requires auth) but never verify the authenticated user owns the target deck. Any authenticated user can mutate or delete any deck by ID.
- Files: `server/routers.ts` (lines 85–118), `server/db-decks.ts`
- Impact: High-severity authorization bypass — authenticated users can delete or modify other users' decks
- Fix approach: In each mutation, fetch the deck first and verify `deck.userId === ctx.user.id`; throw `TRPCError({ code: 'FORBIDDEN' })` otherwise

**Embeddings are fake heuristic vectors, not real ML:**
- Issue: `generateSimpleEmbedding()` produces a 50-dim vector from color codes, CMC, type hash, rarity, and deterministic ID noise — not trained embeddings. The comment itself says "Em produção, isso seria substituído por Word2Vec real."
- Files: `server/services/embeddings.ts` (lines 31–66)
- Impact: The entire similarity, clustering, and deck recommendation pipeline operates on meaningless vectors. KMeans clusters and "similar card" results have no semantic validity.
- Fix approach: Replace with actual card text embeddings — either a local model (word2vec/fasttext on oracle_text) or an API call (OpenAI text-embedding-3-small for each card, cached in `embeddings_cache`)

**Self-play simulation is non-physical and circular:**
- Issue: `ModelEvaluator.simulateMatch()` uses `extractCardFeatures` scores and random `handFactor` multipliers — not actual MTG rules simulation. Games are effectively decided by random numbers and heuristic scores, not card interactions.
- Files: `server/services/modelEvaluation.ts` (lines 24–80), `server/services/modelLearning.ts` (lines 224–257)
- Impact: Card weights trained via self-play may not reflect actual MTG competitive value. The learning loop reinforces heuristic scores rather than game outcomes.
- Fix approach: Integrate with the bundled Forge engine for actual rules-accurate simulation; `server/services/forgeStatus.ts` already has Forge integration groundwork

**`getDeckCards` has N+1 query pattern:**
- Issue: `getDeckCards` fetches all deck card entries, then queries the `cards` table individually per card inside `Promise.all`.
- Files: `server/db-decks.ts` (lines 116–139)
- Impact: A deck with 60 cards issues 61 database queries per call; slower as card count grows
- Fix approach: Replace with a single JOIN query using `innerJoin(cards, eq(deckCards.cardId, cards.id))`

**`deckToVector` (clustering) has N+1 query per card per deck:**
- Issue: For each deck card, `deckToVector` queries `cards` by name (not ID) inside a `for` loop, then calls `getCardEmbedding` separately.
- Files: `server/services/clustering.ts` (lines 72–110)
- Impact: Clustering a deck with 60 cards issues ~120 sequential DB queries; clustering hundreds of decks is extremely slow
- Fix approach: Batch-fetch all cards by name in a single `inArray` query, then build a map for O(1) lookups; batch-fetch all embeddings similarly

**`CompetitiveLearningBridge` exports empty card arrays:**
- Issue: When exporting competitive decks to `competitive_train.json`, the bridge fetches `competitiveDecks` rows but leaves `cards: []` for every deck (line 82: `cards: [] as Array<{name: string; count: number}>`). The JSON file contains deck metadata but no card data.
- Files: `server/services/competitiveLearningBridge.ts` (lines 76–83)
- Impact: The Python ML training pipeline (`server/ml/`) receives a file with no card data to train on; the training step is a no-op
- Fix approach: Join `competitiveDeckCards` when exporting; populate `cards` array per deck

**Hardcoded meta deck lists will go stale:**
- Issue: `META_DECKS` contains literal deck lists with specific card names (e.g., "Monastery Swiftspear", "Thalia, Guardian of Thraben") committed to source code.
- Files: `server/services/metaDecks.ts`
- Impact: Benchmark evaluations become inaccurate as the metagame evolves; requires code changes to update meta reference decks
- Fix approach: Pull benchmark decks from the `competitive_decks` table at runtime (already imported via scrapers), falling back to hardcoded only when the table is empty

**`createDeck` uses name+userId for deduplication instead of RETURNING:**
- Issue: After inserting a deck, the code re-queries with `WHERE userId=... AND name=...` to get the created row. If two decks with the same name are created concurrently, it may return the wrong row.
- Files: `server/db-decks.ts` (lines 15–35)
- Impact: Race condition on concurrent deck creation with the same name; non-atomic pattern
- Fix approach: Use `.returning()` on the Drizzle insert call to get the created row directly

---

## Known Bugs

**`addCardToDeck` hard-caps at 4 copies regardless of format:**
- Symptoms: Commander decks (singleton format) allow up to 4 copies of non-basic cards via the add-card endpoint
- Files: `server/db-decks.ts` (lines 72, 85)
- Trigger: Add any non-basic card more than once to a Commander-format deck
- Workaround: None — the format-aware cap only exists in `validateDeck`, not in `addCardToDeck`

**LLM deck generator validates against a stub card object:**
- Symptoms: `validateDeck` receives cards from the LLM with `id: 0`, `scryfallId: ""`, `colors: null`, `cmc: null` — missing all real card data. Validation warnings about color balance are meaningless.
- Files: `server/services/llmDeckGenerator.ts` (lines 312–338)
- Trigger: Every LLM deck generation call
- Workaround: The `enrichWithLearnedWeights` call provides valid names, but the `validation` result is structurally invalid

**`CardLearningQueue.updateCardWeight` silently swallows errors:**
- Symptoms: DB errors during weight updates are caught and return `{ updated: false }` with no logging.
- Files: `server/services/cardLearningQueue.ts` (lines 291–293)
- Trigger: DB connection failure or constraint violation during weight update
- Workaround: Queue stats (`totalUpdated`) will be lower than expected but no alert fires

---

## Security Considerations

**No deck ownership verification on mutations:**
- Risk: Any authenticated user can add/remove cards from or delete any deck by guessing numeric IDs
- Files: `server/routers.ts` (lines 85–118), `server/db-decks.ts`
- Current mitigation: `protectedProcedure` ensures the user is authenticated, but not that they own the target resource
- Recommendations: Add ownership check in each mutation handler; consider a DB-level helper `assertDeckOwner(deckId, userId)` called before mutations

**All generator and scraper endpoints are `publicProcedure`:**
- Risk: Unauthenticated users can trigger expensive operations: Scryfall sync (up to 5000 card downloads), MTGTop8/MTGGoldfish scraping, embedding training, clustering, and LLM deck generation
- Files: `server/routers.ts` (all `sync`, `mtgtop8`, `mtggoldfish`, `training`, `generator` routers)
- Current mitigation: No rate limiting or authentication required
- Recommendations: Move expensive data-import and training endpoints to `protectedProcedure` at minimum; add rate limiting for LLM generation (cost-sensitive)

**ANTHROPIC_API_KEY accessed directly from `process.env` in service code:**
- Risk: If the key is missing, the error message in the thrown exception includes the env var name and is returned to the API caller via tRPC error propagation
- Files: `server/services/llmDeckGenerator.ts` (lines 137–142), `server/scripts/llmWeeklyCalibrator.ts` (line 58)
- Current mitigation: The `ENV` pattern in `server/_core/env.ts` centralizes env vars but is not used for the Anthropic key
- Recommendations: Add `anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? ""` to `ENV`; check at startup rather than per-request

**Scraper User-Agent spoofs a real browser:**
- Risk: MTGTop8 and MTGGoldfish terms of service may prohibit scraping; using a Chrome UA to circumvent bot detection could result in IP ban or legal exposure
- Files: `server/services/mtgtop8Scraper.ts` (line 4), `server/services/mtggoldfishScraper.ts` (line 4)
- Current mitigation: Batching and delays reduce request frequency
- Recommendations: Review terms of service; consider using official APIs or attribution; at minimum document the scraping dependency

---

## Performance Bottlenecks

**Clustering a large deck database:**
- Problem: `clusterCompetitiveDecks` calls `deckToVector` for every deck, each triggering N+1 DB queries (one per card per deck). Clustering 500 decks × 60 cards = ~30,000 sequential DB queries.
- Files: `server/services/clustering.ts` (`deckToVector` function, lines 41–146)
- Cause: Sequential per-card lookups inside `deckToVector` with no batching
- Improvement path: Batch all card fetches with `inArray(cards.name, allCardNames)` across the entire deck set; cache embeddings in memory during a clustering run

**Embedding generation blocks on per-card DB read-write:**
- Problem: `getCardEmbedding` (called per card during clustering and similarity search) reads from `embeddings_cache`, generates if missing, and writes back — each as separate DB operations
- Files: `server/services/embeddings.ts`
- Cause: No bulk generation; cache misses trigger inline generation per card
- Improvement path: Add a background pre-generation job that populates `embeddings_cache` for all cards; `getCardEmbedding` then becomes a read-only cache hit

**`optimizeDeck` calls `getCardSynergy` O(n²) per iteration:**
- Problem: For every card in the deck, it queries synergy against every other card: 60 cards × 60 cards × 5 iterations = 18,000 potential DB queries per optimization call
- Files: `server/services/deckGenerator.ts` (lines 156–206)
- Cause: No memoization or bulk query for synergy scores
- Improvement path: Fetch all relevant synergy rows in a single query at the start of optimization; build an in-memory lookup map

**Weight cache invalidated and reloaded per-process:**
- Problem: `_weightCache` in `modelLearning.ts` is a module-level variable. Multiple concurrent training scripts (each as a separate Node process) each maintain their own stale 60-second cache with no cross-process coordination.
- Files: `server/services/modelLearning.ts` (lines 41–43)
- Cause: In-memory cache is not shared across Node.js processes
- Improvement path: Acceptable for single-process server; document that parallel script execution may produce inconsistent weight reads

---

## Fragile Areas

**Scraper HTML parsing via regex against undocumented site structure:**
- Files: `server/services/mtgtop8Scraper.ts` (lines 87–153), `server/services/mtggoldfishScraper.ts`
- Why fragile: MTGTop8 uses unquoted HTML attributes; the parsing regex was already fixed once for this (`CORREÇÃO CRÍTICA` comment). Any site redesign silently returns zero archetypes/decks with no error.
- Safe modification: Always check `archetypes.length === 0` guard (already present); add integration test that validates non-zero import count against a recorded HTML fixture
- Test coverage: `mtgtop8Scraper.test.ts` and `mtggoldfishScraper.test.ts` exist but mock `fetch` — they do not catch site structure changes

**Pipeline cache files committed to repo:**
- Files: `.pipeline_cache/*.json`, `.pipeline_cache/*.done` (committed as checked in artifacts)
- Why fragile: `generated_decks.json`, `ladder_ratings.json`, `replay_buffer.jsonl`, etc. are large JSON files in the repo root. Concurrent pipeline runs or a crashed run leave stale `.done` sentinel files that skip re-runs.
- Safe modification: Add `.pipeline_cache/` to `.gitignore`; treat cache as ephemeral

**`getDb()` returns `null` silently instead of throwing:**
- Files: `server/db.ts` (lines 12–26)
- Why fragile: Every service that calls `getDb()` must handle `null` with its own null-guard. In practice many services return empty arrays or `null` silently — the application appears to work but returns no data when the DB connection drops.
- Safe modification: Consider a variant `requireDb()` that throws `new Error("Database unavailable")` for use in contexts where DB is required; reserve the nullable form for scripts that must tolerate missing DB

**`CompetitiveLearningBridge` uses hardcoded relative paths:**
- Files: `server/services/competitiveLearningBridge.ts` (lines 43–45)
- Why fragile: Paths like `"server/ml/models/competitive_train.json"` are relative to the working directory at process start — they work when running from the project root but break when scripts are run from other directories (common in CI or when using `tsx` with a different cwd)
- Safe modification: Use `path.join(import.meta.dirname, '../../server/ml/models/...')` or pass the base path via config

---

## Scaling Limits

**`card_learning` table grows unbounded:**
- Current capacity: One row per unique card name encountered across all learning sources
- Limit: No archival or pruning strategy; as tournaments are imported and self-play runs, the table accumulates rows for every card ever seen, including misspelled card names from scrapers
- Scaling path: Add periodic pruning of zero-weight or rarely-updated entries; normalize card names to `cards.name` via FK rather than free-text `cardName` varchar

**`metaStats` play_rate and win_rate stored as integers:**
- Current capacity: `playRate` and `winRate` are `integer` columns (not `real` or `decimal`)
- Limit: Percentages stored as integers (e.g., 52 for 52%) lose sub-integer precision; calculations that produce fractional rates will be silently truncated on write
- Scaling path: Migrate to `real` columns to support fractional rates

---

## Dependencies at Risk

**`mysql2` listed as production dependency but project uses PostgreSQL:**
- Risk: `mysql2@^3.15.0` is in `dependencies` (not `devDependencies`) but the project schema and all queries use `postgres.js` and Drizzle with PostgreSQL. This is dead weight adding ~2MB to the bundle.
- Impact: Unused dependency increases attack surface; any MySQL2 vulnerability requires patching even though it's never called
- Migration plan: Remove from `package.json`

**`npm install --legacy-peer-deps` required in CI:**
- Risk: Both GitHub Actions workflows use `--legacy-peer-deps` flag, indicating unresolved peer dependency conflicts in the package tree
- Impact: The flag silently bypasses peer dependency checks — incompatible package versions may coexist, causing runtime failures that are hard to trace
- Migration plan: Audit peer dependency conflicts and resolve them; remove `--legacy-peer-deps` from CI commands

---

## Missing Critical Features

**No rate limiting on any API endpoint:**
- Problem: All tRPC procedures (including expensive LLM generation, Scryfall sync, and scraping imports) have no rate limiting
- Blocks: Production deployment without risk of cost runaway on LLM endpoints or DoS via scraper triggers from unauthenticated clients

**No pagination on card search:**
- Problem: `cards.search` in `server/routers.ts` returns all matching cards from the DB; `searchCards` in `server/services/scryfall.ts` has no `LIMIT`/`OFFSET`
- Files: `server/routers.ts` (lines 20–34), `server/services/scryfall.ts`
- Blocks: As the card database grows (5,000+ cards from Scryfall sync), card search responses become arbitrarily large

---

## Test Coverage Gaps

**No tests for authorization/ownership logic:**
- What's not tested: No test verifies that `decks.addCard`, `decks.removeCard`, or `decks.delete` reject requests from users who do not own the target deck
- Files: `server/db-decks.test.ts`, `server/auth.logout.test.ts`
- Risk: The ownership bug (documented in Security section) could ship undetected
- Priority: High

**No tests for the LLM generator pipeline:**
- What's not tested: `server/services/llmDeckGenerator.ts` has no test file. The Anthropic API call, JSON parsing, deck validation integration, and weight enrichment are all untested.
- Files: `server/services/llmDeckGenerator.ts`
- Risk: Prompt format changes or API response shape changes break silently
- Priority: High

**No client-side tests at all:**
- What's not tested: `client/src/` has zero test files. All pages (`ArchetypeGenerator.tsx` at 1648 lines, `DeckGenerator.tsx` at 477 lines, etc.) are untested.
- Files: `client/src/pages/`, `client/src/components/`
- Risk: UI regressions go undetected; the 1648-line `ArchetypeGenerator.tsx` in particular is a high-risk monolith
- Priority: Medium

**Scraper tests use mocked fetch and cannot detect site changes:**
- What's not tested: The regex parsing logic against real HTML structure is never exercised against real or recorded HTML fixtures
- Files: `server/services/mtgtop8Scraper.test.ts`, `server/services/mtggoldfishScraper.test.ts`
- Risk: Site redesigns silently break imports; CI passes while production imports return zero decks
- Priority: Medium

---

*Concerns audit: 2026-04-12*

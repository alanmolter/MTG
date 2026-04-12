# Codebase Structure

**Analysis Date:** 2026-04-12

## Directory Layout

```
mtg-deck-mvp/
├── client/                   # React SPA (Vite root)
│   ├── index.html            # HTML entry point
│   ├── public/               # Static assets served as-is
│   └── src/
│       ├── main.tsx          # React + tRPC bootstrap
│       ├── App.tsx           # Router and providers
│       ├── index.css         # Global Tailwind styles
│       ├── const.ts          # Client-side constants (login URL)
│       ├── _core/            # Framework hooks (auth)
│       ├── components/       # Shared UI components
│       │   └── ui/           # shadcn/ui primitives (Radix-based)
│       ├── contexts/         # React context providers
│       ├── hooks/            # Custom React hooks
│       ├── lib/              # Utility modules (trpc client, utils)
│       └── pages/            # Route-level page components
├── server/                   # Node.js Express server
│   ├── _core/                # Infrastructure: bootstrap, auth, LLM, env
│   ├── routers.ts            # tRPC AppRouter definition (all procedures)
│   ├── db.ts                 # Drizzle connection + user helpers
│   ├── db-decks.ts           # Deck CRUD operations
│   ├── storage.ts            # Manus/Forge file storage helpers
│   ├── services/             # Domain business logic services
│   ├── scripts/              # Standalone CLI ML pipeline scripts
│   └── data/                 # Server-side fixtures (regression_fixtures.json)
├── shared/                   # Isomorphic code (server + client)
│   ├── _core/                # Shared error types
│   ├── const.ts              # Cookie name, error messages, timeouts
│   └── types.ts              # Re-exports all Drizzle schema types
├── drizzle/                  # Database schema and migrations
│   ├── schema.ts             # Table definitions + TypeScript types
│   ├── relations.ts          # Drizzle relation declarations
│   └── migrations/           # Ordered SQL migration files
├── tests/                    # Playwright e2e tests
│   └── navigation.spec.ts
├── dist/                     # Build output (gitignored)
│   └── public/               # Vite-built client assets
├── data/                     # Static data files (model_baseline.json)
├── patches/                  # pnpm patches (wouter)
├── .planning/                # GSD planning artifacts
│   └── codebase/             # Codebase analysis documents
├── .manus-logs/              # Browser debug logs (dev only, gitignored)
├── .pipeline_cache/          # ML pipeline cache files
├── package.json              # Single package.json (monorepo in one package)
├── tsconfig.json             # TypeScript config (project-wide)
├── vite.config.ts            # Vite config (root = client/, alias @, @shared, @assets)
├── vitest.config.ts          # Vitest unit test config
├── drizzle.config.ts         # Drizzle Kit config
└── pnpm-lock.yaml            # Lockfile
```

## Directory Purposes

**`client/src/pages/`:**
- Purpose: One file per route; these are the route-level components wired in `App.tsx`
- Contains: Full page implementations with tRPC hook calls
- Key files:
  - `ArchetypeGenerator.tsx` — primary deck generation UI (most complex page)
  - `DeckBuilder.tsx` — manual deck builder
  - `CardSearch.tsx` — card search and browsing
  - `SynergyGraph.tsx` — Cytoscape.js card synergy visualization
  - `DeckGenerator.tsx` — basic random deck generation
  - `Home.tsx` — landing/dashboard page
  - `SharedDeck.tsx` — public shared deck view (`/shared/:shareId`)
  - `Pipeline.tsx` — ML pipeline management UI
  - `SyncData.tsx` — Scryfall sync UI
  - `Clustering.tsx` — deck clustering visualization

**`client/src/components/ui/`:**
- Purpose: shadcn/ui component library; Radix UI primitives with Tailwind styling
- Contains: ~40 primitive components (Button, Dialog, Select, Table, etc.)
- Key files: All files follow the shadcn pattern — do not modify manually; regenerate via `components.json`

**`client/src/components/`:**
- Purpose: Application-specific composite components (not primitives)
- Key files:
  - `DashboardLayout.tsx` — shared layout with sidebar navigation
  - `AIChatBox.tsx` — AI chat interface component
  - `CardCard.tsx` — card display component
  - `ErrorBoundary.tsx` — React error boundary wrapping the app

**`client/src/hooks/`:**
- Purpose: Custom React hooks for UI behavior
- Key files:
  - `useComposition.ts` — deck composition state management
  - `useMobile.tsx` — mobile breakpoint detection
  - `use-toast.ts` — Sonner toast helper

**`client/src/lib/`:**
- Purpose: Non-React utility modules
- Key files:
  - `trpc.ts` — creates `trpc` client object bound to `AppRouter`
  - `utils.ts` — `cn()` Tailwind class merge utility

**`server/_core/`:**
- Purpose: Framework-level infrastructure not specific to MTG domain
- Key files:
  - `index.ts` — Express + tRPC server startup, port selection
  - `trpc.ts` — `publicProcedure`, `protectedProcedure`, `adminProcedure` exports
  - `context.ts` — per-request `TrpcContext` creation (authenticates user from cookie)
  - `oauth.ts` — `GET /api/oauth/callback` route
  - `env.ts` — typed environment variable access (validates required vars at startup)
  - `llm.ts` — generic LLM wrapper types and client (used by `llmDeckGenerator.ts`)
  - `sdk.ts` — Manus platform SDK (auth token exchange, session creation)
  - `vite.ts` — Vite dev server integration helpers

**`server/services/`:**
- Purpose: All MTG-domain business logic; each file owns one capability area
- Key files:
  - `archetypeGenerator.ts` — archetype-templated rule-based deck building
  - `deckGenerator.ts` — initial deck gen, RL optimization (`trainDeckWithRL`), `validateDeck`, `evaluateDeckWithBrain`
  - `deckEvaluationBrain.ts` — holistic scoring facade; uses `gameFeatureEngine` + `metaAnalytics`
  - `gameFeatureEngine.ts` — card feature extraction, mana curve, turn simulation
  - `modelLearning.ts` — `modelLearningService` static class; card weight CRUD with 60s cache
  - `cardLearningQueue.ts` — singleton serialized write queue for `card_learning` table
  - `llmDeckGenerator.ts` — Anthropic Claude integration for AI deck generation
  - `embeddings.ts` — card vector similarity (`findSimilarCards`)
  - `embeddingTrainer.ts` — trains embeddings from competitive deck co-occurrence
  - `clustering.ts` — k-means clustering of competitive decks
  - `synergy.ts` — card synergy scores from `cardSynergies` table
  - `scryfall.ts` — Scryfall API queries (`searchCards`, `getCardById`)
  - `scryfallSync.ts` — bulk Scryfall import into `cards` table
  - `mtggoldfishScraper.ts` — scrapes MTGGoldfish competitive decks
  - `mtgtop8Scraper.ts` — scrapes MTGTop8 competitive decks
  - `metaAnalysis.ts` — meta stats queries and analysis
  - `metaAnalytics.ts` — `MetaAnalytics` class; benchmark generation and comparison
  - `metaDecks.ts` — `META_DECKS` constant: reference archetype decklists
  - `deckSharing.ts` — shareable link creation and retrieval
  - `deckVisualization.ts` — AI image generation for deck art
  - `modelEvaluation.ts` — `ModelEvaluator` for scoring model performance

**`server/scripts/`:**
- Purpose: Offline ML pipeline; run standalone via `tsx`; safe to kill anytime (DB writes are transactional)
- Key files:
  - `continuousTraining.ts` — self-play population loop (most important training script)
  - `fullBrainTraining.ts` — full pipeline: scrape → train embeddings → self-play
  - `llmWeeklyCalibrator.ts` — uses LLM to calibrate card weights weekly
  - `applyTournamentSignal.ts` — injects tournament win signals into `card_learning`
  - `trainCommander.ts` — Commander-format specialist training
  - `regressionTest.ts` — model regression benchmarks
  - `checkCommanderWeights.ts` / `checkLearning.ts` — weight inspection utilities
  - `utils/parseArgs.ts` — CLI argument parser for all scripts

**`drizzle/`:**
- Purpose: Database schema management; Drizzle Kit reads `drizzle.config.ts` for migration generation
- Key files:
  - `schema.ts` — canonical table definitions; all types inferred from here
  - `relations.ts` — Drizzle relation declarations for typed joins
  - SQL files `0000_*.sql` through `0004_*.sql` — ordered migration history

**`shared/`:**
- Purpose: Code safely importable by both server (`server/`) and client (`client/src/`) without circular deps
- Key files:
  - `const.ts` — `COOKIE_NAME`, error message strings used in both `server/_core/trpc.ts` and `client/src/main.tsx`
  - `types.ts` — re-exports all schema types; client pages import `Card`, `Deck`, etc. from here

## Key File Locations

**Entry Points:**
- `server/_core/index.ts`: HTTP server (Express + tRPC + Vite)
- `client/src/main.tsx`: React SPA root with tRPC/QueryClient setup
- `client/index.html`: Vite HTML root

**Configuration:**
- `vite.config.ts`: Path aliases (`@` → `client/src`, `@shared` → `shared`, `@assets` → `attached_assets`), build output
- `tsconfig.json`: TypeScript project config; same aliases as vite
- `drizzle.config.ts`: Drizzle Kit migration config
- `vitest.config.ts`: Unit test runner config
- `server/_core/env.ts`: All environment variable definitions (typed access)

**Core Logic:**
- `server/routers.ts`: All tRPC procedures (single file for full API overview)
- `drizzle/schema.ts`: All database tables and TypeScript types
- `server/services/deckEvaluationBrain.ts`: Central AI scoring orchestrator
- `server/services/modelLearning.ts`: Card weight management (learning brain)
- `server/services/cardLearningQueue.ts`: Write serialization (critical for correctness)

**Testing:**
- `server/services/*.test.ts`: Unit tests co-located with service files
- `server/*.test.ts`: `auth.logout.test.ts`, `db-decks.test.ts`
- `tests/navigation.spec.ts`: Playwright e2e test

## Naming Conventions

**Files:**
- Services: `camelCase.ts` (e.g., `deckEvaluationBrain.ts`, `cardLearningQueue.ts`)
- Test files: `<serviceName>.test.ts` co-located with source
- tRPC router: singular `routers.ts` at server root
- DB helpers: `db.ts` (connection), `db-decks.ts` (domain-specific)
- React pages: `PascalCase.tsx` (e.g., `ArchetypeGenerator.tsx`)
- React components: `PascalCase.tsx`
- React hooks: `camelCase.ts` prefixed with `use` (e.g., `useComposition.ts`)

**Directories:**
- `_core/` prefix for infrastructure/framework directories (server and client)
- `ui/` for raw primitive components under `components/`
- `services/` for domain logic
- `scripts/` for CLI tools

## Where to Add New Code

**New tRPC API endpoint:**
- Add sub-router or procedure in `server/routers.ts`
- Add corresponding service function in `server/services/<domain>.ts`
- Client access via `trpc.<routerName>.<procedureName>.useQuery/useMutation()`

**New database table:**
- Add table definition to `drizzle/schema.ts`
- Export inferred types (`$inferSelect`, `$inferInsert`)
- Run `pnpm db:push` to generate and apply migration
- Types automatically available via `shared/types.ts`

**New page/route:**
- Create `client/src/pages/<PageName>.tsx`
- Add `<Route path="/..." component={PageName} />` to `App.tsx`

**New reusable component:**
- Application-specific: `client/src/components/<ComponentName>.tsx`
- UI primitive (shadcn pattern): `client/src/components/ui/<name>.tsx`

**New React hook:**
- Add to `client/src/hooks/use<HookName>.ts`

**New shared constant/type:**
- Constants: add to `shared/const.ts`
- Types from DB schema: add table to `drizzle/schema.ts`; re-export from `shared/types.ts` if needed
- Non-schema types: add to `shared/_core/` or co-locate with the service that owns them

**New CLI training script:**
- Add to `server/scripts/<scriptName>.ts`
- Add npm script to `package.json` if it should be a first-class command
- Import `parseArgs` from `server/scripts/utils/parseArgs.ts` for CLI argument handling
- Call `closeDb()` before process exit to avoid hanging

## Special Directories

**`.planning/`:**
- Purpose: GSD planning documents and codebase analysis
- Generated: No (hand-authored + agent-written)
- Committed: Yes

**`.pipeline_cache/`:**
- Purpose: Cached intermediate results from ML pipeline scripts
- Generated: Yes
- Committed: Partially (baseline model files)

**`dist/`:**
- Purpose: Compiled server JS (`dist/index.js`) and client assets (`dist/public/`)
- Generated: Yes (`npm run build`)
- Committed: No (gitignored)

**`.manus-logs/`:**
- Purpose: Browser console/network/session replay logs written by Vite dev plugin
- Generated: Yes (dev mode only)
- Committed: No

**`drizzle/migrations/`:**
- Purpose: SQL migration history managed by Drizzle Kit
- Generated: Yes (via `drizzle-kit generate`)
- Committed: Yes (migrations are part of source history)

---

*Structure analysis: 2026-04-12*

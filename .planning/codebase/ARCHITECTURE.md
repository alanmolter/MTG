# Architecture

**Analysis Date:** 2026-04-12

## Pattern Overview

**Overall:** Full-Stack Monorepo with tRPC API Layer and AI/ML Pipeline

**Key Characteristics:**
- Single Express server serves both API (`/api/trpc`) and static client assets
- End-to-end type safety via tRPC: shared `AppRouter` type flows from `server/routers.ts` directly into the React client via `client/src/lib/trpc.ts`
- AI subsystem embedded within the server: deck generation, evaluation, and learning all run server-side as TypeScript services
- Background ML pipeline (self-play, continuous training) runs as standalone CLI scripts against the same database, fully decoupled from the HTTP server lifecycle
- Drizzle ORM for PostgreSQL defines the canonical schema in `drizzle/schema.ts`; all server code imports types from there

## Layers

**Infrastructure / Core (`server/_core/`):**
- Purpose: Cross-cutting concerns — server bootstrap, auth context, tRPC setup, environment, LLM client, OAuth
- Location: `server/_core/`
- Contains: `index.ts` (server entrypoint), `trpc.ts` (procedure factories), `context.ts` (per-request auth), `oauth.ts` (OAuth callback route), `env.ts` (env var validation), `llm.ts` (LLM wrapper), `sdk.ts` (Manus SDK bridge)
- Depends on: `drizzle/schema.ts`, `shared/const.ts`
- Used by: `server/routers.ts`, all services

**API Router Layer (`server/routers.ts`):**
- Purpose: Defines all tRPC procedures grouped by domain; is the single source of `AppRouter` type
- Location: `server/routers.ts`
- Contains: `cards`, `decks`, `generator`, `sync`, `mtgtop8`, `mtggoldfish`, `training`, `visualization`, `sharing`, `meta` sub-routers
- Depends on: `server/_core/trpc.ts`, all `server/services/*`, `server/db-decks.ts`
- Used by: `client/src/lib/trpc.ts` (type import only); `server/_core/index.ts` mounts it at `/api/trpc`

**Database Access Layer (`server/db.ts`, `server/db-decks.ts`):**
- Purpose: Lazy-initialized PostgreSQL connection via Drizzle; domain-specific deck CRUD helpers
- Location: `server/db.ts` (connection + user helpers), `server/db-decks.ts` (deck CRUD)
- Contains: `getDb()`, `getRawClient()`, `closeDb()`, `upsertUser()`, `getUserByOpenId()` in db.ts; deck/card operations in db-decks.ts
- Depends on: `drizzle/schema.ts`, `postgres` driver
- Used by: all server services, CLI scripts

**Schema / Migrations (`drizzle/`):**
- Purpose: Canonical data model; single source of truth for types
- Location: `drizzle/schema.ts`, `drizzle/relations.ts`, `drizzle/migrations/`
- Contains: tables `users`, `cards`, `decks`, `deckCards`, `cardSynergies`, `metaStats`, `embeddingsCache`, `competitiveDecks`, `competitiveDeckCards`, `trainingJobs`, `deckShares`, `cardLearning`, `rlDecisions`
- Depends on: `drizzle-orm/pg-core`
- Used by: all server-side code; `shared/types.ts` re-exports all inferred types

**Domain Services (`server/services/`):**
- Purpose: Business logic; each file owns one domain capability
- Location: `server/services/`
- Key services:
  - `archetypeGenerator.ts` — rule-based deck construction from card pool + archetype template
  - `deckGenerator.ts` — initial deck generation, RL optimization loop (`trainDeckWithRL`), deck validation
  - `deckEvaluationBrain.ts` — holistic deck scoring orchestrator; initializes meta benchmarks on first call
  - `gameFeatureEngine.ts` — extracts card features, computes mana curve, land ratio, mechanic synergy scores
  - `modelLearning.ts` — `modelLearningService` class managing card weight CRUD with in-memory cache (60s TTL)
  - `cardLearningQueue.ts` — serialized FIFO queue preventing race conditions on `card_learning` table writes
  - `llmDeckGenerator.ts` — LLM-backed (Anthropic Claude) deck generation pipeline
  - `embeddings.ts` / `embeddingTrainer.ts` — vector embeddings for card similarity
  - `clustering.ts` — k-means clustering of competitive decks
  - `synergy.ts` — card synergy scoring via co-occurrence analysis
  - `metaAnalysis.ts` / `metaAnalytics.ts` / `metaDecks.ts` — meta game benchmarks
  - `scryfall.ts` / `scryfallSync.ts` — Scryfall API client + bulk card sync
  - `mtggoldfishScraper.ts` / `mtgtop8Scraper.ts` — competitive deck scrapers
  - `deckSharing.ts` / `deckVisualization.ts` — share links and AI image generation
- Depends on: `server/db.ts`, `drizzle/schema.ts`
- Used by: `server/routers.ts`, CLI scripts

**CLI Scripts (`server/scripts/`):**
- Purpose: Standalone processes for offline ML pipeline tasks; run via `tsx` directly
- Location: `server/scripts/`
- Contains: `continuousTraining.ts` (self-play loop), `fullBrainTraining.ts`, `llmWeeklyCalibrator.ts`, `applyTournamentSignal.ts`, `trainCommander.ts`, `regressionTest.ts`, `checkLearning.ts`, `checkCommanderWeights.ts`, `verifyPersistence.ts`, `testEvaluation.ts`
- Depends on: same services and DB layer as the HTTP server
- Used by: npm scripts (`teach`, `calibrate:llm`, `signal:tournament`) and CI/manual runs

**Shared Layer (`shared/`):**
- Purpose: Types and constants accessible to both server and client without circular imports
- Location: `shared/`
- Contains: `const.ts` (cookie name, error messages, timeouts), `types.ts` (re-exports all Drizzle schema types + error types), `_core/errors.ts`
- Used by: both `server/*` and `client/src/*` via `@shared` path alias

**Client (`client/src/`):**
- Purpose: React SPA; communicates exclusively through tRPC hooks
- Location: `client/src/`
- Contains: `main.tsx` (tRPC + QueryClient bootstrap), `App.tsx` (router), `pages/`, `components/`, `hooks/`, `contexts/`, `lib/`
- Depends on: `@trpc/react-query`, `@tanstack/react-query`, `wouter` (routing)
- Used by: end users via browser

## Data Flow

**User Deck Generation (Archetype Path):**

1. User submits form in `client/src/pages/ArchetypeGenerator.tsx`
2. tRPC mutation `trpc.generator.generateByArchetype.useMutation()` fires via `httpBatchLink` to `POST /api/trpc/generator.generateByArchetype`
3. `server/routers.ts` handler loads card pool from `searchCards()`, fetches learned weights from `modelLearningService.getCardWeights()`
4. `archetypeGenerator.ts` → `generateDeckByArchetype()` selects cards via weighted scoring against archetype template
5. `deckGenerator.ts` → `evaluateDeckWithBrain()` delegates to `deckEvaluationBrain.ts` for holistic scoring
6. `deckGenerator.ts` → `validateDeck()` checks format legality
7. `cardLearningQueue.enqueue()` called for each card in generated deck (non-blocking, async feedback)
8. Response (deck list + metrics + export text) serialized via SuperJSON and returned to client

**LLM Generation Path:**

1. Client calls `trpc.generator.generateWithAI.useMutation()`
2. `llmDeckGenerator.ts` → queries DB for card pool with meta stats, calls Anthropic Claude API
3. LLM returns structured JSON; `validateDeck()` checks legality; `modelLearningService.getCardWeights()` scores result
4. Response returned to client with strategy rationale per card

**Card Learning Feedback Loop:**
1. Deck generation / self-play / tournament signal enqueues `CardLearningUpdate` entries into `CardLearningQueue`
2. Single-worker FIFO queue serializes all writes to `card_learning` table
3. Weight updates bounded to `[0.1, 50.0]` with decay formula; cache invalidated after write
4. Next deck generation reads updated weights via `modelLearningService.getCardWeights()` (60s cache)

**Self-Play Training (Offline):**
1. `server/scripts/continuousTraining.ts` runs standalone via `tsx`
2. Generates populations of decks across archetypes, simulates matches using `deckEvaluationBrain.ts`
3. Winners/losers feed back into `CardLearningQueue`; no HTTP server required

**State Management (Client):**
- Server state: `@tanstack/react-query` via tRPC hooks (no Zustand/Redux)
- UI state: local React `useState`/`useReducer` within page components
- Theme: `client/src/contexts/ThemeContext.tsx` (dark mode default)
- Auth: `client/src/_core/hooks/useAuth.ts` reads from `trpc.auth.me` query

## Key Abstractions

**AppRouter:**
- Purpose: TypeScript type connecting server procedures to client hooks with zero codegen
- Examples: `server/routers.ts` (definition), `client/src/lib/trpc.ts` (client binding)
- Pattern: `export type AppRouter = typeof appRouter` → imported as type-only in client

**CardLearningQueue:**
- Purpose: Serialized async write queue preventing `card_learning` race conditions from concurrent writers
- Examples: `server/services/cardLearningQueue.ts`
- Pattern: Singleton queue; all callers use `getCardLearningQueue().enqueue(update)` — never write directly to DB

**DeckEvaluationBrain:**
- Purpose: Unified scoring facade; lazy-initializes meta benchmarks on first call using `META_DECKS` reference lists
- Examples: `server/services/deckEvaluationBrain.ts`
- Pattern: `evaluateDeckWithBrain(cards, archetype)` — orchestrates `gameFeatureEngine`, `metaAnalytics`, and learned weights

**modelLearningService:**
- Purpose: Static class managing `card_learning` table read/write with in-memory cache
- Examples: `server/services/modelLearning.ts`
- Pattern: `modelLearningService.getCardWeights()` — cached 60s; `updateWeights()` → invalidateCache()

**Drizzle Schema as Shared Types:**
- Purpose: `shared/types.ts` re-exports all `$inferSelect` / `$inferInsert` types from `drizzle/schema.ts`; used by both client and server
- Examples: `shared/types.ts`, `drizzle/schema.ts`
- Pattern: Import types as `import type { Card, Deck } from "@shared/types"`

## Entry Points

**HTTP Server:**
- Location: `server/_core/index.ts`
- Triggers: `npm run dev` (tsx watch) or `npm run start` (compiled JS)
- Responsibilities: Creates Express app, registers OAuth route (`/api/oauth/callback`), mounts tRPC middleware at `/api/trpc`, serves Vite dev server or static build

**Client SPA:**
- Location: `client/src/main.tsx`
- Triggers: Browser loads `client/index.html`
- Responsibilities: Initializes `QueryClient`, creates tRPC client with `httpBatchLink` to `/api/trpc`, wraps app in `trpc.Provider` + `QueryClientProvider`, auto-redirects on 401

**CLI Scripts:**
- Location: `server/scripts/*.ts`
- Triggers: npm scripts (`teach`, `calibrate:llm`, `signal:tournament`) or direct `tsx` invocations
- Responsibilities: Connect to DB, run offline ML tasks, close DB connection to allow process exit

## Error Handling

**Strategy:** tRPC error propagation with typed codes; client auto-redirects on `UNAUTHORIZED`

**Patterns:**
- Server throws `TRPCError({ code: "UNAUTHORIZED" })` from `requireUser` middleware in `server/_core/trpc.ts`
- `FORBIDDEN` thrown for admin-only procedures when `user.role !== 'admin'`
- Client `main.tsx` subscribes to `queryClient` query/mutation caches; on `UNAUTHED_ERR_MSG` → redirect to login URL
- `client/src/components/ErrorBoundary.tsx` wraps entire app for unhandled React errors
- DB connection failures in `server/db.ts` log warnings and return `null`; calling code checks for null DB before querying

## Cross-Cutting Concerns

**Logging:** `console.log`/`console.warn`/`console.error` throughout; prefixed with `[Service Name]` (e.g., `[BRAIN]`, `[Database]`); no structured logging framework
**Validation:** Zod schemas defined inline in `server/routers.ts` procedure `.input()` calls; Drizzle enforces DB-level constraints
**Authentication:** Session cookie (`app_session_id`) set after OAuth callback in `server/_core/oauth.ts`; per-request auth via `sdk.authenticateRequest()` in `server/_core/context.ts`; `protectedProcedure` enforces auth at tRPC middleware level

---

*Architecture analysis: 2026-04-12*

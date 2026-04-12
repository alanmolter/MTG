# Technology Stack

**Analysis Date:** 2026-04-12

## Languages

**Primary:**
- TypeScript 5.9.3 - All server and client code (`server/**/*.ts`, `client/src/**/*.tsx`)
- Python 3.x - ML model training only (`server/ml/config.py`, `server/ml/models/`)

**Secondary:**
- CSS (via Tailwind utility classes) - Styling in TSX components

## Runtime

**Environment:**
- Node.js 22.13.0 (pinned in CI workflows)

**Package Manager:**
- pnpm 10.4.1 (pinned via `packageManager` field in `package.json`)
- Lockfile: `pnpm-lock.yaml` (present)

## Frameworks

**Core:**
- React 19.2.1 - Frontend UI (`client/src/`)
- Express 4.21.2 - HTTP server and middleware (`server/_core/index.ts`)
- tRPC 11.6.0 - Type-safe API layer between client and server (`server/routers.ts`, `server/_core/trpc.ts`)

**Routing:**
- wouter 3.3.5 - Client-side routing (`client/src/`) with a patched version at `patches/wouter@3.7.1.patch`

**State Management:**
- TanStack Query (React Query) 5.90.2 - Server state/cache (`@tanstack/react-query`)
- tRPC React Query adapter - Query integration (`@trpc/react-query`)

**Forms:**
- react-hook-form 7.64.0 + @hookform/resolvers 5.2.2 - Form handling
- zod 4.1.12 - Runtime validation and schema definition

**UI Components:**
- Radix UI primitives (full suite - accordion, dialog, dropdown, select, etc.)
- shadcn/ui component pattern - Components in `client/src/components/ui/`
- class-variance-authority + clsx + tailwind-merge - Conditional className utilities
- lucide-react 0.453.0 - Icons
- framer-motion 12.23.22 - Animations
- recharts 2.15.2 - Charts and data visualization
- cytoscape 3.33.1 + react-cytoscapejs - Graph/deck visualization (`server/services/deckVisualization.ts`)

**Styling:**
- Tailwind CSS 4.1.14 (via `@tailwindcss/vite` plugin)
- tailwindcss-animate + tw-animate-css - Animation utilities

**Testing:**
- vitest 2.1.4 - Test runner (`vitest.config.ts`)
- Environment: `node` (tests run in Node, not browser)
- Test files located in `server/**/*.test.ts`

**Build/Dev:**
- Vite 7.1.7 - Frontend bundler and dev server (`vite.config.ts`)
- esbuild 0.25.0 - Server bundle for production build
- tsx 4.19.1 - TypeScript execution for dev server and scripts
- cross-env 10.1.0 - Cross-platform environment variables in npm scripts

**ML (Python):**
- PyTorch 2.11.0 - Neural network training (`server/ml/models/`, `.venv/Lib/site-packages/torch`)
- NumPy 2.4.3 - Numerical operations (`server/ml/`)
- Word2Vec (via `ml-kmeans` and `embeddings.ts`) - Card similarity embeddings

## Key Dependencies

**Critical:**
- `drizzle-orm` 0.44.5 - ORM for all database access (`server/db.ts`, `drizzle/schema.ts`)
- `postgres` 3.4.4 - PostgreSQL driver used by Drizzle
- `jose` 6.1.0 - JWT signing and verification for session tokens (`server/_core/sdk.ts`)
- `nanoid` 5.1.5 - ID generation
- `superjson` 1.13.3 - tRPC serialization (handles Dates, etc.)
- `dotenv` 17.2.2 - Environment variable loading (`server/_core/index.ts` imports `dotenv/config`)

**ML/Analysis (TypeScript-side):**
- `ml-kmeans` 7.0.0 - K-means clustering for deck archetype analysis (`server/services/clustering.ts`)
- `axios` 1.12.0 - HTTP client for OAuth server communication (`server/_core/sdk.ts`)

**Infrastructure:**
- `@aws-sdk/client-s3` 3.693.0 + `@aws-sdk/s3-request-presigner` 3.693.0 - Listed as dependency but actual file storage goes through the Forge proxy (`server/storage.ts`); direct S3 SDK usage not detected in server code

## Configuration

**Environment:**
- All secrets loaded via `dotenv` at server startup
- Centralized in `server/_core/env.ts` as the `ENV` object
- Required environment variables:
  - `DATABASE_URL` - PostgreSQL connection string
  - `JWT_SECRET` - Session cookie signing key
  - `VITE_APP_ID` - Manus application ID
  - `OAUTH_SERVER_URL` - Manus OAuth server endpoint
  - `OWNER_OPEN_ID` - Owner user identifier
  - `BUILT_IN_FORGE_API_URL` - Forge proxy base URL (LLM + storage)
  - `BUILT_IN_FORGE_API_KEY` - Forge proxy API key
  - `ANTHROPIC_API_KEY` - Anthropic Claude API key (direct calls in `llmDeckGenerator.ts` and `llmWeeklyCalibrator.ts`)
  - `PORT` (optional) - Server port, defaults to 3000

**Build:**
- `vite.config.ts` - Frontend build config; root at `client/`, output at `dist/public/`
- `tsconfig.json` - Includes `client/src/**/*`, `shared/**/*`, `server/**/*`; path aliases `@/` → `client/src/`, `@shared/` → `shared/`
- `drizzle.config.ts` - Drizzle Kit config; schema at `drizzle/schema.ts`, dialect postgresql
- `vitest.config.ts` - Test config; includes `server/**/*.test.ts` and `server/**/*.spec.ts`
- `.prettierrc` - Code formatter config; 2-space indent, double quotes, semicolons, LF line endings

## Platform Requirements

**Development:**
- Node.js 22.13.0
- pnpm 10.4.1
- PostgreSQL 14+ (local or remote)
- Python 3.x + PyTorch for ML training scripts only

**Production:**
- Node.js 22.x
- PostgreSQL 14+
- Access to Forge API (LLM inference + storage proxy)
- Access to Anthropic API (Claude claude-opus-4-5) for deck generation

---

*Stack analysis: 2026-04-12*

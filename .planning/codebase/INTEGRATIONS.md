# External Integrations

**Analysis Date:** 2026-04-12

## APIs & External Services

**LLM Inference (Primary - Forge Proxy):**
- Manus Forge API - OpenAI-compatible LLM gateway
  - SDK/Client: Custom fetch wrapper in `server/_core/llm.ts` (`invokeLLM`)
  - Model: `gemini-2.5-flash` (hardcoded in `server/_core/llm.ts` line 283)
  - Base URL: `BUILT_IN_FORGE_API_URL` env var, falls back to `https://forge.manus.im/v1/chat/completions`
  - Auth: `BUILT_IN_FORGE_API_KEY` env var (Bearer token)
  - Used by: Deck evaluation, embedding generation, calibration scripts

**LLM Inference (Secondary - Direct Anthropic):**
- Anthropic Claude API - Direct REST calls (no SDK)
  - Model: `claude-opus-4-5`
  - Endpoint: `https://api.anthropic.com/v1/messages`
  - Auth: `ANTHROPIC_API_KEY` env var
  - Used by: `server/services/llmDeckGenerator.ts` (LLM deck generation pipeline), `server/scripts/llmWeeklyCalibrator.ts` (weekly meta calibration)
  - Note: These files bypass the Forge proxy and call Anthropic directly

**Image Generation:**
- Manus Forge Image Service - Internal image generation
  - Endpoint: `{BUILT_IN_FORGE_API_URL}/images.v1.ImageService/GenerateImage`
  - Auth: `BUILT_IN_FORGE_API_KEY` env var (Bearer token)
  - Implementation: `server/_core/imageGeneration.ts` (`generateImage`)
  - Output: Generated images are uploaded to Forge storage proxy

**Voice Transcription:**
- Manus Forge Speech-to-Text (Whisper-compatible)
  - Implementation: `server/_core/voiceTranscription.ts`
  - Auth: Forge API key

**MTG Card Data:**
- Scryfall API - Card metadata, search, images
  - Endpoint: `https://api.scryfall.com`
  - Auth: None (public API, no key required)
  - Implementation: `server/services/scryfall.ts`, `server/services/scryfallSync.ts`
  - Used by: Seeding (`server/seed-scryfall.ts`), bulk sync (`server/sync-bulk.ts`)

**MTG Metagame Data (Web Scraping):**
- MTGGoldfish - Metagame decklists and format data
  - Endpoint: `https://www.mtggoldfish.com`
  - Auth: None (scraping with browser User-Agent)
  - Implementation: `server/services/mtggoldfishScraper.ts`
  - Formats: standard, modern, legacy, pioneer, pauper, vintage

- MTGTop8 - Tournament top 8 decklists
  - Endpoint: `https://mtgtop8.com`
  - Auth: None (scraping with browser User-Agent)
  - Implementation: `server/services/mtgtop8Scraper.ts`
  - Formats: standard (ST), modern (MO), legacy (LE), pioneer (PI), pauper (PAU), vintage (VI)

## Data Storage

**Databases:**
- PostgreSQL 14+
  - Connection env var: `DATABASE_URL`
  - Client: `postgres` (postgres.js driver) wrapped with Drizzle ORM
  - Connection module: `server/db.ts` (lazy initialization, graceful failure without DB)
  - Schema: `drizzle/schema.ts`
  - Migrations: `drizzle/` directory (`.sql` files), managed by `drizzle-kit`
  - Raw client also exposed via `getRawClient()` for queries that bypass Drizzle

**File Storage:**
- Manus Forge Storage Proxy - Object storage abstraction
  - Base URL: `BUILT_IN_FORGE_API_URL` env var
  - Auth: `BUILT_IN_FORGE_API_KEY` env var (Bearer token)
  - Implementation: `server/storage.ts` (`storagePut`, `storageGet`)
  - Used for: Generated images, uploaded audio files
  - Note: `@aws-sdk/client-s3` appears in `package.json` but is NOT used in server code; all storage goes through the Forge proxy

**ML Model Files:**
- Local filesystem - PyTorch model weights
  - Location: `server/ml/models/`
  - Files: `.json` training data (e.g., `competitive_train.json`)
  - Not committed to git (inferred from `.gitignore`)

**Pipeline Cache:**
- Local filesystem - LLM pipeline cache
  - Location: `.pipeline_cache/`

## Authentication & Identity

**Auth Provider:**
- Manus OAuth Service (`webdev.v1.WebDevAuthPublicService`)
  - Base URL: `OAUTH_SERVER_URL` env var
  - Client: Axios instance in `server/_core/sdk.ts` (`OAuthService` class)
  - Endpoints consumed:
    - `POST /webdev.v1.WebDevAuthPublicService/ExchangeToken` - Code → access token
    - `POST /webdev.v1.WebDevAuthPublicService/GetUserInfo` - Token → user info
    - `POST /webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt` - JWT → user info
  - Callback route: `GET /api/oauth/callback` (registered in `server/_core/oauth.ts`)
  - Session: HS256 JWT signed with `JWT_SECRET`, stored in HTTP-only cookie
  - Session management: `server/_core/sdk.ts` (`SDKServer` class, `sdk` singleton)
  - Supported login platforms: email, google, apple, microsoft/azure, github

## Monitoring & Observability

**Error Tracking:**
- None detected (no Sentry, Datadog, or similar SDK found)

**Logs:**
- Development: Browser logs captured to `.manus-logs/` via custom Vite plugin in `vite.config.ts`
  - Files: `browserConsole.log`, `networkRequests.log`, `sessionReplay.log`
  - Max size: 1MB per file (auto-trimmed)
- Server: `console.log` / `console.error` / `console.warn` to stdout

**Slack Notifications (CI only):**
- Slack webhook used in GitHub Actions data pipeline
  - Secret: `SLACK_WEBHOOK` (in GitHub Secrets)
  - Triggered on: pipeline success/failure in `.github/workflows/data-pipeline-schedule.yml`

## CI/CD & Deployment

**Hosting:**
- Manus platform (inferred from `vite-plugin-manus-runtime`, allowed hosts in `vite.config.ts`: `.manus.computer`, `.manuspre.computer`, `.manus-asia.computer`)

**CI Pipeline:**
- GitHub Actions
  - `.github/workflows/pipeline.yml` - CI on push/PR to `main` and `develop`; runs type check, tests, validates
  - `.github/workflows/data-pipeline-schedule.yml` - Scheduled daily (2 AM UTC) and weekly (Monday 3 AM UTC) data ingestion pipeline; runs MTG data scraping and ML training

**Node version in CI:**
- 22.13.0 (pinned via `NODE_VERSION` env in workflow files)

## Environment Configuration

**Required env vars:**
- `DATABASE_URL` - PostgreSQL connection string (e.g., `postgresql://user:pass@host:5432/db`)
- `JWT_SECRET` - Secret for signing session JWTs
- `VITE_APP_ID` - Manus application ID (also available client-side via `import.meta.env.VITE_APP_ID`)
- `OAUTH_SERVER_URL` - Manus OAuth server base URL
- `OWNER_OPEN_ID` - OpenId of the app owner user
- `BUILT_IN_FORGE_API_URL` - Forge proxy base URL (required for LLM and storage)
- `BUILT_IN_FORGE_API_KEY` - Forge proxy API key
- `ANTHROPIC_API_KEY` - Required only for `llmDeckGenerator.ts` and `llmWeeklyCalibrator.ts`

**Optional env vars:**
- `PORT` - Server port (defaults to 3000, auto-increments if busy)
- `NODE_ENV` - `development` or `production`

**Secrets location:**
- Development: `.env` file at project root (loaded via `dotenv/config`)
- CI: GitHub Secrets (`DB_PASSWORD`, `SLACK_WEBHOOK`)

## Webhooks & Callbacks

**Incoming:**
- `GET /api/oauth/callback` - Manus OAuth redirect callback (`server/_core/oauth.ts`)

**Outgoing:**
- Slack webhook (CI notifications only, via GitHub Actions)

---

*Integration audit: 2026-04-12*

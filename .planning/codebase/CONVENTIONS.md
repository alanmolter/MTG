# Coding Conventions

**Analysis Date:** 2026-04-12

## Naming Patterns

**Files:**
- Server service files: `camelCase.ts` (e.g., `deckGenerator.ts`, `archetypeGenerator.ts`, `gameFeatureEngine.ts`)
- Test files co-located with source: `camelCase.test.ts` (e.g., `deckGenerator.test.ts`)
- React page components: `PascalCase.tsx` (e.g., `Home.tsx`, `CardSearch.tsx`, `ArchetypeGenerator.tsx`)
- React UI components: `PascalCase.tsx` (e.g., `CardCard.tsx`, `ErrorBoundary.tsx`)
- Server core infrastructure: lowercase in `server/_core/` (e.g., `context.ts`, `trpc.ts`, `env.ts`)

**Functions:**
- Exported service functions: `camelCase` async functions (e.g., `getCardSynergy`, `validateDeck`, `generateDeck`)
- React components: `PascalCase` default exports (e.g., `export default function Home()`)
- Factory/helper functions in tests: `camelCase` (e.g., `makeCard`, `mockCard`, `createAuthContext`)
- tRPC procedures: named inline as object methods on the router object

**Variables:**
- `camelCase` throughout — both local variables and module-level constants
- Constants shared across codebase use `UPPER_SNAKE_CASE` (e.g., `COOKIE_NAME`, `ARCHETYPES`, `FORMAT_RULES`, `MODEL_VERSION`)

**Types/Interfaces:**
- `PascalCase` for interfaces and type aliases (e.g., `CardFeatures`, `DeckMetrics`, `TrpcContext`, `DeckGeneratorOptions`)
- Exported types use `export interface` or `export type`
- Database schema types imported directly from `../../drizzle/schema` (e.g., `Card`, `Deck`, `DeckCard`)

## Code Style

**Formatter:** Prettier

**Key settings** (from `.prettierrc`):
- `semi: true` — semicolons required
- `trailingComma: "es5"` — trailing commas where valid in ES5
- `singleQuote: false` — double quotes for strings
- `printWidth: 80` — max line width 80 characters
- `tabWidth: 2` — 2-space indentation
- `useTabs: false` — spaces, not tabs
- `arrowParens: "avoid"` — omit parens for single-arg arrow functions (e.g., `x => x * 2`)
- `endOfLine: "lf"` — LF line endings
- `jsxSingleQuote: false` — double quotes in JSX

**Linting:** No ESLint config detected. TypeScript `strict: true` provides type safety enforcement.

**TypeScript:**
- `strict: true` enabled in `tsconfig.json`
- `noEmit: true` — type checking only, Vite/esbuild handle compilation
- `allowImportingTsExtensions: true` enabled

## Import Organization

**Order (observed pattern):**
1. External packages (e.g., `import { eq } from "drizzle-orm"`)
2. Internal `@shared/*` aliases (e.g., `import { COOKIE_NAME } from "@shared/const"`)
3. Internal `@/*` aliases for client code (e.g., `import { Button } from "@/components/ui/button"`)
4. Relative imports (e.g., `import { getDb } from "../db"`)

**Path Aliases** (configured in `tsconfig.json` and `vitest.config.ts`):
- `@/*` → `./client/src/*`
- `@shared/*` → `./shared/*`
- `@assets/*` → `./attached_assets/*` (vitest only)

**Dynamic imports:** Used in `server/routers.ts` to lazily load service modules per tRPC procedure:
```typescript
const { searchCards } = await import("./services/scryfall");
```

## Error Handling

**Patterns:**
- Service functions return `null` or `[]` (empty array) on database unavailability — never throw:
  ```typescript
  const db = await getDb();
  if (!db) return null;
  ```
- Database operations wrapped in `try/catch`, log via `console.error`, return `null`:
  ```typescript
  try {
    // db operation
  } catch (error) {
    console.error("Error creating deck:", error);
    return null;
  }
  ```
- tRPC middleware throws `TRPCError` for auth failures:
  ```typescript
  throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  ```
- Scripts (not request handlers) use `console.warn` for non-fatal issues and `console.error` for fatal ones

## Logging

**Framework:** `console` (no structured logger)

**Patterns:**
- Module prefix in brackets: `console.log("[sync-bulk] ...")`, `console.warn("[Database] ...")`
- `console.warn` for degraded-mode / missing-DB situations (graceful degradation)
- `console.error` for caught exceptions in service/DB layer
- Scripts emit progress logs to stdout liberally (pipeline scripts)

## Comments

**When to Comment:**
- JSDoc-style block comments on major exported functions and interfaces, especially in service files:
  ```typescript
  /**
   * Calcula similaridade coseno entre dois vetores
   */
  export function cosineSimilarity(a: number[], b: number[]): number {
  ```
- Section dividers using Unicode box-drawing characters for grouping within long files:
  ```typescript
  // ─── Tipos ────────────────────────────────────────────────────────────────────
  // ─── Fixtures de Cartas para Testes ────────────────────────────────────────
  ```
- Inline comments in Portuguese (project language for domain logic comments)
- English used for infrastructure/core code comments

## Function Design

**Size:** Service functions tend to be medium-length (20-60 lines). Long files exist (e.g., `archetypeGenerator.ts`, `gameFeatureEngine.ts`) but functions within are focused.

**Parameters:** Object destructuring for options parameters:
```typescript
interface DeckGeneratorOptions {
  format: "standard" | "modern" | "commander" | "legacy";
  archetype?: string;
  targetSize?: number;
}
export async function generateDeck(options: DeckGeneratorOptions) { ... }
```

**Return Values:**
- `null` for single-item lookups that can fail
- `[]` (empty array) for list lookups that can fail
- Typed result objects for complex returns (e.g., `DeckValidationResult`, `EvaluationResult`)
- `as const` for literal return types in tRPC procedures:
  ```typescript
  return { success: true } as const;
  ```

## Module Design

**Exports:**
- Named exports for service functions: `export async function getCardSynergy(...)`
- Default exports for React components: `export default function Home()`
- No barrel `index.ts` files observed in service layer — imports are direct

**tRPC Router Pattern:**
- Single `appRouter` in `server/routers.ts` with nested sub-routers
- Procedures use inline Zod schema validation via `.input(z.object({...}))`
- `publicProcedure`, `protectedProcedure`, and `adminProcedure` available from `server/_core/trpc.ts`

**Database Access Pattern:**
- All DB access goes through `getDb()` lazy singleton from `server/db.ts`
- Direct raw client available via `getRawClient()` for cases where Drizzle generates invalid SQL
- Graceful no-op when `DATABASE_URL` is not set (supports running scripts without a live DB)

---

*Convention analysis: 2026-04-12*

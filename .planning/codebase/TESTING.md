# Testing Patterns

**Analysis Date:** 2026-04-12

## Test Framework

**Runner:**
- Vitest v2.1.4
- Config: `vitest.config.ts` (project root)

**Assertion Library:**
- Vitest built-in (`expect` from `vitest`)

**Run Commands:**
```bash
pnpm test              # Run all server unit tests (vitest run)
pnpm test:model        # Regression test script via tsx
```

**Vitest configuration:**
```typescript
// vitest.config.ts
export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "server/**/*.spec.ts"],
  },
});
```

## Test File Organization

**Location:** Co-located with source files in `server/` and `server/services/`

**Naming:** `{sourceFile}.test.ts` — always matches the source module name exactly:
- `server/services/deckGenerator.ts` → `server/services/deckGenerator.test.ts`
- `server/services/synergy.ts` → `server/services/synergy.test.ts`
- `server/auth.logout` logic in `server/routers.ts` → `server/auth.logout.test.ts`

**E2E tests:** `tests/navigation.spec.ts` uses Playwright (`test`, `expect` from `@playwright/test`). These are NOT picked up by Vitest (no Playwright config detected; the spec appears to be a manual/legacy file).

**Structure:**
```
server/
├── auth.logout.test.ts        # tRPC router integration test
├── db-decks.test.ts           # DB layer test
├── services/
│   ├── archetypeGenerator.test.ts
│   ├── clustering.test.ts
│   ├── deckEvaluationBrain.test.ts
│   ├── deckGenerator.test.ts
│   ├── embeddings.test.ts
│   ├── embeddingTrainer.test.ts
│   ├── gameFeatureEngine.test.ts
│   ├── mtggoldfishScraper.test.ts
│   ├── mtgtop8Scraper.test.ts
│   ├── scryfall.test.ts
│   ├── scryfallSync.test.ts
│   └── synergy.test.ts
tests/
└── navigation.spec.ts         # Playwright E2E (not run by vitest)
```

## Test Structure

**Suite Organization:**
```typescript
// Standard pattern — describe block per exported function/module
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Module Name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("functionName", () => {
    it("should describe expected behavior", async () => {
      // arrange
      // act
      // assert
    });
  });
});
```

**Nested describes:** Used to group tests by function when a test file covers multiple exports:
```typescript
// server/services/synergy.test.ts
describe("Synergy Engine", () => {
  describe("getCardSynergy", () => { ... });
  describe("getSynergyNeighbors", () => { ... });
  describe("updateSynergy", () => { ... });
  describe("calculateDeckSynergy", () => { ... });
  describe("findBestCardForDeck", () => { ... });
  describe("Integration tests", () => { ... });
});
```

**Test naming language:** Mix of English and Portuguese. Domain-specific test descriptions use Portuguese (e.g., `"deve avaliar um deck aggro corretamente"`, `"deve gerar deck de 60 cartas para standard"`). Infrastructure/generic tests use English.

**Lifecycle hooks:**
- `beforeEach(() => { vi.clearAllMocks(); })` — standard in every file that uses mocks
- `afterEach(() => { vi.restoreAllMocks(); })` — used alongside `beforeEach` in most service tests

## Mocking

**Framework:** Vitest (`vi.mock`, `vi.fn`, `vi.mocked`)

**Primary mock target:** `../db` module — mocked in nearly every service test:
```typescript
// Module-level mock — applied before imports
vi.mock("../db", () => ({
  getDb: vi.fn(),
}));
```

**DB mock pattern — inline mock object:**
```typescript
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([mockSynergy]),
};
(getDb as any).mockResolvedValue(mockDb);
```

**Simulating null DB (graceful degradation test):**
```typescript
(getDb as any).mockResolvedValue(null);
const result = await getCardSynergy(1, 2);
expect(result).toBe(0); // Should return safe default
```

**Global fetch mock (scraper tests):**
```typescript
global.fetch = vi.fn();

(global.fetch as any)
  .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockHtml) })
  .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockDeckTxt) });
```

**Multiple mocks in one file:**
```typescript
vi.mock("../db", () => ({ getDb: vi.fn() }));
vi.mock("./embeddings", () => ({ getCardEmbedding: vi.fn() }));
```

**Mocking a function from the same module under test:**
```typescript
vi.mocked(getCardSynergy).mockImplementation(getCardSynergyMock);
```

**What to Mock:**
- `getDb` from `../db` — always mock; tests should not require a live DB connection
- `global.fetch` — for any service that scrapes external URLs
- Peer service functions called by the function under test (e.g., mock `getCardSynergy` when testing `calculateDeckSynergy`)

**What NOT to Mock:**
- Pure functions that have no external dependencies (math, data transformation) — test these directly
- The module under test itself

## Fixtures and Factories

**Test Data — factory functions:**
```typescript
// archetypeGenerator.test.ts
const makeCard = (overrides: Partial<CardData> = {}): CardData => ({
  id: Math.floor(Math.random() * 10000),
  name: "Test Card",
  type: "Creature — Human",
  text: "",
  cmc: 2,
  colors: "W",
  rarity: "common",
  imageUrl: null,
  ...overrides,
});

// deckGenerator.test.ts
const mockCard = (id: number, name: string, type: string, cmc: number = 2): Card & { quantity: number } => ({
  id,
  scryfallId: `mock-${id}`,
  name,
  type,
  colors: "U",
  cmc,
  rarity: "common",
  imageUrl: null,
  power: null,
  toughness: null,
  text: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  quantity: 1,
});
```

**Test Data — named card constants:**
```typescript
// gameFeatureEngine.test.ts and archetypeGenerator.test.ts
const lightningBolt = makeCard({ name: "Lightning Bolt", type: "Instant", ... });
const counterspell = makeCard({ name: "Counterspell", type: "Instant", ... });
```

**Context factories (for tRPC tests):**
```typescript
// auth.logout.test.ts
function createAuthContext(): { ctx: TrpcContext; clearedCookies: CookieCall[] } {
  const clearedCookies: CookieCall[] = [];
  const ctx: TrpcContext = {
    user: { id: 1, email: "sample@example.com", ... },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: (name, options) => clearedCookies.push({ name, options }) } as TrpcContext["res"],
  };
  return { ctx, clearedCookies };
}
```

**Location:** Fixtures defined inline at top of test file, not in a shared fixtures directory.

## Coverage

**Requirements:** None enforced — no coverage threshold configured in `vitest.config.ts`.

**View Coverage:**
```bash
pnpm vitest run --coverage
```

## Test Types

**Unit Tests:**
- Scope: Individual exported functions from service modules
- Location: `server/services/*.test.ts`
- Pattern: Isolate via `vi.mock("../db")`, test one function per `describe` block
- Pure logic tests (no mocks): `gameFeatureEngine.test.ts`, `deckEvaluationBrain.test.ts`, `clustering.test.ts` — these test math/scoring functions directly without any DB dependency

**Integration Tests:**
- Scope: tRPC router procedures end-to-end (request → response), using real router with mocked context
- Location: `server/auth.logout.test.ts`
- Pattern: `appRouter.createCaller(ctx)` with a manually constructed context object

**E2E Tests (Playwright):**
- File: `tests/navigation.spec.ts`
- Framework: Playwright (`@playwright/test`)
- Status: No `playwright.config.ts` found — these tests are not integrated into the CI/build pipeline and appear to be unmaintained/legacy

## Common Patterns

**Async Testing:**
```typescript
it("should return synergy weight between two cards", async () => {
  const result = await getCardSynergy(1, 2);
  expect(result).toBe(85);
});
```

**Error/Edge Case Testing — null DB:**
```typescript
it("should handle database errors gracefully", async () => {
  (getDb as any).mockResolvedValue(null);
  const result = await getCardSynergy(1, 2);
  expect(result).toBe(0);
});
```

**Array length assertions:**
```typescript
expect(result.errors).toHaveLength(0);
expect(result.errors.length).toBeGreaterThan(0);
```

**Partial object matching:**
```typescript
expect(clearedCookies[0]?.options).toMatchObject({
  maxAge: -1,
  secure: true,
  sameSite: "none",
  httpOnly: true,
  path: "/",
});
```

**Type-checking assertions:**
```typescript
expect(typeof result.score).toBe("number");
```

**Generating arrays of test cards:**
```typescript
const cards = Array.from({ length: 60 }, (_, i) => ({
  ...mockCard(i, `Card ${i}`, "Creature"),
  quantity: 1,
}));
```

## Known Test Issues

Some tests in `server/services/archetypeGenerator.test.ts` are currently **failing** (5 failures recorded in `vitest_out.txt`):
- `classifyCard` — Lightning Bolt not tagged as `"removal"` (classification logic mismatch)
- `generateDeckByArchetype` — generated decks not reaching 60/100 card targets (land fill underperforms with empty pool)

These failures indicate a divergence between test expectations and current implementation behavior.

---

*Testing analysis: 2026-04-12*

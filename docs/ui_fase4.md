# UI Fase 4 — Avaliação de decks contra painel fixo

Estado atual (branch wip/local-sync-2026-10-16, af0ece20): **a tabela `deck_evaluations` NÃO existe** em `drizzle/schema.ts` nem em migrations (última: 0010_forge_match_provenance). Não há procedures tRPC relacionadas. Existe `forge_matches` com proveniência (agentDeckId, opponentDeckId, seed, policyVersion, poolVersion, bridgeVersion). `generator.evaluate`/`evaluateBrain` são heurísticos (TS), não Forge.

## 1. Schema proposto (migration 0011_deck_evaluations)
Baseado em revisao_arquitetura.md §Fase 4. Escrita exclusiva do ml_engine (DeckEvaluator); o TS só lê + enfileira.

`deck_evaluations`
| campo | tipo | nota |
|---|---|---|
| id | serial PK | |
| deck_sha256 | varchar(64) NOT NULL | hash do deck_text normalizado |
| deck_id | integer NULL → decks.id | quando o deck é de usuário |
| deck_text | text | lista avaliada (reprodutibilidade) |
| format | varchar(50) | |
| pilot | varchar(32) | `forge_ai` \| `rl_champion` |
| pilot_version | text | checkpoint/label |
| panel_version | text NOT NULL | versão do manifest do painel (ex. v2 holdout) |
| status | statusEnum | pending/running/completed/failed |
| n | integer default 0 | partidas jogadas |
| wins | integer default 0 | |
| wr | real | |
| wr_lb95 / wr_ub95 | real | Wilson IC95 |
| avg_turns | real | |
| stopped_early | boolean | SPRT/IC |
| per_opponent | jsonb | `[{opponentDeckId, name, archetype, n, wins, wr}]` |
| seed_base | bigint | |
| error_message | text | |
| created_at / completed_at | timestamptz | |

Índices: unique(deck_sha256, pilot, pilot_version, panel_version); index(deck_id).
Opcional: `forge_matches.evaluation_id` (FK) para drill‑down de partidas.
Painel: `deck_eval_panels(version PK, manifest jsonb, created_at)` ou leitura direta de `deck_pool/v2/manifest.json` via server.

## 2. Procedures tRPC (novo `evaluation: router({...})` em server/routers.ts)
- `evaluation.listPanels` (query) → `[{version, opponents:[{id,name,archetype,colors}]}]`
- `evaluation.request` (protected mutation) `{deckId | deckText, format, pilot, panelVersion, maxGames?}` → `{evaluationId, cached:boolean}` — dedup por sha256; cria linha `pending` + `training_jobs(job_type='deck_eval')`.
- `evaluation.getById` (query) `{id}` → linha completa + per_opponent.
- `evaluation.listByDeck` (query) `{deckId}` → histórico (comparar pilot/panel versions).
- `evaluation.list` (query) `{format?, panelVersion?, sort:'wr_lb95', limit, cursor}` → leaderboard.
- `evaluation.matches` (query) `{evaluationId, opponentDeckId?}` → `forge_matches` (seed, winner, turns).
- `evaluation.cancel` (protected mutation) `{id}` (opcional).
Progresso: polling de `getById` com `refetchInterval` 3s enquanto status ∈ {pending,running} (sem WebSocket no MVP).

## 3. Telas
1. **/evaluation (Leaderboard)** — filtros formato/painel/piloto; tabela: deck, WR, IC95 (barra), n, avg turns, status, data. Ordenação padrão por `wr_lb95` (não por WR bruto).
2. **/evaluation/new (Solicitar)** — selecionar deck salvo (`decks.list`) ou colar lista; escolher painel (mostra oponentes) e piloto; botão "Avaliar"; aviso se resultado em cache.
3. **/evaluation/:id (Detalhe)** — cabeçalho (WR ± IC, n, piloto/painel versions, early stop); progresso ao vivo; matriz por oponente (WR com cor, n pequeno em cinza); gráfico WR por oponente; lista de partidas (seed reproduzível).
4. **Aba no DeckBuilder/DeckVisualization** — card "Avaliação Forge" com último resultado e link.

## 4. Componentes
`EvaluationLeaderboard`, `EvaluationRequestForm`, `PanelPicker`, `PilotSelect`, `WinRateBadge` (WR + IC95, vermelho se lb95<0.5), `ConfidenceBar`, `OpponentMatrix`, `EvaluationProgress`, `MatchList`. Reusar shadcn (`components/ui/*`: Card, Table, Badge, Progress, Select) e recharts se já presente.

## 5. Fluxo de dados
UI → `evaluation.request` → server grava `deck_evaluations(pending)` + `training_jobs` → ml_engine DeckEvaluator (Ray) consome, joga K partidas espelhadas por oponente em seeds fixas, grava `forge_matches` (com evaluation_id) e atualiza n/wins/wr/lb95/per_opponent, para cedo por SPRT → UI faz polling em `getById` → completed. `card_learning` só é atualizado a partir de avaliações com n mínimo e LB95 (fora da UI).

## 6. Regras de UX
- Sempre exibir IC95 e n; nunca WR sozinho. Marcar "amostra insuficiente" se n < mínimo.
- Mostrar `pilot_version`/`panel_version`; resultados de versões diferentes não são comparáveis (agrupar).
- Mesma seed + mesmo painel ⇒ mesmo WR: botão "reproduzir" reenfileira com seed_base.

## 7. Stub
`client/src/pages/DeckEvaluation.tsx` (branch fix/frontend-lint-build) — página com dados mock e tipos `DeckEvaluation`/`OpponentResult` espelhando o schema acima; NÃO roteada em App.tsx e sem chamadas tRPC até o backend existir.

# Migrações do banco (PostgreSQL + drizzle)

## Estado atual

| Item | Onde | Observação |
|---|---|---|
| Schema TS | `drizzle/schema.ts` | fonte para `drizzle-kit generate` |
| Journal | `drizzle/meta/_journal.json` | `dialect: postgresql`, entradas `0003`–`0010` (idx 0–7) |
| Snapshot | `drizzle/meta/0010_snapshot.json` | snapshot PostgreSQL (v7) gerado a partir de `schema.ts`; base para o próximo `generate` |
| Ledger | `drizzle.__drizzle_migrations` | gravado pelo migrator do drizzle (`npm run db:migrate`) e por `drizzle-kit migrate` |
| Legado MySQL | `drizzle/legacy-mysql/` | `0000`–`0002` (SQL + snapshots MySQL). Histórico apenas; **nunca** são aplicados no Postgres |
| Ledger antigo | `public.schema_migrations` | criado pelo runner anterior. Agora só é **lido** uma vez para o baseline; pode ser removido depois |

Os números dos arquivos (`0003`…`0010`) não batem com o `idx` do journal (0…7). Por isso
`drizzle.config.ts` usa `migrations.prefix = "timestamp"`: novas migrações saem como
`20261016230312_nome.sql`, ordenam depois de `0010_*` e não colidem com nomes existentes.

## Comandos

```bash
npm run db:generate   # drizzle-kit generate: cria nova migração a partir de schema.ts
npm run db:check      # drizzle-kit check: consistência do journal/snapshots
npm run db:migrate    # baseline automático (se preciso) + migrator do drizzle
npm run db:push       # alias de db:migrate (não gera mais migração automaticamente)
npm run db:baseline -- --through <tag>   # só carimba o ledger, não migra
```

`npm run db:migrate` é idempotente: o migrator aplica só as entradas do journal cujo
`when` é maior que o último `created_at` do ledger, tudo numa transação.

## Baseline (bancos que já tinham migrações aplicadas)

O migrator do drizzle não sabe o que foi aplicado à mão. Se o ledger estiver vazio ele
tentaria reexecutar `0003_postgres_init` (`CREATE TYPE ...`) e falharia. O
`db:migrate` resolve isso antes de migrar (`server/scripts/migrationBaseline.ts`):

1. `drizzle.__drizzle_migrations` já tem linhas → nada a fazer.
2. `--through <tag>` informado → carimba todas as entradas do journal até essa tag.
3. Existe `public.schema_migrations` (runner antigo) → carimba o prefixo contíguo do
   journal que está registrado lá. Se houver buraco (ex.: 0010 registrada sem 0009),
   aborta e pede `--through`.
4. Existe `public.cards` mas nenhum ledger → **aborta** com instrução para rodar
   `db:baseline -- --through <tag>`. Não adivinhamos.
5. Banco vazio → nada a carimbar; o migrator aplica tudo.

"Carimbar" = inserir `(hash, created_at)` em `drizzle.__drizzle_migrations` com o mesmo
sha256 do arquivo e o `when` do journal, exatamente como o drizzle faria.

### Banco onde as migrações foram aplicadas manualmente (psql)

1. Descubra a última migração presente. Pistas rápidas:
   - `0010_forge_match_provenance`: `forge_matches.seed` existe?
     `SELECT 1 FROM information_schema.columns WHERE table_name='forge_matches' AND column_name='seed';`
   - `0009_competitive_deck_import`: índice/colunas de importação em `competitive_decks`.
   - `0005_endgame_pgvector`: `card_oracle_embeddings` existe (também criada por
     `ml_engine/scripts/ensure_endgame_schema.py`).
2. Faça backup (`pg_dump`).
3. `npm run db:baseline -- --through <última tag aplicada>`
4. `npm run db:migrate` aplica o que faltar.

Na dúvida, confira o arquivo SQL antes: nem todos são idempotentes (`0003` tem
`CREATE TYPE` sem guarda). Nunca rode o migrator com ledger vazio num banco populado.

Sobre `0000`–`0002`: eram DDL MySQL (backticks, `AUTO_INCREMENT`). Não há como terem sido
aplicadas num Postgres; o equivalente Postgres é `0003_postgres_init`. Não entram no baseline.

## Divergências conhecidas entre `schema.ts` e o banco real

O snapshot reflete `schema.ts` (para que `generate` só produza mudanças novas). Comparando
com um banco criado por `0003`–`0010` (PGlite + pgvector, `drizzle-kit pull`), ainda há
drift que **não** foi corrigido neste PR:

- Nomes de constraints/FKs: o SQL usa nomes padrão do Postgres (`users_openId_key`,
  `decks_user_id_fkey`); o drizzle espera `users_openId_unique`, `decks_user_id_users_id_fk`.
- Índices que existem só no `schema.ts` (não criados por nenhuma migração): `cards`
  (`name_idx`, `type_idx`, `colors_idx`, `cmc_idx`, `rarity_idx`, `oracle_idx`),
  `card_learning` (`learning_weight_*`), `rl_decisions_*`, `idx_mcts_*`,
  `idx_league_state_agent`, `idx_card_ctx_weight_*`.
- Índices que existem só no banco: HNSW (`idx_semcache_embedding_hnsw`,
  `idx_card_oracle_embed_hnsw`, `idx_card_ctx_weight_hnsw`), `forge_matches_*_idx`,
  `training_runs_recent_idx`, `competitive_decks_training_eligible_idx` etc.
- Tipos: `api_budget_ledger.input_tokens/output_tokens` e `mcts_nodes.parent_id` são
  `bigint` no banco e `integer` no schema; `card_contextual_weight.commander_id` é
  `NOT NULL` no banco; PK de `card_contextual_weight` difere.
- Enum de `training_jobs.status`: o banco usa `job_status`. Corrigido em `schema.ts`
  neste PR (era `status`), sem impacto em runtime.

Antes de rodar o primeiro `db:generate` de verdade, vale alinhar `schema.ts` a esses
pontos (ou gerar uma migração de reconciliação revisada à mão), senão a migração
gerada pode tentar criar índices duplicados ou mexer em constraints.

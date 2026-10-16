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
npm run db:check      # journal + ledger (hash/ordem/enum) e depois drizzle-kit check
npm run db:migrate    # baseline automático (se preciso) + migrator do drizzle
npm run db:push       # alias de db:migrate (não gera mais migração automaticamente)
npm run db:baseline -- --through <tag>   # só carimba o ledger, não migra
```

`npm run db:migrate` é idempotente: o migrator aplica só as entradas do journal cujo
`when` é maior que o último `created_at` do ledger, tudo numa transação.

Ordem de execução do `db:migrate` (`runMigrations` em `server/scripts/migrationBaseline.ts`):

1. confere o journal (`when` estritamente crescente);
2. `pg_advisory_lock(0x4d54474d)` (nível de sessão, conexão única `max: 1`);
3. audita o ledger (ver `db:check`) e aborta se houver inconsistência;
4. baseline verificado (abaixo);
5. migrator do drizzle;
6. `pg_advisory_unlock` (também em caso de erro).

### Concorrência

`training:prepare`, `import:competitive` e `import:competitive:arena` chamam `db:migrate`.
Com o advisory lock, execuções simultâneas entram em fila: a segunda só planeja depois
que a primeira terminou e vê o ledger pronto (`tracked`), sem carimbar em dobro. Coberto
pelo teste de integração (3 execuções paralelas).

### `db:check` (o migrator não faz isto)

O migrator do drizzle-orm 0.44 lê só o maior `created_at` do ledger: nunca compara hash,
e uma entrada com `when` menor que o último aplicado é pulada em silêncio.
`server/scripts/checkMigrations.ts` falha quando:

- o `when` do journal não é estritamente crescente;
- falta algum `.sql` do journal;
- (com `DATABASE_URL`) o sha256 de um arquivo difere do hash gravado (arquivo editado
  depois de aplicado);
- (com `DATABASE_URL`) há entrada com `when` <= último aplicado que não está no ledger;
- (com `DATABASE_URL`) há linha no ledger sem entrada no journal;
- (com `DATABASE_URL`) `training_jobs.status` não usa o tipo `job_status`.

As mesmas checagens de ledger rodam no começo do `db:migrate`.
`drizzle-kit check` (segunda parte do script) exige `DATABASE_URL` por causa do
`drizzle.config.ts`.

### Transação única e índices HNSW (0005)

O migrator aplica **todas** as migrações pendentes numa única transação. Os `CREATE
INDEX ... USING hnsw` de `0005` seguram lock exclusivo nas tabelas até o `COMMIT`.

- Banco novo: as tabelas de 0005 são criadas vazias na mesma migração, então os índices
  saem na hora.
- Banco existente: 0005 já foi aplicada e entra pelo baseline, sem reexecutar.
- Risco real: rodar 0005 pela primeira vez num banco onde `card_oracle_embeddings`,
  `semantic_cache` ou `card_contextual_weight` já foram populadas por fora (ex.:
  `ensure_endgame_schema.py` + ingestão). Nesse caso o build do HNSW pode levar minutos
  com a tabela bloqueada para escrita. Mitigação: rode `db:migrate` fora do treino, ou
  crie os índices antes com `CREATE INDEX CONCURRENTLY` (fora de transação) e só depois
  migre (`IF NOT EXISTS` vira no-op).
- Migrações novas com índice pesado em tabela grande devem ir em migração própria e, se
  preciso, ser aplicadas à mão com `CONCURRENTLY` e depois carimbadas.

### Requisitos do servidor PostgreSQL

- **pgvector >= 0.5.0** instalado no servidor (HNSW surgiu na 0.5). Confira com
  `SELECT default_version FROM pg_available_extensions WHERE name = 'vector';`.
  Imagem de referência: `pgvector/pgvector:pg16` (a mesma do CI).
- `0005` roda `CREATE EXTENSION IF NOT EXISTS vector`. O pgvector **não** é extensão
  "trusted" (`pg_available_extension_versions`: `trusted=f, superuser=t` na 0.8.0), então
  na primeira vez o usuário do `DATABASE_URL` precisa ser superusuário. Em serviço
  gerenciado (RDS, Supabase, Neon etc.) ou com usuário sem privilégio, rode antes
  `CREATE EXTENSION vector;` com o usuário admin. Depois disso o `IF NOT EXISTS` vira no-op
  e não precisa de privilégio.

### Statement breakpoints

`0003`–`0010` têm `--> statement-breakpoint` entre os comandos: o migrator executa um
comando por vez, então o erro aponta o comando exato e não depende do protocolo simple
do driver para aceitar vários comandos de uma vez. O bloco `DO $$ ... END $$;` de `0004`
fica inteiro num pedaço só. Um teste unitário garante "um comando por pedaço".
Os marcadores são comentários SQL, então rodar o arquivo inteiro no `psql` continua
funcionando. Isso mudou o sha256 dos arquivos: nenhum banco tinha ledger do drizzle antes
deste PR, então não há hash antigo a conciliar.

### CI

`.github/workflows/migrations.yml` sobe `pgvector/pgvector:pg16` e roda
`server/scripts/migrations.integration.test.ts`: banco vazio, estado af0ece20
(arquivos aplicados + `schema_migrations`), 0010 pendente, registro falso, concorrência e
arquivo editado. Localmente:
`MIGRATION_IT_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run server/scripts/migrations.integration.test.ts`.

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
   `db:baseline -- --through <tag>` e sugere a maior tag cujos objetos existem. Não
   adivinhamos.

**Nos casos 2 e 3 cada tag é verificada no catálogo antes de carimbar** (`TAG_CHECKS`).
O runner de af0ece20 gravava `0003`–`0009` em `schema_migrations` só porque `cards`
existia, então esse ledger pode mentir. Se faltar um objeto, o baseline aborta sem gravar
nada e lista o que falta. Objetos conferidos por tag:

| Tag | Conferido |
|---|---|
| 0003 | tipos `role`, `job_status`; tabelas `users`, `cards`, `decks`, `deck_cards`, `card_synergies`, `meta_stats`, `embeddings_cache`, `competitive_decks`, `competitive_deck_cards`, `training_jobs` |
| 0004 | `competitive_decks.is_synthetic`; `card_learning`, `rl_decisions`, `deck_shares`; `cards.oracle_id/is_arena/price_usd`; tipo `status`; índices únicos de `competitive_decks`/`competitive_deck_cards` |
| 0005 | extensão `vector`; `card_oracle_embeddings`, `semantic_cache`, `api_budget_ledger`, `card_contextual_weight`, `toxic_actions`, `mcts_nodes`, `league_state`; os 3 índices HNSW |
| 0006 | `card_learning.weight_{aggro,control,midrange,combo,ramp}`; índices `learning_weight_aggro_idx`, `learning_weight_ramp_idx` |
| 0007 | `competitive_deck_cards` + seus 2 índices |
| 0008 | colunas de qualidade em `competitive_decks` + índice; `training_runs` + índice; `forge_matches` |
| 0009 | default `'moxfield'` em `competitive_decks.source` + índices de `competitive_deck_cards` (0009 só reafirma objetos de 0003/0007; tudo idempotente) |
| 0010 | 6 colunas de proveniência em `forge_matches` + 2 índices |
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
- Enum de `training_jobs.status`: veja a seção abaixo.

## Enum `training_jobs.status`: `status` → `job_status` em `schema.ts`

- `0003` cria `job_status` e `training_jobs.status job_status`. `0004` cria **também** um
  tipo `status` com os mesmos valores, que nenhuma coluna usa.
- `schema.ts` declarava `pgEnum("status")`. Foi renomeado para `pgEnum("job_status")` para
  bater com a coluna real. Em runtime nada muda: o drizzle não faz cast pelo nome do tipo
  em insert/update.
- **Não há migração SQL**: o banco não muda. O tipo órfão `status` fica até alguém decidir
  removê-lo (`DROP TYPE status;` só depois de confirmar que nada o usa).
- Exceção: um banco criado no passado por `drizzle-kit push` direto do `schema.ts` teria
  `training_jobs.status` do tipo `status`. Para conferir:
  `SELECT udt_name FROM information_schema.columns WHERE table_name='training_jobs' AND column_name='status';`
  O `db:check` faz essa consulta e falha se não for `job_status`. Nesse caso, converta com
  `ALTER TABLE training_jobs ALTER COLUMN status TYPE job_status USING status::text::job_status;`
  (com default ajustado) antes de gerar novas migrações.

Antes de rodar o primeiro `db:generate` de verdade, vale alinhar `schema.ts` a esses
pontos (ou gerar uma migração de reconciliação revisada à mão), senão a migração
gerada pode tentar criar índices duplicados ou mexer em constraints.

## Rollback: 20261016234006_competitive_decks_provenance

Down script proposto pelo DBA na revisão do PR #8. Sem a função `immutable_unaccent`, que saiu desta migração. Rodar à mão, numa transação, fora do pipeline de importação. Antes, ter `pg_dump`: as colunas removidas levam junto o backfill e o arquivamento.

```sql
BEGIN;
DROP INDEX IF EXISTS competitive_deck_cards_oracle_id_idx;
ALTER TABLE competitive_deck_cards DROP COLUMN IF EXISTS oracle_id, DROP COLUMN IF EXISTS raw_name, DROP COLUMN IF EXISTS resolved;
ALTER TABLE competitive_decks DROP COLUMN IF EXISTS download_status, DROP COLUMN IF EXISTS archived_at, DROP COLUMN IF EXISTS archive_reason,
  DROP COLUMN IF EXISTS source_url, DROP COLUMN IF EXISTS collected_at, DROP COLUMN IF EXISTS content_hash,
  DROP COLUMN IF EXISTS parser_version, DROP COLUMN IF EXISTS last_fetch_error, DROP COLUMN IF EXISTS import_run_id;
DROP TYPE IF EXISTS deck_download_status;
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792194006561;
COMMIT;
```

`created_at` é o `when` da entrada no `drizzle/meta/_journal.json`.

# Rascunhos de migração (NÃO aplicar)

Estes arquivos ficam fora de `drizzle/` até o merge do PR #5 (runner/ledger do DBA).

- `20261016232131_competitive_decks_provenance.sql`: SQL revisado (proveniência, status de arquivamento, oracle_id, unaccent).
- `*.schema.ts.patch`: alteração de `drizzle/schema.ts` usada no `db:generate` (sobre a branch do PR #5).
- `20261016232131_snapshot.json`: snapshot gerado, só como referência. Gere de novo depois do merge.

Depois do merge do #5: aplicar o patch, rodar `npm run db:generate -- --name competitive_decks_provenance`, trocar o corpo pelo SQL revisado, rodar `npm run db:check` e abrir PR com o DBA. O número/timestamp final é definido pelo DBA.

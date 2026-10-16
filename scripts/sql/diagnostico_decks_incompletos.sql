-- =============================================================================
-- Diagnóstico de decks incompletos (competitive_decks / competitive_deck_cards)
-- SOMENTE LEITURA: só SELECT, sem DDL, DML ou objetos temporários. Tudo roda
-- dentro de uma transação READ ONLY: qualquer escrita é recusada pelo Postgres.
--
-- Como rodar (PC do Alan, container mtg-pgvector exposto na porta 5434):
--   psql "postgresql://<user>@localhost:5434/<db>" -v ON_ERROR_STOP=1 \
--        -f scripts/sql/diagnostico_decks_incompletos.sql > diag_decks.txt
--   (PGPASSWORD=... ou ~/.pgpass; no Windows: psql -h localhost -p 5434 -U <user> -d <db> -f ...)
-- Ou de dentro do container (lá a porta é 5432):
--   docker exec -i mtg-pgvector psql -U <user> -d <db> -v ON_ERROR_STOP=1 \
--        < scripts/sql/diagnostico_decks_incompletos.sql
--
-- "Completo" segue server/services/trainingQuality.ts:
--   main = 60 (100 em commander), side <= 15 (0 em commander), não sintético.
-- Performance: sem EXISTS correlacionado nem OR no join de nomes. O catálogo é
-- normalizado uma vez (nome inteiro + cada face + 'A/B') numa CTE MATERIALIZED
-- e ligado por igualdade (hash join). Cartas são pré-agregadas por deck_id, e o
-- teste de Cloudflare olha só os primeiros 2048 caracteres do raw_json. Como
-- cada bloco é uma instrução separada e não há objetos temporários, as CTEs
-- base (cat, linhas, agg, deck) se repetem com o mesmo texto em cada bloco.
-- Causas medidas (um deck pode ter mais de uma; o bloco 2 atribui só a primaria):
--   sem_cartas | raw_json_nulo | cloudflare_html | fonte_moxfield
--   main_diferente | side_acima_15 | nome_nao_resolvido | sintetico
-- =============================================================================
\pset pager off
\pset null '∅'
\timing on
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL work_mem = '64MB';

\echo '== 0. Totais gerais'
SELECT
  (SELECT COUNT(*) FROM competitive_decks)                     AS decks,
  (SELECT COUNT(DISTINCT deck_id) FROM competitive_deck_cards) AS decks_com_cartas,
  (SELECT COUNT(*) FROM competitive_deck_cards)                AS linhas_cartas,
  (SELECT COUNT(*) FROM cards)                                 AS cards_catalogo;

\echo '== 1. Flags de causa por fonte e formato (contagem de decks com cada flag)'
WITH cat AS MATERIALIZED (
  SELECT DISTINCT v.n
  FROM cards k
  CROSS JOIN LATERAL (VALUES
    (lower(btrim(k.name))),
    (lower(btrim(split_part(k.name, ' // ', 1)))),
    (lower(btrim(split_part(k.name, ' // ', 2)))),
    (lower(replace(btrim(k.name), ' // ', '/')))
  ) AS v(n)
  WHERE v.n <> ''
),
linhas AS MATERIALIZED (
  SELECT c.deck_id, btrim(c.card_name) AS card_name, c.quantity,
         COALESCE(c.section, 'mainboard') AS section,
         (cat.n IS NOT NULL) AS resolvido
  FROM competitive_deck_cards c
  LEFT JOIN cat ON cat.n = lower(btrim(c.card_name))
),
agg AS MATERIALIZED (
  SELECT deck_id,
         COUNT(*)                                                   AS linhas,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'mainboard'), 0) AS main_qtd,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'sideboard'), 0) AS side_qtd,
         COUNT(*) FILTER (WHERE NOT resolvido)                      AS nao_resolvidas
  FROM linhas GROUP BY deck_id
),
deck AS MATERIALIZED (
  SELECT d.id, d.source, d.source_id, lower(d.format) AS format, d.imported_at,
         d.is_training_eligible, d.training_rejection_reason,
         left(d.raw_json, 2048)                                     AS raw_head,
         (a.deck_id IS NULL)                                        AS sem_cartas,
         (d.raw_json IS NULL OR btrim(left(d.raw_json, 2048)) = '') AS raw_json_nulo,
         (left(d.raw_json, 2048) ~* '(cloudflare|cf-ray|just a moment|attention required|<!doctype html|<html)') AS cloudflare_html,
         (lower(d.source) = 'moxfield')                             AS fonte_moxfield,
         COALESCE(a.main_qtd, 0) AS main_qtd, COALESCE(a.side_qtd, 0) AS side_qtd,
         (a.deck_id IS NOT NULL AND a.main_qtd <> CASE WHEN lower(d.format) = 'commander' THEN 100 ELSE 60 END) AS main_diferente,
         (a.deck_id IS NOT NULL AND a.side_qtd > CASE WHEN lower(d.format) = 'commander' THEN 0 ELSE 15 END)    AS side_acima_15,
         (COALESCE(a.nao_resolvidas, 0) > 0)                        AS nome_nao_resolvido,
         COALESCE(d.is_synthetic, false)                            AS sintetico
  FROM competitive_decks d
  LEFT JOIN agg a ON a.deck_id = d.id
)
SELECT source, format, COUNT(*) AS decks,
  COUNT(*) FILTER (WHERE NOT (sem_cartas OR main_diferente OR side_acima_15 OR sintetico)) AS completos,
  COUNT(*) FILTER (WHERE sem_cartas)                  AS sem_cartas,
  COUNT(*) FILTER (WHERE raw_json_nulo)               AS raw_json_nulo,
  COUNT(*) FILTER (WHERE sem_cartas AND raw_json_nulo) AS sem_cartas_e_sem_raw,
  COUNT(*) FILTER (WHERE cloudflare_html)             AS cloudflare_html,
  COUNT(*) FILTER (WHERE fonte_moxfield)              AS fonte_moxfield,
  COUNT(*) FILTER (WHERE main_diferente)              AS main_diferente,
  COUNT(*) FILTER (WHERE side_acima_15)               AS side_acima_15,
  COUNT(*) FILTER (WHERE nome_nao_resolvido)          AS nome_nao_resolvido,
  COUNT(*) FILTER (WHERE sintetico)                   AS sintetico
FROM deck
GROUP BY ROLLUP (source, format)
ORDER BY source NULLS LAST, format NULLS LAST;

\echo '== 2. Causa primaria (exclusiva, soma = total de decks) por fonte'
WITH linhas AS MATERIALIZED (
  SELECT deck_id, quantity, COALESCE(section, 'mainboard') AS section FROM competitive_deck_cards
),
agg AS MATERIALIZED (
  SELECT deck_id,
         COUNT(*)                                                   AS linhas,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'mainboard'), 0) AS main_qtd,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'sideboard'), 0) AS side_qtd,
         0::bigint AS nao_resolvidas
  FROM linhas GROUP BY deck_id
),
deck AS MATERIALIZED (
  SELECT d.id, d.source, d.source_id, lower(d.format) AS format, d.imported_at,
         d.is_training_eligible, d.training_rejection_reason,
         left(d.raw_json, 2048)                                     AS raw_head,
         (a.deck_id IS NULL)                                        AS sem_cartas,
         (d.raw_json IS NULL OR btrim(left(d.raw_json, 2048)) = '') AS raw_json_nulo,
         (left(d.raw_json, 2048) ~* '(cloudflare|cf-ray|just a moment|attention required|<!doctype html|<html)') AS cloudflare_html,
         (lower(d.source) = 'moxfield')                             AS fonte_moxfield,
         COALESCE(a.main_qtd, 0) AS main_qtd, COALESCE(a.side_qtd, 0) AS side_qtd,
         (a.deck_id IS NOT NULL AND a.main_qtd <> CASE WHEN lower(d.format) = 'commander' THEN 100 ELSE 60 END) AS main_diferente,
         (a.deck_id IS NOT NULL AND a.side_qtd > CASE WHEN lower(d.format) = 'commander' THEN 0 ELSE 15 END)    AS side_acima_15,
         (COALESCE(a.nao_resolvidas, 0) > 0)                        AS nome_nao_resolvido,
         COALESCE(d.is_synthetic, false)                            AS sintetico
  FROM competitive_decks d
  LEFT JOIN agg a ON a.deck_id = d.id
),
c AS (
  SELECT source,
    CASE
      WHEN sintetico                                         THEN '1_sintetico'
      WHEN sem_cartas AND cloudflare_html                    THEN '2_sem_cartas_cloudflare'
      WHEN sem_cartas AND raw_json_nulo AND fonte_moxfield   THEN '3_sem_cartas_sem_raw_moxfield'
      WHEN sem_cartas AND raw_json_nulo                      THEN '4_sem_cartas_sem_raw'
      WHEN sem_cartas                                        THEN '5_sem_cartas_raw_presente(reimportavel)'
      WHEN main_diferente                                    THEN '6_main_diferente'
      WHEN side_acima_15                                     THEN '7_side_acima_15'
      ELSE '0_completo'
    END AS causa
  FROM deck
)
SELECT causa, source, COUNT(*) AS decks,
       round(100.0 * COUNT(*) / (SELECT COUNT(*) FROM deck), 1) AS pct_total
FROM c GROUP BY ROLLUP (causa, source)
ORDER BY causa NULLS LAST, decks DESC;

\echo '== 3. Histograma do total de mainboard (decks com cartas)'
SELECT main_qtd, COUNT(*) AS decks FROM (
  SELECT deck_id, SUM(quantity) FILTER (WHERE COALESCE(section, 'mainboard') = 'mainboard') AS main_qtd
  FROM competitive_deck_cards GROUP BY deck_id) x
GROUP BY main_qtd ORDER BY decks DESC LIMIT 25;

\echo '== 4. Main 61-75 sem side: indicio de sideboard parseado como main'
WITH linhas AS MATERIALIZED (
  SELECT deck_id, quantity, COALESCE(section, 'mainboard') AS section FROM competitive_deck_cards
),
agg AS MATERIALIZED (
  SELECT deck_id,
         COUNT(*)                                                   AS linhas,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'mainboard'), 0) AS main_qtd,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'sideboard'), 0) AS side_qtd,
         0::bigint AS nao_resolvidas
  FROM linhas GROUP BY deck_id
),
deck AS MATERIALIZED (
  SELECT d.id, d.source, d.source_id, lower(d.format) AS format, d.imported_at,
         d.is_training_eligible, d.training_rejection_reason,
         left(d.raw_json, 2048)                                     AS raw_head,
         (a.deck_id IS NULL)                                        AS sem_cartas,
         (d.raw_json IS NULL OR btrim(left(d.raw_json, 2048)) = '') AS raw_json_nulo,
         (left(d.raw_json, 2048) ~* '(cloudflare|cf-ray|just a moment|attention required|<!doctype html|<html)') AS cloudflare_html,
         (lower(d.source) = 'moxfield')                             AS fonte_moxfield,
         COALESCE(a.main_qtd, 0) AS main_qtd, COALESCE(a.side_qtd, 0) AS side_qtd,
         (a.deck_id IS NOT NULL AND a.main_qtd <> CASE WHEN lower(d.format) = 'commander' THEN 100 ELSE 60 END) AS main_diferente,
         (a.deck_id IS NOT NULL AND a.side_qtd > CASE WHEN lower(d.format) = 'commander' THEN 0 ELSE 15 END)    AS side_acima_15,
         (COALESCE(a.nao_resolvidas, 0) > 0)                        AS nome_nao_resolvido,
         COALESCE(d.is_synthetic, false)                            AS sintetico
  FROM competitive_decks d
  LEFT JOIN agg a ON a.deck_id = d.id
)
SELECT source, COUNT(*) AS decks
FROM deck
WHERE NOT sem_cartas AND format <> 'commander' AND side_qtd = 0 AND main_qtd BETWEEN 61 AND 75
GROUP BY source ORDER BY decks DESC;

\echo '== 5. Valores de section fora de mainboard/sideboard'
SELECT COALESCE(section, '∅') AS section, COUNT(*) FROM competitive_deck_cards
GROUP BY 1 ORDER BY 2 DESC;

\echo '== 6. Nomes nao resolvidos contra cards (top 50)'
WITH cat AS MATERIALIZED (
  SELECT DISTINCT v.n
  FROM cards k
  CROSS JOIN LATERAL (VALUES
    (lower(btrim(k.name))),
    (lower(btrim(split_part(k.name, ' // ', 1)))),
    (lower(btrim(split_part(k.name, ' // ', 2)))),
    (lower(replace(btrim(k.name), ' // ', '/')))
  ) AS v(n)
  WHERE v.n <> ''
),
linhas AS MATERIALIZED (
  SELECT c.deck_id, btrim(c.card_name) AS card_name, c.quantity,
         COALESCE(c.section, 'mainboard') AS section,
         (cat.n IS NOT NULL) AS resolvido
  FROM competitive_deck_cards c
  LEFT JOIN cat ON cat.n = lower(btrim(c.card_name))
)
SELECT card_name, COUNT(DISTINCT deck_id) AS decks, SUM(quantity) AS copias
FROM linhas WHERE NOT resolvido
GROUP BY card_name ORDER BY decks DESC, card_name LIMIT 50;

\echo '== 7. Padroes de raw_json nos decks sem cartas (prefixo de 60 chars)'
WITH linhas AS MATERIALIZED (
  SELECT deck_id, quantity, COALESCE(section, 'mainboard') AS section FROM competitive_deck_cards
),
agg AS MATERIALIZED (
  SELECT deck_id,
         COUNT(*)                                                   AS linhas,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'mainboard'), 0) AS main_qtd,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'sideboard'), 0) AS side_qtd,
         0::bigint AS nao_resolvidas
  FROM linhas GROUP BY deck_id
),
deck AS MATERIALIZED (
  SELECT d.id, d.source, d.source_id, lower(d.format) AS format, d.imported_at,
         d.is_training_eligible, d.training_rejection_reason,
         left(d.raw_json, 2048)                                     AS raw_head,
         (a.deck_id IS NULL)                                        AS sem_cartas,
         (d.raw_json IS NULL OR btrim(left(d.raw_json, 2048)) = '') AS raw_json_nulo,
         (left(d.raw_json, 2048) ~* '(cloudflare|cf-ray|just a moment|attention required|<!doctype html|<html)') AS cloudflare_html,
         (lower(d.source) = 'moxfield')                             AS fonte_moxfield,
         COALESCE(a.main_qtd, 0) AS main_qtd, COALESCE(a.side_qtd, 0) AS side_qtd,
         (a.deck_id IS NOT NULL AND a.main_qtd <> CASE WHEN lower(d.format) = 'commander' THEN 100 ELSE 60 END) AS main_diferente,
         (a.deck_id IS NOT NULL AND a.side_qtd > CASE WHEN lower(d.format) = 'commander' THEN 0 ELSE 15 END)    AS side_acima_15,
         (COALESCE(a.nao_resolvidas, 0) > 0)                        AS nome_nao_resolvido,
         COALESCE(d.is_synthetic, false)                            AS sintetico
  FROM competitive_decks d
  LEFT JOIN agg a ON a.deck_id = d.id
)
SELECT source, left(regexp_replace(COALESCE(left(raw_head, 200), '∅'), '\s+', ' ', 'g'), 60) AS prefixo,
       COUNT(*) AS decks
FROM deck WHERE sem_cartas
GROUP BY 1, 2 ORDER BY decks DESC LIMIT 30;

\echo '== 8. Prefixo de source_id x sem cartas (goldfish-/top8- tem refetch)'
WITH linhas AS MATERIALIZED (
  SELECT deck_id, quantity, COALESCE(section, 'mainboard') AS section FROM competitive_deck_cards
),
agg AS MATERIALIZED (
  SELECT deck_id,
         COUNT(*)                                                   AS linhas,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'mainboard'), 0) AS main_qtd,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'sideboard'), 0) AS side_qtd,
         0::bigint AS nao_resolvidas
  FROM linhas GROUP BY deck_id
),
deck AS MATERIALIZED (
  SELECT d.id, d.source, d.source_id, lower(d.format) AS format, d.imported_at,
         d.is_training_eligible, d.training_rejection_reason,
         left(d.raw_json, 2048)                                     AS raw_head,
         (a.deck_id IS NULL)                                        AS sem_cartas,
         (d.raw_json IS NULL OR btrim(left(d.raw_json, 2048)) = '') AS raw_json_nulo,
         (left(d.raw_json, 2048) ~* '(cloudflare|cf-ray|just a moment|attention required|<!doctype html|<html)') AS cloudflare_html,
         (lower(d.source) = 'moxfield')                             AS fonte_moxfield,
         COALESCE(a.main_qtd, 0) AS main_qtd, COALESCE(a.side_qtd, 0) AS side_qtd,
         (a.deck_id IS NOT NULL AND a.main_qtd <> CASE WHEN lower(d.format) = 'commander' THEN 100 ELSE 60 END) AS main_diferente,
         (a.deck_id IS NOT NULL AND a.side_qtd > CASE WHEN lower(d.format) = 'commander' THEN 0 ELSE 15 END)    AS side_acima_15,
         (COALESCE(a.nao_resolvidas, 0) > 0)                        AS nome_nao_resolvido,
         COALESCE(d.is_synthetic, false)                            AS sintetico
  FROM competitive_decks d
  LEFT JOIN agg a ON a.deck_id = d.id
)
SELECT source, split_part(source_id, '-', 1) AS prefixo_id, COUNT(*) AS decks,
       COUNT(*) FILTER (WHERE sem_cartas) AS sem_cartas
FROM deck GROUP BY 1, 2 ORDER BY decks DESC LIMIT 30;

\echo '== 9. Elegibilidade e motivos gravados pelo sanitizador'
SELECT is_training_eligible,
       COALESCE(split_part(training_rejection_reason, ';', 1), '∅') AS primeiro_motivo,
       COUNT(*) AS decks
FROM competitive_decks GROUP BY 1, 2 ORDER BY decks DESC LIMIT 30;

\echo '== 10. Importacao por mes x fonte'
WITH linhas AS MATERIALIZED (
  SELECT deck_id, quantity, COALESCE(section, 'mainboard') AS section FROM competitive_deck_cards
),
agg AS MATERIALIZED (
  SELECT deck_id,
         COUNT(*)                                                   AS linhas,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'mainboard'), 0) AS main_qtd,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'sideboard'), 0) AS side_qtd,
         0::bigint AS nao_resolvidas
  FROM linhas GROUP BY deck_id
),
deck AS MATERIALIZED (
  SELECT d.id, d.source, d.source_id, lower(d.format) AS format, d.imported_at,
         d.is_training_eligible, d.training_rejection_reason,
         left(d.raw_json, 2048)                                     AS raw_head,
         (a.deck_id IS NULL)                                        AS sem_cartas,
         (d.raw_json IS NULL OR btrim(left(d.raw_json, 2048)) = '') AS raw_json_nulo,
         (left(d.raw_json, 2048) ~* '(cloudflare|cf-ray|just a moment|attention required|<!doctype html|<html)') AS cloudflare_html,
         (lower(d.source) = 'moxfield')                             AS fonte_moxfield,
         COALESCE(a.main_qtd, 0) AS main_qtd, COALESCE(a.side_qtd, 0) AS side_qtd,
         (a.deck_id IS NOT NULL AND a.main_qtd <> CASE WHEN lower(d.format) = 'commander' THEN 100 ELSE 60 END) AS main_diferente,
         (a.deck_id IS NOT NULL AND a.side_qtd > CASE WHEN lower(d.format) = 'commander' THEN 0 ELSE 15 END)    AS side_acima_15,
         (COALESCE(a.nao_resolvidas, 0) > 0)                        AS nome_nao_resolvido,
         COALESCE(d.is_synthetic, false)                            AS sintetico
  FROM competitive_decks d
  LEFT JOIN agg a ON a.deck_id = d.id
)
SELECT date_trunc('month', imported_at)::date AS mes, source, COUNT(*) AS decks,
       COUNT(*) FILTER (WHERE sem_cartas) AS sem_cartas
FROM deck GROUP BY 1, 2 ORDER BY 1, 2;

ROLLBACK;

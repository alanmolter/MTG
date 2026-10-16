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
-- Causas medidas (um deck pode ter mais de uma; o bloco 2 atribui só a primaria):
--   sem_cartas | raw_json_nulo | cloudflare_html | fonte_moxfield
--   main_diferente | side_acima_15 | nome_nao_resolvido | sintetico
-- =============================================================================
\pset pager off
\pset null '∅'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';

\echo '== 0. Totais gerais'
SELECT
  (SELECT COUNT(*) FROM competitive_decks)                              AS decks,
  (SELECT COUNT(DISTINCT deck_id) FROM competitive_deck_cards)          AS decks_com_cartas,
  (SELECT COUNT(*) FROM competitive_deck_cards)                         AS linhas_cartas,
  (SELECT COUNT(*) FROM cards)                                          AS cards_catalogo;

\echo '== 1. Flags de causa por fonte e formato (contagem de decks com cada flag)'
WITH agg AS (
  SELECT deck_id,
         COUNT(*)                                                       AS linhas,
         COALESCE(SUM(quantity) FILTER (WHERE COALESCE(section,'mainboard') = 'mainboard'), 0) AS main_qtd,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'sideboard'), 0) AS side_qtd
  FROM competitive_deck_cards GROUP BY deck_id
),
unres AS (
  SELECT DISTINCT cdc.deck_id
  FROM competitive_deck_cards cdc
  WHERE NOT EXISTS (
    SELECT 1 FROM cards k
    WHERE lower(k.name) = lower(btrim(cdc.card_name))
       OR lower(split_part(k.name, ' // ', 1)) = lower(btrim(cdc.card_name))
       OR lower(replace(k.name, ' // ', '/')) = lower(btrim(cdc.card_name))
  )
),
f AS (
  SELECT d.id, d.source, lower(d.format) AS format,
    (a.deck_id IS NULL)                                                  AS sem_cartas,
    (d.raw_json IS NULL OR btrim(d.raw_json) = '')                       AS raw_json_nulo,
    (d.raw_json ~* '(cloudflare|cf-ray|just a moment|attention required|<!doctype html|<html)') AS cloudflare_html,
    (lower(d.source) = 'moxfield')                                       AS fonte_moxfield,
    (a.deck_id IS NOT NULL AND a.main_qtd <> CASE WHEN lower(d.format)='commander' THEN 100 ELSE 60 END) AS main_diferente,
    (a.deck_id IS NOT NULL AND a.side_qtd > CASE WHEN lower(d.format)='commander' THEN 0 ELSE 15 END)   AS side_acima_15,
    (u.deck_id IS NOT NULL)                                              AS nome_nao_resolvido,
    COALESCE(d.is_synthetic, false)                                      AS sintetico
  FROM competitive_decks d
  LEFT JOIN agg a   ON a.deck_id = d.id
  LEFT JOIN unres u ON u.deck_id = d.id
)
SELECT source, format, COUNT(*) AS decks,
  COUNT(*) FILTER (WHERE NOT (sem_cartas OR main_diferente OR side_acima_15 OR sintetico)) AS completos,
  COUNT(*) FILTER (WHERE sem_cartas)         AS sem_cartas,
  COUNT(*) FILTER (WHERE raw_json_nulo)      AS raw_json_nulo,
  COUNT(*) FILTER (WHERE sem_cartas AND raw_json_nulo) AS sem_cartas_e_sem_raw,
  COUNT(*) FILTER (WHERE cloudflare_html)    AS cloudflare_html,
  COUNT(*) FILTER (WHERE fonte_moxfield)     AS fonte_moxfield,
  COUNT(*) FILTER (WHERE main_diferente)     AS main_diferente,
  COUNT(*) FILTER (WHERE side_acima_15)      AS side_acima_15,
  COUNT(*) FILTER (WHERE nome_nao_resolvido) AS nome_nao_resolvido,
  COUNT(*) FILTER (WHERE sintetico)          AS sintetico
FROM f
GROUP BY ROLLUP (source, format)
ORDER BY source NULLS LAST, format NULLS LAST;

\echo '== 2. Causa primaria (exclusiva, soma = total de decks) por fonte'
WITH agg AS (
  SELECT deck_id,
         COALESCE(SUM(quantity) FILTER (WHERE COALESCE(section,'mainboard') = 'mainboard'), 0) AS main_qtd,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'sideboard'), 0) AS side_qtd
  FROM competitive_deck_cards GROUP BY deck_id
),
c AS (
  SELECT d.source,
    CASE
      WHEN COALESCE(d.is_synthetic,false)                                   THEN '1_sintetico'
      WHEN a.deck_id IS NULL AND d.raw_json ~* '(cloudflare|cf-ray|just a moment|<!doctype html|<html)' THEN '2_sem_cartas_cloudflare'
      WHEN a.deck_id IS NULL AND (d.raw_json IS NULL OR btrim(d.raw_json)='') AND lower(d.source)='moxfield' THEN '3_sem_cartas_sem_raw_moxfield'
      WHEN a.deck_id IS NULL AND (d.raw_json IS NULL OR btrim(d.raw_json)='') THEN '4_sem_cartas_sem_raw'
      WHEN a.deck_id IS NULL                                                THEN '5_sem_cartas_raw_presente(reimportavel)'
      WHEN a.main_qtd <> CASE WHEN lower(d.format)='commander' THEN 100 ELSE 60 END THEN '6_main_diferente'
      WHEN a.side_qtd > CASE WHEN lower(d.format)='commander' THEN 0 ELSE 15 END   THEN '7_side_acima_15'
      ELSE '0_completo'
    END AS causa
  FROM competitive_decks d LEFT JOIN agg a ON a.deck_id = d.id
)
SELECT causa, source, COUNT(*) AS decks,
       round(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct_total
FROM c GROUP BY ROLLUP (causa, source)
ORDER BY causa NULLS LAST, decks DESC;

\echo '== 3. Histograma do total de mainboard (decks com cartas)'
SELECT main_qtd, COUNT(*) AS decks FROM (
  SELECT deck_id, SUM(quantity) FILTER (WHERE COALESCE(section,'mainboard')='mainboard') AS main_qtd
  FROM competitive_deck_cards GROUP BY deck_id) x
GROUP BY main_qtd ORDER BY decks DESC LIMIT 25;

\echo '== 4. Main+side somando 60/75: indicio de sideboard parseado como main'
SELECT d.source, COUNT(*) AS decks
FROM competitive_decks d
JOIN (SELECT deck_id,
             SUM(quantity) FILTER (WHERE COALESCE(section,'mainboard')='mainboard') AS m,
             COALESCE(SUM(quantity) FILTER (WHERE section='sideboard'),0) AS s
      FROM competitive_deck_cards GROUP BY deck_id) a ON a.deck_id = d.id
WHERE lower(d.format) <> 'commander' AND a.s = 0 AND a.m BETWEEN 61 AND 75
GROUP BY d.source ORDER BY decks DESC;

\echo '== 5. Valores de section fora de mainboard/sideboard'
SELECT COALESCE(section,'∅') AS section, COUNT(*) FROM competitive_deck_cards
GROUP BY 1 ORDER BY 2 DESC;

\echo '== 6. Nomes nao resolvidos contra cards (top 50)'
SELECT btrim(cdc.card_name) AS card_name, COUNT(DISTINCT cdc.deck_id) AS decks, SUM(cdc.quantity) AS copias
FROM competitive_deck_cards cdc
WHERE NOT EXISTS (
  SELECT 1 FROM cards k
  WHERE lower(k.name) = lower(btrim(cdc.card_name))
     OR lower(split_part(k.name, ' // ', 1)) = lower(btrim(cdc.card_name))
     OR lower(replace(k.name, ' // ', '/')) = lower(btrim(cdc.card_name))
)
GROUP BY 1 ORDER BY decks DESC LIMIT 50;

\echo '== 7. Padroes de raw_json nos decks sem cartas (prefixo de 60 chars)'
SELECT d.source, left(regexp_replace(COALESCE(d.raw_json,'∅'), '\s+', ' ', 'g'), 60) AS prefixo,
       COUNT(*) AS decks
FROM competitive_decks d
WHERE NOT EXISTS (SELECT 1 FROM competitive_deck_cards c WHERE c.deck_id = d.id)
GROUP BY 1, 2 ORDER BY decks DESC LIMIT 30;

\echo '== 8. Padroes de source_id (prefixo) x reimportavel (goldfish-/top8- tem refetch)'
SELECT d.source, split_part(d.source_id, '-', 1) AS prefixo_id, COUNT(*) AS decks,
       COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM competitive_deck_cards c WHERE c.deck_id = d.id)) AS sem_cartas
FROM competitive_decks d GROUP BY 1, 2 ORDER BY decks DESC LIMIT 30;

\echo '== 9. Elegibilidade e motivos gravados pelo sanitizador'
SELECT is_training_eligible,
       COALESCE(split_part(training_rejection_reason, ';', 1), '∅') AS primeiro_motivo,
       COUNT(*) AS decks
FROM competitive_decks GROUP BY 1, 2 ORDER BY decks DESC LIMIT 30;

\echo '== 10. Importacao por mes x fonte'
SELECT date_trunc('month', imported_at)::date AS mes, source, COUNT(*) AS decks,
       COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM competitive_deck_cards c WHERE c.deck_id = d.id)) AS sem_cartas
FROM competitive_decks d GROUP BY 1, 2 ORDER BY 1, 2;

ROLLBACK;

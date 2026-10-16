# F0: fechamento e proposta de F1 (dados de decks)

Fonte: saída real de `scripts/sql/diagnostico_decks_incompletos.sql` no `mtg-pgvector` (PC do Alan, user `postgres`, db `mtg`), em `/workspace/mtg/diag_decks_saida.txt`. Todos os blocos rodaram em menos de 100 ms (o 1 em 84 ms).

## 1. Fechamento da F0

### 1.1 Conferência do resumo do Tech Lead
| Afirmação | Saída | Situação |
|---|---|---|
| 1001 incompletos, todos sem cartas e sem raw_json | Bloco 1 (total): `sem_cartas` 1001 = `sem_cartas_e_sem_raw` 1001 | ✅ |
| 668 do MTGTop8 Modern, do import de março | Bloco 1: mtgtop8/modern `sem_cartas` 668; bloco 10: 2026-03 mtgtop8 `sem_cartas` 668 | ✅ |
| source_id `e=&d=`, dá para refazer o fetch | Bloco 8: ids `e=NNN&d=NNN` **sem o prefixo `top8-`**. Os 453 com prefixo `top8-` têm todos cartas | ✅ com ressalva (§2.1: o `reimportEmptyDecks` atual **não** reconhece esse formato) |
| 213 do Goldfish | Bloco 2: mtggoldfish 213 (140 `goldfish-<id>` + 73 com id só numérico, ex.: `7680983`) | ✅ |
| 120 placeholders 'fallback' do Moxfield | Bloco 8: moxfield/`fallback` 120 (30 cada: commander, legacy, modern, standard) | ✅. Obs.: `is_synthetic` = false em todos (bloco 1, `sintetico` 0) |
| Nenhum Cloudflare nem sideboard lido como main | Bloco 1: `cloudflare_html` 0; bloco 4: 0 linhas; `side_acima_15` 0 | ✅ |
| 23 decks com main de 61 ou 80 cartas | Bloco 3: **61 → 14, 80 → 8, 81 → 1**. Bloco 1: legacy 17, pauper 3, modern 1, standard 1, vintage 1 (todos mtgtop8, nenhum commander) | ⚠️ inclui um deck de 81 |
| 3 nomes não resolvidos (acento e encoding) | Bloco 6: Lorien Revealed (25 decks/58 cópias), Troll of Khazad-dum (2/6), `J´┐¢tun Grunt` (1/1) = 28 decks | ✅ |

### 1.2 Quantificação das causas (causa principal exclusiva, bloco 2)
| Causa | Fonte | Decks | % de 1.454 | Recuperável? |
|---|---|---|---|---|
| Completo (60 no main, side ≤ 15) | mtgtop8 | **430** | 29,6 | — |
| Sem cartas e sem raw_json, id `e=&d=` (import de 03/2026) | mtgtop8 (modern) | 668 | 45,9 | **Sim**, refetch no MTGTop8 |
| Sem cartas e sem raw_json | mtggoldfish | 213 | 14,6 | Não (fonte descartada, anti-scraper) |
| Placeholder `fallback` sem cartas | moxfield | 120 | 8,3 | Não (nunca foi um deck real) |
| Main ≠ 60 (61/80/81) | mtgtop8 | 23 | 1,6 | Investigar (§2.3) |
| **Total** | | **1.454** | 100 | |

Outros achados:
- **"453 completos" na verdade são 453 decks com cartas.** Pelo critério de treino (60 no main) são **430**.
- **O sanitizador está desatualizado.** Bloco 9: só 204 elegíveis (`is_training_eligible`), e 1.236 rejeitados por `mainboard_size_0`, mais do que os 1.001 vazios de hoje. Ele não rodou de novo depois da reimportação. Os motivos `61/80` somam 13, contra 23 reais.
- **Falso positivo:** `copy_limit_Snow-Covered Forest_14`. `isBasicLand` (`server/services/trainingQuality.ts:89`) não conhece os básicos snow.
- **raw_json ausente também em decks com cartas:** 218 decks (1.219 − 1.001) não têm raw_json. A proveniência do conteúdo depende só de `competitive_deck_cards`.
- **Nomes não resolvidos:** afetam 28 decks, quase todos vintage (19) e pauper (6).
- **Pool v2 não usa nenhum dos 1.001.** Os 62 decks MTGTop8 do pool têm `tournament_source_id` `top8-…`, todos com cartas. Os outros 166 vêm do MTGJSON.

## 2. Proposta de F1

### 2.1 Refetch dos 668 do MTGTop8 (prioridade 1)
- **Bloqueio atual:** `refetchUrls` (`server/services/reimportEmptyDecks.ts:42-54`) só aceita `^top8-(e=\d+&d=\d+)$`. Os 668 têm `source_id` `e=…&d=…` sem prefixo e cairiam em `skipped`. Ajuste mínimo: aceitar `^(?:top8-)?(e=\d+&d=\d+)$` quando `source = 'mtgtop8'`. Os 73 Goldfish com id numérico também não casam, o que não importa porque não serão refeitos.
- **Reutilizar o `reimportEmptyDecks`:** ele já seleciona só decks sem cartas (`EMPTY_DECK_SQL`), então é idempotente e não toca decks completos. Passar a ele o `fetchWithTimeout` endurecido do `mtgtop8Scraper` (robots.txt, rate limit, cache): exportar um `politeFetchText` do scraper e usá-lo como `deps.fetchText` em `server/scripts/reimportEmptyDecks.ts`.
- **Novos parâmetros do script:**
  - `--source mtgtop8`: filtra antes de buscar, para não tentar Goldfish/Moxfield.
  - `--batch 50` e `--max N`: lotes com commit por deck; o `saveCompetitiveDeck` já é transacional.
  - `--dry-run`: só lista ids, URLs e o que seria gravado, sem escrita.
  - **Retomada:** reexecutar retoma sozinho, porque decks já preenchidos saem do `EMPTY_DECK_SQL`.
- **Validação no import:** só gravar se o parse der main ≥ 60. Gravar `raw_json` com o texto bruto baixado (hoje fica nulo nesses casos).
- **Estimativa:** 1 requisição por deck (`/mtgo?e=&d=`) a 2 s cada dá ~22 min para 668, mais o robots.txt. Em lotes de 50, ~1 min 40 s por lote. Com o cache, uma reexecução é quase instantânea.
- **Execução:** no PC do Alan, contra o banco real, nunca no CI, seguindo a política do MTGTop8 do PR #6. Rodar primeiro `--dry-run --max 20`, depois um lote de 50, conferir com o SQL de diagnóstico e só então o restante.
- **Resultado esperado:** com ~90% de sucesso (eventos antigos podem ter sumido), o banco teria ~1.030 decks com cartas.

### 2.2 Os 333 do Goldfish e Moxfield: arquivar, não apagar
- **Não dar `DELETE`.** O único vínculo é a FK `competitive_deck_cards.deck_id` (`drizzle/schema.ts:200`), e esses decks não têm linhas de cartas. Nenhum aparece no manifest do pool v2. `forge_matches.agent_deck_id/opponent_deck_id` são texto e apontam para ids do pool, não para estes.
- **Marcar com status:** coluna `download_status` (ou `archived_at` + `archive_reason`), com `'source_dropped'` nos 213 do Goldfish e `'placeholder'` nos 120 `fallback`. Também ligar `is_synthetic = true` nos 120, que é o que o schema já documenta para fallback.
- **Excluir das métricas:** o gate do banco real e os consumidores devem filtrar `archived_at IS NULL`. O denominador do % de completos passa a ser 1.121.
- **Antes de arquivar:** rodar um SELECT de checagem (pool v2, `forge_matches` por `source_id`/nome, `card_synergies` derivadas) e anexar o resultado ao PR.

### 2.3 Os 23 decks com 61/80/81 cartas
- Nenhum é commander: são 17 legacy, 3 pauper e um de cada em modern, standard e vintage. Main 80 com side 0 não aparece no bloco 4 (que olha 61-75), mas 80 = 60 + 20 sugere duas listas ou o side somado ao main com cartas repetidas. Main 61 costuma ser escolha real do jogador ou carta duplicada.
- Investigação, por deck: soma do side, cartas repetidas entre main e side, e comparação com a lista ao vivo em `/mtgo?e=&d=`.
- Decisão por regra:
  - **61 cartas, igual à fonte:** manter como dado real. Avaliar aceitar 60-61 no treino, ou registrar `main_size_nonstandard` sem rejeitar.
  - **80/81 cartas:** se a fonte mostrar 60+15, refazer o fetch. Se o problema estiver no parser, corrigir o parser.

### 2.4 Normalização de nomes
| Opção | Prós | Contras |
|---|---|---|
| `unaccent(lower(name))` | Simples, resolve "Lórien" e "Khazad-dûm" | Exige a extensão `unaccent` (DDL do DBA). Não resolve mojibake (`J´┐¢tun`) nem renomeações, e pode colidir entre nomes distintos |
| **`oracle_id` do Scryfall** | Identidade canônica da carta (todas as impressões e faces). Estável, já existe em `cards.oracle_id` | Exige uma etapa de resolução (bulk data `oracle-cards`) e uma coluna nova nas linhas de deck |

**Recomendação:** `oracle_id` como chave canônica. `unaccent` e a correção de mojibake ficam só na etapa de resolução, como funções de matching e nunca como dado gravado:
1. Normalizar a entrada: NFKD, remover acentos, `´┐¢`/U+FFFD como coringa, conferir `ftfy` ou o mapeamento cp1252/cp850 para o mojibake.
2. Casar exato contra nome, faces e `A/B`, depois contra a versão sem acento, e por último a busca fuzzy do Scryfall (`/cards/named?fuzzy=`), com cache.
3. Gravar `oracle_id` e `raw_name` (o nome original). O `card_name` exibido vem do catálogo.
4. Os 3 nomes de hoje (Lorien Revealed, Troll of Khazad-dum, Jötun Grunt) viram casos de teste.

### 2.5 Mudanças de schema (alinhar com o DBA)
- `competitive_decks`:
  - `download_status text` (`ok | empty | source_dropped | placeholder | failed`)
  - `archived_at timestamptz`, `archive_reason text`
  - `source_url text`, `collected_at timestamptz`, `content_hash char(64)`, `parser_version text`, `last_fetch_error text`
  - normalizar `source_id` com prefixo de fonte (backfill `top8-` nos 668), ou criar `source_native_id`
- `competitive_deck_cards`: `oracle_id varchar(64)`, `raw_name text`, `resolved boolean`. Índice em `oracle_id`.
- Extensão `unaccent` (opcional, só para a resolução).
- Índice funcional opcional `lower(name)` em `cards`, para o diagnóstico e a resolução. O SQL atual já roda bem sem ele.
- Tabela `deck_import_runs`, com `import_run_id` em `competitive_decks`, para o gate por run.

### 2.6 Testes e critério de aceite
- **Testes unitários:**
  - `refetchUrls` aceita `e=&d=` com e sem `top8-`
  - o dry-run não grava
  - reimportar duas vezes dá o mesmo resultado (idempotência)
  - o fetch respeita robots.txt e rate limit
  - o parser trata 60+15 e o caso de 80
  - a resolução de nomes cobre os 3 casos reais
  - `isBasicLand` aceita os básicos snow
- **Integração:** Postgres local com dados sintéticos (como na validação do SQL) e respostas do MTGTop8 gravadas em fixture.
- **Critério de aceite da F1**, medido com o SQL de diagnóstico:
  - **≥ 90% de decks completos entre os não arquivados**, ou seja, ≥ 1.009 de 1.121. Hoje são 430/1.121 (38%) ou 430/1.454 (29,6%).
  - 0 nomes não resolvidos (bloco 6 vazio) e 100% das linhas com `oracle_id`.
  - Os 333 arquivados com motivo e 0 deletados.
  - Sanitizador rodado de novo: `is_training_eligible` coerente com o bloco 1.
- **Gate do CI:** continua medindo só o run, como no PR #6. O SQL de diagnóstico vira o gate do banco real.

### 2.7 Riscos
- **MTGTop8:** decks antigos podem ter saído do ar (404) ou o HTML pode ter mudado. Mitigação: dry-run, `last_fetch_error` e aceite com margem (90%).
- **Legal e ToS:** sem licença de bulk; as listas são fatos de torneio. Rate limit, robots.txt, User-Agent identificável e execução pontual, sem rodar em PR.
- **Pegada de acesso:** os 668 vêm de eventos antigos (e=2365…), num volume único maior que o diário. Espalhar em lotes ao longo do dia.
- **Viés:** o banco ficaria ~66% Modern e MTGTop8. Considerar no split e nos pesos do pool v3.
- **Normalização errada por fuzzy:** só aceitar fuzzy com nota de corte, registrar e revisar manualmente.
- **Mudança de schema:** coordenar com o DBA, usar migrations com colunas nullable e backfill separado, e manter o ledger do Drizzle alinhado.

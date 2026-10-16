# Dono de escrita por tabela (proposta)

Regra: **um escritor por tabela**. O TS (web/Drizzle) é dono de catálogo, decks e
aprendizado. O `ml_engine` (Python) é dono de partidas Forge, embeddings e treino. Os dois
lados conversam pela fila `training_jobs`. O outro lado só lê.

## Levantamento do código (grep em 2026-10-16, base `af0ece20`)

| Tabela | Escritas hoje | Leituras hoje | Por que está vazia |
|---|---|---|---|
| `forge_matches` | **Python** `ml_engine/ray_cluster/match_record.py` (`maybe_record_forge_match`, chamado por `env.py::_publish_match` a cada episódio). **TS** `server/scripts/playOneArenaMatch.ts::recordForgeMatch` (partida Forge GUI, `bridge_version='forge-gui'`) | `trainingQuality.ts`, `sanitizeTrainingData.ts`, `fullBrainTraining.ts`, `promoteRayCandidate.ts` | O escritor Python só grava se `DATABASE_URL` estiver no ambiente dos workers Ray e `FORGE_MATCH_RECORD!=0`; erros viram `logger.exception` e são engolidos. Nenhum treino Ray com DB configurado nem partida GUI rodou contra este banco |
| `league_state` | **Ninguém**. `orchestrator.py` só cita na docstring ("mirror do JSON"). `LeagueManager` existe mas nunca é instanciado; o pool vive em `league_state.json` | Ninguém (só `ensure_endgame_schema.py` verifica a existência) | Sem escritor |
| `mcts_nodes` | **Ninguém**. Não existe implementação de MCTS; `contextualWeights.ts` só menciona "MCTS deckbuilder (Pillar 5)" em comentários | Ninguém | Feature não implementada |
| `training_jobs` | TS `embeddingTrainer.ts` (insere `running`, atualiza `completed/failed`) | TS `embeddingTrainer.ts` (último job) | Não é usada como fila: é log do job local de embeddings |

## Proposta

| Tabela | Escritor | Leitores | Observação |
|---|---|---|---|
| `forge_matches` | **ml_engine** (`match_record.py`) | TS (gates de qualidade, promoção, `fullBrainTraining`) | Evidência imutável (append-only). A escrita do TS em `playOneArenaMatch.ts` passa a ser exceção temporária; alvo: o script TS enfileira um job `eval_match` e o Python grava |
| `league_state` | **ml_engine** (orchestrator/`LeagueManager`) | TS (dashboard/promoção, somente leitura) | Espelho do `league_state.json`: upsert por `(agent_id, generation)` quando um snapshot entra no pool; `is_champion` marcado na promoção |
| `mcts_nodes` | **TS** (futuro deckbuilder MCTS, junto de `contextualWeights.ts`) | TS | É estado de busca de deckbuilding (domínio "decks"), não treino. Enquanto não houver MCTS, a tabela fica vazia de propósito. Alternativa: removê-la até existir código |
| `training_jobs` | **TS insere** (enfileira). **ml_engine** reivindica e atualiza `status/completed_at/error_message` dos jobs que consome | ambos | Fila. Jobs locais do TS (`job_type='embeddings'`) continuam sendo escritos pelo próprio TS |

### Fluxo via `training_jobs`

```
TS (API/script)                          ml_engine (worker)
INSERT training_jobs                      loop:
  (job_type='ray_train'|'eval_match',      SELECT ... WHERE status='pending'
   status='pending', payload)                AND job_type IN (...)
                                             ORDER BY id
                                             FOR UPDATE SKIP LOCKED LIMIT 1
                                           UPDATE status='running'
                                           executa: Forge/Ray
                                             -> INSERT forge_matches (match_record.py)
                                             -> UPSERT league_state (LeagueManager)
                                           UPDATE status='completed'|'failed',
                                             completed_at, error_message
TS lê training_jobs / forge_matches / league_state para UI e gates
```

### Mudanças mínimas (próximos PRs, não feitas aqui)

1. Migração: `training_jobs` ganha `payload jsonb NOT NULL DEFAULT '{}'`,
   `claimed_by text`, `claimed_at timestamptz` e índice parcial
   `(job_type, id) WHERE status='pending'`. `started_at` deveria aceitar NULL (hoje é
   `defaultNow()` na inserção, o que mede enfileiramento e não início).
2. Python: `ml_engine/jobs/worker.py` com o claim acima e despacho por `job_type`.
3. Python: `LeagueManager` instanciado no orchestrator (callback do Tune) + função
   `persist_league_state(conn, entry)` no mesmo estilo de `match_record.py` (opcional
   quando `DATABASE_URL` não existe).
4. TS: `playOneArenaMatch.ts` passa a enfileirar `eval_match` em vez de inserir em
   `forge_matches` (ou fica documentado como exceção, com `bridge_version='forge-gui'` e
   `policyControlled=false` no `raw_json`, como já é hoje).
5. TS: helper `enqueueTrainingJob(jobType, payload)` em `server/services/`.

### Por que nada foi ligado neste PR

- `forge_matches` já tem escritor Python correto; o vazio é operacional (env dos workers),
  não falta de código.
- `league_state` exige instanciar `LeagueManager` dentro do loop do Tune: mexe no
  treino PBT, não é baixo risco.
- `mcts_nodes` não tem produtor possível sem implementar o MCTS.
- A fila precisa de migração de schema antes do worker.

## Riscos / perguntas em aberto

- Dois escritores em `forge_matches` hoje (Python e `playOneArenaMatch.ts`). Manter a
  exceção GUI ou migrar para a fila?
- `mcts_nodes`: manter para o deckbuilder TS futuro ou dropar?
- Workers Ray recebem `DATABASE_URL`? Se não, `forge_matches` continuará vazia mesmo com
  treino rodando. Falhas de gravação deveriam virar métrica, não só log.
- Permissões: hoje um único usuário de banco. Para garantir "um escritor", criar roles
  `app_ts` e `ml_engine` com `GRANT INSERT/UPDATE` só nas tabelas de cada um.

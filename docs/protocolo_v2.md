# Protocolo ForgeRLBridge v2 — contrato

**Status:** proposta. Nada disto está implementado no Java em `af0ece20`, exceto os itens marcados ✅.

**Schemas:** `/workspace/mtg/schemas/bridge_v2/*.schema.json` (JSON Schema draft 2020-12).
- Exemplos: `schemas/bridge_v2/examples/`.
- Validador: `schemas/bridge_v2/validate.py`. Usa `jsonschema` 4.26 e roda 6 exemplos positivos e 7 negativos, todos com PASS.

**Base de compatibilidade:** `ml_engine/ray_cluster/env.py@af0ece20`.

## 1. Transporte
- Um processo JVM por env. O canal é JSON-lines UTF-8, um objeto por linha: stdin do cliente para o bridge, stdout do bridge para o cliente.
- O stdout é exclusivo do protocolo; os logs do Forge vão para o stderr (✅ `ForgeRLBridge.java`, redirecionamento de `System.out`).
- O cliente descarta linhas que não sejam JSON, comportamento que o `env.py` já tem.
- O modelo é estritamente requisição→resposta: **uma resposta por comando**. O bridge nunca emite mensagens espontâneas, nem eventos de turno. Essa regra elimina a fila `snapshotQueue` como fonte de respostas.

## 2. Campos de correlação
| Campo | Quem gera | Regra |
|---|---|---|
| `request_id` | cliente, monotônico a partir de 1 (✅ `env.py:775-776`, `bc/record.py`) | O bridge ecoa o valor em toda resposta (✅ `writeResponse`). O cliente descarta respostas com id diferente do pendente (✅ `response_matches`, `env.py:88-100`). **No v2, uma resposta sem `request_id` é erro**: o modo leniente de compatibilidade com v1 é removido. |
| `decision_id` | bridge, monotônico por partida a partir de 0 | Todo `state` não terminal traz o id da decisão pendente. O `step` precisa enviar o mesmo id; caso contrário, o bridge responde `error` com `STALE_DECISION` e o jogo não avança. |
| `seed` | cliente (✅ `env.py:465`) | O bridge aplica `MyRandom.setRandom(new Random(seed))` antes de `createGame` (✅ `ForgeRLBridge.java:320-328`) e ecoa a seed no `state`. |

## 3. Mensagens

### 3.1 `hello` (handshake) — novo
- **Requisição** (`hello.request.schema.json`): `{"cmd":"hello","request_id":1,"protocol":2,"required_capabilities":[...]}`.
- **Resposta** (`hello.response.schema.json`): contém `protocol: 2`, `bridge_version`, `forge_commit` (o submódulo `forge` está fixado em `7cc4ff7b`), `capabilities ⊂ {policy_control, seed, legal_mask, decision_points, paging, exact_ai_labels, autoregressive}` e `limits.num_actions = 512`.
- **Regras:**
  - O cliente envia `hello` logo após o spawn, antes de qualquer `new_game`.
  - Se o protocolo for diferente de 2, ou se faltar alguma capability requerida (no treino: `policy_control`, `seed`, `legal_mask`, `decision_points`), o cliente mata a JVM e lança erro de configuração. Isso não conta como episódio.
  - Um bridge v1 responde `unknown cmd: hello`. Esse resultado deve ser tratado como `PROTOCOL_MISMATCH`.

### 3.2 `reset` (`cmd: "new_game"`, mantido por compatibilidade)
- Schema: `reset.request.schema.json`.
- Campos já enviados hoje: `agent_deck`, `opponent_deck`, `seed`, `agent_policy` e `step_timeout_seconds` (✅ `env.py:464-467`).
- Campos novos: `agent_side` (padrão 0), `opponent` (`forge_ai`), `decision_timeout_ms` e `turn_limit`.
- A resposta é um `state` com `decision_id = 0` (a primeira decisão do agente, normalmente o mulligan) e `policy_action_applied = null`.

### 3.3 `step`
- Schema: `step.request.schema.json`. Formato: `{"cmd":"step","request_id":N,"decision_id":D,"action":k}` com `k ∈ [0, 511]`.
- **Semântica:**
  - `action_mask[k] == 1`: o bridge aplica a ação no `ExternalPlayerController`, avança o jogo até a **próxima decisão do agente** ou o fim da partida, e responde `state` com `policy_action_applied: true`.
  - `action_mask[k] == 0`: o jogo **não** avança. A resposta é `state` com a mesma `decision_id`, `policy_action_applied: false` e `illegal_action: true`. O `env.py:547-548` já converte isso em ilegal.
  - `step_autoregressive` continua existindo só como capability opcional, `autoregressive`. O `env.py` recusa o modo AR (`env.py:148-152` da versão anterior).

### 3.4 `state`
Schema: `state.schema.json`. A lista abaixo destaca só os campos obrigatórios; os campos extras do v1 continuam permitidos (`additionalProperties: true`) para não quebrar `_encode_observation`.

| Campo | Tipo | Observação |
|---|---|---|
| `type` | `"state"` | |
| `request_id`, `protocol`, `bridge_version` | | |
| `decision_id`, `decision_kind` | int; `priority`, `mulligan`, `declare_attackers`, `declare_blockers`, `choose_targets`, `choose_cards` ou `none` | `none` quando `terminal` |
| `policy_controlled` | bool | `true` ⇔ o lado `agent_side` usa o `ExternalPlayerController`. O `env.py:475` e o `env.py:531` exigem `true`. |
| `policy_action_applied` | bool ou null | `null` só na resposta ao `new_game` |
| `ai_fallback_decisions` | int | decisões do lado do agente que caíram na IA, acumuladas na partida |
| `terminal`, `truncated`, `truncation_reason`, `outcome` | | `truncated ⇒ truncation_reason` obrigatório. `outcome ∈ {1, -1, 0, null}` |
| `illegal_action` | bool | |
| `action_mask` | 512 × {0,1} | **Legal de verdade:** o bit vale 1 só se a ação puder ser aplicada agora. Num estado vivo, há pelo menos um 1. |
| `action_source_indices`, `action_target_indices`, `action_kinds` | 512 × int (-1 = vazio) | já consumidos pelo `env.py` |
| `actions[]` | `{slot, kind, sa_id, source_index, target_index, label}` | descritor por slot legal |
| `chosen_action` | int | só no modo baseline (`agent_policy=forge_ai`): **rótulo exato** escolhido pela IA |

**Layout do espaço de ações (inalterado):**
- 0 = passar ou "não fazer nada" na decisão;
- 1..509 = opções da página;
- 510/511 = página anterior/seguinte (capability `paging`).

Ataque e bloqueio viram sub-decisões, uma por criatura (`kind` 3/4: slot 1 = sim, 0 = não), para caber em `Discrete(512)`.

### 3.5 `error`
Schema: `error.schema.json`. Formato: `{"type":"error","request_id":N|null,"code":...,"message":...,"fatal":bool}`.

| Código | Fatal | Ação do cliente |
|---|---|---|
| `BAD_REQUEST` (JSON inválido ou campo faltando) | não | bug do cliente; abortar o episódio |
| `UNKNOWN_CMD` | não | |
| `PROTOCOL_MISMATCH` | sim | erro de configuração; não treinar |
| `NO_GAME` | não | chamar reset |
| `DECK_PARSE_ERROR` | não | marcar o deck como inválido e sortear outro |
| `STALE_DECISION` | não | ressincronizar com o `state` atual (bug do cliente; contar e alertar) |
| `ILLEGAL_ACTION` | — | **não usar** em `step` (usar `state` com `policy_action_applied: false`). Fica reservado para o modo AR. |
| `DECISION_TIMEOUT` | não | truncamento de infraestrutura (`_infra_stop`) |
| `ENGINE_ERROR` (exceção na thread de jogo) | sim | matar a JVM; truncamento de infraestrutura |
| `INTERNAL` | sim | idem |

Hoje (v1) os erros saem como `{"error":"...","terminal":true,"outcome":0,"illegal_action":true}`, sem código. O v2 substitui esse formato.

## 4. Timeouts (hierarquia obrigatória)
| Nível | Valor padrão | Onde | Efeito |
|---|---|---|---|
| Decisão da IA oponente / avanço até a próxima decisão do agente | `step_timeout_seconds = 8` | Java (✅ `DEFAULT_STEP_TIMEOUT_SECONDS = 8`, sobrescrito por `new_game`) | `state` com `truncated: true` e `truncation_reason: "step_timeout"` (✅ campo emitido). O env faz `_infra_stop` (✅ `env.py:525-526`). |
| Leitura de resposta | `step_timeout = 12 s` (60 s no `new_game`) | Python (✅ `env.py:68`, `java_step_timeout_seconds()` garante Java < Python) | `_infra_stop("forge_step_timeout")` e kill da JVM |
| Watchdog da partida | `turn_limit = 50` / N decisões | Python (✅ `turn_limit`) e Java (novo) | `truncation_reason: "turn_limit"` |
| Espera do controlador externo por um `step` | ilimitada enquanto a JVM vive | Java | o jogo fica parado no ponto de decisão; não há timeout de "agente lento" |

**Regra v2:** depois de um `truncated: step_timeout`, o bridge **descarta a partida** (`killExistingGame`). Assim, nenhum estado atrasado sobrevive para o próximo comando. Isso fecha a lacuna descrita na §6.

## 5. Determinismo
Com seed, decks e sequência de ações iguais, o v2 exige:
- `decision_id`, `action_mask` e um hash canônico do estado idênticos em cada decisão, em pelo menos 95 % das partidas, já na fase 1;
- 100 % na fase 2.

Fontes de não determinismo conhecidas, já documentadas no código (`ForgeRLBridge.java:308-319`): `new Random()`/`SecureRandom` dentro da IA, timeouts de relógio e escalonamento de threads. O v2 remove a dependência de eventos assíncronos (ponto de decisão síncrono); o resto deve ser medido.

## 6. Lacunas do v1 que motivam o v2 (estado `af0ece20`)
1. `policy_controlled` está fixo em `false` (`ForgeRLBridge.java:772`), e os dois lados são `LobbyPlayerAi` (l. 345-346).
2. O `request_id` é anexado na **escrita** (`writeResponse`), mas o snapshot vem de uma fila preenchida por eventos de turno. Um snapshot antigo enfileirado ainda sai com o id do comando atual. Isso evita dessincronia de *linhas*, mas não de *conteúdo*. O mesmo vale depois de um timeout Java: o snapshot tardio fica na fila e é consumido pelo próximo `step`.
3. A máscara é permissiva (qualquer carta própria na mão ou desvirada).
4. O `chosen_action` é inferido pela diferença de mão.
5. Não há handshake: o `ping` retorna `bridge_version` mas não protocolo nem capabilities, e o env não chama `ping`.

## 7. Critérios de aceite mensuráveis — Fase 1 (controle de um lado)
Executar em `scripts/e2e-preflight.ps1`, estágio novo `policy_control`, mais um job manual na máquina com Forge.

| # | Critério | Meta |
|---|---|---|
| A1 | Handshake: `hello` retorna `protocol=2` e as capabilities `policy_control, seed, legal_mask, decision_points` | 100 % |
| A2 | 200 episódios com política legal-random (`agent_policy=external`) sem `forge_policy_control_lost` | 0 ocorrências |
| A3 | Todas as mensagens validam contra `schemas/bridge_v2` (validação em modo estrito ligada no env por flag) | 0 violações |
| A4 | `policy_action_applied=true` nos steps com ação marcada na máscara | ≥ 99,5 % |
| A5 | Ação fora da máscara: o jogo não avança (mesmo `decision_id` e hash de estado) | 100 % (teste com 1.000 ações ilegais injetadas) |
| A6 | Legalidade: nenhuma ação mascarada como legal é rejeitada pelo Forge | ≤ 0,5 % |
| A7 | `ai_fallback_decisions / decisões do agente` | < 5 % (com relatório por `decision_kind`) |
| A8 | `stale_replies_discarded` e `STALE_DECISION` | 0 em 200 episódios |
| A9 | `truncation_reason=step_timeout` | < 1 % dos episódios; nenhum estado tardio depois de um timeout (teste com IA travada artificialmente) |
| A10 | Política sensível: always-pass perde ≥ 90 % contra a IA do Forge; legal-random tem win rate diferente de always-pass (IC95 disjunto) | prova de que as ações têm efeito |
| A11 | Determinismo com seed (20 pares de partidas, mesma sequência de ações) | ≥ 95 % das partidas com hash idêntico em todas as decisões |
| A12 | Throughput | ≥ 5 decisões/s por JVM (medido) [meta a calibrar] |
| A13 | CI: `pytest ml_engine`, `npm test` e o teste Java do bridge (`rlbridge_src/test.cmd`) verdes | verde |

## 8. Checklist de revisão de PR — Fase 1
**Protocolo e contrato**
- [ ] `hello` implementado; `PROTOCOL_VERSION=2` como constante única em Java e Python.
- [ ] Toda resposta tem `type` e `request_id`, e o modo leniente sem id foi removido do `response_matches` (ou fica atrás de uma flag `v1_compat`).
- [ ] Os schemas em `schemas/bridge_v2` foram versionados no repositório, e os testes Python validam payloads reais (fixtures gravadas do bridge).
- [ ] Os códigos de `error` seguem a §3.5, e a string livre `{"error": ...}` foi eliminada.

**Controle**
- [ ] O lado `agent_side` usa o `ExternalPlayerController`, e o oponente segue `LobbyPlayerAi`. `policy_controlled` é calculado, não um literal.
- [ ] Os pontos de decisão cobertos (priority, mulligan, attackers, blockers, targets) estão listados; o resto delega à IA e incrementa `ai_fallback_decisions`.
- [ ] A troca entre threads é síncrona (`SynchronousQueue` ou equivalente), sem `snapshotQueue` alimentada por eventos de turno para respostas de `step`.
- [ ] Ação ilegal não chama a API do Forge e não avança `decision_id`.

**Máscara e ações**
- [ ] A máscara deriva de `canPlay()` e da capacidade de pagar o custo (ou da API equivalente no Forge `7cc4ff7b`). Há teste com uma mão sem mana ⇒ só passar é legal.
- [ ] Paginação 510/511 testada com mais de 509 opções (fixture sintética).
- [ ] `actions[]` é coerente com `action_mask`, `action_kinds` e `action_source_indices`.

**Determinismo e timeouts**
- [ ] A seed é aplicada antes de `createGame`, e há teste de replay com hash por decisão.
- [ ] O timeout Java é menor que o Python (o `java_step_timeout_seconds` está mantido), e um timeout descarta a partida no Java.
- [ ] Teste de IA travada: o estado tardio não vaza para o próximo comando.

**Dados e treino**
- [ ] O BC usa `chosen_action` exato (`exact_ai_labels`); os shards antigos são marcados como v1 e excluídos do treino.
- [ ] `forge_matches` ganha `policy_controlled` e `protocol_version` (migração `0011`) e é gravado por `match_record.py`.
- [ ] `trainingQuality.evaluatePromotionGates` considera só partidas com `policy_controlled=true`.

**Operacional**
- [ ] Novo estágio `policy_control` no `e2e-preflight.ps1`, com os critérios A1-A11 impressos como PASS/FAIL.
- [ ] O README do `rlbridge_src` foi atualizado e o `BRIDGE_VERSION` incrementado.
- [ ] Sem regressão no modo baseline `agent_policy=forge_ai`.


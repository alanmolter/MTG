# MTG Deck AI — Arquitetura e Ciclo de Vida

Documentação técnica completa do projeto: tecnologias, componentes, fluxo de
dados, ciclo de treinamento e como o modelo evolui a cada rodada.

> **Status atual:** stack 8-pilares funcional, treinamento RL acelerado em GPU
> (RTX 2070 SUPER, CUDA 12.6), pipeline ponta-a-ponta validado em `npm run teach`,
> `npm run train:ray` e `npm run stack:up`.

---

## 1. Visão Geral em 1 minuto

O projeto é um **sistema de IA que aprende a jogar Magic: The Gathering** e que,
a partir desse conhecimento, **gera decks competitivos e os avalia** para
jogadores humanos. Tem três "cérebros" que trabalham em paralelo:

| Cérebro | Onde roda | Para que serve |
|---|---|---|
| **Simbólico** (heurísticas + bandits) | Node/TypeScript | gera decks respeitando regras, curva de mana, sinergia, meta |
| **Evolutivo** (self-play + algoritmo genético) | Node/TypeScript | evolui pesos de cartas via partidas simuladas |
| **Neural** (GNN + RL + IMPALA + PBT) | Python (Ray, PyTorch) | aprende a **jogar** o jogo dentro do Forge e destila isso em pesos |

A cola entre eles é um banco Postgres com `pgvector`, onde todos os cérebros
escrevem/leem pesos, embeddings, sinergias e "ações tóxicas" (loops
detectados).

---

## 2. Arquitetura em 8 Pilares

O design segue a separação de responsabilidades documentada em `SEED.md`
("8 pilares do endgame"):

| # | Pilar | Tecnologia | Local |
|---|---|---|---|
| 1 | **RLlib + IMPALA** (RL distribuído) | Ray 2.53, PyTorch 2.11+cu126 | `ml_engine/ray_cluster/orchestrator.py` |
| 2 | **GNN heterogêneo** (estado do jogo) | PyTorch Geometric 2.7 (HeteroConv + GATConv) | `ml_engine/models/game_state_gnn.py` |
| 3 | **Embeddings semânticas** das cartas | Sentence-Transformers (MiniLM 384-d) | `ml_engine/rag/embedder.py` |
| 4 | **RAG + pgvector** para contexto | Postgres + pgvector + FastAPI :8765 | `ml_engine/rag/server.py`, `drizzle/schema.ts` |
| 5 | **Gymnasium ↔ Forge** bridge | Java Forge + subprocess JSON-line | `ml_engine/ray_cluster/env.py`, `forge/rlbridge/` |
| 6 | **Reward shaping denso** | Potential-based shaping (Ng et al. 1999) | `ml_engine/forge_worker/reward_shaper.py` |
| 7 | **Loop-guard + PBT league** | Hash de estado + population-based training | `ml_engine/forge_worker/loop_guard.py`, `orchestrator.py` |
| 8 | **Financial defense** (cache + circuit breaker) | Node services + semantic cache | `server/services/ragCache.ts`, `circuitBreaker.ts` |

Cada pilar foi pensado para **isolar um risco**:
- Pilar 1 → risco de **colapso de gradiente** em ambientes lentos (Forge é lento → IMPALA + V-trace toleram trajetórias stale)
- Pilar 2 → risco de **representação fraca** (vetor simples de cartas perde relação de controle/zona)
- Pilar 3+4 → risco de **re-embedar** as mesmas 50k cartas a cada query (→ cache vetorial em disco)
- Pilar 5 → risco de **fonte de verdade fictícia** (heurísticas Node não validam combos exóticos → Forge valida)
- Pilar 6 → risco de **reward esparso** matar o aprendizado (resolver com shaping bounded)
- Pilar 7 → risco de **catástrofe + amnésia** (population-based + frozen opponents)
- Pilar 8 → risco de **explosão de custo** em APIs externas (cache + budget ledger + circuit breaker)

---

## 3. Stack Tecnológico — O Que É e Por Quê

### 3.1 Camada Frontend (cliente)

| Tech | Versão | Para que serve |
|---|---|---|
| **React 19** | 19.2 | Interface reativa (páginas de Deck Builder, Gerador, Meta Dashboard) |
| **Tailwind 4** | 4.1 | Estilo utilitário — zero CSS manual |
| **Radix UI** | ^1.x | Componentes acessíveis (dialogs, dropdowns, tooltips) |
| **Wouter** | 3.3 | Router leve (alternativa ao react-router) |
| **React Query / TanStack** | 5.90 | Cache de requisições (deck generation, search) |
| **Cytoscape** | 3.33 | Visualização de **grafo de sinergia** entre cartas |
| **Framer Motion** | 12.23 | Animações das transições de deck |

### 3.2 Camada Backend (Node/TypeScript)

| Tech | Para que serve |
|---|---|
| **Express 4** | Servidor HTTP base |
| **tRPC 11** | RPC type-safe entre cliente↔servidor (elimina contratos OpenAPI) |
| **Drizzle ORM** | ORM type-safe para Postgres. Schema em `drizzle/schema.ts` |
| **postgres.js / pg** | Driver Postgres (com suporte a `vector(N)` custom type via Drizzle) |
| **tsx** | Executa TypeScript direto em dev (sem build) |
| **dotenv** | Lê `.env` local |

### 3.3 Camada ML (Python)

| Tech | Versão | Para que serve |
|---|---|---|
| **PyTorch** | 2.11.0+cu126 | Backbone do GNN + learner IMPALA. **Compilado com CUDA 12.6** (GPU ativa na RTX 2070S) |
| **torch-geometric (PyG)** | 2.7.0 | Camadas de GNN (`HeteroConv`, `GATConv`, `global_mean_pool`) |
| **Ray + RLlib + Tune** | 2.53.0 | Orquestração distribuída de trials, IMPALA algorithm, PBT scheduler |
| **Gymnasium** | 1.1.1 | API padrão de ambientes RL (substitui OpenAI Gym) |
| **Sentence-Transformers** | ≥2.7 | Embedding MiniLM-L6-v2 (384-d) para texto oracle das cartas |
| **FastAPI + Uvicorn** | ≥0.110 | Ponte HTTP Node ↔ Python (porta 8765) |
| **psycopg2** + **pgvector** | 2.9+ | Escritor em massa dos embeddings no Postgres |
| **pydantic 2** | ≥2.5 | Validação dos payloads da API Python |

### 3.4 Motor de Jogo (Java)

| Tech | Para que serve |
|---|---|
| **MTG Forge** | Motor **oficial** não-Wizards de regras do MTG. Valida combos exóticos, replacement effects, layers, priority — coisas que heurística simples não pega |
| **rlbridge (módulo próprio)** | Em `forge/rlbridge/` — traduz ações de RL (int) para chamadas da API do Forge e serializa o estado do jogo em JSON para o Python |

### 3.5 Banco de Dados

**Postgres 15+ com extensão `pgvector`.** 21 tabelas principais (ver §5).

---

## 4. Estrutura de Pastas

```
mtg-deck-mvp/
├── client/                    # React SPA (Vite)
├── server/                    # Node backend
│   ├── _core/                 # Express bootstrap, tRPC, auth
│   ├── services/              # ← Lógica de negócio (40+ arquivos)
│   │   ├── deckEvaluationBrain.ts    # Cérebro heurístico
│   │   ├── deckGenerator.ts          # Gera decks
│   │   ├── cardLearningQueue.ts      # Fila FIFO de updates de pesos (sem race)
│   │   ├── modelLearning.ts          # Self-play + genético
│   │   ├── clustering.ts             # KMeans de arquétipos
│   │   ├── embeddings.ts             # Word2Vec local (64-d)
│   │   ├── ragCache.ts               # Cache vetorial (pilar 8)
│   │   ├── circuitBreaker.ts         # Disjuntor de APIs externas (pilar 8)
│   │   ├── metaAnalytics.ts          # Análise de metadecks
│   │   ├── mtggoldfishScraper.ts     # Scraper de torneios
│   │   └── ...                       # (gameFeatureEngine, synergy, etc.)
│   ├── scripts/               # ← Entrypoints CLI (npm scripts)
│   │   ├── fullBrainTraining.ts      # `npm run teach`
│   │   ├── trainCommander.ts         # Treino Commander diversidade
│   │   ├── continuousTraining.ts     # Self-play genético
│   │   ├── llmWeeklyCalibrator.ts    # `npm run calibrate:llm`
│   │   ├── checkDbHealth.ts          # `npm run db:health`
│   │   └── ...
│   └── ml/                    # Configs de modelos (config.py)
├── ml_engine/                 # ← Python (pilares 1-7)
│   ├── rag/
│   │   ├── embedder.py        # Sentence-Transformers wrapper
│   │   ├── server.py          # FastAPI :8765 (/embed, /health)
│   │   └── pgvector_writer.py # Backfill dos embeddings
│   ├── models/
│   │   └── game_state_gnn.py  # GNN + RLlib wrapper
│   ├── forge_worker/
│   │   ├── reward_shaper.py   # Shaping denso
│   │   ├── loop_guard.py      # Detector de loops infinitos
│   │   └── tests/             # pytest
│   └── ray_cluster/
│       ├── env.py             # MtgForgeEnv (Gymnasium)
│       ├── orchestrator.py    # ← IMPALA + PBT + GPU
│       └── smoke_env.py       # Smoke tests (curto e longo)
├── forge/                     # MTG Forge (submódulo Java)
│   └── rlbridge/              # ← Módulo próprio: ponte RL → Forge
├── drizzle/
│   ├── schema.ts              # ← Schema Postgres (21 tabelas)
│   └── migrations/            # SQL migrations (0000-0006)
├── scripts/
│   └── run-python.mjs         # ← Shim cross-plat para npm → venv Python
├── run-stack.ps1              # Launcher do stack (ml_engine + node + Forge)
├── run-all.ps1                # Pipeline completo de treinamento
└── package.json               # 60+ npm scripts
```

---

## 5. Camada de Dados (Postgres)

21 tabelas em `drizzle/schema.ts`. As **chave** para o aprendizado:

| Tabela | Propósito | Escritores |
|---|---|---|
| `cards` | Catálogo de ~60k cartas (seed via Scryfall API) | `npm run seed:scryfall` |
| `decks` + `deck_cards` | Decks gerados/importados | Frontend, scrapers |
| `competitive_decks` | Metadecks de torneio (MTGGoldfish, MTGTop8) | scrapers |
| `card_learning` | **Peso aprendido** de cada carta em `[0.1, 50.0]`. Colunas: `weight` (global) + `weight_aggro`/`weight_control`/`weight_midrange`/`weight_combo`/`weight_ramp` (Phase 2) | **todos os cérebros** via `CardLearningQueue` |
| `card_synergies` | Sinergia pareada (card_a × card_b → score) | self-play, LLM calibrator |
| `card_oracle_embeddings` | Vetor 384-d do texto oracle (pgvector) | `ml_engine/rag/pgvector_writer.py` |
| `rl_decisions` | Log de cada decisão do agente RL (s, a, r, s') | `MtgForgeEnv` |
| `toxic_actions` | Ações que causaram loop infinito (com context_hash) | `LoopGuard` |
| `league_state` | Pool de oponentes congelados (PBT) | `orchestrator.py` |
| `mcts_nodes` | Cache MCTS (não usado no pipeline atual; reservado) | — |
| `semantic_cache` | Cache vetorial de queries (pilar 8) | `ragCache.ts` |
| `api_budget_ledger` | Controle de custo da API Anthropic | circuit breaker |
| `card_contextual_weight` | Peso de carta **condicional a arquétipo** (e.g., Goblin vale 15 em aggro, 2 em control) | `contextualWeights.ts` |

### Por que `CardLearningQueue`

Três escritores concorrentes (frontend, self-play, RL) escrevendo no mesmo peso
de carta = race condition clássica. Solução implementada em
`server/services/cardLearningQueue.ts`:
- **Fila FIFO com worker único** (serializa updates)
- **Weight capping** via SQL `LEAST(GREATEST(weight + delta, 0.1), 50.0)`
- **Decay proporcional**: `effectiveDelta = delta * (1 - weight/MAX)^2` — impede saturação no teto

---

## 6. Backend Node — O Cérebro Simbólico e Evolutivo

### 6.1 Deck Evaluation Brain

`server/services/deckEvaluationBrain.ts` — avalia um deck sem precisar simular.
Calcula `normalizedScore` e atribui tier S/A/B/C/D/F com base em:

- `manaCurveScore` — distribuição do CMC adequada ao arquétipo?
- `landRatioScore` — proporção de lands (normalmente 24/60 em Standard, 38/100 em Commander)
- `mechanicSynergyScore` — cartas com mecânicas que se reforçam
- `simulateTurns` — simulação Monte Carlo de abertura/mulligan
- `impactScore` dinâmico — CMC + raridade + funções (board wipe, finisher, etc.)

### 6.2 Self-Play + Algoritmo Genético

Implementado em `continuousTraining.ts` e `modelLearning.ts`:

```
1. Population: 5 arquétipos × 20 decks = 100 decks iniciais
2. Evaluate: cada deck rodado N vezes pelo ModelEvaluator
3. Select: top 25% por winrate médio
4. Evolve:
   a) Crossover: junta cartas de 2 pais elite (swap aleatório)
   b) Mutation: troca X% das cartas por outras do pool
   c) Inject randomness: a cada 20 iterações, reintroduz Y% aleatório
5. Write-back: CardLearningQueue aplica deltas proporcionais ao winrate
6. Repeat
```

### 6.3 Commander Intelligence

`trainCommander.ts` — variante para EDH (100 cartas, singleton, color identity).
Usa a flag `--forbidden-color` rotacionada pelo `run-all.ps1` (W→U→B→R→G) para
**forçar diversidade**: o modelo não pode viciar em Jeskai porque sempre terá
uma cor banida.

### 6.4 LLM Weekly Calibrator

`server/scripts/llmWeeklyCalibrator.ts` — quebra o loop circular do self-play.

O problema: self-play vê só a si mesmo → pode viciar em cartas estranhas que o
bot inimigo não sabe punir. Solução: 1× por semana (custo ~$0.50), envia as
top-80 cartas para **Claude Haiku 4.5** que retorna score 0-100 baseado em
conhecimento real de jogo competitivo. Cartas subavaliadas pelo self-play
sobem; superavaliadas descem.

### 6.5 Financial Defense (pilar 8)

- `ragCache.ts` — cache vetorial (query → embedding → match por similarity >
  0.92 → hit sem chamar LLM). TTL de 30 dias em Postgres.
- `circuitBreaker.ts` — disjuntor típico (fechado → half-open → aberto). Se a
  API externa falhar N vezes em M minutos, abre e rejeita chamadas por T
  minutos. Evita queimar budget em API downtime.
- `apiBudgetLedger` (tabela) — cada chamada registra `(model, tokens_in,
  tokens_out, usd)`. Limite diário enforcement.

---

## 7. ML Engine (Python) — O Cérebro Neural

### 7.1 GameStateGNN (pilar 2)

`ml_engine/models/game_state_gnn.py` — grafo heterogêneo com **2 tipos de nó**
e **4 tipos de aresta**:

```
Nós:
  card    (features: mana, power, toughness, flags, oracle embedding 384-d) → 395 dims
  player  (features: life, mana pool, hand size, turn) → 15 dims

Arestas:
  (card) --controlled_by--> (player)
  (card) --in_zone--------> (player)          # battlefield, hand, graveyard, exile
  (card) --synergizes_with-> (card)           # precomputado via cosine similarity ≥ 0.7
  (card) --attacks--------> (card)            # durante combate

Layers: 3 × HeteroConv(GATConv(heads=4)), hidden=128
Pooling: global_mean_pool por graph-id em card e player → concat → [256]
Heads:
  action_head: MLP → [B, 512]    # logits
  value_head:  MLP → [B, 1]      # scalar V(s)
```

**Por que GNN e não MLP/CNN**: relações carta↔carta↔player são grafos por
natureza. Uma flatten simples perderia quem controla o quê, qual carta está em
qual zona, e quais atacam quais bloqueadores. GATConv (Graph Attention)
aprende a ponderar "este comando é o mais ameaçador" no mesmo nível em que
CNNs aprendem features de imagem.

### 7.2 MtgForgeEnv (pilar 5)

`ml_engine/ray_cluster/env.py` — ambiente Gymnasium que encapsula **um
subprocesso Forge** (JVM) por worker. Protocolo JSON-line no stdin/stdout:

```
Python → Java:  {"type": "step", "action": 42}
Java → Python:  {"type": "state", "card_feats": [...], "player_feats": [...],
                 "edges": {...}, "action_mask": [...], "reward": 0.02, "done": false}
```

- Observation space: `Dict` com `card_feats`, `player_feats`, 4 tipos de
  arestas, e `action_mask` (MultiBinary(512))
- Action space: `Discrete(512)` **por default**. Opt-in (`config
  ["use_autoregressive_actions"]=True`) troca para `MultiDiscrete([4, 128,
  128])` = `(type, source, target)` — env empacota em int flat antes de
  enviar ao Forge (protocolo Java inalterado). Detalhes em §11.10.
- Robustez: crash do Forge → `env.reset()` respawna; turn cap (50) + step
  timeout (10s) impedem hangs

### 7.3 Reward Shaping (pilar 6)

`ml_engine/forge_worker/reward_shaper.py`:

```
r_total = r_outcome                     # {-1, 0, +1} no fim
        + α * Δlife_advantage            # você - oponente
        + ζ * mana_efficiency            # used / available  (Phase 1)
        + γ * Δcard_advantage            # diferença de hand size
        + δ * Δboard_control              # power total em jogo
        + ε * progress_bonus              # virar-se para lethal
        + archetype_modifier              # control: +bonus p/ mana aberta
        [bounded em ±0.1 por turno]
```

Teorema de Ng-Harada-Russell 1999: se o shaping é **potential-based** e
bounded, a política ótima é invariante. Logo: treino mais rápido, mesma solução.

**Phase 1 (abril/2026)**: o termo de tempo bruto (`beta * mana_value_played`)
foi substituído por **mana efficiency** (`zeta * used/available`) para deixar
de premiar "soltar carta cara" e passar a premiar "gastar bem o mana
disponível". Também entrou um modificador por arquétipo: control ganha
micro-bonus ao passar turno com ≥2 lands destapadas + ≥1 instant na mão.
Detalhes em §11.8.

### 7.4 LoopGuard (pilar 7)

`ml_engine/forge_worker/loop_guard.py`:
- SHA1 hash do estado canônico (life, battlefield, graveyards, hand sizes, phase)
- Se repetir ≥ 3× em janela de 50 estados → flag loop
- Loop detectado: reward `-2.0`, game termina, ação última → tabela `toxic_actions`
- Futuras gerações PBT herdam a aversão sem precisar redescobrir

### 7.5 Orchestrator (pilar 1 + 7)

`ml_engine/ray_cluster/orchestrator.py` — entrypoint de treinamento.

**IMPALA (Importance Weighted Actor-Learner)**: escolhido porque suporta
rollouts assíncronos em escala. Forge é lento (segundos por turno), mas
múltiplos workers coletam trajetórias em paralelo e enviam ao learner central,
que aplica **V-trace** para corrigir o bias de trajetórias stale. Isso mantém
GPU ocupada mesmo com env lento.

**PBT (Population-Based Training)**: 4 trials em paralelo, cada um com
hiperparâmetros diferentes (`lr`, `entropy_coeff`, `vf_loss_coeff`,
`grad_clip`). A cada `perturbation_interval=20` iterações:
1. Rankeia trials pela métrica `env_runners/episode_reward_mean`
2. Trials ruins **copiam os pesos** de trials bons
3. Hiperparâmetros mutam (perturbação log-uniforme ou resample)

**League scheduling**: a cada 20 iterações, o melhor trial é congelado e
adicionado ao pool de oponentes. Actors samplam 50% oponente do pool / 50%
self-play vivo — combate o **catastrophic forgetting** (esquecer como bater
matchups antigos).

**GPU detection** (novo — abril/2026): helper `_gpu_per_trial()` detecta CUDA
via `torch.cuda.is_available()` e aloca `0.25` GPU por trial. 4 trials
concorrentes somam 1.0 GPU → cabem numa única 2070 SUPER. Override via env
`MTG_GPU_PER_TRIAL` (ex: `0.5` → 2 concurrent, `1.0` → 1 por vez).

### 7.6 RAG (pilares 3 + 4)

- `embedder.py` — carrega MiniLM-L6-v2 uma vez, expõe `embed(text)` e
  `embed_batch(texts)`
- `server.py` — FastAPI em `:8765` (`POST /embed`, `GET /health`). Preload do
  modelo no startup para não ter cold-start
- `pgvector_writer.py` — backfill em batch de `card_oracle_embeddings`, uma
  linha por carta: `(card_id, embedding vector(384))`

---

## 8. Integração Forge (Java)

O Forge é um **engine open-source de MTG** que implementa 100% das regras.
Usamos o módulo `forge/rlbridge/` (built pelo `build.cmd`) que:

1. Inicia uma partida headless (sem GUI) com dois decks dados
2. Recebe ações via stdin JSON
3. Executa a ação (priority, stack resolution, layered effects — tudo oficial)
4. Serializa o estado resultante em JSON e escreve no stdout
5. Loop até win/loss/draw/turn_cap

O `MtgForgeEnv` do lado Python só gerencia o subprocesso e traduz
Gymnasium↔JSON. A vantagem é: **se o agente aprende a ganhar no Forge, ganha
em partidas reais** — não há divergência de regras.

---

## 9. Ciclo de Vida do Projeto

### 9.1 Setup inicial (1×)

```powershell
# 1. Clonar + instalar deps Node
git clone <repo> ; cd mtg-deck-mvp
pnpm install        # ou npm install

# 2. Criar venv Python 3.12 + deps ML
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r ml_engine\requirements.txt

# 3. Instalar torch com CUDA (se tiver GPU NVIDIA)
.\.venv\Scripts\pip.exe install --index-url https://download.pytorch.org/whl/cu126 torch==2.11.0+cu126

# 4. Build do rlbridge (Java + Maven)
cd forge\rlbridge ; .\build.cmd ; cd ..\..

# 5. Configurar .env (DATABASE_URL, ANTHROPIC_API_KEY)
# 6. Criar banco + aplicar migrations
npm run db:push

# 7. Popular cartas (Scryfall)
npm run seed:scryfall

# 8. Gerar embeddings oracle (pgvector)
npm run embed:cards
```

### 9.2 Smoke test (validar tudo funcionando)

```powershell
npm run db:health           # tabelas OK
npm run forge:smoke         # 1 partida end-to-end no Forge
npm run forge:smoke:multi   # 5 partidas
npm run train:ray:smoke     # 72s de treino RL (valida GPU)
```

### 9.3 Rotina diária de treinamento

| Momento | Comando | Duração | O que faz |
|---|---|---|---|
| Chegada | `npm run teach` | ~9 min | Commander Intelligence (1500 games) + Archetype Self-Play (12500 games) → enche `card_learning` |
| Dia/noite | `npm run train:ray` | até 24h | PBT+IMPALA: 4 trials na GPU, checkpoint a cada 10 iter em `ray_results/` |
| Monitor (opcional, 2º terminal) | `nvidia-smi -l 5` | — | GPU utilization ao vivo |
| App (3º terminal, opcional) | `npm run stack:up` | — | Sobe ml_engine :8765 + Node :3000 |

### 9.4 Cadência semanal

- **Segunda a Sábado**: rotina diária acima.
- **Domingo**: `npm run calibrate:llm` (~$0.50 em Haiku) para corrigir drift
  antes de rodar `npm run teach` de novo.

### 9.5 Pipeline completo (retrain)

`npm run train` (via `run-all.ps1`) executa as 12 etapas: sync Scryfall →
scrapers → clustering → embeddings → commander → self-play → meta analysis →
regression tests. Rota mensal, não diária.

---

## 10. Como o Modelo Aprende e Melhora

Este é o coração do projeto. Quatro fluxos de aprendizado **convergem na
mesma tabela** `card_learning`, cada um reforçando/corrigindo o outro.

### 10.1 Fluxo A — Self-Play Heurístico (TypeScript, diário)

```
┌─ População inicial (100 decks, 5 arquétipos × 20) ──────────────────┐
│    ↓                                                                 │
│  Avalia cada deck (DeckEvaluationBrain: curva, sinergia, simulação) │
│    ↓                                                                 │
│  Seleciona top 25% (elite)                                           │
│    ↓                                                                 │
│  Crossover + Mutation → nova geração                                 │
│    ↓                                                                 │
│  Partida Forge entre pares de decks → winrate real                   │
│    ↓                                                                 │
│  CardLearningQueue.enqueue(delta proporcional ao Δwinrate)           │
│    ↓                                                                 │
│  Weight capping [0.1, 50] + decay (1 - w/MAX)²                       │
└──────────────────────────────────────────────────────────────────────┘
```

**Resultado por rodada**: ~12500 partidas, ~500 ajustes de pesos, ~10 min.

### 10.2 Fluxo B — Commander Intelligence (TypeScript, diário)

Variante de A com:
- Pool limitado ao color identity válido
- `--forbidden-color` rotativa (impõe diversidade)
- Deck size 100 singleton
- ~1500 partidas por run, ~8 min

### 10.3 Fluxo C — Deep RL (Python + Ray, 24h budget)

```
┌─ 4 trials PBT em paralelo (GPU 0.25 cada) ──────────────────────────┐
│                                                                      │
│  Trial_i:                                                            │
│    Actors (Forge subprocess) geram trajetórias                       │
│        ↓ (assíncrono)                                                │
│    Learner central (GNN + V-trace loss) atualiza θ                   │
│        ↓                                                             │
│    LoopGuard detecta loops, injeta toxic_actions                     │
│        ↓                                                             │
│    Reward shaping denso → gradiente desde turn 1                     │
│                                                                      │
│  A cada 20 iters:                                                    │
│    - Rankeia trials                                                  │
│    - Trials ruins copiam pesos dos bons + mutam hparams              │
│    - Best trial → league pool (frozen opponent)                      │
│                                                                      │
│  Checkpoint a cada 10 iters → ray_results/pbt_mtg_<ts>/              │
└──────────────────────────────────────────────────────────────────────┘
```

**Ponto-chave**: ao final, o melhor trial é destilado de volta em pesos de
cartas via `rlToCardLearningBridge.ts` (heurística: cartas que aparecem em
estados de alto V(s) recebem delta positivo).

### 10.4 Fluxo D — Calibração LLM (semanal)

- Envia top-80 cartas × 5 arquétipos para Claude Haiku
- Recebe score 0-100 por carta
- Calcula delta = `(score - 50)/50 * {0.15 se positivo, 0.10 se negativo}`
- `CardLearningQueue.enqueue(delta)` com source `unified_learning`
- Resultado: correção de drift que o self-play isolado não conseguiria fazer

### 10.5 Como os fluxos se complementam

| Fluxo | Velocidade | Qualidade do sinal | Risco |
|---|---|---|---|
| A (Self-play heurístico) | alta (10 min) | médio (heurística pode mentir) | viciar em combos estranhos |
| B (Commander) | alta (8 min) | médio-alto (identidade válida) | tendência por cor popular |
| C (RL profundo) | baixa (24h) | alto (Forge é verdade absoluta) | custo computacional |
| D (LLM calibrator) | média (10 min) | alto (conhecimento humano) | custo financeiro |

A combinação equivale a um **ensemble de professores**: heurística é rápida
mas pode mentir, RL é verdade absoluta mas caro, LLM tem senso comum humano.
Todos votam na mesma tabela.

### 10.6 Métrica visível de progresso

```sql
-- Pesos por faixa após N treinos
SELECT
  COUNT(*) FILTER (WHERE weight >= 10) AS elite,
  COUNT(*) FILTER (WHERE weight BETWEEN 2 AND 10) AS strong,
  COUNT(*) FILTER (WHERE weight BETWEEN 0.5 AND 2) AS baseline,
  COUNT(*) FILTER (WHERE weight < 0.5) AS weak,
  AVG(weight) AS avg_weight,
  COUNT(*) FILTER (WHERE win_count + loss_count > 100) AS well_explored
FROM card_learning;
```

Rode `npm run check:learn` (= `checkCommanderWeights.ts`) depois de cada
`npm run teach` e observe:
- `elite` cresce (cartas que provaram valor)
- `weak` cresce (cartas descartadas)
- `well_explored` cresce monotonicamente (exploração cumulativa)
- `avg_weight` deve **estabilizar** próximo de 1.5–3.0 (não crescer sem
  parar — se crescer, cap do decay falhou).

---

## 11. Implementações Recentes (abril/2026)

Histórico do trabalho mais recente — alinhar com os commits:

### 11.1 Suporte a GPU ativa

- **Problema**: `torch 2.11.0+cpu` no venv → treinos 100% na CPU apesar da
  RTX 2070 SUPER idle. Ventoinha do CPU a 100% enquanto GPU a 0%.
- **Fix**:
  1. Reinstalação do wheel com CUDA: `torch==2.11.0+cu126` do índice oficial
     PyTorch
  2. Novo helper `_gpu_per_trial()` em `orchestrator.py` que detecta via
     `torch.cuda.is_available()` e aloca `num_gpus=0.25` por trial
  3. Env override `MTG_GPU_PER_TRIAL` para ajustar fração
- **Validação**: `nvidia-smi` mostra 16% util / 605 MiB VRAM por trial; Ray
  dashboard mostra `0.25/1 GPUs` (antes: `0/1`).

### 11.2 Ray 2.53 New API Stack

- **Problema**: Ray 2.11+ defaulta IMPALA para a new RLModule/Learner API,
  incompatível com `custom_model="game_state_gnn"`.
- **Fix**: `IMPALAConfig().api_stack(enable_rl_module_and_learner=False,
  enable_env_runner_and_connector_v2=False)` — shim oficial para legacy API.

### 11.3 IMPALA V-trace vs GAE

- **Problema**: `tune.run` rejeitou `lambda_` como kwarg.
- **Fix**: IMPALA usa V-trace (não GAE), logo `lambda_` é inválido. Removido
  das `PBT_MUTATIONS` e de `.training()`.

### 11.4 Métrica nested

- **Problema**: trial "did not include metric episode_reward_mean".
- **Fix**: Ray 2.11+ aninhou a métrica. Nova chave:
  `env_runners/episode_reward_mean` em `metric_key`.

### 11.5 GNN batched obs

- **Problema**: `KeyError: 'card'` no `forward()` — RLlib passa `Dict[str,
  Tensor]` batched, não `HeteroData`.
- **Fix**: Novo helper `_batched_dict_to_hetero()` em `game_state_gnn.py` que
  desempacota o dict com offsets per-graph (para arestas) e sintetiza `.batch`
  indices para `global_mean_pool`.

### 11.6 Python resolution em npm scripts

- **Problema**: `npm run train:ray` no Windows pegava Python 3.14 do sistema
  (sem ray/torch) em vez do `.venv`.
- **Fix**: Shim `scripts/run-python.mjs` que resolve nessa ordem: `$PYTHON`
  → `.venv/Scripts/python.exe` → `venv/Scripts/python.exe` → fallback. Todos
  os scripts Python no `package.json` passaram a usar o shim. Também define
  `PYTHONPATH=<repo root>` para `python -m ml_engine.X` funcionar de qualquer CWD.

### 11.7 run-stack.ps1 auto-detect venv

- **Problema**: `npm run stack:up` falhava com `ModuleNotFoundError:
  sentence_transformers` — mesmo motivo do 11.6.
- **Fix**: `run-stack.ps1` com bloco de auto-detecção que prefere
  `.venv\Scripts\python.exe` antes de cair em `python` do PATH.

### 11.8 Phase 1 — Reward Shaping: Mana Efficiency + Archetype bonus

- **Problema**: o termo de tempo (`beta_tempo * mana_value_played`) premiava
  *gastar mana bruto*. Agente aprendia a soltar qualquer carta cara mesmo
  quando ficava com 3 terrenos virados e sem resposta.
- **Fix**: `ml_engine/forge_worker/reward_shaper.py`
  - `ShapingConfig.zeta_efficiency=0.03` — premia `mana_used / mana_available`
    (∈ [0,1]). Gastar 4 de 4 disponíveis → bonus cheio; flood de 1 de 4 →
    25% do bonus.
  - `ShapingConfig.control_mana_open_bonus=0.015` — micro-reforço quando
    `archetype="control"` + `turn_ended=True` + `untapped_lands>=2` +
    `instants_in_hand>=1`. Ensina o conceito de *passar com mana aberta*
    sem hard-code.
  - `GameStateSnapshot` ganhou campos `mana_available_you`,
    `untapped_lands_you`, `instants_in_hand_you`, `archetype`, `turn_ended`
    (defaults=0/""/False para back-compat).
  - `beta_tempo` **depreciado** (default 0.0; mantido só para testes legados).
- **Integração**: `env.py` `_state_to_snapshot` extrai os novos campos do
  JSON do bridge (com fallbacks: `mana_pool_total` → `lands_untapped`,
  `phase ∈ {END, END_OF_TURN, CLEANUP}` → `turn_ended=True`). Env aceita
  `config["archetype"]` e propaga automaticamente para o shaper.
- **Testes**: 22/22 passam, incluindo 10 novos cobrindo efficiency
  (full/partial/over-cast/no-info), control bonus (on/off, requer
  end-of-turn, requer instants), aggro não herda bonus, e back-compat com
  snapshots sem os novos campos.

### 11.9 Phase 2 — Contextual Distillation: pesos por arquétipo

- **Problema**: `card_learning.weight` é **escalar global**. [Counterspell]
  recebia o mesmo peso em control e aggro — em aggro o peso descia
  (ruim no arquétipo) e "puxava" a reputação da carta no sistema inteiro.
- **Fix**:
  1. Migration `drizzle/0006_archetype_weights.sql`: adiciona 5 colunas
     reais idempotentes a `card_learning`: `weight_aggro`, `weight_control`,
     `weight_midrange`, `weight_combo`, `weight_ramp` (todas default 1.0).
     Backfill: se todas estão em 1.0 e `weight` não, copia o global para
     os 5 buckets (warm-start). 5 índices novos para queries por archetype.
  2. `drizzle/schema.ts`: campos TS + constante exportada
     `CARD_LEARNING_ARCHETYPES` (tipo literal union).
  3. `server/services/cardLearningQueue.ts`: `CardLearningUpdate.archetype?`
     opcional. `updateCardWeight` agora agrupa deltas em **buckets**:
     - `_global` sempre recebe TODOS os deltas → atualiza `weight` (compat)
     - cada archetype recebe apenas os deltas daquele archetype, com
       decay próprio `(1 - w/MAX)²` baseado no peso daquela coluna
     - upsert com SET dinâmico (só colunas que mudaram)
     - helper exportado `normalizeArchetype(raw)` valida em runtime
  4. `server/services/rlToCardLearningBridge.ts`:
     `feedbackFromDeckOptimization(deck, score, deckId, archetype?)` e
     `syncRLRewardsToCardLearning()` extrai archetype do metadata.
  5. `server/services/modelLearning.ts`:
     `getCardWeights(archetype?)` lê coluna específica com cache próprio
     (TTL 60s, bucket por arquétipo). `updateWeights(updates, source,
     defaultArchetype?)` propaga. `invalidateCache()` limpa ambos.
- **Validação**: probe end-to-end em DB real mostra:
  ```
  enqueue(delta=0.3, archetype=control)
  enqueue(delta=0.1, archetype=aggro)
  enqueue(delta=0.2, sem archetype)
  → weight=1.578 (recebeu 0.3+0.1+0.2)
  → weight_control=1.289 (só os 0.3)
  → weight_aggro=1.096 (só os 0.1)
  → weight_combo/ramp/midrange=1.0 (inalterados)
  ```
  Todos os 251 testes vitest + 35 pytest continuam verdes.

### 11.10 Phase 3 — Autoregressive Actions (opt-in)

- **Problema**: `Discrete(512)` trata toda ação como átomo independente.
  O agente precisa aprender do zero que "jogar Lightning Bolt no rosto"
  e "jogar Lightning Bolt no goblin" compartilham a mesma carta-fonte.
  Explosão combinatória de ações similares mata exploração.
- **Fix** (opt-in, backward-compat total):
  1. `env.py`: flag de config `use_autoregressive_actions` (default
     `False`). Quando `True`, `action_space = MultiDiscrete([4, 128, 128])`
     — triple `(action_type, source, target)`.
  2. Método privado `_encode_action(a)` empacota o triple em int
     flat (`type * S*T + source * T + target`) mod `num_actions` antes de
     enviar ao Forge. **O protocolo JSON do rlbridge Java não muda** —
     segue recebendo `{"cmd": "step", "action": <int>}`.
  3. `game_state_gnn.py`: wrapper RLlib agora checa shape da
     `action_mask` antes de aplicá-la. Em AR mode os logits têm 260 dims
     (4+128+128) e a mask Forge tem 512 — shapes diferentes → mask
     ignorada (ações inválidas caem no `penalty_illegal_action` do
     shaper).
- **Como ligar**:
  ```python
  env_config = {
      "use_autoregressive_actions": True,
      "ar_num_types": 4,     # {pass, cast, attack, block}
      "ar_num_sources": 128, # até 128 cartas visíveis
      "ar_num_targets": 128,
  }
  ```
  RLlib decompõe o `MultiDiscrete` em 3 distribuições categóricas
  independentes automaticamente. Para autoregressividade *real*
  (target condicionado em type+source) seria preciso um
  `ActionDistribution` custom — ficou para um futuro pilar se o ganho
  empírico compensar.
- **Validação**: smoke test `env + shaper + GNN(260)` forward-pass OK;
  Discrete(512) continua o default e não é afetado.

---

## 12. Comandos de Referência Rápida

### Setup / Saúde

```powershell
npm run db:push           # aplica migrations
npm run db:health         # checa tabelas e linhas
npm run seed:scryfall     # popula cartas
npm run embed:cards       # backfill pgvector (~60k cartas, 5 min GPU)
```

### Treino leve (dia-a-dia)

```powershell
npm run teach             # Commander + Self-Play (9 min, CPU)
npm run check:learn       # ver evolução dos pesos
```

### Treino pesado (GPU)

```powershell
npm run train:ray         # PBT+IMPALA, 24h budget, 4 trials na GPU
npm run train:ray:smoke   # sanity check 72s

# ajustes:
$env:MTG_GPU_PER_TRIAL="0.5" ; npm run train:ray   # 2 trials GPU inteira/2
$env:MTG_GPU_PER_TRIAL="1"   ; npm run train:ray   # 1 trial por vez
$env:MTG_GPU_PER_TRIAL="0"   ; npm run train:ray   # force CPU
```

### Calibração semanal

```powershell
npm run calibrate:llm     # ~$0.50 Haiku, corrige drift do self-play
```

### Testes

```powershell
npm run forge:smoke         # 1 partida Forge end-to-end
npm run forge:smoke:multi   # 5 partidas
npm run test                # vitest (Node)
npm run ml:test             # pytest (Python forge_worker)
npm run test:model          # regressão do modelo
```

### Stack web

```powershell
npm run stack:up          # sobe ml_engine :8765 + node :3000 (Ctrl+C graceful)
npm run dev               # só Node + Vite
```

### Monitoramento

```powershell
nvidia-smi -l 5                                # GPU live
Get-Content logs\ml_engine.log -Tail 50 -Wait  # logs Python
Get-Content logs\node_api.log -Tail 50 -Wait   # logs Node
```

---

## 13. Racional das Escolhas Arquiteturais

| Decisão | Alternativa rejeitada | Motivo |
|---|---|---|
| **GNN heterogênea** | MLP sobre vetor flat de cartas | MLP perderia relação card↔player↔zone |
| **IMPALA + V-trace** | PPO sync | Forge é lento → PPO sync desperdiça GPU; IMPALA async absorve latência |
| **PBT (4 trials)** | Single trial | Non-stationarity de MTG exige exploração de hparams contínua |
| **League pool** | Self-play puro | Catastrophic forgetting (esquecer como bater matchup antigo) |
| **Forge real vs simulador simples** | Heurística de combate TS | Forge valida 100% das regras (replacement effects, layered abilities) |
| **pgvector** | FAISS standalone | Centralizar tudo em Postgres = menos infra, transações ACID |
| **Sentence-Transformers 384-d** | OpenAI Ada 1536-d | 4× menor embedding, barato, local, zero custo de API |
| **Claude Haiku 4.5 para calibrator** | GPT-4 / Opus | Haiku é ~50× mais barato e suficiente para ranking 0-100 |
| **CardLearningQueue FIFO** | Lock pessimista SQL | Throughput 100× maior; evita deadlocks entre 3 escritores |
| **Weight cap [0.1, 50] + decay quadrático** | Sem cap | Evita saturação e peso infinito após 1000 iterações |
| **Ray legacy API stack** | RLModule (novo) | `custom_model` GNN só suportado no legacy por enquanto |

---

## 14. Glossário

- **Arquétipo** — estilo de deck (aggro, control, midrange, combo, ramp)
- **Color identity** — conjunto de cores de um Commander (restringe o deck)
- **IMPALA** — Importance Weighted Actor-Learner Architecture (DeepMind 2018)
- **V-trace** — correção off-policy em IMPALA que tolera trajetórias stale
- **PBT** — Population-Based Training (DeepMind 2017): evolui hparams + pesos
- **GNN / GATConv** — Graph Neural Network / Graph Attention Convolution
- **HeteroConv** — convolução sobre grafo com múltiplos tipos de nó/aresta
- **pgvector** — extensão Postgres para tipo `vector(N)` + índice IVFFlat/HNSW
- **RAG** — Retrieval-Augmented Generation (cache semântico de queries)
- **Shaping reward** — sinal denso que acelera aprendizado sem mudar política ótima
- **Toxic action** — ação que levou a loop infinito; banida em treinos futuros
- **League** — pool de oponentes congelados para self-play anti-forgetting
- **Tier (S/A/B/C/D/F)** — classificação holística de deck pelo DeckEvaluationBrain

---

## 15. Próximos Passos (não implementados, só planejados)

- [ ] Destilação formal RL → card weights (hoje é heurística em
      `rlToCardLearningBridge.ts`)
- [ ] MCTS em inferência (tabela `mcts_nodes` reservada mas não usada)
- [ ] Multi-GPU para PBT (>4 trials concorrentes)
- [ ] Dashboard de progresso de treino (hoje é CLI + checkpoints)
- [ ] Ensemble de modelos congelados em inferência (para gerar decks mais
      robustos via voting)

---

*Última atualização: abril/2026 — Phase 1 (Mana Efficiency reward),
Phase 2 (pesos por arquétipo em `card_learning`) e Phase 3 (MultiDiscrete
autoregressive actions opt-in). 35 pytest + 251 vitest + tsc exit 0.*

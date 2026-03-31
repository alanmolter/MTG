# MTG Deck Engine MVP - Arquitetura Detalhada

## Visão Geral

O MVP é uma aplicação web full-stack para geração e análise de decks competitivos de Magic: The Gathering. A arquitetura combina análise de dados (embeddings, grafos, clustering) e aprendizado de máquina (Self-Play, Reinforcement Learning) com uma interface intuitiva para jogadores e analistas. O sistema utiliza o **MTG Forge** como motor de regras oficial para simular partidas e validar interações.

## Stack Tecnológico

| Camada | Tecnologia | Justificativa |
|---|---|---|
| **Frontend** | React 19 + Tailwind 4 | UI responsiva, componentes reutilizáveis |
| **Backend** | Express + tRPC | Type-safe RPC, fácil integração com frontend |
| **Banco de Dados** | PostgreSQL (Drizzle ORM) | Armazenamento de cartas, decks, metadados e pesos de aprendizado |
| **ML/Análise** | TypeScript (Word2Vec, KMeans) | Embeddings de cartas, clustering de arquétipos, Self-Play, Reinforcement Learning |
| **Motor de Regras** | MTG Forge Engine | Validação de regras completas, simulação de partidas reais |
| **Integração** | Scryfall API | Dados oficiais de cartas MTG |

## Arquitetura de Componentes

### 1. Data Layer (Backend)

**Tabelas Principais:**
- `cards`: Catálogo de cartas (id, name, cmc, type, colors, rarity, scryfall_id)
- `decks`: Decks importados/gerados (id, name, format, archetype, user_id)
- `deck_cards`: Relação many-to-many (deck_id, card_id, quantity)
- `card_learning`: Pesos de aprendizado da IA (cardName, weight, winCount, lossCount, avgScore)
- `competitive_decks`: Decks do metagame extraídos de torneios (com suporte a `is_synthetic`)
- `meta_stats`: Estatísticas de frequência (card_id, format, win_rate, play_rate, archetype)

### 2. Backend Services

#### A. Scryfall Integration (`server/services/scryfall.ts`)
- Sincronização de catálogo de cartas
- Busca por nome, tipo, cores, CMC
- Cache de imagens e dados

#### B. Machine Learning & AI Engine (`server/services/modelLearning.ts`)
- **Self-Play Loop**: Simulação contínua de partidas para evolução de decks
- **Commander Intelligence**: Treinamento especializado para o formato Commander (EDH)
- **Genetic Algorithm**: Mutação e crossover de decks baseados em performance
- **CardLearningQueue**: Fila FIFO serializada para atualização de pesos sem race conditions, com weight capping `[0.1, 50.0]` e decay proporcional
- **Cache em Memória**: TTL de 60s para pesos de cartas, reduzindo drasticamente a carga no banco de dados durante a geração em massa (evita >10.000 queries por iteração)

#### C. Forge Engine Integration (`server/services/forgeStatus.ts`)
- Motor de regras oficial do MTG para simulação de partidas
- Validação de legalidade de cartas, formatos (Standard, Commander) e restrições (singleton, identidade de cor)
- Geração de dados `forge_reality` baseados em resultados de partidas simuladas com variância estocástica
- **Feedback Visual Centralizado**: Banners de inicialização, status de conexão, regras aplicadas e progresso em tempo real no terminal

#### D. Embeddings & Clustering (`server/services/embeddings.ts`, `server/services/clustering.ts`)
- Treino de Word2Vec para representação vetorial de cartas (dimensão 64)
- **KMeans Robusto**: Implementação manual do algoritmo KMeans com tratamento de clusters vazios (re-seed) para evitar crashes comuns em bibliotecas de terceiros
- **Métricas de Qualidade**: Silhouette Score, Calinski-Harabasz, Davies-Bouldin e Inertia com tratamento de divisão por zero e precisão de ponto flutuante
- **Classificação de Arquétipos**: Heurísticas avançadas baseadas em proporção de criaturas, mágicas, CMC médio e identidade de cor (Guilds/Shards)

#### E. Deck Generator & Evaluator (`server/services/deckGenerator.ts`, `server/services/deckEvaluationBrain.ts`)
- Geração inicial baseada em arquétipos e pesos aprendidos
- Avaliação heurística (curva de mana, sinergia, impacto)
- **Game Feature Engine**: Cálculo de `impactScore` dinâmico baseado em CMC, raridade, e funções (board wipe, finisher, remoção, discard)
- **Simulação Estocástica**: `ModelEvaluator` com fator de variância de draws (`0.5x - 1.5x`) e normalização por tamanho de deck para evitar winrates triviais (ex: Commander 100 cartas vs Standard 60 cartas)

#### F. Meta Analytics & Scrapers (`server/services/mtggoldfishScraper.ts`, `server/services/mtgtop8Scraper.ts`)
- Extração de decks competitivos de torneios reais
- **Multi-formato**: Suporte a Standard, Modern, Legacy, Pioneer, Pauper e Vintage (10 decks por formato)
- **Downloads Paralelos**: Rate-limiting inteligente e execução concorrente
- **SQL Raw Defensivo**: Inserção direta via `postgres.js` com detecção automática de schema para evitar bugs do Drizzle ORM com `ON CONFLICT`

### 3. Frontend Architecture

#### Pages
- **Home**: Landing com resumo de meta
- **CardSearch**: Busca avançada de cartas com filtros
- **DeckBuilder**: Editor interativo de decks
- **DeckGenerator**: Gerador automático com opções de arquétipos e IA
- **MetaDashboard**: Estatísticas e tendências
- **DeckExport**: Exportação em múltiplos formatos

#### Components
- `CardCard`: Exibição de carta individual
- `DeckList`: Tabela de cartas no deck
- `ArchetypeSelector`: Seletor de arquétipos
- `MetaChart`: Gráficos de frequência/win-rate

### 4. Data Flow (Training Pipeline)

```
1. Inicialização & Sincronização
   Scryfall API → cards table
   MTGGoldfish/MTGTop8 (6 formatos) → competitive_decks

2. Treinamento Contínuo (Self-Play & Commander)
   Gerar População (usando pesos atuais)
   → Avaliar (DeckEvaluationBrain)
   → Selecionar Elite (Top 25%)
   → Evoluir (Mutação & Crossover)
   → Simular Partidas (Forge Engine - Commander vs Commander)
   → Atualizar Pesos (CardLearningQueue → card_learning)

3. Geração de Deck para Usuário
   User selects archetype/format
   → Fetch learned weights (cache em memória)
   → Generate optimized deck
   → Return to frontend
```

## Funcionalidades MVP

### Fase 1: Core (Essencial)
- [x] Schema de banco de dados (Drizzle ORM)
- [x] Integração Scryfall (busca e sincronização)
- [x] Busca de cartas com filtros
- [x] Visualização de cartas
- [x] Gerador de decks simples (por arquétipos pré-definidos)
- [x] Exportação de decks (texto)

### Fase 2: Análise & Metagame (Importante)
- [x] Scrapers para MTGGoldfish e MTGTop8 (multi-formato, paralelos)
- [x] Embeddings Word2Vec para cartas (dimensão 64)
- [x] Clustering de arquétipos (KMeans manual robusto)
- [x] Dashboard de meta (top decks, frequência)
- [ ] Motor de sinergia (grafo de co-ocorrência)
- [ ] Visualização de grafo interativa

### Fase 3: Otimização & IA (Avançado)
- [x] Simulação de partidas com motor de regras (Forge Engine)
- [x] Loop de Self-Play e Reinforcement Learning
- [x] Treinamento especializado para Commander (Commander vs Commander)
- [x] Fila de aprendizado assíncrona (CardLearningQueue)
- [x] Otimização de deck baseada em pesos aprendidos e `impactScore` dinâmico

## Decisões de Design e Correções Recentes

1. **Scrapers Multi-formato e SQL Raw**: Os scrapers foram reescritos para baixar 10 decks de 6 formatos diferentes em paralelo. Para contornar um bug do Drizzle ORM com `ON CONFLICT` e parâmetros duplicados, a inserção no banco foi migrada para SQL raw usando `postgres.js` nativo, com detecção automática da coluna `is_synthetic`.
2. **KMeans Manual Robusto**: A biblioteca `ml-kmeans` foi substituída por uma implementação manual do algoritmo KMeans. Isso resolveu crashes críticos causados por clusters vazios (onde a biblioteca tentava acessar índices `undefined`), implementando uma estratégia de re-seed que pega o ponto mais distante do cluster mais populoso.
3. **Simulação Estocástica e Normalização**: O `ModelEvaluator` foi ajustado para normalizar o poder do deck pelo seu tamanho (evitando que decks Commander de 100 cartas sempre vençam decks Standard de 60 cartas). Além disso, oponentes de teste agora são do mesmo formato (Commander vs Commander) e possuem níveis de força balanceados (ex: 3 oponentes Midrange diferentes).
4. **Game Feature Engine Dinâmico**: O cálculo de `impactScore` foi aprimorado para refletir o poder real das cartas. Criaturas com CMC alto (3-4 e 5+) recebem bônus, assim como cartas de remoção (Fatal Push) e descarte (Thoughtseize), permitindo que decks Midrange e Control tenham winrates competitivos e realistas nas simulações.
5. **Feedback Visual e UX do Terminal**: Implementação do `forgeStatus.ts` para centralizar o feedback visual no terminal. Resolução de problemas de sobreposição de texto (`\r` vs `\n`), limpeza de linhas truncadas na fila de aprendizado, e exibição correta de métricas (partidas reais em vez de multiplicadores artificiais de regras).
6. **Deduplicação Inteligente**: O ranking de Comandantes agora deduplica cartas double-faced pelo nome do personagem (antes da vírgula) e prioriza cartas com partidas reais simuladas, evitando que pesos inflados por herança dominem o topo da lista.
7. **Wrapper PowerShell**: Criação do `run-all.ps1` nativo para garantir compatibilidade total com usuários de Windows PowerShell, mantendo a mesma experiência visual do CMD.

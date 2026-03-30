# MTG Deck Engine MVP - Arquitetura Detalhada

## Visão Geral

O MVP é uma aplicação web full-stack para geração e análise de decks competitivos de Magic: The Gathering. A arquitetura combina análise de dados (embeddings, grafos, clustering) e aprendizado de máquina (Self-Play, Reinforcement Learning) com uma interface intuitiva para jogadores e analistas. O sistema utiliza o **MTG Forge** como motor de regras oficial para simular partidas e validar interações.

## Stack Tecnológico

| Camada | Tecnologia | Justificativa |
|--------|-----------|--------------|
| Frontend | React 19 + Tailwind 4 | UI responsiva, componentes reutilizáveis |
| Backend | Express + tRPC | Type-safe RPC, fácil integração com frontend |
| Banco de Dados | PostgreSQL (Drizzle ORM) | Armazenamento de cartas, decks, metadados e pesos de aprendizado |
| ML/Análise | TypeScript (ml-kmeans, embeddings) | Word2Vec, KMeans, Self-Play, Reinforcement Learning |
| Motor de Regras | MTG Forge Engine | Validação de regras completas, simulação de partidas reais |
| Integração | Scryfall API | Dados oficiais de cartas MTG |

## Arquitetura de Componentes

### 1. Data Layer (Backend)

**Tabelas Principais:**
- `cards`: Catálogo de cartas (id, name, cmc, type, colors, rarity, scryfall_id)
- `decks`: Decks importados/gerados (id, name, format, archetype, user_id)
- `deck_cards`: Relação many-to-many (deck_id, card_id, quantity)
- `card_learning`: Pesos de aprendizado da IA (cardName, weight, winCount, lossCount, avgScore)
- `competitive_decks`: Decks do metagame extraídos de torneios
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
- **CardLearningQueue**: Fila FIFO serializada para atualização de pesos sem race conditions, com weight capping [0.1, 50.0] e decay proporcional

#### C. Forge Engine Integration (`server/services/forgeStatus.ts`)
- Motor de regras oficial do MTG para simulação de partidas
- Validação de legalidade de cartas, formatos (Standard, Commander) e restrições (singleton, identidade de cor)
- Geração de dados `forge_reality` baseados em resultados de partidas simuladas com variância estocástica

#### D. Embeddings & Clustering (`server/services/embeddings.ts`, `server/services/clustering.ts`)
- Treino de Word2Vec para representação vetorial de cartas
- KMeans (`ml-kmeans`) para identificar arquétipos e classificar decks
- Normalização de dimensões de vetores para evitar inconsistências

#### E. Deck Generator & Evaluator (`server/services/deckGenerator.ts`, `server/services/deckEvaluationBrain.ts`)
- Geração inicial baseada em arquétipos e pesos aprendidos
- Avaliação heurística (curva de mana, sinergia, impacto)
- Simulação de partidas (ModelEvaluator) com fator estocástico para evitar winrates triviais

#### F. Meta Analytics & Scrapers (`server/services/mtggoldfishScraper.ts`, `server/services/mtgtop8Scraper.ts`)
- Extração de decks competitivos de torneios reais
- Análise de tendências de formato e arquétipos

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
   MTGGoldfish/MTGTop8 → competitive_decks

2. Treinamento Contínuo (Self-Play & Commander)
   Gerar População (usando pesos atuais)
   → Avaliar (DeckEvaluationBrain)
   → Selecionar Elite (Top 25%)
   → Evoluir (Mutação & Crossover)
   → Simular Partidas (Forge Engine)
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
- [x] Scrapers para MTGGoldfish e MTGTop8
- [x] Embeddings Word2Vec para cartas
- [x] Clustering de arquétipos (KMeans)
- [x] Dashboard de meta (top decks, frequência)
- [ ] Motor de sinergia (grafo de co-ocorrência)
- [ ] Visualização de grafo interativa

### Fase 3: Otimização & IA (Avançado)
- [x] Simulação de partidas com motor de regras (Forge Engine)
- [x] Loop de Self-Play e Reinforcement Learning
- [x] Treinamento especializado para Commander
- [x] Fila de aprendizado assíncrona (CardLearningQueue)
- [x] Otimização de deck baseada em pesos aprendidos

## Decisões de Design Recentes

1. **Integração do Forge Engine**: Utilizado como motor de regras definitivo para simulações de partidas, garantindo que a IA aprenda com interações reais do jogo (curva de mana, remoções, variância de draws) em vez de heurísticas estáticas.
2. **CardLearningQueue**: Implementada uma fila FIFO para gerenciar atualizações de pesos no banco de dados, eliminando race conditions entre processos paralelos (Self-Play, Commander Train, Frontend).
3. **Weight Capping & Decay**: Pesos de cartas são limitados entre `[0.1, 50.0]` com um decaimento proporcional para evitar saturação, garantindo que o modelo continue adaptável a mudanças no metagame.
4. **Cache em Memória**: O serviço `modelLearningService` utiliza um cache em memória com TTL de 60s para os pesos das cartas, reduzindo drasticamente a carga no banco de dados durante a geração em massa de decks.
5. **Simulação Estocástica**: A simulação de partidas (`ModelEvaluator`) incorpora variância de draws para evitar winrates triviais de 100%, forçando a IA a construir decks mais consistentes e resilientes.

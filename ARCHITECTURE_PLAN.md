# MTG Deck Engine MVP - Arquitetura Detalhada

## Visão Geral

O MVP é uma aplicação web full-stack para geração e análise de decks competitivos de Magic: The Gathering. A arquitetura combina análise de dados (embeddings, grafos, clustering) com uma interface intuitiva para jogadores e analistas.

## Stack Tecnológico

| Camada | Tecnologia | Justificativa |
|--------|-----------|--------------|
| Frontend | React 19 + Tailwind 4 | UI responsiva, componentes reutilizáveis |
| Backend | Express + tRPC | Type-safe RPC, fácil integração com frontend |
| Banco de Dados | MySQL | Armazenamento de cartas, decks, metadados |
| ML/Análise | Python (worker isolado) | Word2Vec, KMeans, grafos NetworkX |
| Integração | Scryfall API | Dados oficiais de cartas MTG |

## Arquitetura de Componentes

### 1. Data Layer (Backend)

**Tabelas Principais:**
- `cards`: Catálogo de cartas (id, name, cmc, type, colors, rarity, scryfall_id)
- `decks`: Decks importados/gerados (id, name, format, archetype, user_id)
- `deck_cards`: Relação many-to-many (deck_id, card_id, quantity)
- `card_synergies`: Grafo de sinergia pré-calculado (card1_id, card2_id, weight, co_occurrence)
- `meta_stats`: Estatísticas de frequência (card_id, format, win_rate, play_rate, archetype)
- `embeddings_cache`: Vetores Word2Vec em cache (card_id, vector_json)

### 2. Backend Services

#### A. Scryfall Integration (`server/services/scryfall.ts`)
- Sincronização de catálogo de cartas
- Busca por nome, tipo, cores, CMC
- Cache de imagens e dados

#### B. Synergy Engine (`server/services/synergy.ts`)
- Construção de grafo de co-ocorrência
- Cálculo de pesos baseado em frequência
- Endpoints para consultar sinergia entre cartas

#### C. Embeddings Service (`server/services/embeddings.ts`)
- Treino de Word2Vec em background
- Cache de vetores
- Busca de cartas similares por similaridade coseno

#### D. Clustering Service (`server/services/clustering.ts`)
- KMeans para identificar arquétipos
- Classificação de decks por padrão
- Análise de diversidade meta

#### E. Deck Generator (`server/services/deckGenerator.ts`)
- Geração inicial baseada em arquétipos
- Otimização por simulação simplificada
- Validação de regras MTG (60 cards min, 4 cópias max, etc)

#### F. Meta Analytics (`server/services/metaAnalytics.ts`)
- Agregação de estatísticas
- Tendências de formato
- Recomendações de tech choices

### 3. Frontend Architecture

#### Pages
- **Home**: Landing com resumo de meta
- **CardSearch**: Busca avançada de cartas com filtros
- **DeckBuilder**: Editor interativo de decks
- **DeckGenerator**: Gerador automático com opções de arquétipos
- **SynergyGraph**: Visualização interativa de grafo
- **MetaDashboard**: Estatísticas e tendências
- **DeckExport**: Exportação em múltiplos formatos

#### Components
- `CardCard`: Exibição de carta individual
- `DeckList`: Tabela de cartas no deck
- `SynergyVisualization`: Grafo D3/Cytoscape
- `ArchetypeSelector`: Seletor de arquétipos
- `MetaChart`: Gráficos de frequência/win-rate

### 4. Data Flow

```
1. Sincronização Inicial
   Scryfall API → cards table → embeddings cache

2. Geração de Deck
   User selects archetype
   → Fetch similar cards (embeddings)
   → Build synergy graph
   → Generate initial deck
   → Simulate matches (RL)
   → Return optimized deck

3. Meta Updates
   Background job (daily)
   → Fetch tournament results
   → Update meta_stats
   → Recalculate synergies
   → Retrain embeddings
```

## Funcionalidades MVP

### Fase 1: Core (Essencial)
- [x] Schema de banco de dados
- [ ] Integração Scryfall (busca básica)
- [ ] Busca de cartas com filtros
- [ ] Visualização de cartas
- [ ] Gerador de decks simples (por arquétipos pré-definidos)
- [ ] Exportação de decks (texto)

### Fase 2: Análise (Importante)
- [ ] Motor de sinergia (grafo de co-ocorrência)
- [ ] Embeddings Word2Vec
- [ ] Visualização de grafo interativa
- [ ] Dashboard de meta (top decks, frequência)
- [ ] Clustering de arquétipos

### Fase 3: Otimização (Avançado)
- [ ] Simulação de partidas (RL simplificado)
- [ ] Otimização de deck
- [ ] Importação de decks competitivos
- [ ] Visualizações artísticas
- [ ] Integração com APIs de torneios

## Decisões de Design

1. **Python Worker Isolado**: Operações de ML (embeddings, clustering) rodam em worker Python separado, chamado via tRPC. Frontend não acessa diretamente.

2. **Cache Agressivo**: Embeddings e grafos são pré-calculados e cacheados. Atualizações em background.

3. **Validação de Regras**: Todas as restrições MTG (60 cards, 4 cópias, etc) validadas no backend.

4. **Formato Agnóstico**: Suporte para Standard, Modern, Commander (regras diferentes por formato).

5. **Visualizações Interativas**: Grafos usam Cytoscape.js para performance com 1000+ nós.

## Próximos Passos

1. Criar schema Drizzle
2. Implementar integração Scryfall
3. Construir endpoints de busca
4. Desenvolver frontend de busca
5. Implementar motor de sinergia
6. Integrar visualizações

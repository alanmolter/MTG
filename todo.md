# MTG Deck Engine MVP - TODO

## Fase 1: Core Essencial

### Backend
- [x] Criar schema Drizzle (cards, decks, deck_cards, synergies, meta_stats)
- [x] Implementar integração Scryfall (fetch cards, cache)
- [x] Criar endpoints de busca de cartas (name, type, colors, cmc)
- [x] Implementar validação de regras MTG
- [x] Criar endpoints de CRUD para decks

### Frontend
- [x] Design system e tema visual (dark/light)
- [x] Página Home com resumo
- [x] Página CardSearch com filtros avançados
- [x] Componente CardCard para exibição
- [ ] Página DeckBuilder com editor
- [x] Exportação de decks (texto simples)

### Testes
- [x] Testes de validação de regras MTG
- [ ] Testes de busca de cartas
- [ ] Testes de CRUD de decks

## Fase 2: Análise e Sinergia

### Backend
- [x] Implementar motor de sinergia (grafo co-ocorrência)
- [x] Implementar Word2Vec embeddings (versão simplificada)
- [x] Criar endpoints para busca de cartas similares
- [ ] Implementar clustering KMeans para arquétipos
- [ ] Dashboard de meta (top cards, frequência)

### Frontend
- [ ] Página SynergyGraph com visualização interativa
- [ ] Página MetaDashboard com gráficos
- [x] Seletor de arquétipos
- [ ] Visualização de estatísticas de meta

### Testes
- [ ] Testes de motor de sinergia
- [x] Testes de embeddings
- [ ] Testes de clustering

## Fase 3: Otimização e Avançado

### Backend
- [x] Implementar gerador de decks com RL simplificado
- [ ] Importador de decks competitivos
- [ ] Integração com APIs de torneios (MTGTop8, MTGGoldfish)
- [ ] Visualizações artísticas de decks

### Frontend
- [x] Página DeckGenerator com opções de otimização
- [ ] Visualizações artísticas de decks
- [ ] Compartilhamento de decks

### Testes
- [ ] Testes de gerador de decks
- [ ] Testes de importador

## Bugs e Melhorias Futuras
- [ ] Integração com dados reais de Scryfall (seed inicial)
- [ ] Implementar clustering KMeans real
- [ ] Otimizar busca de cartas com índices de banco de dados
- [ ] Adicionar visualização de grafos Cytoscape
- [ ] Integrar APIs de torneios (MTGTop8, MTGGoldfish)
- [ ] Implementar compartilhamento de decks
- [ ] Adicionar análise de meta por formato


## Fase 4: Integração com Dados Reais (Nova)

### Backend
- [x] Criar job de sincronização com Scryfall API (busca por formato/cores)
- [ ] Implementar importador de decks reais (Moxfield/MTGGoldfish)
- [ ] Treinar embeddings automaticamente com dados reais
- [ ] Atualizar grafo de sinergia com dados competitivos
- [x] Criar endpoint de sincronização manual

### Frontend
- [x] Página de status de sincronização
- [x] Indicador de última atualização de dados
- [x] Filtro por formato competitivo

### Testes
- [x] Testes de sincronização com Scryfall
- [ ] Testes de importação de decks
- [ ] Testes de treino de embeddings

## Fase 5: Pipeline Moxfield + Embeddings + Geração (Nova)

### Backend
- [x] Scraper de decks do Moxfield (API pública + fallback HTML)
- [x] Salvar decks importados no banco (competitive_decks, competitive_deck_cards)
- [x] Treinamento automático de embeddings Word2Vec com co-ocorrência real
- [x] Endpoint tRPC para geração de decks
- [ ] Job de re-treinamento agendado (cron)

### Frontend
- [x] Página Pipeline (importação + treinamento + geração em um fluxo)
- [x] Painel de treinamento de embeddings (status, progresso, histórico)
- [x] Botão de execução individual de cada etapa

### Testes
- [x] Testes do scraper Moxfield (11 testes)
- [x] Testes de treinamento de embeddings (14 testes)
- [x] 50 testes passando no total

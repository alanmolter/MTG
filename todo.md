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
- [x] Página DeckBuilder com editor
- [x] Exportação de decks (texto simples)

### Testes
- [x] Testes de validação de regras MTG
- [x] Testes de busca de cartas
- [x] Testes de CRUD de decks

## Fase 2: Análise e Sinergia

### Backend
- [x] Implementar motor de sinergia (grafo co-ocorrência)
- [x] Implementar Word2Vec embeddings (versão simplificada)
- [x] Criar endpoints para busca de cartas similares
- [x] Implementar clustering KMeans para arquétipos
- [ ] Dashboard de meta (top cards, frequência)

### Frontend
- [x] Página SynergyGraph com visualização interativa
- [ ] Página MetaDashboard com gráficos
- [x] Seletor de arquétipos
- [ ] Visualização de estatísticas de meta

### Testes
- [x] Testes de motor de sinergia
- [x] Testes de embeddings
- [x] Testes de clustering

## Fase 3: Otimização e Avançado

### Backend
- [x] Implementar gerador de decks com RL simplificado
- [x] Importador de decks competitivos
- [x] Integração com APIs de torneios (MTGTop8, MTGGoldfish)
- [x] Visualizações artísticas de decks

### Frontend
- [x] Página DeckGenerator com opções de otimização
- [x] Visualizações artísticas de decks
- [x] Compartilhamento de decks

### Testes
- [x] Testes de gerador de decks
- [x] Testes de importador

## Bugs e Melhorias Futuras
- [x] Integração com dados reais de Scryfall (seed inicial)
- [x] Implementar clustering KMeans real
- [x] Otimizar busca de cartas com índices de banco de dados
- [x] Adicionar visualização de grafos Cytoscape
- [x] Integrar APIs de torneios (MTGTop8, MTGGoldfish)
- [x] Implementar compartilhamento de decks
- [x] Adicionar análise de meta por formato


## Fase 4: Integração com Dados Reais (Nova)

### Backend
- [x] Criar job de sincronização com Scryfall API (busca por formato/cores)
- [x] Implementar importador de decks reais (Moxfield/MTGGoldfish)
- [x] Treinar embeddings automaticamente com dados reais
- [x] Atualizar grafo de sinergia com dados competitivos
- [x] Criar endpoint de sincronização manual

### Frontend
- [x] Página de status de sincronização
- [x] Indicador de última atualização de dados
- [x] Filtro por formato competitivo

### Testes
- [x] Testes de sincronização com Scryfall
- [x] Testes de importação de decks
- [x] Testes de treino de embeddings

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

## Fase 6: Game Feature Engine + RL Melhorado

### Backend
- [x] Engine de features de jogo (is_creature, is_removal, is_draw, is_ramp, is_token, etc.)
- [x] Score de curva de mana ideal (IDEAL_CURVE calibrado por arquétipo: aggro/burn/tempo/midrange/control/ramp/combo)
- [x] Score de proporção de terrenos (land_ratio_score por arquétipo)
- [x] Score de sinergia por mecânica (mechanic_tags + tag stacking com recompensa exponencial)
- [x] Simulação de turnos 1-6 (flood/screw/curva detection, 20 iterações)
- [x] Função evaluate_deck composta (curve + land + synergy + simulation)
- [x] RL melhorado com hill-climbing guiado por features (200 iterações)
- [x] Calibração automática com médias dos decks reais do banco

### Frontend
- [x] Painel de métricas do deck gerado (score breakdown visual)
- [x] Gráfico de curva de mana (barras por CMC com contagem)
- [x] Exibição de tags mecânicas das cartas com badges coloridos
- [x] Score total e componentes (curve/land/synergy/simulation com barras)
- [x] Toggle de RL Optimization na UI
- [x] Exportação Arena + texto
- [x] Lista de deck agrupada por tipo (Creatures/Spells/Lands)

### Testes
- [x] 26 testes da Game Feature Engine (extractCardFeatures, manaCurveScore, landRatioScore, mechanicSynergyScore, simulateTurns, evaluateDeck, calibrateFromRealDecks)
- [x] 76 testes passando no total em 7 arquivos

## Fase 7: Gerador por Arquétipo com Filtros Avançados

### Backend
- [x] archetypeGenerator.ts: templates ARCHETYPES (aggro/control/combo/midrange/ramp/burn/tempo)
- [x] Classificador de cartas por função (classify_card com tags)
- [x] Filtro avançado por cor, tribo e tipo (filter_cards)
- [x] Score por arquétipo (score_card com prioridades + curva + CMC)
- [x] Gerador principal: lands → creatures → spells por slot
- [x] Suporte a formatos (standard/historic/commander/legacy/modern/pioneer)
- [x] Endpoint tRPC generator.generateByArchetype com parâmetros completos

### Frontend
- [x] Filtros de cor (W/U/B/R/G com ícones de mana)
- [x] Filtro de tribo (Elf, Goblin, Zombie, Human, Dragon, etc.)
- [x] Filtro de tipo (creature, instant, sorcery, enchantment, artifact)
- [x] Seletor de formato atualizado (standard/historic/commander/legacy/modern)
- [x] Preview do template do arquétipo (slots esperados: lands/creatures/spells)
- [x] Integração com métricas da Game Feature Engine

### Testes
- [x] Testes do archetypeGenerator
- [x] Testes dos filtros avançados
- [x] Testes do scoring por arquétipo

## Fase 8: Maturidade de Produção & Features Avançadas

### 💡 Lógica Financeira e Geração de Budget Decks
- [ ] Buscar e sincronizar preços (ex: `prices.usd`) utilizando a API/Bulk da Scryfall
- [ ] Ajustar tabela de `cards` para persistir dados de valor
- [ ] Criar input de "Orçamento Máximo ($)" no frontend do Gerador de Arquétipos
- [ ] Ajustar algorítmo de seleção para priorizar boas cartas dentro do orçamento (Pauper/Budget)

### 🧩 Geração Avançada de Sideboard
- [ ] Implementar motor de análise das "fraquezas" do Mainboard gerado
- [ ] Adicionar pontuação/seleção automática de 15 cartas de Sideboard complementares
- [ ] Priorizar tags como `hate`, `counter` e `removal` específicos baseadas na pool de cor do deck
- [ ] Atualizar script de export (`exportToArena` e `exportToText`) para exibir corretamente a lista de Sideboard

### 🌐 Autenticação, Perfis e Database em Nuvem
- [ ] Configurar conexão do banco de dados para produção num host real (Supabase, Neon, AWS, Render)
- [ ] Implementar sistema de Autenticação/Usuários (Clerk, Auth.js, Firebase)
- [ ] Interface para o usuário listar "Meus Decks Salvos" com botões de "Editar" e "Favoritar"

### ⚙️ Pipelines e Automação Contínua (Cron Jobs)
- [ ] Modularizar scraper competitivos (`populate-moxfield.ts`, `mtgtop8Scraper.ts`) para rodar em intervalos
- [ ] Modularizar pipeline do Oracle Bulk (`sync-bulk.ts`) para injetar novas coleções periodicamente
- [ ] Configurar agendadores (ex: Node-cron, GitHub Actions ou workers no Render) para orquestrar essas execuções de madrugada sem intervenção manual

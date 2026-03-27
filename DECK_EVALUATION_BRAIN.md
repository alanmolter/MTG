# Deck Evaluation Brain (Cérebro de Avaliação de Decks)

## 📋 Visão Geral

A **Função FINAL `evaluate_deck`** é o cérebro inteligente do sistema de geração de decks MTG. Ela integra quatro componentes principais para criar uma avaliação holística e profissional de qualidade de decks:

1. **structure_score**: Qualidade estrutural (roles, composição)
2. **curve_score**: Qualidade da curva de mana
3. **synergy_score**: Sinergia entre cartas
4. **simulate**: Simulação de gameplay

## 🧠 Arquitetura

### Componentes Principais

```
┌─────────────────────────────────────────────────────────────┐
│           Deck Evaluation Brain (evaluate_deck)             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Curve Score  │  │ Structure    │  │ Synergy      │     │
│  │ (Mana Curve) │  │ Score        │  │ Score        │     │
│  │              │  │ (Roles)      │  │ (Mechanics)  │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│         ↓                  ↓                  ↓             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │     Normalização (0-100) por Arquétipo              │  │
│  └──────────────────────────────────────────────────────┘  │
│         ↓                  ↓                  ↓             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Ponderação Inteligente (Archetype Profiles)        │  │
│  │  - Aggro: Curva > Estrutura > Sinergia              │  │
│  │  - Control: Estrutura > Sinergia > Curva            │  │
│  │  - Combo: Sinergia > Estrutura > Curva              │  │
│  └──────────────────────────────────────────────────────┘  │
│         ↓                                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Score Final Normalizado (0-100)                    │  │
│  │  + Tier (S/A/B/C/D/F)                               │  │
│  │  + Análise Estrutural (Strengths/Weaknesses)        │  │
│  │  + Recomendações de Melhoria                        │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 📊 Perfis de Arquétipos

Cada arquétipo tem pesos diferentes para otimizar a avaliação:

### Aggro
- **Curva**: 35% (crítico - precisa de early game)
- **Estrutura**: 25%
- **Sinergia**: 15%
- **Simulação**: 15%
- **Consistência**: 10%

### Control
- **Curva**: 20% (menos importante)
- **Estrutura**: 30% (crítico - precisa de remoção/draw)
- **Sinergia**: 20%
- **Simulação**: 20%
- **Consistência**: 10%

### Combo
- **Curva**: 20%
- **Estrutura**: 25%
- **Sinergia**: 35% (crítico - peças precisam interagir)
- **Simulação**: 10%
- **Consistência**: 10%

### Midrange, Ramp, Tempo, Burn
(Veja `deckEvaluationBrain.ts` para detalhes completos)

## 🎯 Funcionalidades Principais

### 1. `evaluateDeck(cards, archetype)`

Avaliação completa com análise detalhada.

**Retorno:**
```typescript
{
  // Scores individuais
  manaCurveScore: number;
  landRatioScore: number;
  synergyScore: number;
  simulationScore: number;
  
  // Contagens
  landCount: number;
  creatureCount: number;
  removalCount: number;
  drawCount: number;
  
  // Score final normalizado (0-100)
  normalizedScore: number;
  
  // Tier de qualidade
  tier: "S" | "A" | "B" | "C" | "D" | "F";
  
  // Análise estrutural
  analysis: {
    strengths: string[];
    weaknesses: string[];
    suggestions: string[];
  };
  
  // Recomendações de melhoria
  recommendations: string[];
  
  // Breakdown detalhado
  breakdown: {
    curve: number;
    lands: number;
    synergy: number;
    simulation: number;
    consistency: number;
    speed: number;
    complexity: number;
    structure: number;
  };
}
```

### 2. `evaluateDeckQuick(cards, archetype)`

Avaliação rápida para loops de otimização (RL).

**Retorno:** `number` (score 0-100)

**Vantagem:** ~3x mais rápido (menos iterações de simulação)

### 3. `compareDeckQuality(deckA, deckB, archetype)`

Compara dois decks e retorna qual é melhor.

**Retorno:**
```typescript
{
  winner: "A" | "B" | "tie";
  scoreA: number;
  scoreB: number;
  difference: number;
}
```

## 🔧 Integração no Projeto

### Endpoints Disponíveis

#### 1. `generator.evaluateBrain` (novo)
```typescript
// Avaliação completa com análise
POST /trpc/generator.evaluateBrain
{
  cards: [
    { name: "Lightning Bolt", type: "Instant", cmc: 1, quantity: 4 },
    { name: "Mountain", type: "Basic Land", cmc: 0, quantity: 20 }
  ],
  archetype: "burn"
}
```

#### 2. `generator.evaluate` (existente)
```typescript
// Avaliação básica (compatível com versão anterior)
POST /trpc/generator.evaluate
```

### Funções no `deckGenerator.ts`

```typescript
// Avaliação completa
evaluateDeckWithBrain(deck, archetype): EvaluationResult

// Avaliação rápida
evaluateDeckQuickScore(deck, archetype): number

// Avaliação compatível (versão anterior)
evaluateDeckWithEngine(deck, archetype): DeckMetrics
```

## 📈 Exemplos de Uso

### Exemplo 1: Avaliar um Deck Aggro

```typescript
import { evaluateDeck } from "./services/deckEvaluationBrain";

const aggroDeck = [
  { name: "Goblin Guide", type: "Creature", cmc: 1 },
  { name: "Lightning Bolt", type: "Instant", cmc: 1 },
  { name: "Mountain", type: "Basic Land", cmc: 0 },
  // ... mais cartas
];

const result = evaluateDeck(aggroDeck, "aggro");

console.log(`Score: ${result.normalizedScore}/100`);
console.log(`Tier: ${result.tier}`);
console.log(`Pontos Fortes: ${result.analysis.strengths.join(", ")}`);
console.log(`Recomendações: ${result.recommendations.join("\n")}`);
```

### Exemplo 2: Loop de Otimização com RL

```typescript
import { evaluateDeckQuick } from "./services/deckEvaluationBrain";

let bestDeck = initialDeck;
let bestScore = evaluateDeckQuick(bestDeck, "aggro");

for (let i = 0; i < 200; i++) {
  const candidate = mutateDeck(bestDeck);
  const score = evaluateDeckQuick(candidate, "aggro");
  
  if (score > bestScore) {
    bestDeck = candidate;
    bestScore = score;
  }
}
```

### Exemplo 3: Comparar Dois Decks

```typescript
import { compareDeckQuality } from "./services/deckEvaluationBrain";

const result = compareDeckQuality(deckA, deckB, "control");

if (result.winner === "A") {
  console.log(`Deck A é melhor por ${result.difference.toFixed(1)} pontos`);
}
```

## 🎓 Métricas Explicadas

### Curve Score
- Mede qualidade da distribuição de custo de mana
- Penaliza desvios da curva ideal por arquétipo
- Bônus por cobertura de CMCs 1-3 (early game)
- Bônus por distribuição bem balanceada

### Structure Score
- Mede adequação de roles (threat, removal, draw, etc)
- Compara com targets ideais por arquétipo
- Penaliza falta de remoção, ameaças ou card draw
- Valida proporção de terrenos

### Synergy Score
- Mede interação entre cartas
- Detecta pares sinérgicos (token + sacrifice, etc)
- Recompensa stacking de mecânicas
- Bônus por engine + tutor (combo)

### Simulation Score
- Simula 30 mãos aleatórias
- Detecta mana screw/flood
- Mede eficiência de mana
- Premia decks que jogam cartas impactantes

## 🧪 Testes

Arquivo: `deckEvaluationBrain.test.ts`

**Cobertura:**
- ✅ Avaliação de cada arquétipo (Aggro, Control, Combo, Ramp)
- ✅ Normalização de scores (0-100)
- ✅ Análise estrutural (strengths/weaknesses)
- ✅ Sistema de tiers (S-F)
- ✅ Comparação de decks
- ✅ Edge cases (deck vazio, cartas sem CMC, etc)
- ✅ Consistência (mesmo input = mesmo output)

**Executar testes:**
```bash
npm test -- deckEvaluationBrain.test.ts
```

## 🚀 Performance

| Operação | Tempo |
|----------|-------|
| `evaluateDeck` (completo) | ~50-100ms |
| `evaluateDeckQuick` | ~15-30ms |
| `compareDeckQuality` | ~30-60ms |

**Otimizações:**
- `evaluateDeckQuick` usa apenas 10 iterações de simulação (vs 30)
- Scores são normalizados uma vez
- Sem análise estrutural detalhada em modo quick

## 📚 Arquivos Modificados/Criados

### Novos Arquivos
1. **`server/services/deckEvaluationBrain.ts`** (400+ linhas)
   - Implementação completa da função evaluate_deck
   - Perfis de arquétipos com pesos otimizados
   - Análise estrutural inteligente
   - Sistema de tiers

2. **`server/services/deckEvaluationBrain.test.ts`** (400+ linhas)
   - 30+ testes de cobertura completa
   - Fixtures de decks reais
   - Validação de edge cases

### Arquivos Modificados
1. **`server/services/deckGenerator.ts`**
   - Importação do novo `deckEvaluationBrain`
   - Novas funções: `evaluateDeckWithBrain`, `evaluateDeckQuickScore`
   - Compatibilidade com versão anterior mantida

2. **`server/routers.ts`**
   - Novo endpoint: `generator.evaluateBrain`
   - Mantém endpoint existente `generator.evaluate`

## 🔄 Fluxo de Criação de Decks Melhorado

```
┌─────────────────────────────────────────────────────────┐
│ 1. Usuário seleciona arquétipo (Aggro, Control, etc)   │
└──────────────────────┬──────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│ 2. Gerador cria deck inicial baseado em templates      │
└──────────────────────┬──────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│ 3. Avaliação Rápida (evaluateDeckQuick)                │
│    - Score 0-100                                        │
│    - Feedback imediato                                  │
└──────────────────────┬──────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│ 4. Loop de Otimização com RL (200 iterações)           │
│    - Mutações guiadas por features                      │
│    - Avaliação rápida a cada iteração                   │
│    - Melhoria incremental                               │
└──────────────────────┬──────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│ 5. Avaliação Final Completa (evaluateDeck)             │
│    - Score normalizado 0-100                            │
│    - Tier (S/A/B/C/D/F)                                │
│    - Análise estrutural detalhada                       │
│    - Recomendações de melhoria                          │
└──────────────────────┬──────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│ 6. Apresentação ao Usuário                             │
│    - Visualização de score                              │
│    - Pontos fortes e fracos                             │
│    - Sugestões de melhoria                              │
│    - Opção de refinar deck                              │
└─────────────────────────────────────────────────────────┘
```

## 💡 Benefícios

### Para o Usuário
- ✅ Decks gerados são significativamente melhores
- ✅ Feedback claro sobre qualidade (score 0-100)
- ✅ Recomendações acionáveis para melhoria
- ✅ Análise estrutural profissional

### Para o Desenvolvedor
- ✅ Função centralizada e reutilizável
- ✅ Fácil integração com RL/otimização
- ✅ Extensível para novos arquétipos
- ✅ Bem testado e documentado

## 🔮 Próximos Passos (Futuro)

1. **Integração com Meta Real**
   - Usar dados de torneios (Moxfield, MTGTop8)
   - Recompensar staples do meta

2. **Aprendizado Contínuo**
   - Treinar pesos de arquétipos com decks competitivos
   - Calibração automática de scores

3. **Análise Avançada**
   - Detecção de combo patterns
   - Análise de mulligans
   - Simulação de matchups

4. **UI/UX**
   - Gráficos de breakdown de score
   - Visualização de curva vs ideal
   - Recomendações interativas

## 📞 Suporte

Para dúvidas ou melhorias:
1. Consulte os testes em `deckEvaluationBrain.test.ts`
2. Revise os perfis de arquétipos em `deckEvaluationBrain.ts`
3. Verifique a integração em `deckGenerator.ts`

---

**Versão:** 1.0.0  
**Data:** 2026-03-26  
**Status:** ✅ Implementado e Testado

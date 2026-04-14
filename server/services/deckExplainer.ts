/**
 * Deck Explainer
 *
 * Gera uma explicação rica e legível da estratégia de um deck MTG:
 *   - Visão geral da estratégia
 *   - Sinergias chave entre cartas
 *   - Condições de vitória
 *   - Sequência de jogo (early/mid/late)
 *   - Cartas mais importantes e seus papéis
 *
 * Usa Claude (se ANTHROPIC_API_KEY disponível) ou fallback rule-based.
 */

import { detectWinConditions } from "./gameFeatureEngine";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CardForExplanation {
  name: string;
  type?: string | null;
  text?: string | null;
  cmc?: number | null;
  quantity: number;
}

export interface KeySynergy {
  cards: string[];
  description: string;
  type: "combo" | "value" | "protection" | "engine" | "theme";
}

export interface DeckExplanation {
  deckStyle: string;
  strategyOverview: string;
  keySynergies: KeySynergy[];
  winConditions: string[];
  playSequence: {
    early: string;
    mid: string;
    late: string;
  };
  keyCards: { name: string; role: string }[];
  source: "llm" | "rule-based";
}

// ─── LLM Explainer ────────────────────────────────────────────────────────────

function buildExplainerPrompt(
  cards: CardForExplanation[],
  archetype: string,
  format: string
): string {
  // Cards únicos + oracle text truncado
  const uniqueCards = new Map<string, CardForExplanation>();
  for (const c of cards) {
    if (!uniqueCards.has(c.name)) uniqueCards.set(c.name, c);
  }

  const cardList = Array.from(uniqueCards.values())
    .filter((c) => !c.type?.toLowerCase().includes("land"))
    .slice(0, 60)
    .map((c) => {
      const qty = c.quantity > 1 ? `${c.quantity}x ` : "";
      const text = c.text ? c.text.slice(0, 120).replace(/\n/g, " ") : "";
      return `${qty}${c.name} [CMC:${c.cmc ?? "?"}] — ${text}`;
    })
    .join("\n");

  return `Você é um especialista em Magic: The Gathering com profundo conhecimento de mecânicas, sinergias e teoria de jogo.

DECK: ${format.toUpperCase()} — Arquétipo: ${archetype}

CARTAS DO DECK (não-terrenos):
${cardList}

TAREFA:
Analise TODAS as cartas acima e gere uma explicação detalhada e precisa do deck. Identifique:
1. Como as cartas trabalham JUNTAS — não descreva cartas isoladamente
2. Quais são as sinergias mecânicas reais entre as cartas listadas
3. Como o deck GANHA (condições de vitória específicas baseadas nas cartas)
4. A sequência ideal de jogadas por fase do jogo
5. As cartas mais importantes e por quê

RESPONDA APENAS em JSON válido, sem markdown ou texto adicional:
{
  "deckStyle": "uma frase curta tipo 'Aggro de Criatura Haste', 'Controle de Counterspell', 'Combo Infinito'",
  "strategyOverview": "3-5 frases explicando o plano geral do deck baseado nas cartas reais",
  "keySynergies": [
    {
      "cards": ["Carta A", "Carta B"],
      "description": "explicação específica de como essas cartas se combinam mecanicamente",
      "type": "combo|value|protection|engine|theme"
    }
  ],
  "winConditions": [
    "condição de vitória 1 — descreva o estado do jogo que leva à vitória",
    "condição de vitória 2 (se houver)"
  ],
  "playSequence": {
    "early": "turnos 1-3: o que fazer com essas cartas específicas",
    "mid": "turnos 4-6: como desenvolver a estratégia com essas cartas",
    "late": "turnos 7+: como fechar o jogo com essas cartas"
  },
  "keyCards": [
    { "name": "Nome Exato da Carta", "role": "por que essa carta é fundamental no deck" }
  ]
}

IMPORTANTE: Use apenas os nomes das cartas que aparecem na lista acima. Seja específico sobre interações mecânicas. Máximo 5 sinergias e 5 key cards.`;
}

async function callAnthropicForExplanation(
  prompt: string
): Promise<Omit<DeckExplanation, "source"> | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      content: { type: string; text: string }[];
    };
    const text = data.content?.[0]?.text ?? "";

    // Parse JSON (pode ter markdown wrapper)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]) as Omit<DeckExplanation, "source">;
  } catch {
    return null;
  }
}

// ─── Rule-Based Fallback ───────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  removal: "Remoção",
  draw: "Compra de cartas",
  ramp: "Aceleração de mana",
  tutor: "Buscador de peças",
  counterspell: "Contramágica",
  token: "Gerador de tokens",
  sacrifice: "Motor de sacrifício",
  graveyard: "Recurso do cemitério",
  haste: "Ameaça de haste",
  flying: "Criatura voadora",
  lifegain: "Ganho de vida",
};

const ARCHETYPE_STYLE: Record<string, string> = {
  aggro: "Aggro — Pressão rápida com criaturas pequenas",
  burn: "Burn — Dano direto ao oponente",
  tempo: "Tempo — Criaturas eficientes + respostas baratas",
  midrange: "Midrange — Ameaças versáteis de médio porte",
  control: "Controle — Negação e vantagem de cartas",
  ramp: "Ramp — Aceleração de mana + ameaças grandes",
  combo: "Combo — Peças que criam loops ou ganho imediato",
};

const ARCHETYPE_SEQUENCES: Record<
  string,
  { early: string; mid: string; late: string }
> = {
  aggro: {
    early:
      "Jogue criaturas de 1-2 mana com evasão ou haste. Aplique pressão imediata atacando todo turno.",
    mid: "Mantenha o board com criaturas e use feitiços de dano direto para limpar bloqueadores ou reduzir vida do oponente.",
    late: "Feche o jogo com feitiços de dano direto ou efeitos de haste. Evite entrar em jogo longo.",
  },
  burn: {
    early: "Use mágicas de dano de 1-2 mana para reduzir a vida do oponente rapidamente.",
    mid: "Combine dano direto com criaturas com haste para maximizar o dano por turno.",
    late: "Feche com feitiços de dano que atingem o oponente diretamente. 20 de dano em 4-5 turnos é o objetivo.",
  },
  control: {
    early: "Segure mana aberto para contramágicas e remoção barata. Evite desenvolver o board.",
    mid: "Estabilize com sweepers e compre cartas. Estabeleça vantagem de cartas permanente.",
    late: "Jogue sua win condition protegida por counterspells. Cada spell do oponente deve ter resposta.",
  },
  midrange: {
    early: "Jogue ramp e criaturas pequenas de alta eficiência. Responda às ameaças do oponente.",
    mid: "Desenvolva criaturas versáteis que ganham vantagem — draw, remoção ou tokens.",
    late: "Domine o board com criaturas maiores. Sua vantagem de recursos deve superar o oponente.",
  },
  ramp: {
    early: "Priorize todas as fontes de ramp. Jogue mana rocks e criaturas de ramp antes de tudo.",
    mid: "Use o mana extra para jogar ameaças muito acima da curva do oponente.",
    late: "Uma ou duas criaturas gigantes ou spells de alto impacto devem encerrar o jogo.",
  },
  combo: {
    early: "Desenvolva mana, jogue peças do combo e busque tutors para encontrar o restante.",
    mid: "Proteja suas peças com counterspells ou respostas. Monte o combo no momento certo.",
    late: "Execute o combo quando tiver proteção suficiente. Uma única abertura pode encerrar o jogo.",
  },
  tempo: {
    early: "Jogue criaturas eficientes de 1-2 mana e mantenha mana para responses.",
    mid: "Ataque com criaturas enquanto usa bounce e counterspells para atrasar o oponente.",
    late: "Suas criaturas com evasão devem ter fechado o jogo antes do oponente estabilizar.",
  },
};

function buildRuleBasedExplanation(
  cards: CardForExplanation[],
  archetype: string
): DeckExplanation {
  const winResult = detectWinConditions(
    cards.map((c) => ({ name: c.name, type: c.type, text: c.text }))
  );

  // Contagem de papéis funcionais
  const roleCounts: Record<string, string[]> = {};
  for (const card of cards) {
    const text = (card.text || "").toLowerCase();
    const type = (card.type || "").toLowerCase();
    if (text.includes("destroy") || text.includes("exile") || text.includes("damage") && text.includes("target creature")) {
      (roleCounts["removal"] ??= []).push(card.name);
    }
    if (text.includes("draw") && text.includes("card")) {
      (roleCounts["draw"] ??= []).push(card.name);
    }
    if (text.includes("search your library") && !text.includes("basic land")) {
      (roleCounts["tutor"] ??= []).push(card.name);
    }
    if (text.includes("add {") || (text.includes("add") && text.includes("mana"))) {
      (roleCounts["ramp"] ??= []).push(card.name);
    }
    if (text.includes("counter target")) {
      (roleCounts["counterspell"] ??= []).push(card.name);
    }
    if (type.includes("creature") && text.includes("haste")) {
      (roleCounts["haste"] ??= []).push(card.name);
    }
    if (type.includes("creature") && text.includes("flying")) {
      (roleCounts["flying"] ??= []).push(card.name);
    }
    if (text.includes("token")) {
      (roleCounts["token"] ??= []).push(card.name);
    }
    if (text.includes("graveyard")) {
      (roleCounts["graveyard"] ??= []).push(card.name);
    }
  }

  // Sinergias detectadas rule-based
  const synergies: KeySynergy[] = [];
  if (roleCounts["token"] && roleCounts["sacrifice"]) {
    synergies.push({
      cards: [...(roleCounts["token"] ?? []).slice(0, 2), ...(roleCounts["sacrifice"] ?? []).slice(0, 1)],
      description: "Geração de tokens alimenta o motor de sacrifício para vantagem contínua de mana ou cartas",
      type: "engine",
    });
  }
  if (roleCounts["tutor"] && roleCounts["draw"]) {
    synergies.push({
      cards: [...(roleCounts["tutor"] ?? []).slice(0, 1), ...(roleCounts["draw"] ?? []).slice(0, 1)],
      description: "Tutors buscam as peças certas enquanto card draw mantém a mão cheia de opções",
      type: "value",
    });
  }
  if (roleCounts["ramp"] && roleCounts["haste"]) {
    synergies.push({
      cards: [...(roleCounts["ramp"] ?? []).slice(0, 1), ...(roleCounts["haste"] ?? []).slice(0, 1)],
      description: "Ramp permite jogar criaturas com haste muito antes do esperado, criando pressão imediata",
      type: "engine",
    });
  }
  if (roleCounts["counterspell"] && roleCounts["draw"]) {
    synergies.push({
      cards: [...(roleCounts["counterspell"] ?? []).slice(0, 1), ...(roleCounts["draw"] ?? []).slice(0, 1)],
      description: "Counterspells protegem a estratégia enquanto card draw garante sempre ter respostas na mão",
      type: "protection",
    });
  }
  if (roleCounts["graveyard"]) {
    synergies.push({
      cards: (roleCounts["graveyard"] ?? []).slice(0, 2),
      description: "Cartas com recursão do cemitério criam vantagem de recursos ao longo do jogo",
      type: "value",
    });
  }

  // Key cards — mais impactantes por CMC
  const nonLands = cards
    .filter((c) => !c.type?.toLowerCase().includes("land"))
    .sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0));
  const keyCards = nonLands.slice(0, 5).map((c) => {
    const text = (c.text || "").toLowerCase();
    let role = "Ameaça principal";
    if (text.includes("search your library")) role = "Buscador de peças chave";
    else if (text.includes("draw") && text.includes("card")) role = "Motor de card draw";
    else if (text.includes("counter target")) role = "Proteção via counterspell";
    else if (text.includes("destroy") || text.includes("exile")) role = "Remoção versátil";
    else if (text.includes("add {")) role = "Aceleração de mana";
    else if (text.includes("haste")) role = "Ameaça de resposta imediata";
    else if (text.includes("flying")) role = "Ameaça de dano aéreo";
    return { name: c.name, role };
  });

  // Win conditions
  const winConditions: string[] = [];
  if (winResult.types.includes("combo_engine")) {
    winConditions.push(...winResult.details.filter((d) => d.includes("Named combo") || d.includes("tutor")));
  }
  if (winResult.types.includes("aggro_damage")) winConditions.push("Dano direto — reduzir vida do oponente para 0 com criaturas e feitiços de dano");
  if (winResult.types.includes("alternate_win")) winConditions.push("Condição alternativa de vitória via efeito de carta");
  if (winResult.types.includes("mill_win")) winConditions.push("Mill — forçar o oponente a comprar de um deck vazio");
  if (winResult.types.includes("poison_win")) winConditions.push("10 contadores de veneno via criaturas com infect");
  if (winConditions.length === 0) winConditions.push("Dominância do board — vença no combate com mais criaturas ou mais eficientes");

  // Texto da estratégia
  const topRoles = Object.entries(roleCounts)
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, 3)
    .map(([role]) => ROLE_LABELS[role] || role);

  const archLower = archetype.toLowerCase();
  const styleKey = Object.keys(ARCHETYPE_STYLE).find((k) => archLower.includes(k)) ?? "midrange";
  const sequence = ARCHETYPE_SEQUENCES[styleKey] ?? ARCHETYPE_SEQUENCES.midrange;

  const overview = `Deck ${ARCHETYPE_STYLE[styleKey] ?? archetype}. ` +
    `Conta com ${cards.filter((c) => !c.type?.toLowerCase().includes("land")).reduce((s, c) => s + c.quantity, 0)} cartas não-terrenos. ` +
    (topRoles.length > 0 ? `As principais funções são: ${topRoles.join(", ")}. ` : "") +
    (winResult.hasWinCondition ? `Condição de vitória identificada: ${winConditions[0]}.` : "Estratégia baseada em dominância de board.");

  return {
    deckStyle: ARCHETYPE_STYLE[styleKey] ?? archetype,
    strategyOverview: overview,
    keySynergies: synergies.slice(0, 5),
    winConditions,
    playSequence: sequence,
    keyCards,
    source: "rule-based",
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Gera explicação do deck. Usa Claude se API key disponível, senão rule-based.
 */
export async function explainDeck(
  cards: CardForExplanation[],
  archetype: string,
  format: string
): Promise<DeckExplanation> {
  // Sempre tenta LLM primeiro
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const prompt = buildExplainerPrompt(cards, archetype, format);
      const llmResult = await callAnthropicForExplanation(prompt);
      if (llmResult) {
        return { ...llmResult, source: "llm" };
      }
    } catch {
      // fall through to rule-based
    }
  }

  return buildRuleBasedExplanation(cards, archetype);
}

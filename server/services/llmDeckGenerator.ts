/**
 * LLM Deck Generator
 *
 * Integra um LLM (Claude) como GERADOR DE CANDIDATOS no pipeline de construção
 * de decks MTG. O LLM entende o oracle_text das cartas e raciocina sobre sinergia,
 * enquanto a stack existente (Forge validator + meta_stats scorer) valida e ranqueia.
 *
 * Pipeline:
 *   User Input → [LLM Generator] → [Constraint Validator] → [Meta Scorer] → Deck Final
 *
 * Requer: variável de ambiente ANTHROPIC_API_KEY
 * Node 22+ usa fetch nativo — sem dependências extras necessárias.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { cards, competitiveDecks, metaStats } from "../../drizzle/schema";
import { getDb } from "../db";
import { validateDeck } from "./deckGenerator";
import { modelLearningService } from "./modelLearning";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface CardWithStats {
  name: string;
  cmc: number | null;
  type: string | null;
  oracle_text: string | null;
  win_rate: number | null;
  play_rate: number | null;
}

export interface LLMDeckCard {
  name: string;
  quantity: number;
  reason: string;
}

export interface LLMDeckResult {
  mainboard: LLMDeckCard[];
  strategy: string;
}

export interface GenerateWithLLMParams {
  format: "Standard" | "Commander" | "Modern" | "Pioneer";
  archetype: "Aggro" | "Midrange" | "Control" | "Combo" | "Ramp";
  commander?: string;
}

export interface EnrichedDeckCard extends LLMDeckCard {
  learnedWeight: number;
  isValid: boolean;
}

export interface LLMGeneratorOutput {
  deck: EnrichedDeckCard[];
  strategy: string;
  validation: {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  };
  candidatePoolSize: number;
  metaContext: string;
}

// ---------------------------------------------------------------------------
// Prompt Engineering
// ---------------------------------------------------------------------------

function buildDeckPrompt(params: {
  format: string;
  archetype: string;
  commander?: string;
  candidateCards: CardWithStats[];
  metaContext: string;
}): string {
  const deckSize = params.format === "Commander" ? 99 : 60;

  const cardList = params.candidateCards
    .slice(0, 150) // LLM não precisa de mais que 150 candidatas
    .map((c) => {
      const wr = c.win_rate != null ? `WR:${c.win_rate}%` : "WR:?";
      const pr = c.play_rate != null ? `PR:${c.play_rate}%` : "PR:?";
      const text = c.oracle_text ? `"${c.oracle_text.slice(0, 80)}"` : "";
      return `${c.name} | CMC:${c.cmc ?? "?"} | ${c.type ?? "?"} | ${wr} | ${pr} | ${text}`;
    })
    .join("\n");

  const commanderBlock = params.commander
    ? `COMMANDER: ${params.commander}\n`
    : "";

  const commanderRules =
    params.format === "Commander"
      ? `- Inclua ~35 terrenos, ~10 ramp, ~10 card draw
- Respeite a identidade de cor do commander
- Singleton: máximo 1 cópia de cada carta (exceto terrenos básicos)`
      : `- Monte uma curva de mana coerente (4× de cada carta não-terreno)
- Inclua entre 20-24 terrenos`;

  return `Você é um especialista em Magic: The Gathering competitivo.

FORMATO: ${params.format}
ARQUÉTIPO: ${params.archetype}
${commanderBlock}
CONTEXTO DO METAGAME (arquétipos dominantes):
${params.metaContext || "Meta não disponível — use julgamento próprio"}

CARTAS DISPONÍVEIS (pré-filtradas do metagame atual, com estatísticas reais):
${cardList}

TAREFA:
Monte um deck ${params.format} de ${deckSize} cartas otimizado para o arquétipo ${params.archetype}.

REGRAS OBRIGATÓRIAS:
- Use APENAS cartas exatamente como listadas acima (nomes exatos)
- Monte uma curva de mana coerente com o arquétipo
- Priorize cartas com win_rate alto quando houver empate de sinergia
${commanderRules}

RESPONDA APENAS em JSON válido, sem texto adicional, markdown ou comentários:
{
  "mainboard": [
    { "name": "Nome Exato da Carta", "quantity": 1, "reason": "motivo em 1 frase" }
  ],
  "strategy": "descrição em 2 frases da estratégia do deck"
}`;
}

// ---------------------------------------------------------------------------
// Chamada à API da Anthropic (fetch nativo — Node 22+)
// ---------------------------------------------------------------------------

async function callAnthropicAPI(prompt: string): Promise<LLMDeckResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY não configurada. Adicione ao arquivo .env para usar o gerador LLM."
    );
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Anthropic API error ${response.status}: ${errorText}`
    );
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const raw =
    data.content[0]?.type === "text" ? data.content[0].text : "";

  // Limpar possíveis blocos de código markdown no output
  const clean = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

  try {
    return JSON.parse(clean) as LLMDeckResult;
  } catch {
    throw new Error(
      `Falha ao parsear JSON da resposta LLM. Raw output: ${raw.slice(0, 300)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Busca de candidatas do banco de dados
// ---------------------------------------------------------------------------

async function fetchCandidateCards(
  format: string,
  commander?: string
): Promise<CardWithStats[]> {
  const db = await getDb();
  if (!db) {
    console.warn("[LLMGenerator] Banco de dados não disponível — usando pool vazio");
    return [];
  }

  // Normalizar formato para o schema (lowercase no DB)
  const dbFormat = format.toLowerCase();

  try {
    const rows = await db
      .select({
        name: cards.name,
        cmc: cards.cmc,
        type: cards.type,
        oracle_text: cards.text,       // coluna "text" no schema = oracle_text
        win_rate: metaStats.winRate,
        play_rate: metaStats.playRate,
      })
      .from(cards)
      .leftJoin(metaStats, and(
        eq(metaStats.cardId, cards.id),
        eq(metaStats.format, dbFormat)
      ))
      .orderBy(desc(metaStats.playRate))
      .limit(200);

    // Se commander especificado, incluir a carta commander no topo
    if (commander) {
      const commanderRow = rows.find(
        (r) => r.name.toLowerCase() === commander.toLowerCase()
      );
      if (!commanderRow) {
        console.warn(`[LLMGenerator] Commander "${commander}" não encontrado no pool`);
      }
    }

    return rows;
  } catch (error) {
    console.error("[LLMGenerator] Erro ao buscar candidatas:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Busca do contexto do metagame
// ---------------------------------------------------------------------------

async function fetchMetaContext(format: string): Promise<string> {
  const db = await getDb();
  if (!db) return "";

  try {
    const dbFormat = format.toLowerCase();
    const topDecks = await db
      .select({ archetype: competitiveDecks.archetype, name: competitiveDecks.name })
      .from(competitiveDecks)
      .where(and(
        eq(competitiveDecks.format, dbFormat),
        eq(competitiveDecks.isSynthetic, false)
      ))
      .limit(8);

    if (topDecks.length === 0) return "Sem dados de metagame disponíveis no banco";

    const archetypeSet = new Set(topDecks.map((d) => d.archetype).filter(Boolean));
    const archetypes = Array.from(archetypeSet);
    return archetypes.join(", ") || topDecks.map((d) => d.name).slice(0, 5).join(", ");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Enriquecimento com pesos aprendidos (cardLearning)
// ---------------------------------------------------------------------------

async function enrichWithLearnedWeights(
  llmCards: LLMDeckCard[]
): Promise<EnrichedDeckCard[]> {
  const weights = await modelLearningService.getCardWeights();

  return llmCards.map((card) => ({
    ...card,
    learnedWeight: weights[card.name] ?? 1.0,
    isValid: true, // validação de regras feita separadamente
  }));
}

// ---------------------------------------------------------------------------
// Função Principal: generateDeckWithLLM
// ---------------------------------------------------------------------------

export async function generateDeckWithLLM(
  params: GenerateWithLLMParams
): Promise<LLMGeneratorOutput> {
  const { format, archetype, commander } = params;

  console.log(`[LLMGenerator] Iniciando geração — Formato: ${format}, Arquétipo: ${archetype}`);

  // 1. Buscar candidatas do banco (não do LLM)
  const candidates = await fetchCandidateCards(format, commander);
  console.log(`[LLMGenerator] Pool de candidatas: ${candidates.length} cartas`);

  // 2. Buscar contexto do metagame
  const metaContext = await fetchMetaContext(format);

  // 3. Construir prompt e chamar o LLM
  const prompt = buildDeckPrompt({
    format,
    archetype,
    commander,
    candidateCards: candidates,
    metaContext,
  });

  console.log(`[LLMGenerator] Chamando Anthropic API (claude-opus-4-5)...`);
  const llmResult = await callAnthropicAPI(prompt);

  // 4. Enriquecer cartas do LLM com dados reais do banco antes de validar
  const db = await getDb();
  const llmNames = llmResult.mainboard.map((c) => c.name);
  const realCardsData = db
    ? await db.select().from(cards).where(inArray(cards.name, llmNames)).catch(() => [])
    : [];
  const realCardMap = new Map(realCardsData.map((c) => [c.name.toLowerCase(), c]));

  const cardsForValidation = llmResult.mainboard.map((c) => {
    const real = realCardMap.get(c.name.toLowerCase());
    return {
      id: real?.id ?? 0,
      scryfallId: real?.scryfallId ?? "",
      oracleId: null,
      name: c.name,
      type: real?.type ?? null,
      colors: real?.colors ?? null,
      cmc: real?.cmc ?? null,
      rarity: real?.rarity ?? null,
      imageUrl: real?.imageUrl ?? null,
      power: real?.power ?? null,
      toughness: real?.toughness ?? null,
      text: real?.text ?? null,
      priceUsd: null,
      isArena: real?.isArena ?? 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      quantity: c.quantity,
    };
  });

  const dbFormat = format.toLowerCase() as
    | "standard"
    | "modern"
    | "commander"
    | "legacy";
  const validation = validateDeck(cardsForValidation, dbFormat);

  if (!validation.isValid) {
    console.warn(
      `[LLMGenerator] Deck com erros de validação: ${validation.errors.join("; ")}`
    );
  }

  // 5. Enriquecer com pesos aprendidos (Meta Scorer)
  const enriched = await enrichWithLearnedWeights(llmResult.mainboard);

  // Ordenar por peso aprendido (cartas mais validadas pela IA primeiro)
  enriched.sort((a, b) => b.learnedWeight - a.learnedWeight);

  console.log(
    `[LLMGenerator] Deck gerado com ${enriched.length} entradas únicas. Estratégia: ${llmResult.strategy}`
  );

  return {
    deck: enriched,
    strategy: llmResult.strategy,
    validation,
    candidatePoolSize: candidates.length,
    metaContext,
  };
}

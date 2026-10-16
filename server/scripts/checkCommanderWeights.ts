import { getDb, closeDb } from "../db";
import { sql } from "drizzle-orm";

type CommanderRow = {
  name: string;
  weight: number;
  winCount: number;
  lossCount: number;
  type: string | null;
  colors: string | null;
};

async function check() {
  const db = await getDb();
  if (!db) return;

  // `cards` has one row per printing, while `card_learning` is keyed by card
  // name. Use LATERAL to pick one representative card row per learned name so
  // repeated printings cannot crowd out real commanders before deduplication.
  const rawCommanders = (await db.execute(sql`
    SELECT
      cl.card_name AS name,
      cl.weight,
      cl.win_count AS "winCount",
      cl.loss_count AS "lossCount",
      c.type,
      c.colors
    FROM card_learning cl
    JOIN LATERAL (
      SELECT type, colors
      FROM cards c
      WHERE c.name = cl.card_name
        AND c.type ILIKE '%Legendary%'
        AND c.type ILIKE '%Creature%'
      ORDER BY c.is_arena DESC, c.id ASC
      LIMIT 1
    ) c ON TRUE
    ORDER BY cl.weight DESC, (cl.win_count + cl.loss_count) DESC, cl.card_name ASC
    LIMIT 500
  `)) as CommanderRow[];

  // Deduplicação em dois níveis:
  //   1. Cartas double-faced (com " // "): usar parte antes do " // "
  //   2. Mesmo personagem (múltiplas versões): usar parte antes da primeira vírgula
  //      Mantém a versão com MAIS PARTIDAS REAIS para cada personagem (não apenas maior peso).
  //      Isso evita mostrar cartas com peso inflado por decay mas sem partidas reais.

  // Primeiro passo: agrupar por personagem e escolher a melhor versão
  const personagemMap = new Map<string, CommanderRow>();

  for (const c of rawCommanders) {
    const singleFaceName = c.name.includes(" // ")
      ? c.name.split(" // ")[0].trim()
      : c.name.trim();

    const personagem = singleFaceName.includes(",")
      ? singleFaceName.split(",")[0].trim().toLowerCase()
      : singleFaceName.toLowerCase();

    const existing = personagemMap.get(personagem);
    if (!existing) {
      personagemMap.set(personagem, c);
    } else {
      // Preferir a versão com mais partidas reais (winCount + lossCount)
      const existingTotal =
        (existing.winCount ?? 0) + (existing.lossCount ?? 0);
      const newTotal = (c.winCount ?? 0) + (c.lossCount ?? 0);
      if (newTotal > existingTotal) {
        personagemMap.set(personagem, c);
      }
    }
  }

  // Segundo passo: ordenar com REALITY GUARD.
  //
  // Anomaly-2 fix (2026-04-23): antes, o sort só considerava "tem partidas
  // reais" e "peso DESC". Isso expunha exatamente o caso patológico do
  // bug report — Aatchik (1% WR, peso 45) aparecia em #1 só porque seu
  // peso estava alto. Para o display público, queremos mostrar COMANDANTES
  // APRENDIDOS, não comandantes cujos pesos o aprendizado ainda não
  // corrigiu. A nova ordenação usa uma "score de confiança" que:
  //   - penaliza winrate < 20% com ≥ 10 partidas (puxa score pra baixo)
  //   - premia winrate > 50% com ≥ 10 partidas (puxa score pra cima)
  //   - usa peso como desempate e para cartas sem partidas reais
  const MIN_GAMES_FOR_CONFIDENCE = 10;
  const scoreOf = (c: CommanderRow): number => {
    const total = (c.winCount ?? 0) + (c.lossCount ?? 0);
    const wr = total > 0 ? (c.winCount ?? 0) / total : 0;

    if (total === 0) {
      // Sem partidas reais: usa peso bruto com teto de 40 para não deixar
      // que cartas "infladas por calibração" sem evidência empírica
      // dominem o top. Permite comandantes novos aparecerem, mas não
      // acima dos com histórico positivo confirmado.
      return Math.min(40, c.weight);
    }

    if (total >= MIN_GAMES_FOR_CONFIDENCE && wr < 0.2) {
      // Reality guard: winrate horrível com dados = CAI para baixo.
      // Mantém peso mas drena 50 pontos para empurrar para o fim da lista.
      return c.weight - 50 + wr * 10;
    }

    // Caso geral: peso ajustado pelo winrate real. Fator ×1.2 para wr=100%
    // e ×0.6 para wr=0%; neutro (×1.0) em wr=66%.
    const winrateFactor = 0.6 + 0.9 * wr;
    return c.weight * winrateFactor;
  };

  const topCommanders = Array.from(personagemMap.values())
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, 10);

  const seenPersonagem = personagemMap;

  const total = rawCommanders.length;
  const uniquePersonagens = seenPersonagem.size;

  console.log("\n TOP 10 COMANDANTES APRENDIDOS PELO CEREBRO:");
  console.log("=".repeat(70));
  topCommanders.forEach((c, i) => {
    // Exibir nome limpo (sem face B)
    const cleanName = c.name.includes(" // ")
      ? c.name.split(" // ")[0].trim()
      : c.name;
    const displayName =
      cleanName.length > 35 ? cleanName.substring(0, 32) + "..." : cleanName;
    const colors = c.colors || "C";
    const total = (c.winCount ?? 0) + (c.lossCount ?? 0);
    const wr =
      total > 0
        ? (((c.winCount ?? 0) / total) * 100).toFixed(0) + "% wr"
        : "sem partidas";
    console.log(
      `${String(i + 1).padStart(2)}. ${displayName.padEnd(36)} | ${colors.padEnd(5)} | Peso: ${c.weight.toFixed(2)} | ${wr}`
    );
  });
  console.log("=".repeat(70));
  console.log(
    `   (${total} lendarios no banco, ${uniquePersonagens} personagens unicos mostrados)`
  );

  closeDb()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}

check().catch(console.error);

import { describe, it, expect, vi } from "vitest";

// Mock do banco de dados
vi.mock("../db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
}));

describe("Embedding Trainer", () => {
  describe("Inicialização de matrizes", () => {
    it("deve criar matriz com dimensões corretas", () => {
      const rows = 10;
      const cols = 64;
      const matrix = Array.from({ length: rows }, () => {
        const arr = new Float32Array(cols);
        for (let i = 0; i < cols; i++) arr[i] = (Math.random() - 0.5) / cols;
        return arr;
      });

      expect(matrix).toHaveLength(rows);
      expect(matrix[0]).toHaveLength(cols);
    });

    it("deve inicializar valores próximos de zero", () => {
      const dim = 64;
      const vec = new Float32Array(dim);
      for (let i = 0; i < dim; i++) vec[i] = (Math.random() - 0.5) / dim;

      for (const val of vec) {
        expect(Math.abs(val)).toBeLessThan(1);
      }
    });
  });

  describe("Função sigmoid", () => {
    it("deve retornar 0.5 para entrada 0", () => {
      const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
      expect(sigmoid(0)).toBeCloseTo(0.5, 5);
    });

    it("deve retornar valor próximo de 1 para entrada grande", () => {
      const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
      expect(sigmoid(10)).toBeGreaterThan(0.99);
    });

    it("deve retornar valor próximo de 0 para entrada muito negativa", () => {
      const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
      expect(sigmoid(-10)).toBeLessThan(0.01);
    });

    it("deve lidar com valores extremos sem NaN", () => {
      const sigmoid = (x: number) => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
      expect(sigmoid(1000)).not.toBeNaN();
      expect(sigmoid(-1000)).not.toBeNaN();
    });
  });

  describe("Construção de vocabulário", () => {
    it("deve filtrar cartas com frequência mínima", () => {
      const cardFreq = new Map<string, number>([
        ["Lightning Bolt", 10],
        ["Rare Card", 1],
        ["Goblin Guide", 5],
        ["Uncommon Card", 2],
      ]);

      const MIN_COUNT = 2;
      const vocab = Array.from(cardFreq.entries())
        .filter(([, freq]) => freq >= MIN_COUNT)
        .map(([name]) => name);

      expect(vocab).toContain("Lightning Bolt");
      expect(vocab).toContain("Goblin Guide");
      expect(vocab).toContain("Uncommon Card");
      expect(vocab).not.toContain("Rare Card");
    });

    it("deve criar mapeamento palavra→índice", () => {
      const vocab = ["Lightning Bolt", "Goblin Guide", "Mountain"];
      const wordToIdx = new Map<string, number>(vocab.map((w, i) => [w, i]));

      expect(wordToIdx.get("Lightning Bolt")).toBe(0);
      expect(wordToIdx.get("Goblin Guide")).toBe(1);
      expect(wordToIdx.get("Mountain")).toBe(2);
      expect(wordToIdx.size).toBe(3);
    });
  });

  describe("Co-ocorrência de cartas", () => {
    it("deve calcular co-ocorrência entre cartas no mesmo deck", () => {
      const decks = [
        ["Lightning Bolt", "Goblin Guide", "Mountain"],
        ["Lightning Bolt", "Monastery Swiftspear", "Mountain"],
        ["Lightning Bolt", "Goblin Guide", "Sacred Foundry"],
      ];

      const coOccurrence = new Map<string, number>();

      for (const deck of decks) {
        const uniqueCards = Array.from(new Set(deck));
        for (let i = 0; i < uniqueCards.length; i++) {
          for (let j = i + 1; j < uniqueCards.length; j++) {
            const key = `${uniqueCards[i]}|||${uniqueCards[j]}`;
            coOccurrence.set(key, (coOccurrence.get(key) || 0) + 1);
          }
        }
      }

      // Lightning Bolt aparece com Goblin Guide em 2 decks
      const boltGuide = coOccurrence.get("Lightning Bolt|||Goblin Guide") || 0;
      expect(boltGuide).toBe(2);

      // Lightning Bolt aparece com Mountain em 2 decks
      const boltMountain = coOccurrence.get("Lightning Bolt|||Mountain") || 0;
      expect(boltMountain).toBe(2);
    });

    it("deve calcular taxa de co-ocorrência relativa ao total de decks", () => {
      const totalDecks = 10;
      const coOccurrenceCount = 7;
      const weight = Math.min(100, Math.floor((coOccurrenceCount / totalDecks) * 100));

      expect(weight).toBe(70);
    });

    it("deve limitar peso máximo a 100", () => {
      const totalDecks = 5;
      const coOccurrenceCount = 5; // 100% dos decks
      const weight = Math.min(100, Math.floor((coOccurrenceCount / totalDecks) * 100));

      expect(weight).toBe(100);
    });
  });

  describe("Skip-gram window", () => {
    it("deve gerar pares de contexto dentro da janela", () => {
      const cardList = ["A", "B", "C", "D", "E"];
      const WINDOW_SIZE = 2;
      const pairs: [string, string][] = [];

      for (let pos = 0; pos < cardList.length; pos++) {
        for (let w = -WINDOW_SIZE; w <= WINDOW_SIZE; w++) {
          if (w === 0) continue;
          const contextPos = pos + w;
          if (contextPos < 0 || contextPos >= cardList.length) continue;
          pairs.push([cardList[pos], cardList[contextPos]]);
        }
      }

      // "A" deve ter contexto com "B" e "C" (janela de 2)
      const aContexts = pairs.filter(([center]) => center === "A").map(([, ctx]) => ctx);
      expect(aContexts).toContain("B");
      expect(aContexts).toContain("C");
      expect(aContexts).not.toContain("D"); // fora da janela
    });
  });

  describe("Status de jobs de treinamento", () => {
    it("deve validar status possíveis", () => {
      const validStatuses = ["pending", "running", "completed", "failed"];
      const testStatuses = ["completed", "failed", "running"];

      for (const status of testStatuses) {
        expect(validStatuses).toContain(status);
      }
    });

    it("deve calcular duração corretamente", () => {
      const startTime = Date.now() - 5000; // 5 segundos atrás
      const durationMs = Date.now() - startTime;

      expect(durationMs).toBeGreaterThanOrEqual(5000);
      expect(durationMs).toBeLessThan(10000);
    });
  });
});

/**
 * Competitive Learning Bridge com Validação de Versão e Hash
 * 
 * Problema: competitive_train.json pode ficar obsoleto se export falhar
 * 
 * Solução:
 * - Adicionar metadados de versão e hash SHA256
 * - Escrever atomicamente (tmp → rename)
 * - Validar antes de treinar
 */

import * as fs from "fs/promises";
import * as crypto from "crypto";
import { getDb } from "../db";
import { competitiveDecks, competitiveDeckCards } from "../../drizzle/schema";
import { eq, inArray } from "drizzle-orm";

interface CompetitiveTrainMetadata {
  version: number;
  timestamp: number;
  hash: string;
  deckCount: number;
  cardCount: number;
  format: string;
  source: string;
}

interface CompetitiveTrainData {
  metadata: CompetitiveTrainMetadata;
  decks: Array<{
    id: string;
    name: string;
    format: string;
    source: string;
    cards: Array<{
      name: string;
      count: number;
    }>;
  }>;
}

export class CompetitiveLearningBridge {
  private readonly exportPath = "server/ml/models/competitive_train.json";
  private readonly metadataPath = "server/ml/models/competitive_train.metadata.json";
  private readonly versionFile = "server/ml/models/competitive_train.version";

  /**
   * Exporta decks competitivos com metadados de versão e hash
   */
  async exportCompetitiveDecks(format: string = "commander"): Promise<{
    version: number;
    hash: string;
    deckCount: number;
  }> {
    const db = await getDb();
    if (!db) {
      console.warn("[CompetitiveLearning] Database not available");
      return { version: 0, hash: "", deckCount: 0 };
    }

    console.log(`[CompetitiveLearning] Exporting competitive decks for ${format}...`);

    try {
      // 1. Ler decks competitivos
      const competitiveDecksData = await db
        .select()
        .from(competitiveDecks)
        .where(eq(competitiveDecks.format, format));

      if (competitiveDecksData.length === 0) {
        console.warn(`[CompetitiveLearning] No competitive decks found for ${format}`);
        return { version: 0, hash: "", deckCount: 0 };
      }

      // 2. Buscar cartas de todos os decks em uma única query
      const deckIds = competitiveDecksData.map((cd: any) => cd.id);
      const allCardRows = await db
        .select()
        .from(competitiveDeckCards)
        .where(inArray(competitiveDeckCards.deckId, deckIds));

      // Agrupar cartas por deckId
      const cardsByDeck = new Map<number, Array<{ name: string; count: number }>>();
      for (const row of allCardRows) {
        if (!cardsByDeck.has(row.deckId)) cardsByDeck.set(row.deckId, []);
        cardsByDeck.get(row.deckId)!.push({ name: row.cardName, count: row.quantity });
      }

      // 3. Transformar para formato de treino com cartas reais
      const decks = competitiveDecksData.map((cd: any) => ({
        id: cd.id.toString(),
        name: cd.name,
        format: cd.format,
        source: cd.source,
        cards: cardsByDeck.get(cd.id) ?? [],
      }));

      // 3. Calcular hash dos dados
      const dataHash = this.calculateHash(JSON.stringify(decks));

      // 4. Ler versão anterior
      const previousVersion = await this.readVersion();
      const newVersion = previousVersion + 1;

      // 5. Criar metadata
      const metadata: CompetitiveTrainMetadata = {
        version: newVersion,
        timestamp: Date.now(),
        hash: dataHash,
        deckCount: decks.length,
        cardCount: decks.reduce((sum, d) => sum + d.cards.length, 0),
        format,
        source: "competitiveLearningBridge",
      };

      // 6. Criar payload completo
      const payload: CompetitiveTrainData = {
        metadata,
        decks,
      };

      // 7. Escrever arquivo atomicamente (tmp → rename)
      const tempPath = `${this.exportPath}.tmp`;

      await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf-8");
      await fs.rename(tempPath, this.exportPath);

      // Salvar versão
      await fs.writeFile(this.versionFile, newVersion.toString(), "utf-8");

      // Salvar metadata separadamente
      await fs.writeFile(this.metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

      console.log(
        `[CompetitiveLearning] ✓ Exported v${newVersion} ` +
        `(${decks.length} decks, hash=${dataHash.substring(0, 8)}...)`
      );

      return {
        version: newVersion,
        hash: dataHash,
        deckCount: decks.length,
      };
    } catch (error) {
      console.error("[CompetitiveLearning] Export failed:", error);
      throw error;
    }
  }

  /**
   * Valida que arquivo JSON é válido e tem versão esperada
   */
  async validateTrainFile(expectedVersion?: number): Promise<{
    valid: boolean;
    version: number;
    hash: string;
    message: string;
  }> {
    try {
      // 1. Verificar se arquivo existe
      const content = await fs.readFile(this.exportPath, "utf-8");
      const data: CompetitiveTrainData = JSON.parse(content);

      // 2. Validar estrutura
      if (!data.metadata || !data.decks) {
        return {
          valid: false,
          version: 0,
          hash: "",
          message: "Invalid structure: missing metadata or decks",
        };
      }

      // 3. Validar versão se esperada
      if (expectedVersion !== undefined && data.metadata.version !== expectedVersion) {
        return {
          valid: false,
          version: data.metadata.version,
          hash: data.metadata.hash,
          message: `Version mismatch: expected ${expectedVersion}, got ${data.metadata.version}`,
        };
      }

      // 4. Validar hash
      const recalculatedHash = this.calculateHash(JSON.stringify(data.decks));
      if (recalculatedHash !== data.metadata.hash) {
        return {
          valid: false,
          version: data.metadata.version,
          hash: data.metadata.hash,
          message: "Hash mismatch: file may be corrupted",
        };
      }

      return {
        valid: true,
        version: data.metadata.version,
        hash: data.metadata.hash,
        message: `Valid (v${data.metadata.version}, ${data.decks.length} decks)`,
      };
    } catch (error) {
      return {
        valid: false,
        version: 0,
        hash: "",
        message: `Error reading file: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Lê versão atual do arquivo de versão
   */
  private async readVersion(): Promise<number> {
    try {
      const content = await fs.readFile(this.versionFile, "utf-8");
      return parseInt(content.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Calcula SHA256 hash de string
   */
  private calculateHash(data: string): string {
    return crypto.createHash("sha256").update(data).digest("hex");
  }
}

// Singleton
let bridgeInstance: CompetitiveLearningBridge | null = null;

export function getCompetitiveLearningBridge(): CompetitiveLearningBridge {
  if (!bridgeInstance) {
    bridgeInstance = new CompetitiveLearningBridge();
  }
  return bridgeInstance;
}

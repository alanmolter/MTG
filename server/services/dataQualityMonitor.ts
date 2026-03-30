/**
 * Data Quality Monitor
 * 
 * Problema: Fallback sintético do Moxfield polui embeddings
 * 
 * Solução:
 * - Marcar dados com flags isSynthetic e dataConfidence
 * - Filtrar em embeddingTrainer.ts
 * - Auditoria de qualidade
 */

import { getDb } from "../db";

export interface DataQualityMetrics {
  source: string;
  totalDecks: number;
  syntheticDecks: number;
  syntheticPercentage: number;
  dataConfidence: number;
  notes: string;
}

export class DataQualityMonitor {
  /**
   * Analisa qualidade de dados por fonte
   */
  async analyzeDataQuality(): Promise<{
    bySource: Map<string, DataQualityMetrics>;
    summary: {
      totalDecks: number;
      syntheticDecks: number;
      avgConfidence: number;
      warnings: string[];
    };
  }> {
    const db = await getDb();
    if (!db) {
      console.warn("[DataQuality] Database not available");
      return {
        bySource: new Map(),
        summary: {
          totalDecks: 0,
          syntheticDecks: 0,
          avgConfidence: 0,
          warnings: [],
        },
      };
    }

    try {
      // 1. Ler todos os decks competitivos
      const allDecks = await db.query.competitiveDecks.findMany();

      // 2. Agrupar por fonte
      const bySource = new Map<string, DataQualityMetrics>();
      let totalSynthetic = 0;
      let totalConfidence = 0;

      for (const deck of allDecks) {
        const source = deck.source || "unknown";

        if (!bySource.has(source)) {
          bySource.set(source, {
            source,
            totalDecks: 0,
            syntheticDecks: 0,
            syntheticPercentage: 0,
            dataConfidence: 1.0,
            notes: "",
          });
        }

        const metrics = bySource.get(source)!;
        metrics.totalDecks++;

        // Assumindo que decks têm campos isSynthetic e dataConfidence
        // (Se não existem, usar defaults)
        const isSynthetic = (deck as any).isSynthetic || false;
        const confidence = (deck as any).dataConfidence || 1.0;

        if (isSynthetic) {
          metrics.syntheticDecks++;
          totalSynthetic++;
        }

        totalConfidence += confidence;
      }

      // 3. Calcular percentuais
      for (const metrics of bySource.values()) {
        metrics.syntheticPercentage =
          metrics.totalDecks > 0
            ? (metrics.syntheticDecks / metrics.totalDecks) * 100
            : 0;
        metrics.dataConfidence =
          metrics.totalDecks > 0
            ? totalConfidence / metrics.totalDecks
            : 1.0;
      }

      // 4. Gerar warnings
      const warnings: string[] = [];

      if (totalSynthetic / allDecks.length > 0.2) {
        warnings.push(
          `HIGH: ${((totalSynthetic / allDecks.length) * 100).toFixed(1)}% synthetic data`
        );
      }

      const avgConfidence = totalConfidence / allDecks.length;
      if (avgConfidence < 0.8) {
        warnings.push(`MEDIUM: Average confidence ${avgConfidence.toFixed(2)} is low`);
      }

      console.log("[DataQuality] ✓ Analysis complete");
      console.log(`  Total decks: ${allDecks.length}`);
      console.log(`  Synthetic: ${totalSynthetic} (${((totalSynthetic / allDecks.length) * 100).toFixed(1)}%)`);
      console.log(`  Avg confidence: ${avgConfidence.toFixed(2)}`);

      return {
        bySource,
        summary: {
          totalDecks: allDecks.length,
          syntheticDecks: totalSynthetic,
          avgConfidence,
          warnings,
        },
      };
    } catch (error) {
      console.error("[DataQuality] Error analyzing data:", error);
      throw error;
    }
  }

  /**
   * Retorna recomendações baseado em qualidade
   */
  async getRecommendations(): Promise<string[]> {
    const analysis = await this.analyzeDataQuality();
    const recommendations: string[] = [];

    if (analysis.summary.warnings.length > 0) {
      recommendations.push("⚠️  Data quality issues detected:");
      recommendations.push(...analysis.summary.warnings);
    }

    if (analysis.summary.syntheticDecks > 0) {
      recommendations.push(
        `Retrain embeddings excluding ${analysis.summary.syntheticDecks} synthetic decks`
      );
    }

    if (analysis.summary.avgConfidence < 0.8) {
      recommendations.push("Import more real decks from MTGGoldfish/MTGTop8");
    }

    return recommendations;
  }
}

// Singleton
let monitorInstance: DataQualityMonitor | null = null;

export function getDataQualityMonitor(): DataQualityMonitor {
  if (!monitorInstance) {
    monitorInstance = new DataQualityMonitor();
  }
  return monitorInstance;
}

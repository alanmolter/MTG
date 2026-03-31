import { getDb } from "../db";
import { competitiveDecks, competitiveDeckCards, CompetitiveDeck, CompetitiveDeckCard, cards } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { getCardEmbedding } from "./embeddings";

export interface DeckVector {
  deckId: number;
  vector: number[];
  colors: string;
  format: string;
  cardCount: number;
  creatureRatio: number;    // proporção de criaturas no deck
  instantSorceryRatio: number; // proporção de instants+sorceries
  avgCmc: number;           // custo de mana médio
}

export interface ClusterResult {
  clusterId: number;
  deckIds: number[];
  centroid: number[];
  archetype: string;
  confidence: number;
  avgColors: string;
  avgCardCount: number;
  intraClusterDistance: number;
  interClusterDistance: number;
}

export interface ClusteringStats {
  silhouetteScore: number;
  calinskiHarabaszIndex: number;
  daviesBouldinIndex: number;
  inertia: number;
  converged: boolean;
}

/**
 * Converte um deck competitivo para um vetor numérico usando embeddings das cartas.
 * Agora também coleta creatureRatio, instantSorceryRatio e avgCmc para classificação.
 */
export async function deckToVector(deckId: number): Promise<DeckVector | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const deck = await db
      .select()
      .from(competitiveDecks)
      .where(eq(competitiveDecks.id, deckId))
      .limit(1);

    if (deck.length === 0) return null;

    const deckCards = await db
      .select()
      .from(competitiveDeckCards)
      .where(and(
        eq(competitiveDeckCards.deckId, deckId),
        eq(competitiveDeckCards.section, "mainboard")
      ));

    if (deckCards.length === 0) return null;

    const cardVectors: number[][] = [];
    let totalQuantity = 0;
    const colorSet = new Set<string>();
    let creatureCount = 0;
    let instantSorceryCount = 0;
    let totalCmc = 0;
    let cmcCards = 0;

    for (const deckCard of deckCards) {
      const card = await db
        .select()
        .from(cards)
        .where(eq(cards.name, deckCard.cardName))
        .limit(1);

      if (card.length > 0) {
        // Coletar cores das cartas
        if (card[0].colors) {
          card[0].colors.split("").forEach(c => {
            if ("WUBRG".includes(c)) colorSet.add(c);
          });
        }

        // Coletar tipo para classificação de archetype
        const typeLine = (card[0].type || "").toLowerCase();
        if (typeLine.includes("creature")) {
          creatureCount += deckCard.quantity;
        }
        if (typeLine.includes("instant") || typeLine.includes("sorcery")) {
          instantSorceryCount += deckCard.quantity;
        }

        // Coletar CMC
        const cmc = card[0].cmc ?? 0;
        if (cmc > 0) {
          totalCmc += cmc * deckCard.quantity;
          cmcCards += deckCard.quantity;
        }

        const embedding = await getCardEmbedding(card[0].id);
        if (embedding) {
          for (let i = 0; i < deckCard.quantity; i++) {
            cardVectors.push(embedding);
          }
          totalQuantity += deckCard.quantity;
        }
      }
    }

    if (cardVectors.length === 0) return null;

    const vectorLength = cardVectors[0].length;
    const avgVector = new Array(vectorLength).fill(0);

    for (const vec of cardVectors) {
      for (let i = 0; i < vectorLength; i++) {
        avgVector[i] += vec[i];
      }
    }

    for (let i = 0; i < vectorLength; i++) {
      avgVector[i] /= cardVectors.length;
    }

    // Usar cores calculadas das cartas se o campo colors do deck estiver vazio
    const deckColors = deck[0].colors || "";
    const computedColors = deckColors.length > 0 ? deckColors : Array.from(colorSet).sort().join("");

    return {
      deckId,
      vector: avgVector,
      colors: computedColors,
      format: deck[0].format,
      cardCount: totalQuantity,
      creatureRatio: totalQuantity > 0 ? creatureCount / totalQuantity : 0,
      instantSorceryRatio: totalQuantity > 0 ? instantSorceryCount / totalQuantity : 0,
      avgCmc: cmcCards > 0 ? totalCmc / cmcCards : 0,
    };
  } catch (error) {
    console.error("Error converting deck to vector:", error);
    return null;
  }
}

/**
 * Calcula a distância euclidiana entre dois vetores
 */
export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    const minLen = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < minLen; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Calcula o centróide de um conjunto de vetores
 */
export function calculateCentroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];

  const vectorLength = vectors[0].length;
  const centroid = new Array(vectorLength).fill(0);

  for (const vector of vectors) {
    for (let i = 0; i < Math.min(vectorLength, vector.length); i++) {
      centroid[i] += vector[i];
    }
  }

  for (let i = 0; i < vectorLength; i++) {
    centroid[i] /= vectors.length;
  }

  return centroid;
}

/**
 * Normaliza um vetor para ter magnitude 1
 */
function normalizeVector(vec: number[]): number[] {
  let magnitude = 0;
  for (let i = 0; i < vec.length; i++) {
    magnitude += vec[i] * vec[i];
  }
  magnitude = Math.sqrt(magnitude);
  
  if (magnitude === 0) return vec;
  
  return vec.map(v => v / magnitude);
}

/**
 * Normaliza um conjunto de vetores
 */
function normalizeVectors(vectors: DeckVector[]): DeckVector[] {
  return vectors.map(dv => ({
    ...dv,
    vector: normalizeVector(dv.vector),
  }));
}

// ─── Implementação KMeans manual robusta ────────────────────────────────────
// Substitui ml-kmeans que tem bug no updateCenters com clusters vazios.

/**
 * Inicialização kmeans++ manual
 */
function kmeansppInit(data: number[][], k: number): number[][] {
  const n = data.length;
  const dim = data[0].length;
  const centroids: number[][] = [];

  centroids.push([...data[Math.floor(Math.random() * n)]]);

  for (let c = 1; c < k; c++) {
    const distances = new Float64Array(n);
    let totalDist = 0;

    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      for (const centroid of centroids) {
        let dist = 0;
        for (let d = 0; d < dim; d++) {
          const diff = data[i][d] - centroid[d];
          dist += diff * diff;
        }
        minDist = Math.min(minDist, dist);
      }
      distances[i] = minDist;
      totalDist += minDist;
    }

    if (totalDist === 0 || !isFinite(totalDist)) {
      centroids.push([...data[Math.floor(Math.random() * n)]]);
      continue;
    }

    let r = Math.random() * totalDist;
    let cumSum = 0;
    let chosen = 0;
    for (let i = 0; i < n; i++) {
      cumSum += distances[i];
      if (cumSum >= r) {
        chosen = i;
        break;
      }
    }
    centroids.push([...data[chosen]]);
  }

  return centroids;
}

/**
 * Atribui cada ponto ao centroid mais próximo
 */
function assignPoints(data: number[][], centroids: number[][]): number[] {
  const n = data.length;
  const k = centroids.length;
  const dim = data[0].length;
  const assignments = new Array(n);

  for (let i = 0; i < n; i++) {
    let minDist = Infinity;
    let bestCluster = 0;

    for (let c = 0; c < k; c++) {
      let dist = 0;
      for (let d = 0; d < dim; d++) {
        const diff = data[i][d] - centroids[c][d];
        dist += diff * diff;
      }
      if (dist < minDist) {
        minDist = dist;
        bestCluster = c;
      }
    }
    assignments[i] = bestCluster;
  }

  return assignments;
}

/**
 * Recalcula centroids. TRATA CLUSTERS VAZIOS com re-seed.
 */
function updateCentroids(data: number[][], assignments: number[], k: number): number[][] {
  const dim = data[0].length;
  const centroids: number[][] = [];
  const counts = new Array(k).fill(0);
  const sums: number[][] = [];

  for (let c = 0; c < k; c++) {
    sums.push(new Array(dim).fill(0));
  }

  for (let i = 0; i < data.length; i++) {
    const c = assignments[i];
    counts[c]++;
    for (let d = 0; d < dim; d++) {
      sums[c][d] += data[i][d];
    }
  }

  for (let c = 0; c < k; c++) {
    if (counts[c] > 0) {
      centroids.push(sums[c].map(s => s / counts[c]));
    } else {
      const largestCluster = counts.indexOf(Math.max(...counts));
      let maxDist = -1;
      let farthestIdx = 0;

      for (let i = 0; i < data.length; i++) {
        if (assignments[i] === largestCluster) {
          let dist = 0;
          for (let d = 0; d < dim; d++) {
            const diff = data[i][d] - (sums[largestCluster][d] / counts[largestCluster]);
            dist += diff * diff;
          }
          if (dist > maxDist) {
            maxDist = dist;
            farthestIdx = i;
          }
        }
      }

      centroids.push([...data[farthestIdx]]);
      console.log(`[KMeans] Cluster ${c} vazio → re-seed com ponto do cluster ${largestCluster}`);
    }
  }

  return centroids;
}

/**
 * Implementação KMeans manual robusta
 */
function robustKMeans(
  data: number[][],
  k: number,
  maxIterations: number = 150
): { assignments: number[]; centroids: number[][]; converged: boolean; iterations: number } {
  const n = data.length;

  let centroids = kmeansppInit(data, k);
  let assignments = assignPoints(data, centroids);
  let converged = false;
  let iter = 0;

  for (iter = 0; iter < maxIterations; iter++) {
    centroids = updateCentroids(data, assignments, k);
    const newAssignments = assignPoints(data, centroids);

    let changed = 0;
    for (let i = 0; i < n; i++) {
      if (newAssignments[i] !== assignments[i]) changed++;
    }

    assignments = newAssignments;

    if (changed === 0) {
      converged = true;
      break;
    }
  }

  return { assignments, centroids, converged, iterations: iter + 1 };
}

/**
 * Atribui nomes de arquétipos baseado nas características REAIS dos decks.
 * Usa creatureRatio, instantSorceryRatio, avgCmc e cores — não apenas cardCount.
 */
function assignArchetype(clusterVectors: DeckVector[], centroid: number[]): { archetype: string; confidence: number } {
  if (clusterVectors.length === 0) return { archetype: "Unknown", confidence: 0 };

  const totalDecks = clusterVectors.length;

  // ─── Calcular métricas médias do cluster ──────────────────────────
  const avgCreatureRatio = clusterVectors.reduce((s, dv) => s + dv.creatureRatio, 0) / totalDecks;
  const avgInstantSorceryRatio = clusterVectors.reduce((s, dv) => s + dv.instantSorceryRatio, 0) / totalDecks;
  const avgCmc = clusterVectors.reduce((s, dv) => s + dv.avgCmc, 0) / totalDecks;
  const avgCardCount = clusterVectors.reduce((s, dv) => s + dv.cardCount, 0) / totalDecks;

  // ─── Calcular cores dominantes ─────────────────────────────────────
  const colorCounts: { [key: string]: number } = {};
  const colorMap: { [key: string]: string } = {
    W: "White", U: "Blue", B: "Black", R: "Red", G: "Green",
  };

  clusterVectors.forEach(dv => {
    if (dv.colors) {
      dv.colors.split("").forEach(color => {
        if ("WUBRG".includes(color)) {
          colorCounts[color] = (colorCounts[color] || 0) + 1;
        }
      });
    }
  });

  const dominantColors = Object.entries(colorCounts)
    .filter(([_, count]) => count / totalDecks > 0.3)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([color]) => color);

  // ─── Classificar archetype baseado em métricas reais ───────────────
  // Aggro: muitas criaturas, CMC baixo
  // Control: poucas criaturas, muitos instants/sorceries, CMC alto
  // Midrange: equilíbrio entre criaturas e spells, CMC médio
  // Combo: poucas criaturas, poucos instants, CMC variado (cartas específicas)
  // Ramp: CMC alto, muitas criaturas grandes

  let style = "Midrange";
  let styleConfidence = 0.5;

  if (avgCreatureRatio >= 0.45 && avgCmc <= 2.8) {
    style = "Aggro";
    styleConfidence = 0.7 + Math.min(0.25, (avgCreatureRatio - 0.45) * 2);
  } else if (avgCreatureRatio >= 0.40 && avgCmc <= 3.2) {
    style = "Aggro";
    styleConfidence = 0.6 + Math.min(0.2, (avgCreatureRatio - 0.40) * 2);
  } else if (avgInstantSorceryRatio >= 0.35 && avgCreatureRatio < 0.30) {
    style = "Control";
    styleConfidence = 0.7 + Math.min(0.25, (avgInstantSorceryRatio - 0.35) * 2);
  } else if (avgInstantSorceryRatio >= 0.25 && avgCmc >= 3.0 && avgCreatureRatio < 0.35) {
    style = "Control";
    styleConfidence = 0.6 + Math.min(0.2, (avgCmc - 3.0) * 0.1);
  } else if (avgCreatureRatio < 0.25 && avgInstantSorceryRatio < 0.25) {
    style = "Combo";
    styleConfidence = 0.55;
  } else if (avgCmc >= 3.5 && avgCreatureRatio >= 0.30) {
    style = "Ramp";
    styleConfidence = 0.6 + Math.min(0.2, (avgCmc - 3.5) * 0.1);
  } else if (avgCreatureRatio >= 0.30 && avgCreatureRatio < 0.45 && avgCmc >= 2.5 && avgCmc < 3.5) {
    style = "Midrange";
    styleConfidence = 0.65;
  } else if (avgInstantSorceryRatio >= 0.30 && avgCreatureRatio >= 0.20 && avgCmc < 2.5) {
    style = "Tempo";
    styleConfidence = 0.6;
  }

  // ─── Construir nome do archetype ───────────────────────────────────
  let colorPrefix: string;

  if (dominantColors.length === 0) {
    colorPrefix = "Colorless";
  } else if (dominantColors.length === 1) {
    colorPrefix = colorMap[dominantColors[0]] || dominantColors[0];
  } else if (dominantColors.length === 2) {
    // Usar nomes de guilds do MTG para pares de cores
    const pair = dominantColors.sort().join("");
    const guildNames: { [key: string]: string } = {
      "BG": "Golgari", "BR": "Rakdos", "BU": "Dimir", "BW": "Orzhov",
      "GR": "Gruul", "GU": "Simic", "GW": "Selesnya",
      "RU": "Izzet", "RW": "Boros", "UW": "Azorius",
    };
    colorPrefix = guildNames[pair] || `${dominantColors.map(c => colorMap[c] || c).join("-")}`;
  } else {
    // 3+ cores: usar nomes de shards/wedges ou "Multicolor"
    const triple = dominantColors.sort().join("");
    const triNames: { [key: string]: string } = {
      "BGW": "Abzan", "BRU": "Grixis", "GRW": "Naya", "BUW": "Esper", "GRU": "Temur",
      "BGR": "Jund", "BRW": "Mardu", "GUW": "Bant", "BRG": "Jund", "RUW": "Jeskai",
    };
    colorPrefix = triNames[triple] || "Multicolor";
  }

  // Commander tem cardCount > 90
  if (avgCardCount > 90) {
    style = `Commander ${style}`;
  }

  const archetype = `${colorPrefix} ${style}`;
  const confidence = Math.max(0.1, Math.min(1, styleConfidence));

  return { archetype, confidence };
}


/**
 * Implementação do algoritmo K-Means usando implementação manual robusta.
 */
export function kMeansReal(vectors: DeckVector[], k: number, maxIterations: number = 150): { clusters: ClusterResult[]; stats: ClusteringStats } {
  if (vectors.length === 0 || k <= 0) {
    return { clusters: [], stats: { silhouetteScore: 0, calinskiHarabaszIndex: 0, daviesBouldinIndex: 0, inertia: 0, converged: false } };
  }

  const adjustedK = Math.min(k, vectors.length);
  
  // Extrair dados numéricos e normalizar dimensões
  const rawData = vectors.map(v => v.vector);
  const maxDim = rawData.reduce((max, vec) => Math.max(max, vec.length), 0);
  const data = rawData.map(vec => {
    if (vec.length === maxDim) return vec;
    const padded = new Array(maxDim).fill(0);
    for (let i = 0; i < vec.length; i++) padded[i] = vec[i];
    return padded;
  });

  // Filtrar vetores completamente zerados ou com NaN
  const validMask = data.map(vec => vec.some(v => v !== 0 && isFinite(v)));
  const filteredData = data.filter((_, i) => validMask[i]);
  const filteredVectors = vectors.filter((_, i) => validMask[i]);

  if (filteredData.length < adjustedK) {
    console.warn(`[KMeans] Vetores válidos insuficientes (${filteredData.length}) para k=${adjustedK}.`);
    return { clusters: [], stats: { silhouetteScore: 0, calinskiHarabaszIndex: 0, daviesBouldinIndex: 0, inertia: 0, converged: false } };
  }

  console.log(`[KMeans] Running robust KMeans: k=${adjustedK}, dim=${maxDim}, n=${filteredData.length}, max_iterations=${maxIterations}`);

  const result = robustKMeans(filteredData, adjustedK, maxIterations);

  const assignments = result.assignments;
  const centroids = result.centroids;

  console.log(`[KMeans] Clustering complete! Converged: ${result.converged}. Iterations: ${result.iterations}`);

  // Construir clusters com metadados
  const clusterMap = new Map<number, number[]>();
  for (let i = 0; i < assignments.length; i++) {
    const clusterId = assignments[i];
    if (!clusterMap.has(clusterId)) {
      clusterMap.set(clusterId, []);
    }
    clusterMap.get(clusterId)!.push(i);
  }

  // Criar resultados finais
  const clusters: ClusterResult[] = [];
  clusterMap.forEach((vectorIndices, clusterId) => {
    const clusterVectors = vectorIndices.map(i => filteredVectors[i]);
    const centroid = centroids[clusterId];

    // Distâncias intra-cluster (usando os vetores FILTRADOS, mesma escala dos centroids)
    const clusterDataVecs = vectorIndices.map(i => filteredData[i]);
    const intraClusterDistances = clusterDataVecs.map(vec =>
      euclideanDistance(vec, centroid)
    );
    const avgIntraClusterDistance = intraClusterDistances.length > 0
      ? intraClusterDistances.reduce((a, b) => a + b, 0) / intraClusterDistances.length
      : 0;

    // Distância inter-cluster
    const otherCentroids = centroids.filter((_, idx) => idx !== clusterId);
    let avgInterClusterDistance = 0;
    if (otherCentroids.length > 0) {
      const distancesToOthers = otherCentroids.map(oc => euclideanDistance(centroid, oc));
      avgInterClusterDistance = distancesToOthers.reduce((a, b) => a + b, 0) / distancesToOthers.length;
    }

    const { archetype, confidence } = assignArchetype(clusterVectors, centroid);
    const avgCardCount = clusterVectors.length > 0
      ? clusterVectors.reduce((sum, dv) => sum + dv.cardCount, 0) / clusterVectors.length
      : 0;

    // Cores médias
    const colorCounts: { [key: string]: number } = {};
    clusterVectors.forEach(dv => {
      if (dv.colors) {
        dv.colors.split("").forEach(color => {
          colorCounts[color] = (colorCounts[color] || 0) + 1;
        });
      }
    });

    const totalDecks = clusterVectors.length;
    const avgColors = Object.entries(colorCounts)
      .filter(([_, count]) => count / totalDecks > 0.2)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([color]) => color)
      .join("");

    clusters.push({
      clusterId,
      deckIds: clusterVectors.map(dv => dv.deckId),
      centroid,
      archetype,
      confidence,
      avgColors,
      avgCardCount: Math.round(avgCardCount),
      intraClusterDistance: avgIntraClusterDistance,
      interClusterDistance: avgInterClusterDistance,
    });
  });

  // Calcular estatísticas usando os MESMOS vetores filtrados (mesma escala dos centroids)
  const stats = calculateClusteringMetrics(clusters, filteredVectors, filteredData);

  return { clusters, stats };
}

/**
 * Executa clustering KMeans em todos os decks competitivos
 */
export async function clusterCompetitiveDecks(k: number = 8): Promise<{ clusters: ClusterResult[]; stats: ClusteringStats }> {
  const db = await getDb();
  if (!db) return { clusters: [], stats: { silhouetteScore: 0, calinskiHarabaszIndex: 0, daviesBouldinIndex: 0, inertia: 0, converged: false } };

  try {
    const decks = await db.select().from(competitiveDecks);

    console.log(`[Clustering] Starting KMeans clustering with ${decks.length} decks, k=${k}`);

    const deckVectors: DeckVector[] = [];
    for (const deck of decks) {
      const vector = await deckToVector(deck.id);
      if (vector) {
        deckVectors.push(vector);
      }
    }

    console.log(`[Clustering] Converted ${deckVectors.length} decks to vectors`);

    if (deckVectors.length < k) {
      console.warn(`[Clustering] Not enough deck vectors (${deckVectors.length}) for k=${k} clusters`);
      return { clusters: [], stats: { silhouetteScore: 0, calinskiHarabaszIndex: 0, daviesBouldinIndex: 0, inertia: 0, converged: false } };
    }

    // Normalizar vetores para melhor clustering
    const normalizedVectors = normalizeVectors(deckVectors);

    // Executar KMeans com implementação manual robusta
    const { clusters, stats } = kMeansReal(normalizedVectors, k, 150);

    console.log(`[Clustering] Generated ${clusters.length} clusters`);
    clusters.forEach(c => {
      console.log(`  Cluster ${c.clusterId}: ${c.archetype} (${c.deckIds.length} decks, colors=${c.avgColors}, conf=${c.confidence.toFixed(2)})`);
    });
    console.log(`[Clustering] Silhouette Score: ${stats.silhouetteScore.toFixed(3)}`);
    console.log(`[Clustering] Calinski-Harabasz Index: ${stats.calinskiHarabaszIndex.toFixed(2)}`);
    console.log(`[Clustering] Davies-Bouldin Index: ${stats.daviesBouldinIndex.toFixed(3)}`);
    console.log(`[Clustering] Inertia: ${stats.inertia.toFixed(4)}`);

    // Atualizar arquétipos no banco
    for (const cluster of clusters) {
      for (const deckId of cluster.deckIds) {
        await db
          .update(competitiveDecks)
          .set({ archetype: cluster.archetype })
          .where(eq(competitiveDecks.id, deckId));
      }
    }

    console.log(`[Clustering] Updated ${clusters.reduce((sum, c) => sum + c.deckIds.length, 0)} deck archetypes in database`);

    return { clusters, stats };
  } catch (error) {
    console.error("[Clustering] Error in KMeans clustering:", error);
    return { clusters: [], stats: { silhouetteScore: 0, calinskiHarabaszIndex: 0, daviesBouldinIndex: 0, inertia: 0, converged: false } };
  }
}

/**
 * Calcula métricas de qualidade do clustering.
 * Agora recebe filteredData (mesma escala dos centroids) para cálculos corretos.
 */
export function calculateClusteringMetrics(
  clusters: ClusterResult[],
  vectors: DeckVector[],
  filteredData?: number[][]
): ClusteringStats {
  if (clusters.length === 0 || vectors.length === 0) {
    return { silhouetteScore: 0, calinskiHarabaszIndex: 0, daviesBouldinIndex: 0, inertia: 0, converged: true };
  }

  // Usar filteredData se disponível (mesma escala dos centroids), senão extrair dos vectors
  const dataVectors = filteredData || vectors.map(v => v.vector);

  // Mapear deckId → índice no dataVectors para lookup rápido
  const deckIdToIdx = new Map<number, number>();
  vectors.forEach((v, i) => deckIdToIdx.set(v.deckId, i));

  // ─── Silhouette Score ───────────────────────────────────────────────
  let totalSilhouette = 0;
  let validSilhouettes = 0;

  for (let idx = 0; idx < vectors.length; idx++) {
    const vector = vectors[idx];
    const dataVec = dataVectors[idx];
    const cluster = clusters.find(c => c.deckIds.includes(vector.deckId));
    if (!cluster) continue;

    // a(i) = distância média intra-cluster
    const sameClusterIndices = cluster.deckIds
      .filter(id => id !== vector.deckId)
      .map(id => deckIdToIdx.get(id))
      .filter((i): i is number => i !== undefined);

    const a = sameClusterIndices.length > 0
      ? sameClusterIndices.reduce((sum, i) => sum + euclideanDistance(dataVec, dataVectors[i]), 0) / sameClusterIndices.length
      : 0;

    // b(i) = distância média mínima ao cluster vizinho mais próximo
    let minB = Infinity;
    for (const otherCluster of clusters) {
      if (otherCluster.clusterId === cluster.clusterId) continue;

      const otherIndices = otherCluster.deckIds
        .map(id => deckIdToIdx.get(id))
        .filter((i): i is number => i !== undefined);

      if (otherIndices.length > 0) {
        const avgDist = otherIndices.reduce((sum, i) => sum + euclideanDistance(dataVec, dataVectors[i]), 0) / otherIndices.length;
        minB = Math.min(minB, avgDist);
      }
    }

    if (minB === Infinity || (a === 0 && minB === 0)) {
      totalSilhouette += 0;
    } else {
      const maxAB = Math.max(a, minB);
      const s = maxAB > 0 ? (minB - a) / maxAB : 0;
      if (isFinite(s)) {
        totalSilhouette += Math.max(-1, Math.min(1, s));
      }
    }
    validSilhouettes++;
  }

  const silhouetteScore = validSilhouettes > 0 ? totalSilhouette / validSilhouettes : 0;

  // ─── Calinski-Harabasz Index ────────────────────────────────────────
  const overallCentroid = calculateCentroid(dataVectors);

  let SSB = 0;
  let SSW = 0;

  for (const cluster of clusters) {
    const clusterIndices = cluster.deckIds
      .map(id => deckIdToIdx.get(id))
      .filter((i): i is number => i !== undefined);

    const nk = clusterIndices.length;

    // SSB: distância do centroid do cluster ao centroid global × tamanho do cluster
    const centroidDist = euclideanDistance(cluster.centroid, overallCentroid);
    SSB += nk * centroidDist * centroidDist;

    // SSW: soma das distâncias dos pontos ao centroid do cluster
    for (const idx of clusterIndices) {
      const dist = euclideanDistance(dataVectors[idx], cluster.centroid);
      SSW += dist * dist;
    }
  }

  const numClusters = clusters.length;
  const numPoints = vectors.length;
  let calinskiHarabaszIndex = 0;

  if (numClusters > 1 && numPoints > numClusters) {
    if (SSW > 1e-10) {
      calinskiHarabaszIndex = (SSB / (numClusters - 1)) / (SSW / (numPoints - numClusters));
    } else {
      calinskiHarabaszIndex = SSB > 1e-10 ? 999999 : 0;
    }
  }
  if (!isFinite(calinskiHarabaszIndex)) calinskiHarabaszIndex = 0;

  // ─── Davies-Bouldin Index ───────────────────────────────────────────
  let totalDB = 0;
  for (let i = 0; i < clusters.length; i++) {
    let maxRatio = 0;

    const clusterIIndices = clusters[i].deckIds
      .map(id => deckIdToIdx.get(id))
      .filter((idx): idx is number => idx !== undefined);

    const avgI = clusterIIndices.length > 0
      ? clusterIIndices.reduce((sum, idx) => sum + euclideanDistance(dataVectors[idx], clusters[i].centroid), 0) / clusterIIndices.length
      : 0;

    for (let j = 0; j < clusters.length; j++) {
      if (i === j) continue;

      const clusterJIndices = clusters[j].deckIds
        .map(id => deckIdToIdx.get(id))
        .filter((idx): idx is number => idx !== undefined);

      if (clusterIIndices.length === 0 || clusterJIndices.length === 0) continue;

      const avgJ = clusterJIndices.reduce((sum, idx) => sum + euclideanDistance(dataVectors[idx], clusters[j].centroid), 0) / clusterJIndices.length;

      const centroidDistance = euclideanDistance(clusters[i].centroid, clusters[j].centroid);
      const ratio = centroidDistance > 1e-10 ? (avgI + avgJ) / centroidDistance : 0;

      maxRatio = Math.max(maxRatio, ratio);
    }
    totalDB += maxRatio;
  }

  const daviesBouldinIndex = clusters.length > 1 ? totalDB / clusters.length : 0;

  // ─── Inertia (Within-cluster sum of squares) ────────────────────────
  const inertia = SSW;

  return {
    silhouetteScore: isFinite(silhouetteScore) ? Math.max(-1, Math.min(1, silhouetteScore)) : 0,
    calinskiHarabaszIndex: isFinite(calinskiHarabaszIndex) ? Math.max(0, calinskiHarabaszIndex) : 0,
    daviesBouldinIndex: isFinite(daviesBouldinIndex) ? Math.max(0, daviesBouldinIndex) : 0,
    inertia: isFinite(inertia) ? inertia : 0,
    converged: true,
  };
}

/**
 * Agrupa clusters por nome de arquétipo
 */
export function groupClustersByArchetype(clusters: ClusterResult[]): Map<string, ClusterResult[]> {
  const grouped = new Map<string, ClusterResult[]>();

  clusters.forEach(cluster => {
    const archetype = cluster.archetype;
    if (!grouped.has(archetype)) {
      grouped.set(archetype, []);
    }
    grouped.get(archetype)!.push(cluster);
  });

  return grouped;
}

/**
 * Retorna estatísticas de um clustering agrupadas por arquétipo
 */
export function getClusterStatsByArchetype(clusters: ClusterResult[]): Array<{
  archetype: string;
  clusterCount: number;
  totalDecks: number;
  avgConfidence: number;
  colors: Set<string>;
}> {
  const grouped = groupClustersByArchetype(clusters);
  const stats: Array<{
    archetype: string;
    clusterCount: number;
    totalDecks: number;
    avgConfidence: number;
    colors: Set<string>;
  }> = [];

  grouped.forEach((clusterList, archetype) => {
    const totalDecks = clusterList.reduce((sum, c) => sum + c.deckIds.length, 0);
    const avgConfidence = clusterList.reduce((sum, c) => sum + c.confidence, 0) / clusterList.length;
    const colors = new Set<string>();

    clusterList.forEach(c => {
      c.avgColors.split("").forEach(color => colors.add(color));
    });

    stats.push({
      archetype,
      clusterCount: clusterList.length,
      totalDecks,
      avgConfidence,
      colors,
    });
  });

  return stats.sort((a, b) => b.totalDecks - a.totalDecks);
}

/**
 * Encontra o K ótimo usando o método do cotovelo (elbow method)
 */
export async function findOptimalK(deckVectors: DeckVector[], maxK: number = 15): Promise<{ optimalK: number; inertias: number[]; silhouettes: number[] }> {
  const inertias: number[] = [];
  const silhouettes: number[] = [];

  const minK = Math.max(2, Math.min(5, Math.floor(deckVectors.length / 10)));
  const testK = Math.min(maxK, deckVectors.length - 1);

  console.log(`[Clustering] Testing K values from ${minK} to ${testK} for elbow method...`);

  for (let k = minK; k <= testK; k++) {
    const normalized = normalizeVectors(deckVectors);
    const { clusters, stats } = kMeansReal(normalized, k, 100);

    inertias.push(stats.inertia);
    silhouettes.push(stats.silhouetteScore);

    console.log(`[Clustering] K=${k}: Inertia=${stats.inertia.toFixed(4)}, Silhouette=${stats.silhouetteScore.toFixed(3)}`);
  }

  let optimalK = minK;
  let maxInertiaChange = 0;

  for (let i = 1; i < inertias.length; i++) {
    const change = inertias[i - 1] - inertias[i];
    if (change > maxInertiaChange) {
      maxInertiaChange = change;
      optimalK = minK + i - 1;
    }
  }

  if (silhouettes.length > 0) {
    const maxSilhouetteIdx = silhouettes.indexOf(Math.max(...silhouettes));
    if (Math.max(...silhouettes) > 0.5) {
      optimalK = minK + maxSilhouetteIdx;
    }
  }

  console.log(`[Clustering] Optimal K found: ${optimalK}`);

  return { optimalK, inertias, silhouettes };
}

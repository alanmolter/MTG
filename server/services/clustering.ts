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
 * Converte um deck competitivo para um vetor numérico usando embeddings das cartas
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

    for (const deckCard of deckCards) {
      const card = await db
        .select()
        .from(cards)
        .where(eq(cards.name, deckCard.cardName))
        .limit(1);

      if (card.length > 0) {
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

    return {
      deckId,
      vector: avgVector,
      colors: deck[0].colors || "",
      format: deck[0].format,
      cardCount: totalQuantity,
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
  if (a.length !== b.length) return Infinity;

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
    for (let i = 0; i < vectorLength; i++) {
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
// Trata: clusters vazios (re-seed), vetores NaN, dimensões inconsistentes.

/**
 * Inicialização kmeans++ manual: escolhe centroids iniciais com probabilidade
 * proporcional à distância ao centroid mais próximo.
 */
function kmeansppInit(data: number[][], k: number): number[][] {
  const n = data.length;
  const dim = data[0].length;
  const centroids: number[][] = [];

  // Primeiro centroid: aleatório
  centroids.push([...data[Math.floor(Math.random() * n)]]);

  for (let c = 1; c < k; c++) {
    // Calcular distância mínima de cada ponto ao centroid mais próximo
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

    // Se totalDist é 0 (todos os pontos são idênticos), escolher aleatório
    if (totalDist === 0 || !isFinite(totalDist)) {
      centroids.push([...data[Math.floor(Math.random() * n)]]);
      continue;
    }

    // Escolher próximo centroid com probabilidade proporcional à distância²
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
 * Atribui cada ponto ao centroid mais próximo.
 * Retorna array de assignments (índice do cluster para cada ponto).
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
 * Recalcula centroids a partir dos assignments.
 * TRATA CLUSTERS VAZIOS: re-seed com o ponto mais distante do cluster mais populoso.
 */
function updateCentroids(data: number[][], assignments: number[], k: number): number[][] {
  const dim = data[0].length;
  const centroids: number[][] = [];
  const counts = new Array(k).fill(0);
  const sums: number[][] = [];

  for (let c = 0; c < k; c++) {
    sums.push(new Array(dim).fill(0));
  }

  // Somar vetores por cluster
  for (let i = 0; i < data.length; i++) {
    const c = assignments[i];
    counts[c]++;
    for (let d = 0; d < dim; d++) {
      sums[c][d] += data[i][d];
    }
  }

  // Calcular médias
  for (let c = 0; c < k; c++) {
    if (counts[c] > 0) {
      centroids.push(sums[c].map(s => s / counts[c]));
    } else {
      // CLUSTER VAZIO: re-seed com o ponto mais distante do cluster mais populoso
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
      console.log(`[KMeans] Cluster ${c} ficou vazio → re-seed com ponto mais distante do cluster ${largestCluster}`);
    }
  }

  return centroids;
}

/**
 * Implementação KMeans manual robusta.
 * Substitui ml-kmeans que tem bug com clusters vazios no updateCenters.
 */
function robustKMeans(
  data: number[][],
  k: number,
  maxIterations: number = 150
): { assignments: number[]; centroids: number[][]; converged: boolean; iterations: number } {
  const n = data.length;

  // Inicialização kmeans++
  let centroids = kmeansppInit(data, k);
  let assignments = assignPoints(data, centroids);
  let converged = false;
  let iter = 0;

  for (iter = 0; iter < maxIterations; iter++) {
    // Recalcular centroids (com tratamento de clusters vazios)
    centroids = updateCentroids(data, assignments, k);

    // Re-atribuir pontos
    const newAssignments = assignPoints(data, centroids);

    // Verificar convergência
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
 * Atribui nomes de arquétipos baseado nas características dos clusters
 * Usa análise de cores e tamanho de deck + heurística de CMC
 */
function assignArchetype(clusterVectors: DeckVector[], centroid: number[]): { archetype: string; confidence: number } {
  if (clusterVectors.length === 0) return { archetype: "Unknown", confidence: 0 };

  const avgCardCount = clusterVectors.reduce((sum, dv) => sum + dv.cardCount, 0) / clusterVectors.length;

  const colorCounts: { [key: string]: number } = {};
  const colorMap: { [key: string]: string } = {
    W: "White",
    U: "Blue",
    B: "Black",
    R: "Red",
    G: "Green",
  };

  clusterVectors.forEach(dv => {
    if (dv.colors) {
      dv.colors.split("").forEach(color => {
        colorCounts[color] = (colorCounts[color] || 0) + 1;
      });
    }
  });

  const totalDecks = clusterVectors.length;
  const dominantColors = Object.entries(colorCounts)
    .filter(([_, count]) => count / totalDecks > 0.25)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([color]) => color);

  const colorConfidence = dominantColors.length > 0 
    ? (colorCounts[dominantColors[0]] || 0) / totalDecks 
    : 0.3;

  let archetype = "Unknown";
  let archetypeConfidence = 0;

  if (dominantColors.length === 0) {
    if (avgCardCount < 50) {
      archetype = "Colorless Tempo";
      archetypeConfidence = 0.5;
    } else if (avgCardCount > 65) {
      archetype = "Colorless Ramp";
      archetypeConfidence = 0.5;
    } else {
      archetype = "Colorless Midrange";
      archetypeConfidence = 0.6;
    }
  } else if (dominantColors.length === 1) {
    const color = dominantColors[0];
    const colorName = colorMap[color] || color;

    if (avgCardCount < 44) {
      archetype = `${colorName} Aggro`;
      archetypeConfidence = Math.min(0.95, colorConfidence + 0.2);
    } else if (avgCardCount < 52) {
      archetype = `${colorName} Tempo`;
      archetypeConfidence = Math.min(0.9, colorConfidence + 0.15);
    } else if (avgCardCount < 62) {
      archetype = `${colorName} Midrange`;
      archetypeConfidence = Math.min(0.9, colorConfidence + 0.15);
    } else if (avgCardCount < 75) {
      archetype = `${colorName} Control`;
      archetypeConfidence = Math.min(0.95, colorConfidence + 0.2);
    } else {
      archetype = `${colorName} Ramp`;
      archetypeConfidence = Math.min(0.9, colorConfidence + 0.15);
    }
  } else if (dominantColors.length === 2) {
    const colorPair = dominantColors.join("");

    if (avgCardCount < 48) {
      archetype = `${colorPair} Aggro`;
      archetypeConfidence = Math.min(0.9, colorConfidence + 0.1);
    } else if (avgCardCount < 60) {
      archetype = `${colorPair} Midrange`;
      archetypeConfidence = Math.min(0.85, colorConfidence + 0.1);
    } else {
      archetype = `${colorPair} Control`;
      archetypeConfidence = Math.min(0.9, colorConfidence + 0.1);
    }
  } else if (dominantColors.length >= 3) {
    if (avgCardCount < 50) {
      archetype = "Multicolor Aggro";
      archetypeConfidence = 0.6;
    } else if (avgCardCount > 70) {
      archetype = "Multicolor Control";
      archetypeConfidence = 0.65;
    } else {
      archetype = "Multicolor Midrange/Goodstuff";
      archetypeConfidence = 0.7;
    }
  }

  return {
    archetype,
    confidence: Math.max(0.1, Math.min(1, archetypeConfidence)),
  };
}


/**
 * Implementação do algoritmo K-Means usando implementação manual robusta.
 * Substitui ml-kmeans v7 que tem bug com clusters vazios no updateCenters.
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
    console.warn(`[KMeans] Vetores válidos insuficientes (${filteredData.length}) para k=${adjustedK}. Abortando.`);
    return { clusters: [], stats: { silhouetteScore: 0, calinskiHarabaszIndex: 0, daviesBouldinIndex: 0, inertia: 0, converged: false } };
  }

  console.log(`[KMeans] Running robust KMeans: k=${adjustedK}, dim=${maxDim}, n=${filteredData.length}, max_iterations=${maxIterations}`);

  // Executar KMeans manual robusto (sem dependência de ml-kmeans)
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

  // Criar resultados finais com informações enriquecidas
  const clusters: ClusterResult[] = [];
  clusterMap.forEach((vectorIndices, clusterId) => {
    const clusterVectors = vectorIndices.map(i => filteredVectors[i]);
    const centroid = centroids[clusterId];

    // Calcular distâncias intra-cluster
    const intraClusterDistances = vectorIndices.map(i =>
      euclideanDistance(filteredVectors[i].vector, centroid)
    );
    const avgIntraClusterDistance = intraClusterDistances.length > 0
      ? intraClusterDistances.reduce((a, b) => a + b, 0) / intraClusterDistances.length
      : 0;

    // Calcular distância inter-cluster
    const otherCentroids = centroids.filter((_, idx) => idx !== clusterId);
    let avgInterClusterDistance = 0;
    if (otherCentroids.length > 0) {
      const distancesToOthers = otherCentroids.map(otherCentroid =>
        euclideanDistance(centroid, otherCentroid)
      );
      avgInterClusterDistance = distancesToOthers.reduce((a, b) => a + b, 0) / distancesToOthers.length;
    }

    const { archetype, confidence } = assignArchetype(clusterVectors, centroid);
    const avgCardCount = clusterVectors.length > 0
      ? clusterVectors.reduce((sum, dv) => sum + dv.cardCount, 0) / clusterVectors.length
      : 0;

    // Calcular cores médias
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

  // Calcular estatísticas de clustering
  const stats = calculateClusteringMetrics(clusters, vectors);

  return { clusters, stats };
}

/**
 * Executa clustering KMeans em todos os decks competitivos com otimizações
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
    console.log(`[Clustering] Silhouette Score: ${stats.silhouetteScore.toFixed(3)}`);
    console.log(`[Clustering] Calinski-Harabasz Index: ${stats.calinskiHarabaszIndex.toFixed(2)}`);
    console.log(`[Clustering] Davies-Bouldin Index: ${stats.daviesBouldinIndex.toFixed(3)}`);

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
 * Calcula métricas de qualidade do clustering com implementação robusta
 */
export function calculateClusteringMetrics(clusters: ClusterResult[], vectors: DeckVector[]): ClusteringStats {
  if (clusters.length === 0 || vectors.length === 0) {
    return { silhouetteScore: 0, calinskiHarabaszIndex: 0, daviesBouldinIndex: 0, inertia: 0, converged: true };
  }

  // ─── Silhouette Score ───────────────────────────────────────────────
  let totalSilhouette = 0;
  let validSilhouettes = 0;

  vectors.forEach(vector => {
    const cluster = clusters.find(c => c.deckIds.includes(vector.deckId));
    if (!cluster) return;

    const sameClusterVectors = vectors.filter(v =>
      cluster.deckIds.includes(v.deckId) && v.deckId !== vector.deckId
    );
    const a = sameClusterVectors.length > 0
      ? sameClusterVectors.reduce((sum, v) => sum + euclideanDistance(vector.vector, v.vector), 0) / sameClusterVectors.length
      : 0;

    let minB = Infinity;
    clusters.forEach(otherCluster => {
      if (otherCluster.clusterId === cluster.clusterId) return;

      const otherVectors = vectors.filter(v => otherCluster.deckIds.includes(v.deckId));
      if (otherVectors.length > 0) {
        const avgDistance = otherVectors.reduce((sum, v) => sum + euclideanDistance(vector.vector, v.vector), 0) / otherVectors.length;
        minB = Math.min(minB, avgDistance);
      }
    });

    const silhouetteValue = minB > a ? (minB - a) / minB : (a - minB) / a;
    if (silhouetteValue >= -1 && silhouetteValue <= 1) {
      totalSilhouette += silhouetteValue;
      validSilhouettes++;
    }
  });

  const silhouetteScore = validSilhouettes > 0 ? totalSilhouette / validSilhouettes : 0;

  // ─── Calinski-Harabasz Index ────────────────────────────────────────
  const overallCentroid = calculateCentroid(vectors.map(v => v.vector));
  
  const SSB = clusters.reduce((sum, cluster) => {
    const clusterSize = cluster.deckIds.length;
    const distance = euclideanDistance(cluster.centroid, overallCentroid);
    return sum + clusterSize * distance * distance;
  }, 0);

  const SSW = clusters.reduce((sum, cluster) => {
    const clusterVectors = vectors.filter(v => cluster.deckIds.includes(v.deckId));
    return sum + clusterVectors.reduce((clusterSum, vector) => {
      return clusterSum + euclideanDistance(vector.vector, cluster.centroid) ** 2;
    }, 0);
  }, 0);

  const numClusters = clusters.length;
  const numPoints = vectors.length;
  const calinskiHarabaszIndex =
    numClusters > 1 && numPoints > numClusters
      ? (SSB / (numClusters - 1)) / (SSW / (numPoints - numClusters))
      : 0;

  // ─── Davies-Bouldin Index ───────────────────────────────────────────
  let totalDB = 0;
  for (let i = 0; i < clusters.length; i++) {
    let maxRatio = 0;
    for (let j = 0; j < clusters.length; j++) {
      if (i === j) continue;

      const clusterIVectors = vectors.filter(v => clusters[i].deckIds.includes(v.deckId));
      const clusterJVectors = vectors.filter(v => clusters[j].deckIds.includes(v.deckId));

      if (clusterIVectors.length === 0 || clusterJVectors.length === 0) continue;

      const avgI = clusterIVectors.reduce((sum, v) => sum + euclideanDistance(v.vector, clusters[i].centroid), 0) / clusterIVectors.length;
      const avgJ = clusterJVectors.reduce((sum, v) => sum + euclideanDistance(v.vector, clusters[j].centroid), 0) / clusterJVectors.length;

      const centroidDistance = euclideanDistance(clusters[i].centroid, clusters[j].centroid);
      const ratio = centroidDistance > 0 ? (avgI + avgJ) / centroidDistance : 0;

      maxRatio = Math.max(maxRatio, ratio);
    }
    totalDB += maxRatio;
  }

  const daviesBouldinIndex = clusters.length > 1 ? totalDB / clusters.length : 0;

  // ─── Inertia (Within-cluster sum of squares) ────────────────────────
  const inertia = SSW;

  return {
    silhouetteScore: Math.max(-1, Math.min(1, silhouetteScore)),
    calinskiHarabaszIndex: Math.max(0, calinskiHarabaszIndex),
    daviesBouldinIndex: Math.max(0, daviesBouldinIndex),
    inertia,
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

    console.log(`[Clustering] K=${k}: Inertia=${stats.inertia.toFixed(2)}, Silhouette=${stats.silhouetteScore.toFixed(3)}`);
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

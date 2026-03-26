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
    // Obter informações do deck
    const deck = await db
      .select()
      .from(competitiveDecks)
      .where(eq(competitiveDecks.id, deckId))
      .limit(1);

    if (deck.length === 0) return null;

    // Obter cartas do deck
    const deckCards = await db
      .select()
      .from(competitiveDeckCards)
      .where(and(
        eq(competitiveDeckCards.deckId, deckId),
        eq(competitiveDeckCards.section, "mainboard")
      ));

    if (deckCards.length === 0) return null;

    // Calcular vetor médio das cartas
    const cardVectors: number[][] = [];
    let totalQuantity = 0;

    for (const deckCard of deckCards) {
      // Encontrar a carta no banco principal
      const card = await db
        .select()
        .from(cards)
        .where(eq(cards.name, deckCard.cardName))
        .limit(1);

      if (card.length > 0) {
        const embedding = await getCardEmbedding(card[0].id);
        if (embedding) {
          // Adicionar o vetor múltiplas vezes baseado na quantidade
          for (let i = 0; i < deckCard.quantity; i++) {
            cardVectors.push(embedding);
          }
          totalQuantity += deckCard.quantity;
        }
      }
    }

    if (cardVectors.length === 0) return null;

    // Calcular vetor médio
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

/**
 * Atribui nomes de arquétipos baseado nas características dos clusters
 * Usa análise de cores e tamanho de deck + heurística de CMC
 */
function assignArchetype(clusterVectors: DeckVector[], centroid: number[]): { archetype: string; confidence: number } {
  if (clusterVectors.length === 0) return { archetype: "Unknown", confidence: 0 };

  // Calcular estatísticas do cluster
  const avgCardCount = clusterVectors.reduce((sum, dv) => sum + dv.cardCount, 0) / clusterVectors.length;
  const minCardCount = Math.min(...clusterVectors.map(dv => dv.cardCount));
  const maxCardCount = Math.max(...clusterVectors.map(dv => dv.cardCount));
  const cardCountStdDev = Math.sqrt(
    clusterVectors.reduce((sum, dv) => sum + Math.pow(dv.cardCount - avgCardCount, 2), 0) / clusterVectors.length
  );

  // Contar cores com frequência
  const colorCounts: { [key: string]: number } = {};
  const colorFrequency: { [key: string]: number } = {};
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
        colorFrequency[color] = (colorCounts[color] || 0) / clusterVectors.length;
      });
    }
  });

  const totalDecks = clusterVectors.length;
  const dominantColors = Object.entries(colorCounts)
    .filter(([_, count]) => count / totalDecks > 0.25) // Pelo menos 25% dos decks
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([color]) => color);

  // Confiança baseada na homogeneidade de cores
  const colorConfidence = dominantColors.length > 0 
    ? (colorCounts[dominantColors[0]] || 0) / totalDecks 
    : 0.3;

  // Heurística de arquétipo baseada em cores e tamanho
  let archetype = "Unknown";
  let archetypeConfidence = 0;

  // Lógica de classificação
  if (dominantColors.length === 0) {
    // Colorless/Artifact
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

    // Classificação por tamanho
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
 * Inicializa centróides usando K-means++ (melhor inicialização que aleatória)
 */
function initializeCentroidsKMeansPlusPlus(vectors: DeckVector[], k: number): number[][] {
  const centroids: number[][] = [];
  
  // Escolher primeiro centróide aleatoriamente
  const firstIdx = Math.floor(Math.random() * vectors.length);
  centroids.push([...vectors[firstIdx].vector]);

  // Escolher os próximos k-1 centróides
  for (let i = 1; i < k; i++) {
    let maxDistance = 0;
    let nextCentroidIdx = 0;

    // Para cada ponto, calcular a distância para o centróide mais próximo
    vectors.forEach((vector, idx) => {
      let minDistToCentroid = Infinity;

      centroids.forEach(centroid => {
        const dist = euclideanDistance(vector.vector, centroid);
        minDistToCentroid = Math.min(minDistToCentroid, dist);
      });

      // Probabilidade de escolher este ponto é proporcional à sua distância
      const probability = minDistToCentroid * minDistToCentroid;
      if (probability > maxDistance) {
        maxDistance = probability;
        nextCentroidIdx = idx;
      }
    });

    centroids.push([...vectors[nextCentroidIdx].vector]);
  }

  return centroids;
}

/**
 * Implementação do algoritmo K-Means com K-means++ (inicialização melhorada)
 */
export function kMeansReal(vectors: DeckVector[], k: number, maxIterations: number = 150): { clusters: ClusterResult[]; stats: ClusteringStats } {
  if (vectors.length === 0 || k <= 0) {
    return { clusters: [], stats: { silhouetteScore: 0, calinskiHarabaszIndex: 0, daviesBouldinIndex: 0, inertia: 0, converged: false } };
  }

  // Limite máximo de K
  const adjustedK = Math.min(k, vectors.length);

  // Inicializar centróides usando K-means++
  let centroids = initializeCentroidsKMeansPlusPlus(vectors, adjustedK);

  let hasConverged = false;
  let iteration = 0;
  let assignments: number[] = [];

  console.log(`[KMeans] Starting K-Means++ with k=${adjustedK}, max_iterations=${maxIterations}`);

  while (!hasConverged && iteration < maxIterations) {
    // Atribuir vetores aos clusters mais próximos
    const newAssignments: number[] = [];
    vectors.forEach(vector => {
      let minDistance = Infinity;
      let closestCluster = 0;

      centroids.forEach((centroid, idx) => {
        const distance = euclideanDistance(vector.vector, centroid);
        if (distance < minDistance) {
          minDistance = distance;
          closestCluster = idx;
        }
      });

      newAssignments.push(closestCluster);
    });

    // Verificar convergência
    hasConverged = assignments.length > 0 && 
                   assignments.every((val, idx) => val === newAssignments[idx]);
    
    assignments = newAssignments;

    // Recalcular centróides
    const newCentroids: number[][] = [];
    for (let i = 0; i < adjustedK; i++) {
      const clusterVectors = vectors
        .filter((_, idx) => assignments[idx] === i)
        .map(v => v.vector);

      if (clusterVectors.length > 0) {
        newCentroids.push(calculateCentroid(clusterVectors));
      } else {
        // Se cluster ficar vazio, manter centróide anterior
        newCentroids.push([...centroids[i]]);
      }
    }

    centroids = newCentroids;
    iteration++;

    if (iteration % 10 === 0) {
      console.log(`[KMeans] Iteration ${iteration}...`);
    }
  }

  console.log(`[KMeans] Converged in ${iteration} iterations`);

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
    const clusterVectors = vectorIndices.map(i => vectors[i]);
    const centroid = centroids[clusterId];

    // Calcular distâncias intra-cluster
    const intraClusterDistances = vectorIndices.map(i =>
      euclideanDistance(vectors[i].vector, centroid)
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
    // Obter todos os decks competitivos
    const decks = await db.select().from(competitiveDecks);

    console.log(`[Clustering] Starting KMeans clustering with ${decks.length} decks, k=${k}`);

    // Converter decks para vetores
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

    // Executar KMeans com biblioteca real
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

    // a: distância média dentro do cluster
    const sameClusterVectors = vectors.filter(v =>
      cluster.deckIds.includes(v.deckId) && v.deckId !== vector.deckId
    );
    const a = sameClusterVectors.length > 0
      ? sameClusterVectors.reduce((sum, v) => sum + euclideanDistance(vector.vector, v.vector), 0) / sameClusterVectors.length
      : 0;

    // b: menor distância média para outros clusters
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

  // Encontrar o ponto de cotovelo (maior mudança de inércia)
  let optimalK = minK;
  let maxInertiaChange = 0;

  for (let i = 1; i < inertias.length; i++) {
    const change = inertias[i - 1] - inertias[i];
    if (change > maxInertiaChange) {
      maxInertiaChange = change;
      optimalK = minK + i - 1;
    }
  }

  // Alternativamente, considerar silhueta mais alta
  if (silhouettes.length > 0) {
    const maxSilhouetteIdx = silhouettes.indexOf(Math.max(...silhouettes));
    if (Math.max(...silhouettes) > 0.5) {
      optimalK = minK + maxSilhouetteIdx;
    }
  }

  console.log(`[Clustering] Optimal K found: ${optimalK}`);

  return { optimalK, inertias, silhouettes };
}
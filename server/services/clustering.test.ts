import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  kMeansReal,
  calculateCentroid,
  euclideanDistance,
  calculateClusteringMetrics,
  groupClustersByArchetype,
  DeckVector,
  ClusterResult,
} from "./clustering";

// Mock the database and embeddings
vi.mock("../db", () => ({
  getDb: vi.fn(),
}));

vi.mock("./embeddings", () => ({
  getCardEmbedding: vi.fn(),
}));

describe("Clustering Service (Real ML-KMeans)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("euclideanDistance", () => {
    it("should calculate correct distance between identical vectors", () => {
      const a = [1, 2, 3];
      const b = [1, 2, 3];
      expect(euclideanDistance(a, b)).toBe(0);
    });

    it("should calculate correct distance between different vectors", () => {
      const a = [0, 0, 0];
      const b = [3, 4, 0];
      expect(euclideanDistance(a, b)).toBe(5);
    });

    it("should return infinity for vectors of different lengths", () => {
      const a = [1, 2];
      const b = [1, 2, 3];
      expect(euclideanDistance(a, b)).toBe(Infinity);
    });
  });

  describe("calculateCentroid", () => {
    it("should calculate centroid of multiple vectors", () => {
      const vectors = [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ];
      const centroid = calculateCentroid(vectors);
      expect(centroid).toEqual([4, 5, 6]);
    });

    it("should return empty array for empty input", () => {
      const centroid = calculateCentroid([]);
      expect(centroid).toEqual([]);
    });
  });

  describe("kMeansReal avec ml-kmeans", () => {
    it("should cluster simple 2D data correctly using ml-kmeans++", () => {
      const vectors: DeckVector[] = [
        { deckId: 1, vector: [0, 0], colors: "W", format: "standard", cardCount: 60 },
        { deckId: 2, vector: [1, 1], colors: "W", format: "standard", cardCount: 60 },
        { deckId: 3, vector: [10, 10], colors: "R", format: "standard", cardCount: 60 },
        { deckId: 4, vector: [11, 11], colors: "R", format: "standard", cardCount: 60 },
      ];

      const { clusters, stats } = kMeansReal(vectors, 2, 10);

      expect(clusters).toHaveLength(2);
      expect(clusters[0].deckIds.length + clusters[1].deckIds.length).toBe(4);
      
      // Verify clustering quality metrics
      expect(stats.silhouetteScore).toBeGreaterThanOrEqual(-1);
      expect(stats.silhouetteScore).toBeLessThanOrEqual(1);
      expect(stats.inertia).toBeGreaterThanOrEqual(0);
    });

    it("should handle empty input", () => {
      const { clusters, stats } = kMeansReal([], 3);
      expect(clusters).toEqual([]);
      expect(stats.silhouetteScore).toBe(0);
    });

    it("should handle k=0", () => {
      const vectors: DeckVector[] = [
        { deckId: 1, vector: [0, 0], colors: "W", format: "standard", cardCount: 60 },
      ];
      const { clusters } = kMeansReal(vectors, 0);
      expect(clusters).toEqual([]);
    });

    it("should limit K to number of vectors", () => {
      const vectors: DeckVector[] = [
        { deckId: 1, vector: [0, 0], colors: "W", format: "standard", cardCount: 60 },
        { deckId: 2, vector: [1, 1], colors: "W", format: "standard", cardCount: 60 },
      ];

      const { clusters } = kMeansReal(vectors, 10);
      expect(clusters.length).toBeLessThanOrEqual(vectors.length);
    });
  });

  describe("calculateClusteringMetrics", () => {
    it("should calculate metrics for well-separated clusters", () => {
      const clusters: ClusterResult[] = [
        {
          clusterId: 0,
          deckIds: [1, 2],
          centroid: [0, 0],
          archetype: "W Aggro",
          confidence: 0.9,
          avgColors: "W",
          avgCardCount: 60,
          intraClusterDistance: 0.5,
          interClusterDistance: 14.1,
        },
        {
          clusterId: 1,
          deckIds: [3, 4],
          centroid: [10, 10],
          archetype: "R Aggro",
          confidence: 0.9,
          avgColors: "R",
          avgCardCount: 60,
          intraClusterDistance: 0.5,
          interClusterDistance: 14.1,
        },
      ];

      const vectors: DeckVector[] = [
        { deckId: 1, vector: [0, 0], colors: "W", format: "standard", cardCount: 60 },
        { deckId: 2, vector: [1, 1], colors: "W", format: "standard", cardCount: 60 },
        { deckId: 3, vector: [10, 10], colors: "R", format: "standard", cardCount: 60 },
        { deckId: 4, vector: [11, 11], colors: "R", format: "standard", cardCount: 60 },
      ];

      const metrics = calculateClusteringMetrics(clusters, vectors);

      expect(metrics.silhouetteScore).toBeGreaterThanOrEqual(-1);
      expect(metrics.silhouetteScore).toBeLessThanOrEqual(1);
      expect(metrics.calinskiHarabaszIndex).toBeGreaterThanOrEqual(0);
      expect(metrics.daviesBouldinIndex).toBeGreaterThanOrEqual(0);
    });

    it("should handle empty input", () => {
      const metrics = calculateClusteringMetrics([], []);
      expect(metrics.silhouetteScore).toBe(0);
      expect(metrics.calinskiHarabaszIndex).toBe(0);
      expect(metrics.daviesBouldinIndex).toBe(0);
      expect(metrics.converged).toBe(true);
    });
  });

  describe("groupClustersByArchetype", () => {
    it("should group clusters by archetype name", () => {
      const clusters: ClusterResult[] = [
        {
          clusterId: 0,
          deckIds: [1, 2],
          centroid: [0, 0],
          archetype: "R Aggro",
          confidence: 0.9,
          avgColors: "R",
          avgCardCount: 40,
          intraClusterDistance: 0.5,
          interClusterDistance: 10,
        },
        {
          clusterId: 1,
          deckIds: [3, 4],
          centroid: [10, 10],
          archetype: "R Aggro",
          confidence: 0.9,
          avgColors: "R",
          avgCardCount: 42,
          intraClusterDistance: 0.5,
          interClusterDistance: 10,
        },
        {
          clusterId: 2,
          deckIds: [5, 6],
          centroid: [20, 20],
          archetype: "U Control",
          confidence: 0.85,
          avgColors: "U",
          avgCardCount: 65,
          intraClusterDistance: 0.6,
          interClusterDistance: 15,
        },
      ];

      const grouped = groupClustersByArchetype(clusters);
      expect(grouped.size).toBe(2);
      expect(grouped.get("R Aggro")).toHaveLength(2);
      expect(grouped.get("U Control")).toHaveLength(1);
    });
  });
});
import { describe, it, expect } from "vitest";
import { cosineSimilarity } from "./embeddings";

describe("Embeddings", () => {
  it("should calculate cosine similarity between identical vectors as 1", () => {
    const vector = [1, 0, 0];
    const similarity = cosineSimilarity(vector, vector);
    expect(similarity).toBeCloseTo(1, 5);
  });

  it("should calculate cosine similarity between orthogonal vectors as 0", () => {
    const vector1 = [1, 0, 0];
    const vector2 = [0, 1, 0];
    const similarity = cosineSimilarity(vector1, vector2);
    expect(similarity).toBeCloseTo(0, 5);
  });

  it("should calculate cosine similarity between opposite vectors as -1", () => {
    const vector1 = [1, 0, 0];
    const vector2 = [-1, 0, 0];
    const similarity = cosineSimilarity(vector1, vector2);
    expect(similarity).toBeCloseTo(-1, 5);
  });

  it("should calculate cosine similarity between similar vectors as high", () => {
    const vector1 = [1, 1, 0];
    const vector2 = [1, 1, 0];
    const similarity = cosineSimilarity(vector1, vector2);
    expect(similarity).toBeCloseTo(1, 5);
  });

  it("should handle vectors of different lengths by returning 0", () => {
    const vector1 = [1, 0];
    const vector2 = [1, 0, 0];
    const similarity = cosineSimilarity(vector1, vector2);
    expect(similarity).toBe(0);
  });

  it("should handle zero vectors", () => {
    const vector1 = [0, 0, 0];
    const vector2 = [0, 0, 0];
    const similarity = cosineSimilarity(vector1, vector2);
    expect(similarity).toBe(0); // 0/0 = 0
  });

  it("should calculate correct similarity for normalized vectors", () => {
    const vector1 = [0.6, 0.8, 0];
    const vector2 = [0.6, 0.8, 0];
    const similarity = cosineSimilarity(vector1, vector2);
    expect(similarity).toBeCloseTo(1, 5);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeTrainingPool, isArenaOnlyTraining } from "./poolFilter";

/**
 * The helper reads `process.env.TRAINING_POOL_ARENA_ONLY` at every call,
 * so the tests just toggle the env var and assert the result. Each test
 * snapshot/restores the original value so cross-test contamination is
 * impossible.
 */
describe("poolFilter", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.TRAINING_POOL_ARENA_ONLY;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TRAINING_POOL_ARENA_ONLY;
    } else {
      process.env.TRAINING_POOL_ARENA_ONLY = original;
    }
  });

  describe("isArenaOnlyTraining", () => {
    it("returns false when env var is unset", () => {
      delete process.env.TRAINING_POOL_ARENA_ONLY;
      expect(isArenaOnlyTraining()).toBe(false);
    });

    it("returns false when env var is empty string", () => {
      process.env.TRAINING_POOL_ARENA_ONLY = "";
      expect(isArenaOnlyTraining()).toBe(false);
    });

    it.each(["1", "true", "yes", "on", "TRUE", "True", "Yes", "On", " 1 "])(
      "returns true for truthy value %j",
      (value) => {
        process.env.TRAINING_POOL_ARENA_ONLY = value;
        expect(isArenaOnlyTraining()).toBe(true);
      }
    );

    it.each(["0", "false", "no", "off", "anything-else", "2", "FALSE"])(
      "returns false for non-truthy value %j",
      (value) => {
        process.env.TRAINING_POOL_ARENA_ONLY = value;
        expect(isArenaOnlyTraining()).toBe(false);
      }
    );
  });

  describe("describeTrainingPool", () => {
    it("returns 'Full catalog' when the flag is off", () => {
      delete process.env.TRAINING_POOL_ARENA_ONLY;
      expect(describeTrainingPool()).toBe("Full catalog");
    });

    it("returns 'Arena-only' when the flag is on", () => {
      process.env.TRAINING_POOL_ARENA_ONLY = "1";
      expect(describeTrainingPool()).toBe("Arena-only");
    });
  });
});

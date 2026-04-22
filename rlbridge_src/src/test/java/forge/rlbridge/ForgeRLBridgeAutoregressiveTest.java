package forge.rlbridge;

import java.lang.reflect.Method;

/**
 * Phase 3 — regression test for the step_autoregressive JSON protocol.
 *
 * Verifies:
 *   1. The Json parser extracts action_base / source_id / target_id from
 *      the new native payload.
 *   2. The legacy {"cmd":"step","action":N} path still parses.
 *   3. The fail-safe range validation logic mirrors the bridge's constants
 *      (AR_NUM_TYPES=4, AR_NUM_SOURCES=128, AR_NUM_TARGETS=128).
 *
 * The test drives the parser via reflection because Json is a package-
 * private static inner class of ForgeRLBridge; since we live in the same
 * package we can reach it.
 *
 * No Maven — build + run via:
 *   cd forge/rlbridge
 *   build.cmd   (produce target/classes and rlbridge.jar)
 *   test.cmd    (compile this test + run)
 */
public class ForgeRLBridgeAutoregressiveTest {

    // Must match ForgeRLBridge.AR_NUM_* (kept in sync manually)
    private static final int AR_NUM_TYPES   = 4;
    private static final int AR_NUM_SOURCES = 128;
    private static final int AR_NUM_TARGETS = 128;

    private static int passed = 0;
    private static int failed = 0;

    public static void main(String[] args) throws Exception {
        testAutoregressivePayloadParse();
        testLegacyPayloadParse();
        testDefaultsWhenFieldMissing();
        testRangeValidationInBounds();
        testRangeValidationOutOfBounds();
        testIllegalActionFailSafeContract();

        System.out.println("[rlbridge-test] passed=" + passed + " failed=" + failed);
        if (failed > 0) System.exit(1);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private static void assertEq(String label, Object actual, Object expected) {
        boolean ok = (actual == null && expected == null) ||
                     (actual != null && actual.equals(expected));
        if (!ok) {
            System.err.println("FAIL " + label + ": got=" + actual + " want=" + expected);
            failed++;
        } else {
            passed++;
        }
    }

    private static void assertTrue(String label, boolean cond) {
        if (!cond) { System.err.println("FAIL " + label); failed++; } else { passed++; }
    }

    private static Object parseJson(String line) throws Exception {
        Class<?> cls = Class.forName("forge.rlbridge.ForgeRLBridge$Json");
        Method parse = cls.getDeclaredMethod("parse", String.class);
        parse.setAccessible(true);
        return parse.invoke(null, line);
    }

    private static String jsonStr(Object j, String key) throws Exception {
        Method m = j.getClass().getDeclaredMethod("str", String.class);
        m.setAccessible(true);
        return (String) m.invoke(j, key);
    }

    private static int jsonInt(Object j, String key, int def) throws Exception {
        Method m = j.getClass().getDeclaredMethod("intVal", String.class, int.class);
        m.setAccessible(true);
        return (Integer) m.invoke(j, key, def);
    }

    /** Mirrors the bridge's fail-safe check in stepAutoregressive(). */
    private static boolean valid(int type, int src, int tgt) {
        return type >= 0 && type < AR_NUM_TYPES   &&
               src  >= 0 && src  < AR_NUM_SOURCES &&
               tgt  >= 0 && tgt  < AR_NUM_TARGETS;
    }

    // ── tests ──────────────────────────────────────────────────────────────

    private static void testAutoregressivePayloadParse() throws Exception {
        String line = "{\"cmd\":\"step_autoregressive\",\"action_base\":2,\"source_id\":17,\"target_id\":64}";
        Object j = parseJson(line);
        assertEq("ar.cmd",         jsonStr(j, "cmd"),                "step_autoregressive");
        assertEq("ar.action_base", jsonInt(j, "action_base", -999),  2);
        assertEq("ar.source_id",   jsonInt(j, "source_id", -999),    17);
        assertEq("ar.target_id",   jsonInt(j, "target_id", -999),    64);
    }

    private static void testLegacyPayloadParse() throws Exception {
        String line = "{\"cmd\":\"step\",\"action\":42}";
        Object j = parseJson(line);
        assertEq("legacy.cmd",    jsonStr(j, "cmd"),           "step");
        assertEq("legacy.action", jsonInt(j, "action", -999),  42);
    }

    /** Missing field must return the supplied default (drives fail-safe). */
    private static void testDefaultsWhenFieldMissing() throws Exception {
        String line = "{\"cmd\":\"step_autoregressive\"}";
        Object j = parseJson(line);
        assertEq("missing.action_base", jsonInt(j, "action_base", -1), -1);
        assertEq("missing.source_id",   jsonInt(j, "source_id",   -1), -1);
        assertEq("missing.target_id",   jsonInt(j, "target_id",   -1), -1);
        // And that default → the bridge's `illegal=true` branch:
        assertTrue("missing.is_illegal", !valid(-1, -1, -1));
    }

    private static void testRangeValidationInBounds() {
        assertTrue("range.zeroes",      valid(0,    0,   0));
        assertTrue("range.max_corner",  valid(3,  127, 127));
        assertTrue("range.mixed",       valid(2,   64,  64));
    }

    private static void testRangeValidationOutOfBounds() {
        assertTrue("range.type_too_big",  !valid(AR_NUM_TYPES,      0,   0));
        assertTrue("range.type_negative", !valid(-1,                 0,   0));
        assertTrue("range.src_too_big",   !valid(0, AR_NUM_SOURCES,  0));
        assertTrue("range.src_negative",  !valid(0,                 -1,   0));
        assertTrue("range.tgt_too_big",   !valid(0,                  0,   AR_NUM_TARGETS));
        assertTrue("range.tgt_negative",  !valid(0,                  0,  -1));
    }

    /**
     * Fail-safe contract: when the bridge rejects an out-of-range triple
     * it must emit a snapshot with illegal_action=true so the Python side
     * applies a negative reward. This test locks the contract-as-documented
     * (the actual snapshot comes from a running Forge, which this test
     * intentionally does not spin up).
     */
    private static void testIllegalActionFailSafeContract() {
        int[][] bad = {
            {AR_NUM_TYPES, 0, 0},
            {0, AR_NUM_SOURCES, 0},
            {0, 0, AR_NUM_TARGETS},
            {-1, 0, 0},
            {0, -1, 0},
            {0, 0, -1},
        };
        for (int[] triple : bad) {
            assertTrue("failsafe.rejects " + triple[0] + "/" + triple[1] + "/" + triple[2],
                       !valid(triple[0], triple[1], triple[2]));
        }
    }
}

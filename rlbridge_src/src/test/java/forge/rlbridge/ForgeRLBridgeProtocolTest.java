package forge.rlbridge;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Random;

/**
 * Forge-free protocol tests. CI compiles this with javac and runs {@code main}
 * without the Forge fat jar. {@code test.cmd} runs it beside the reflection
 * tests once the jar is present.
 */
public class ForgeRLBridgeProtocolTest {

    private static int passed;
    private static int failed;

    public static void main(String[] args) throws Exception {
        testHelloEnvelope();
        testOnlyPassWhenNothingIsPayable();
        testPagingPast509();
        testReseedStaticRandoms();
        testIllegalDoesNotAdvance();
        testStaleDecisionDoesNotApply();
        testMissingBindingDropsPlantedState();
        testTimeoutDropsLatePublish();
        testDeterministicTrajectory();
        System.out.println("[rlbridge-protocol] passed=" + passed + " failed=" + failed);
        if (failed > 0) System.exit(1);
    }

    private static void testHelloEnvelope() {
        String hello = ProtocolV2.helloResponse(1, 0);
        assertTrue("hello protocol", hello.contains("\"protocol\":2"));
        assertTrue("hello policy_control", hello.contains("\"policy_control\""));
        assertTrue("hello seed", hello.contains("\"seed\""));
        assertTrue("hello legal_mask", hello.contains("\"legal_mask\""));
        assertTrue("hello decision_points", hello.contains("\"decision_points\""));
        assertTrue("hello commit", hello.contains("\"forge_commit\":\"7cc4ff7b\""));
        assertTrue("hello version", hello.contains("\"bridge_version\":\"rlbridge-v2.0.0\""));
        String error = ProtocolV2.errorResponse(null, "BAD_REQUEST", "missing request_id", null, null);
        assertTrue("error type", error.contains("\"type\":\"error\""));
        assertTrue("error null id", error.contains("\"request_id\":null"));
        assertTrue("fatal mismatch", ProtocolV2.fatal("PROTOCOL_MISMATCH"));
        assertTrue("stale not fatal", !ProtocolV2.fatal("STALE_DECISION"));
    }

    private static void testOnlyPassWhenNothingIsPayable() {
        ProtocolV2.Layout layout = ProtocolV2.onlyPassWhenUnpayable(new boolean[] {false, false, false});
        assertEq("only pass slot 0", layout.mask[0], 1);
        int legal = 0;
        for (int bit : layout.mask) legal += bit;
        assertEq("only one legal", legal, 1);
        ProtocolV2.Layout payable = ProtocolV2.onlyPassWhenUnpayable(new boolean[] {false, true});
        assertEq("payable spell", payable.mask[1], 1);
        assertEq("payable kind", payable.kinds[1], 1);
    }

    private static void testPagingPast509() {
        List<ProtocolV2.Option> options = new ArrayList<>();
        for (int i = 0; i < 600; i++) options.add(new ProtocolV2.Option(1, 0, -1, "opt" + i));
        ProtocolV2.Layout first = ProtocolV2.layout(options, 0, true);
        assertEq("page next on", first.mask[ProtocolV2.PAGE_NEXT], 1);
        assertEq("page next kind", first.kinds[ProtocolV2.PAGE_NEXT], 7);
        assertEq("page prev off", first.mask[ProtocolV2.PAGE_PREV], 0);
        assertEq("first page last option", first.optionIndex[509], 508);
        ProtocolV2.Layout second = ProtocolV2.layout(options, 1, true);
        assertEq("page prev on", second.mask[ProtocolV2.PAGE_PREV], 1);
        assertEq("page prev kind", second.kinds[ProtocolV2.PAGE_PREV], 6);
        assertEq("second page first option", second.optionIndex[1], 509);
        assertTrue("actions mention slot", first.actionsJson.contains("\"slot\":511"));
    }

    private static void testReseedStaticRandoms() {
        long seed = 99L;
        int n = ProtocolV2.reseedStaticRandoms(seed, RngBox.class);
        assertEq("two static Random fields", n, 2);
        int a = RngBox.alpha.nextInt();
        int b = RngBox.beta.nextInt();
        ProtocolV2.reseedStaticRandoms(seed, RngBox.class);
        assertEq("alpha replay", RngBox.alpha.nextInt(), a);
        assertEq("beta replay", RngBox.beta.nextInt(), b);
        long[] sources = ProtocolV2.sourceSeeds(seed);
        assertEq("six rng sources", sources.length, ProtocolV2.RNG_SOURCES.length);
        assertTrue("sources differ", sources[0] != sources[1]);
    }

    private static void testIllegalDoesNotAdvance() throws Exception {
        DecisionHandoff handoff = new DecisionHandoff();
        Holder<Integer> seen = new Holder<>();
        Thread game = new Thread(() -> {
            try {
                seen.value = handoff.publishAndAwaitAction(offer("priority", 1, 11));
                if (seen.value != null && seen.value >= 0) {
                    handoff.publishTerminal(offer("none", 50, 1));
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                seen.value = -2;
            }
        });
        game.start();
        DecisionHandoff.Reply first = handoff.awaitFirst(1, 2000);
        assertTrue("first bound", first.json.contains("\"request_id\":1"));
        int decision = jsonInt(first.json, "decision_id");
        String hash = jsonString(first.json, "state_hash");
        DecisionHandoff.Reply illegal = handoff.step(2, decision, 4, 2000);
        assertTrue("illegal flag", illegal.illegal);
        assertTrue("illegal not applied", !illegal.applied);
        assertEq("same decision", jsonInt(illegal.json, "decision_id"), decision);
        assertEq("same hash", jsonString(illegal.json, "state_hash"), hash);
        assertTrue("illegal request", illegal.json.contains("\"request_id\":2"));
        Thread.sleep(40);
        assertTrue("game still blocked", game.isAlive());
        DecisionHandoff.Reply legal = handoff.step(3, decision, 1, 2000);
        game.join(2000);
        assertEq("applied the legal slot", seen.value == null ? -1 : seen.value, 1);
        assertTrue("legal applied", legal.applied);
        assertTrue("advanced decision", jsonInt(legal.json, "decision_id") != decision);
    }

    private static void testStaleDecisionDoesNotApply() throws Exception {
        DecisionHandoff handoff = new DecisionHandoff();
        Thread game = new Thread(() -> {
            try {
                handoff.publishAndAwaitAction(offer("priority", 2, 3));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        game.start();
        DecisionHandoff.Reply first = handoff.awaitFirst(1, 2000);
        int decision = jsonInt(first.json, "decision_id");
        DecisionHandoff.Reply stale = handoff.step(2, decision + 9, 1, 200);
        assertTrue("stale code", "STALE_DECISION".equals(stale.code));
        assertTrue("stale not applied", !stale.applied);
        Thread.sleep(30);
        assertTrue("stale left the game blocked", game.isAlive());
        handoff.discardMatch();
        game.join(2000);
    }

    private static void testMissingBindingDropsPlantedState() throws Exception {
        DecisionHandoff handoff = new DecisionHandoff();
        DecisionHandoff.Offer planted = offer("priority", 5, 77);
        handoff.plant(planted, 1L);
        String plantedHash = planted.stateHash;
        DecisionHandoff.Reply reply = handoff.awaitFirst(2, 80);
        assertTrue("mismatch dropped", reply.dropped || reply.timedOut);
        assertTrue("planted hash not delivered", !reply.json.contains(plantedHash));
        assertTrue("counted the drop", handoff.droppedMismatches() > 0);
    }

    private static void testTimeoutDropsLatePublish() throws Exception {
        DecisionHandoff handoff = new DecisionHandoff();
        handoff.discardMatch();
        int late = handoff.publishAndAwaitAction(offer("priority", 8, 8));
        assertEq("late publish dropped", late, -1);
        DecisionHandoff.Reply reply = handoff.step(4, 0, 0, 50);
        assertTrue("timeout after discard", reply.timedOut);
        assertTrue("late body absent", !reply.json.contains("\"marker\":8"));
    }

    private static void testDeterministicTrajectory() throws Exception {
        int[] actions = {1, 0, 1};
        String a = play(123456789L, actions);
        String b = play(123456789L, actions);
        String c = play(123456790L, actions);
        assertEq("same seed same trajectory", a, b);
        assertTrue("different seed differs", !a.equals(c));
    }

    private static String play(long seed, int[] actions) throws Exception {
        DecisionHandoff handoff = new DecisionHandoff();
        Random shuffle = ProtocolV2.shuffleRandom(seed);
        Random ai = ProtocolV2.aiRandom(seed);
        Random javaRng = ProtocolV2.javaRandom(seed);
        Thread game = new Thread(() -> {
            try {
                for (int i = 0; i < actions.length; i++) {
                    int draw = shuffle.nextInt(10000) ^ ai.nextInt(10000) ^ javaRng.nextInt(10000);
                    int chosen = handoff.publishAndAwaitAction(offer("priority", i, draw));
                    if (chosen < 0) return;
                }
                handoff.publishTerminal(offer("none", 99, shuffle.nextInt(10000)));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        game.start();
        DecisionHandoff.Reply reply = handoff.awaitFirst(1, 2000);
        long request = 2;
        for (int action : actions) {
            int decision = jsonInt(reply.json, "decision_id");
            reply = handoff.step(request++, decision, action, 2000);
            if (reply.timedOut || reply.staleDecision) {
                throw new AssertionError(reply.json);
            }
        }
        game.join(2000);
        return handoff.trajectoryHash();
    }

    private static DecisionHandoff.Offer offer(String kind, int marker, int draw) {
        int[] mask = new int[ProtocolV2.NUM_ACTIONS];
        mask[0] = 1;
        mask[1] = 1;
        String json = "{\"type\":\"state\",\"decision_id\":-1,\"state_hash\":\"PENDING\""
            + ",\"protocol\":2,\"policy_action_applied\":null,\"illegal_action\":false"
            + ",\"decision_kind\":\"" + kind + "\",\"marker\":" + marker + ",\"draw\":" + draw + "}";
        return new DecisionHandoff.Offer(kind, json, mask, "none".equals(kind));
    }

    private static int jsonInt(String json, String key) {
        String needle = "\"" + key + "\":";
        int start = json.indexOf(needle);
        if (start < 0) return -999;
        start += needle.length();
        int end = start;
        if (end < json.length() && json.charAt(end) == '-') end++;
        while (end < json.length() && Character.isDigit(json.charAt(end))) end++;
        return Integer.parseInt(json.substring(start, end));
    }

    private static String jsonString(String json, String key) {
        String needle = "\"" + key + "\":\"";
        int start = json.indexOf(needle);
        if (start < 0) return "";
        start += needle.length();
        return json.substring(start, json.indexOf('"', start));
    }

    private static void assertEq(String label, Object actual, Object expected) {
        if (actual == null ? expected == null : actual.equals(expected)) passed++;
        else {
            failed++;
            System.err.println("FAIL " + label + ": got=" + actual + " want=" + expected);
        }
    }

    private static void assertTrue(String label, boolean cond) {
        if (cond) passed++;
        else {
            failed++;
            System.err.println("FAIL " + label);
        }
    }

    static final class RngBox {
        static Random alpha = new Random(1);
        static Random beta = new Random(2);
    }

    static final class Holder<T> {
        T value;
    }
}

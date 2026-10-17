package forge.rlbridge;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Binds each state to the request that is waiting for it.
 *
 * <p>The game thread publishes one offer and blocks until the client accepts
 * a legal action. The stdin thread never re-tags a queued snapshot: a state
 * produced for a different request is dropped, an illegal action returns a
 * copy of the current decision without waking the game, and a timeout
 * discards the match so a late publish cannot satisfy the next command.
 */
public final class DecisionHandoff {

    public static final class Offer {
        public final String decisionKind;
        /** Snapshot JSON with {@code decision_id:-1} and {@code state_hash:PENDING}. */
        public final String stateJson;
        public final int[] mask;
        public final boolean terminal;
        int decisionId = -1;
        long boundRequest = -1;
        String stateHash = "";

        public Offer(String decisionKind, String stateJson, int[] mask, boolean terminal) {
            this.decisionKind = decisionKind;
            this.stateJson = stateJson;
            this.mask = Arrays.copyOf(mask, ProtocolV2.NUM_ACTIONS);
            this.terminal = terminal;
        }
    }

    public static final class Reply {
        public final String json;
        public final boolean applied;
        public final boolean illegal;
        public final boolean staleDecision;
        public final boolean timedOut;
        public final boolean dropped;
        public final String code;

        Reply(String json, boolean applied, boolean illegal, boolean staleDecision,
              boolean timedOut, boolean dropped, String code) {
            this.json = json;
            this.applied = applied;
            this.illegal = illegal;
            this.staleDecision = staleDecision;
            this.timedOut = timedOut;
            this.dropped = dropped;
            this.code = code;
        }
    }

    private final Object lock = new Object();
    private Offer pending;
    private boolean actionAccepted;
    private int acceptedAction = -1;
    private boolean discard;
    private int nextDecisionId;
    private long waiterRequest = -1;
    private int policyDecisions;
    private int droppedMismatches;
    private int epoch;
    private final List<String> trajectory = new ArrayList<>();

    public int epoch() {
        synchronized (lock) {
            return epoch;
        }
    }

    /**
     * Open a fresh generation. A publish that still carries the previous
     * epoch is dropped, including one that arrives after this returns.
     */
    public void reset() {
        synchronized (lock) {
            epoch++;
            clearLocked(false);
        }
    }

    /** Close the current match. The old game thread must not publish into the next one. */
    public void endMatch() {
        synchronized (lock) {
            epoch++;
            clearLocked(true);
        }
    }

    /** Re-open the handoff after {@link #endMatch()}. Does not move the epoch. */
    public int beginMatch() {
        synchronized (lock) {
            clearLocked(false);
            return epoch;
        }
    }

    private void clearLocked(boolean discarded) {
        pending = null;
        actionAccepted = false;
        acceptedAction = -1;
        discard = discarded;
        nextDecisionId = 0;
        waiterRequest = -1;
        policyDecisions = 0;
        trajectory.clear();
        lock.notifyAll();
    }

    public boolean isDiscarded() {
        synchronized (lock) {
            return discard;
        }
    }

    public int policyDecisions() {
        synchronized (lock) {
            return policyDecisions;
        }
    }

    public int droppedMismatches() {
        synchronized (lock) {
            return droppedMismatches;
        }
    }

    public String trajectoryHash() {
        synchronized (lock) {
            return ProtocolV2.trajectoryHash(trajectory);
        }
    }

    public List<String> trajectory() {
        synchronized (lock) {
            return new ArrayList<>(trajectory);
        }
    }

    /** Test hook: leave a state tagged for {@code boundTo} so a later request must drop it. */
    void plant(Offer offer, long boundTo) {
        synchronized (lock) {
            assign(offer, boundTo);
            pending = offer;
            lock.notifyAll();
        }
    }

    /**
     * Game thread. Blocks until a legal action is accepted. Returns -1 when
     * the match was discarded, including a publish that arrives after the
     * discard (the late state is not stored).
     */
    public int publishAndAwaitAction(Offer offer) throws InterruptedException {
        return publishAndAwaitAction(offer, epoch());
    }

    /**
     * Game thread. {@code offerEpoch} is the match that produced this state.
     * A publish from an older match returns -1 and is not stored, even when
     * it arrives after {@link #reset()} or {@link #beginMatch()}.
     */
    public int publishAndAwaitAction(Offer offer, int offerEpoch) throws InterruptedException {
        synchronized (lock) {
            if (discard || offerEpoch != epoch) {
                droppedMismatches++;
                return -1;
            }
            assign(offer, waiterRequest);
            pending = offer;
            lock.notifyAll();
            while (!actionAccepted && !discard && offerEpoch == epoch) {
                lock.wait();
            }
            if (discard || offerEpoch != epoch || !actionAccepted) {
                if (pending == offer) pending = null;
                droppedMismatches++;
                return -1;
            }
            int action = acceptedAction;
            actionAccepted = false;
            acceptedAction = -1;
            if (pending == offer) pending = null;
            policyDecisions++;
            trajectory.add(offer.decisionId + "|" + offer.stateHash + "|" + action);
            lock.notifyAll();
            return action;
        }
    }

    /** Unblocks a waiter with a terminal snapshot and does not expect an action. */
    public void publishTerminal(Offer offer) {
        publishTerminal(offer, epoch());
    }

    public void publishTerminal(Offer offer, int offerEpoch) {
        synchronized (lock) {
            if (discard || offerEpoch != epoch) {
                droppedMismatches++;
                return;
            }
            assign(offer, waiterRequest);
            pending = offer;
            lock.notifyAll();
        }
    }

    /**
     * Unblock the waiter with a schema-valid engine failure and discard the
     * match. A bridge bug must not be played by the Forge AI.
     */
    public void failEngine(int offerEpoch) {
        synchronized (lock) {
            if (offerEpoch != epoch) {
                droppedMismatches++;
                return;
            }
            String json = "{\"type\":\"state\",\"decision_id\":-1,\"state_hash\":\"PENDING\""
                + ",\"protocol\":2,\"bridge_version\":\"" + ProtocolV2.BRIDGE_VERSION + "\""
                + ",\"decision_kind\":\"none\""
                + ",\"policy_controlled\":true,\"policy_action_applied\":null"
                + ",\"terminal\":true,\"truncated\":true,\"truncation_reason\":\"engine_error\""
                + ",\"outcome\":null,\"illegal_action\":false,\"turn\":0,\"phase\":\"\""
                + ",\"action_mask\":[" + zeros(0) + "]"
                + ",\"action_source_indices\":[" + zeros(-1) + "]"
                + ",\"action_target_indices\":[" + zeros(-1) + "]"
                + ",\"action_kinds\":[" + zeros(0) + "]}";
            Offer offer = new Offer("none", json, new int[ProtocolV2.NUM_ACTIONS], true);
            assign(offer, waiterRequest);
            pending = offer;
            discard = true;
            actionAccepted = false;
            lock.notifyAll();
        }
    }

    public Reply awaitFirst(long requestId, long timeoutMs) throws InterruptedException {
        synchronized (lock) {
            waiterRequest = requestId;
            lock.notifyAll();
            if (!waitForOwned(requestId, timeoutMs)) {
                return timeoutReply(requestId);
            }
            return render(pending, requestId, null, false);
        }
    }

    public Reply step(long requestId, int decisionId, int action, long timeoutMs) throws InterruptedException {
        synchronized (lock) {
            if (discard) return timeoutReply(requestId);
            if (pending == null && !waitForOwned(requestId, timeoutMs)) {
                return timeoutReply(requestId);
            }
            if (pending == null) return timeoutReply(requestId);
            if (pending.boundRequest != -1 && pending.boundRequest != requestId
                    && pending.decisionId != decisionId) {
                dropPending();
                return error(requestId, "STALE_DECISION", "state was bound to a different request",
                    decisionId, null, true);
            }
            if (pending.decisionId != decisionId) {
                return error(requestId, "STALE_DECISION",
                    "decision_id does not match the pending decision",
                    decisionId, pending.decisionId, false);
            }
            if (action < 0 || action >= ProtocolV2.NUM_ACTIONS || pending.mask[action] == 0) {
                return render(pending, requestId, Boolean.FALSE, true);
            }
            if (pending.terminal) {
                return render(pending, requestId, Boolean.FALSE, true);
            }
            String actedHash = pending.stateHash;
            int actedId = pending.decisionId;
            acceptedAction = action;
            actionAccepted = true;
            pending = null;
            waiterRequest = requestId;
            lock.notifyAll();
            if (!waitForOwned(requestId, timeoutMs)) {
                return timeoutReply(requestId);
            }
            if (pending.stateHash.equals(actedHash) && pending.decisionId == actedId
                    && pending.boundRequest != requestId) {
                dropPending();
                return error(requestId, "STALE_DECISION", "stale state reused for a new request",
                    decisionId, actedId, true);
            }
            return render(pending, requestId, Boolean.TRUE, false);
        }
    }

    public void discardMatch() {
        synchronized (lock) {
            discard = true;
            pending = null;
            actionAccepted = false;
            lock.notifyAll();
        }
    }

    private void assign(Offer offer, long boundTo) {
        offer.decisionId = nextDecisionId++;
        offer.boundRequest = boundTo;
        String withId = offer.stateJson.replace("\"decision_id\":-1", "\"decision_id\":" + offer.decisionId);
        offer.stateHash = ProtocolV2.sha256(withId);
    }

    private boolean waitForOwned(long requestId, long timeoutMs) throws InterruptedException {
        long deadline = timeoutMs < 0 ? Long.MAX_VALUE : System.nanoTime() + timeoutMs * 1_000_000L;
        while (true) {
            if (pending != null) {
                if (pending.boundRequest != -1 && pending.boundRequest != requestId) {
                    dropPending();
                    continue;
                }
                pending.boundRequest = requestId;
                return true;
            }
            if (discard) return false;
            long remaining = deadline - System.nanoTime();
            if (timeoutMs >= 0 && remaining <= 0) {
                discardMatch();
                return false;
            }
            if (timeoutMs < 0) lock.wait();
            else lock.wait(Math.max(1L, remaining / 1_000_000L));
        }
    }

    private void dropPending() {
        pending = null;
        droppedMismatches++;
        lock.notifyAll();
    }

    private Reply timeoutReply(long requestId) {
        discardMatch();
        String json = "{\"type\":\"state\",\"request_id\":" + requestId
            + ",\"protocol\":2,\"bridge_version\":\"" + ProtocolV2.BRIDGE_VERSION + "\""
            + ",\"decision_id\":0,\"decision_kind\":\"none\""
            + ",\"policy_controlled\":true,\"policy_action_applied\":false"
            + ",\"terminal\":false,\"truncated\":true,\"truncation_reason\":\"step_timeout\""
            + ",\"outcome\":null,\"illegal_action\":false,\"turn\":0,\"phase\":\"\""
            + ",\"action_mask\":[" + zeros(0) + "]"
            + ",\"action_source_indices\":[" + zeros(-1) + "]"
            + ",\"action_target_indices\":[" + zeros(-1) + "]"
            + ",\"action_kinds\":[" + zeros(0) + "]}";
        // A live mask of all zeros is only legal because truncated is true.
        return new Reply(json, false, false, false, true, true, "DECISION_TIMEOUT");
    }

    private static String zeros(int value) {
        StringBuilder sb = new StringBuilder(NUM_COMMAS());
        for (int i = 0; i < ProtocolV2.NUM_ACTIONS; i++) {
            if (i > 0) sb.append(',');
            sb.append(value);
        }
        return sb.toString();
    }

    private static int NUM_COMMAS() { return ProtocolV2.NUM_ACTIONS * 2; }

    private Reply error(long requestId, String code, String message,
                        int decisionId, Integer expected, boolean dropped) {
        return new Reply(
            ProtocolV2.errorResponse(requestId, code, message, decisionId, expected),
            false, false, true, false, dropped, code);
    }

    private Reply render(Offer offer, long requestId, Boolean applied, boolean illegal) {
        String body = offer.stateJson;
        body = body.replace("\"decision_id\":-1", "\"decision_id\":" + offer.decisionId);
        body = body.replace("\"state_hash\":\"PENDING\"", "\"state_hash\":\"" + offer.stateHash + "\"");
        if (illegal) body = body.replace("\"illegal_action\":false", "\"illegal_action\":true");
        String appliedJson = applied == null ? "null" : applied.toString();
        body = body.replace("\"policy_action_applied\":null", "\"policy_action_applied\":" + appliedJson);
        if (!body.contains("\"request_id\"")) {
            int brace = body.lastIndexOf('}');
            body = body.substring(0, brace) + ",\"request_id\":" + requestId + "}";
        }
        return new Reply(body, Boolean.TRUE.equals(applied), illegal, false, false, false, null);
    }
}

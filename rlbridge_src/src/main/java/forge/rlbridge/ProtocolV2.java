package forge.rlbridge;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Random;

/**
 * Forge-free protocol v2 helpers: version, error envelope, action layout,
 * and the seeds for every RNG the bridge and the Python env share.
 *
 * <p>Kind numbers match {@code ml_engine/ray_cluster/env.py}: 0 pass, 1 play,
 * 2 attack, 3 block, 4 target, 5 activate, 6 previous page, 7 next page.
 * Targets -2 and -3 are the agent and the opponent.
 */
public final class ProtocolV2 {

    public static final int PROTOCOL_VERSION = 2;
    public static final String BRIDGE_VERSION = "rlbridge-v2.0.0";
    public static final String FORGE_COMMIT = "7cc4ff7b";
    public static final int NUM_ACTIONS = 512;
    public static final int PAGE_SIZE = 509;
    public static final int PAGE_PREV = 510;
    public static final int PAGE_NEXT = 511;

    /** Sources named by the phase-1 contract. Each gets its own derived seed. */
    public static final String[] RNG_SOURCES = {
        "java", "forge.shuffle", "forge.ai", "python", "torch", "numpy"
    };

    public static final String[] TRAINING_CAPABILITIES = {
        "policy_control", "seed", "legal_mask", "decision_points"
    };

    private ProtocolV2() {}

    public static long mix(long seed, String source) {
        long mixed = seed;
        byte[] bytes = source.getBytes(StandardCharsets.UTF_8);
        for (byte b : bytes) {
            mixed = mixed * 0x9E3779B97F4A7C15L + (b & 0xff);
        }
        return mixed;
    }

    public static long[] sourceSeeds(long seed) {
        long[] out = new long[RNG_SOURCES.length];
        for (int i = 0; i < RNG_SOURCES.length; i++) {
            out[i] = mix(seed, RNG_SOURCES[i]);
        }
        return out;
    }

    public static Random javaRandom(long seed) {
        return new Random(mix(seed, "java"));
    }

    public static Random shuffleRandom(long seed) {
        return new Random(mix(seed, "forge.shuffle"));
    }

    public static Random aiRandom(long seed) {
        return new Random(mix(seed, "forge.ai"));
    }

    /**
     * Replace every static {@link Random} field on {@code types} with a
     * generator derived from {@code seed} and the field name. Returns how
     * many fields were reseeded. Used for Forge AI helpers that keep their
     * own {@code Random} instead of {@code MyRandom}.
     */
    public static int reseedStaticRandoms(long seed, Class<?>... types) {
        int count = 0;
        for (Class<?> type : types) {
            if (type == null) continue;
            for (java.lang.reflect.Field field : type.getDeclaredFields()) {
                if (!java.lang.reflect.Modifier.isStatic(field.getModifiers())) continue;
                if (field.getType() != Random.class) continue;
                field.setAccessible(true);
                try {
                    field.set(null, new Random(mix(seed, "forge.ai:" + type.getName() + ":" + field.getName())));
                    count++;
                } catch (IllegalAccessException e) {
                    throw new IllegalStateException(e);
                }
            }
        }
        return count;
    }

    public static String sha256(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] raw = digest.digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(raw.length * 2);
            for (byte b : raw) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    public static String trajectoryHash(List<String> records) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < records.size(); i++) {
            if (i > 0) sb.append('\n');
            sb.append(records.get(i));
        }
        return sha256(sb.toString());
    }

    public static final class Option {
        public final int kind;
        public final int source;
        public final int target;
        public final String label;

        public Option(int kind, int source, int target, String label) {
            this.kind = kind;
            this.source = source;
            this.target = target;
            this.label = label == null ? "" : label;
        }
    }

    public static final class Layout {
        public final int[] mask;
        public final int[] sources;
        public final int[] targets;
        public final int[] kinds;
        /** Index into the full option list, or -1 for pass / page. */
        public final int[] optionIndex;
        public final String actionsJson;
        public final int page;
        public final int pageCount;

        Layout(int[] mask, int[] sources, int[] targets, int[] kinds, int[] optionIndex,
               String actionsJson, int page, int pageCount) {
            this.mask = mask;
            this.sources = sources;
            this.targets = targets;
            this.kinds = kinds;
            this.optionIndex = optionIndex;
            this.actionsJson = actionsJson;
            this.page = page;
            this.pageCount = pageCount;
        }
    }

    public static int pageCount(int optionCount) {
        if (optionCount <= 0) return 1;
        return (optionCount + PAGE_SIZE - 1) / PAGE_SIZE;
    }

    /**
     * Slot 0 is pass when {@code passLegal}. Options occupy 1..509 of
     * {@code page}. Slots 510 and 511 turn the page when another page exists.
     * A hand with nothing payable is an empty option list and a legal pass:
     * only slot 0 is on.
     */
    public static Layout layout(List<Option> options, int page, boolean passLegal) {
        int count = options == null ? 0 : options.size();
        int pages = pageCount(count);
        if (page < 0) page = 0;
        if (page >= pages) page = pages - 1;
        int[] mask = new int[NUM_ACTIONS];
        int[] sources = new int[NUM_ACTIONS];
        int[] targets = new int[NUM_ACTIONS];
        int[] kinds = new int[NUM_ACTIONS];
        int[] optionIndex = new int[NUM_ACTIONS];
        Arrays.fill(sources, -1);
        Arrays.fill(targets, -1);
        Arrays.fill(optionIndex, -1);
        StringBuilder actions = new StringBuilder();
        actions.append('[');
        boolean first = true;
        if (passLegal) {
            mask[0] = 1;
            kinds[0] = 0;
            first = false;
            actions.append("{\"slot\":0,\"kind\":0,\"source_index\":-1,\"target_index\":-1,\"label\":\"pass\"}");
        }
        int begin = page * PAGE_SIZE;
        int end = Math.min(count, begin + PAGE_SIZE);
        int slot = 1;
        for (int i = begin; i < end && slot < PAGE_PREV; i++, slot++) {
            Option option = options.get(i);
            mask[slot] = 1;
            kinds[slot] = option.kind;
            sources[slot] = option.source;
            targets[slot] = option.target;
            optionIndex[slot] = i;
            if (!first) actions.append(',');
            first = false;
            actions.append("{\"slot\":").append(slot)
                .append(",\"kind\":").append(option.kind)
                .append(",\"source_index\":").append(option.source)
                .append(",\"target_index\":").append(option.target)
                .append(",\"label\":\"").append(escape(option.label)).append("\"}");
        }
        if (page > 0) {
            mask[PAGE_PREV] = 1;
            kinds[PAGE_PREV] = 6;
            if (!first) actions.append(',');
            first = false;
            actions.append("{\"slot\":510,\"kind\":6,\"source_index\":-1,\"target_index\":-1,\"label\":\"page_prev\"}");
        }
        if (page + 1 < pages) {
            mask[PAGE_NEXT] = 1;
            kinds[PAGE_NEXT] = 7;
            if (!first) actions.append(',');
            actions.append("{\"slot\":511,\"kind\":7,\"source_index\":-1,\"target_index\":-1,\"label\":\"page_next\"}");
        }
        actions.append(']');
        return new Layout(mask, sources, targets, kinds, optionIndex, actions.toString(), page, pages);
    }

    /** Only pass is legal when no spell on the list can be paid for. */
    public static Layout onlyPassWhenUnpayable(boolean[] canPay) {
        List<Option> options = new ArrayList<>();
        if (canPay != null) {
            for (int i = 0; i < canPay.length; i++) {
                if (canPay[i]) options.add(new Option(1, i, -1, "spell"));
            }
        }
        return layout(options, 0, true);
    }

    public static String helloResponse(long requestId, int cardsLoaded) {
        return "{\"type\":\"hello\",\"request_id\":" + requestId
            + ",\"protocol\":" + PROTOCOL_VERSION
            + ",\"bridge_version\":\"" + BRIDGE_VERSION + "\""
            + ",\"forge_commit\":\"" + FORGE_COMMIT + "\""
            + ",\"cards_loaded\":" + Math.max(0, cardsLoaded)
            + ",\"capabilities\":[\"policy_control\",\"seed\",\"legal_mask\",\"decision_points\",\"paging\",\"exact_ai_labels\"]"
            + ",\"limits\":{\"num_actions\":512,\"max_cards\":128,\"max_decision_timeout_ms\":8000}}";
    }

    public static boolean fatal(String code) {
        return "PROTOCOL_MISMATCH".equals(code) || "ENGINE_ERROR".equals(code) || "INTERNAL".equals(code);
    }

    public static String errorResponse(Long requestId, String code, String message,
                                       Integer decisionId, Integer expectedDecisionId) {
        StringBuilder sb = new StringBuilder(256);
        sb.append("{\"type\":\"error\",\"request_id\":");
        sb.append(requestId == null ? "null" : requestId.toString());
        sb.append(",\"code\":\"").append(code).append('"');
        sb.append(",\"message\":\"").append(escape(message)).append('"');
        sb.append(",\"fatal\":").append(fatal(code));
        sb.append(",\"bridge_version\":\"").append(BRIDGE_VERSION).append('"');
        if (decisionId != null) sb.append(",\"decision_id\":").append(decisionId);
        if (expectedDecisionId != null) sb.append(",\"expected_decision_id\":").append(expectedDecisionId);
        sb.append('}');
        return sb.toString();
    }

    public static String escape(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"': sb.append("\\\""); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }
}

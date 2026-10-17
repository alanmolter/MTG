package forge.rlbridge;

import forge.GuiDesktop;
import forge.LobbyPlayer;
import forge.StaticData;
import forge.ai.LobbyPlayerAi;
import forge.deck.CardPool;
import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.game.Game;
import forge.game.GameEndReason;
import forge.game.GameOutcome;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.Match;
import forge.card.MagicColor;
import forge.game.card.Card;
import forge.game.event.Event;
import forge.game.event.GameEventGameFinished;
import forge.game.event.GameEventTurnBegan;
import forge.game.event.GameEventTurnEnded;
import forge.game.player.Player;
import forge.game.player.RegisteredPlayer;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.item.PaperCard;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.util.MyRandom;

import com.google.common.eventbus.Subscribe;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * ForgeRLBridge — JSON-line stdin/stdout protocol to drive Forge as an RL env.
 *
 * Launch:
 *   java -cp forge-gui-desktop-*.jar;rlbridge.jar forge.rlbridge.ForgeRLBridge
 *
 * Protocol (one JSON object per line):
 *   IN:  {"cmd":"ping"}                          → OUT: {"pong":true,"cards_loaded":N}
 *   IN:  {"cmd":"new_game","agent_deck":"...","opponent_deck":"...","seed":42,
 *         "request_id":1,"step_timeout_seconds":8}
 *                                                → OUT: first state snapshot
 *   IN:  {"cmd":"step","action":<int>,"request_id":2}
 *                                                → OUT: next snapshot (blocks ≤ step_timeout_seconds)
 *   IN:  {"cmd":"step_autoregressive",           → OUT: next snapshot (blocks ≤ 10s)
 *         "action_base":<0..3>,                      action_base semantics:
 *         "source_id":<0..127>,                        0 → Cast/Play hand[source_id] targeting target_id
 *         "target_id":<0..127>}                        1 → Attack battlefield[source_id] → defender target_id
 *                                                      2 → Activate ability battlefield[source_id] targeting target_id
 *                                                      3 → Pass priority / Special (target_id encodes which)
 *                                                    Fail-safe: out-of-range indices or illegal-in-stack
 *                                                    actions are consumed and the returned snapshot flags
 *                                                    illegal_action=true so the shaper emits a negative reward.
 *   IN:  {"cmd":"quit"}                          → exits the JVM
 *
 * State snapshot schema (matches ml_engine/ray_cluster/env.py expectations):
 *   {
 *     "terminal": bool,                  // game over?
 *     "outcome": +1 / -1 / null,         // +1 agent wins, -1 loses
 *     "illegal_action": false,           // always false in AI-driven mode
 *     "turn": int,
 *     "life_you": int, "life_opp": int,
 *     "hand_you_size": int, "hand_opp_size": int,
 *     "power_you": int, "power_opp": int,     // total P of creatures in play
 *     "mana_value_played": int,
 *     "you":  { "life", "hand_size", "library_size", "graveyard_size", "exile_size",
 *               "mana_pool_total", "mana_w/u/b/r/g", "is_active", "max_life_seen" },
 *     "opp":  { same fields },
 *     "cards": [ { "mana_value","power","toughness","loyalty",
 *                  "is_creature","is_instant","is_sorcery","is_enchantment",
 *                  "is_artifact","is_land","is_planeswalker" } ],
 *     "controlled_by_edges": [], "in_zone_edges": [],
 *     "synergy_edges":       [], "attacks_edges":  [],
 *     "action_mask": [1,1,...]   // 512 entries, permissive
 *   }
 *
 * Design:
 *   - Forge's Match.startGame() runs the full game loop synchronously. We spin
 *     that up in a background thread and stream turn-begin/turn-end events
 *     through a BlockingQueue. The Python side's "step" blocks until the next
 *     snapshot is available or terminal.
 *   - The agent's `action` param is currently ignored — both sides are driven
 *     by Forge's built-in AI. This gives the RL loop real win/loss signal
 *     derived from Forge's rule engine. External policy control can be bolted
 *     on later via a custom PlayerController.
 *   - Cards load lazily (LOAD_CARD_SCRIPTS_LAZILY=true) to keep startup under
 *     a few seconds. The first new_game warms the cache for the decks in use.
 */
public class ForgeRLBridge implements ExternalPlayerController.Host {

    private static final int ACTION_MASK_SIZE = ProtocolV2.NUM_ACTIONS;
    /** Default decision wait. Python's read timeout must be strictly longer. */
    private static final int DEFAULT_STEP_TIMEOUT_SECONDS = 8;
    static final String BRIDGE_VERSION = ProtocolV2.BRIDGE_VERSION;

    // Phase 3 — autoregressive action space bounds. Must match
    // ml_engine/ray_cluster/env.py's AR_NUM_TYPES / AR_NUM_SOURCES /
    // AR_NUM_TARGETS. Any index outside these ranges triggers the fail-safe:
    // the action is consumed, no Forge API is called, and the returned
    // snapshot carries illegal_action=true so the reward shaper penalises.
    private static final int AR_NUM_TYPES   = 4;
    private static final int AR_NUM_SOURCES = 128;
    private static final int AR_NUM_TARGETS = 128;

    // ── State shared between stdin reader and game thread ──────────────────
    private final BlockingQueue<String> snapshotQueue = new ArrayBlockingQueue<>(256);
    private final DecisionHandoff handoff = new DecisionHandoff();
    private volatile boolean externalPolicy;
    private volatile String pendingKind = "none";
    private volatile ProtocolV2.Layout currentLayout;
    private volatile int chosenActionLabel = -1;
    private volatile int aiFallbackDecisions;
    private volatile int bridgeErrors;
    private final java.util.Map<String, Integer> fallbackByKind = new java.util.LinkedHashMap<>();
    private volatile long matchSeed;
    private volatile int matchEpoch;
    private volatile int turnLimit = 50;
    private volatile boolean turnLimitSent;
    private volatile String truncationReason;
    private final java.util.concurrent.atomic.AtomicBoolean gameRunning = new java.util.concurrent.atomic.AtomicBoolean(false);
    private Game currentGame = null;
    private Player agentPlayer = null;
    private Player opponentPlayer = null;
    private final AtomicBoolean gameFinished = new AtomicBoolean(false);
    private volatile int agentMaxLife = 20;
    private volatile int oppMaxLife = 20;
    // Names the agent held, and names on the stack, at the previous snapshot.
    // A card that leaves the hand is the AI decision this snapshot records.
    private final List<String> previousAgentHand = new ArrayList<>();
    private final List<String> previousStack = new ArrayList<>();
    private int stepTimeoutSeconds = defaultStepTimeoutSeconds();

    public static void main(String[] args) {
        ForgeRLBridge bridge = new ForgeRLBridge();
        bridge.run();
    }

    private void run() {
        // CRITICAL: Reserve the REAL stdout for the JSON-line protocol, then
        // redirect System.out → stderr so Forge's internal println() calls
        // ("Read cards: …", "Language 'en-US' loaded successfully", etc.)
        // don't contaminate the protocol stream.
        PrintStream protocolOut = System.out;
        System.setOut(System.err);

        System.err.println("[forge-rlbridge] starting — initializing Forge…");
        long t0 = System.currentTimeMillis();
        initForge();
        System.err.println("[forge-rlbridge] Forge ready in " + (System.currentTimeMillis() - t0) + "ms");

        try (BufferedReader in = new BufferedReader(new InputStreamReader(System.in))) {
            String line;
            while ((line = in.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;
                Json parsed = null;
                try {
                    parsed = Json.parse(line);
                    handleCommand(parsed, protocolOut);
                } catch (Throwable t) {
                    Long id = parsed == null ? null : parsed.longOrNull("request_id");
                    String msg = t.getClass().getSimpleName() + ": " + String.valueOf(t.getMessage());
                    writeResponse(protocolOut, parsed,
                        ProtocolV2.errorResponse(id, "INTERNAL", msg, null, null));
                }
            }
        } catch (Exception e) {
            System.err.println("[forge-rlbridge] fatal: " + e);
            System.exit(1);
        }
    }

    // ── Forge initialization ───────────────────────────────────────────────

    private static boolean initialized = false;
    private static synchronized void initForge() {
        if (initialized) return;
        String assets = resolveAssetsDir();
        System.err.println("[forge-rlbridge] assetsDir=" + assets);
        GuiBase.setInterface(new BridgeGuiDesktop(assets));
        FModel.initialize(null, preferences -> {
            preferences.setPref(FPref.LOAD_CARD_SCRIPTS_LAZILY, true);
            preferences.setPref(FPref.UI_LANGUAGE, "en-US");
            return null;
        });
        initialized = true;
    }

    /**
     * Resolve the Forge assets directory (the parent of "res/"). Order:
     *   1) -DFORGE_ASSETS_DIR=... system property
     *   2) FORGE_ASSETS_DIR env var
     *   3) Auto-detect: search CWD, parent of CWD, and parent-of-parent for
     *      a child that contains "res/languages/en-US.properties"
     *   4) Fallback: "../forge-gui/"
     * The returned path always ends with "/" so it composes correctly with
     * Forge's path-concatenation style (ASSETS_DIR + "res/").
     */
    private static String resolveAssetsDir() {
        String p = System.getProperty("FORGE_ASSETS_DIR");
        if (p == null || p.isEmpty()) p = System.getenv("FORGE_ASSETS_DIR");
        if (p != null && !p.isEmpty()) return ensureTrailingSlash(p);

        // Candidate relative paths to try under each ancestor directory. The
        // first hit wins. Order matters: prefer deeper matches (they're less
        // ambiguous than shallow "res/" roots).
        String[] rels = {
            "forge/forge-gui",   // repo-root layout: mtg-deck-mvp/forge/forge-gui
            "forge-gui",         // one level up: .../forge/forge-gui when CWD=.../forge
            "."                  // assets themselves: CWD=.../forge-gui
        };
        File cwd = new File(".").getAbsoluteFile();
        for (File d = cwd; d != null; d = d.getParentFile()) {
            for (String rel : rels) {
                File cand = new File(d, rel);
                if (new File(cand, "res/languages/en-US.properties").isFile()) {
                    try {
                        return ensureTrailingSlash(cand.getCanonicalPath());
                    } catch (Exception e) {
                        return ensureTrailingSlash(cand.getAbsolutePath());
                    }
                }
            }
        }
        return "../forge-gui/";
    }

    private static String ensureTrailingSlash(String p) {
        if (p.endsWith("/") || p.endsWith(File.separator)) return p;
        return p + File.separator;
    }

    /** Delegates to GuiDesktop but overrides getAssetsDir to return our resolved absolute path. */
    public static final class BridgeGuiDesktop extends GuiDesktop {
        private final String assetsDir;
        public BridgeGuiDesktop(String assetsDir) { this.assetsDir = assetsDir; }
        @Override public String getAssetsDir() { return assetsDir; }
    }

    // ── Command dispatch ───────────────────────────────────────────────────

    private void handleCommand(Json j, PrintStream out) throws Exception {
        String cmd = j.str("cmd");
        Long requestId = j.longOrNull("request_id");
        if (cmd == null) {
            writeResponse(out, j, ProtocolV2.errorResponse(requestId, "BAD_REQUEST", "missing cmd", null, null));
            return;
        }
        if (requestId == null && !"quit".equals(cmd)) {
            writeResponse(out, j, ProtocolV2.errorResponse(null, "BAD_REQUEST", "request_id is required", null, null));
            return;
        }
        switch (cmd) {
            case "hello":
                hello(j, out, requestId);
                break;
            case "ping":
                hello(j, out, requestId);
                break;
            case "quit":
                writeResponse(out, j, "{\"type\":\"bye\",\"request_id\":" + (requestId == null ? 1 : requestId) + "}");
                System.exit(0);
                break;
            case "new_game":
                startNewGame(j, out, requestId);
                break;
            case "step":
                stepGame(j, out, requestId);
                break;
            case "step_autoregressive":
                stepAutoregressive(j, out, requestId);
                break;
            default:
                writeResponse(out, j, ProtocolV2.errorResponse(requestId, "UNKNOWN_CMD", "unknown cmd: " + cmd, null, null));
        }
    }

    private void hello(Json j, PrintStream out, long requestId) {
        Integer protocol = j.intOrNull("protocol");
        if (protocol == null || protocol != ProtocolV2.PROTOCOL_VERSION) {
            writeResponse(out, j, ProtocolV2.errorResponse(requestId, "PROTOCOL_MISMATCH",
                "bridge protocol is " + ProtocolV2.PROTOCOL_VERSION, null, null));
            return;
        }
        writeResponse(out, j, ProtocolV2.helloResponse(requestId, cardsLoaded()));
    }

    /**
     * Print one response. The body must already carry {@code type} and
     * {@code request_id}. Stamping the id here was the v1 bug: a snapshot
     * taken for an older decision left the queue under the new id.
     */
    private static void writeResponse(PrintStream out, Json request, String jsonObject) {
        String body = jsonObject == null ? "" : jsonObject.trim();
        if (!body.contains("\"type\"") || !body.contains("\"request_id\"")) {
            Long id = request == null ? null : request.longOrNull("request_id");
            body = ProtocolV2.errorResponse(id, "INTERNAL",
                "refusing to emit a response that is not bound to a request", null, null);
        }
        out.println(body);
        out.flush();
    }

    private static int defaultStepTimeoutSeconds() {
        String raw = System.getProperty("forge.rlbridge.stepTimeoutSeconds");
        if (raw == null || raw.isEmpty()) raw = System.getenv("FORGE_STEP_TIMEOUT_SECONDS");
        if (raw == null || raw.isEmpty()) return DEFAULT_STEP_TIMEOUT_SECONDS;
        try {
            return Math.max(1, Integer.parseInt(raw.trim()));
        } catch (NumberFormatException e) {
            return DEFAULT_STEP_TIMEOUT_SECONDS;
        }
    }

    /**
     * Replace Forge's process-wide RNG before the libraries are shuffled.
     *
     * {@code MyRandom} starts as a {@code SecureRandom}. {@code setSeed} on
     * that instance is not a portable replay. {@code setRandom(new Random(seed))}
     * is the hook Forge documents for deterministic simulation. It covers
     * shuffles and coin flips that call {@code MyRandom.getRandom()} after
     * this point. It does not cover {@code new Random()} / {@code new SecureRandom()}
     * inside AI heuristics, wall-clock timeouts, or thread scheduling. The
     * bridge still lets Forge AI play both sides, so a repeated seed repeats
     * the opening hands only when those shuffles go through MyRandom.
     */
    private void applyMatchSeed(Json j) {
        Long seed = j.longOrNull("seed");
        if (seed == null) {
            System.err.println("[forge-rlbridge] new_game has no seed; Forge SecureRandom stays in place");
            return;
        }
        matchSeed = seed;
        // One derived seed per source. Shuffles use forge.shuffle. AI helpers
        // that keep a static Random are reseeded from forge.ai. Python seeds
        // its own numpy/torch streams from the same match seed.
        String[] forgeRngHolders = {
            "forge.util.MyRandom",
            "forge.ai.ComputerUtil",
            "forge.ai.AiController",
            "forge.ai.ComputerUtilCard",
            "forge.game.GameAction",
        };
        for (String name : forgeRngHolders) {
            try {
                ProtocolV2.reseedStaticRandoms(seed, Class.forName(name));
            } catch (ClassNotFoundException ignored) {
                // The class is absent from this Forge build. The shuffle RNG
                // below still covers MyRandom.
            }
        }
        MyRandom.setRandom(ProtocolV2.shuffleRandom(seed));
        ProtocolV2.javaRandom(seed);
        System.err.println("[forge-rlbridge] seeded java, forge.shuffle, forge.ai from " + seed);
    }

    // ── new_game ───────────────────────────────────────────────────────────

    private void startNewGame(Json j, PrintStream out, long requestId) throws Exception {
        killExistingGame();
        this.matchEpoch = handoff.beginMatch();
        aiFallbackDecisions = 0;
        bridgeErrors = 0;
        synchronized (fallbackByKind) { fallbackByKind.clear(); }
        chosenActionLabel = -1;
        currentLayout = null;
        pendingKind = "none";
        truncationReason = null;
        turnLimitSent = false;

        Integer requestedTimeout = j.intOrNull("step_timeout_seconds");
        if (requestedTimeout != null && requestedTimeout > 0) {
            this.stepTimeoutSeconds = requestedTimeout;
        }
        Integer requestedTurns = j.intOrNull("turn_limit");
        if (requestedTurns != null && requestedTurns > 0) this.turnLimit = requestedTurns;
        String policy = j.str("agent_policy");
        if (policy == null || policy.isEmpty()) policy = "external";
        if (!"external".equals(policy) && !"forge_ai".equals(policy)) {
            writeResponse(out, j, ProtocolV2.errorResponse(requestId, "BAD_REQUEST",
                "agent_policy must be external or forge_ai", null, null));
            return;
        }
        this.externalPolicy = "external".equals(policy);
        applyMatchSeed(j);

        Deck deckA;
        Deck deckB;
        try {
            deckA = parseDeck(j.str("agent_deck"), "AgentDeck");
            deckB = parseDeck(j.str("opponent_deck"), "OpponentDeck");
        } catch (RuntimeException ex) {
            writeResponse(out, j, ProtocolV2.errorResponse(requestId, "DECK_PARSE_ERROR", ex.getMessage(), null, null));
            return;
        }

        int side = j.intVal("agent_side", 0);
        if (side != 0 && side != 1) side = 0;
        LobbyPlayer agentLobby = externalPolicy
            ? new ExternalLobbyPlayer("agent", this)
            : new LobbyPlayerAi("agent", null);
        LobbyPlayer opponentLobby = new LobbyPlayerAi("opponent", null);
        Deck deck0 = side == 0 ? deckA : deckB;
        Deck deck1 = side == 0 ? deckB : deckA;
        LobbyPlayer seat0 = side == 0 ? agentLobby : opponentLobby;
        LobbyPlayer seat1 = side == 0 ? opponentLobby : agentLobby;

        List<RegisteredPlayer> players = new ArrayList<>();
        RegisteredPlayer rpA = new RegisteredPlayer(deck0).setPlayer(seat0);
        RegisteredPlayer rpB = new RegisteredPlayer(deck1).setPlayer(seat1);
        players.add(rpA);
        players.add(rpB);

        GameRules rules = new GameRules(GameType.Constructed);
        Match match = new Match(rules, players, "RLBridge");
        Game game = match.createGame();
        this.currentGame = game;
        this.gameFinished.set(false);
        this.snapshotQueue.clear();
        this.agentMaxLife = 20;
        this.oppMaxLife = 20;

        // Resolve seats by lobby name. createGame() already built the players.
        this.agentPlayer = null;
        this.opponentPlayer = null;
        List<Player> ps = game.getPlayers();
        if (ps != null) {
            for (Player p : ps) {
                if ("agent".equals(p.getName())) this.agentPlayer = p;
                else this.opponentPlayer = p;
            }
            if (this.agentPlayer == null && ps.size() >= 1) this.agentPlayer = ps.get(0);
            if (this.opponentPlayer == null && ps.size() >= 2) this.opponentPlayer = ps.get(1);
        }
        for (Player p : game.getPlayers()) {
            p.updateOpponentsForView();
        }

        // No turn-event subscription. Step responses come only from the
        // decision the game thread publishes after the command that is waiting.
        final int gameEpoch = this.matchEpoch;
        gameRunning.set(true);
        game.getAction().invoke(() -> {
            try {
                if (handoff.epoch() != gameEpoch) return;
                match.startGame(game);
            } catch (Throwable t) {
                System.err.println("[forge-rlbridge] game thread crashed: " + t);
                t.printStackTrace(System.err);
                if (handoff.epoch() == gameEpoch) handoff.failEngine(gameEpoch);
            } finally {
                try {
                    gameFinished.set(true);
                    if (handoff.epoch() == gameEpoch && !handoff.isDiscarded()) {
                        pendingKind = "none";
                        currentLayout = null;
                        handoff.publishTerminal(new DecisionHandoff.Offer(
                            "none", buildSnapshot(true, false, false), passMask(), true), gameEpoch);
                    }
                } finally {
                    gameRunning.set(false);
                }
            }
        });

        // Cold card load can take longer than a later decision. Stay under
        // Python's 60s new_game read.
        long firstWaitMs = Math.max(stepTimeoutSeconds, 45) * 1000L;
        DecisionHandoff.Reply reply = handoff.awaitFirst(requestId, firstWaitMs);
        writeResponse(out, j, reply.json);
        if (reply.timedOut) killExistingGame();
    }

    // ── step ───────────────────────────────────────────────────────────────

    private void stepGame(Json j, PrintStream out, long requestId) throws Exception {
        if (currentGame == null) {
            writeResponse(out, j, ProtocolV2.errorResponse(requestId, "NO_GAME", "no game in progress", null, null));
            return;
        }
        Integer decisionId = j.intOrNull("decision_id");
        Integer action = j.intOrNull("action");
        if (decisionId == null || action == null) {
            writeResponse(out, j, ProtocolV2.errorResponse(requestId, "BAD_REQUEST",
                "step requires decision_id and action", decisionId, null));
            return;
        }
        DecisionHandoff.Reply reply = handoff.step(
            requestId, decisionId, action, stepTimeoutSeconds * 1000L);
        writeResponse(out, j, reply.json);
        if (reply.timedOut) killExistingGame();
    }

    // ── step_autoregressive ─────────────────────────────────────────────────

    /**
     * Phase 3 — native autoregressive action dispatcher.
     *
     * Extracts (action_base, source_id, target_id) directly from the JSON
     * without any hash/modulo packing. action_base semantics:
     *   0 → Cast / Play card at hand[source_id] targeting target_id
     *   1 → Attack with creature battlefield[source_id] → defender target_id
     *   2 → Activate ability at battlefield[source_id] targeting target_id
     *   3 → Pass priority / Special action (target_id encodes which)
     *
     * Fail-safe semantics (critical for training stability):
     *   - Out-of-range actionBase/sourceId/targetId → consume, emit
     *     illegal_action=true snapshot, do NOT advance Forge. The Python
     *     shaper applies penalty_illegal_action on the returned state so the
     *     agent gets a negative-reward training signal.
     *   - Illegal-in-stack action (once a custom PlayerController is wired):
     *     the controller returns null; we catch the resulting exception via
     *     the top-level handler in run() which already emits the fail-safe
     *     snapshot — no crash.
     *
     * While Forge's built-in AI currently drives both sides, this method
     * still validates indices end-to-end so the protocol contract holds.
     * Once the custom controller is wired, each action_base branch will
     * invoke the mapped Forge API (SpellAbility.canPlay, DeclareAttackers,
     * activated abilities, priority pass).
     */
    private void stepAutoregressive(Json j, PrintStream out, long requestId) throws Exception {
        if (currentGame == null) {
            writeResponse(out, j, ProtocolV2.errorResponse(requestId, "NO_GAME", "no game in progress", null, null));
            return;
        }

        int actionBase = j.intVal("action_base", -1);
        int sourceId   = j.intVal("source_id",   -1);
        int targetId   = j.intVal("target_id",   -1);

        boolean illegal =
            actionBase < 0 || actionBase >= AR_NUM_TYPES   ||
            sourceId   < 0 || sourceId   >= AR_NUM_SOURCES ||
            targetId   < 0 || targetId   >= AR_NUM_TARGETS;

        if (illegal) {
            // Reserved for the autoregressive endpoint. A discrete step uses
            // state.illegal_action instead of this code, and neither path
            // touches the pending decision.
            writeResponse(out, j, ProtocolV2.errorResponse(requestId, "ILLEGAL_ACTION",
                "autoregressive index out of range", null, null));
            return;
        }
        writeResponse(out, j, ProtocolV2.errorResponse(requestId, "BAD_REQUEST",
            "step_autoregressive does not advance a policy-controlled game; use step", null, null));
    }

    // ── Event listener (subscribed via Guava EventBus) ─────────────────────

    public static final class GameEventListener {
        private final ForgeRLBridge bridge;
        public GameEventListener(ForgeRLBridge b) { this.bridge = b; }

        @Subscribe public void onTurnBegan(GameEventTurnBegan e)  { bridge.enqueueSnapshot(false); }
        @Subscribe public void onTurnEnded(GameEventTurnEnded e)  { bridge.enqueueSnapshot(false); }
        @Subscribe public void onFinished(GameEventGameFinished e){
            bridge.gameFinished.set(true);
            bridge.enqueueSnapshot(true);
        }
    }

    void enqueueSnapshot(boolean terminal) {
        try {
            String snap = buildSnapshot(terminal);
            snapshotQueue.offer(snap, 2, TimeUnit.SECONDS);
        } catch (Throwable t) {
            // Never let a listener throw into the game thread
            System.err.println("[forge-rlbridge] snapshot error: " + t);
        }
    }

    // ── Snapshot builder ───────────────────────────────────────────────────

    private String buildSnapshot(boolean forcedTerminal) {
        return buildSnapshot(forcedTerminal, false, false);
    }

    private String buildSnapshot(boolean forcedTerminal, boolean illegalAction) {
        return buildSnapshot(forcedTerminal, illegalAction, false);
    }

    private String buildSnapshot(boolean forcedTerminal, boolean illegalAction, boolean truncated) {
        StringBuilder sb = new StringBuilder(4096);
        sb.append('{');
        sb.append("\"type\":\"state\",");
        sb.append("\"protocol\":").append(ProtocolV2.PROTOCOL_VERSION).append(',');
        sb.append("\"bridge_version\":\"").append(BRIDGE_VERSION).append("\",");
        sb.append("\"decision_id\":-1,");
        String kind = pendingKind == null ? "none" : pendingKind;
        if (forcedTerminal) kind = "none";
        sb.append("\"decision_kind\":\"").append(kind).append("\",");
        sb.append("\"decision_type\":\"").append(kind).append("\",");
        sb.append("\"state_hash\":\"PENDING\",");
        sb.append("\"policy_action_applied\":null,");
        sb.append("\"seed\":").append(matchSeed).append(',');
        sb.append("\"ai_fallback_decisions\":").append(aiFallbackDecisions).append(',');
        sb.append("\"bridge_errors\":").append(bridgeErrors).append(',');
        sb.append("\"ai_fallback_by_kind\":").append(fallbackByKindJson()).append(',');
        sb.append("\"policy_decisions\":").append(handoff.policyDecisions()).append(',');
        sb.append("\"full_magic_training_ready\":false,");

        Game g = currentGame;
        Player you = agentPlayer;
        Player opp = opponentPlayer;

        boolean terminal = forcedTerminal || (g != null && g.isGameOver());
        Integer outcome = null;
        if (terminal && g != null) {
            GameOutcome go = g.getOutcome();
            if (go != null && you != null) {
                if (go.isDraw()) {
                    outcome = 0;
                } else if (go.isWinner(you.getLobbyPlayer())) {
                    outcome = 1;
                } else {
                    outcome = -1;
                }
            } else {
                outcome = 0;
            }
        }

        int turn = (g != null && g.getPhaseHandler() != null) ? g.getPhaseHandler().getTurn() : 0;
        int lifeYou = (you != null) ? you.getLife() : 20;
        int lifeOpp = (opp != null) ? opp.getLife() : 20;
        if (lifeYou > agentMaxLife) agentMaxLife = lifeYou;
        if (lifeOpp > oppMaxLife)   oppMaxLife = lifeOpp;

        int handYou  = (you != null) ? you.getCardsIn(ZoneType.Hand).size() : 0;
        int handOpp  = (opp != null) ? opp.getCardsIn(ZoneType.Hand).size() : 0;
        int libYou   = (you != null) ? you.getCardsIn(ZoneType.Library).size()   : 0;
        int libOpp   = (opp != null) ? opp.getCardsIn(ZoneType.Library).size()   : 0;
        int gyYou    = (you != null) ? you.getCardsIn(ZoneType.Graveyard).size() : 0;
        int gyOpp    = (opp != null) ? opp.getCardsIn(ZoneType.Graveyard).size() : 0;
        int exYou    = (you != null) ? you.getCardsIn(ZoneType.Exile).size()     : 0;
        int exOpp    = (opp != null) ? opp.getCardsIn(ZoneType.Exile).size()     : 0;

        int powerYou = sumPower(you);
        int powerOpp = sumPower(opp);

        boolean activeYou = (g != null && g.getPhaseHandler() != null && you != null &&
                             g.getPhaseHandler().getPlayerTurn() == you);
        boolean activeOpp = (g != null && g.getPhaseHandler() != null && opp != null &&
                             g.getPhaseHandler().getPlayerTurn() == opp);

        field(sb, "terminal", terminal); sb.append(',');
        field(sb, "truncated", truncated); sb.append(',');
        if (truncated) {
            String reason = truncationReason == null ? "step_timeout" : truncationReason;
            field(sb, "truncation_reason", reason); sb.append(',');
        }
        sb.append("\"outcome\":").append(outcome == null ? "null" : outcome.toString()).append(',');
        field(sb, "illegal_action", illegalAction); sb.append(',');
        field(sb, "turn", turn); sb.append(',');
        field(sb, "life_you", lifeYou); sb.append(',');
        field(sb, "life_opp", lifeOpp); sb.append(',');
        field(sb, "hand_you_size", handYou); sb.append(',');
        field(sb, "hand_opp_size", handOpp); sb.append(',');
        field(sb, "power_you", powerYou); sb.append(',');
        field(sb, "power_opp", powerOpp); sb.append(',');
        field(sb, "mana_value_played", 0); sb.append(',');

        // LoopGuard-compatible fields — these keys are what canonical_state_hash
        // filters on. Without them the hash is constant across turns and the
        // guard falsely fires at step 3. Include permanent counts + the phase
        // name so consecutive states have different hashes as the game moves.
        int phase = (g != null && g.getPhaseHandler() != null && g.getPhaseHandler().getPhase() != null)
                ? g.getPhaseHandler().getPhase().ordinal() : -1;
        String phaseName = (g != null && g.getPhaseHandler() != null && g.getPhaseHandler().getPhase() != null)
                ? g.getPhaseHandler().getPhase().name() : "";
        boolean turnEnded = "END_OF_TURN".equals(phaseName)
                || "END".equals(phaseName)
                || "CLEANUP".equals(phaseName)
                || "CLEANUP_PHASE".equals(phaseName);
        int bfYou = (you != null) ? you.getCardsIn(ZoneType.Battlefield).size() : 0;
        int bfOpp = (opp != null) ? opp.getCardsIn(ZoneType.Battlefield).size() : 0;
        int landsYou = countLands(you);
        int landsOpp = countLands(opp);
        int untappedYou = countUntappedLands(you);
        int instantsYou = countInstantsInHand(you);
        field(sb, "turn_phase", phase); sb.append(',');
        field(sb, "phase", phaseName); sb.append(',');
        field(sb, "turn_ended", turnEnded); sb.append(',');
        field(sb, "battlefield_you", bfYou); sb.append(',');
        field(sb, "battlefield_opp", bfOpp); sb.append(',');
        field(sb, "lands_you", landsYou); sb.append(',');
        field(sb, "lands_opp", landsOpp); sb.append(',');
        field(sb, "nonland_permanents_you", Math.max(0, bfYou - landsYou)); sb.append(',');
        field(sb, "nonland_permanents_opp", Math.max(0, bfOpp - landsOpp)); sb.append(',');
        field(sb, "untapped_lands_you", untappedYou); sb.append(',');
        field(sb, "instants_in_hand_you", instantsYou); sb.append(',');
        field(sb, "mana_available_you", untappedYou); sb.append(',');
        field(sb, "graveyard_you_size", gyYou); sb.append(',');
        field(sb, "graveyard_opp_size", gyOpp); sb.append(',');
        // Floating mana is not read from Forge's mana pool yet. Untapped lands
        // are reported separately as mana_available_you. These keys stay in the
        // payload because LoopGuard hashes them; leaving them out collapses
        // the hash. They remain 0 until the pool is wired.
        int[] manaYou = manaColors(you);
        int[] manaOpp = manaColors(opp);
        field(sb, "mana_pool_you", manaYou[0]); sb.append(',');
        field(sb, "mana_pool_opp", manaOpp[0]); sb.append(',');

        // "you" block
        sb.append("\"you\":{");
        field(sb, "life", lifeYou); sb.append(',');
        field(sb, "max_life_seen", agentMaxLife); sb.append(',');
        field(sb, "mana_pool_total", manaYou[0]); sb.append(',');
        field(sb, "mana_w", manaYou[1]); sb.append(',');
        field(sb, "mana_u", manaYou[2]); sb.append(',');
        field(sb, "mana_b", manaYou[3]); sb.append(',');
        field(sb, "mana_r", manaYou[4]); sb.append(',');
        field(sb, "mana_g", manaYou[5]); sb.append(',');
        field(sb, "hand_size", handYou); sb.append(',');
        field(sb, "library_size", libYou); sb.append(',');
        field(sb, "graveyard_size", gyYou); sb.append(',');
        field(sb, "exile_size", exYou); sb.append(',');
        field(sb, "lands_untapped", untappedYou); sb.append(',');
        field(sb, "instants_in_hand", instantsYou); sb.append(',');
        field(sb, "is_active", activeYou);
        sb.append("},");

        // "opp" block
        sb.append("\"opp\":{");
        field(sb, "life", lifeOpp); sb.append(',');
        field(sb, "max_life_seen", oppMaxLife); sb.append(',');
        field(sb, "mana_pool_total", manaOpp[0]); sb.append(',');
        field(sb, "mana_w", manaOpp[1]); sb.append(',');
        field(sb, "mana_u", manaOpp[2]); sb.append(',');
        field(sb, "mana_b", manaOpp[3]); sb.append(',');
        field(sb, "mana_r", manaOpp[4]); sb.append(',');
        field(sb, "mana_g", manaOpp[5]); sb.append(',');
        field(sb, "hand_size", handOpp); sb.append(',');
        field(sb, "library_size", libOpp); sb.append(',');
        field(sb, "graveyard_size", gyOpp); sb.append(',');
        field(sb, "exile_size", exOpp); sb.append(',');
        field(sb, "is_active", activeOpp);
        sb.append("},");

        // Visible cards, in source-index order: agent hand, then both
        // battlefields, then the stack. Opponent hand stays hidden.
        // Cap below the Python observation width (128) so source indices
        // always point at a card the policy can see.
        List<Card> visible = new ArrayList<>();
        List<String> zones = new ArrayList<>();
        if (you != null) addCards(visible, zones, you.getCardsIn(ZoneType.Hand), "hand");
        if (g != null) addCards(visible, zones, g.getCardsIn(ZoneType.Battlefield), "battlefield");
        if (g != null) addCards(visible, zones, g.getCardsIn(ZoneType.Stack), "stack");
        if (you != null) addCards(visible, zones, you.getCardsIn(ZoneType.Graveyard), "graveyard");
        if (you != null) addCards(visible, zones, you.getCardsIn(ZoneType.Exile), "exile");
        int limit = Math.min(visible.size(), 120);
        sb.append("\"cards\":[");
        for (int i = 0; i < limit; i++) {
            if (i > 0) sb.append(',');
            appendCard(sb, visible.get(i), you, zones.get(i));
        }
        sb.append("],");

        sb.append("\"controlled_by_edges\":[],");
        sb.append("\"in_zone_edges\":[],");
        sb.append("\"synergy_edges\":[],");
        sb.append("\"attacks_edges\":[],");

        appendActionContract(sb, visible, zones, limit, you, activeYou);
        sb.append('}');
        return sb.toString();
    }

    private static void addCards(List<Card> cards, List<String> zones, Iterable<Card> source, String zone) {
        if (source == null) return;
        for (Card card : source) {
            cards.add(card);
            zones.add(zone);
        }
    }

    /**
     * Discrete(512) contract consumed by MtgForgeEnv.
     * Slot 0 is pass. Slots 1..509 are play/activate for a visible source
     * card (kind 1). Slots 510 and 511 stay illegal unless a caller pages.
     * {@code chosen_action} is the slot matching the card that left the
     * agent's hand since the previous snapshot, or 0 for an inferred pass.
     * -1 means the AI decision did not map onto a legal slot.
     */
    private void appendActionContract(
            StringBuilder sb, List<Card> visible, List<String> zones, int limit, Player you, boolean activeYou) {
        if (currentLayout != null) {
            boolean controlled = externalPolicy && you != null
                && you.getController() instanceof ExternalPlayerController;
            sb.append("\"policy_controlled\":").append(controlled).append(',');
            sb.append("\"chosen_action\":").append(chosenActionLabel).append(',');
            appendIntArray(sb, "action_mask", currentLayout.mask); sb.append(',');
            appendIntArray(sb, "action_source_indices", currentLayout.sources); sb.append(',');
            appendIntArray(sb, "action_target_indices", currentLayout.targets); sb.append(',');
            appendIntArray(sb, "action_kinds", currentLayout.kinds); sb.append(',');
            sb.append("\"actions\":").append(currentLayout.actionsJson);
            return;
        }

        int[] mask = new int[ACTION_MASK_SIZE];
        int[] sources = new int[ACTION_MASK_SIZE];
        int[] targets = new int[ACTION_MASK_SIZE];
        int[] kinds = new int[ACTION_MASK_SIZE];
        String[] sourceNames = new String[ACTION_MASK_SIZE];
        for (int i = 0; i < ACTION_MASK_SIZE; i++) {
            sources[i] = -1;
            targets[i] = -1;
        }
        mask[0] = 1;
        kinds[0] = 0;

        int slot = 1;
        List<String> handNow = new ArrayList<>();
        List<String> stackNow = new ArrayList<>();
        for (int i = 0; i < limit; i++) {
            Card card = visible.get(i);
            String zone = zones.get(i);
            boolean yours = you != null && card.getController() == you;
            if (yours && "hand".equals(zone)) handNow.add(card.getName());
            if ("stack".equals(zone)) stackNow.add(card.getName());
            boolean playable = yours && ("hand".equals(zone) || ("battlefield".equals(zone) && !card.isTapped()));
            if (playable && slot < ACTION_MASK_SIZE - 2) {
                mask[slot] = 1;
                kinds[slot] = 1;
                sources[slot] = i;
                targets[slot] = -1;
                sourceNames[slot] = card.getName();
                slot++;
            }
        }

        String choiceType = "unknown";
        String choiceCard = "";
        List<String> leftHand = new ArrayList<>(previousAgentHand);
        for (String name : handNow) {
            leftHand.remove(name);
        }
        if (!leftHand.isEmpty()) {
            choiceCard = leftHand.get(0);
            choiceType = stackNow.contains(choiceCard) ? "cast" : "land";
        } else if (!previousAgentHand.isEmpty()
                && previousAgentHand.equals(handNow)
                && previousStack.equals(stackNow)
                && !activeYou) {
            choiceType = "pass";
        }
        previousAgentHand.clear();
        previousAgentHand.addAll(handNow);
        previousStack.clear();
        previousStack.addAll(stackNow);

        int chosen = -1;
        if ("pass".equals(choiceType)) {
            chosen = 0;
        } else if (!choiceCard.isEmpty()) {
            for (int i = 1; i < ACTION_MASK_SIZE - 2; i++) {
                if (mask[i] == 1 && choiceCard.equals(sourceNames[i])) {
                    chosen = i;
                    break;
                }
            }
            if (chosen < 0) choiceType = "unknown";
        }

        boolean controlled = externalPolicy && you != null
            && you.getController() instanceof ExternalPlayerController;
        sb.append("\"policy_controlled\":").append(controlled).append(',');
        field(sb, "ai_choice_type", choiceType); sb.append(',');
        field(sb, "ai_choice_card", choiceCard); sb.append(',');
        sb.append("\"chosen_action\":").append(chosen).append(',');
        appendIntArray(sb, "action_mask", mask); sb.append(',');
        appendIntArray(sb, "action_source_indices", sources); sb.append(',');
        appendIntArray(sb, "action_target_indices", targets); sb.append(',');
        appendIntArray(sb, "action_kinds", kinds);
    }

    private static void appendIntArray(StringBuilder sb, String key, int[] values) {
        sb.append('"').append(key).append("\":[");
        for (int i = 0; i < values.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(values[i]);
        }
        sb.append(']');
    }

    private static void appendCard(StringBuilder sb, Card c, Player agent, String zone) {
        sb.append('{');
        field(sb, "mana_value", c.getCMC()); sb.append(',');
        field(sb, "power", c.isCreature() ? c.getNetPower() : 0); sb.append(',');
        field(sb, "toughness", c.isCreature() ? c.getNetToughness() : 0); sb.append(',');
        field(sb, "loyalty", c.isPlaneswalker() ? c.getCurrentLoyalty() : 0); sb.append(',');
        field(sb, "is_creature", c.isCreature()); sb.append(',');
        field(sb, "is_instant", c.isInstant()); sb.append(',');
        field(sb, "is_sorcery", c.isSorcery()); sb.append(',');
        field(sb, "is_enchantment", c.isEnchantment()); sb.append(',');
        field(sb, "is_artifact", c.isArtifact()); sb.append(',');
        field(sb, "is_land", c.isLand()); sb.append(',');
        field(sb, "is_planeswalker", c.isPlaneswalker()); sb.append(',');
        field(sb, "is_tapped", c.isTapped()); sb.append(',');
        String controller = "opp";
        Player owner = c.getController();
        if (agent != null && owner == agent) controller = "you";
        field(sb, "controller", controller); sb.append(',');
        field(sb, "zone", zone); sb.append(',');
        field(sb, "name", c.getName()); sb.append(',');
        String oracle = "";
        try {
            if (c.getRules() != null && c.getRules().getMainPart() != null
                    && c.getRules().getMainPart().getOracleText() != null) {
                oracle = c.getRules().getMainPart().getOracleText();
            }
        } catch (Throwable ignored) { }
        field(sb, "oracle_text", oracle); sb.append(',');
        field(sb, "is_attacking", isAttacking(c));
        sb.append('}');
    }

    /** total, W, U, B, R, G. */
    private static int[] manaColors(Player player) {
        int[] mana = new int[6];
        if (player == null || player.getManaPool() == null) return mana;
        mana[0] = player.getManaPool().totalMana();
        mana[1] = player.getManaPool().getAmountOfColor(MagicColor.Color.WHITE.getColorMask());
        mana[2] = player.getManaPool().getAmountOfColor(MagicColor.Color.BLUE.getColorMask());
        mana[3] = player.getManaPool().getAmountOfColor(MagicColor.Color.BLACK.getColorMask());
        mana[4] = player.getManaPool().getAmountOfColor(MagicColor.Color.RED.getColorMask());
        mana[5] = player.getManaPool().getAmountOfColor(MagicColor.Color.GREEN.getColorMask());
        return mana;
    }

    private static int[] passMask() {
        int[] mask = new int[ACTION_MASK_SIZE];
        mask[0] = 1;
        return mask;
    }

    @Override
    public int decide(String decisionKind, ProtocolV2.Layout layout, int aiChosenSlot) {
        int epoch = this.matchEpoch;
        if (handoff.epoch() != epoch || handoff.isDiscarded()) return -1;
        this.pendingKind = decisionKind;
        this.currentLayout = layout;
        this.chosenActionLabel = aiChosenSlot;
        try {
            if (!turnLimitSent && currentGame != null && currentGame.getPhaseHandler() != null
                    && currentGame.getPhaseHandler().getTurn() >= turnLimit) {
                turnLimitSent = true;
                truncationReason = "turn_limit";
                pendingKind = "none";
                handoff.publishTerminal(new DecisionHandoff.Offer(
                    "none", buildSnapshot(false, false, true), layout.mask, true), epoch);
                return -1;
            }
            if (turnLimitSent) return -1;
            return handoff.publishAndAwaitAction(new DecisionHandoff.Offer(
                decisionKind, buildSnapshot(false, false, false), layout.mask, false), epoch);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            handoff.discardMatch();
            return -1;
        } finally {
            this.currentLayout = null;
        }
    }

    @Override
    public void noteFallback(String decisionKind, String why) {
        String kind = decisionKind == null || decisionKind.isEmpty() ? "unknown" : decisionKind;
        aiFallbackDecisions++;
        synchronized (fallbackByKind) {
            fallbackByKind.merge(kind, 1, Integer::sum);
        }
        System.err.println("[forge-rlbridge] ai_fallback " + kind + " " + why);
    }

    @Override
    public void noteBridgeError(String decisionKind, Throwable error) {
        bridgeErrors++;
        String message = error == null ? "null" : error.toString();
        System.err.println("[forge-rlbridge] ENGINE_ERROR " + decisionKind + " " + message);
        if (error != null) error.printStackTrace(System.err);
        truncationReason = "engine_error";
        handoff.failEngine(matchEpoch);
    }

    @Override
    public boolean discarded() {
        return handoff.isDiscarded();
    }

    @Override
    public int visibleIndex(Card card) {
        if (card == null) return -1;
        List<Card> visible = new ArrayList<>();
        List<String> zones = new ArrayList<>();
        if (agentPlayer != null) addCards(visible, zones, agentPlayer.getCardsIn(ZoneType.Hand), "hand");
        if (currentGame != null) addCards(visible, zones, currentGame.getCardsIn(ZoneType.Battlefield), "battlefield");
        if (currentGame != null) addCards(visible, zones, currentGame.getCardsIn(ZoneType.Stack), "stack");
        if (agentPlayer != null) addCards(visible, zones, agentPlayer.getCardsIn(ZoneType.Graveyard), "graveyard");
        if (agentPlayer != null) addCards(visible, zones, agentPlayer.getCardsIn(ZoneType.Exile), "exile");
        int limit = Math.min(visible.size(), 120);
        for (int i = 0; i < limit; i++) {
            if (visible.get(i) == card) return i;
        }
        return -1;
    }

    private static int countLands(Player p) {
        if (p == null) return 0;
        int n = 0;
        for (Card c : p.getCardsIn(ZoneType.Battlefield)) {
            if (c.isLand()) n++;
        }
        return n;
    }

    private static int countUntappedLands(Player p) {
        if (p == null) return 0;
        int n = 0;
        for (Card c : p.getCardsIn(ZoneType.Battlefield)) {
            if (c.isLand() && !c.isTapped()) n++;
        }
        return n;
    }

    private static int countInstantsInHand(Player p) {
        if (p == null) return 0;
        int n = 0;
        for (Card c : p.getCardsIn(ZoneType.Hand)) {
            if (c.isInstant()) n++;
        }
        return n;
    }

    private static int sumPower(Player p) {
        if (p == null) return 0;
        int sum = 0;
        for (Card c : p.getCardsIn(ZoneType.Battlefield)) {
            if (c.isCreature()) sum += c.getNetPower();
        }
        return sum;
    }

    // ── Deck parsing ───────────────────────────────────────────────────────

    /**
     * Accepts MTGO-style decklists:
     *   4 Lightning Bolt
     *   20 Mountain
     *   // optional comments
     *   Sideboard
     *   1 Pyroblast
     * Sideboard is ignored.
     *
     * Also accepts the shorthand "AggroRed" / "Burn" / "Control" / "Ramp" /
     * "Combo" / "Midrange" — these map to prebuilt 60-card test decks so
     * self-play can run without needing deck files on disk.
     */
    private Deck parseDeck(String payload, String name) {
        if (payload == null || payload.trim().isEmpty()) {
            payload = defaultDeckFor("AggroRed");
        } else {
            String p = payload.trim();
            if (p.matches("(?i)aggro(red)?|burn|control|ramp|combo|midrange")) {
                payload = defaultDeckFor(p);
            }
        }

        Deck deck = new Deck(name);
        CardPool main = deck.getOrCreate(DeckSection.Main);
        boolean inSideboard = false;
        for (String raw : payload.split("\\r?\\n")) {
            String line = raw.trim();
            if (line.isEmpty() || line.startsWith("//") || line.startsWith("#")) continue;
            if (line.equalsIgnoreCase("sideboard") || line.equalsIgnoreCase("sb:")) {
                inSideboard = true;
                continue;
            }
            if (inSideboard) continue;

            // "4 Lightning Bolt" or "4x Lightning Bolt"
            int sp = line.indexOf(' ');
            if (sp < 0) continue;
            String countStr = line.substring(0, sp).replace("x", "").trim();
            String cardName = line.substring(sp + 1).trim();
            // Strip set code like " (M10)"
            int paren = cardName.indexOf('(');
            if (paren > 0) cardName = cardName.substring(0, paren).trim();

            int count;
            try { count = Integer.parseInt(countStr); } catch (NumberFormatException e) { continue; }
            if (count <= 0 || count > 60) continue;

            PaperCard pc = StaticData.instance().getCommonCards().getCard(cardName);
            if (pc == null) {
                try { StaticData.instance().attemptToLoadCard(cardName); } catch (Throwable ignored) {}
                pc = StaticData.instance().getCommonCards().getCard(cardName);
            }
            if (pc != null) {
                main.add(pc, count);
            } else {
                System.err.println("[forge-rlbridge] unknown card: " + cardName);
            }
        }

        // Ensure we have at least a 40-card deck; pad with basic lands as fallback
        int total = main.countAll();
        if (total < 40) {
            PaperCard mountain = StaticData.instance().getCommonCards().getCard("Mountain");
            if (mountain != null) main.add(mountain, 40 - total);
        }
        return deck;
    }

    private static String defaultDeckFor(String kind) {
        String k = kind == null ? "" : kind.toLowerCase();
        if (k.contains("burn") || k.contains("aggro")) {
            return  "4 Goblin Guide\n" +
                    "4 Monastery Swiftspear\n" +
                    "4 Eidolon of the Great Revel\n" +
                    "4 Lightning Bolt\n" +
                    "4 Lava Spike\n" +
                    "4 Rift Bolt\n" +
                    "4 Searing Blaze\n" +
                    "4 Boros Charm\n" +
                    "4 Skullcrack\n" +
                    "4 Skewer the Critics\n" +
                    "20 Mountain\n";
        }
        if (k.contains("control")) {
            return  "4 Counterspell\n" +
                    "4 Mana Leak\n" +
                    "4 Snapcaster Mage\n" +
                    "4 Preordain\n" +
                    "4 Brainstorm\n" +
                    "4 Ponder\n" +
                    "4 Swords to Plowshares\n" +
                    "2 Jace, the Mind Sculptor\n" +
                    "4 Path to Exile\n" +
                    "4 Spell Pierce\n" +
                    "22 Island\n";
        }
        if (k.contains("ramp")) {
            return  "4 Llanowar Elves\n" +
                    "4 Elvish Mystic\n" +
                    "4 Rampant Growth\n" +
                    "4 Cultivate\n" +
                    "4 Kodama's Reach\n" +
                    "4 Explore\n" +
                    "2 Primeval Titan\n" +
                    "2 Craterhoof Behemoth\n" +
                    "24 Forest\n" +
                    "4 Forest\n" +
                    "4 Forest\n";
        }
        // Midrange default
        return  "4 Thoughtseize\n" +
                "4 Tarmogoyf\n" +
                "4 Liliana of the Veil\n" +
                "4 Fatal Push\n" +
                "4 Inquisition of Kozilek\n" +
                "4 Dark Confidant\n" +
                "4 Lightning Bolt\n" +
                "24 Swamp\n" +
                "8 Forest\n";
    }

    // ── Housekeeping ───────────────────────────────────────────────────────

    private void killExistingGame() {
        // Bump the epoch before the old pool thread can publish again. Join
        // is not enough: Forge runs the match on a cached pool thread that
        // stays alive after the runnable returns.
        handoff.endMatch();
        try {
            if (currentGame != null && !currentGame.isGameOver()) {
                currentGame.setAge(forge.game.GameStage.GameOver);
            }
        } catch (Throwable ignored) {}
        long deadline = System.currentTimeMillis() + 5000L;
        while (gameRunning.get() && System.currentTimeMillis() < deadline) {
            try { Thread.sleep(20); } catch (InterruptedException ignored) { break; }
        }
        if (gameRunning.get()) {
            System.err.println("[forge-rlbridge] previous game still running; its states are dropped by the epoch fence");
        }
        currentGame = null;
        agentPlayer = null;
        opponentPlayer = null;
        gameFinished.set(true);
        snapshotQueue.clear();
        previousAgentHand.clear();
        previousStack.clear();
    }

    /** {@code Card.isAttacking()} NPEs when {@code Game.getCombat()} is null. */
    private static boolean isAttacking(Card card) {
        if (card == null || card.getGame() == null || card.getGame().getCombat() == null) return false;
        return card.getGame().getCombat().isAttacking(card);
    }

    private static int cardsLoaded() {
        try {
            if (StaticData.instance() == null || StaticData.instance().getCommonCards() == null) return 0;
            return (int) StaticData.instance().getCommonCards().streamAllCards().count();
        } catch (Throwable ex) {
            System.err.println("[forge-rlbridge] cards_loaded unavailable: " + ex);
            return 0;
        }
    }

    private String fallbackByKindJson() {
        StringBuilder sb = new StringBuilder();
        sb.append('{');
        synchronized (fallbackByKind) {
            boolean first = true;
            for (java.util.Map.Entry<String, Integer> entry : fallbackByKind.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append('"').append(escape(entry.getKey())).append("\":").append(entry.getValue());
            }
        }
        sb.append('}');
        return sb.toString();
    }

    // ── Tiny JSON helpers ──────────────────────────────────────────────────

    private static void field(StringBuilder sb, String k, int v)     { sb.append('"').append(k).append("\":").append(v); }
    private static void field(StringBuilder sb, String k, boolean v) { sb.append('"').append(k).append("\":").append(v); }
    private static void field(StringBuilder sb, String k, String v)  {
        sb.append('"').append(k).append("\":\"").append(escape(v)).append('"');
    }

    private static String escape(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"':  sb.append("\\\""); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }

    /** Micro JSON reader: tolerant, read-only, flat objects (no nesting). */
    static final class Json {
        private final String src;
        private int pos;
        private Json(String s) { this.src = s; this.pos = 0; }
        static Json parse(String s) { return new Json(s); }

        /** Return top-level string value for `key` or null. */
        String str(String key) {
            int p = findKey(key);
            if (p < 0) return null;
            // findKey returns the index of the opening quote of "key".
            // The needle "key" has length = key.length() + 2 (two quotes).
            skipWs(p + key.length() + 2);
            expect(':');
            skipWs(pos);
            if (src.charAt(pos) == '"') return readString();
            // non-string value (shouldn't happen for our cmd/string fields)
            return null;
        }

        /** Top-level int, or null when the key is absent. */
        Integer intOrNull(String key) {
            int p = findKey(key);
            if (p < 0) return null;
            return intVal(key, 0);
        }

        /** Top-level long, or null when the key is absent. Seed 0 is valid. */
        Long longOrNull(String key) {
            int p = findKey(key);
            if (p < 0) return null;
            skipWs(p + key.length() + 2);
            if (pos >= src.length() || src.charAt(pos) != ':') return null;
            pos++;
            skipWs(pos);
            int start = pos;
            if (pos < src.length() && (src.charAt(pos) == '-' || src.charAt(pos) == '+')) pos++;
            while (pos < src.length() && Character.isDigit(src.charAt(pos))) pos++;
            if (pos == start || (pos == start + 1 && (src.charAt(start) == '-' || src.charAt(start) == '+'))) {
                return null;
            }
            try { return Long.parseLong(src.substring(start, pos)); }
            catch (NumberFormatException e) { return null; }
        }

        /** Return top-level int value for `key` or defaultValue. */
        int intVal(String key, int defaultValue) {
            int p = findKey(key);
            if (p < 0) return defaultValue;
            skipWs(p + key.length() + 2);
            if (pos >= src.length() || src.charAt(pos) != ':') return defaultValue;
            pos++;
            skipWs(pos);
            int start = pos;
            if (pos < src.length() && (src.charAt(pos) == '-' || src.charAt(pos) == '+')) pos++;
            while (pos < src.length() && Character.isDigit(src.charAt(pos))) pos++;
            if (pos == start) return defaultValue;
            try { return Integer.parseInt(src.substring(start, pos)); }
            catch (NumberFormatException e) { return defaultValue; }
        }

        private int findKey(String key) {
            String needle = "\"" + key + "\"";
            return src.indexOf(needle);
        }

        private String readString() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (pos < src.length()) {
                char c = src.charAt(pos++);
                if (c == '"') return sb.toString();
                if (c == '\\' && pos < src.length()) {
                    char e = src.charAt(pos++);
                    switch (e) {
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case '\\': sb.append('\\'); break;
                        case '"': sb.append('"'); break;
                        case 'u':
                            if (pos + 4 <= src.length()) {
                                sb.append((char) Integer.parseInt(src.substring(pos, pos + 4), 16));
                                pos += 4;
                            }
                            break;
                        default: sb.append(e);
                    }
                } else {
                    sb.append(c);
                }
            }
            return sb.toString();
        }

        private void skipWs(int p) {
            pos = p;
            while (pos < src.length() && Character.isWhitespace(src.charAt(pos))) pos++;
        }
        private void expect(char c) {
            if (pos >= src.length() || src.charAt(pos) != c) {
                throw new IllegalStateException("expected '" + c + "' at pos " + pos + " in: " + src);
            }
            pos++;
        }
    }
}

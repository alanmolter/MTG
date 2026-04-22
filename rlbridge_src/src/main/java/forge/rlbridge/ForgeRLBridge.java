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

import com.google.common.eventbus.Subscribe;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
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
 *   IN:  {"cmd":"new_game","agent_deck":"...","opponent_deck":"...","seed":42}
 *                                                → OUT: first state snapshot
 *   IN:  {"cmd":"step","action":<int>}           → OUT: next snapshot (blocks ≤ 10s)
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
public class ForgeRLBridge {

    private static final int ACTION_MASK_SIZE = 512;
    private static final int STEP_TIMEOUT_SECONDS = 20;

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
    private Thread gameThread = null;
    private Game currentGame = null;
    private Player agentPlayer = null;
    private Player opponentPlayer = null;
    private final AtomicBoolean gameFinished = new AtomicBoolean(false);
    private volatile int agentMaxLife = 20;
    private volatile int oppMaxLife = 20;

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
                try {
                    handleCommand(line, protocolOut);
                } catch (Throwable t) {
                    String msg = escape(t.getClass().getSimpleName() + ": " + String.valueOf(t.getMessage()));
                    protocolOut.println("{\"error\":\"" + msg + "\",\"terminal\":true,\"outcome\":0,\"illegal_action\":true}");
                    protocolOut.flush();
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

    private void handleCommand(String line, PrintStream out) throws Exception {
        // Minimal JSON parsing — we only care about a handful of top-level keys
        // and we accept simple string/int/null scalars. This avoids pulling in
        // a JSON library in the bridge jar.
        Json j = Json.parse(line);
        String cmd = j.str("cmd");
        if (cmd == null) {
            out.println("{\"error\":\"missing cmd\"}");
            out.flush();
            return;
        }
        switch (cmd) {
            case "ping":
                out.println("{\"pong\":true}");
                out.flush();
                break;
            case "quit":
                out.println("{\"bye\":true}");
                out.flush();
                System.exit(0);
                break;
            case "new_game":
                startNewGame(j, out);
                break;
            case "step":
                stepGame(j, out);
                break;
            case "step_autoregressive":
                stepAutoregressive(j, out);
                break;
            default:
                out.println("{\"error\":\"unknown cmd: " + escape(cmd) + "\"}");
                out.flush();
        }
    }

    // ── new_game ───────────────────────────────────────────────────────────

    private void startNewGame(Json j, PrintStream out) throws Exception {
        killExistingGame();

        Deck deckA = parseDeck(j.str("agent_deck"), "AgentDeck");
        Deck deckB = parseDeck(j.str("opponent_deck"), "OpponentDeck");

        List<RegisteredPlayer> players = new ArrayList<>();
        RegisteredPlayer rpA = new RegisteredPlayer(deckA).setPlayer(new LobbyPlayerAi("agent", null));
        RegisteredPlayer rpB = new RegisteredPlayer(deckB).setPlayer(new LobbyPlayerAi("opponent", null));
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

        // Resolve agent/opponent Player refs immediately — createGame()
        // already populated game.getPlayers().
        List<Player> ps = game.getPlayers();
        if (ps != null && ps.size() >= 2) {
            this.agentPlayer = ps.get(0);
            this.opponentPlayer = ps.get(1);
        }
        // Mirror what HostedMatch does so each player has opponent refs set.
        for (Player p : game.getPlayers()) {
            p.updateOpponentsForView();
        }

        // Subscribe to game events so we can emit snapshots between turns.
        game.subscribeToEvents(new GameEventListener(this));

        // Run the game on Forge's internal game-thread pool (what HostedMatch
        // does). Spawning a raw Thread fails because ThreadUtil.isGameThread()
        // returns false, and several internal operations (stashGameState,
        // controller.chooseSpellAbilityToPlay) require the game thread context.
        game.getAction().invoke(() -> {
            try {
                match.startGame(game);
            } catch (Throwable t) {
                System.err.println("[forge-rlbridge] game thread crashed: " + t);
                t.printStackTrace(System.err);
            } finally {
                gameFinished.set(true);
                enqueueSnapshot(true);
            }
        });

        // Emit initial snapshot or await first turn event.
        String snap = snapshotQueue.poll(STEP_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        if (snap == null) {
            snap = buildSnapshot(false);
        }
        out.println(snap);
        out.flush();
    }

    // ── step ───────────────────────────────────────────────────────────────

    private void stepGame(Json j, PrintStream out) throws Exception {
        // The `action` param is currently observational — Forge's AI drives
        // both sides. We simply await the next game-state snapshot.
        if (currentGame == null) {
            out.println("{\"error\":\"no game in progress\",\"terminal\":true,\"outcome\":0}");
            out.flush();
            return;
        }
        if (gameFinished.get() && snapshotQueue.isEmpty()) {
            String snap = buildSnapshot(true);
            out.println(snap);
            out.flush();
            return;
        }
        String snap = snapshotQueue.poll(STEP_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        if (snap == null) {
            // Timeout — emit current state with truncated flag
            snap = buildSnapshot(gameFinished.get());
        }
        out.println(snap);
        out.flush();
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
    private void stepAutoregressive(Json j, PrintStream out) throws Exception {
        if (currentGame == null) {
            out.println("{\"error\":\"no game in progress\",\"terminal\":true,\"outcome\":0}");
            out.flush();
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
            // Consume the action without advancing Forge. Return the current
            // snapshot with illegal_action=true → negative reward on the
            // Python side via shaper.penalty_illegal_action.
            String snap = buildSnapshot(gameFinished.get(), true);
            out.println(snap);
            out.flush();
            return;
        }

        // Valid triple — fall through to the same snapshot-await path as
        // stepGame(). action_base dispatch is currently a no-op (Forge's AI
        // drives both sides) but the event-driven snapshot stream still
        // advances turn-by-turn, giving the RL loop a real win/loss signal.
        if (gameFinished.get() && snapshotQueue.isEmpty()) {
            String snap = buildSnapshot(true, false);
            out.println(snap);
            out.flush();
            return;
        }
        String snap = snapshotQueue.poll(STEP_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        if (snap == null) {
            snap = buildSnapshot(gameFinished.get(), false);
        }
        out.println(snap);
        out.flush();
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
        return buildSnapshot(forcedTerminal, false);
    }

    private String buildSnapshot(boolean forcedTerminal, boolean illegalAction) {
        StringBuilder sb = new StringBuilder(2048);
        sb.append('{');

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
        int phase = (g != null && g.getPhaseHandler() != null) ? g.getPhaseHandler().getPhase().ordinal() : -1;
        int bfYou = (you != null) ? you.getCardsIn(ZoneType.Battlefield).size() : 0;
        int bfOpp = (opp != null) ? opp.getCardsIn(ZoneType.Battlefield).size() : 0;
        field(sb, "turn_phase", phase); sb.append(',');
        field(sb, "battlefield_you", bfYou); sb.append(',');
        field(sb, "battlefield_opp", bfOpp); sb.append(',');
        field(sb, "graveyard_you_size", gyYou); sb.append(',');
        field(sb, "graveyard_opp_size", gyOpp); sb.append(',');
        field(sb, "mana_pool_you", 0); sb.append(',');
        field(sb, "mana_pool_opp", 0); sb.append(',');

        // "you" block
        sb.append("\"you\":{");
        field(sb, "life", lifeYou); sb.append(',');
        field(sb, "max_life_seen", agentMaxLife); sb.append(',');
        field(sb, "mana_pool_total", 0); sb.append(',');
        field(sb, "mana_w", 0); sb.append(',');
        field(sb, "mana_u", 0); sb.append(',');
        field(sb, "mana_b", 0); sb.append(',');
        field(sb, "mana_r", 0); sb.append(',');
        field(sb, "mana_g", 0); sb.append(',');
        field(sb, "hand_size", handYou); sb.append(',');
        field(sb, "library_size", libYou); sb.append(',');
        field(sb, "graveyard_size", gyYou); sb.append(',');
        field(sb, "exile_size", exYou); sb.append(',');
        field(sb, "is_active", activeYou);
        sb.append("},");

        // "opp" block
        sb.append("\"opp\":{");
        field(sb, "life", lifeOpp); sb.append(',');
        field(sb, "max_life_seen", oppMaxLife); sb.append(',');
        field(sb, "mana_pool_total", 0); sb.append(',');
        field(sb, "mana_w", 0); sb.append(',');
        field(sb, "mana_u", 0); sb.append(',');
        field(sb, "mana_b", 0); sb.append(',');
        field(sb, "mana_r", 0); sb.append(',');
        field(sb, "mana_g", 0); sb.append(',');
        field(sb, "hand_size", handOpp); sb.append(',');
        field(sb, "library_size", libOpp); sb.append(',');
        field(sb, "graveyard_size", gyOpp); sb.append(',');
        field(sb, "exile_size", exOpp); sb.append(',');
        field(sb, "is_active", activeOpp);
        sb.append("},");

        // cards on battlefield
        sb.append("\"cards\":[");
        boolean first = true;
        if (g != null) {
            for (Card c : g.getCardsIn(ZoneType.Battlefield)) {
                if (!first) sb.append(',');
                first = false;
                appendCard(sb, c);
            }
        }
        sb.append("],");

        sb.append("\"controlled_by_edges\":[],");
        sb.append("\"in_zone_edges\":[],");
        sb.append("\"synergy_edges\":[],");
        sb.append("\"attacks_edges\":[],");

        // action_mask — permissive (all legal) until we wire a custom controller
        sb.append("\"action_mask\":[");
        for (int i = 0; i < ACTION_MASK_SIZE; i++) {
            if (i > 0) sb.append(',');
            sb.append('1');
        }
        sb.append(']');

        sb.append('}');
        return sb.toString();
    }

    private static void appendCard(StringBuilder sb, Card c) {
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
        field(sb, "is_planeswalker", c.isPlaneswalker());
        sb.append('}');
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
        // We no longer own the game thread directly (it runs on Forge's pool).
        // Best-effort: mark the game over so the internal main loop exits.
        try {
            if (currentGame != null && !currentGame.isGameOver()) {
                currentGame.setAge(forge.game.GameStage.GameOver);
            }
        } catch (Throwable ignored) {}
        // Give Forge a beat to observe the state change.
        try { Thread.sleep(50); } catch (InterruptedException ignored) {}
        gameThread = null;
        currentGame = null;
        agentPlayer = null;
        opponentPlayer = null;
        gameFinished.set(true);
        snapshotQueue.clear();
    }

    // ── Tiny JSON helpers ──────────────────────────────────────────────────

    private static void field(StringBuilder sb, String k, int v)     { sb.append('"').append(k).append("\":").append(v); }
    private static void field(StringBuilder sb, String k, boolean v) { sb.append('"').append(k).append("\":").append(v); }

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

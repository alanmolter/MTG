package forge.rlbridge;

import forge.Singletons;
import forge.deck.Deck;
import forge.deck.io.DeckSerializer;
import forge.game.Game;
import forge.game.GameOutcome;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.player.RegisteredPlayer;
import forge.gamemodes.match.HostedMatch;
import forge.gui.FThreads;
import forge.gui.GuiBase;
import forge.player.GamePlayerUtil;
import forge.view.Main;

import java.io.File;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Opens real Forge Desktop UI, starts one visible AI-vs-AI match, prints the
 * result, then exits. This is intentionally separate from ForgeRLBridge's
 * JSON-line headless trainer: the goal here is visual UAT of the pipeline.
 */
public final class VisualAutoMatch {
    private static final String AGENT_NAME = "agent";
    private static final String OPPONENT_NAME = "opponent";
    private static final String RESULT_PREFIX = "VISUAL_AUTO_MATCH_RESULT ";

    private VisualAutoMatch() {}

    public static void main(String[] args) {
        Args parsed = Args.parse(args);
        if (parsed.agentDeck == null || parsed.opponentDeck == null) {
            System.err.println("Usage: VisualAutoMatch --agent-deck <file.dck> --opponent-deck <file.dck> [--timeout-sec 900] [--close-delay-sec 8]");
            System.exit(2);
            return;
        }

        Deck agentDeck = loadDeck(parsed.agentDeck, "agent");
        Deck opponentDeck = loadDeck(parsed.opponentDeck, "opponent");

        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean resultPrinted = new AtomicBoolean(false);

        // Boot Forge exactly like the normal desktop app, so the user sees the
        // same Swing match UI and card interactions as a manual game.
        Main.main(new String[0]);

        Thread watchdog = new Thread(() -> {
            try {
                if (!done.await(parsed.timeoutSec, TimeUnit.SECONDS) && resultPrinted.compareAndSet(false, true)) {
                    printResult("draw", 0, "timeout", parsed.timeoutSec, null);
                    delayedExit(parsed.closeDelaySec);
                }
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }, "VisualAutoMatch-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();

        FThreads.delayInEDT(1500, () -> startVisibleMatch(agentDeck, opponentDeck, parsed, done, resultPrinted));
    }

    private static Deck loadDeck(String deckPath, String role) {
        File file = new File(deckPath);
        Deck deck = DeckSerializer.fromFile(file);
        if (deck == null) {
            System.err.println("[VisualAutoMatch] Could not load " + role + " deck: " + file.getAbsolutePath());
            System.exit(3);
        }
        return deck;
    }

    private static void startVisibleMatch(
        Deck agentDeck,
        Deck opponentDeck,
        Args args,
        CountDownLatch done,
        AtomicBoolean resultPrinted
    ) {
        try {
            List<RegisteredPlayer> players = new ArrayList<>();
            RegisteredPlayer agent = new RegisteredPlayer(agentDeck)
                .setPlayer(GamePlayerUtil.createAiPlayer(AGENT_NAME, 0));
            RegisteredPlayer opponent = new RegisteredPlayer(opponentDeck)
                .setPlayer(GamePlayerUtil.createAiPlayer(OPPONENT_NAME, 1));
            players.add(agent);
            players.add(opponent);

            GameRules rules = new GameRules(GameType.Constructed);
            rules.setAppliedVariants(EnumSet.of(GameType.Constructed));
            rules.setGamesPerMatch(1);
            rules.setSimTimeout(args.timeoutSec);

            HostedMatch hosted = GuiBase.getInterface().hostMatch();
            hosted.setEndGameHook(() -> {
                if (resultPrinted.compareAndSet(false, true)) {
                    printGameResult(hosted.getGame());
                    done.countDown();
                    delayedExit(args.closeDelaySec);
                }
            });
            hosted.startMatch(rules, EnumSet.of(GameType.Constructed), players, (Map<RegisteredPlayer, forge.gui.interfaces.IGuiGame>) null, null);
        } catch (Throwable t) {
            t.printStackTrace(System.err);
            if (resultPrinted.compareAndSet(false, true)) {
                printResult("draw", 0, "error", 0, t.getMessage());
                done.countDown();
                delayedExit(args.closeDelaySec);
            }
        }
    }

    private static void printGameResult(Game game) {
        GameOutcome outcome = game == null ? null : game.getOutcome();
        if (outcome == null || outcome.isDraw()) {
            printResult("draw", 0, "draw", turnsOf(game), null);
            return;
        }

        String winnerName = outcome.getWinningLobbyPlayer() == null
            ? ""
            : outcome.getWinningLobbyPlayer().getName();
        int outcomeCode = AGENT_NAME.equals(winnerName) ? 1 : OPPONENT_NAME.equals(winnerName) ? -1 : 0;
        String winner = outcomeCode == 1 ? "agent" : outcomeCode == -1 ? "opponent" : winnerName;
        printResult(winner, outcomeCode, "completed", turnsOf(game), null);
    }

    private static int turnsOf(Game game) {
        return game == null || game.getPhaseHandler() == null ? 0 : game.getPhaseHandler().getTurn();
    }

    private static void printResult(String winner, int outcome, String status, int turnsOrSeconds, String error) {
        StringBuilder sb = new StringBuilder(160);
        sb.append(RESULT_PREFIX).append("{");
        sb.append("\"winner\":\"").append(escape(winner)).append("\",");
        sb.append("\"outcome\":").append(outcome).append(",");
        sb.append("\"status\":\"").append(escape(status)).append("\",");
        sb.append("\"turns\":").append(Math.max(0, turnsOrSeconds));
        if (error != null && !error.isEmpty()) {
            sb.append(",\"error\":\"").append(escape(error)).append("\"");
        }
        sb.append("}");
        System.out.println(sb);
        System.out.flush();
    }

    private static String escape(String raw) {
        return raw == null ? "" : raw.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static void delayedExit(int closeDelaySec) {
        Thread closer = new Thread(() -> {
            try {
                Thread.sleep(Math.max(0, closeDelaySec) * 1000L);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            System.exit(0);
        }, "VisualAutoMatch-closer");
        closer.setDaemon(false);
        closer.start();
    }

    private static final class Args {
        String agentDeck;
        String opponentDeck;
        int timeoutSec = 900;
        int closeDelaySec = 8;

        static Args parse(String[] args) {
            Args parsed = new Args();
            for (int i = 0; i < args.length; i++) {
                String arg = args[i];
                if ("--agent-deck".equals(arg) && i + 1 < args.length) {
                    parsed.agentDeck = args[++i];
                } else if ("--opponent-deck".equals(arg) && i + 1 < args.length) {
                    parsed.opponentDeck = args[++i];
                } else if ("--timeout-sec".equals(arg) && i + 1 < args.length) {
                    parsed.timeoutSec = Integer.parseInt(args[++i]);
                } else if ("--close-delay-sec".equals(arg) && i + 1 < args.length) {
                    parsed.closeDelaySec = Integer.parseInt(args[++i]);
                }
            }
            return parsed;
        }
    }
}

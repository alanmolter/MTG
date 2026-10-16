package forge.rlbridge;

import forge.LobbyPlayer;
import forge.ai.LobbyPlayerAi;
import forge.ai.PlayerControllerAi;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.player.Player;
import forge.game.player.PlayerController;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.TargetRestrictions;
import forge.game.zone.ZoneType;

import java.util.ArrayList;
import java.util.List;

/**
 * Agent-seat controller. Covered decisions block on {@link Host#decide}
 * until Python sends a legal slot. Everything else stays on Forge AI and
 * counts as a fallback. Mana payment is Forge's job and is not a fallback.
 */
public final class ExternalPlayerController extends PlayerControllerAi {

    public interface Host {
        int decide(String decisionKind, ProtocolV2.Layout layout, int aiChosenSlot);
        void noteFallback(String decisionKind, String why);
        boolean discarded();
        int visibleIndex(Card card);
    }

    private final Host host;

    public ExternalPlayerController(Game game, Player player, LobbyPlayer lobby, Host host) {
        super(game, player, lobby);
        this.host = host;
    }

    @Override
    public Player chooseStartingPlayer(boolean isFirstGame) {
        return this.player;
    }

    @Override
    public boolean mulliganKeepHand(Player mulliganingPlayer, int cardsToReturn) {
        if (host.discarded()) return true;
        try {
            List<ProtocolV2.Option> options = new ArrayList<>();
            Card sample = firstCard(player.getCardsIn(ZoneType.Hand));
            int source = sample == null ? -1 : host.visibleIndex(sample);
            if (source >= 0) options.add(new ProtocolV2.Option(1, source, -1, "mulligan"));
            int slot = ask("mulligan", options, true, aiMulliganSlot());
            if (slot < 0 || slot == 0) return true;
            return false;
        } catch (RuntimeException ex) {
            host.noteFallback("mulligan", ex.toString());
            return super.mulliganKeepHand(mulliganingPlayer, cardsToReturn);
        }
    }

    @Override
    public CardCollectionView tuckCardsViaMulligan(CardCollectionView hand, int cardsToReturn) {
        if (host.discarded()) return super.tuckCardsViaMulligan(hand, cardsToReturn);
        try {
            CardCollection toReturn = new CardCollection();
            for (int i = 0; i < cardsToReturn; i++) {
                List<Card> remaining = new ArrayList<>();
                List<ProtocolV2.Option> options = new ArrayList<>();
                for (Card card : hand) {
                    if (toReturn.contains(card)) continue;
                    int source = host.visibleIndex(card);
                    if (source < 0) continue;
                    remaining.add(card);
                    options.add(new ProtocolV2.Option(1, source, -1, "tuck"));
                }
                if (options.isEmpty()) break;
                int slot = ask("choose_cards", options, false, -1);
                int index = lastOptionIndex;
                if (slot < 0 || index < 0 || index >= remaining.size()) break;
                toReturn.add(remaining.get(index));
            }
            return CardCollection.getView(toReturn);
        } catch (RuntimeException ex) {
            host.noteFallback("choose_cards", ex.toString());
            return super.tuckCardsViaMulligan(hand, cardsToReturn);
        }
    }

    @Override
    public List<SpellAbility> chooseSpellAbilityToPlay() {
        if (host.discarded()) return null;
        try {
            List<SpellAbility> abilities = new ArrayList<>();
            List<ProtocolV2.Option> options = new ArrayList<>();
            collectPlayable(abilities, options);
            int slot = ask("priority", options, true, aiPrioritySlot(abilities, options));
            if (slot < 0 || slot == 0 || lastOptionIndex < 0 || lastOptionIndex >= abilities.size()) {
                return null;
            }
            return java.util.Collections.singletonList(abilities.get(lastOptionIndex));
        } catch (RuntimeException ex) {
            host.noteFallback("priority", ex.toString());
            return super.chooseSpellAbilityToPlay();
        }
    }

    @Override
    public boolean chooseTargetsFor(SpellAbility currentAbility) {
        if (host.discarded()) return false;
        try {
            if (currentAbility.isDividedAsYouChoose() || currentAbility.getTargetRestrictions() == null
                    || !currentAbility.usesTargeting()) {
                if (currentAbility.isDividedAsYouChoose()) {
                    host.noteFallback("choose_targets", "divided");
                    return super.chooseTargetsFor(currentAbility);
                }
                return true;
            }
            TargetRestrictions restrictions = currentAbility.getTargetRestrictions();
            int min = restrictions.getMinTargets(currentAbility.getHostCard(), currentAbility);
            int max = restrictions.getMaxTargets(currentAbility.getHostCard(), currentAbility);
            currentAbility.clearTargets();
            int chosen = 0;
            while (chosen < max) {
                List<GameEntity> candidates = restrictions.getAllCandidates(currentAbility, true);
                List<ProtocolV2.Option> options = new ArrayList<>();
                List<GameEntity> encoded = new ArrayList<>();
                int source = host.visibleIndex(currentAbility.getHostCard());
                if (source < 0) source = 0;
                for (GameEntity candidate : candidates) {
                    if (currentAbility.getTargets().contains(candidate)) continue;
                    int target = targetIndex(candidate);
                    if (target < -3) continue;
                    if (!(candidate instanceof Card) && target >= 0) continue;
                    encoded.add(candidate);
                    options.add(new ProtocolV2.Option(4, source, target, "target"));
                }
                boolean canFinish = chosen >= min;
                if (options.isEmpty()) break;
                int slot = ask("choose_targets", options, canFinish, -1);
                if (slot < 0 || slot == 0 || lastOptionIndex < 0) break;
                currentAbility.getTargets().add(encoded.get(lastOptionIndex));
                chosen++;
                if (max <= 1) break;
            }
            return chosen >= min;
        } catch (RuntimeException ex) {
            host.noteFallback("choose_targets", ex.toString());
            return super.chooseTargetsFor(currentAbility);
        }
    }

    @Override
    public void declareAttackers(Player attacker, Combat combat) {
        if (attacker != player || host.discarded()) {
            if (attacker == player) return;
            super.declareAttackers(attacker, combat);
            return;
        }
        try {
            for (Card card : CombatUtil.getPossibleAttackers(attacker)) {
                List<GameEntity> defenders = new ArrayList<>();
                List<ProtocolV2.Option> options = new ArrayList<>();
                int source = host.visibleIndex(card);
                if (source < 0) continue;
                for (GameEntity defender : CombatUtil.getAllPossibleDefenders(attacker)) {
                    if (!CombatUtil.canAttack(card, defender)) continue;
                    int target = targetIndex(defender);
                    if (target == -1) continue;
                    defenders.add(defender);
                    options.add(new ProtocolV2.Option(2, source, target, "attack"));
                }
                if (options.isEmpty()) continue;
                int slot = ask("declare_attackers", options, true, -1);
                if (slot < 0) return;
                if (slot == 0 || lastOptionIndex < 0) continue;
                combat.addAttacker(card, defenders.get(lastOptionIndex));
            }
        } catch (RuntimeException ex) {
            host.noteFallback("declare_attackers", ex.toString());
            super.declareAttackers(attacker, combat);
        }
    }

    @Override
    public void declareBlockers(Player defender, Combat combat) {
        if (defender != player || host.discarded()) {
            if (defender == player) return;
            super.declareBlockers(defender, combat);
            return;
        }
        try {
            for (Card blocker : player.getCardsIn(ZoneType.Battlefield)) {
                if (!blocker.isCreature()) continue;
                int source = host.visibleIndex(blocker);
                if (source < 0) continue;
                List<Card> attackers = new ArrayList<>();
                List<ProtocolV2.Option> options = new ArrayList<>();
                for (Card attacker : combat.getAttackers()) {
                    if (!CombatUtil.canBlock(attacker, blocker, combat)) continue;
                    int target = host.visibleIndex(attacker);
                    if (target < 0) continue;
                    attackers.add(attacker);
                    options.add(new ProtocolV2.Option(3, source, target, "block"));
                }
                if (options.isEmpty()) continue;
                int slot = ask("declare_blockers", options, true, -1);
                if (slot < 0) return;
                if (slot == 0 || lastOptionIndex < 0) continue;
                combat.addBlocker(attackers.get(lastOptionIndex), blocker);
            }
        } catch (RuntimeException ex) {
            host.noteFallback("declare_blockers", ex.toString());
            super.declareBlockers(defender, combat);
        }
    }

    @Override
    public CardCollection chooseCardsToDiscardToMaximumHandSize(int numDiscard) {
        if (host.discarded()) return super.chooseCardsToDiscardToMaximumHandSize(numDiscard);
        try {
            CardCollection discarded = new CardCollection();
            for (int i = 0; i < numDiscard; i++) {
                List<Card> remaining = new ArrayList<>();
                List<ProtocolV2.Option> options = new ArrayList<>();
                for (Card card : player.getCardsIn(ZoneType.Hand)) {
                    if (discarded.contains(card)) continue;
                    int source = host.visibleIndex(card);
                    if (source < 0) continue;
                    remaining.add(card);
                    options.add(new ProtocolV2.Option(1, source, -1, "discard"));
                }
                if (options.isEmpty()) break;
                int slot = ask("choose_cards", options, false, -1);
                if (slot < 0 || lastOptionIndex < 0 || lastOptionIndex >= remaining.size()) break;
                discarded.add(remaining.get(lastOptionIndex));
            }
            return discarded;
        } catch (RuntimeException ex) {
            host.noteFallback("choose_cards", ex.toString());
            return super.chooseCardsToDiscardToMaximumHandSize(numDiscard);
        }
    }

    private int lastOptionIndex = -1;
    private ProtocolV2.Layout lastLayout;

    private int ask(String kind, List<ProtocolV2.Option> options, boolean passLegal, int aiSlot) {
        lastOptionIndex = -1;
        int page = 0;
        int pages = ProtocolV2.pageCount(options.size());
        while (!host.discarded()) {
            ProtocolV2.Layout layout = ProtocolV2.layout(options, page, passLegal);
            lastLayout = layout;
            int hinted = aiSlot;
            if (hinted > 0 && (hinted >= layout.optionIndex.length || layout.optionIndex[hinted] < 0)
                    && hinted != ProtocolV2.PAGE_PREV && hinted != ProtocolV2.PAGE_NEXT) {
                hinted = -1;
            }
            int slot = host.decide(kind, layout, hinted);
            if (slot < 0) return -1;
            if (slot == ProtocolV2.PAGE_PREV) {
                page = Math.max(0, page - 1);
                continue;
            }
            if (slot == ProtocolV2.PAGE_NEXT) {
                page = Math.min(pages - 1, page + 1);
                continue;
            }
            if (slot == 0 && passLegal) return 0;
            lastOptionIndex = layout.optionIndex[slot];
            return slot;
        }
        return -1;
    }

    private void collectPlayable(List<SpellAbility> abilities, List<ProtocolV2.Option> options) {
        ZoneType[] zones = {ZoneType.Hand, ZoneType.Battlefield, ZoneType.Graveyard, ZoneType.Exile};
        for (ZoneType zone : zones) {
            for (Card card : player.getCardsIn(zone)) {
                int source = host.visibleIndex(card);
                if (source < 0) continue;
                for (SpellAbility ability : card.getAllPossibleAbilities(player, true)) {
                    if (ability == null) continue;
                    if (ability.isManaAbility() && !ability.isLandAbility()) continue;
                    if (!ability.canPlay()) continue;
                    int kind = ability.isLandAbility() || ability.isSpell() ? 1 : 5;
                    String name = ability.toString();
                    if (name.length() > 180) name = name.substring(0, 180);
                    abilities.add(ability);
                    options.add(new ProtocolV2.Option(kind, source, -1, name));
                }
            }
        }
    }

    private int aiPrioritySlot(List<SpellAbility> abilities, List<ProtocolV2.Option> options) {
        PlayerController previous = player.getController();
        PlayerControllerAi ai = new PlayerControllerAi(getGame(), player, getLobbyPlayer());
        try {
            player.dangerouslySetController(ai);
            List<SpellAbility> chosen = ai.chooseSpellAbilityToPlay();
            if (chosen == null || chosen.isEmpty()) return 0;
            SpellAbility want = chosen.get(0);
            for (int i = 0; i < abilities.size(); i++) {
                if (abilities.get(i) == want) {
                    ProtocolV2.Layout layout = ProtocolV2.layout(options, 0, true);
                    for (int slot = 0; slot < layout.optionIndex.length; slot++) {
                        if (layout.optionIndex[slot] == i) return slot;
                    }
                }
            }
        } catch (RuntimeException ignored) {
            return -1;
        } finally {
            player.dangerouslySetController(previous);
        }
        return -1;
    }

    private int aiMulliganSlot() {
        PlayerController previous = player.getController();
        PlayerControllerAi ai = new PlayerControllerAi(getGame(), player, getLobbyPlayer());
        try {
            player.dangerouslySetController(ai);
            return ai.mulliganKeepHand(player, 0) ? 0 : 1;
        } catch (RuntimeException ignored) {
            return -1;
        } finally {
            player.dangerouslySetController(previous);
        }
    }

    private int targetIndex(GameEntity entity) {
        if (entity == player) return -2;
        if (entity instanceof Player) return -3;
        if (entity instanceof Card) return host.visibleIndex((Card) entity);
        return -1;
    }

    private static Card firstCard(CardCollectionView cards) {
        if (cards == null) return null;
        for (Card card : cards) return card;
        return null;
    }
}

/**
 * Installs {@link ExternalPlayerController} as the agent seat. The opponent
 * stays a {@link LobbyPlayerAi}. Mind-control creates a plain AI controller.
 */
final class ExternalLobbyPlayer extends LobbyPlayer implements forge.game.player.IGameEntitiesFactory {
    private final ExternalPlayerController.Host host;

    ExternalLobbyPlayer(String name, ExternalPlayerController.Host host) {
        super(name);
        this.host = host;
    }

    @Override
    public Player createIngamePlayer(Game game, int id) {
        Player ingame = new Player(getName(), game, id);
        ingame.setFirstController(new ExternalPlayerController(game, ingame, this, host));
        return ingame;
    }

    @Override
    public PlayerController createMindSlaveController(Player master, Player slave) {
        return new PlayerControllerAi(slave.getGame(), slave, this);
    }

    @Override
    public void hear(LobbyPlayer player, String message) { }
}

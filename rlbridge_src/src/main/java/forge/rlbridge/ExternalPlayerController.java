package forge.rlbridge;

import forge.LobbyPlayer;
import forge.ai.ComputerUtil;
import forge.ai.ComputerUtilCost;
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
import com.google.common.collect.ListMultimap;
import com.google.common.collect.Multimap;
import forge.card.ColorSet;
import forge.card.ICardFace;
import forge.card.mana.ManaCost;
import forge.card.mana.ManaCostShard;
import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.game.ability.ApiType;
import forge.game.ability.effects.CharmEffect;
import forge.game.ability.effects.RollDiceEffect;
import forge.game.card.CardState;
import forge.game.card.CounterType;
import forge.game.cost.Cost;
import forge.game.cost.CostDecisionMakerBase;
import forge.game.cost.CostPart;
import forge.game.cost.CostPartMana;
import forge.game.cost.CostPartWithList;
import forge.game.keyword.KeywordInterface;
import forge.game.mana.Mana;
import forge.game.mana.ManaConversionMatrix;
import forge.game.mana.ManaCostBeingPaid;
import forge.game.GameObject;
import forge.game.GameType;
import forge.game.PlanarDice;
import forge.game.player.DelayedReveal;
import forge.game.player.PlayerActionConfirmMode;
import forge.game.spellability.TargetChoices;

import java.util.function.Predicate;
import forge.game.replacement.ReplacementEffect;
import forge.game.spellability.AbilitySub;
import forge.game.spellability.OptionalCostValue;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.staticability.StaticAbility;
import forge.game.trigger.WrappedAbility;
import forge.game.zone.PlayerZone;
import forge.item.PaperCard;
import forge.util.ITriggerEvent;
import forge.util.collect.FCollectionView;
import org.apache.commons.lang3.tuple.ImmutablePair;
import org.apache.commons.lang3.tuple.Pair;

import java.util.Collection;
import forge.game.zone.ZoneType;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * Agent-seat controller. Covered decisions block on {@link Host#decide}
 * until Python sends a legal slot. {@code chosen_action} is the Forge AI
 * slot for that decision (attack, block, target, discard, mulligan, priority).
 *
 * <p>{@code ai_fallback_decisions} counts decisions this class does not
 * cover and therefore delegates to {@link PlayerControllerAi}. It is not an
 * exception counter. Mana payment, reveals, and turn bookkeeping are not
 * decisions and are not counted. A bridge failure (serialization, a bad
 * snapshot) is {@code ENGINE_ERROR}: it is logged, counted as
 * {@code bridge_errors}, and does not call the AI.
 */
public final class ExternalPlayerController extends PlayerControllerAi {

    public interface Host {
        /** Epoch of the match that is open while this controller is constructed. */
        int epoch();
        int decide(String decisionKind, ProtocolV2.Layout layout, int aiChosenSlot, int epoch);
        void noteFallback(String decisionKind, String why);
        void noteBridgeError(String decisionKind, Throwable error, int epoch);
        /** Result of the spell or land the previous priority action tried to play. */
        void noteSpellPlayed(boolean applied, String failure);
        boolean discarded();
        int visibleIndex(Card card);
    }

    private final Host host;
    /** Captured at construction. Later matches must not reuse this controller's epoch. */
    private final int epoch;
    /**
     * Greater than zero while the legal mask is asking whether a spell can be
     * paid. Cost reduction then calls back into this controller. That is a
     * probe, not a decision the policy missed, so it is not an ai_fallback.
     */
    private int maskProbe;

    public ExternalPlayerController(Game game, Player player, LobbyPlayer lobby, Host host) {
        super(game, player, lobby);
        this.host = host;
        this.epoch = host.epoch();
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
            host.noteBridgeError("mulligan", ex, epoch);
            return true;
        }
    }

    @Override
    public CardCollectionView tuckCardsViaMulligan(CardCollectionView hand, int cardsToReturn) {
        if (host.discarded()) return super.tuckCardsViaMulligan(hand, cardsToReturn);
        try {
            List<Card> planned = aiTuck(hand, cardsToReturn);
            int cursor = 0;
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
                int hint = cursor < planned.size()
                    ? slotFor(options, host.visibleIndex(planned.get(cursor)), -1, false) : -1;
                int slot = ask("choose_cards", options, false, hint);
                cursor++;
                int index = lastOptionIndex;
                if (slot < 0 || index < 0 || index >= remaining.size()) break;
                toReturn.add(remaining.get(index));
            }
            return CardCollection.getView(toReturn);
        } catch (RuntimeException ex) {
            host.noteBridgeError("choose_cards", ex, epoch);
            return CardCollection.getView(new CardCollection());
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
            host.noteBridgeError("priority", ex, epoch);
            return null;
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
            List<GameEntity> planned = aiTargetPlan(currentAbility);
            if (host.discarded()) return false;
            currentAbility.clearTargets();
            int chosen = 0;
            int cursor = 0;
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
                int hint;
                if (cursor < planned.size()) {
                    hint = slotFor(options, source, targetIndex(planned.get(cursor)), canFinish);
                } else {
                    hint = canFinish ? 0 : -1;
                }
                int slot = ask("choose_targets", options, canFinish, hint);
                cursor++;
                if (slot < 0 || slot == 0 || lastOptionIndex < 0) break;
                currentAbility.getTargets().add(encoded.get(lastOptionIndex));
                chosen++;
                if (max <= 1) break;
            }
            return chosen >= min;
        } catch (RuntimeException ex) {
            host.noteBridgeError("choose_targets", ex, epoch);
            return false;
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
            Map<Card, GameEntity> plan = aiAttackPlan(attacker);
            if (host.discarded()) return;
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
                int hint = 0;
                GameEntity plannedDefender = plan.get(card);
                if (plannedDefender != null) {
                    hint = slotFor(options, source, targetIndex(plannedDefender), true);
                }
                int slot = ask("declare_attackers", options, true, hint);
                if (slot < 0) return;
                if (slot == 0 || lastOptionIndex < 0) continue;
                combat.addAttacker(card, defenders.get(lastOptionIndex));
            }
        } catch (RuntimeException ex) {
            host.noteBridgeError("declare_attackers", ex, epoch);
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
            Map<Card, Card> plan = aiBlockPlan(defender, combat);
            if (host.discarded()) return;
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
                int hint = 0;
                Card plannedAttacker = plan.get(blocker);
                if (plannedAttacker != null) {
                    hint = slotFor(options, source, host.visibleIndex(plannedAttacker), true);
                }
                int slot = ask("declare_blockers", options, true, hint);
                if (slot < 0) return;
                if (slot == 0 || lastOptionIndex < 0) continue;
                combat.addBlocker(attackers.get(lastOptionIndex), blocker);
            }
        } catch (RuntimeException ex) {
            host.noteBridgeError("declare_blockers", ex, epoch);
        }
    }

    @Override
    public CardCollection chooseCardsToDiscardToMaximumHandSize(int numDiscard) {
        if (host.discarded()) return super.chooseCardsToDiscardToMaximumHandSize(numDiscard);
        try {
            CardCollection planned = aiDiscard(numDiscard);
            int cursor = 0;
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
                int hint = cursor < planned.size()
                    ? slotFor(options, host.visibleIndex(planned.get(cursor)), -1, false) : -1;
                int slot = ask("choose_cards", options, false, hint);
                cursor++;
                if (slot < 0 || lastOptionIndex < 0 || lastOptionIndex >= remaining.size()) break;
                discarded.add(remaining.get(lastOptionIndex));
            }
            return discarded;
        } catch (RuntimeException ex) {
            host.noteBridgeError("choose_cards", ex, epoch);
            return new CardCollection();
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
            int slot = host.decide(kind, layout, hinted, epoch);
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
                    clearChainTargets(ability);
                    if (ability.isManaAbility() && !ability.isLandAbility()) continue;
                    maskProbe++;
                    boolean offered;
                    try {
                        offered = ability.canPlay() && payable(ability);
                    } finally {
                        maskProbe--;
                    }
                    if (!offered) continue;
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
            // The probe chooses targets on the same SpellAbility objects the
            // policy will cast. Drop them so play goes through choose_targets.
            clearPresetTargets();
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

    @Override
    public boolean playChosenSpellAbility(SpellAbility sa) {
        // Execution, not an ai_fallback. Targets are a separate policy decision:
        // the AI hint must not arrive already written onto this SpellAbility.
        try {
            if (sa.isLandAbility()) {
                boolean played = super.playChosenSpellAbility(sa);
                host.noteSpellPlayed(played, played ? null : "land not played");
                return played;
            }
            clearChainTargets(sa);
            final boolean[] targetsOk = {true};
            boolean played = ComputerUtil.handlePlayingSpellAbility(player, sa, () -> {
                targetsOk[0] = chooseChainTargets(sa);
            });
            played = played && targetsOk[0];
            String failure = played ? null : "AI failed to play " + sa.getHostCard();
            if (!played) System.err.println("[forge-rlbridge] spell failed " + failure);
            host.noteSpellPlayed(played, failure);
            return played;
        } catch (RuntimeException ex) {
            String failure = "spell failed " + sa + " " + ex;
            System.err.println("[forge-rlbridge] " + failure);
            ex.printStackTrace(System.err);
            host.noteSpellPlayed(false, failure);
            return false;
        }
    }

    /**
     * Policy targets for this spell and its sub-abilities. Returns false when
     * a required target was not chosen, so the cast is not reported as applied.
     */
    private boolean chooseChainTargets(SpellAbility sa) {
        boolean ok = true;
        SpellAbility cur = sa;
        while (cur != null) {
            if (cur.usesTargeting()) {
                cur.clearTargets();
                if (!chooseTargetsFor(cur)) {
                    cur.resetTargets();
                    ok = false;
                }
            }
            cur = cur.getSubAbility();
        }
        if (!ok && sa != null) {
            if (sa.usesTargeting()) sa.resetTargets();
            else if (sa.getTargets() != null) sa.getTargets().add(player);
        }
        return ok;
    }

    private boolean payable(SpellAbility ability) {
        if (ability.isLandAbility()) return true;
        try {
            if (ability.getPayCosts() == null) return true;
            return ComputerUtilCost.canPayCost(ability, player, false);
        } catch (RuntimeException ex) {
            return false;
        }
    }

    private void clearPresetTargets() {
        ZoneType[] zones = {
            ZoneType.Hand, ZoneType.Battlefield, ZoneType.Graveyard,
            ZoneType.Exile, ZoneType.Command
        };
        for (ZoneType zone : zones) {
            CardCollectionView cards;
            try {
                cards = player.getCardsIn(zone);
            } catch (RuntimeException ex) {
                continue;
            }
            if (cards == null) continue;
            for (Card card : cards) {
                try {
                    for (SpellAbility ability : card.getAllPossibleAbilities(player, true)) {
                        if (ability != null) clearChainTargets(ability);
                    }
                } catch (RuntimeException ignored) { }
            }
        }
    }

    private static void clearChainTargets(SpellAbility sa) {
        SpellAbility cur = sa;
        while (cur != null) {
            try {
                cur.clearTargets();
            } catch (RuntimeException ignored) { }
            cur = cur.getSubAbility();
        }
    }

    private <T> T delegated(String kind, Supplier<T> call) {
        if (maskProbe == 0 && !host.discarded()) host.noteFallback(kind, "delegated");
        return call.get();
    }

    private void delegatedVoid(String kind, Runnable call) {
        if (maskProbe == 0 && !host.discarded()) host.noteFallback(kind, "delegated");
        call.run();
    }

    private int slotFor(List<ProtocolV2.Option> options, int source, int target, boolean passLegal) {
        if (source < 0) return passLegal ? 0 : -1;
        ProtocolV2.Layout layout = ProtocolV2.layout(options, 0, passLegal);
        for (int i = 0; i < options.size(); i++) {
            ProtocolV2.Option option = options.get(i);
            if (source >= 0 && option.source != source) continue;
            if (target >= -3 && option.target != target) continue;
            for (int slot = 0; slot < layout.optionIndex.length; slot++) {
                if (layout.optionIndex[slot] == i) return slot;
            }
        }
        return passLegal ? 0 : -1;
    }

    private Map<Card, GameEntity> aiAttackPlan(Player attacker) {
        Map<Card, GameEntity> plan = new HashMap<>();
        PlayerController previous = player.getController();
        PlayerControllerAi ai = new PlayerControllerAi(getGame(), player, getLobbyPlayer());
        Combat probe = new Combat(attacker);
        try {
            player.dangerouslySetController(ai);
            ai.declareAttackers(attacker, probe);
            for (Card card : probe.getAttackers()) {
                GameEntity defender = probe.getDefenderByAttacker(card);
                if (defender != null) plan.put(card, defender);
            }
        } catch (RuntimeException ex) {
            System.err.println("[forge-rlbridge] ai label declare_attackers " + ex);
        } finally {
            player.dangerouslySetController(previous);
            for (Card card : new ArrayList<>(probe.getAttackers())) probe.removeFromCombat(card);
        }
        return plan;
    }

    private Map<Card, Card> aiBlockPlan(Player defender, Combat combat) {
        Map<Card, Card> plan = new HashMap<>();
        List<Card> assigned = new ArrayList<>();
        PlayerController previous = player.getController();
        PlayerControllerAi ai = new PlayerControllerAi(getGame(), player, getLobbyPlayer());
        try {
            player.dangerouslySetController(ai);
            ai.declareBlockers(defender, combat);
            for (Card blocker : player.getCardsIn(ZoneType.Battlefield)) {
                if (!combat.isBlocking(blocker)) continue;
                assigned.add(blocker);
                CardCollection attackers = combat.getAttackersBlockedBy(blocker);
                if (attackers != null && !attackers.isEmpty()) plan.put(blocker, attackers.get(0));
            }
        } catch (RuntimeException ex) {
            System.err.println("[forge-rlbridge] ai label declare_blockers " + ex);
        } finally {
            player.dangerouslySetController(previous);
            for (Card blocker : player.getCardsIn(ZoneType.Battlefield)) {
                if (combat.isBlocking(blocker)) combat.undoBlockingAssignment(blocker);
            }
        }
        return plan;
    }

    private List<GameEntity> aiTargetPlan(SpellAbility ability) {
        List<GameEntity> chosen = new ArrayList<>();
        PlayerController previous = player.getController();
        PlayerControllerAi ai = new PlayerControllerAi(getGame(), player, getLobbyPlayer());
        try {
            player.dangerouslySetController(ai);
            ability.clearTargets();
            if (ai.chooseTargetsFor(ability) && ability.getTargets() != null) {
                for (forge.game.GameObject obj : ability.getTargets()) {
                    if (obj instanceof GameEntity) chosen.add((GameEntity) obj);
                }
            }
        } catch (RuntimeException ex) {
            System.err.println("[forge-rlbridge] ai label choose_targets " + ex);
        } finally {
            try { ability.clearTargets(); } catch (RuntimeException ignored) { }
            player.dangerouslySetController(previous);
        }
        return chosen;
    }

    private CardCollection aiDiscard(int numDiscard) {
        PlayerController previous = player.getController();
        PlayerControllerAi ai = new PlayerControllerAi(getGame(), player, getLobbyPlayer());
        try {
            player.dangerouslySetController(ai);
            CardCollection chosen = ai.chooseCardsToDiscardToMaximumHandSize(numDiscard);
            return chosen == null ? new CardCollection() : chosen;
        } catch (RuntimeException ex) {
            System.err.println("[forge-rlbridge] ai label choose_cards " + ex);
            return new CardCollection();
        } finally {
            player.dangerouslySetController(previous);
        }
    }

    private List<Card> aiTuck(CardCollectionView hand, int cardsToReturn) {
        PlayerController previous = player.getController();
        PlayerControllerAi ai = new PlayerControllerAi(getGame(), player, getLobbyPlayer());
        try {
            player.dangerouslySetController(ai);
            CardCollectionView chosen = ai.tuckCardsViaMulligan(hand, cardsToReturn);
            List<Card> cards = new ArrayList<>();
            if (chosen != null) for (Card card : chosen) cards.add(card);
            return cards;
        } catch (RuntimeException ex) {
            System.err.println("[forge-rlbridge] ai label mulligan " + ex);
            return new ArrayList<>();
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

    @Override
    public SpellAbility getAbilityToPlay(Card hostCard, List<SpellAbility> abilities, ITriggerEvent triggerEvent) {
        return delegated("getAbilityToPlay", () -> super.getAbilityToPlay(hostCard, abilities, triggerEvent));
    }

    @Override
    public void playSpellAbilityNoStack(SpellAbility effectSA, boolean mayChoseNewTargets) {
        if (host.discarded()) return;
        try {
            // false is execution of a trigger whose targets were already chosen.
            // true is a replacement or effect that would otherwise let doTrigger pick them.
            if (mayChoseNewTargets && !preparePolicyTrigger(effectSA, true)) return;
            ComputerUtil.playNoStack(player, effectSA, getGame(), true);
        } catch (RuntimeException ex) {
            host.noteBridgeError("play_trigger", ex, epoch);
        }
    }

    @Override
    public void orderAndPlaySimultaneousSa(List<SpellAbility> activePlayerSAs) {
        if (host.discarded() || activePlayerSAs == null || activePlayerSAs.isEmpty()) return;
        // Ordering simultaneous triggers is not a target. Targets are chosen below.
        if (!host.discarded()) host.noteFallback("orderAndPlaySimultaneousSa", "order");
        List<SpellAbility> ordered = activePlayerSAs;
        try {
            List<SpellAbility> aiOrder = super.orderSimultaneousSa(new ArrayList<>(activePlayerSAs));
            if (aiOrder != null && !aiOrder.isEmpty()) ordered = aiOrder;
        } catch (RuntimeException ex) {
            System.err.println("[forge-rlbridge] trigger order " + ex);
        }
        for (SpellAbility sa : ordered) {
            try {
                if (sa.isTrigger() && !sa.isCopied()) {
                    if (!preparePolicyTrigger(sa, true)) continue;
                    ComputerUtil.playStack(sa, player, getGame());
                    continue;
                }
                if (sa.isCopied()) {
                    if (sa.isSpell() && sa.getHostCard() != null && !sa.getHostCard().isInZone(ZoneType.Stack)) {
                        sa.setHostCard(getGame().getAction().moveToStack(sa.getHostCard(), sa));
                    } else if (sa.isSpell()) {
                        getGame().getStackZone().add(sa.getHostCard());
                    }
                    if (sa.isMayChooseNewTargets()) {
                        clearChainTargets(sa);
                        chooseChainTargets(sa);
                    }
                }
                getGame().getStack().add(sa);
            } catch (RuntimeException ex) {
                host.noteBridgeError("play_trigger", ex, epoch);
            }
        }
    }

    @Override
    public boolean playTrigger(Card card, WrappedAbility wrapperAbility, boolean isMandatory) {
        if (host.discarded()) return false;
        try {
            if (!preparePolicyTrigger(wrapperAbility, !isMandatory)) return false;
            return ComputerUtil.playNoStack(player, wrapperAbility, getGame(), true);
        } catch (RuntimeException ex) {
            host.noteBridgeError("play_trigger", ex, epoch);
            return false;
        }
    }

    /**
     * Optional triggers ask {@code play_trigger}. Any targeted trigger or
     * replacement then asks {@code choose_targets}. The AI does not keep the
     * targets it found while ordering or probing the trigger.
     */
    private boolean preparePolicyTrigger(SpellAbility sa, boolean askOptional) {
        if (sa == null) return false;
        if (askOptional && sa.isOptionalTrigger() && !acceptOptionalTrigger(sa)) return false;
        if (sa.getApi() == ApiType.Charm && !CharmEffect.makeChoices(sa)) return false;
        boolean targeted = chainUsesTargeting(sa);
        clearChainTargets(sa);
        boolean ok = !targeted || chooseChainTargets(sa);
        if (targeted) {
            String name = sa.getHostCard() == null ? "?" : sa.getHostCard().getName();
            System.err.println("[forge-rlbridge] etb_target " + name + " "
                + (ok ? "choose_targets" : "no_legal_target"));
        }
        return ok;
    }

    private boolean acceptOptionalTrigger(SpellAbility sa) {
        int source = sa.getHostCard() == null ? 0 : host.visibleIndex(sa.getHostCard());
        if (source < 0) source = 0;
        String name = sa.getHostCard() == null ? "trigger" : sa.getHostCard().getName();
        if (name.length() > 160) name = name.substring(0, 160);
        List<ProtocolV2.Option> options = new ArrayList<>();
        options.add(new ProtocolV2.Option(5, source, -1, "trigger " + name));
        // Slot 1 is "play it". Probing doTrigger for the hint would choose
        // targets on this controller, which is the path this method replaces.
        int slot = ask("play_trigger", options, true, 1);
        return slot > 0;
    }

    private static boolean chainUsesTargeting(SpellAbility sa) {
        SpellAbility cur = sa;
        while (cur != null) {
            if (cur.usesTargeting()) return true;
            cur = cur.getSubAbility();
        }
        return false;
    }

    @Override
    public boolean playSaFromPlayEffect(SpellAbility tgtSA) {
        return delegated("playSaFromPlayEffect", () -> super.playSaFromPlayEffect(tgtSA));
    }

    @Override
    public List<PaperCard> sideboard(Deck deck, GameType gameType, String message) {
        return delegated("sideboard", () -> super.sideboard(deck, gameType, message));
    }

    @Override
    public List<PaperCard> chooseCardsYouWonToAddToDeck(List<PaperCard> losses) {
        return delegated("chooseCardsYouWonToAddToDeck", () -> super.chooseCardsYouWonToAddToDeck(losses));
    }

    @Override
    public Map<Card, Integer> assignCombatDamage(Card attacker, CardCollectionView blockers, CardCollectionView remaining, int damageDealt, GameEntity defender, boolean overrideOrder) {
        return delegated("assignCombatDamage", () -> super.assignCombatDamage(attacker, blockers, remaining, damageDealt, defender, overrideOrder));
    }

    @Override
    public Map<GameEntity, Integer> divideShield(Card effectSource, Map<GameEntity, Integer> affected, int shieldAmount) {
        return delegated("divideShield", () -> super.divideShield(effectSource, affected, shieldAmount));
    }

    @Override
    public CardCollectionView choosePermanentsToSacrifice(SpellAbility sa, int min, int max, CardCollectionView validTargets, String message) {
        return delegated("choosePermanentsToSacrifice", () -> super.choosePermanentsToSacrifice(sa, min, max, validTargets, message));
    }

    @Override
    public CardCollectionView choosePermanentsToDestroy(SpellAbility sa, int min, int max, CardCollectionView validTargets, String message) {
        return delegated("choosePermanentsToDestroy", () -> super.choosePermanentsToDestroy(sa, min, max, validTargets, message));
    }

    @Override
    public Integer announceRequirements(SpellAbility ability, int min, int max, String announce) {
        return delegated("announceRequirements", () -> super.announceRequirements(ability, min, max, announce));
    }

    @Override
    public TargetChoices chooseNewTargetsFor(SpellAbility ability, Predicate<GameObject> filter, boolean optional) {
        return delegated("chooseNewTargetsFor", () -> super.chooseNewTargetsFor(ability, filter, optional));
    }

    @Override
    public Pair<SpellAbilityStackInstance, GameObject> chooseTarget(SpellAbility sa, List<Pair<SpellAbilityStackInstance, GameObject>> allTargets) {
        return delegated("chooseTarget", () -> super.chooseTarget(sa, allTargets));
    }

    @Override
    public CardCollectionView chooseCardsForEffect(CardCollectionView sourceList, SpellAbility sa, String title, int min, int max, boolean isOptional, Map<String, Object> params) {
        return delegated("chooseCardsForEffect", () -> super.chooseCardsForEffect(sourceList, sa, title, min, max, isOptional, params));
    }

    @Override
    public CardCollection chooseCardsForEffectMultiple(Map<String, CardCollection> validMap, SpellAbility sa, String title, boolean isOptional) {
        return delegated("chooseCardsForEffectMultiple", () -> super.chooseCardsForEffectMultiple(validMap, sa, title, isOptional));
    }

    @Override
    public <T extends GameEntity> T chooseSingleEntityForEffect(FCollectionView<T> optionList, DelayedReveal delayedReveal, SpellAbility sa, String title, boolean isOptional, Player relatedPlayer, Map<String, Object> params) {
        return delegated("chooseSingleEntityForEffect", () -> super.chooseSingleEntityForEffect(optionList, delayedReveal, sa, title, isOptional, relatedPlayer, params));
    }

    @Override
    public <T extends GameEntity> List<T> chooseEntitiesForEffect(FCollectionView<T> optionList, int min, int max, DelayedReveal delayedReveal, SpellAbility sa, String title, Player relatedPlayer, Map<String, Object> params) {
        return delegated("chooseEntitiesForEffect", () -> super.chooseEntitiesForEffect(optionList, min, max, delayedReveal, sa, title, relatedPlayer, params));
    }

    @Override
    public List<SpellAbility> chooseSpellAbilitiesForEffect(List<SpellAbility> spells, SpellAbility sa, String title, int num, Map<String, Object> params) {
        return delegated("chooseSpellAbilitiesForEffect", () -> super.chooseSpellAbilitiesForEffect(spells, sa, title, num, params));
    }

    @Override
    public SpellAbility chooseSingleSpellForEffect(List<SpellAbility> spells, SpellAbility sa, String title, Map<String, Object> params) {
        return delegated("chooseSingleSpellForEffect", () -> super.chooseSingleSpellForEffect(spells, sa, title, params));
    }

    @Override
    public boolean confirmAction(SpellAbility sa, PlayerActionConfirmMode mode, String message, List<String> options, Card cardToShow, Map<String, Object> params) {
        return delegated("confirmAction", () -> super.confirmAction(sa, mode, message, options, cardToShow, params));
    }

    @Override
    public boolean confirmBidAction(SpellAbility sa, PlayerActionConfirmMode bidlife, String string, int bid, Player winner) {
        return delegated("confirmBidAction", () -> super.confirmBidAction(sa, bidlife, string, bid, winner));
    }

    @Override
    public boolean confirmReplacementEffect(ReplacementEffect replacementEffect, SpellAbility effectSA, GameEntity affected, String question) {
        return delegated("confirmReplacementEffect", () -> super.confirmReplacementEffect(replacementEffect, effectSA, affected, question));
    }

    @Override
    public boolean confirmStaticApplication(Card hostCard, PlayerActionConfirmMode mode, String message, String logic) {
        return delegated("confirmStaticApplication", () -> super.confirmStaticApplication(hostCard, mode, message, logic));
    }

    @Override
    public boolean confirmTrigger(WrappedAbility sa) {
        if (host.discarded()) return false;
        try {
            if (sa.isMandatory()) return true;
            return preparePolicyTrigger(sa, true);
        } catch (RuntimeException ex) {
            host.noteBridgeError("play_trigger", ex, epoch);
            return false;
        }
    }

    @Override
    public List<Card> exertAttackers(List<Card> attackers) {
        return delegated("exertAttackers", () -> super.exertAttackers(attackers));
    }

    @Override
    public List<Card> enlistAttackers(List<Card> attackers) {
        return delegated("enlistAttackers", () -> super.enlistAttackers(attackers));
    }

    @Override
    public CardCollection orderBlockers(Card attacker, CardCollection blockers) {
        return delegated("orderBlockers", () -> super.orderBlockers(attacker, blockers));
    }

    @Override
    public CardCollection orderBlocker(Card attacker, Card blocker, CardCollection oldBlockers) {
        return delegated("orderBlocker", () -> super.orderBlocker(attacker, blocker, oldBlockers));
    }

    @Override
    public CardCollection orderAttackers(Card blocker, CardCollection attackers) {
        return delegated("orderAttackers", () -> super.orderAttackers(blocker, attackers));
    }

    @Override
    public ImmutablePair<CardCollection, CardCollection> arrangeForScry(CardCollection topN) {
        return delegated("arrangeForScry", () -> super.arrangeForScry(topN));
    }

    @Override
    public ImmutablePair<CardCollection, CardCollection> arrangeForSurveil(CardCollection topN) {
        return delegated("arrangeForSurveil", () -> super.arrangeForSurveil(topN));
    }

    @Override
    public boolean willPutCardOnTop(Card c) {
        return delegated("willPutCardOnTop", () -> super.willPutCardOnTop(c));
    }

    @Override
    public CardCollectionView orderMoveToZoneList(CardCollectionView cards, ZoneType destinationZone, SpellAbility source) {
        return delegated("orderMoveToZoneList", () -> super.orderMoveToZoneList(cards, destinationZone, source));
    }

    @Override
    public CardCollection chooseCardsToDiscardFrom(Player playerDiscard, SpellAbility sa, CardCollection validCards, int min, int max) {
        return delegated("chooseCardsToDiscardFrom", () -> super.chooseCardsToDiscardFrom(playerDiscard, sa, validCards, min, max));
    }

    @Override
    public CardCollectionView chooseCardsToDiscardUnlessType(int min, CardCollectionView hand, String[] unlessTypes, SpellAbility sa) {
        return delegated("chooseCardsToDiscardUnlessType", () -> super.chooseCardsToDiscardUnlessType(min, hand, unlessTypes, sa));
    }

    @Override
    public CardCollectionView chooseCardsToDelve(int genericAmount, CardCollection grave) {
        return delegated("chooseCardsToDelve", () -> super.chooseCardsToDelve(genericAmount, grave));
    }

    @Override
    public List<Card> chooseCardsForSplice(SpellAbility sa, List<Card> cards) {
        return delegated("chooseCardsForSplice", () -> super.chooseCardsForSplice(sa, cards));
    }

    @Override
    public CardCollectionView chooseCardsToRevealFromHand(int min, int max, CardCollectionView valid) {
        return delegated("chooseCardsToRevealFromHand", () -> super.chooseCardsToRevealFromHand(min, max, valid));
    }

    @Override
    public List<SpellAbility> chooseSaToActivateFromOpeningHand(List<SpellAbility> usableFromOpeningHand) {
        return delegated("chooseSaToActivateFromOpeningHand", () -> super.chooseSaToActivateFromOpeningHand(usableFromOpeningHand));
    }

    @Override
    public PlayerZone chooseStartingHand(List<PlayerZone> zones) {
        return delegated("chooseStartingHand", () -> super.chooseStartingHand(zones));
    }

    @Override
    public String chooseSomeType(String kindOfType, SpellAbility sa, Collection<String> validTypes, boolean isOptional) {
        return delegated("chooseSomeType", () -> super.chooseSomeType(kindOfType, sa, validTypes, isOptional));
    }

    @Override
    public String chooseSector(Card assignee, String ai, List<String> sectors) {
        return delegated("chooseSector", () -> super.chooseSector(assignee, ai, sectors));
    }

    @Override
    public List<Card> chooseContraptionsToCrank(List<Card> contraptions) {
        return delegated("chooseContraptionsToCrank", () -> super.chooseContraptionsToCrank(contraptions));
    }

    @Override
    public int chooseSprocket(Card assignee, List<Integer> sprockets) {
        return delegated("chooseSprocket", () -> super.chooseSprocket(assignee, sprockets));
    }

    @Override
    public PlanarDice choosePDRollToIgnore(List<PlanarDice> rolls) {
        return delegated("choosePDRollToIgnore", () -> super.choosePDRollToIgnore(rolls));
    }

    @Override
    public Integer chooseRollToIgnore(List<Integer> rolls) {
        return delegated("chooseRollToIgnore", () -> super.chooseRollToIgnore(rolls));
    }

    @Override
    public List<Integer> chooseDiceToReroll(List<Integer> rolls) {
        return delegated("chooseDiceToReroll", () -> super.chooseDiceToReroll(rolls));
    }

    @Override
    public Integer chooseRollToModify(List<Integer> rolls) {
        return delegated("chooseRollToModify", () -> super.chooseRollToModify(rolls));
    }

    @Override
    public RollDiceEffect.DieRollResult chooseRollToSwap(List<RollDiceEffect.DieRollResult> rolls) {
        return delegated("chooseRollToSwap", () -> super.chooseRollToSwap(rolls));
    }

    @Override
    public String chooseRollSwapValue(List<String> swapChoices, Integer currentResult, int power, int toughness) {
        return delegated("chooseRollSwapValue", () -> super.chooseRollSwapValue(swapChoices, currentResult, power, toughness));
    }

    @Override
    public Object vote(SpellAbility sa, String prompt, List<Object> options, ListMultimap<Object, Player> votes, Player forPlayer, boolean optional) {
        return delegated("vote", () -> super.vote(sa, prompt, options, votes, forPlayer, optional));
    }

    @Override
    public List<AbilitySub> chooseModeForAbility(SpellAbility sa, List<AbilitySub> possible, int min, int num, boolean allowRepeat) {
        if (host.discarded() || possible == null || possible.isEmpty()) {
            return new ArrayList<>();
        }
        try {
            List<AbilitySub> planned = aiModes(sa, possible, min, num, allowRepeat);
            List<AbilitySub> pool = new ArrayList<>(possible);
            List<AbilitySub> chosen = new ArrayList<>();
            int cursor = 0;
            int limit = Math.max(0, num);
            while (chosen.size() < limit && !pool.isEmpty()) {
                List<ProtocolV2.Option> options = new ArrayList<>();
                List<AbilitySub> encoded = new ArrayList<>();
                int source = sa == null ? 0 : host.visibleIndex(sa.getHostCard());
                if (source < 0) source = 0;
                for (AbilitySub mode : pool) {
                    encoded.add(mode);
                    String name = String.valueOf(mode);
                    if (name.length() > 180) name = name.substring(0, 180);
                    options.add(new ProtocolV2.Option(5, source, -1, name));
                }
                boolean canFinish = chosen.size() >= min;
                int hint = -1;
                if (cursor < planned.size()) {
                    int want = pool.indexOf(planned.get(cursor));
                    if (want >= 0) {
                        ProtocolV2.Layout layout = ProtocolV2.layout(options, 0, canFinish);
                        for (int slot = 0; slot < layout.optionIndex.length; slot++) {
                            if (layout.optionIndex[slot] == want) hint = slot;
                        }
                    }
                }
                int slot = ask("choose_mode", options, canFinish, hint);
                cursor++;
                if (slot < 0 || slot == 0 || lastOptionIndex < 0 || lastOptionIndex >= encoded.size()) break;
                AbilitySub picked = encoded.get(lastOptionIndex);
                chosen.add(picked);
                if (!allowRepeat) pool.remove(picked);
            }
            return chosen;
        } catch (RuntimeException ex) {
            host.noteBridgeError("choose_mode", ex, epoch);
            return new ArrayList<>();
        }
    }

    private List<AbilitySub> aiModes(SpellAbility sa, List<AbilitySub> possible, int min, int num, boolean allowRepeat) {
        PlayerController previous = player.getController();
        PlayerControllerAi ai = new PlayerControllerAi(getGame(), player, getLobbyPlayer());
        try {
            player.dangerouslySetController(ai);
            List<AbilitySub> chosen = ai.chooseModeForAbility(sa, possible, min, num, allowRepeat);
            return chosen == null ? new ArrayList<>() : new ArrayList<>(chosen);
        } catch (RuntimeException ex) {
            System.err.println("[forge-rlbridge] ai label choose_mode " + ex);
            return new ArrayList<>();
        } finally {
            player.dangerouslySetController(previous);
        }
    }

    @Override
    public int chooseNumberForCostReduction(SpellAbility sa, int min, int max) {
        return delegated("chooseNumberForCostReduction", () -> super.chooseNumberForCostReduction(sa, min, max));
    }

    @Override
    public int chooseNumberForKeywordCost(SpellAbility sa, Cost cost, KeywordInterface keyword, String prompt, int max) {
        return delegated("chooseNumberForKeywordCost", () -> super.chooseNumberForKeywordCost(sa, cost, keyword, prompt, max));
    }

    @Override
    public int chooseNumber(SpellAbility sa, String title, int min, int max) {
        return delegated("chooseNumber", () -> super.chooseNumber(sa, title, min, max));
    }

    @Override
    public int chooseNumber(SpellAbility sa, String title, List<Integer> values, Player relatedPlayer) {
        return delegated("chooseNumber", () -> super.chooseNumber(sa, title, values, relatedPlayer));
    }

    @Override
    public boolean chooseBinary(SpellAbility sa, String question, BinaryChoiceType kindOfChoice, Boolean defaultChoice) {
        return delegated("chooseBinary", () -> super.chooseBinary(sa, question, kindOfChoice, defaultChoice));
    }

    @Override
    public boolean chooseFlipResult(SpellAbility sa, Player flipper, boolean call) {
        return delegated("chooseFlipResult", () -> super.chooseFlipResult(sa, flipper, call));
    }

    @Override
    public byte chooseColor(String message, SpellAbility sa, ColorSet colors) {
        return delegated("chooseColor", () -> super.chooseColor(message, sa, colors));
    }

    @Override
    public byte chooseColorAllowColorless(String message, Card c, ColorSet colors) {
        return delegated("chooseColorAllowColorless", () -> super.chooseColorAllowColorless(message, c, colors));
    }

    @Override
    public ColorSet chooseColors(String message, SpellAbility sa, int min, int max, ColorSet options) {
        return delegated("chooseColors", () -> super.chooseColors(message, sa, min, max, options));
    }

    @Override
    public ICardFace chooseSingleCardFace(SpellAbility sa, String message, Predicate<ICardFace> cpp, String name) {
        return delegated("chooseSingleCardFace", () -> super.chooseSingleCardFace(sa, message, cpp, name));
    }

    @Override
    public ICardFace chooseSingleCardFace(SpellAbility sa, List<ICardFace> faces, String message) {
        return delegated("chooseSingleCardFace", () -> super.chooseSingleCardFace(sa, faces, message));
    }

    @Override
    public CardState chooseSingleCardState(SpellAbility sa, List<CardState> states, String message, Map<String, Object> params) {
        return delegated("chooseSingleCardState", () -> super.chooseSingleCardState(sa, states, message, params));
    }

    @Override
    public boolean chooseCardsPile(SpellAbility sa, CardCollectionView pile1, CardCollectionView pile2, String faceUp) {
        return delegated("chooseCardsPile", () -> super.chooseCardsPile(sa, pile1, pile2, faceUp));
    }

    @Override
    public CounterType chooseCounterType(List<CounterType> options, SpellAbility sa, String prompt, Map<String, Object> params) {
        return delegated("chooseCounterType", () -> super.chooseCounterType(options, sa, prompt, params));
    }

    @Override
    public String chooseKeywordForPump(List<String> options, SpellAbility sa, String prompt, Card tgtCard) {
        return delegated("chooseKeywordForPump", () -> super.chooseKeywordForPump(options, sa, prompt, tgtCard));
    }

    @Override
    public ReplacementEffect chooseSingleReplacementEffect(List<ReplacementEffect> possibleReplacers) {
        return delegated("chooseSingleReplacementEffect", () -> super.chooseSingleReplacementEffect(possibleReplacers));
    }

    @Override
    public StaticAbility chooseSingleStaticAbility(List<StaticAbility> possibleReplacers) {
        return delegated("chooseSingleStaticAbility", () -> super.chooseSingleStaticAbility(possibleReplacers));
    }

    @Override
    public String chooseProtectionType(SpellAbility sa, List<String> choices) {
        return delegated("chooseProtectionType", () -> super.chooseProtectionType(sa, choices));
    }

    @Override
    public List<OptionalCostValue> chooseOptionalCosts(SpellAbility choosen, List<OptionalCostValue> optionalCostValues) {
        return delegated("chooseOptionalCosts", () -> super.chooseOptionalCosts(choosen, optionalCostValues));
    }

    @Override
    public List<CostPart> orderCosts(List<CostPart> costs) {
        return delegated("orderCosts", () -> super.orderCosts(costs));
    }

    @Override
    public String chooseCardName(SpellAbility sa, Predicate<ICardFace> cpp, String valid, String message) {
        return delegated("chooseCardName", () -> super.chooseCardName(sa, cpp, valid, message));
    }

    @Override
    public String chooseCardName(SpellAbility sa, List<ICardFace> faces, String message) {
        return delegated("chooseCardName", () -> super.chooseCardName(sa, faces, message));
    }

    @Override
    public Card chooseSingleCardForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility sa, CardCollection fetchList, DelayedReveal delayedReveal, String selectPrompt, boolean isOptional, Player decider) {
        return delegated("chooseSingleCardForZoneChange", () -> super.chooseSingleCardForZoneChange(destination, origin, sa, fetchList, delayedReveal, selectPrompt, isOptional, decider));
    }

    @Override
    public List<Card> chooseCardsForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility sa, CardCollection fetchList, int min, int max, DelayedReveal delayedReveal, String selectPrompt, Player decider) {
        return delegated("chooseCardsForZoneChange", () -> super.chooseCardsForZoneChange(destination, origin, sa, fetchList, min, max, delayedReveal, selectPrompt, decider));
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

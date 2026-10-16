"""Deterministic, card-data-backed quality checks for 60-card MTG decks.

This is deliberately separate from gameplay reward and embedding similarity.
It detects impossible mana bases, pathological curves and a small set of
well-established self-hosing interactions. It is a conservative guardrail,
not an oracle for deck strength or format legality.
"""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Mapping, Sequence


COLORS = "WUBRG"
BASIC_LAND_COLORS = {
    "Plains": "W",
    "Island": "U",
    "Swamp": "B",
    "Mountain": "R",
    "Forest": "G",
}
DEFAULT_CARD_DATABASE = (
    Path(__file__).resolve().parents[2]
    / "forge"
    / "forge-gui"
    / "res"
    / "cardsfolder"
)
# Name, mana cost, types, and land production for the training pool. Used when
# the Forge cardsfolder is not on disk. Oracle prose is not stored.
BUNDLED_CARD_INDEX = (
    Path(__file__).resolve().parent / "data" / "deck_pool" / "v1" / "forge_cards.json"
)
BASIC_LAND_NAMES = frozenset(
    {
        name.casefold()
        for name in (*BASIC_LAND_COLORS, "Wastes")
    }
    | {
        f"snow-covered {name}".casefold()
        for name in (*BASIC_LAND_COLORS, "Wastes")
    }
)
DECK_LINE = re.compile(r"^\s*(\d{1,3})\s*x?\s+(.+?)\s*$", re.IGNORECASE)
MANA_SYMBOL = re.compile(r"\{([WUBRG])\}")
GENERIC_MANA = re.compile(r"^\d+$")
PIP = re.compile(r"(?:^|/)([WUBRG])(?:$|/)")


@dataclass(frozen=True)
class CardData:
    name: str
    mana_cost: str
    types: str
    oracle: str
    path: Path
    # Colors a land face of this card can add. Spell faces do not contribute:
    # their rules text mentions costs that are not mana sources.
    produces: frozenset[str] = frozenset()

    @property
    def is_land(self) -> bool:
        return "Land" in self.types.split()

    @property
    def is_noncreature_spell(self) -> bool:
        return not self.is_land and "Creature" not in self.types.split()


@dataclass(frozen=True)
class DeckGateConfig:
    card_count: int = 60
    min_lands: int = 18
    max_lands: int = 28
    min_early_spells: int = 8
    max_expensive_spells: int = 12
    minimum_color_probability: float = 0.70


def canonical_deck_hash(decklist: str) -> str:
    """Match policy_evaluation._text_sha256's holdout-deck identity."""

    normalized = "\n".join(line.strip() for line in str(decklist).strip().splitlines())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def parse_decklist(decklist: str) -> dict[str, int]:
    """Parse mainboard-only Forge/MTGO lines; reject ambiguous input."""

    cards: dict[str, int] = {}
    for lineno, raw in enumerate(decklist.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = DECK_LINE.fullmatch(line)
        if match is None:
            raise ValueError(f"decklist line {lineno} is not '<count> <name>': {line!r}")
        quantity = int(match.group(1))
        name = match.group(2).strip()
        if quantity <= 0 or not name or "\x00" in name:
            raise ValueError(f"decklist line {lineno} has invalid count or name")
        cards[name] = cards.get(name, 0) + quantity
    if not cards:
        raise ValueError("decklist has no mainboard cards")
    return cards


def _slug(name: str) -> str:
    lowered = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    lowered = lowered.replace("'", "").replace("’", "")
    return re.sub(r"[^a-z0-9]+", "_", lowered).strip("_")


def _split_faces(lines: list[str]) -> list[list[str]]:
    faces: list[list[str]] = []
    current: list[str] = []
    for line in lines:
        if line.startswith("Name:") and current:
            faces.append(current)
            current = [line]
        else:
            current.append(line)
    if current:
        faces.append(current)
    return faces


def _face_field(face: Sequence[str], key: str) -> str:
    prefix = f"{key}:"
    for line in face:
        if line.startswith(prefix):
            return line[len(prefix):].strip()
    return ""


def _face_produces(face: Sequence[str]) -> set[str]:
    """Mana a land face can add. Non-land faces are ignored on purpose."""

    types = _face_field(face, "Types")
    if "Land" not in types.split():
        return set()
    produced = {
        color
        for basic_type, color in BASIC_LAND_COLORS.items()
        if basic_type in types.split()
    }
    body = "\n".join(face)
    if re.search(r"Produced\$\s+Any\b", body) or re.search(
        r"Add (?:three mana|one mana) of any (?:one )?color", body, re.IGNORECASE
    ):
        produced.update(COLORS)
    for match in re.finditer(r"Produced\$\s+([^\n|]+)", body):
        token = match.group(1).strip()
        if token.startswith("Any"):
            produced.update(COLORS)
        else:
            produced.update(part for part in token.split() if part in COLORS)
    produced.update(MANA_SYMBOL.findall(body))
    return produced


def _read_card(path: Path) -> CardData | None:
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except (OSError, UnicodeError):
        return None
    faces = _split_faces(lines)
    if not faces:
        return None
    front = faces[0]
    name = _face_field(front, "Name")
    types = _face_field(front, "Types")
    if not name or not types:
        return None
    produces: set[str] = set()
    for face in faces:
        produces.update(_face_produces(face))
    return CardData(
        name=name,
        mana_cost=_face_field(front, "ManaCost"),
        types=types,
        oracle=_face_field(front, "Oracle").replace("\\n", "\n"),
        path=path,
        produces=frozenset(produces),
    )


def _load_card_file(name: str, card_database: Path) -> CardData | None:
    slug = _slug(name)
    if not slug or not card_database.is_dir():
        return None
    first = slug[0]
    card_dir = card_database / first
    direct = card_dir / f"{slug}.txt"
    candidates = [direct]
    # MDFC / adventure files append the back face: bonecrusher_giant_stomp.txt
    # still has Name:Bonecrusher Giant. Match that name, not a fuzzy title.
    if card_dir.is_dir():
        candidates.extend(sorted(card_dir.glob(f"{slug}_*.txt")))
        if direct not in candidates:
            candidates.extend(sorted(card_dir.glob("*.txt")))
    for path in candidates:
        if not path.is_file():
            continue
        card = _read_card(path)
        if card is not None and card.name.casefold() == name.casefold():
            return card
    return None


@lru_cache(maxsize=1)
def _bundled_card_index() -> dict[str, CardData]:
    """Casefold name -> card. Empty when the index file is absent."""

    path = BUNDLED_CARD_INDEX
    if not path.is_file():
        return {}
    import json

    payload = json.loads(path.read_text(encoding="utf-8"))
    index: dict[str, CardData] = {}
    for entry in payload.get("cards", []):
        card = CardData(
            name=str(entry["name"]),
            mana_cost=str(entry.get("mana_cost", "")),
            types=str(entry.get("types", "")),
            oracle="",
            path=path,
            produces=frozenset(entry.get("produces") or ()),
        )
        keys = [card.name, *list(entry.get("aliases") or ())]
        for key in keys:
            index[str(key).casefold()] = card
    return index


@lru_cache(maxsize=4096)
def load_card(name: str, card_database: Path = DEFAULT_CARD_DATABASE) -> CardData | None:
    """Resolve exact Forge card data; never approximate an unknown card.

    The cardsfolder wins when the file is present. Otherwise the bundled
    index (Name / ManaCost / Types / land production, checked against Forge
    filenames) is used so the gate still runs without a Forge checkout.
    """

    found = _load_card_file(name, Path(card_database))
    if found is not None:
        return found
    return _bundled_card_index().get(name.casefold())


def _cost_tokens(card: CardData) -> list[str]:
    cost = card.mana_cost.strip()
    if not cost or cost.casefold() == "no cost":
        return []
    return cost.replace("{", "").replace("}", "").split()


def _hybrid_colors(token: str) -> list[str]:
    """Colored halves of a hybrid pip. Forge writes {W}{B} hybrid as ``WB``."""

    if token in COLORS:
        return [token]
    if "/" in token:
        return [part for part in token.split("/") if part in COLORS]
    if len(token) == 2 and token[0] in COLORS and token[1] in COLORS:
        return [token[0], token[1]]
    return []


def _mana_value(card: CardData) -> int | None:
    if card.is_land:
        return 0
    tokens = _cost_tokens(card)
    if not tokens:
        # Zero-cost artifacts exist; "no cost" on nonlands means uncastable
        # conventionally and needs specific rules not covered by this gate.
        return None
    value = 0
    for token in tokens:
        if GENERIC_MANA.fullmatch(token):
            value += int(token)
        elif token == "X":
            continue
        elif token in COLORS or re.fullmatch(r"(?:[WUBRG2]/){1,2}[WUBRGP]", token):
            value += 2 if token.startswith("2/") else 1
        elif _hybrid_colors(token):
            value += 1
        else:
            return None
    return value


def _required_colored_pips(card: CardData) -> Counter[str]:
    """Conservatively count printed colored costs (hybrid can use either)."""

    result: Counter[str] = Counter()
    for token in _cost_tokens(card):
        if token in COLORS:
            result[token] += 1
            continue
        alternatives = _hybrid_colors(token)
        if len(alternatives) == 1:
            result[alternatives[0]] += 1
        # Two hybrid colors have no unique color demand; identity is checked
        # separately so a WB pip still requires both colors in the deck.
    return result


def _spell_colors(card: CardData) -> set[str]:
    """Color identity of the mana cost. Hybrid contributes both colors."""

    colors: set[str] = set()
    for token in _cost_tokens(card):
        colors.update(_hybrid_colors(token))
    return colors


def _is_basic_land(name: str, card: CardData | None) -> bool:
    if name.casefold() in BASIC_LAND_NAMES:
        return True
    return card is not None and "Basic" in card.types.split()


def _land_colors(card: CardData) -> set[str]:
    # `produces` covers land backs of modal cards and "any color" lands.
    # Front-face basics and printed {W} symbols still count when a Forge
    # file did not precompute production.
    colors = set(card.produces)
    if not card.is_land:
        return colors
    colors.update(
        color
        for basic_type, color in BASIC_LAND_COLORS.items()
        if basic_type in card.types.split()
    )
    colors.update(MANA_SYMBOL.findall(card.oracle))
    return colors


def _hypergeom_at_least(population: int, successes: int, draws: int, needed: int) -> float:
    """Exact chance to see >=needed color sources by the relevant turn."""

    if needed <= 0:
        return 1.0
    if successes < needed:
        return 0.0
    denominator = math.comb(population, draws)
    probability = 0.0
    for found in range(needed, min(successes, draws) + 1):
        misses = draws - found
        if misses > population - successes:
            continue
        probability += math.comb(successes, found) * math.comb(population - successes, misses) / denominator
    return min(1.0, probability)


def _finding(code: str, severity: str, detail: str) -> dict[str, str]:
    return {"code": code, "severity": severity, "detail": detail}


def _known_interactions(cards: Mapping[str, int], metadata: Mapping[str, CardData]) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """A tiny, auditable interaction registry; unknown pairs are not inferred."""

    names = {name.casefold(): name for name in cards}
    synergies: list[dict[str, str]] = []
    incompatibilities: list[dict[str, str]] = []
    noncreature_spell_count = sum(
        cards[name] for name, card in metadata.items() if card.is_noncreature_spell
    )
    instant_sorcery_count = sum(
        cards[name]
        for name, card in metadata.items()
        if "Instant" in card.types.split() or "Sorcery" in card.types.split()
    )
    if "monastery swiftspear" in names and noncreature_spell_count >= 8:
        synergies.append({
            "card": names["monastery swiftspear"],
            "support": "noncreature_spells",
            "evidence": f"Prowess with {noncreature_spell_count} noncreature spells",
        })
    if "young pyromancer" in names and instant_sorcery_count >= 8:
        synergies.append({
            "card": names["young pyromancer"],
            "support": "instant_or_sorcery_spells",
            "evidence": f"Token trigger with {instant_sorcery_count} instants/sorceries",
        })
    if "ajani's pridemate" in names and "soul warden" in names:
        synergies.append({
            "card": names["ajani's pridemate"],
            "support": names["soul warden"],
            "evidence": "Life-gain trigger grows Ajani's Pridemate",
        })
    for hate_card, conflicts, evidence in (
        (
            "rest in peace",
            ("reanimate", "animate dead", "unearth"),
            "Rest in Peace exiles graveyards needed by the reanimation spell",
        ),
        (
            "grafdigger's cage",
            ("collected company", "chord of calling", "green sun's zenith"),
            "Grafdigger's Cage stops creatures entering from your library",
        ),
        (
            "stony silence",
            ("sol ring", "mox opal", "arcane signet", "mind stone"),
            "Stony Silence stops your artifact's activated mana ability",
        ),
    ):
        if hate_card not in names:
            continue
        for conflict in conflicts:
            if conflict in names:
                incompatibilities.append({
                    "card": names[hate_card],
                    "conflict": names[conflict],
                    "evidence": evidence,
                })
    return synergies, incompatibilities


def evaluate_deck(
    deck_id: str,
    decklist: str,
    *,
    card_database: Path = DEFAULT_CARD_DATABASE,
    config: DeckGateConfig = DeckGateConfig(),
) -> dict[str, object]:
    """Return a deterministic result with actionable error/warning findings."""

    digest = canonical_deck_hash(decklist)
    findings: list[dict[str, str]] = []
    metrics: dict[str, object] = {
        "card_count": 0,
        "land_count": 0,
        "land_ratio": 0.0,
        "mana_curve": {str(key): 0 for key in range(6)} | {"6+": 0},
        "source_counts": {color: 0 for color in COLORS},
        "spell_color_checks": [],
        "synergy_pairs": [],
        "incompatibility_pairs": [],
    }
    try:
        quantities = parse_decklist(decklist)
    except ValueError as exc:
        findings.append(_finding("malformed_decklist", "error", str(exc)))
        return {
            "deck_id": deck_id,
            "decklist_sha256": digest,
            "pass": False,
            "metrics": metrics,
            "findings": findings,
        }
    total = sum(quantities.values())
    metrics["card_count"] = total
    if total < config.card_count:
        findings.append(_finding(
            "card_count", "error",
            f"Expected at least {config.card_count} mainboard cards, found {total}",
        ))
    if not Path(card_database).is_dir() and not _bundled_card_index():
        findings.append(_finding("card_database_missing", "error", f"Forge card database missing: {card_database}"))
    metadata: dict[str, CardData] = {}
    for name in quantities:
        card = load_card(name, Path(card_database))
        if card is None:
            findings.append(_finding("unknown_card", "error", f"Card not found in Forge data: {name}"))
        else:
            metadata[name] = card

    for name, quantity in quantities.items():
        card = metadata.get(name)
        if quantity > 4 and not _is_basic_land(name, card):
            findings.append(_finding(
                "copy_limit", "error",
                f"{name} has {quantity} copies; maximum is 4 except for basic lands",
            ))

    lands = sum(quantities[name] for name, card in metadata.items() if card.is_land)
    metrics["land_count"] = lands
    metrics["land_ratio"] = round(lands / total, 4) if total else 0.0
    if lands < config.min_lands or lands > config.max_lands:
        findings.append(_finding(
            "land_ratio", "error",
            f"Expected {config.min_lands}-{config.max_lands} lands in a 60-card deck; found {lands}",
        ))

    source_counts: Counter[str] = Counter()
    for name, card in metadata.items():
        for color in _land_colors(card):
            source_counts[color] += quantities[name]
    metrics["source_counts"] = {color: source_counts[color] for color in COLORS}
    produced = set(source_counts)

    curve: Counter[str] = Counter()
    spell_color_checks: list[dict[str, object]] = []
    early_spells = 0
    expensive_spells = 0
    for name, card in metadata.items():
        if card.is_land:
            continue
        quantity = quantities[name]
        mana_value = _mana_value(card)
        if mana_value is None:
            findings.append(_finding(
                "unparsed_mana_cost", "error", f"Cannot safely parse mana cost of {name}: {card.mana_cost!r}"
            ))
            continue
        curve[str(mana_value) if mana_value < 6 else "6+"] += quantity
        if mana_value <= 2:
            early_spells += quantity
        if mana_value >= 6:
            expensive_spells += quantity
        spell_colors = _spell_colors(card)
        if not spell_colors <= produced:
            missing = "".join(color for color in COLORS if color in spell_colors - produced) or "?"
            findings.append(_finding(
                "color_identity", "error",
                f"{name} is {''.join(color for color in COLORS if color in spell_colors)} "
                f"but the mana base produces {''.join(color for color in COLORS if color in produced) or 'nothing'}; "
                f"off-color {missing}",
            ))
        for color, pip_count in _required_colored_pips(card).items():
            # Seven opening cards plus one draw for each turn after turn 1.
            # This ignores mulligans and is an *availability* bound, not
            # castability with all generic/other colored requirements.
            draws = min(total, 7 + max(1, mana_value) - 1)
            probability = _hypergeom_at_least(
                total, source_counts[color], draws, pip_count
            ) if total else 0.0
            passed = probability >= config.minimum_color_probability
            spell_color_checks.append({
                "card": name,
                "color": color,
                "required_pips": pip_count,
                "sources": source_counts[color],
                "turn": max(1, mana_value),
                "probability": round(probability, 4),
                "pass": passed,
            })
            if not passed:
                findings.append(_finding(
                    "colored_source_shortage", "error",
                    f"{name} needs {pip_count} {color} pip(s): "
                    f"{source_counts[color]} sources give {probability:.1%} by turn {max(1, mana_value)} "
                    f"(minimum {config.minimum_color_probability:.0%})",
                ))
    metrics["mana_curve"] = {str(key): curve[str(key)] for key in range(6)} | {"6+": curve["6+"]}
    metrics["spell_color_checks"] = spell_color_checks
    if early_spells < config.min_early_spells:
        findings.append(_finding(
            "early_curve", "error", f"Only {early_spells} spells cost 0-2 mana; minimum {config.min_early_spells}"
        ))
    if expensive_spells > config.max_expensive_spells:
        findings.append(_finding(
            "top_heavy_curve", "error", f"{expensive_spells} spells cost 6+ mana; maximum {config.max_expensive_spells}"
        ))
    synergies, incompatibilities = _known_interactions(quantities, metadata)
    metrics["synergy_pairs"] = synergies
    metrics["incompatibility_pairs"] = incompatibilities
    if not synergies:
        findings.append(_finding(
            "no_verified_synergy", "warning",
            "No interaction from the small verified registry was detected; this is not proof of no synergy",
        ))
    for pair in incompatibilities:
        findings.append(_finding(
            "known_incompatibility", "error",
            f"{pair['card']} conflicts with {pair['conflict']}: {pair['evidence']}",
        ))
    return {
        "deck_id": deck_id,
        "decklist_sha256": digest,
        "pass": not any(finding["severity"] == "error" for finding in findings),
        "metrics": metrics,
        "findings": findings,
    }


def deck_rejection_reason(
    deck_id: str,
    decklist: str,
    *,
    card_database: Path = DEFAULT_CARD_DATABASE,
    config: DeckGateConfig = DeckGateConfig(),
) -> str | None:
    """None when the deck passes. Otherwise one line naming every error."""

    result = evaluate_deck(deck_id, decklist, card_database=card_database, config=config)
    if result["pass"]:
        return None
    details = [
        f"{finding['code']}: {finding['detail']}"
        for finding in result["findings"]
        if finding["severity"] == "error"
    ]
    return "; ".join(details) or "deck failed quality gate"


def build_deck_quality_report(
    decklists: Iterable[tuple[str, str]],
    *,
    card_database: Path = DEFAULT_CARD_DATABASE,
    config: DeckGateConfig = DeckGateConfig(),
) -> dict[str, object]:
    """Aggregate a cohort; all distinct deck hashes must pass."""

    results: list[dict[str, object]] = []
    seen_hashes: set[str] = set()
    for deck_id, decklist in decklists:
        if not isinstance(deck_id, str) or not deck_id.strip() or not isinstance(decklist, str):
            raise ValueError("every deck needs a non-empty id and text")
        digest = canonical_deck_hash(decklist)
        if digest in seen_hashes:
            continue
        seen_hashes.add(digest)
        results.append(evaluate_deck(deck_id, decklist, card_database=card_database, config=config))
    passed = sum(bool(result["pass"]) for result in results)
    return {
        "schema_version": "1.0",
        "gate": "deck_quality",
        "pass": bool(results) and passed == len(results),
        "source": {"card_database": "forge_cardsfolder"},
        "summary": {"deck_count": len(results), "passed_decks": passed},
        "decks": results,
    }

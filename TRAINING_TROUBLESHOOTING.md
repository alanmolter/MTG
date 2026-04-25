# TRAINING_TROUBLESHOOTING.md

Operational runbook for the Ray RLlib + IMPALA + PBT training pipeline
(`.\train.ps1`). Every failure mode we've hit in production is documented
here, with the **root cause**, the **guard in code that now prevents it**,
and the **diagnostic command** to verify the guard still works.

If you hit a new failure that isn't listed, add it here before closing the
issue. This file is the contract — the guards in code only exist *because*
this file exists.

---

## Quick map: symptom → section

| Symptom                                                                                           | Section |
|---------------------------------------------------------------------------------------------------|:-------:|
| `ValueError: shape '[5, 50]' is invalid for input of size 256`                                    | [§1](#1-shape-bt-invalid-for-input-of-size-n) |
| `RuntimeError: The learner thread died while training!`                                           | [§1](#1-shape-bt-invalid-for-input-of-size-n) (usually) |
| `numpy._core._exceptions._ArrayMemoryError: Unable to allocate 40 MiB ... (200, 53406)`           | [§2](#2-unable-to-allocate-mib-for-array-with-shape-b-obs_dim) |
| `RuntimeError: CUDA error: CUBLAS_STATUS_EXECUTION_FAILED when calling cublasSgemm`               | [§3](#3-cublas_status_execution_failed) |
| `No module named ml_engine.scripts.check_learning_progress`                                       | [§4](#4-no-module-named-ml_enginescriptscheck_learning_progress) |
| All 4 trials die with `max_failures` reached, `.\train.ps1` exits with code ≠0                    | [§5](#5-every-trial-dies-immediately) |
| Crash after 1–3 hours around iter 100+, allocation fails for a *tiny* (5 MiB) shape               | [§10](#10--late-stage-oom-during-long-pbt-runs-anomaly-4) |

---

## 1. `shape '[B,T]' is invalid for input of size N`

### Symptom

```
ValueError: shape '[5, 50]' is invalid for input of size 256
  at ray/rllib/algorithms/impala/impala_torch_policy.py:161 in _make_time_major
  → (wrapped as) RuntimeError: The learner thread died while training!
```

Every trial dies on its first training iteration. `error.txt` under
`ray_results/pbt_mtg_*/IMPALA_*/` shows the stack above.

### Root cause

IMPALA's V-trace learner reshapes `[train_batch_size, ...]` tensors into
`[B, T, ...]` where:

```python
T = policy.config["rollout_fragment_length"]
B = tensor.shape[0] // T
```

`torch.reshape` then asserts `B * T == tensor.shape[0]`. If
`train_batch_size % rollout_fragment_length != 0`, integer division drops
the fraction and `B * T < tensor.shape[0]`, so reshape fails.

The original defaults were `train_batch_size=256`, `rollout_fragment_length=50`
→ `B = 256 // 50 = 5`, `5 * 50 = 250 ≠ 256`. Boom.

### Guards now in code

1. **`ml_engine/ray_cluster/orchestrator.py::_validate_batch_alignment`**
   raises `ValueError` *before* Ray sees the config. The message suggests
   the next safe multiple.

2. **`ml_engine/ray_cluster/orchestrator.py::_align_batch_size`** auto-bumps
   a misaligned CLI value up to the next multiple and warns on stderr.

3. **`train.ps1`** has a preflight check: misaligned `-BatchSize` is rounded
   up before the argv is even built, with a yellow warning.

4. **`test_orchestrator_config.py`** has the regression test
   `test_validate_batch_alignment_rejects_nondivisible_256_50` locking the
   exact production case.

### Verify the guard

```powershell
# Must raise, NOT silently proceed:
.venv\Scripts\python -c "from ml_engine.ray_cluster.orchestrator import build_impala_config; build_impala_config(num_workers=1, train_batch_size=256, opponent_pool_path='x', rollout_fragment_length=50)"
# → ValueError: IMPALA misconfig: train_batch_size (256) must be an integer multiple of rollout_fragment_length (50)...
```

```powershell
# Full test:
.venv\Scripts\python -m pytest ml_engine/ray_cluster/tests/test_orchestrator_config.py -v
```

### Fix if you hit it again

Either:
- Set `train_batch_size` to a multiple of `rollout_fragment_length`
  (e.g. `500 = 10*50`), or
- Change `rollout_fragment_length` to a divisor of your batch size
  (e.g. `rollout_fragment_length = 64` for `train_batch_size = 256`).

---

## 2. `Unable to allocate M MiB for array with shape (B, obs_dim)`

### Symptom

```
numpy._core._exceptions._ArrayMemoryError:
  Unable to allocate 40.7 MiB for an array with shape (200, 53406) and data type float32
  at ray/rllib/policy/policy.py:1349 in _initialize_loss_from_dummy_batch
```

The number `53406` is the flattened `observation_space` dim. The `200` is
`min(max(rollout_fragment_length * 4, 32), train_batch_size)` — the dummy
batch size that Ray uses to warm up the view requirements.

### Root cause

`MtgForgeEnv` defaults `max_cards = 128`. The flat obs dim is then:

```
128 * 395     # card_feats
 + 2 * 15      # player_feats
 + 2 * 256     # controlled_by_edges
 + 2 * 256     # in_zone_edges
 + 2 * 512     # synergy_edges
 + 2 * 128     # attacks_edges
 +     512     # action_mask
 ─────────
 = 53,406 floats  →  40 MiB per (200-row) dummy batch
```

With 4 trials × 4 env runners, peak concurrent allocation is ~650 MiB —
enough to hit Windows' heap fragmentation limit on 16 GB systems.

### Guards now in code

1. **`build_impala_config(max_cards=...)`** defaults to **64** (was 128).
   Halves the obs dim → ~20 MiB per dummy batch → ~320 MiB peak.

2. **`env_config["max_cards"]`** is plumbed through so the env uses the
   same cap as the model expects. See `test_build_config_plumbs_max_cards_into_env_config`.

3. **`train.ps1 -MaxCards <N>`** CLI flag for power users who want to tune.

### Verify the guard

```powershell
.venv\Scripts\python -m pytest ml_engine/ray_cluster/tests/test_orchestrator_config.py::test_build_config_default_max_cards_is_memory_safe -v
```

### Fix if you hit it again

- Lower `-MaxCards` further (32 is still useful for dev):
  ```powershell
  .\train.ps1 -MaxCards 32
  ```
- Reduce `-NumWorkers` and/or `-NumTrials` to cut concurrent allocations.
- Close Chrome / IDEs before starting a 4×4 PBT run.

---

## 3. `CUBLAS_STATUS_EXECUTION_FAILED`

### Symptom

```
RuntimeError: CUDA error: CUBLAS_STATUS_EXECUTION_FAILED when calling cublasSgemm
  at ml_engine/models/game_state_gnn.py:144 in forward
  → self.player_proj(data["player"].x)
```

### Root cause

Almost always a **cascade** from an earlier failure (§1 or §2) that
corrupted the CUDA context in the daemon learner thread. The real error
is in the **first** `Failure #1` block of `error.txt`, not this one.

### Guards now in code

The GNN wrapper now intercepts the CUBLAS error and re-raises it with an
explicit pointer to this runbook, so future readers don't chase the ghost:

```
GNN forward hit a CUDA/CUBLAS failure. This is almost always a cascade from
an earlier error (OOM, tensor-shape mismatch in IMPALA's _make_time_major,
or another trial killing the learner). Check the FIRST failure in the trial
log, not this one. See TRAINING_TROUBLESHOOTING.md.
```

### Verify the guard

Grep-level check that the message is still in place:

```powershell
Select-String -Path ml_engine\models\game_state_gnn.py -Pattern "TRAINING_TROUBLESHOOTING"
```

### Fix if you hit it again

1. Open `ray_results/pbt_mtg_*/IMPALA_*/error.txt`.
2. Scroll to the *first* `Failure #1` block.
3. Route the *underlying* cause via §1/§2 of this doc.
4. A literal CUDA execution failure (GPU dying, thermal, driver crash) is
   rare — if you've ruled out §1 and §2, run `nvidia-smi dmon -s ut` in a
   second shell and look for throttling / ECC errors.

---

## 4. `No module named ml_engine.scripts.check_learning_progress`

### Symptom

```
.venv\Scripts\python -m ml_engine.scripts.check_learning_progress
→ ModuleNotFoundError: No module named 'ml_engine.scripts.check_learning_progress'
```

### Root cause

An earlier weekly runbook referenced the module before it was implemented.

### Guard now in code

The module exists at `ml_engine/scripts/check_learning_progress.py` and is
tested by `ml_engine/scripts/tests/test_check_learning_progress.py`. It is
importable via `python -m`.

### Verify the guard

```powershell
.venv\Scripts\python -m pytest ml_engine/scripts/tests/test_check_learning_progress.py -v
.venv\Scripts\python -m ml_engine.scripts.check_learning_progress --tail 1
```

### Usage

```powershell
# Quick status of the 3 newest PBT runs:
.venv\Scripts\python -m ml_engine.scripts.check_learning_progress

# One specific run:
.venv\Scripts\python -m ml_engine.scripts.check_learning_progress --experiment pbt_mtg_1776822742

# Machine-readable:
.venv\Scripts\python -m ml_engine.scripts.check_learning_progress --json | ConvertFrom-Json
```

The report flags misaligned configs as `MISALIGNED` so you can correlate a
dead trial directly to §1 at a glance.

---

## 5. Every trial dies immediately

### Symptom

```
.\train.ps1 -NumWorkers 4 -NumTrials 4 -BudgetHours 24
...
2026-04-21 22:54:51  trial IMPALA_mtg_forge_env_e7605_00003 reached max_failures
  training exited with code 1
```

### Root cause

Usually §1 (misalignment) + §2 (memory) compounding. All 4 trials hit the
same root cause because PBT's 4 trials share `config = build_impala_config(...)`
— one misconfig kills them all.

### Guards now in code

- §1 guard throws BEFORE tune.run → zero trials start.
- §2 guard defaults to `max_cards=64` → peak memory ~320 MiB.
- `train.ps1` prints the aligned values in its startup banner so you see
  the final config before Ray spins up.

### Diagnostic quick path

```powershell
# 1) Is a trial making progress?
.venv\Scripts\python -m ml_engine.scripts.check_learning_progress --tail 1

# 2) If DEAD, what was the first failure?
Get-Content ray_results\pbt_mtg_*\IMPALA_*\error.txt | Select-Object -First 40

# 3) Re-run with conservative knobs:
.\train.ps1 -NumWorkers 2 -NumTrials 2 -BatchSize 500 -MaxCards 32
```

---

## §6 — Reward shaper: losing agent netting positive return (Anomaly-1A)

**Symptom (from `npm run check:learn`):**

```
 1. Aatchik, Dire Fabricator                | B     | Peso: 45.00 | 1% wr
 2. Aang, Avatar of Last Airbender           | U     | Peso: 42.29 | 3% wr
```

Cards with 1–3% winrate pinned to weight 42–45 (near the 50.0 cap).
Those commanders were *losing almost every match*, yet the learning system
kept ranking them at the top.

**Root cause:** before 2026-04-23, `ShapingConfig.step_cap = 0.1` was the
only brake on dense reward. A 30-turn game with good mana efficiency could
accumulate up to +3.0 shaped reward, completely drowning out the ±1.0
terminal. The losing agent was rewarded for *playing efficiently while
losing*.

**Fix in `ml_engine/forge_worker/reward_shaper.py`:**

- `step_cap` lowered from 0.1 → **0.04**
- New `episode_shape_cap = 0.5` — cumulative per-episode bound
- `RewardShaper._episode_shape_total` tracks running sum; clips additions
  that would push past the cap; auto-resets on terminal transitions
- Public `reset_episode()` method for env.reset() hook

**Invariant enforced:**  Σ r_shape ∈ [−0.5, +0.5] over any episode,
so `outcome_weight = ±1.0` is always the decisive term.

**Regression tests (all in `ml_engine/forge_worker/tests/test_reward_shaper.py`):**

- `test_cumulative_cap_blocks_runaway_positive_shape`
- `test_cumulative_cap_blocks_runaway_negative_shape`
- `test_loss_outcome_always_dominates_total_return` ← the canonical Anomaly-1A
- `test_reset_episode_clears_cumulative`
- `test_terminal_auto_resets_cumulative`

Run: `python -m pytest ml_engine/forge_worker/tests/test_reward_shaper.py -v`

---

## §7 — LLM calibrator inflating bad cards (Anomaly-1B)

**Symptom:** weekly `llmWeeklyCalibrator.ts` was pushing cards up to
weight 45+ even when they had empirical winrate < 5%. The LLM (Claude
Haiku) was only shown the card name + current weight, never the real
win/loss record, so it kept endorsing "staples on paper" that were
actually bleeding games.

**Root cause in `server/scripts/llmWeeklyCalibrator.ts` (pre-fix):**

```ts
const topCards = await db.select({ cardName, weight })
  .from(cardLearning)
  .orderBy(desc(cardLearning.weight))
  // no winCount / lossCount loaded → prompt has no reality signal
```

And `scoreToDelta(llmScore, currentWeight)` had no reality guard — any
score > 50 produced a positive delta regardless of actual performance.

**Fix:**

1. Query now also loads `winCount` and `lossCount`.
2. Prompt includes real winrate per card and an explicit rule: "winrate
   real < 30% with ≥10 games cannot receive score > 50".
3. `scoreToDelta()` now takes `(llmScore, weight, winCount, lossCount)`
   and applies two guards:
   - **Veto:** any positive delta is zeroed when winrate < 30% and total ≥ 10
   - **Force-down:** winrate < 25% with ≥10 games receives a mandatory
     negative delta proportional to how bad the winrate is

Even if the LLM still "likes" the card, it can no longer push the weight
higher against empirical evidence.

**Operational check:** after the next weekly calibration run, verify with
`npm run check:learn` that no card with winrate < 30% + total ≥ 10 has
weight above ~35. If it does, the guard didn't fire — check for recent
edits to `VETO_WINRATE_PCT` or `MIN_GAMES_FOR_VETO`.

---

## §8 — DFC color identity stored as "C" colorless (Anomaly-3)

**Symptom:** Aclazotz (a black MDFC — Modal Double-Faced Card) showed
up in `check:learn` output as color "C" (colorless), so commander-colour
filters silently excluded him from black-identity decks.

**Root cause:** `server/seed-scryfall.ts` and `server/sync-bulk.ts` both
persisted colors with `card.colors?.join("") || null`. Scryfall reports
DFC colors on `card_faces[i].colors`, not on the top-level `colors`
field, so DFCs ended up with NULL → rendered as "C".

**Fix — fallback chain in both seed scripts:**

```
1.  card.colors                       (normal cards)
2.  union(card_faces[i].colors)       (DFCs, split cards)
3.  card.color_identity               (authoritative fallback)
4.  ""  (empty string = truly colorless, distinct from NULL)
```

New public helpers:
- `resolveScryfallColors()` in `seed-scryfall.ts` (exported for reuse)
- `resolveCardColors()` in `sync-bulk.ts` (module-local)
- `server/scripts/repairCardColors.ts` — one-shot retroactive repair
  that re-fetches every card with NULL/empty colors from Scryfall and
  updates the row

**Operational recovery for an existing database:**

```bash
# Dry-run first — shows what would change, writes nothing
npx tsx server/scripts/repairCardColors.ts

# Then commit the repair (can be re-run; idempotent)
npx tsx server/scripts/repairCardColors.ts --apply
```

After this, `npm run check:learn` should no longer show legendary
creatures as color "C" unless they are genuinely colorless (e.g.
Kozilek, Karn, etc.).

---

## §9 — Commander display ordering with reality guard (Anomaly-2 display layer)

Even after the weight decay + LLM guard are live, the `check:learn`
display can still *show* a bad card on top for a few days while the
decay rolls in. The display script was updated to apply its own
reality guard:

- Cards with total ≥ 10 and winrate < 20% are *pushed to the bottom*
  of the top-10 regardless of raw weight.
- Cards with total = 0 are capped at a display-score of 40, so any
  real-data commander with positive winrate ranks above them.

Source: `server/scripts/checkCommanderWeights.ts` (function `scoreOf`).
If the top-10 still looks wrong, inspect that ordering first — the
underlying weights may already be fine.

---

## §10 — Late-stage OOM during long PBT runs (Anomaly-4)

### Symptom

Training survives the warm-up (so this is NOT §2, the dummy-batch
allocation), runs for 1–3 hours, then crashes somewhere around
iteration 100+ per trial with:

```
numpy._core._exceptions._ArrayMemoryError:
  Unable to allocate 5.14 MiB for an array with shape (50, 26974) and data type float32
```

…often followed by a secondary failure inside the checkpoint
serializer:

```
MemoryError  in cloudpickle.dumps(...)
```

The allocation size (5 MiB) is tiny — it's a single rollout fragment.
That it fails means the **process/system** is out of contiguous memory,
not that the tensor is big.

### Root cause

Aggregate pressure from the PBT topology, not any single tensor:

- `num_trials=4 × num_workers=4` = **16 concurrent env runners**
- Each env runner spawns one Forge JVM with `-Xmx2G`
- Forge JVMs grow to ~0.5–1 GB each after warm-up → **8–16 GB of JVM heap**
- PBT perturbations (every 20 iters) clone winner weights + optimizer
  state → transient spikes 2–3× model size
- Checkpoint serialization (every `checkpoint_freq` iters) holds the
  full state in memory during `cloudpickle.dumps`

Over 2–3 hours the Python learner process fragments, the JVMs grow,
Windows commits near system limits, and the next small allocation
fails. The traceback looks like a plain OOM but the real disease is
**too many concurrent heavyweight processes for a laptop-class box**.

### Guards now in code

1. **`scripts/teach-loop.ps1` peer**: `npm run train:ray` defaults to
   `--num-workers 2 --num-trials 2` (was `4 × 4`). Cuts concurrent
   JVMs from 16 to 4. Override with explicit CLI flags if you're on
   a workstation with 64+ GB.

2. **`env.py` line ~281**: Forge JVM launched with `-Xmx1G` (was
   `-Xmx2G`). Caps aggregate JVM reserve at ~4 GB with the default
   topology. Forge runs comfortably in 1 GB for Commander/Brawl.

3. `max_cards=64` already enforced by §2 — keeps per-tensor size bounded.

### Verify the guard

```powershell
# Expect to see: --num-workers 2 --num-trials 2
Select-String -Path package.json -Pattern '"train:ray":'

# Expect to see: -Xmx1G
Select-String -Path ml_engine\ray_cluster\env.py -Pattern '-Xmx'
```

### Fix if you hit it again

In order of invasiveness, pick the first that works:

1. **Confirm nothing else is eating RAM.** Chrome, Docker Desktop, and
   VSCode Copilot all like to sit on 2–4 GB. Close them.
2. **Lower population further**: `--num-trials 1` (kills PBT but runs
   a single IMPALA trial fine) or `--num-workers 1`.
3. **Enable observation compression** in `build_impala_config`
   (`orchestrator.py`): add `compress_observations=True` to
   `.env_runners(...)`. LZ4 in-transit, ~5–10× on MTG obs.
4. **Structural**: replace the 26,974-dim flat card-pool obs with a
   variable-length `(deck_length, embedding_dim)` tensor backed by
   the existing card embeddings. Requires model + env changes.

### Recovery from a crash

The orchestrator writes checkpoints every `--checkpoint-freq` iters
under `ray_results/pbt_mtg_<ts>/`. You can inspect them but the
current `orchestrator.py` does **not** expose a `--resume` flag — the
experiment name is regenerated each run (`pbt_mtg_{time.time()}`). If
you want true resume, add `resume="LATEST"` + a stable `name=` to the
`tune.run(...)` call. Most of the time it's cheaper to relaunch with
the smaller topology than to wire up resume.

---

## CI / dev invariants

Run before every push that touches `ml_engine/ray_cluster/` or `ml_engine/models/`:

```powershell
.venv\Scripts\python -m pytest ml_engine/ray_cluster/tests/ ml_engine/scripts/tests/ -v
```

Green = every guard in this doc is still wired up. Red = you regressed a
guard; do not merge until the failure is triaged against the relevant
section above.

---

## Known-good "first run" command

If you just want a training run that definitely works on a 16 GB / 1 GPU
laptop, this is the recipe:

```powershell
powershell -ExecutionPolicy Bypass -File .\train.ps1 `
  -NumWorkers 2 `
  -NumTrials 2 `
  -BudgetHours 0.5 `
  -BatchSize 500 `
  -RolloutFragmentLength 50 `
  -MaxCards 32
```

Expected: all 2 trials alive after 30 min, at least 3 training iters each,
`check_learning_progress` reports `ALIVE` with non-zero rewards.

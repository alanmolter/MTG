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

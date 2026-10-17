# rlbridge_src — mirror dos fontes Java do ForgeRLBridge

`forge/` is a git submodule of https://github.com/Card-Forge/forge
(pinned commit `7cc4ff7b17365c7e882cb472537c5ccdda0dbde0`, see `.gitmodules`).
The superproject does not vendor files inside that checkout, so the bridge
sources live here and `setup.ps1` copies them into `forge/rlbridge/` on the
user's machine.

```powershell
git submodule update --init forge
```

## Fluxo em `setup.ps1`

```
rlbridge_src/  →  forge/rlbridge/   (cópia automática no setup)
                      ↓
                  build.cmd  (javac + jar → target/rlbridge.jar)
                      ↓
                  test.cmd   (roda os 25 asserts Java)
```

## O que está aqui

- `src/main/java/forge/rlbridge/ForgeRLBridge.java` — bridge Python↔Forge
  com o protocolo `step` (legacy Discrete) e `step_autoregressive` (Phase 3
  sem hash collision).
- `src/test/java/forge/rlbridge/ForgeRLBridgeAutoregressiveTest.java` —
  reflection tests for the JSON parser (including `longOrNull` seeds) and
  the fail-safe range check.
- `build.cmd` — javac + jar, sem Maven (compila contra o fat jar do
  Forge).
- `test.cmd` — compila + roda os testes.
- `run.cmd` — lança o bridge em modo interativo pra debug.

## Rebuild after a Java change

`rlbridge.jar` is not produced in this repo. On the Windows machine, from
the repo root:

```powershell
New-Item -ItemType Directory -Force forge\rlbridge | Out-Null
Copy-Item -Recurse -Force rlbridge_src\src\* forge\rlbridge\src\
Copy-Item -Force rlbridge_src\build.cmd forge\rlbridge\build.cmd
cmd /c forge\rlbridge\build.cmd
```

`build.cmd` compiles against
`forge\forge-gui-desktop\target\forge-gui-desktop-2.0.12-SNAPSHOT-jar-with-dependencies.jar`.
`scripts\e2e-preflight.ps1` does this copy and build and FAILs the rlbridge
stage when the Forge jar is absent.

Protocol v2 (`rlbridge-v2.0.0`, `PROTOCOL_VERSION=2`). The agent seat is an
`ExternalPlayerController` when `agent_policy` is `external`. The opponent
stays `LobbyPlayerAi`. `policy_controlled` is true only while that controller
is installed. `agent_policy=forge_ai` still plays the match out inside
`new_game` and returns one terminal state with `policy_controlled` false.

`step` applies a legal mask bit and blocks until the next agent decision.
An illegal bit returns the same `decision_id` and `state_hash` and does not
call Forge. A `step_timeout` discards the match so a late state cannot be
served under the next request id. Replies without `request_id` are rejected.
`ping` is the v2 `hello` and requires `protocol: 2`. A v1 client receives
`PROTOCOL_MISMATCH`. `cards_loaded` is the common-card count from the card
database, not a hardcoded 0.

Each match has an epoch. `new_game` waits for the previous game runnable to
finish (or five seconds) and then drops any publish that still carries the
old epoch, so a terminal state cannot satisfy the next reset.

`ai_fallback_decisions` counts decisions the external controller does not
cover and delegates to Forge AI (modes, scry, sacrifice, X, and the rest of
`PlayerController`). Mana payment, reveals, and turn bookkeeping are not
counted. A snapshot exception is `ENGINE_ERROR` (`bridge_errors`), logged
with a stack trace, and is not handed to the AI.

`chosen_action` is the slot the Forge AI would have taken for that decision
(`exact_ai_labels`), or `-1` when it could not be mapped. It is not inferred
from a hand diff.

## Rebuild and test on Windows

```powershell
New-Item -ItemType Directory -Force forge\rlbridge | Out-Null
Copy-Item -Recurse -Force rlbridge_src\src\* forge\rlbridge\src\
Copy-Item -Force rlbridge_src\build.cmd,rlbridge_src\test.cmd forge\rlbridge\
cmd /c forge\rlbridge\build.cmd
cmd /c forge\rlbridge\test.cmd
powershell -ExecutionPolicy Bypass -File .\scripts\e2e-preflight.ps1
# Full phase-1 sample (the smoke default is 2 episodes):
$env:POLICY_CONTROL_EPISODES = "200"
python -m ml_engine.scripts.e2e_preflight --stage policy_control
```

CI runs `rlbridge_src/test-protocol.sh` (no Forge jar) and
`python schemas/bridge_v2/validate.py`.

## Seed

Before `createGame`, the bridge derives one seed per match for Java,
Forge shuffles (`MyRandom.setRandom`), and Forge AI static `Random` fields.
Python reseeds NumPy and PyTorch only when `seed_python_rngs` is set, so a
training worker does not restart its policy RNG on every episode.

`MyRandom` is process-global. Run one game per JVM. Wall-clock timeouts can
still diverge; phase 1 asks for identical hashes on at least 95% of paired
replays. A missing seed leaves Forge's `SecureRandom` in place.

## Atualizar os fontes

Depois de editar `forge/rlbridge/...` na sua máquina:

```powershell
Copy-Item -Recurse -Force forge\rlbridge\src\*         rlbridge_src\src\
Copy-Item -Force            forge\rlbridge\*.cmd       rlbridge_src\
git add rlbridge_src
git commit -m "rlbridge: ..."
```

Ou use o helper `.\sync-rlbridge.ps1` (gerado pelo `setup.ps1`).

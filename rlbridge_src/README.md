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

Snapshots now include the Discrete(512) contract (`action_mask`,
`action_source_indices`, `action_target_indices`, `action_kinds`) and
`chosen_action`. `chosen_action` is the slot of the card that left the
agent's hand since the previous snapshot, `0` for an inferred pass, or `-1`
when the AI decision does not map. `policy_controlled` stays false until a
controller actually applies `step`.

## Seed

`new_game.seed` is applied with `MyRandom.setRandom(new java.util.Random(seed))`
before `match.createGame()`. Forge documents that hook for deterministic
simulation. It covers shuffles and coin flips that later call
`MyRandom.getRandom()`.

Limits, so the same seed is not a full replay:

- Code that does `new Random()` or `new SecureRandom()` (some AI heuristics)
  does not see this seed. `setSeed` on the default `SecureRandom` is not used,
  because that is not a portable replay.
- Wall-clock timeouts and thread scheduling still vary.
- `MyRandom` is process-global. Run one game per JVM.
- The bridge still lets Forge AI play both sides. A repeated seed repeats
  opening hands when those shuffles go through `MyRandom`. It does not prove
  the whole game is identical.

A missing seed leaves Forge's `SecureRandom` in place. Python may send a
seed larger than `Integer.MAX_VALUE`; the bridge reads it as a long.

## Atualizar os fontes

Depois de editar `forge/rlbridge/...` na sua máquina:

```powershell
Copy-Item -Recurse -Force forge\rlbridge\src\*         rlbridge_src\src\
Copy-Item -Force            forge\rlbridge\*.cmd       rlbridge_src\
git add rlbridge_src
git commit -m "rlbridge: ..."
```

Ou use o helper `.\sync-rlbridge.ps1` (gerado pelo `setup.ps1`).

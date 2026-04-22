# rlbridge_src — mirror dos fontes Java do ForgeRLBridge

Este diretório existe porque `forge/` é um git submódulo (fork de
`Card-Forge/forge`) e o Git do superprojeto **não consegue trackear**
arquivos dentro dele. Então mantemos aqui uma cópia versionada de
`forge/rlbridge/` e o `setup.ps1` se encarrega de materializar essa cópia
dentro de `forge/rlbridge/` na máquina do usuário.

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
  25 asserts via reflection validando o parser de JSON + fail-safe de
  range.
- `build.cmd` — javac + jar, sem Maven (compila contra o fat jar do
  Forge).
- `test.cmd` — compila + roda os testes.
- `run.cmd` — lança o bridge em modo interativo pra debug.

## Atualizar os fontes

Depois de editar `forge/rlbridge/...` na sua máquina:

```powershell
Copy-Item -Recurse -Force forge\rlbridge\src\*         rlbridge_src\src\
Copy-Item -Force            forge\rlbridge\*.cmd       rlbridge_src\
git add rlbridge_src
git commit -m "rlbridge: ..."
```

Ou use o helper `.\sync-rlbridge.ps1` (gerado pelo `setup.ps1`).

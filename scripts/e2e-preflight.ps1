#Requires -Version 5.0
<#
.SYNOPSIS
    End-to-end smoke for the Windows training machine.

.DESCRIPTION
    One pass, one PASS/FAIL line per stage:
      postgres  - docker compose service `postgres`, including a stale
                  container named mtg-pgvector left by the old service `db`
      rlbridge  - copy rlbridge_src into forge/rlbridge and rebuild the jar
      decks     - load deck pool v1 and v2
      db        - count Arena-format competitive_decks that have card rows
      matches   - forge_matches written equals the episode count and dropped is 0
      bc        - one Forge-AI vs Forge-AI record, a short supervised train,
                  and one KL-regularized step
      rllib     - IMPALA config with --bc-checkpoint / --bc-kl-coeff
      eval      - holdout action accuracy of the BC checkpoint

    A missing Forge checkout fails rlbridge and bc. It does not skip them.

    Python stages use the project .venv (Python 3.12). System Python is not
    a fallback: 3.14 does not have the torch_geometric build this tree needs.

.USAGE
    powershell -ExecutionPolicy Bypass -File .\scripts\e2e-preflight.ps1
#>
param(
    [string]$EnvFile = ".env",
    [string]$DatabaseUrl = ""
)

$ErrorActionPreference = "Continue"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))
$failed = @()

function Report {
    param([string]$Stage, [bool]$Ok, [string]$Detail)
    $status = $(if ($Ok) { "PASS" } else { "FAIL" })
    $color = $(if ($Ok) { "Green" } else { "Red" })
    Write-Host ("{0}: {1} {2}" -f $Stage, $status, $Detail) -ForegroundColor $color
    if (-not $Ok) { $script:failed += $Stage }
}

if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
        $parts = $line.Split("=", 2)
        if (-not (Test-Path "env:$($parts[0])")) {
            Set-Item -Path "env:$($parts[0])" -Value $parts[1].Trim().Trim('"').Trim("'")
        }
    }
}
if ($DatabaseUrl) { $env:DATABASE_URL = $DatabaseUrl }
if (-not $env:DATABASE_URL) {
    $env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5434/mtg"
}

function Resolve-ProjectPython {
    $candidates = @(
        (Join-Path (Get-Location) ".venv\Scripts\python.exe"),
        (Join-Path (Get-Location) ".venv\bin\python")
    )
    $found = $null
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { $found = $candidate; break }
    }
    if (-not $found) {
        Write-Host "e2e-preflight: no project .venv found." -ForegroundColor Red
        Write-Host "Create it with Python 3.12, then install ml_engine requirements:"
        Write-Host "  py -3.12 -m venv .venv"
        Write-Host "  .\.venv\Scripts\python.exe -m pip install -r ml_engine\requirements.txt"
        exit 1
    }
    $version = (& $found -c "import sys; print('%d.%d' % (sys.version_info[0], sys.version_info[1]))" | Out-String).Trim()
    if ($version -ne "3.12") {
        Write-Host "e2e-preflight: $found is Python $version. This project needs 3.12." -ForegroundColor Red
        Write-Host "Recreate the venv (do not fall back to system Python):"
        Write-Host "  py -3.12 -m venv .venv"
        Write-Host "  .\.venv\Scripts\python.exe -m pip install -r ml_engine\requirements.txt"
        exit 1
    }
    return $found
}

$python = Resolve-ProjectPython
Write-Host "e2e-preflight: python $python"

# --- postgres --------------------------------------------------------------
$compose = docker compose up -d postgres 2>&1 | Out-String
$composeOk = $LASTEXITCODE -eq 0
if (-not $composeOk -and $compose -match "mtg-pgvector") {
    Write-Host "postgres: container name mtg-pgvector is taken by the old compose service 'db'."
    $running = docker inspect -f "{{.State.Running}}" mtg-pgvector 2>$null
    if ($running -eq "true") {
        Write-Host "postgres: the existing mtg-pgvector container is running; reusing it."
        $composeOk = $true
    } else {
        docker rm mtg-pgvector | Out-Null
        $compose = docker compose up -d postgres 2>&1 | Out-String
        $composeOk = $LASTEXITCODE -eq 0
    }
}
$ready = $false
if ($composeOk) {
    docker exec mtg-pgvector pg_isready -U postgres -d mtg | Out-Null
    $ready = $LASTEXITCODE -eq 0
}
Report "postgres" ($composeOk -and $ready) $env:DATABASE_URL

# --- rlbridge --------------------------------------------------------------
$forgeJar = Get-ChildItem -Path "forge\forge-gui-desktop\target" -Filter "*jar-with-dependencies.jar" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $forgeJar) {
    Report "rlbridge" $false "Forge fat jar missing. Build forge, then this script copies rlbridge_src and runs forge\rlbridge\build.cmd."
} else {
    New-Item -ItemType Directory -Force -Path "forge\rlbridge" | Out-Null
    Copy-Item -Recurse -Force "rlbridge_src\src\*" "forge\rlbridge\src\"
    Copy-Item -Force "rlbridge_src\build.cmd" "forge\rlbridge\build.cmd"
    Push-Location "forge\rlbridge"
    cmd /c build.cmd
    $built = $LASTEXITCODE -eq 0 -and (Test-Path "target\rlbridge.jar")
    Pop-Location
    if ($built) { $env:FORGE_BRIDGE_JAR = (Resolve-Path "forge\rlbridge\target\rlbridge.jar").Path }
    if ($forgeJar) { $env:FORGE_JAR = $forgeJar.FullName }
    Report "rlbridge" $built "forge\rlbridge\target\rlbridge.jar"
}

# --- deck pools ------------------------------------------------------------
& $python -m ml_engine.scripts.e2e_preflight --stage decks
Report "decks" ($LASTEXITCODE -eq 0) "v1 + v2 manifest"

# --- database lists that actually have cards -------------------------------
$dbDetail = "skipped"
$dbOk = $false
if ($ready) {
    $sql = @"
SELECT format || '=' || count(*)::text
FROM competitive_decks d
WHERE lower(format) IN ('standard','pioneer','historic','timeless','explorer')
  AND EXISTS (SELECT 1 FROM competitive_deck_cards c WHERE c.deck_id = d.id)
GROUP BY format
ORDER BY format;
"@
    $dbDetail = docker exec -e PGPASSWORD=postgres mtg-pgvector psql -U postgres -d mtg -At -c $sql 2>&1 | Out-String
    $dbOk = $LASTEXITCODE -eq 0
}
Report "db" $dbOk $dbDetail.Trim()

# --- forge_matches accounting ----------------------------------------------
& $python -m ml_engine.scripts.e2e_preflight --stage matches --episodes 2
Report "matches" ($LASTEXITCODE -eq 0) "written == episodes and dropped == 0"

# --- record, train, one regularized step, eval, rllib config --------------
$work = Join-Path (Get-Location) "bc_smoke"
& $python -m ml_engine.scripts.e2e_preflight --stage bc --work $work
Report "bc" ($LASTEXITCODE -eq 0) "record + train + KL step"
& $python -m ml_engine.scripts.e2e_preflight --stage rllib --work $work
Report "rllib" ($LASTEXITCODE -eq 0) "IMPALA bc_checkpoint flag"
& $python -m ml_engine.scripts.e2e_preflight --stage eval --work $work
Report "eval" ($LASTEXITCODE -eq 0) "holdout action accuracy"

Write-Host ""
if ($failed.Count -eq 0) {
    Write-Host "e2e-preflight: PASS" -ForegroundColor Green
    exit 0
}
Write-Host ("e2e-preflight: FAIL " + ($failed -join ", ")) -ForegroundColor Red
exit 1

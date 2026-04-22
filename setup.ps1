#Requires -Version 5.0
<#
.SYNOPSIS
    MTG AI - One-shot setup script (Windows PowerShell-safe).

.DESCRIPTION
    Idempotent setup. Safe to re-run. Handles the things that silently fail
    on Windows PowerShell 5.1 so you don't have to:

      1. Bypasses ExecutionPolicy for its own session (no Set-ExecutionPolicy needed)
      2. Detects .venv, creates it if missing, activates it safely
      3. Installs Python deps from ml_engine/requirements.txt
      4. Installs Node deps via pnpm (or npm as fallback)
      5. Loads .env into $env:* so DATABASE_URL etc. are visible to child procs
      6. Creates pgvector extension + runs Drizzle migrations
      7. (Optional) backfills card oracle embeddings

.USAGE
    # First time - use this form so ExecutionPolicy is bypassed for this call:
    powershell -ExecutionPolicy Bypass -File .\setup.ps1

    # If you've already done:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
    # then you can just do:
    .\setup.ps1

    # Flags:
    .\setup.ps1 -SkipEmbeddings    # skip the slow embeddings backfill
    .\setup.ps1 -SkipNode          # skip pnpm install (already done)
    .\setup.ps1 -PythonBin python3.11

.NOTES
    Any step that fails prints RED and continues so you see ALL problems in
    one run instead of having to re-run N times to discover them one at a
    time. Final summary tells you what still needs fixing.
#>
param(
    [switch]$SkipEmbeddings = $false,
    [switch]$SkipNode       = $false,
    [switch]$SkipMigrations = $false,
    [switch]$SkipRlbridge   = $false,
    [switch]$ForceVenv      = $false,
    [string]$PythonBin      = "python",
    [string]$TargetPython   = "3.12",   # version we try to use via 'py -3.12'
    [string]$EnvFile        = ".env"
)

# Do NOT use $ErrorActionPreference = "Stop" here - we want to see every
# failure in one pass instead of halting on the first one.
$ErrorActionPreference = "Continue"
$problems = @()

function Step { param([string]$n, [string]$msg) Write-Host ""; Write-Host "=== [$n] $msg ===" -ForegroundColor Cyan }
function OK   { param([string]$msg) Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn { param([string]$msg) Write-Host "    WARN  $msg" -ForegroundColor Yellow; $script:problems += $msg }
function Fail { param([string]$msg) Write-Host "    FAIL  $msg" -ForegroundColor Red;    $script:problems += $msg }

# ---------------------------------------------------------------------------
# 0. Sanity: are we in the project root?
# ---------------------------------------------------------------------------
Step "0" "Checking project root"
if (-not (Test-Path "package.json")) {
    Fail "package.json not found. Run this script from the mtg-deck-mvp/ root."
    exit 1
}
if (-not (Test-Path "ml_engine")) {
    Fail "ml_engine/ not found. Run this script from the mtg-deck-mvp/ root."
    exit 1
}
OK "cwd is project root"

# ---------------------------------------------------------------------------
# 1. Load .env into this PowerShell session
#    PowerShell does NOT load .env automatically the way bash's dotenv can.
#    We parse it line-by-line and set $env:KEY for child processes.
# ---------------------------------------------------------------------------
Step "1" "Loading $EnvFile into current session"
if (Test-Path $EnvFile) {
    $loaded = 0
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        if ($line -match "^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$") {
            $k = $matches[1]
            $v = $matches[2].Trim()
            # Strip surrounding quotes if present
            if ($v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length - 2) }
            if ($v.StartsWith("'") -and $v.EndsWith("'")) { $v = $v.Substring(1, $v.Length - 2) }
            Set-Item -Path "env:$k" -Value $v
            $loaded++
        }
    }
    OK "$loaded variables loaded from $EnvFile"
    if (-not $env:DATABASE_URL) {
        Warn "DATABASE_URL not set after loading $EnvFile - migrations + embeddings will fail"
    }
} else {
    Warn "$EnvFile not found. Create it with at least DATABASE_URL=postgresql://..."
}

# ---------------------------------------------------------------------------
# 2. Python venv
#    The RL stack (torch, torch-geometric, ray) needs compiled wheels that
#    only exist for Python 3.11/3.12 on Windows right now. If .venv was
#    created with 3.13/3.14, pip WILL fail. We detect that and rebuild the
#    venv using 'py -3.12' automatically.
# ---------------------------------------------------------------------------
Step "2" "Python virtual environment (.venv)"
$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

function Get-VenvVersion {
    param([string]$Exe)
    if (-not (Test-Path $Exe)) { return $null }
    $raw = & $Exe -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    return ($raw | Out-String).Trim()
}

function New-Venv {
    param([string]$Version)
    # Try 'py -<ver>' first (Windows launcher), fall back to $PythonBin
    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        Write-Host "    using 'py -$Version' to build venv..." -ForegroundColor DarkGray
        & py "-$Version" -m venv .venv
        return $LASTEXITCODE
    } else {
        Write-Host "    'py' launcher not found, falling back to '$PythonBin -m venv'..." -ForegroundColor DarkGray
        & $PythonBin -m venv .venv
        return $LASTEXITCODE
    }
}

$needRebuild = $false
$currentVer  = Get-VenvVersion $venvPython
if (-not (Test-Path $venvPython)) {
    Write-Host "    .venv/Scripts/python.exe missing - creating fresh venv..." -ForegroundColor DarkGray
    $needRebuild = $true
} elseif ($ForceVenv) {
    Write-Host "    -ForceVenv: rebuilding .venv from scratch..." -ForegroundColor DarkGray
    $needRebuild = $true
} elseif ($currentVer -and ($currentVer -match "^3\.(1[3-9]|[2-9]\d)$")) {
    # 3.13+ - known broken for torch-geometric/ray wheels on Windows
    Write-Host "    .venv uses Python $currentVer but RL stack needs 3.11/3.12." -ForegroundColor Yellow
    Write-Host "    Rebuilding .venv with Python $TargetPython..." -ForegroundColor Yellow
    $needRebuild = $true
} else {
    OK ".venv exists (Python $currentVer)"
}

if ($needRebuild) {
    # Remove old venv if present. Use -Force because some files are read-only.
    if (Test-Path ".venv") {
        Remove-Item -Recurse -Force ".venv" -ErrorAction SilentlyContinue
    }
    $rc = New-Venv -Version $TargetPython
    if ($rc -ne 0) {
        Fail "venv creation failed (exit $rc). Make sure Python $TargetPython is installed: 'py -$TargetPython --version'"
    } elseif (-not (Test-Path $venvPython)) {
        Fail ".venv was created but $venvPython still missing"
    } else {
        $newVer = Get-VenvVersion $venvPython
        OK "venv created with Python $newVer"
    }
}

# Use the venv Python directly from here on - never rely on "activate" since
# the activation script doesn't survive re-invocation across Start-Process.
$pyExe = $venvPython
if (-not (Test-Path $pyExe)) {
    Fail "No Python binary found - skipping all Python-dependent steps"
    $pyExe = $null
}

# ---------------------------------------------------------------------------
# 3. Python deps
# ---------------------------------------------------------------------------
if ($pyExe) {
    Step "3" "Installing ml_engine/requirements.txt"
    if (-not (Test-Path "ml_engine\requirements.txt")) {
        Warn "ml_engine\requirements.txt not found - skipping pip install"
    } else {
        & $pyExe -m pip install --upgrade pip
        & $pyExe -m pip install -r ml_engine\requirements.txt
        if ($LASTEXITCODE -ne 0) {
            Fail "pip install failed - scroll up for the exact dependency that broke"
        } else {
            OK "Python deps installed"
        }
    }
}

# ---------------------------------------------------------------------------
# 4. Node deps
# ---------------------------------------------------------------------------
if (-not $SkipNode) {
    Step "4" "Installing Node deps (pnpm or npm)"
    $hasNode = (Get-Command node -ErrorAction SilentlyContinue) -ne $null
    if (-not $hasNode) {
        Fail "node not on PATH - install Node 20+ from nodejs.org"
    } else {
        $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
        if ($pnpm) {
            & pnpm install
            if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed" } else { OK "pnpm install done" }
        } else {
            Write-Host "    pnpm not found, falling back to npm..." -ForegroundColor DarkGray
            & npm install --legacy-peer-deps
            if ($LASTEXITCODE -ne 0) { Fail "npm install failed" } else { OK "npm install done" }
        }
    }
} else {
    Write-Host "    skipping Node install (-SkipNode)" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# 5. Database: pgvector extension + migrations
# ---------------------------------------------------------------------------
if (-not $SkipMigrations) {
    Step "5" "Database schema (pgvector + Drizzle migrate)"
    if (-not $env:DATABASE_URL) {
        Fail "DATABASE_URL not set - skipping migrations. Populate .env and re-run."
    } else {
        # We'd rather apply the extension via a migration, but having it
        # pre-created makes the first migration clean.
        $psql = Get-Command psql -ErrorAction SilentlyContinue
        if ($psql) {
            Write-Host "    ensuring 'vector' extension exists..." -ForegroundColor DarkGray
            & psql $env:DATABASE_URL -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1 | Out-Host
            if ($LASTEXITCODE -ne 0) {
                Warn "psql CREATE EXTENSION returned non-zero. If the extension is already there this is fine."
            } else {
                OK "vector extension ready"
            }
        } else {
            Write-Host "    psql not on PATH - skipping extension check (Drizzle migrations may fail if the extension isn't present)" -ForegroundColor DarkGray
        }

        # NOTE: we intentionally DO NOT run 'drizzle-kit generate' here.
        # generate rebuilds JSON snapshots by diffing schema.ts against
        # drizzle/meta/_journal.json - and that journal is currently in
        # mysql-era format (left over from before the PG migration), so
        # generate fails. The .sql migrations in drizzle/ are already on
        # disk; 'drizzle-kit migrate' reads them directly and applies what
        # isn't in __drizzle_migrations yet, which is what we want.
        Write-Host "    running drizzle-kit migrate (skipping generate - snapshots are mysql-era)..." -ForegroundColor DarkGray
        & npx drizzle-kit migrate 2>&1 | Out-Host
        $migrateRc = $LASTEXITCODE

        # drizzle-kit has a known behavior where it exits non-zero even when
        # the migration SQL actually applied (Postgres NOTICE messages like
        # "already exists, ignoring" get interpreted as errors on some
        # versions). Worse, in this project's case drizzle-kit silently DOES
        # NOT apply 0005_endgame_pgvector.sql (the meta journal is still in
        # mysql-era format from before the Postgres migration).
        #
        # Solution: apply + verify directly via psycopg2. The module is
        # idempotent - if drizzle-kit actually DID apply it, ensure_endgame_schema
        # sees the tables and exits 0 without re-applying.
        if ($pyExe) {
            Write-Host "    verifying + applying endgame schema via psycopg2..." -ForegroundColor DarkGray
            & $pyExe -m ml_engine.scripts.ensure_endgame_schema 2>&1 | Out-Host
            $verifyRc = $LASTEXITCODE
            if ($verifyRc -eq 0) {
                OK "Endgame schema verified (all 7 tables present)"
            } elseif ($verifyRc -eq 2) {
                Fail "Endgame schema still incomplete after apply attempt. Check DB perms + SQL file above."
            } else {
                Fail "ensure_endgame_schema failed with exit=$verifyRc. See output above."
                if ($migrateRc -ne 0) {
                    Write-Host "    (drizzle-kit also exited $migrateRc - that part was expected)" -ForegroundColor DarkGray
                }
            }
        } elseif ($migrateRc -eq 0) {
            OK "Drizzle migrations applied (no Python available for deep verify)"
        } else {
            Fail "drizzle migrate exit=$migrateRc and no Python available to verify"
        }
    }
} else {
    Write-Host "    skipping migrations (-SkipMigrations)" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# 6. Card embeddings backfill (slow, optional)
# ---------------------------------------------------------------------------
if (-not $SkipEmbeddings -and $pyExe) {
    Step "6" "Backfilling card oracle embeddings (first 100 cards as smoke test)"
    & $pyExe -m ml_engine.rag.pgvector_writer --limit 100
    if ($LASTEXITCODE -ne 0) {
        Warn "embedding backfill smoke test failed - check that ml_engine deps installed + DB is reachable"
    } else {
        OK "100-card smoke test embedded. For a full backfill run:"
        Write-Host "        & .\.venv\Scripts\python.exe -m ml_engine.rag.pgvector_writer" -ForegroundColor DarkGray
    }
} elseif ($SkipEmbeddings) {
    Write-Host "    skipping embeddings (-SkipEmbeddings)" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# 7. ForgeRLBridge (Java) - materialize from rlbridge_src/ + build + test
#    The forge/ directory is a nested fork of Card-Forge/forge, so git of
#    the superproject CAN NOT track our custom rlbridge/ files inside it.
#    We keep a tracked mirror at rlbridge_src/ and sync it here.
# ---------------------------------------------------------------------------
if (-not $SkipRlbridge) {
    Step "7" "ForgeRLBridge: sync rlbridge_src -> forge\rlbridge, build, test"
    $bridgeRoot = Join-Path $PSScriptRoot "forge\rlbridge"
    $mirror     = Join-Path $PSScriptRoot "rlbridge_src"
    $forgeJar   = Join-Path $PSScriptRoot "forge\forge-gui-desktop\target\forge-gui-desktop-2.0.12-SNAPSHOT-jar-with-dependencies.jar"

    if (-not (Test-Path $mirror)) {
        Warn "rlbridge_src\ missing - skipping sync (did git pull fetch it?)"
    } elseif (-not (Test-Path $forgeJar)) {
        Warn "Forge fat jar missing at $forgeJar"
        Warn "Build it once:  cd forge ; mvn package -pl forge-gui-desktop -am -DskipTests"
    } else {
        if (-not (Test-Path $bridgeRoot)) { New-Item -ItemType Directory -Path $bridgeRoot | Out-Null }
        if (-not (Test-Path (Join-Path $bridgeRoot "src"))) {
            New-Item -ItemType Directory -Path (Join-Path $bridgeRoot "src") | Out-Null
        }

        # Copy sources + scripts. -Force overwrites so it stays in sync with git.
        Write-Host "    syncing rlbridge_src -> forge\rlbridge ..." -ForegroundColor DarkGray
        Copy-Item -Recurse -Force (Join-Path $mirror "src\*")  (Join-Path $bridgeRoot "src\")
        Get-ChildItem -Path $mirror -Filter "*.cmd" | ForEach-Object {
            Copy-Item -Force $_.FullName (Join-Path $bridgeRoot $_.Name)
        }
        OK "sources + scripts in place"

        # Build: javac + jar (Maven-less)
        $classesDir = Join-Path $bridgeRoot "target\classes"
        if (-not (Test-Path $classesDir)) { New-Item -ItemType Directory -Path $classesDir | Out-Null }
        $mainSrc = Join-Path $bridgeRoot "src\main\java\forge\rlbridge\ForgeRLBridge.java"
        & javac -cp $forgeJar -d $classesDir $mainSrc
        if ($LASTEXITCODE -ne 0) {
            Fail "javac ForgeRLBridge.java failed - is JDK 11+ installed + on PATH?"
        } else {
            $metaDir = Join-Path $classesDir "META-INF"
            if (-not (Test-Path $metaDir)) { New-Item -ItemType Directory -Path $metaDir | Out-Null }
            $manifestPath = Join-Path $metaDir "MANIFEST.MF"
            Set-Content -Path $manifestPath -Encoding ASCII -Value @"
Manifest-Version: 1.0
Main-Class: forge.rlbridge.ForgeRLBridge

"@
            Push-Location $bridgeRoot
            & jar cfm target\rlbridge.jar target\classes\META-INF\MANIFEST.MF -C target\classes forge
            $jarRc = $LASTEXITCODE
            Pop-Location
            if ($jarRc -ne 0) { Fail "jar packaging failed" } else { OK "rlbridge.jar built" }

            # Run Java unit tests (compile + execute)
            $testDir = Join-Path $bridgeRoot "target\test-classes"
            if (-not (Test-Path $testDir)) { New-Item -ItemType Directory -Path $testDir | Out-Null }
            $testSrc = Join-Path $bridgeRoot "src\test\java\forge\rlbridge\ForgeRLBridgeAutoregressiveTest.java"
            & javac -cp "$forgeJar;$classesDir" -d $testDir $testSrc
            if ($LASTEXITCODE -ne 0) {
                Warn "javac test class failed - see output above"
            } else {
                & java -cp "$forgeJar;$classesDir;$testDir" forge.rlbridge.ForgeRLBridgeAutoregressiveTest
                if ($LASTEXITCODE -ne 0) { Fail "Java rlbridge tests FAILED" } else { OK "Java rlbridge tests passed" }
            }
        }
    }
} else {
    Write-Host "    skipping rlbridge (-SkipRlbridge)" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "     SETUP REPORT" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
if ($problems.Count -eq 0) {
    Write-Host "  ALL GREEN. You can now:" -ForegroundColor Green
    Write-Host "    1. Start the runtime stack :  .\run-stack.ps1" -ForegroundColor White
    Write-Host "    2. Start a single training :  .\train.ps1" -ForegroundColor White
    Write-Host "    3. Full legacy pipeline    :  .\run-all.ps1" -ForegroundColor White
} else {
    Write-Host "  Items needing attention:" -ForegroundColor Yellow
    foreach ($p in $problems) { Write-Host "    - $p" -ForegroundColor Yellow }
    Write-Host ""
    Write-Host "  Fix the items above and re-run:  .\setup.ps1" -ForegroundColor Yellow
}
Write-Host "  ============================================================" -ForegroundColor Cyan

#Requires -Version 5.0
<#
.SYNOPSIS
    One-shot: migrate existing Windows Postgres data into the Docker
    pgvector container.

.DESCRIPTION
    Flow:
      1. pg_dump the old Windows Postgres (postgres://postgres:alan7474@localhost:5432/MTG)
      2. docker compose up -d  (starts pgvector/pgvector:pg18 on :5433)
      3. Wait for container to be healthy
      4. psql-restore the dump into the new DB
      5. Rewrite .env -> DATABASE_URL on port 5433

    Idempotent-ish: you can re-run. It will re-dump and re-import. If you
    don't want to preserve old data, use -SkipDump (just starts the container
    with an empty DB and rewrites .env).

.USAGE
    # Preserve existing data from Windows Postgres:
    .\migrate-to-docker.ps1

    # Fresh start - no dump, just spin up the container:
    .\migrate-to-docker.ps1 -SkipDump

    # Change the source DSN if needed:
    .\migrate-to-docker.ps1 -OldDsn "postgresql://postgres:PASS@localhost:5432/MTG"
#>
param(
    [string]$OldDsn     = "postgresql://postgres:alan7474@localhost:5432/MTG",
    [string]$NewDsn     = "postgresql://postgres:postgres@localhost:5433/mtg",
    [string]$EnvFile    = ".env",
    [string]$DumpFile   = "tmp\mtg-old.dump",
    [switch]$SkipDump   = $false,
    [switch]$SkipRestore = $false
)

$ErrorActionPreference = "Continue"
function Step { param([string]$n, [string]$msg) Write-Host ""; Write-Host "=== [$n] $msg ===" -ForegroundColor Cyan }
function OK   { param([string]$msg) Write-Host "    OK   $msg" -ForegroundColor Green }
function Warn { param([string]$msg) Write-Host "    WARN $msg" -ForegroundColor Yellow }
function Fail { param([string]$msg) Write-Host "    FAIL $msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
Step "0" "Sanity checks"
# ---------------------------------------------------------------------------
if (-not (Test-Path "docker-compose.yml")) {
    Fail "docker-compose.yml not found. Run this from the project root."
    exit 1
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    Fail "docker CLI not on PATH. Install Docker Desktop first: https://www.docker.com/products/docker-desktop/"
    exit 1
}

# Quick ping to the docker engine
& docker version --format '{{.Server.Version}}' 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Fail "Docker engine is not running. Open Docker Desktop and wait for it to say 'Engine running'."
    exit 1
}
OK "docker CLI available + engine running"

# ---------------------------------------------------------------------------
Step "1" "Dump old Windows Postgres (source of truth)"
# ---------------------------------------------------------------------------
if ($SkipDump) {
    Warn "-SkipDump: skipping pg_dump. New DB will start empty."
} else {
    $pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
    if (-not $pgDump) {
        Warn "pg_dump not on PATH. Falling back to docker-image pg_dump..."
        # Use the pgvector image itself to run pg_dump against the host postgres.
        # This avoids needing a Windows psql install on PATH.
        #
        # 'host.docker.internal' is the special DNS name that lets a container
        # reach the host network from Docker Desktop.
        $rewrittenDsn = $OldDsn -replace "localhost", "host.docker.internal"
        if (-not (Test-Path "tmp")) { New-Item -ItemType Directory -Path "tmp" | Out-Null }
        Write-Host "    running pg_dump via docker (host.docker.internal)..." -ForegroundColor DarkGray
        & docker run --rm `
            -v "${PWD}\tmp:/out" `
            pgvector/pgvector:pg18 `
            pg_dump --format=custom --no-owner --no-acl "$rewrittenDsn" -f /out/mtg-old.dump
        if ($LASTEXITCODE -ne 0) {
            Fail "pg_dump via docker failed. Check the DSN and that Windows Postgres is actually running + accessible."
            Write-Host "    tried: $rewrittenDsn" -ForegroundColor DarkGray
            exit 1
        }
    } else {
        if (-not (Test-Path "tmp")) { New-Item -ItemType Directory -Path "tmp" | Out-Null }
        & pg_dump --format=custom --no-owner --no-acl $OldDsn -f $DumpFile
        if ($LASTEXITCODE -ne 0) {
            Fail "pg_dump failed. Check the DSN."
            exit 1
        }
    }
    if (Test-Path $DumpFile) {
        $size = (Get-Item $DumpFile).Length
        OK "dump written: $DumpFile  ($([math]::Round($size/1MB,2)) MB)"
    } else {
        Fail "dump file missing after pg_dump"
        exit 1
    }
}

# ---------------------------------------------------------------------------
Step "2" "Start docker compose (pgvector:pg16 on :5433)"
# ---------------------------------------------------------------------------
& docker compose up -d
if ($LASTEXITCODE -ne 0) {
    Fail "docker compose up failed. See errors above."
    exit 1
}
OK "container launched"

Write-Host "    waiting for pgvector container to become healthy..." -ForegroundColor DarkGray
$deadline = (Get-Date).AddSeconds(60)
$healthy = $false
while ((Get-Date) -lt $deadline) {
    $status = (& docker inspect --format "{{.State.Health.Status}}" mtg-pgvector 2>$null) -as [string]
    if ($status -eq "healthy") { $healthy = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $healthy) {
    Fail "container never reported healthy within 60s. Check 'docker compose logs db'"
    exit 1
}
OK "container healthy"

# ---------------------------------------------------------------------------
Step "3" "Install pgvector extension into the new DB"
# ---------------------------------------------------------------------------
# The image has the extension FILES baked in, but each DB still needs
# CREATE EXTENSION before the `vector` type becomes usable.
& docker exec -i mtg-pgvector psql -U postgres -d mtg -c "CREATE EXTENSION IF NOT EXISTS vector;"
if ($LASTEXITCODE -ne 0) {
    Fail "CREATE EXTENSION vector failed - check container logs"
    exit 1
}
OK "vector extension enabled on 'mtg' database"

# ---------------------------------------------------------------------------
Step "4" "Restore dump into the new DB"
# ---------------------------------------------------------------------------
if ($SkipRestore -or $SkipDump) {
    Warn "skipping restore (SkipDump or SkipRestore)"
} else {
    # Copy the dump into the container and run pg_restore from there
    & docker cp $DumpFile "mtg-pgvector:/tmp/mtg-old.dump"
    if ($LASTEXITCODE -ne 0) { Fail "docker cp failed"; exit 1 }

    # --no-owner / --no-acl: don't try to re-grant from the old role
    # --if-exists + --clean: drop objects before recreating (idempotent re-runs)
    & docker exec mtg-pgvector `
        pg_restore --no-owner --no-acl --if-exists --clean `
        -U postgres -d mtg /tmp/mtg-old.dump
    # pg_restore returns non-zero on warnings (e.g. "role does not exist"),
    # so we don't trust the exit code. Instead we sanity check a known table.
    $cardsCount = & docker exec mtg-pgvector psql -U postgres -d mtg -tAc "SELECT COUNT(*) FROM cards"
    if ($LASTEXITCODE -ne 0) {
        Warn "post-restore sanity query failed. Check 'docker compose logs db'."
    } else {
        OK "restore complete. cards table has $($cardsCount.Trim()) rows."
    }
}

# ---------------------------------------------------------------------------
Step "5" "Rewrite .env -> point DATABASE_URL to :5433"
# ---------------------------------------------------------------------------
if (Test-Path $EnvFile) {
    # Backup before rewriting
    Copy-Item $EnvFile "$EnvFile.bak" -Force
    OK "backed up existing $EnvFile -> $EnvFile.bak"

    $content = Get-Content $EnvFile -Raw
    if ($content -match "(?m)^DATABASE_URL\s*=.*$") {
        $content = [regex]::Replace($content, "(?m)^DATABASE_URL\s*=.*$", "DATABASE_URL=$NewDsn")
    } else {
        $content = "DATABASE_URL=$NewDsn`n" + $content
    }
    Set-Content -Path $EnvFile -Value $content -Encoding utf8
    OK "DATABASE_URL rewritten to $NewDsn"
} else {
    Warn "$EnvFile does not exist. Writing a fresh one."
    "DATABASE_URL=$NewDsn" | Set-Content $EnvFile -Encoding utf8
    OK "wrote new $EnvFile"
}

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "     MIGRATION DONE" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "  New DB:     $NewDsn" -ForegroundColor White
Write-Host "  Container:  docker compose ps" -ForegroundColor White
Write-Host "  Logs:       docker compose logs -f db" -ForegroundColor White
Write-Host ""
Write-Host "  Next step - re-run setup (which will now find pgvector):" -ForegroundColor Green
Write-Host "      .\setup.ps1" -ForegroundColor White
Write-Host "  ============================================================" -ForegroundColor Cyan

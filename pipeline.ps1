#Requires -Version 5.0
<#
.SYNOPSIS
    MTG AI - End-to-end Arena pipeline (convergence audit + fresh deck +
    Forge match + provenance + post-match learning report).

.DESCRIPTION
    Replaces the lighter pre-2026-05-30 pipeline. This version answers the
    operator question "is the model converged enough to build playable
    Arena decks?" in nine concrete phases:

      FASE 0  Convergencia: Ray env_steps totais + cobertura Arena estavel
              em card_learning + populacao card_synergies. Computa tier
              (Aprendiz..Mestre) e quantas teach:arena runs faltam.
      FASE 1  Sanity DB: DATABASE_URL alcancavel, pool Arena populado,
              card_learning + card_synergies presentes e nao-vazios.
      FASE 2  Snapshot top weights Arena (npm run check:learn).
      FASE 3  Snapshot pesos detalhado por tier (Mestre/Avancado/...) e
              distribuicao por bucket de peso.
      FASE 4  Snapshot Ray IMPALA (ultima experiment, env_steps_lifetime
              do trial mais recente, status).
      FASE 5  Gera deck NOVO + joga 1 partida no Forge. Deck e construido
              via synthesizeArenaDeckFromBrain (card_learning weights +
              card_synergies pair bias). O script TS imprime provenance
              por carta (origem: learned/synergy/neutral).
      FASE 6  Inspeciona o ultimo .dck escrito + valida tamanho >=60 e
              limite 4 copias. Lista cartas e identidade de cor.
      FASE 7  Pos-match: aplica delta, mostra novos top weights, mede
              quantas cartas mudaram de tier (qualificaram como estaveis).
      FASE 8  Sinergias usadas no deck — quantos pares do agent_deck
              tinham entrada em card_synergies (proof of bias).
      FASE 9  Veredito final + proximos passos (treino adicional vs. ja
              consegue gerar decks coerentes).

    PRINCIPIO: o pipeline NAO treina. Treine antes com:
        npm run teach:arena:12h   (~70 runs em 12h, sobe cobertura)
        .\train.ps1 -BudgetHours 1   (Ray IMPALA 1h, refina policy GNN)
    Depois rode .\pipeline.ps1 pra avaliar o estado.

.USAGE
    powershell -ExecutionPolicy Bypass -File .\pipeline.ps1
    .\pipeline.ps1                    # pipeline completa (recomendado)
    .\pipeline.ps1 -SkipMatch         # so diagnostico, pula Forge
    .\pipeline.ps1 -EnvFile .\.env.local
#>
param(
    [switch]$SkipMatch = $false,
    [string]$EnvFile   = ".env"
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8       = "1"

function Phase($m) { Write-Host "`n========== $m ==========" -ForegroundColor Cyan }
function Pass($m)  { Write-Host "  [OK]  $m" -ForegroundColor Green }
function Warn($m)  { Write-Host "  [WN]  $m" -ForegroundColor Yellow }
function Fail($m)  { Write-Host "  [ER]  $m" -ForegroundColor Red }
function Info($m)  { Write-Host "  $m" -ForegroundColor White }

# ── Load .env ────────────────────────────────────────────────────────────────
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        if ($line -match "^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$") {
            $v = $matches[2].Trim()
            if ($v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length - 2) }
            if ($v.StartsWith("'") -and $v.EndsWith("'")) { $v = $v.Substring(1, $v.Length - 2) }
            Set-Item -Path "env:$($matches[1])" -Value $v
        }
    }
}
if (-not $env:TRAINING_POOL_ARENA_ONLY) { $env:TRAINING_POOL_ARENA_ONLY = "1" }
if (-not $env:VISUAL_AUTO_MATCH)        { $env:VISUAL_AUTO_MATCH        = "1" }

# Snapshot pre-match metrics for FASE 7 delta later
$preMatchSnapshot = $null

# ── FASE 0: Convergencia macro ──────────────────────────────────────────────
Phase "FASE 0: Convergencia macro (Ray steps + Arena coverage + sinergias)"
$convScript = @"
import csv, glob, json, os, sys
import psycopg2
out = {}

ray_dirs = [
    os.path.join(os.environ.get('LOCALAPPDATA',''), 'mtg-deck-mvp', 'ray_results'),
    os.path.join(os.getcwd(), 'ray_results'),
]
total_ts = 0
total_iters = 0
biggest_exp = ('', 0)
for d in ray_dirs:
    if not os.path.isdir(d): continue
    for csvf in glob.glob(os.path.join(d, '**', 'progress.csv'), recursive=True):
        try:
            with open(csvf, 'r', encoding='utf-8') as f:
                rows = list(csv.DictReader(f))
            if not rows: continue
            last = rows[-1]
            for k in last:
                if 'env_steps_sampled_lifetime' in k.lower():
                    try:
                        ts = int(float(last[k] or 0))
                        total_ts += ts
                        total_iters += len(rows)
                        if ts > biggest_exp[1]:
                            biggest_exp = (csvf, ts)
                    except: pass
                    break
        except: pass
out['ray_env_steps_total']  = total_ts
out['ray_iters_total']      = total_iters
out['ray_biggest_trial_ts'] = biggest_exp[1]

try:
    c = psycopg2.connect(os.environ['DATABASE_URL'], connect_timeout=5)
    cur = c.cursor()
    cur.execute('SELECT COUNT(DISTINCT name) FROM cards WHERE is_arena=1')
    out['arena_pool'] = cur.fetchone()[0]
    cur.execute('''SELECT COUNT(DISTINCT cl.card_name) FROM card_learning cl
                   JOIN cards ca ON ca.name=cl.card_name
                   WHERE ca.is_arena=1 AND (cl.win_count+cl.loss_count) >= 10''')
    out['arena_stable'] = cur.fetchone()[0]
    cur.execute('''SELECT COUNT(DISTINCT cl.card_name) FROM card_learning cl
                   JOIN cards ca ON ca.name=cl.card_name
                   WHERE ca.is_arena=1 AND (cl.win_count+cl.loss_count) >= 30''')
    out['arena_mature'] = cur.fetchone()[0]
    cur.execute('''SELECT SUM(cl.win_count*1.0)::float / NULLIF(SUM(cl.win_count+cl.loss_count),0)
                   FROM card_learning cl JOIN cards ca ON ca.name=cl.card_name
                   WHERE ca.is_arena=1 AND (cl.win_count+cl.loss_count) >= 10''')
    wr = cur.fetchone()[0]
    out['arena_winrate_avg'] = float(wr) if wr is not None else 0
    cur.execute('SELECT SUM(win_count+loss_count) FROM card_learning')
    out['card_touches_total'] = int(cur.fetchone()[0] or 0)
    cur.execute(\"SELECT to_regclass('public.card_synergies')\")
    if cur.fetchone()[0]:
        cur.execute('SELECT COUNT(*) FROM card_synergies WHERE card1_id <> card2_id')
        out['syn_total'] = cur.fetchone()[0]
        cur.execute('''SELECT COUNT(*) FROM card_synergies cs
                       JOIN cards c1 ON c1.id=cs.card1_id
                       JOIN cards c2 ON c2.id=cs.card2_id
                       WHERE c1.is_arena=1 AND c2.is_arena=1 AND cs.card1_id<>cs.card2_id''')
        out['syn_arena'] = cur.fetchone()[0]
    else:
        out['syn_total'] = 0
        out['syn_arena'] = 0
    c.close()
except Exception as e:
    out['db_error'] = str(e)

print(json.dumps(out))
"@
$convJson = python -c $convScript 2>&1 | Select-Object -Last 1
try { $conv = $convJson | ConvertFrom-Json } catch { $conv = @{} }

if ($conv.db_error) { Fail "DB: $($conv.db_error)" }

# PS 5.1 doesn't support `??`. Helper does the equivalent.
function CoalesceNum($v, $default) {
    if ($null -eq $v -or "$v" -eq "") { return $default }
    return $v
}

$arenaPool   = [int](CoalesceNum $conv.arena_pool          0)
$arenaStable = [int](CoalesceNum $conv.arena_stable        0)
$arenaMature = [int](CoalesceNum $conv.arena_mature        0)
$arenaWr     = [double](CoalesceNum $conv.arena_winrate_avg 0)
$cardTouches = [int](CoalesceNum $conv.card_touches_total  0)
$rayTotalTs  = [int](CoalesceNum $conv.ray_env_steps_total 0)
$rayIters    = [int](CoalesceNum $conv.ray_iters_total     0)
$rayBiggest  = [int](CoalesceNum $conv.ray_biggest_trial_ts 0)
$synTotal    = [int](CoalesceNum $conv.syn_total           0)
$synArena    = [int](CoalesceNum $conv.syn_arena           0)
$coverage    = if ($arenaPool -gt 0) { $arenaStable * 100.0 / $arenaPool } else { 0 }

$tier =
    if     ($coverage -ge 90) { "Mestre"         }
    elseif ($coverage -ge 75) { "Avancado"       }
    elseif ($coverage -ge 50) { "Intermediario"  }
    elseif ($coverage -ge 25) { "Iniciante"      }
    else                       { "Aprendiz"       }

$gap90 = [Math]::Max(0, [Math]::Round($arenaPool * 0.9) - $arenaStable)
$gap75 = [Math]::Max(0, [Math]::Round($arenaPool * 0.75) - $arenaStable)
# Empirical: 1 teach:arena run touches ~150k cards but marginal stable gain
# tapers. Conservative ~140 new "stable" cards per run early on, ~70 later.
$runsTo75 = if ($coverage -lt 75) { [Math]::Round($gap75 / 80.0) } else { 0 }
$runsTo90 = if ($coverage -lt 90) { [Math]::Round($gap90 / 50.0) } else { 0 }

Info ("Ray IMPALA env_steps (todos os runs) : {0:N0}" -f $rayTotalTs)
Info ("Ray trial isolado maior              : {0:N0} ts ({1} iters totais)" -f $rayBiggest, $rayIters)
Info ("Pool Arena (cartas distintas)        : {0:N0}" -f $arenaPool)
Info ("Arena estaveis >=10 jogos            : {0:N0} ({1:N1}% coverage)" -f $arenaStable, $coverage)
Info ("Arena maduras >=30 jogos             : {0:N0} ({1:N1}%)" -f $arenaMature, ($arenaMature*100.0/[Math]::Max($arenaPool,1)))
Info ("Winrate medio das estaveis           : {0:N1}%" -f ($arenaWr*100))
Info ("Card-touches cumulativos             : {0:N0}" -f $cardTouches)
Info ("card_synergies (pares totais)        : {0:N0}" -f $synTotal)
Info ("card_synergies Arena <-> Arena       : {0:N0} ({1:N1}%)" -f $synArena, ($synArena*100.0/[Math]::Max($synTotal,1)))
Write-Host ""
Info ("TIER ATUAL                           : $tier")
if ($runsTo75 -gt 0) { Info ("Runs teach:arena pra Avancado (75%)  : ~$runsTo75 runs (~$([Math]::Round($runsTo75 * 10 / 60.0, 1))h)") }
if ($runsTo90 -gt 0) { Info ("Runs teach:arena pra Mestre (90%)    : ~$runsTo90 runs (~$([Math]::Round($runsTo90 * 10 / 60.0, 1))h)") }
if ($tier -eq "Mestre") { Pass "Convergencia suficiente pra decks Arena consistentes." }
elseif ($tier -in @("Avancado","Intermediario")) { Pass "Convergencia OK — decks coerentes esperados." }
else { Warn "Cobertura baixa — decks vao misturar cartas com sinal fraco." }

# ── FASE 1: Sanity DB ───────────────────────────────────────────────────────
Phase "FASE 1: sanity DB (DATABASE_URL + tabelas obrigatorias)"
if ($conv.db_error) {
    Fail "DB inacessivel: $($conv.db_error)"
} else {
    if ($arenaPool -ge 1000)    { Pass "cards.is_arena populado ($arenaPool cartas)" } else { Fail "Pool Arena minusculo: $arenaPool — rode db:repair-arena" }
    $cardTouchesFmt = '{0:N0}' -f $cardTouches
    if ($cardTouches -ge 10000) { Pass "card_learning ativo ($cardTouchesFmt touches)" } else { Warn "card_learning quase vazio — rode teach:arena" }
    if ($synArena    -ge 100)   { Pass "card_synergies Arena ativo ($synArena pares)" } else { Warn "Sinergias Arena fracas — rode continuousTraining" }
}

# ── FASE 2: Snapshot top Arena (check:learn) ────────────────────────────────
Phase "FASE 2: Snapshot top Arena (check:learn)"
$preTop20 = npm run --silent check:learn 2>&1
$preTop20 | Select-Object -First 18 | ForEach-Object { Write-Host "  $_" }

# ── FASE 3: Distribuicao por bucket de peso Arena ───────────────────────────
Phase "FASE 3: Distribuicao Arena por bucket de peso"
$bucketScript = @"
import os, psycopg2, json
c = psycopg2.connect(os.environ['DATABASE_URL'], connect_timeout=5); cur=c.cursor()
buckets = [(0,0.5,'baixa     '),(0.5,2,'neutra    '),(2,10,'media     '),(10,25,'alta      '),(25,50,'saturada  ')]
for lo, hi, lbl in buckets:
    cur.execute('''SELECT COUNT(DISTINCT cl.card_name) FROM card_learning cl
                   JOIN cards ca ON ca.name=cl.card_name
                   WHERE ca.is_arena=1 AND cl.weight >= %s AND cl.weight < %s''', (lo, hi))
    n = cur.fetchone()[0]
    bar = '#' * min(50, int(n/40))
    print(f'  [{lo:4.1f},{hi:4.1f}) {lbl} : {n:>6,}  {bar}')
c.close()
"@
python -c $bucketScript 2>&1 | ForEach-Object { Write-Host $_ }

# ── FASE 4: Estado Ray IMPALA (ultimo trial) ────────────────────────────────
Phase "FASE 4: Estado Ray IMPALA (ultimo experimento)"
$rayResultsDir = if ($env:RAY_RESULTS_DIR) { $env:RAY_RESULTS_DIR } `
                 else { Join-Path $env:LOCALAPPDATA "mtg-deck-mvp\ray_results" }
python -m ml_engine.scripts.check_learning_progress --results-dir "$rayResultsDir" --tail 1 2>&1 |
    Select-Object -First 25 | ForEach-Object { Write-Host $_ }

# Capture pre-match weights distribution for FASE 7 delta
$preMatchSnapshot = python -c @"
import os, psycopg2, json
c = psycopg2.connect(os.environ['DATABASE_URL'], connect_timeout=5); cur=c.cursor()
cur.execute('''SELECT cl.card_name, cl.weight, cl.win_count, cl.loss_count
               FROM card_learning cl JOIN cards ca ON ca.name=cl.card_name
               WHERE ca.is_arena=1''')
out = {r[0]: {'w': float(r[1]), 'wc': int(r[2]), 'lc': int(r[3])} for r in cur.fetchall()}
print(json.dumps(out))
c.close()
"@ 2>&1 | Select-Object -Last 1

# ── FASE 5: Forge match (deck novo + provenance + visual) ───────────────────
$matchVerdict = "skipped"
$matchLog = $null
if (-not $SkipMatch) {
    Phase "FASE 5: gera deck novo (cerebro+sinergias) + joga 1 partida no Forge"
    $matchLog = Join-Path $env:TEMP ("mtg-pipeline-match-" + (Get-Date -Format yyyyMMdd-HHmmss) + ".log")

    # Echo provenance section to console live so the operator sees deck construction
    Write-Host "  Construindo deck com card_learning + card_synergies..." -ForegroundColor Gray
    cmd /c "npx tsx server/scripts/playOneArenaMatch.ts --auto > `"$matchLog`" 2>&1"
    $matchExit = $LASTEXITCODE
    $matchTxt  = ""
    if (Test-Path $matchLog) { $matchTxt = Get-Content -Raw -LiteralPath $matchLog }

    # Print provenance lines from the log (everything between Rotação and Forge open)
    $provBlock = ($matchTxt -split "`r?`n") |
        Where-Object { $_ -match 'Rotação|Síntese cerebro|provenance|Pool candidato|Spells learned|Spells via sinergia|Peso medio cerebro|Winrate medio|^\s+\dx\s' } |
        Select-Object -First 60
    if ($provBlock) {
        Write-Host ""
        Write-Host "  ── PROVENANCE DAS DUAS LISTAS ──" -ForegroundColor Cyan
        $provBlock | ForEach-Object { Write-Host $_ }
    }

    $resultLine = ($matchTxt -split "`r?`n") | Where-Object { $_ -match 'VISUAL_AUTO_MATCH_RESULT\s*\{' } | Select-Object -Last 1
    if ($resultLine -and ($resultLine -match 'VISUAL_AUTO_MATCH_RESULT\s*(\{.*\})')) {
        try {
            $obj = $matches[1] | ConvertFrom-Json
            $w = "$($obj.winner)".ToLower()
            $oc = [int]($obj.outcome)
            if     ($w -eq "agent"    -or $oc -eq  1) { Pass "Forge: AGENT VENCEU";   $matchVerdict = "win"  }
            elseif ($w -eq "opponent" -or $oc -eq -1) { Warn "Forge: AGENT PERDEU";    $matchVerdict = "loss" }
            else                                       { Warn "Forge: empate";          $matchVerdict = "draw" }
        } catch {
            Warn "Forge: JSON parse failed ($($_.Exception.Message))"
            $matchVerdict = "indeterminate"
        }
    }
    elseif ($matchExit -ne 0) {
        Fail "Forge: erro exit=$matchExit (log: $matchLog)"; $matchVerdict = "error"
    }
    else {
        Warn "Forge: indeterminado (log: $matchLog)"; $matchVerdict = "indeterminate"
    }
} else {
    Phase "FASE 5: SKIPPED (--SkipMatch)"
}

# ── FASE 6: inspecionar deck que acabou de ser escrito ──────────────────────
Phase "FASE 6: deck gerado pelo cerebro (mainboard final + checks de legalidade)"
$autoArena = Join-Path $env:APPDATA "Forge\decks\constructed\AutoArena"
$mainCardsArr = @()
$deckColors = "?"
if (Test-Path $autoArena) {
    $latestDeck = Get-ChildItem $autoArena -Filter "Agent_*.dck" |
                  Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latestDeck) {
        $latestDeck = Get-ChildItem $autoArena -Filter "*.dck" |
                      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
    if ($latestDeck) {
        Info "Arquivo: $($latestDeck.FullName)"
        $deckText = Get-Content -Raw -LiteralPath $latestDeck.FullName
        $mainSection = $false
        foreach ($line in ($deckText -split "`r?`n")) {
            if ($line -match '^\[Main\]')   { $mainSection = $true;  continue }
            if ($line -match '^\[')         { $mainSection = $false; continue }
            if ($mainSection -and $line.Trim() -and $line -notmatch '^//') {
                $mainCardsArr += $line.Trim()
            }
        }
        Write-Host ""
        Write-Host "  ----- DECKLIST (mainboard) -----" -ForegroundColor Cyan
        $totalCards = 0
        foreach ($c in $mainCardsArr) {
            Write-Host "    $c"
            if ($c -match '^(\d+)\s') { $totalCards += [int]$matches[1] }
        }
        Write-Host "  ----- TOTAL: $totalCards cartas -----" -ForegroundColor Cyan
        if ($totalCards -ge 60) { Pass "Tamanho >= 60 (Arena legal)" } else { Fail "Tamanho < 60: ILEGAL" }
        $tooManyOk = $true
        $basics = @('Plains','Island','Swamp','Mountain','Forest','Wastes')
        foreach ($c in $mainCardsArr) {
            if ($c -match '^(\d+)\s+(.+)$') {
                $n = [int]$matches[1]; $name = $matches[2].Trim()
                if (($basics -notcontains $name) -and $n -gt 4) {
                    Fail "Mais de 4 copias de '$name' ($n)"; $tooManyOk = $false
                }
            }
        }
        if ($tooManyOk) { Pass "Limite de copias respeitado (max 4 nao-basics)" }
    } else { Warn "Nenhum .dck em $autoArena" }
} else { Warn "Diretorio AutoArena nao existe ($autoArena)" }

# ── FASE 7: pos-match — delta de aprendizado e novo top ─────────────────────
Phase "FASE 7: pos-match — delta de aprendizado"
if ($matchVerdict -in @("win","loss")) {
    $postScript = @"
import os, psycopg2, json, sys
pre = json.loads('''$preMatchSnapshot''')
c = psycopg2.connect(os.environ['DATABASE_URL'], connect_timeout=5); cur=c.cursor()
cur.execute('''SELECT cl.card_name, cl.weight, cl.win_count, cl.loss_count
               FROM card_learning cl JOIN cards ca ON ca.name=cl.card_name
               WHERE ca.is_arena=1''')
post = {r[0]: {'w': float(r[1]), 'wc': int(r[2]), 'lc': int(r[3])} for r in cur.fetchall()}
c.close()
delta_w = 0.0; delta_wins = 0; delta_losses = 0; touched = 0
new_stable = 0
for n, v in post.items():
    if n in pre:
        if v['w'] != pre[n]['w'] or v['wc'] != pre[n]['wc'] or v['lc'] != pre[n]['lc']:
            touched += 1
            delta_w += (v['w'] - pre[n]['w'])
            delta_wins += (v['wc'] - pre[n]['wc'])
            delta_losses += (v['lc'] - pre[n]['lc'])
            if (v['wc']+v['lc']) >= 10 and (pre[n]['wc']+pre[n]['lc']) < 10:
                new_stable += 1
    else:
        if (v['wc']+v['lc']) >= 1: touched += 1
print(f'  Cartas Arena tocadas pela partida : {touched}')
print(f'  Novas wins                        : +{delta_wins}')
print(f'  Novas losses                      : +{delta_losses}')
print(f'  Delta soma peso                   : {delta_w:+.2f}')
print(f'  Cartas que viraram ESTAVEIS agora : +{new_stable}')
"@
    python -c $postScript 2>&1 | ForEach-Object { Write-Host $_ }
} else {
    Info "Sem delta (partida nao aplicou sinal — $matchVerdict)"
}

# ── FASE 8: confirmar uso das sinergias ─────────────────────────────────────
Phase "FASE 8: validar uso de card_synergies no deck do agent"
if ($mainCardsArr.Count -gt 0) {
    $cardListJoined = ($mainCardsArr | ForEach-Object {
        if ($_ -match '^\d+\s+(.+)$') { $matches[1].Trim() }
    }) -join "|"
    $synValidateScript = @"
import os, psycopg2, sys
deck = set('''$cardListJoined'''.split('|'))
deck = {d for d in deck if d}
c = psycopg2.connect(os.environ['DATABASE_URL'], connect_timeout=5); cur=c.cursor()
# pares sinergicos onde AMBOS estao no deck
cur.execute('''SELECT c1.name, c2.name, cs.weight FROM card_synergies cs
               JOIN cards c1 ON c1.id=cs.card1_id
               JOIN cards c2 ON c2.id=cs.card2_id
               WHERE cs.card1_id<>cs.card2_id AND cs.weight > 0
               AND c1.name = ANY(%s) AND c2.name = ANY(%s)
               ORDER BY cs.weight DESC LIMIT 10''', (list(deck), list(deck)))
pairs = cur.fetchall()
print(f'  Pares sinergicos ATIVOS no deck (ambas cartas presentes): {len(pairs)}')
for a, b, w in pairs[:8]:
    print(f'    {a[:28]:28} <-> {b[:28]:28} (w={w:.2f})')
c.close()
"@
    python -c $synValidateScript 2>&1 | ForEach-Object { Write-Host $_ }
} else {
    Warn "Sem deck pra validar."
}

# ── FASE 9: veredito final ──────────────────────────────────────────────────
Phase "FASE 9: veredito final"
$canBuildPlayable =
    ($arenaStable -ge 1500) -and
    ($synArena    -ge 500)  -and
    ($mainCardsArr.Count -ge 1)

$matchSummary = switch ($matchVerdict) {
    "win"           { "Forge -> AGENT VENCEU" }
    "loss"          { "Forge -> AGENT PERDEU" }
    "draw"          { "Forge -> empate" }
    "skipped"       { "Forge -> SKIPPED" }
    "error"         { "Forge -> erro de execucao (ver $matchLog)" }
    default         { "Forge -> indeterminado (ver $matchLog)" }
}

Write-Host ""
Write-Host "  RESUMO:" -ForegroundColor White
Write-Host "    Tier atual                : $tier ($([Math]::Round($coverage,1))% Arena estavel)" -ForegroundColor White
Write-Host "    Pode gerar deck jogavel?  : $(if ($canBuildPlayable) { 'SIM' } else { 'PARCIAL — falta cobertura/sinergia' })" -ForegroundColor White
Write-Host "    Partida                   : $matchSummary" -ForegroundColor White
$rayTotalTsFmt   = '{0:N0}' -f $rayTotalTs
$cardTouchesFmt2 = '{0:N0}' -f $cardTouches
Write-Host "    Ray env_steps totais      : $rayTotalTsFmt" -ForegroundColor White
Write-Host "    Card-touches cumulativos  : $cardTouchesFmt2" -ForegroundColor White
Write-Host "    Sinergias Arena<->Arena   : $synArena pares" -ForegroundColor White

if ($tier -eq "Aprendiz" -or $tier -eq "Iniciante") {
    Write-Host ""
    Write-Host "  PROXIMO PASSO: subir cobertura." -ForegroundColor Yellow
    Write-Host "    npm run teach:arena:12h         # ~70 runs em 12h" -ForegroundColor Yellow
    Write-Host "    .\train.ps1 -BudgetHours 1      # 1h Ray IMPALA pra refinar policy" -ForegroundColor Yellow
} elseif ($tier -eq "Intermediario") {
    Write-Host ""
    Write-Host "  PROXIMO PASSO: refinar pesos." -ForegroundColor Yellow
    Write-Host "    npm run teach:arena:20" -ForegroundColor Yellow
    Write-Host "    npm run calibrate:llm           # ajuste fino via Haiku" -ForegroundColor Yellow
} else {
    Write-Host ""
    Write-Host "  Modelo pronto pra gerar decks Arena consistentes." -ForegroundColor Green
    Write-Host "  Importe o ultimo .dck no MTG Arena online pra teste real." -ForegroundColor Green
}

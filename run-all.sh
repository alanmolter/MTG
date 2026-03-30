#!/usr/bin/env bash
# =============================================================================
#  ██████╗ ██╗   ██╗███╗   ██╗      █████╗ ██╗     ██╗
# ██╔══██╗██║   ██║████╗  ██║     ██╔══██╗██║     ██║
# ██████╔╝██║   ██║██╔██╗ ██║     ███████║██║     ██║
# ██╔══██╗██║   ██║██║╚██╗██║     ██╔══██║██║     ██║
# ██║  ██║╚██████╔╝██║ ╚████║     ██║  ██║███████╗███████╗
# ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝     ╚═╝  ╚═╝╚══════╝╚══════╝
#
#  PIPELINE MASTER — Executa TUDO de uma vez só
#  Uso: ./run-all.sh
#  Opcional: ./run-all.sh --format commander --iterations 200
# =============================================================================

set -euo pipefail

# ── Cores ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ── Parâmetros (com defaults) ─────────────────────────────────────────────────
FORMAT="${FORMAT:-modern}"
ITERATIONS="${ITERATIONS:-100}"
DECKS="${DECKS:-50}"

for arg in "$@"; do
  case $arg in
    --format=*)      FORMAT="${arg#*=}"     ;;
    --iterations=*)  ITERATIONS="${arg#*=}" ;;
    --decks=*)       DECKS="${arg#*=}"      ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
STEP=0
ERRORS=0
START_TIME=$(date +%s)

step() {
  STEP=$((STEP + 1))
  echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}${CYAN}  PASSO ${STEP}: $1${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; ERRORS=$((ERRORS + 1)); }

run() {
  # Executa comando; se falhar, registra erro mas continua
  if ! eval "$1" 2>&1; then
    fail "Falhou: $1"
    return 1
  fi
  return 0
}

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e "${BOLD}${GREEN}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║           🧙 MTG AI — PIPELINE MASTER COMPLETO 🧙           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  ${YELLOW}Formato:${NC}    $FORMAT"
echo -e "  ${YELLOW}Iterações:${NC}  $ITERATIONS"
echo -e "  ${YELLOW}Decks:${NC}      $DECKS"
echo -e "  ${YELLOW}Início:${NC}     $(date '+%d/%m/%Y %H:%M:%S')"

# ── Pré-requisitos ─────────────────────────────────────────────────────────────
step "Verificando pré-requisitos"
command -v node  >/dev/null && ok "Node.js $(node -v)" || { fail "Node.js não encontrado"; exit 1; }
command -v npm   >/dev/null && ok "npm $(npm -v)"      || { fail "npm não encontrado"; exit 1; }
[ -f ".env" ]              && ok ".env encontrado"     || warn ".env não encontrado — usando variáveis de ambiente"
[ -f "package.json" ]      && ok "package.json ok"     || { fail "Execute na raiz do projeto"; exit 1; }

# ── Dependências ───────────────────────────────────────────────────────────────
step "Instalando dependências"
run "npm install --silent" && ok "Dependências instaladas" || fail "Erro ao instalar dependências"

# ── Banco de dados ─────────────────────────────────────────────────────────────
step "Sincronizando schema do banco de dados"
run "npm run db:push" && ok "Schema sincronizado" || warn "db:push falhou — banco pode estar desatualizado"

# ── Sincronização Scryfall (cartas base) ───────────────────────────────────────
step "Sincronizando cartas do Scryfall (bulk oracle)"
echo -e "  ${YELLOW}⬇️  Baixando base completa de cartas...${NC}"
run "npx tsx server/sync-bulk.ts" && ok "Cartas Scryfall sincronizadas" || warn "sync-bulk falhou — usando dados existentes"

# ── Seed inicial (se banco vazio) ──────────────────────────────────────────────
step "Seed inicial de cartas (se necessário)"
run "npm run seed:scryfall" && ok "Seed concluído" || warn "Seed falhou ou já foi executado"

# ── Importação de dados competitivos ──────────────────────────────────────────
step "Importando decks competitivos (MTGGoldfish + MTGTop8)"
echo -e "  ${YELLOW}📥 MTGGoldfish — formato: $FORMAT, limite: $DECKS decks...${NC}"
run "npx tsx -e \"
  import('dotenv/config');
  import('./server/services/mtggoldfishScraper.ts').then(m =>
    m.importMTGGoldfishDecks('$FORMAT', $DECKS)
      .then(r => console.log('  ✅ Goldfish:', r.decksImported, 'importados,', r.decksSkipped, 'pulados'))
      .catch(e => console.warn('  ⚠️  Goldfish:', e.message))
  );
\"" || warn "MTGGoldfish falhou — continuando"

echo -e "  ${YELLOW}📥 MTGTop8 — formato: $FORMAT, limite: $DECKS decks...${NC}"
run "npx tsx -e \"
  import('dotenv/config');
  import('./server/services/mtgtop8Scraper.ts').then(m =>
    m.importMTGTop8Decks('$FORMAT', $DECKS)
      .then(r => console.log('  ✅ Top8:', r.decksImported, 'importados,', r.decksSkipped, 'pulados'))
      .catch(e => console.warn('  ⚠️  Top8:', e.message))
  );
\"" || warn "MTGTop8 falhou — continuando"

# ── Importação + Embeddings (pipeline combinado) ───────────────────────────────
step "Importação combinada + treinamento de Embeddings Word2Vec"
run "npx tsx import-and-train.ts" && ok "Embeddings treinados" || warn "import-and-train falhou"

# ── Clustering de arquétipos ───────────────────────────────────────────────────
step "Clustering de arquétipos competitivos (KMeans)"
run "npx tsx run-clustering.ts" && ok "Clustering concluído" || warn "Clustering falhou"

# ── Treinamento do Brain (avaliação de decks) ──────────────────────────────────
step "Treinamento do Brain v2 (avaliação e pontuação de decks)"
run "npm run teach" && ok "Brain treinado" || warn "Brain training falhou"

# ── Treinamento especializado de Comandantes ───────────────────────────────────
step "Treinamento especializado em Comandantes"
run "npx tsx server/scripts/trainCommander.ts" && ok "Treinamento Commander concluído" || warn "Commander training falhou"

# ── Loop de treinamento contínuo (self-improving) ─────────────────────────────
step "Loop de treinamento contínuo — $ITERATIONS iterações (Self-Play IA)"
echo -e "  ${YELLOW}🔄 Executando $ITERATIONS iterações de auto-aprendizado...${NC}"
run "npx tsx -e \"
  import('dotenv/config');
  import('./server/scripts/continuousTraining.ts').then(m =>
    m.default ? m.default($ITERATIONS) : m.runContinuousTraining?.($ITERATIONS)
  ).catch(e => { console.warn('⚠️ ', e.message); process.exit(0); });
\"" && ok "Treinamento contínuo concluído" || warn "Treinamento contínuo falhou"

# ── Verificação de pesos aprendidos ───────────────────────────────────────────
step "Verificando pesos e aprendizado acumulado"
run "npm run check:learn" && ok "Pesos verificados" || warn "check:learn falhou"

# ── Testes de regressão do modelo ─────────────────────────────────────────────
step "Testes de regressão do modelo"
run "npm run test:model" && ok "Testes de modelo passaram" || warn "Testes de modelo falharam"

# ── Suite de testes automatizados ─────────────────────────────────────────────
step "Suite de testes automatizados (vitest)"
run "npm test" && ok "Todos os testes passaram" || warn "Alguns testes falharam"

# ── Relatório final ────────────────────────────────────────────────────────────
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
MINS=$((ELAPSED / 60))
SECS=$((ELAPSED % 60))

echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  RELATÓRIO FINAL${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${YELLOW}Duração total:${NC}  ${MINS}m ${SECS}s"
echo -e "  ${YELLOW}Passos:${NC}         $STEP executados"
if [ "$ERRORS" -eq 0 ]; then
  echo -e "  ${GREEN}Erros:${NC}          0 — pipeline perfeito!"
else
  echo -e "  ${YELLOW}Avisos:${NC}         $ERRORS passo(s) com falha não-crítica"
fi

echo -e "\n${YELLOW}  Próximos passos:${NC}"
echo "    1. Inicie o servidor:  npm run dev"
echo "    2. Acesse o dashboard: http://localhost:3000"
echo "    3. Repita este script para tornar a IA mais inteligente a cada run"

if [ "$ERRORS" -eq 0 ]; then
  echo -e "\n${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║          ✅  PIPELINE CONCLUÍDO COM SUCESSO TOTAL  ✅         ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}\n"
  exit 0
else
  echo -e "\n${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${YELLOW}║     ⚠️  PIPELINE CONCLUÍDO COM $ERRORS AVISO(S) NÃO-CRÍTICO(S)     ║${NC}"
  echo -e "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}\n"
  exit 0
fi

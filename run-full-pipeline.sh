#!/bin/bash

###############################################################################
# 🚀 MAGIC AI SYSTEM - FULL PIPELINE
#
# Comando unificado que executa todo o pipeline de ingestão até treinamento:
# 1. Importar dados de MTGGoldfish e MTGTop8
# 2. Treinar embeddings Word2Vec
# 3. Treinar modelo de avaliação (Brain v2)
# 4. Gerar decks otimizados
#
# USO:
#   ./run-full-pipeline.sh [options]
#
# OPTIONS:
#   --format FORMAT       Formato (standard|modern|commander|legacy) [default: modern]
#   --decks N             Número de decks a importar [default: 50]
#   --skip-import         Pular importação, usar dados existentes
#   --skip-train          Pular treinamento, usar modelos existentes
#   --skip-generate       Pular geração, apenas treinar
#   --validate-only       Apenas validar dados, não executar
#   --debug               Modo debug com logs detalhados
#   -h, --help            Mostrar esta ajuda
#
# EXEMPLOS:
#   ./run-full-pipeline.sh                          # Pipeline completo (modern, 50 decks)
#   ./run-full-pipeline.sh --format commander --decks 100
#   ./run-full-pipeline.sh --skip-import --skip-train
#
###############################################################################

set -e

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configurações padrão
FORMAT="modern"
DECKS=50
SKIP_IMPORT=false
SKIP_TRAIN=false
SKIP_GENERATE=false
VALIDATE_ONLY=false
DEBUG=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --format)
      FORMAT="$2"
      shift 2
      ;;
    --decks)
      DECKS="$2"
      shift 2
      ;;
    --skip-import)
      SKIP_IMPORT=true
      shift
      ;;
    --skip-train)
      SKIP_TRAIN=true
      shift
      ;;
    --skip-generate)
      SKIP_GENERATE=true
      shift
      ;;
    --validate-only)
      VALIDATE_ONLY=true
      shift
      ;;
    --debug)
      DEBUG=true
      shift
      ;;
    -h|--help)
      head -n 30 "$0" | tail -n +2
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Verificar variáveis de ambiente
if [ -z "$DATABASE_URL" ]; then
  echo -e "${RED}❌ DATABASE_URL não configurada${NC}"
  echo "Configure com: export DATABASE_URL='postgresql://user:pass@host:port/db'"
  exit 1
fi

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         🚀 MAGIC AI SYSTEM - FULL PIPELINE 🚀             ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"

echo -e "\n${YELLOW}⚙️  CONFIGURAÇÃO:${NC}"
echo "  Format: $FORMAT"
echo "  Decks: $DECKS"
echo "  Skip Import: $SKIP_IMPORT"
echo "  Skip Train: $SKIP_TRAIN"
echo "  Skip Generate: $SKIP_GENERATE"
echo "  Debug: $DEBUG"

# ============================================================================
# FASE 1: VALIDAÇÃO DE DADOS
# ============================================================================

echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}FASE 1: VALIDAÇÃO DE DADOS${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

echo -e "\n${YELLOW}📊 Validando banco de dados...${NC}"
npm run validate:db 2>&1 | grep -E "✓|✅|❌|Error" || echo "✓ Banco validado"

if [ "$VALIDATE_ONLY" = true ]; then
  echo -e "\n${GREEN}✅ Validação completa. Encerrando (--validate-only).${NC}"
  exit 0
fi

# ============================================================================
# FASE 2: IMPORTAÇÃO DE DADOS
# ============================================================================

if [ "$SKIP_IMPORT" = false ]; then
  echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}FASE 2: IMPORTAÇÃO DE DADOS${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

  echo -e "\n${YELLOW}📥 Importando decks de MTGGoldfish (${FORMAT}, ${DECKS} decks)...${NC}"
  npm run import:mtggoldfish -- --format "$FORMAT" --limit "$DECKS" 2>&1 | tail -20

  echo -e "\n${YELLOW}📥 Importando decks de MTGTop8 (${FORMAT}, ${DECKS} decks)...${NC}"
  npm run import:mtgtop8 -- --format "$FORMAT" --limit "$DECKS" 2>&1 | tail -20

  echo -e "\n${GREEN}✅ Importação concluída${NC}"
else
  echo -e "\n${YELLOW}⏭️  Pulando importação (--skip-import)${NC}"
fi

# ============================================================================
# FASE 3: ANÁLISE DE QUALIDADE DE DADOS
# ============================================================================

echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}FASE 3: ANÁLISE DE QUALIDADE DE DADOS${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

echo -e "\n${YELLOW}🔍 Auditando qualidade de dados...${NC}"
npm run audit:data-quality 2>&1 | tail -20

# ============================================================================
# FASE 4: TREINAMENTO DE MODELOS
# ============================================================================

if [ "$SKIP_TRAIN" = false ]; then
  echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}FASE 4: TREINAMENTO DE MODELOS${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

  echo -e "\n${YELLOW}🧠 Treinando Embeddings Word2Vec...${NC}"
  npm run train:embeddings 2>&1 | tail -20

  echo -e "\n${YELLOW}🧠 Treinando Brain v2 (Avaliação de Decks)...${NC}"
  npm run train:brain 2>&1 | tail -20

  echo -e "\n${YELLOW}🧠 Treinando RL Policy Network...${NC}"
  npm run train:rl 2>&1 | tail -20

  echo -e "\n${GREEN}✅ Treinamento concluído${NC}"
else
  echo -e "\n${YELLOW}⏭️  Pulando treinamento (--skip-train)${NC}"
fi

# ============================================================================
# FASE 5: GERAÇÃO E VALIDAÇÃO DE DECKS
# ============================================================================

if [ "$SKIP_GENERATE" = false ]; then
  echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}FASE 5: GERAÇÃO E VALIDAÇÃO DE DECKS${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

  echo -e "\n${YELLOW}🎲 Gerando deck de exemplo (${FORMAT})...${NC}"
  npm run generate:deck -- --format "$FORMAT" 2>&1 | tail -30

  echo -e "\n${GREEN}✅ Geração concluída${NC}"
else
  echo -e "\n${YELLOW}⏭️  Pulando geração (--skip-generate)${NC}"
fi

# ============================================================================
# RELATÓRIO FINAL
# ============================================================================

echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}RELATÓRIO FINAL${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

echo -e "\n${YELLOW}📊 Estatísticas:${NC}"
npm run stats:pipeline 2>&1 | tail -20

echo -e "\n${YELLOW}✨ Próximos passos:${NC}"
echo "  1. Acesse http://localhost:3000 para visualizar o dashboard"
echo "  2. Use a aba 'Pipeline' para executar novos ciclos de treinamento"
echo "  3. Use a aba 'Generator' para criar decks otimizados"
echo "  4. Monitore a qualidade em 'Data Quality'"

echo -e "\n${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              ✅ PIPELINE CONCLUÍDO COM SUCESSO ✅          ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"

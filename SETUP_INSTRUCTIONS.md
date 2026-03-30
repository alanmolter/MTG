# 🚀 SETUP COMPLETO - Magic AI System

**Última atualização**: 2025-03-30  
**Status**: ✅ PRONTO PARA EXECUÇÃO

---

## 📋 Pré-requisitos

- ✅ Node.js 22.13.0+
- ✅ npm ou pnpm
- ✅ PostgreSQL 14+ rodando em `192.168.56.1:5432`
- ✅ Database `MTG` criado
- ✅ Usuário `postgres` com senha `alan7474`

---

## 🔧 SETUP RÁPIDO (5 minutos)

### 1. Instalar Dependências

```bash
cd /tmp/MTG
npm install
# ou
pnpm install
```

### 2. Verificar Conexão com Banco

```bash
# Testar conexão
npm run test:db-connection

# Esperado:
# ✓ Connected to PostgreSQL
# ✓ Database: MTG
# ✓ Tables: 15
```

### 3. Executar Migrações

```bash
npm run migrate
```

### 4. Executar Pipeline Completo

```bash
./run-full-pipeline.sh
```

---

## 📊 VARIÁVEIS DE AMBIENTE

Arquivo `.env` já configurado:

```env
DATABASE_URL=postgresql://postgres:alan7474@192.168.56.1:5432/MTG
OAUTH_SERVER_URL=http://localhost:3000
JWT_SECRET=your-secret-key-here
VITE_APP_ID=mtg-deck-mvp
FORGE_API_URL=http://localhost:8088
```

---

## 🚀 EXECUTAR PIPELINE

### Opção 1: Pipeline Completo (Recomendado)

```bash
./run-full-pipeline.sh
```

**Fases executadas**:
1. ✅ Validação de dados
2. ✅ Importação (MTGGoldfish + MTGTop8)
3. ✅ Análise de qualidade
4. ✅ Treinamento (Embeddings + Brain + RL)
5. ✅ Geração e validação de decks
6. ✅ Relatório final

**Tempo estimado**: 2-5 minutos

### Opção 2: Pipeline com Opções Customizadas

```bash
# Commander format, 100 decks
./run-full-pipeline.sh --format commander --decks 100

# Pular importação (usar dados existentes)
./run-full-pipeline.sh --skip-import

# Apenas treinar (sem importação nem geração)
./run-full-pipeline.sh --skip-import --skip-generate

# Apenas validar dados (sem executar)
./run-full-pipeline.sh --validate-only

# Debug mode com logs detalhados
./run-full-pipeline.sh --debug
```

### Opção 3: Executar Etapas Individuais

```bash
# 1. Importar dados
npm run import:mtggoldfish -- --format modern --limit 50
npm run import:mtgtop8 -- --format modern --limit 50

# 2. Treinar embeddings
npm run train:embeddings

# 3. Treinar Brain v2
npm run train:brain

# 4. Treinar RL
npm run train:rl

# 5. Gerar deck
npm run generate:deck -- --format modern

# 6. Analisar qualidade
npm run audit:data-quality
```

---

## 📊 MONITORAR EXECUÇÃO

### Logs em Tempo Real

```bash
# Terminal 1: Executar pipeline
./run-full-pipeline.sh

# Terminal 2: Monitorar logs
tail -f logs/pipeline.log
```

### Métricas de Progresso

```bash
# Ver estatísticas
npm run stats:pipeline

# Ver status do banco
npm run stats:db

# Ver modelos treinados
npm run stats:models
```

---

## 🧪 TESTES

### Executar Testes de Correções Críticas

```bash
npm run test:critical-fixes

# Esperado:
# ✓ Dimensionalidade validada
# ✓ Race condition eliminada
# ✓ RL retroalimentação funcionando
# ✓ Políticas documentadas
# ✓ JSON validado com hash
# ✓ Fallback sintético marcado
```

### Executar Todos os Testes

```bash
npm test
```

### Testes Específicos

```bash
# Testes de banco de dados
npm run test:db

# Testes de embeddings
npm run test:embeddings

# Testes de Brain
npm run test:brain

# Testes de RL
npm run test:rl
```

---

## 📈 VALIDAÇÕES FINAIS

### 1. Verificar Dados Importados

```bash
npm run stats:db

# Esperado:
# Cards: 5000+
# Competitive Decks: 1000+
# Embeddings: 5000+
```

### 2. Verificar Qualidade de Dados

```bash
npm run audit:data-quality

# Esperado:
# Total decks: 1050
# Synthetic: 50 (4.8%)
# Avg confidence: 0.98
# Status: ✅ EXCELENTE
```

### 3. Gerar Deck de Teste

```bash
npm run generate:deck -- --format modern

# Esperado:
# Format: Modern
# Cards: 60
# Mana Curve: ✓ Balanced
# Synergy Score: 0.85+
```

### 4. Verificar Modelos Treinados

```bash
npm run stats:models

# Esperado:
# Embeddings: ✓ Treinado
# Brain v2: ✓ Treinado
# RL Policy: ✓ Treinado
```

---

## 🐛 TROUBLESHOOTING

### Erro: "Connection refused"

**Problema**: PostgreSQL não está acessível em `192.168.56.1:5432`

**Solução**:
1. Verifique se PostgreSQL está rodando no seu PC
2. Verifique o firewall (porta 5432 aberta)
3. Verifique se o IP está correto: `ipconfig` (Windows) ou `ifconfig` (Linux/Mac)
4. Atualize `DATABASE_URL` em `.env`

```bash
# Testar conexão
psql "postgresql://postgres:alan7474@192.168.56.1:5432/MTG" -c "SELECT 1;"
```

### Erro: "Database does not exist"

**Problema**: Database `MTG` não foi criado

**Solução**:
```bash
# Criar database
psql "postgresql://postgres:alan7474@192.168.56.1:5432/postgres" -c "CREATE DATABASE MTG;"

# Ou usar pgAdmin no seu PC
```

### Erro: "Permission denied"

**Problema**: Usuário `postgres` sem permissões

**Solução**:
```bash
# No seu PC, no PostgreSQL:
ALTER USER postgres WITH PASSWORD 'alan7474';
GRANT ALL PRIVILEGES ON DATABASE MTG TO postgres;
```

### Erro: "Out of memory"

**Problema**: Treinamento de embeddings usa muita memória

**Solução**:
```bash
# Reduzir número de decks
./run-full-pipeline.sh --decks 20

# Ou treinar em etapas
./run-full-pipeline.sh --skip-train
npm run train:embeddings  # Separadamente
```

### Erro: "Timeout"

**Problema**: Operação levando muito tempo

**Solução**:
```bash
# Aumentar timeout em .env
TIMEOUT=300000  # 5 minutos

# Ou executar etapas separadamente
./run-full-pipeline.sh --skip-import --skip-generate
```

---

## 📁 ESTRUTURA DE ARQUIVOS

```
/tmp/MTG/
├── .env                              # Configuração (DATABASE_URL)
├── run-full-pipeline.sh              # 🚀 COMANDO PRINCIPAL
├── SETUP_INSTRUCTIONS.md             # Este arquivo
├── CRITICAL_FIXES_APPLIED.md         # Resumo de correções
│
├── server/
│   ├── ml/
│   │   └── config.py                 # Correção 1: Dimensionalidade
│   ├── services/
│   │   ├── cardLearningQueue.ts       # Correção 2: Race condition
│   │   ├── rlToCardLearningBridge.ts  # Correção 3: RL retroalimentação
│   │   ├── competitiveLearningBridge.ts # Correção 5: Validação JSON
│   │   └── dataQualityMonitor.ts      # Correção 6: Fallback sintético
│   ├── routers.ts                    # Modificado: Moxfield removido
│   └── db.ts                         # Conexão com PostgreSQL
│
├── client/
│   └── src/pages/
│       └── Pipeline.tsx              # Modificado: Moxfield removido
│
├── drizzle/
│   └── schema.ts                     # Modificado: default source alterado
│
└── package.json                      # Scripts npm
```

---

## 🔄 FLUXO DE EXECUÇÃO

```
┌─────────────────────────────────────────────────────────┐
│  ./run-full-pipeline.sh                                 │
└─────────────────────────────────────────────────────────┘
                          ↓
        ┌─────────────────────────────────────┐
        │ FASE 1: Validação de Dados          │
        │ - Verificar banco                   │
        │ - Verificar tabelas                 │
        └─────────────────────────────────────┘
                          ↓
        ┌─────────────────────────────────────┐
        │ FASE 2: Importação                  │
        │ - MTGGoldfish (50 decks)            │
        │ - MTGTop8 (50 decks)                │
        └─────────────────────────────────────┘
                          ↓
        ┌─────────────────────────────────────┐
        │ FASE 3: Análise de Qualidade        │
        │ - Verificar dados sintéticos        │
        │ - Calcular confiança                │
        └─────────────────────────────────────┘
                          ↓
        ┌─────────────────────────────────────┐
        │ FASE 4: Treinamento                 │
        │ - Embeddings Word2Vec               │
        │ - Brain v2                          │
        │ - RL Policy Network                 │
        └─────────────────────────────────────┘
                          ↓
        ┌─────────────────────────────────────┐
        │ FASE 5: Geração de Decks            │
        │ - Gerar deck de exemplo             │
        │ - Validar estrutura                 │
        │ - Exportar                          │
        └─────────────────────────────────────┘
                          ↓
        ┌─────────────────────────────────────┐
        │ FASE 6: Relatório Final             │
        │ - Estatísticas                      │
        │ - Próximos passos                   │
        └─────────────────────────────────────┘
```

---

## 📞 SUPORTE

### Documentação Referência

- **Correções Críticas**: `CRITICAL_FIXES_APPLIED.md`
- **Políticas de Aprendizado**: `LEARNING_POLICIES_QUICK_REFERENCE.md`
- **Arquitetura**: `ARCHITECTURE.md`
- **Brain v2**: `DECK_EVALUATION_BRAIN.md`

### Comandos Úteis

```bash
# Ver ajuda do pipeline
./run-full-pipeline.sh -h

# Ver logs
tail -f logs/pipeline.log

# Ver status
npm run stats:pipeline

# Resetar banco (CUIDADO!)
npm run reset:db

# Limpar cache
npm run clean
```

---

## ✨ PRÓXIMOS PASSOS

### Imediato:
1. ✅ Verificar conexão com PostgreSQL
2. ✅ Executar `./run-full-pipeline.sh`
3. ✅ Verificar logs e métricas

### Curto Prazo:
1. Integrar em CI/CD
2. Adicionar monitoramento
3. Treinar com mais dados

### Médio Prazo:
1. Otimizar performance
2. Implementar caching
3. Adicionar mais fontes

---

## 🎯 RESUMO

✅ **Setup completo em 5 minutos**  
✅ **Pipeline unificado pronto**  
✅ **Todas as correções aplicadas**  
✅ **Validações incluídas**  

**Status**: 🟢 **PRONTO PARA EXECUÇÃO**

---

**Criado em**: 2025-03-30  
**Versão**: 1.0  
**Mantido por**: Magic AI System

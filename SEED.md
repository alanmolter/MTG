# 🎴 Scryfall Seed - Carregamento de Dados Iniciais

Este script popula o banco de dados com cartas reais do Magic: The Gathering obtidas da [Scryfall API](https://scryfall.com/docs/api).

## ⚙️ Pré-requisitos

- PostgreSQL rodando localmente
- Banco de dados `MTG` criado e configurado
- Arquivo `.env` com `DATABASE_URL` configurada
- Tabelas criadas via `npm run db:push`

## 🚀 Como executar

### Opção 1: Via npm script
```bash
npm run seed:scryfall
```

### Opção 2: Direto com tsx
```bash
DATABASE_URL=postgresql://postgres:alan7474@localhost:5432/MTG npx tsx server/seed-scryfall.ts
```

Em PowerShell:
```powershell
$env:DATABASE_URL='postgresql://postgres:alan7474@localhost:5432/MTG'
npx tsx server/seed-scryfall.ts
```

## 📊 O que é carregado

O script carrega cartas de MTG Modern legalizadas como **criaturaseterrenos**:

- **Fonte**: Scryfall API via query `legal:modern is:permanent type:creature`
- **Limite**: Primeiras 5 páginas (~875 cartas)
- **Campos carregados**:
  - `scryfallId` - ID único do Scryfall
  - `name` - Nome da carta
  - `type` - Tipo de carta
  - `colors` - Cores (W, U, B, R, G)
  - `cmc` - Custo de mana convertido
  - `rarity` - Raridade (common, uncommon, rare, mythic)
  - `imageUrl` - URL da imagem
  - `power/toughness` - Para criaturas
  - `text` - Texto do oráculo

## 📈 Progresso

Durante a execução, você verá:

```
🚀 Iniciando seed de dados do Scryfall
============================================================

📥 Buscando página 1...
   Found 175 cards...
   ✅ 50 cards imported...
   ✅ 100 cards imported...
   ...

📊 Resultado Final:
============================================================
✅ Importadas:  875
⏭️  Puladas:     0

📈 Total de cartas no banco: 875

✨ Seed concluído!
```

## 🔧 Customização

Para modificar o comportamento, edite `server/seed-scryfall.ts`:

### Aumentar limite de cartas
```typescript
const maxPages = 10; // Aumentar de 5 para 10
```

### Mudar query de Scryfall
```typescript
const query = "legal:standard type:creature"; // Buscar Standard ao invés de Modern
```

### Adicionar filtros
```typescript
const query = "legal:modern is:permanent type:creature color:U"; // Apenas azul
```

## 🎯 Queries úteis do Scryfall

- `legal:standard` - Cartas legalizadas em Standard
- `legal:modern` - Cartas legalizadas em Modern
- `legal:commander` - Cartas legalizadas em Commander
- `type:creature` - Apenas criaturas
- `type:instant,sorcery` - Mágicas instantâneas e de feitiço
- `color:W` - Apenas brancas (U=azul, B=preto, R=vermelho, G=verde)
- `rarity:rare,mythic` - Apenas raras e míticas
- `is:permanent` - Apenas permanentes

Veja mais em: https://scryfall.com/docs/reference

## 🐛 Troubleshooting

### "Não conseguiu conectar ao banco de dados"
- Verifique se PostgreSQL está rodando
- Confirme que o banco `MTG` existe
- Teste a conexão: `npm run test-db-connection.js` (após criar o script)

### "Importadas: 0"
- Verifique se há cartas com imagem no Scryfall
- Aumente `maxPages` ou mude a query
- Verifique os erros na lista de primeiros erros

### Cartas estão sendo puladas
- Muitas cartas do Scryfall não têm imagem principal
- Use `is:permanent` e `type:creature` para melhor cobertura

## 📚 Próximas etapas

Após popular as cartas, você pode:

1. **Treinar embeddings**
   ```bash
   npm run train:embeddings
   ```

2. **Gerar deck**
   - Acesse a página do gerador de deck no frontend

3. **Sincronizar decks competitivos**
   ```bash
   npm run seed:competitive-decks
   ```

## 📜 Referências

- [Scryfall API Documentation](https://scryfall.com/docs/api)
- [MTG Formats](https://magic.wizards.com/en/formats)
- [Projeto GitHub](..)

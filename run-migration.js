import postgres from 'postgres';
import { readFileSync } from 'fs';

const sql = postgres('postgresql://postgres:alan7474@localhost:5432/MTG');
const migrationSql = readFileSync('drizzle/0003_postgres_init.sql', 'utf8');

(async () => {
  try {
    console.log('🚀 Executando migração...');
    
    // Split SQL by semicolon and execute each statement
    const statements = migrationSql.split(';').filter(s => s.trim());
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
    
    console.log('✅ Migração concluída com sucesso!');
    
    // Verify tables
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`;
    console.log('📊 Tabelas criadas:', tables.map(t => t.table_name).join(', '));
    
    await sql.end();
  } catch(e) {
    console.log('❌ Erro:', e.message);
    console.log(e);
  }
})();

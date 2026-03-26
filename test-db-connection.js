import postgres from 'postgres';

async function testConnection() {
  const connStr = 'postgresql://postgres:alan7474@localhost:5432/MTG';
  
  try {
    console.log(`\n🔗 Testando conexão: ${connStr}`);
    const sql = postgres(connStr);
    
    // Test connection
    const result = await sql`SELECT NOW()`;
    console.log('✅ Conectado com sucesso!');
    console.log('⏰ Hora do servidor:', result[0].now);
    
    // List tables
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`;
    console.log('📊 Tabelas no database:');
    if (tables.length === 0) {
      console.log('   (nenhuma tabela encontrada)');
    } else {
      tables.forEach(t => console.log(`   - ${t.table_name}`));
    }
    
    // Get table details
    const tableCount = await sql`SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema='public'`;
    console.log(`\n📈 Total de tabelas: ${tableCount[0].count}`);
    
    // Check specific tables
    const specificTables = ['cards', 'decks', 'competitive_decks', 'synergies'];
    console.log('\n🔍 Procurando tabelas do projeto:');
    for (const tname of specificTables) {
      const exists = await sql`SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=${tname})`;
      console.log(`   ${exists[0].exists ? '✅' : '❌'} ${tname}`);
    }
    
    await sql.end();
  } catch (error) {
    console.log('❌ Erro:', error.message);
  }
}

testConnection();

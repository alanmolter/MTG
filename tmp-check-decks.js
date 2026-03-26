import postgres from 'postgres';

async function checkCount() {
  const connStr = 'postgresql://postgres:alan7474@localhost:5432/MTG';
  const sql = postgres(connStr);
  try {
    const result = await sql`SELECT COUNT(*) as count FROM competitive_decks`;
    console.log(`Total competitive decks: ${result[0].count}`);
  } catch (error) {
    console.error(error);
  } finally {
    await sql.end();
  }
}

checkCount();

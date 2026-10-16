import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Novas migrações recebem prefixo de timestamp (ex.: 20261016230312_nome.sql)
  // para não colidir com os arquivos históricos 0003–0010, cujo número não
  // coincide com o idx do journal. Ver docs/migrations.md.
  migrations: {
    prefix: "timestamp",
    table: "__drizzle_migrations",
    schema: "drizzle",
  },
  dbCredentials: {
    url: connectionString,
  },
});

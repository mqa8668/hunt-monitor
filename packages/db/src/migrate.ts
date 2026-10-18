import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export async function migrate(databaseUrl?: string): Promise<void> {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (see .env.example)");
  // onnotice: "IF NOT EXISTS" notices must not leak to stdout.
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await drizzleMigrate(drizzle(sql), { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  await migrate();
  console.info("migrate: done");
}

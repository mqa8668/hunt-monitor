import { defineConfig } from "drizzle-kit";

// No fallback URL: fail fast when DATABASE_URL is unset.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required (see .env.example)");

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url },
});

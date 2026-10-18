import { schema, type DbHandle } from "@hunt-monitor/db";
import { desc, eq } from "drizzle-orm";

/** Current value of a config key (the row with the highest version), or undefined when unset. */
async function currentValue(handle: DbHandle, key: string): Promise<unknown> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, key))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return row?.value;
}

export async function configNumber(handle: DbHandle, key: string, fallback: number): Promise<number> {
  const v = await currentValue(handle, key);
  return typeof v === "number" ? v : fallback;
}

export async function configBool(handle: DbHandle, key: string, fallback: boolean): Promise<boolean> {
  const v = await currentValue(handle, key);
  return typeof v === "boolean" ? v : fallback;
}

export async function configString(handle: DbHandle, key: string, fallback: string): Promise<string> {
  const v = await currentValue(handle, key);
  return typeof v === "string" ? v : fallback;
}

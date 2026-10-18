import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Release version: `APP_VERSION` when set, else the root package.json version, else "dev". */
export function appVersion(
  env: Record<string, string | undefined> = process.env,
  packageFile: string = join(import.meta.dir, "..", "..", "..", "package.json"),
): string {
  const fromEnv = env.APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    const v = (JSON.parse(readFileSync(packageFile, "utf8")) as { version?: unknown }).version;
    if (typeof v === "string" && v !== "") return v;
  } catch {
    // No readable package.json: fall through.
  }
  return "dev";
}

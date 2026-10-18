import { describe, expect, test } from "bun:test";

const entry = new URL("./index.ts", import.meta.url).pathname;

async function hunt(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, NO_COLOR: "1" } as Record<string, string>;
  delete env.DATABASE_URL;
  const p = Bun.spawn(["bun", entry, ...args], { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

describe("hunt", () => {
  test("match --dry-run on the bundled sample prints matches and needs no database", async () => {
    const r = await hunt("match", "--dry-run", "--json");
    expect(r.code).toBe(0);
    const posts = (JSON.parse(r.stdout) as { posts: { kind: string }[] }).posts;
    expect(posts.some((p) => p.kind === "match")).toBe(true);
    expect(posts.some((p) => p.kind === "repost")).toBe(true);
  });

  test("a custom watch narrows the result", async () => {
    const r = await hunt("match", "--dry-run", "--watch", "road bike size 54 <$700");
    expect(r.stdout).toContain("road bike size 54 <$700");
    expect(r.stdout).not.toContain("iphone 15 pro");
  });

  test("help is plain text and lists the commands", async () => {
    const r = await hunt("--help");
    expect(r.code).toBe(0);
    for (const c of ["source add", "watch add", "match --dry-run", "demo"]) expect(r.stdout).toContain(c);
    expect(r.stdout).not.toContain("\u001b");
  });

  test("an unknown command fails with a hint", async () => {
    const r = await hunt("nope");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("hunt --help");
  });

  test("database commands without DATABASE_URL say what to do", async () => {
    const r = await hunt("source", "list");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL");
  });
});

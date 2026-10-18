import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appVersion } from "./version";

const pkg = (content: string): string => {
  const file = join(mkdtempSync(join(tmpdir(), "appversion-")), "package.json");
  writeFileSync(file, content);
  return file;
};

describe("appVersion", () => {
  test("APP_VERSION wins", () => {
    expect(appVersion({ APP_VERSION: " v9.9.9 " }, pkg('{"version":"1.2.3"}'))).toBe("v9.9.9");
  });
  test("falls back to package.json", () => {
    expect(appVersion({}, pkg('{"version":"1.2.3"}'))).toBe("1.2.3");
  });
  test("dev when nothing is readable", () => {
    expect(appVersion({}, pkg("not json"))).toBe("dev");
    expect(appVersion({}, "/nonexistent/package.json")).toBe("dev");
  });
});

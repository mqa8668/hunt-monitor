import { describe, expect, test } from "bun:test";
import { parseRobots, robotsFromResponse } from "./robots";

describe("robots", () => {
  const txt = "User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: hunt-monitor\nDisallow: /feeds/secret$\n";

  test("own group wins over the wildcard group", () => {
    const r = parseRobots(txt, "hunt-monitor");
    expect(r.allowed("/private/x")).toBe(true);
    expect(r.allowed("/feeds/secret")).toBe(false);
    expect(r.allowed("/feeds/secret2")).toBe(true);
  });

  test("wildcard group, longest match, and Allow beats Disallow on a tie", () => {
    const r = parseRobots(txt, "other-bot");
    expect(r.allowed("/private/x")).toBe(false);
    expect(r.allowed("/private/ok")).toBe(true);
    expect(r.allowed("/public")).toBe(true);
  });

  test("status handling: 2xx parsed, 4xx allows all, 5xx and network failure block", () => {
    expect(robotsFromResponse(404, "", "x").allowed("/a")).toBe(true);
    expect(robotsFromResponse(503, "", "x").allowed("/a")).toBe(false);
    expect(robotsFromResponse(null, "", "x").allowed("/a")).toBe(false);
    expect(robotsFromResponse(200, "User-agent: *\nDisallow: /", "x").allowed("/a")).toBe(false);
  });
});

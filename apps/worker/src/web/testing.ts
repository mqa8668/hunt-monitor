import { readFileSync } from "node:fs";

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

export interface TestServer {
  url: string;
  hits: string[];
  stop(): void;
}

/** A local HTTP server for tests: `routes` maps a path to a Response (or a function that builds one). Never touches the internet. */
export function startServer(routes: Record<string, Response | ((req: Request) => Response | Promise<Response>)>): TestServer {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      hits.push(u.pathname + u.search);
      const r = routes[u.pathname];
      if (!r) return new Response("not found", { status: 404 });
      return (typeof r === "function" ? await r(req) : r.clone()) as never;
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => void server.stop(true) };
}

import { fetchCalls } from "./src/sf";
import { Jev } from "./src/jev";

type Env = { JEV_API_KEY: string; ASSETS: { fetch: (request: Request) => Promise<Response> } };

let jev: Jev | undefined;

// The page never sees the key or talks to the city directly: this proxies both,
// caching the call feed for ten minutes since the city loads data once a day.
export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/calls") {
      const since = Number(url.searchParams.get("since") ?? Date.now() - 48 * 3600_000);
      const key = new Request(`${url.origin}/api/calls?since=${Math.floor(since / 600_000)}`);
      const cache = (caches as unknown as { default: Cache }).default;
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        const calls = await fetchCalls(since);
        const response = Response.json({ calls, fetchedAt: Date.now() }, { headers: { "cache-control": "public, max-age=600" } });
        ctx.waitUntil(cache.put(key, response.clone()));
        return response;
      } catch (error) {
        return Response.json({ message: String(error) }, { status: 502 });
      }
    }
    if (url.pathname === "/api/judge") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!env.JEV_API_KEY) return Response.json({ message: "JEV_API_KEY is not set on the Worker" }, { status: 500 });
      jev ??= new Jev(env.JEV_API_KEY, 6);
      const { state, questions } = (await request.json()) as { state: string; questions: Record<string, unknown> };
      try {
        const started = Date.now();
        const answers = await jev.evaluate(state, questions as never);
        return Response.json({ answers, usage: jev.usage, latencyMs: Date.now() - started });
      } catch (error) {
        return Response.json({ message: String(error) }, { status: 502 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};

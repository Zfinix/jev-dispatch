import index from "../viewer/index.html";
import { fetchCalls } from "../src/sf";
import { Jev } from "../src/jev";

const PORT = Number(process.env.PORT ?? 4300);
const key = process.env.JEV_API_KEY;
if (!key) throw new Error("Set JEV_API_KEY in .dev.vars");
const jev = new Jev(key, 6);

const server = Bun.serve({
  port: PORT,
  development: { hmr: false },
  routes: {
    "/": index,
    "/api/calls": async (request) => {
      const since = Number(new URL(request.url).searchParams.get("since") ?? Date.now() - 48 * 3600_000);
      try {
        return Response.json({ calls: await fetchCalls(since), fetchedAt: Date.now() });
      } catch (error) {
        return Response.json({ message: String(error) }, { status: 502 });
      }
    },
    "/api/judge": {
      POST: async (request) => {
        const { state, questions } = (await request.json()) as { state: string; questions: Record<string, unknown> };
        try {
          const started = Date.now();
          const answers = await jev.evaluate(state, questions as never);
          return Response.json({ answers, usage: jev.usage, latencyMs: Date.now() - started });
        } catch (error) {
          return Response.json({ message: String(error) }, { status: 502 });
        }
      },
    },
  },
});

console.log(`Jev Dispatch at ${server.url}`);

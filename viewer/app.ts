import type { Call, CityId } from "../src/calls";
import { CITIES, type City } from "../src/cities";
import type { Answer } from "../src/jev";
import { baseline, BATCH, emptyBoard, questionsFor, score, verdicts, type Board, type Scored } from "../src/triage";

declare const maplibregl: any;

const JEV_USD_PER_MTOKEN = 0.042;
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const clock = $("#clock");
const stats = $("#stats");
const status = $("#status");
const list = $("#calls");
const inspector = $("#inspector");
const runButton = $<HTMLButtonElement>("#run");
const feedNote = $("#feed-note");
const legendItems = $("#legend-items");

type Mode = "live" | "replay";
let city: City = CITIES.detroit;
let mode: Mode = "live";
let running = false;
let queue: Call[] = [];
let seen = new Set<string>();
let scored: Scored[] = [];
let board: Board = emptyBoard(city);
let usage = { calls: 0, inputTokens: 0, outputTokens: 0, millis: 0 };
let latestAt = 0;
let pollTimer: number | undefined;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const cityClock = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: city.timeZone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
const shortTime = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: city.timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");
const primary = () => city.aspects[0];

// Colours for the primary aspect's options, in the order the city lists them.
const PALETTE = ["#f43f5e", "#f59e0b", "#2563eb", "#737373", "#404040", "#22c55e"];
const colourOf = (value: string) => PALETTE[Math.max(0, Object.keys(primary().options).indexOf(value)) % PALETTE.length];
const shortOf = (value: string) => (primary().key === "priority" ? `P${value}` : value.slice(0, 6));

function showStatus(text: string) {
  status.textContent = text;
  status.hidden = !text;
}

// CARTO's Dark Matter vector basemap, one dot per triaged call coloured by
// Jev's primary answer and ringed in white where the dispatcher disagreed.
const map = new maplibregl.Map({ container: "map", style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json", center: city.center, zoom: city.zoom, attributionControl: { compact: true } });
const features: unknown[] = [];
let mapReady = false;
map.on("load", () => {
  map.addSource("calls", { type: "geojson", data: { type: "FeatureCollection", features } });
  map.addLayer({ id: "calls", type: "circle", source: "calls", paint: { "circle-radius": ["case", ["get", "miss"], 6.5, 5], "circle-color": ["get", "colour"], "circle-opacity": 0.85, "circle-stroke-width": ["case", ["get", "miss"], 2, 0.8], "circle-stroke-color": ["case", ["get", "miss"], "#ffffff", ["get", "colour"]] } });
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });
  map.on("mouseenter", "calls", (e: any) => {
    map.getCanvas().style.cursor = "pointer";
    const p = e.features[0].properties;
    popup.setLngLat(e.features[0].geometry.coordinates).setHTML(`<b>${p.headline}</b><br>Jev: ${p.jev} · dispatcher: ${p.real}<br>${p.hood}`).addTo(map);
  });
  map.on("mouseleave", "calls", () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
  });
  mapReady = true;
  redraw();
});
function redraw() {
  if (mapReady) map.getSource("calls").setData({ type: "FeatureCollection", features });
}
function plot(s: Scored) {
  if (!s.call.lat || !s.call.lng) return;
  const key = primary().key;
  const truth = s.call.truth[key] ?? "";
  features.push({ type: "Feature", geometry: { type: "Point", coordinates: [s.call.lng, s.call.lat] }, properties: { headline: s.call.headline, hood: s.call.neighborhood, jev: primary().show(s.jev[key]), real: truth ? primary().show(truth) : "unknown", colour: colourOf(s.jev[key]), miss: !!truth && s.jev[key] !== truth } });
  redraw();
}
function renderLegend() {
  legendItems.replaceChildren(...Object.keys(primary().options).map((v) => {
    const span = el("span");
    const dot = el("i");
    dot.style.background = colourOf(v);
    span.append(dot, primary().show(v));
    return span;
  }));
}

function chip(value: string | undefined, caption: string): HTMLElement {
  const box = el("span", "verdict-cell");
  const c = el("span", `chip${value ? "" : " pending"}`, value ? shortOf(value) : "…");
  if (value) c.style.background = colourOf(value);
  box.append(c, el("span", "caption", caption));
  return box;
}

function renderCall(call: Call, verdict?: Scored): HTMLElement {
  const key = primary().key;
  const truth = call.truth[key];
  const miss = !!verdict && !!truth && verdict.jev[key] !== truth;
  const li = el("li", `call${miss ? " miss" : ""}${verdict ? "" : " pending"}`);
  li.dataset.id = call.id;
  const title = el("span", "title");
  title.append(el("span", "desc", call.headline), el("span", "hood", call.neighborhood));
  if (miss) title.append(el("span", "badge", "disagree"));
  li.append(el("span", "when", shortTime(call.at)), title, el("span", "where", call.detail));
  const v = el("span", "verdict");
  v.append(chip(verdict?.jev[key], "Jev"), chip(verdict ? truth ?? undefined : undefined, "Dispatcher"));
  li.append(v);
  if (verdict) {
    const tags = el("span", "tags");
    for (const a of city.aspects.slice(1)) {
      const t = call.truth[a.key];
      const ok = t === null || t === undefined ? undefined : a.near ? a.near(verdict.jev[a.key], t) : verdict.jev[a.key] === t;
      tags.append(el("span", `tag${ok === undefined ? "" : ok ? " right" : " wrong"}`, a.show(verdict.jev[a.key])));
    }
    for (const [k, v2] of Object.entries(call.facts)) tags.append(el("span", "tag", `${k} ${v2}`));
    tags.append(el("span", "tag sure", `${Math.round(verdict.confidence * 100)}%`));
    li.append(tags);
  }
  return li;
}

function renderStats() {
  const p = board.aspects[primary().key];
  const b = baseline(city, p, primary().key);
  stats.replaceChildren(
    ...[
      ["calls", String(board.calls)],
      [`${primary().label.toLowerCase()} agree`, pct(p.exact, p.scored)],
      ["baseline", pct(b.exact, p.scored)],
      ["decisions", (board.calls * city.aspects.length).toLocaleString()],
      ["latency", board.batches ? `${Math.round(board.latencyTotal / board.batches)} ms` : "–"],
    ].map(([k, v]) => {
      const s = el("span");
      s.append(`${k} `, Object.assign(el("b"), { textContent: v }));
      return s;
    }),
  );
}

function metricGrid(rows: [string, string][]): HTMLElement {
  const dl = el("dl", "metrics");
  for (const [k, v] of rows) {
    const d = el("div");
    d.append(el("dt", undefined, k), el("dd", undefined, v));
    dl.append(d);
  }
  return dl;
}

function section(title: string, ...children: HTMLElement[]): HTMLElement {
  const s = el("section", "section");
  s.append(el("h3", undefined, title), ...children);
  return s;
}

function bars(rows: [string, number][], max: number): HTMLElement {
  const box = el("div", "bars");
  for (const [label, value] of rows) {
    const row = el("div", "bar");
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    fill.style.width = `${Math.min(100, (value / Math.max(1, max)) * 100)}%`;
    track.append(fill);
    row.append(el("span", "bar-label", label), track, el("span", "bar-value", String(value)));
    box.append(row);
  }
  return box;
}

// Jev against the dumb baseline for every question, exact and near.
function scoreTable(): HTMLElement {
  const table = el("div", "table");
  table.append(el("span", "th", "Question"), el("span", "th", "Jev"), el("span", "th", "Always guess the usual"));
  for (const a of city.aspects) {
    const t = board.aspects[a.key];
    const b = baseline(city, t, a.key);
    const cell = (n: number, other: number, d: number) => el("span", `td${d && n > other ? " win" : d && n < other ? " lose" : ""}`, pct(n, d));
    table.append(el("span", "label", `${a.label}, exact`), cell(t.exact, b.exact, t.scored), cell(b.exact, t.exact, t.scored));
    if (a.near) table.append(el("span", "label", `${a.label}, close enough`), cell(t.near, b.near, t.scored), cell(b.near, t.near, t.scored));
    table.append(el("span", "sub", t.scored ? `${t.scored} calls scored · the usual answer here is "${a.show(b.guess)}"` : "no calls scored yet"));
  }
  return table;
}

function renderInspector() {
  const head = el("header");
  head.append(el("h2", undefined, city.short), el("p", "lede", city.id === "detroit"
    ? "Every call is real, published by the City of Detroit. Jev sees the calltaker's code, the source and the neighbourhood, and decides priority, whether a life is at risk, and how soon police arrive. The dispatcher's priority and the real response time are the answer key. The baseline column is what always guessing the most common answer would score."
    : "Every call is real, published by the City of San Francisco. The call types are coarse, so Jev is only asked to forecast the response: which unit goes first, how many, and how soon they arrive. The dispatcher's actual dispatch and the real on-scene time are the answer key, and the baseline is always guessing the most common answer."));

  const p = primary();
  const tally = board.aspects[p.key];
  const options = Object.keys(p.options);
  const grid = el("div", "grid");
  grid.style.setProperty("--n", String(options.length));
  grid.append(el("span", "h", ""), ...options.map((o) => el("span", "h", `Jev ${shortOf(o)}`)));
  for (const real of options) {
    grid.append(el("span", "r", `Real ${shortOf(real)}`));
    for (const guess of options) {
      const n = tally.confusion[real]?.[guess] ?? 0;
      grid.append(el("span", `c${real === guess ? " diag" : ""}`, n ? String(n) : ""));
    }
  }

  const misses = el("ol", "misses");
  const worst = [...scored].filter((s) => { const t = s.call.truth[p.key]; return t && (p.near ? !p.near(s.jev[p.key], t) : s.jev[p.key] !== t); }).slice(-8).reverse();
  for (const s of worst) {
    const li = el("li");
    const h = el("span", "head");
    h.append(el("span", undefined, s.call.headline), el("span", undefined, `Jev ${p.show(s.jev[p.key])} · real ${p.show(s.call.truth[p.key]!)}`));
    li.append(h, el("span", "sub", `${s.call.neighborhood}, ${shortTime(s.call.at)} · ${s.call.detail} (${Math.round(s.confidence * 100)}% sure)`));
    misses.append(li);
  }
  if (!worst.length) misses.append(el("li", undefined, "No big disagreements yet."));

  const mix = options.flatMap((o) => [[`Real ${p.show(o)}`, tally.counts[o] ?? 0] as [string, number], [`Jev ${p.show(o)}`, scored.filter((s) => s.jev[p.key] === o).length] as [string, number]]);
  const types = [...new Set(scored.map((s) => s.call.headline))].map((t) => [t, scored.filter((s) => s.call.headline === t).length] as [string, number]).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const jev = metricGrid([
    ["Decisions", (board.calls * city.aspects.length).toLocaleString()],
    ["Jev calls", String(board.batches)],
    ["Avg latency", board.batches ? `${Math.round(board.latencyTotal / board.batches)} ms` : "–"],
    ["Input tokens", usage.inputTokens.toLocaleString()],
    ["Cost so far", `$${((usage.inputTokens * JEV_USD_PER_MTOKEN) / 1e6).toFixed(4)}`],
    ["Per call", `${city.aspects.length} questions`],
  ]);

  inspector.replaceChildren(head, section("Jev vs the baseline", scoreTable()), section(`${p.label}: real vs Jev`, grid), section("Disagreements", misses), section("Mix", bars(mix, Math.max(1, ...mix.map((m) => m[1])))), section("Call types", bars(types, Math.max(1, ...types.map((t) => t[1])))), section("Jev", jev));
}

async function judge(batch: Call[]) {
  const load = { lastHour: scored.filter((s) => s.call.at > batch[0].at - 3600_000).length + queue.filter((c) => c.at > batch[0].at - 3600_000).length, waiting: queue.length };
  const response = await fetch("/api/judge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: city.state(batch, load), questions: questionsFor(city, batch) }) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? `Jev returned ${response.status}`);
  const body = (await response.json()) as { answers: Record<string, Answer>; usage: typeof usage; latencyMs: number };
  usage = body.usage;
  const results = verdicts(city, batch, body.answers, body.latencyMs);
  score(city, board, results, body.latencyMs);
  scored.push(...results);
  for (const s of results) {
    plot(s);
    const existing = list.querySelector<HTMLElement>(`[data-id="${s.call.id}"]`);
    const fresh = renderCall(s.call, s);
    if (existing) existing.replaceWith(fresh);
    else list.prepend(fresh);
  }
  renderStats();
  renderInspector();
}

async function load(sinceMs: number): Promise<Call[]> {
  const response = await fetch(`/api/calls?city=${city.id}&since=${Math.floor(sinceMs)}`);
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? `feed returned ${response.status}`);
  const body = (await response.json()) as { calls: Call[] };
  const fresh = body.calls.filter((c) => !seen.has(c.id));
  for (const c of fresh) seen.add(c.id);
  if (body.calls.length) latestAt = Math.max(latestAt, ...body.calls.map((c) => c.at));
  return fresh;
}

// Work through the queue a batch at a time, pausing between batches so the
// floor reads like a shift rather than a dump.
async function work() {
  while (running && queue.length) {
    const batch = queue.splice(0, Math.min(BATCH, queue.length));
    for (const c of batch) if (!list.querySelector(`[data-id="${c.id}"]`)) list.prepend(renderCall(c));
    clock.textContent = `${city.short} · ${cityClock(batch[batch.length - 1].at)} · ${queue.length} waiting`;
    showStatus(`Jev is triaging ${batch.length} calls…`);
    try {
      await judge(batch);
    } catch (error) {
      showStatus(`Jev didn't answer: ${(error as Error).message}`);
      running = false;
      runButton.textContent = "Start";
      runButton.setAttribute("aria-pressed", "false");
      return;
    }
    showStatus("");
    await new Promise((r) => setTimeout(r, mode === "replay" ? 400 : 1500));
  }
  if (running && mode === "live") {
    clock.textContent = `${city.short} · caught up to ${cityClock(latestAt || Date.now())} · watching for new calls`;
    showStatus(`Caught up; ${city.lagNote}. Checking again shortly.`);
  }
}

async function start() {
  running = true;
  runButton.textContent = "Pause";
  runButton.setAttribute("aria-pressed", "true");
  if (!scored.length && !queue.length) {
    showStatus(`Loading ${city.short} 911 calls…`);
    try {
      queue = await load(Date.now() - (mode === "replay" ? city.replayHours : city.liveHours) * 3600_000);
      const lagHours = queue.length ? Math.round((Date.now() - queue[queue.length - 1].at) / 360_000) / 10 : 0;
      feedNote.textContent = queue.length ? `${queue.length} real calls · newest is ${lagHours}h old` : "no calls published yet in this window";
    } catch (error) {
      showStatus(`Couldn't load calls: ${(error as Error).message}`);
      running = false;
      runButton.textContent = "Start";
      return;
    }
  }
  clearInterval(pollTimer);
  if (mode === "live") {
    pollTimer = window.setInterval(async () => {
      if (!running) return;
      const fresh = await load(latestAt ? latestAt - 60_000 : Date.now() - city.liveHours * 3600_000).catch(() => []);
      if (fresh.length) {
        queue.push(...fresh);
        feedNote.textContent = `${fresh.length} new calls just arrived`;
        if (queue.length === fresh.length) work();
      }
    }, city.pollMs);
  }
  work();
}

function stop() {
  running = false;
  runButton.textContent = "Resume";
  runButton.setAttribute("aria-pressed", "false");
  showStatus("Paused.");
}

function reset() {
  if (running) stop();
  clearInterval(pollTimer);
  queue = [];
  seen = new Set();
  scored = [];
  board = emptyBoard(city);
  latestAt = 0;
  list.replaceChildren();
  features.length = 0;
  redraw();
  runButton.textContent = "Start";
  feedNote.textContent = "real calls, oldest first";
  clock.textContent = `${city.short}, waiting for calls`;
  renderLegend();
  renderStats();
  renderInspector();
}

runButton.addEventListener("click", () => (running ? stop() : start()));
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
  b.addEventListener("click", () => {
    mode = b.dataset.mode as Mode;
    document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    reset();
  });
}
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-city]")) {
  b.addEventListener("click", () => {
    city = CITIES[b.dataset.city as CityId];
    document.querySelectorAll<HTMLButtonElement>("[data-city]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    map.flyTo({ center: city.center, zoom: city.zoom, duration: 1200 });
    reset();
  });
}

reset();

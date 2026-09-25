import type { Call } from "../src/sf";
import type { Answer } from "../src/jev";
import { BATCH, bucket, emptyBoard, LEADS, questionsFor, QUESTIONS_PER_CALL, RESPONSE, score, stateText, unitsLabel, verdicts, type Board, type Scored } from "../src/triage";

declare const L: any;

const JEV_USD_PER_MTOKEN = 0.042;
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const clock = $("#clock");
const stats = $("#stats");
const status = $("#status");
const list = $("#calls");
const inspector = $("#inspector");
const runButton = $<HTMLButtonElement>("#run");
const feedNote = $("#feed-note");

type Mode = "live" | "replay";
let mode: Mode = "live";
let running = false;
let queue: Call[] = [];
let seen = new Set<string>();
let scored: Scored[] = [];
let board: Board = emptyBoard();
let usage = { calls: 0, inputTokens: 0, outputTokens: 0, millis: 0 };
let latestCalledAt = 0;
let pollTimer: number | undefined;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const cityClock = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
const shortTime = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");

function showStatus(text: string) {
  status.textContent = text;
  status.hidden = !text;
}

// Map of San Francisco with one dot per triaged call, coloured by Jev's code
// and ringed in white where the dispatcher disagreed.
const map = L.map("map", { zoomControl: false, attributionControl: true }).setView([37.76, -122.44], 12);
// CARTO's dark basemap first; if its tiles fail, fall back to OpenStreetMap
// tiles darkened with a filter so the floor never goes blank.
const CARTO_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoiYWNfZjE3cWI1ajMiLCJqdGkiOiJlYjBjNzQ2MCJ9.S6wLJ53px-sgbjpxBkIDGvasMU-F4rpxMQH80EVW6Qw";
const carto = L.tileLayer(`https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`, { attribution: "&copy; OpenStreetMap &copy; CARTO", maxZoom: 19 }).addTo(map);
let tileFailures = 0;
carto.on("tileerror", () => {
  if (++tileFailures < 3 || !map.hasLayer(carto)) return;
  map.removeLayer(carto);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19, className: "dark-tiles" }).addTo(map);
});
const colour = (code: 2 | 3) => (code === 3 ? "#f43f5e" : "#2563eb");
function plot(s: Scored) {
  if (!s.call.lat || !s.call.lng) return;
  const miss = s.jev.code !== s.call.truth.code;
  const dot = L.circleMarker([s.call.lat, s.call.lng], { radius: miss ? 7 : 5, color: miss ? "#ffffff" : colour(s.jev.code), weight: miss ? 2 : 1, fillColor: colour(s.jev.code), fillOpacity: 0.85 });
  dot.bindTooltip(`${s.call.type}<br>Jev code ${s.jev.code} · dispatcher code ${s.call.truth.code}<br>${s.call.neighborhood}`);
  dot.addTo(map);
}

function chip(code: 2 | 3 | undefined, caption: string): HTMLElement {
  const box = el("span", "verdict-cell");
  box.append(el("span", `chip${code ? ` c${code}` : " pending"}`, code ? `C${code}` : "…"), el("span", "caption", caption));
  return box;
}

function renderCall(call: Call, verdict?: Scored): HTMLElement {
  const miss = !!verdict && verdict.jev.code !== call.truth.code;
  const li = el("li", `call${miss ? " miss" : ""}${verdict ? "" : " pending"}`);
  li.dataset.id = call.id;
  const title = el("span", "title");
  title.append(el("span", "desc", call.type), el("span", "hood", call.neighborhood));
  if (miss) title.append(el("span", "badge", "disagree"));
  li.append(el("span", "when", shortTime(call.receivedAt)), title);
  li.append(el("span", "where", call.address.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase())));
  const v = el("span", "verdict");
  v.append(chip(verdict?.jev.code, "Jev"), chip(verdict ? call.truth.code : undefined, "Dispatcher"));
  li.append(v);
  if (verdict) {
    const t = call.truth;
    const tags = el("span", "tags");
    const mark = (ok: boolean, text: string) => el("span", `tag ${ok ? "right" : "wrong"}`, text);
    if (verdict.jev.threat > 0.5) tags.append(mark(t.threat, `life-threatening ${Math.round(verdict.jev.threat * 100)}%`));
    tags.append(mark((verdict.jev.als > 0.5) === t.als, verdict.jev.als > 0.5 ? "paramedic" : "basic care"));
    tags.append(mark(verdict.jev.lead === t.lead, LEADS[verdict.jev.lead].split(" (")[0].replace(/^a |^an /, "")));
    tags.append(mark(verdict.jev.units === unitsLabel(t.units), `${verdict.jev.units === "several" ? "3+" : verdict.jev.units} unit${verdict.jev.units === "one" ? "" : "s"}, sent ${t.units}`));
    const actual = bucket(t.responseMin);
    tags.append(actual === null ? el("span", "tag", RESPONSE[verdict.jev.response]) : mark(Math.abs(verdict.jev.response - actual) <= 1, `${RESPONSE[verdict.jev.response]}, arrived ${Math.round(t.responseMin!)} min`));
    tags.append(el("span", "tag sure", `${Math.round(verdict.jev.confidence * 100)}%`));
    li.append(tags);
  }
  return li;
}

function renderStats() {
  stats.replaceChildren(
    ...[
      ["calls triaged", String(board.calls)],
      ["code agree", pct(board.codeExact, board.calls)],
      ["code 3 caught", pct(board.code3Caught, board.code3Total)],
      ["paramedic agree", pct(board.alsRight, board.calls)],
      ["first unit", pct(board.leadRight, board.calls)],
      ["decisions", (board.calls * QUESTIONS_PER_CALL).toLocaleString()],
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

function renderInspector() {
  const head = el("header");
  head.append(el("h2", undefined, "San Francisco"), el("p", "lede", "Every call is real, published by the City of San Francisco. Jev sees what the calltaker logged and decides the response code, whether life is at risk, paramedic or basic care, which unit goes first, how many, and how soon they'll arrive. The dispatcher's actual decisions and the real on-scene time are the answer key."));

  const agreement = metricGrid([
    ["Response code", pct(board.codeExact, board.calls)],
    ["Code 3 caught", `${board.code3Caught} / ${board.code3Total}`],
    ["Code 3 calls that were right", pct(board.code3Right, board.code3Said)],
    ["Life-threatening", pct(board.threatRight, board.calls)],
    ["Paramedic or basic", pct(board.alsRight, board.calls)],
    ["Paramedic need caught", `${board.alsCaught} / ${board.alsTotal}`],
    ["First unit out", pct(board.leadRight, board.calls)],
    ["Unit count", pct(board.unitsRight, board.calls)],
    ["Arrival within one bucket", pct(board.responseWithinOne, board.responseScored)],
  ]);

  const grid = el("div", "grid");
  grid.append(el("span", "h", ""), el("span", "h", "Jev C3"), el("span", "h", "Jev C2"));
  board.confusion.forEach((row, i) => {
    grid.append(el("span", "r", i === 0 ? "Real C3" : "Real C2"));
    row.forEach((n, j) => grid.append(el("span", `c${i === j ? " diag" : ""}`, n ? String(n) : "")));
  });

  const misses = el("ol", "misses");
  const worst = [...scored].filter((s) => s.jev.code !== s.call.truth.code).slice(-8).reverse();
  for (const s of worst) {
    const li = el("li");
    const h = el("span", "head");
    h.append(el("span", undefined, s.call.type), el("span", undefined, `Jev C${s.jev.code} · real C${s.call.truth.code}`));
    li.append(h, el("span", "sub", `${s.call.neighborhood}, ${shortTime(s.call.receivedAt)} · ${s.call.truth.group} · ${s.jev.code === 3 ? "Jev sent lights and sirens, the dispatcher didn't" : "Jev went quiet, the dispatcher sent lights and sirens"} (${Math.round(s.jev.confidence * 100)}% sure)`));
    misses.append(li);
  }
  if (!worst.length) misses.append(el("li", undefined, "No code disagreements yet."));

  const byPriority = ([3, 2] as const).map((p) => [`Real code ${p}`, scored.filter((s) => s.call.truth.code === p).length] as [string, number]);
  const jevSays = ([3, 2] as const).map((p) => [`Jev code ${p}`, scored.filter((s) => s.jev.code === p).length] as [string, number]);
  const types = [...new Set(scored.map((s) => s.call.type))].map((t) => [t, scored.filter((s) => s.call.type === t).length] as [string, number]).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const jev = metricGrid([
    ["Decisions", (board.calls * QUESTIONS_PER_CALL).toLocaleString()],
    ["Jev calls", String(board.batches)],
    ["Avg latency", board.batches ? `${Math.round(board.latencyTotal / board.batches)} ms` : "–"],
    ["Input tokens", usage.inputTokens.toLocaleString()],
    ["Cost so far", `$${((usage.inputTokens * JEV_USD_PER_MTOKEN) / 1e6).toFixed(4)}`],
    ["Per call", `${QUESTIONS_PER_CALL} questions`],
  ]);

  inspector.replaceChildren(head, section("Agreement with the dispatcher", agreement), section("Response code", grid), section("Disagreements", misses), section("Mix", bars([...byPriority, ...jevSays], Math.max(1, ...byPriority.map((b) => b[1]), ...jevSays.map((b) => b[1])))), section("Call types", bars(types, Math.max(1, ...types.map((t) => t[1])))), section("Jev", jev));
}

async function judge(batch: Call[]) {
  const load = { lastHour: scored.filter((s) => s.call.receivedAt > batch[0].receivedAt - 3600_000).length + queue.filter((c) => c.receivedAt > batch[0].receivedAt - 3600_000).length, waiting: queue.length };
  const response = await fetch("/api/judge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: stateText(batch, load), questions: questionsFor(batch) }) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? `Jev returned ${response.status}`);
  const body = (await response.json()) as { answers: Record<string, Answer>; usage: typeof usage; latencyMs: number };
  usage = body.usage;
  const results = verdicts(batch, body.answers, body.latencyMs);
  score(board, results, body.latencyMs);
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
  const response = await fetch(`/api/calls?since=${Math.floor(sinceMs)}`);
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? `feed returned ${response.status}`);
  const body = (await response.json()) as { calls: Call[] };
  const fresh = body.calls.filter((c) => !seen.has(c.id));
  for (const c of fresh) seen.add(c.id);
  if (body.calls.length) latestCalledAt = Math.max(latestCalledAt, ...body.calls.map((c) => c.receivedAt));
  return fresh;
}

// Work through the queue a batch at a time, pausing between batches so the
// floor reads like a shift rather than a dump.
async function work() {
  while (running && queue.length) {
    const batch = queue.splice(0, Math.min(BATCH, queue.length));
    for (const c of batch) if (!list.querySelector(`[data-id="${c.id}"]`)) list.prepend(renderCall(c));
    clock.textContent = `San Francisco · ${cityClock(batch[batch.length - 1].receivedAt)} · ${queue.length} waiting`;
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
    clock.textContent = `San Francisco · caught up to ${cityClock(latestCalledAt || Date.now())} · watching for new calls`;
    showStatus("Caught up. The city loads new calls once a day; checking every ten minutes.");
  }
}

async function start() {
  running = true;
  runButton.textContent = "Pause";
  runButton.setAttribute("aria-pressed", "true");
  if (!scored.length && !queue.length) {
    showStatus(mode === "replay" ? "Loading a week of San Francisco 911 calls…" : "Loading the most recent San Francisco 911 calls…");
    try {
      queue = await load(Date.now() - (mode === "replay" ? 7 * 24 : 72) * 3600_000);
      const lagHours = queue.length ? Math.round((Date.now() - queue[queue.length - 1].receivedAt) / 360_000) / 10 : 0;
      feedNote.textContent = queue.length ? `${queue.length} real calls · the city publishes about ${lagHours}h behind` : "no calls published yet in this window";
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
      const fresh = await load(latestCalledAt ? latestCalledAt - 60_000 : Date.now() - 72 * 3600_000).catch(() => []);
      if (fresh.length) {
        queue.push(...fresh);
        feedNote.textContent = `${fresh.length} new calls just arrived`;
        if (!queue.length || queue.length === fresh.length) work();
      }
    }, 600_000);
  }
  work();
}

function stop() {
  running = false;
  runButton.textContent = "Resume";
  runButton.setAttribute("aria-pressed", "false");
  showStatus("Paused.");
}

runButton.addEventListener("click", () => (running ? stop() : start()));
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
  b.addEventListener("click", () => {
    if (running) stop();
    mode = b.dataset.mode as Mode;
    document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    queue = [];
    seen = new Set();
    scored = [];
    board = emptyBoard();
    latestCalledAt = 0;
    list.replaceChildren();
    map.eachLayer((layer: any) => { if (layer instanceof L.CircleMarker) map.removeLayer(layer); });
    runButton.textContent = "Start";
    renderStats();
    renderInspector();
  });
}

renderStats();
renderInspector();

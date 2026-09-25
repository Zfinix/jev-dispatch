import { bucket, type Call } from "./calls";

// San Francisco Fire and EMS, one row per unit sent, loaded once a day. The
// call type is coarse, so this city is only asked forecasting questions.
const FEED = "https://data.sf.gov/resource/nuek-vuh3.json";
const UNIT_KIND: Record<string, string> = { MEDIC: "medic", ENGINE: "engine", TRUCK: "truck", PRIVATE: "private", BLS: "private", CHIEF: "chief", CP: "chief", "RESCUE CAPTAIN": "chief" };
type Row = Record<string, string | boolean | null | { coordinates: [number, number] }>;
const minutes = (from: string | undefined, to: string | undefined) => (from && to ? (Date.parse(`${to}Z`) - Date.parse(`${from}Z`)) / 60_000 : null);
const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

function fold(rows: Row[]): Call[] {
  const byCall = new Map<string, Row[]>();
  for (const r of rows) {
    const key = String(r.call_number ?? "");
    if (key) byCall.set(key, [...(byCall.get(key) ?? []), r]);
  }
  const calls: Call[] = [];
  for (const [id, units] of byCall) {
    units.sort((a, b) => Number(a.unit_sequence_in_call_dispatch ?? 99) - Number(b.unit_sequence_in_call_dispatch ?? 99));
    const first = units[0];
    const received = String(first.received_dttm ?? "");
    if (!received || !first.call_type) continue;
    const point = first.case_location as { coordinates: [number, number] } | null;
    const onScene = units.map((u) => String(u.on_scene_dttm ?? "")).filter(Boolean).sort()[0];
    const response = minutes(received, onScene);
    calls.push({
      city: "sf",
      id,
      at: Date.parse(`${received}Z`),
      headline: String(first.call_type),
      detail: titleCase(String(first.address ?? "").trim() || "address withheld"),
      neighborhood: String(first.neighborhoods_analysis_boundaries ?? "").trim() || "unknown neighbourhood",
      area: `battalion ${String(first.battalion ?? "").trim()}`,
      lat: point?.coordinates?.[1] ?? 0,
      lng: point?.coordinates?.[0] ?? 0,
      truth: { lead: UNIT_KIND[String(first.unit_type ?? "")] ?? "other", units: units.length <= 1 ? "one" : units.length === 2 ? "two" : "several", response: bucket(response) },
      facts: { sent: `${units.length} unit${units.length === 1 ? "" : "s"}, ${String(first.unit_type ?? "").toLowerCase()} first`, ...(response !== null && response >= 0 ? { arrived: `${Math.round(response)} min` } : {}) },
    });
  }
  return calls.sort((a, b) => a.at - b.at);
}

export async function fetchSf(sinceMs: number, limit = 8000): Promise<Call[]> {
  const stamp = new Date(sinceMs).toISOString().slice(0, 19);
  const params = new URLSearchParams({ $where: `received_dttm > '${stamp}'`, $order: "received_dttm ASC", $limit: String(limit) });
  const response = await fetch(`${FEED}?${params}`, { headers: { accept: "application/json", "user-agent": "jev-dispatch/0.1 (+https://dispatch.chizi.app)" } });
  if (!response.ok) throw new Error(`San Francisco open data returned ${response.status}`);
  return fold((await response.json()) as Row[]);
}

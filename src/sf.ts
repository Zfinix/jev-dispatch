// San Francisco Fire and EMS dispatched calls, published by the city and
// loaded once a day. One row per unit sent; rows are folded into one call.
// Jev sees only what the calltaker knew; the dispatcher's decisions are truth.
const FEED = "https://data.sf.gov/resource/nuek-vuh3.json";

export type UnitKind = "medic" | "engine" | "truck" | "private" | "chief" | "other";

export type Call = {
  id: string;
  receivedAt: number;
  type: string;
  address: string;
  neighborhood: string;
  battalion: string;
  lat: number;
  lng: number;
  truth: { code: 2 | 3; threat: boolean; group: string; als: boolean; lead: UnitKind; units: number; responseMin: number | null; original: string };
};

type Row = Record<string, string | boolean | null | { coordinates: [number, number] }>;

const UNIT_KIND: Record<string, UnitKind> = { MEDIC: "medic", ENGINE: "engine", TRUCK: "truck", PRIVATE: "private", BLS: "private", CHIEF: "chief", CP: "chief", "RESCUE CAPTAIN": "chief" };
const minutes = (from: string | undefined, to: string | undefined) => (from && to ? Math.round(((Date.parse(`${to}Z`) - Date.parse(`${from}Z`)) / 60_000) * 10) / 10 : null);

function fold(rows: Row[]): Call[] {
  const byCall = new Map<string, Row[]>();
  for (const r of rows) {
    const key = String(r.call_number ?? "");
    if (!key) continue;
    byCall.set(key, [...(byCall.get(key) ?? []), r]);
  }
  const calls: Call[] = [];
  for (const [id, units] of byCall) {
    units.sort((a, b) => Number(a.unit_sequence_in_call_dispatch ?? 99) - Number(b.unit_sequence_in_call_dispatch ?? 99));
    const first = units[0];
    const code = Number(first.final_priority);
    const received = String(first.received_dttm ?? "");
    if ((code !== 2 && code !== 3) || !received || !first.call_type) continue;
    const point = first.case_location as { coordinates: [number, number] } | null;
    const onScene = units.map((u) => String(u.on_scene_dttm ?? "")).filter(Boolean).sort()[0];
    calls.push({
      id,
      receivedAt: Date.parse(`${received}Z`),
      type: String(first.call_type),
      address: String(first.address ?? "").trim() || "address withheld",
      neighborhood: String(first.neighborhoods_analysis_boundaries ?? "").trim() || "unknown neighbourhood",
      battalion: String(first.battalion ?? "").trim(),
      lat: point?.coordinates?.[1] ?? 0,
      lng: point?.coordinates?.[0] ?? 0,
      truth: {
        code,
        threat: ["Potentially Life-Threatening", "Fire"].includes(String(first.call_type_group ?? "")),
        group: String(first.call_type_group ?? "unclassified"),
        als: units.some((u) => u.als_unit === true),
        lead: UNIT_KIND[String(first.unit_type ?? "")] ?? "other",
        units: units.length,
        responseMin: minutes(received, onScene),
        original: String(first.original_priority ?? ""),
      },
    });
  }
  return calls.sort((a, b) => a.receivedAt - b.receivedAt);
}

// Calls received since a timestamp (UTC), oldest first. About 1,000 calls a
// day means roughly 2,500 unit rows, so a day fits in one request.
export async function fetchCalls(sinceMs: number, limit = 8000): Promise<Call[]> {
  const stamp = new Date(sinceMs).toISOString().slice(0, 19);
  const params = new URLSearchParams({
    $where: `received_dttm > '${stamp}'`,
    $order: "received_dttm ASC",
    $limit: String(limit),
  });
  const response = await fetch(`${FEED}?${params}`, { headers: { accept: "application/json", "user-agent": "jev-dispatch/0.1 (+https://dispatch.chizi.app)" } });
  if (!response.ok) throw new Error(`San Francisco open data returned ${response.status}`);
  return fold((await response.json()) as Row[]);
}

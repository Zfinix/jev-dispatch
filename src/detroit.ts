import { bucket, type Call } from "./calls";

// Detroit Police 911 calls on ArcGIS, refreshed through the day a few hours
// behind. The calltaker's code is descriptive, which is the signal Jev needs.
const LAYER = "https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/Police_Serviced_911_Calls/FeatureServer/0/query";
const SOURCES: Record<string, string> = { W911: "wireless 911 call", PHONE: "phone call", "911": "landline 911 call", OI: "officer initiated", ALARM: "alarm company", TEXT: "text to 911" };

type Row = Record<string, string | number | null>;

function normalise(a: Row): Call | undefined {
  const priority = String(a.priority ?? "").trim();
  if (!/^[1-5]$/.test(priority) || !a.call_description || typeof a.called_at !== "number") return undefined;
  const response = a.total_response_time === null ? null : Number(a.total_response_time);
  const source = SOURCES[String(a.call_source ?? "").trim()] ?? String(a.call_source ?? "call").trim().toLowerCase();
  return {
    city: "detroit",
    id: String(a.incident_id),
    at: a.called_at,
    headline: String(a.call_description).trim(),
    detail: `${source} · precinct ${a.precinct ?? "?"}`,
    neighborhood: String(a.neighborhood_name ?? "").trim() || "unknown neighbourhood",
    area: `precinct ${a.precinct ?? "?"}`,
    lat: Number(a.latitude ?? 0),
    lng: Number(a.longitude ?? 0),
    truth: { priority, threat: priority === "1" ? "yes" : "no", response: bucket(response) },
    facts: response !== null && response >= 0 ? { arrived: `${Math.round(response)} min` } : {},
  };
}

export async function fetchDetroit(sinceMs: number, limit = 1500): Promise<Call[]> {
  const stamp = new Date(sinceMs).toISOString().slice(0, 19).replace("T", " ");
  const params = new URLSearchParams({
    where: `called_at >= TIMESTAMP '${stamp}'`,
    outFields: "incident_id,call_source,call_description,priority,called_at,total_response_time,neighborhood_name,precinct,longitude,latitude",
    orderByFields: "called_at ASC",
    resultRecordCount: String(limit),
    f: "json",
  });
  const response = await fetch(`${LAYER}?${params}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Detroit open data returned ${response.status}`);
  const body = (await response.json()) as { features?: { attributes: Row }[]; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return (body.features ?? []).map((f) => normalise(f.attributes)).filter((c): c is Call => !!c);
}

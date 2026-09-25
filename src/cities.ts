import type { Call, CityId } from "./calls";
import type { Answer, Question } from "./jev";

// An aspect is one typed question per call plus how to read the dispatcher's
// answer for it. `near` says when two answers count as close enough.
export type Aspect = {
  key: string;
  label: string;
  options: Record<string, string>;
  ask: (c: Call) => Question;
  read: (a: Answer | undefined) => string;
  near?: (jev: string, truth: string) => boolean;
  show: (jev: string) => string;
};

export type City = {
  id: CityId;
  name: string;
  short: string;
  timeZone: string;
  center: [number, number];
  zoom: number;
  liveHours: number;
  replayHours: number;
  pollMs: number;
  lagNote: string;
  aspects: Aspect[];
  state: (batch: Call[], load: { lastHour: number; waiting: number }) => string;
};

const RESPONSE = { "0": "under 5 minutes", "1": "5 to 15 minutes", "2": "15 to 30 minutes", "3": "30 to 60 minutes", "4": "over an hour" };
const nearBucket = (a: string, b: string) => Math.abs(Number(a) - Number(b)) <= 1;
const clock = (tz: string) => (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", hour: "numeric", minute: "2-digit" }).format(new Date(ms));

const arrival = (what: (c: Call) => string): Aspect => ({
  key: "response",
  label: "Arrival time",
  options: RESPONSE,
  ask: (c) => ({ type: "score", instructions: `How long until the first unit is on scene at ${what(c)}, given the response it deserves and how busy the city is?`, criteria: Object.values(RESPONSE) }),
  read: (a) => (a?.type === "score" ? String(Math.max(0, Math.min(4, Math.round(a.score)))) : "1"),
  near: nearBucket,
  show: (v) => RESPONSE[v as keyof typeof RESPONSE],
});

const DETROIT_PRIORITIES = {
  "1": "immediate danger to life, violent crime or serious injury in progress: send units now",
  "2": "urgent, just occurred or likely to escalate, potential for injury: respond quickly",
  "3": "routine, no immediate danger, respond when units free up",
  "4": "low priority, a delayed response is acceptable",
  "5": "report or referral only, no emergency response needed",
};

export const DETROIT: City = {
  id: "detroit",
  name: "Detroit Police",
  short: "Detroit",
  timeZone: "America/Detroit",
  center: [-83.1, 42.36],
  zoom: 10.4,
  liveHours: 12,
  replayHours: 48,
  pollMs: 60_000,
  lagNote: "the city publishes a few hours behind",
  aspects: [
    {
      key: "priority",
      label: "Priority",
      options: DETROIT_PRIORITIES,
      ask: (c) => ({ type: "choice", instructions: `What dispatch priority should "${c.headline}" from ${c.neighborhood} get?`, criteria: DETROIT_PRIORITIES }),
      read: (a) => (a?.type === "choice" && a.choice in DETROIT_PRIORITIES ? a.choice : "3"),
      near: nearBucket,
      show: (v) => `priority ${v}`,
    },
    {
      key: "threat",
      label: "Life at risk",
      options: { yes: "yes", no: "no" },
      ask: (c) => ({ type: "noul", instructions: `Someone's life or physical safety is in immediate danger in the call logged as "${c.headline}".` }),
      read: (a) => (a?.type === "noul" && a.noul > 0.7 ? "yes" : "no"),
      show: (v) => (v === "yes" ? "life at risk" : "no immediate danger"),
    },
    arrival((c) => `"${c.headline}" in ${c.neighborhood}`),
  ],
  state: (batch, load) => [
    `Detroit Police 911 dispatch. ${clock("America/Detroit")(batch[0].at)} local time. ${load.lastHour} calls citywide in the last hour, ${load.waiting} waiting for a decision.`,
    "Each line is one incoming call as the calltaker logged it: the source, the neighbourhood and precinct, and the call type code. Decide for each one as a dispatcher would.",
    ...batch.map((c) => `${c.id}: ${c.detail} from ${c.neighborhood}, logged as "${c.headline}".`),
  ].join("\n"),
};

const LEADS = { medic: "a paramedic ambulance", engine: "a fire engine", truck: "a ladder truck", private: "a basic life support ambulance", chief: "a battalion chief or rescue captain", other: "something else: rescue squad, support, hazmat" };
const UNITS = { one: "one unit", two: "two units", several: "three or more units" };

export const SF: City = {
  id: "sf",
  name: "San Francisco Fire & EMS",
  short: "San Francisco",
  timeZone: "America/Los_Angeles",
  center: [-122.44, 37.76],
  zoom: 11.4,
  liveHours: 72,
  replayHours: 7 * 24,
  pollMs: 600_000,
  lagNote: "the city loads data once a day",
  aspects: [
    {
      key: "lead",
      label: "First unit out",
      options: LEADS,
      ask: (c) => ({ type: "choice", instructions: `Which unit should be first out the door for "${c.headline}" at ${c.detail}, ${c.neighborhood}?`, criteria: LEADS }),
      read: (a) => (a?.type === "choice" && a.choice in LEADS ? a.choice : "other"),
      show: (v) => LEADS[v as keyof typeof LEADS].replace(/^an? /, "").split(":")[0],
    },
    {
      key: "units",
      label: "Unit count",
      options: UNITS,
      ask: (c) => ({ type: "choice", instructions: `How many units should be sent to "${c.headline}" at ${c.detail}, ${c.neighborhood}?`, criteria: UNITS }),
      read: (a) => (a?.type === "choice" && a.choice in UNITS ? a.choice : "one"),
      near: (a, b) => ["one two", "two one", "two several", "several two"].includes(`${a} ${b}`) || a === b,
      show: (v) => UNITS[v as keyof typeof UNITS],
    },
    arrival((c) => `"${c.headline}" at ${c.detail}, ${c.neighborhood}`),
  ],
  state: (batch, load) => [
    `San Francisco Fire Department 911 dispatch. ${clock("America/Los_Angeles")(batch[0].at)} local time. ${load.lastHour} calls citywide in the last hour, ${load.waiting} waiting for a decision.`,
    "Each line is one incoming call as the calltaker logged it: the call type, the address, the neighbourhood and the battalion area. Decide the response for each one as the dispatcher would.",
    ...batch.map((c) => `${c.id}: ${c.headline} at ${c.detail}, ${c.neighborhood} (${c.area}).`),
  ].join("\n"),
};

export const CITIES: Record<CityId, City> = { detroit: DETROIT, sf: SF };

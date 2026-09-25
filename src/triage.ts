import type { Call, UnitKind } from "./sf";
import type { Answer, Question } from "./jev";

// Jev sees what the 911 calltaker logged: the call type, the address, the
// neighbourhood and the time. The dispatcher's code, the life-threat grouping,
// the units sent and the real arrival time stay hidden until scoring.
export const BATCH = 10;
export const QUESTIONS_PER_CALL = 6;

export const CODES: Record<string, string> = {
  "3": "Code 3: lights and sirens, treat as life-threatening or a working fire",
  "2": "Code 2: no lights or sirens, a non-emergency response is enough",
};
export const LEADS: Record<UnitKind, string> = {
  medic: "a paramedic ambulance (medic unit)",
  engine: "a fire engine",
  truck: "a ladder truck",
  private: "a basic life support ambulance",
  chief: "a battalion chief or rescue captain",
  other: "something else: rescue squad, support, hazmat",
};
export const UNITS: Record<string, string> = { one: "one unit", two: "two units", several: "three or more units" };
export const RESPONSE = ["under 4 minutes", "4 to 8 minutes", "8 to 15 minutes", "15 to 30 minutes", "over 30 minutes"];

export type Verdict = { code: 2 | 3; confidence: number; threat: number; als: number; lead: UnitKind; units: string; response: number; latencyMs: number };
export type Scored = { call: Call; jev: Verdict };

export const bucket = (minutes: number | null) => (minutes === null || minutes < 0 ? null : minutes < 4 ? 0 : minutes < 8 ? 1 : minutes < 15 ? 2 : minutes < 30 ? 3 : 4);
export const unitsLabel = (n: number) => (n <= 1 ? "one" : n === 2 ? "two" : "several");

const sfTime = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long", hour: "numeric", minute: "2-digit" }).format(new Date(ms));

export function stateText(batch: Call[], load: { lastHour: number; waiting: number }): string {
  return [
    `San Francisco Fire Department 911 dispatch. ${sfTime(batch[0].receivedAt)} local time. ${load.lastHour} calls citywide in the last hour, ${load.waiting} waiting for a decision.`,
    "Each line is one incoming call as the calltaker logged it: the call type, the address, the neighbourhood and the battalion area. Decide for each one as the dispatcher would.",
    ...batch.map((c) => `${c.id}: ${c.type} at ${c.address}, ${c.neighborhood} (battalion ${c.battalion}).`),
  ].join("\n");
}

export function questionsFor(batch: Call[]): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const c of batch) {
    const what = `"${c.type}" at ${c.address}, ${c.neighborhood}`;
    questions[`${c.id}.code`] = { type: "choice", instructions: `How should units respond to ${what}?`, criteria: CODES };
    questions[`${c.id}.threat`] = { type: "noul", instructions: `The call ${what} is potentially life-threatening or a working fire.` };
    questions[`${c.id}.als`] = { type: "noul", instructions: `${what} needs advanced life support: a paramedic, not just basic care.` };
    questions[`${c.id}.lead`] = { type: "choice", instructions: `Which unit should be first out the door for ${what}?`, criteria: LEADS };
    questions[`${c.id}.units`] = { type: "choice", instructions: `How many units should be sent to ${what}?`, criteria: UNITS };
    questions[`${c.id}.response`] = { type: "score", instructions: `How long until the first unit is on scene at ${what}, given the response it deserves and how busy the city is?`, criteria: RESPONSE };
  }
  return questions;
}

export function verdicts(batch: Call[], answers: Record<string, Answer>, latencyMs: number): Scored[] {
  const out: Scored[] = [];
  for (const call of batch) {
    const code = answers[`${call.id}.code`];
    const threat = answers[`${call.id}.threat`];
    const als = answers[`${call.id}.als`];
    const lead = answers[`${call.id}.lead`];
    const units = answers[`${call.id}.units`];
    const response = answers[`${call.id}.response`];
    if (code?.type !== "choice") continue;
    out.push({
      call,
      jev: {
        code: code.choice === "3" ? 3 : 2,
        confidence: code.probabilities[code.choice] ?? code.confidence,
        threat: threat?.type === "noul" ? threat.noul : 0,
        als: als?.type === "noul" ? als.noul : 0,
        lead: lead?.type === "choice" && lead.choice in LEADS ? (lead.choice as UnitKind) : "other",
        units: units?.type === "choice" ? units.choice : "one",
        response: response?.type === "score" ? Math.round(response.score) : 1,
        latencyMs,
      },
    });
  }
  return out;
}

export type Board = {
  calls: number;
  codeExact: number;
  code3Total: number;
  code3Caught: number;
  code3Said: number;
  code3Right: number;
  confusion: number[][];
  threatRight: number;
  alsRight: number;
  alsTotal: number;
  alsCaught: number;
  leadRight: number;
  unitsRight: number;
  responseScored: number;
  responseExact: number;
  responseWithinOne: number;
  latencyTotal: number;
  batches: number;
};

export const emptyBoard = (): Board => ({ calls: 0, codeExact: 0, code3Total: 0, code3Caught: 0, code3Said: 0, code3Right: 0, confusion: [[0, 0], [0, 0]], threatRight: 0, alsRight: 0, alsTotal: 0, alsCaught: 0, leadRight: 0, unitsRight: 0, responseScored: 0, responseExact: 0, responseWithinOne: 0, latencyTotal: 0, batches: 0 });

export function score(board: Board, scored: Scored[], latencyMs: number) {
  board.batches += 1;
  board.latencyTotal += latencyMs;
  for (const { call, jev } of scored) {
    const t = call.truth;
    board.calls += 1;
    if (jev.code === t.code) board.codeExact += 1;
    if (t.code === 3) {
      board.code3Total += 1;
      if (jev.code === 3) board.code3Caught += 1;
    }
    if (jev.code === 3) {
      board.code3Said += 1;
      if (t.code === 3) board.code3Right += 1;
    }
    board.confusion[t.code === 3 ? 0 : 1][jev.code === 3 ? 0 : 1] += 1;
    if ((jev.threat > 0.5) === t.threat) board.threatRight += 1;
    if ((jev.als > 0.5) === t.als) board.alsRight += 1;
    if (t.als) {
      board.alsTotal += 1;
      if (jev.als > 0.5) board.alsCaught += 1;
    }
    if (jev.lead === t.lead) board.leadRight += 1;
    if (jev.units === unitsLabel(t.units)) board.unitsRight += 1;
    const actual = bucket(t.responseMin);
    if (actual !== null) {
      board.responseScored += 1;
      if (jev.response === actual) board.responseExact += 1;
      if (Math.abs(jev.response - actual) <= 1) board.responseWithinOne += 1;
    }
  }
}

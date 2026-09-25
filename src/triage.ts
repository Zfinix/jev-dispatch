import type { Call } from "./calls";
import type { City } from "./cities";
import type { Answer, Question } from "./jev";

export const BATCH = 10;

export type Scored = { call: Call; jev: Record<string, string>; confidence: number; latencyMs: number };

export function questionsFor(city: City, batch: Call[]): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const c of batch) for (const a of city.aspects) questions[`${c.id}.${a.key}`] = a.ask(c);
  return questions;
}

export function verdicts(city: City, batch: Call[], answers: Record<string, Answer>, latencyMs: number): Scored[] {
  return batch.map((call) => {
    const jev: Record<string, string> = {};
    for (const a of city.aspects) jev[a.key] = a.read(answers[`${call.id}.${a.key}`]);
    const first = answers[`${call.id}.${city.aspects[0].key}`];
    const confidence = first?.type === "choice" ? (first.probabilities[first.choice] ?? first.confidence) : first?.type === "noul" ? Math.max(first.noul, 1 - first.noul) : first?.type === "score" ? first.confidence : 0;
    return { call, jev, confidence, latencyMs };
  });
}

// Per aspect: how often Jev matched the dispatcher exactly or nearly, and how
// often a dumb baseline would have by always guessing the most common answer.
export type Tally = { scored: number; exact: number; near: number; counts: Record<string, number>; confusion: Record<string, Record<string, number>> };
export type Board = { calls: number; batches: number; latencyTotal: number; aspects: Record<string, Tally> };

export const emptyBoard = (city: City): Board => ({ calls: 0, batches: 0, latencyTotal: 0, aspects: Object.fromEntries(city.aspects.map((a) => [a.key, { scored: 0, exact: 0, near: 0, counts: {}, confusion: {} }])) });

export function score(city: City, board: Board, scored: Scored[], latencyMs: number) {
  board.batches += 1;
  board.latencyTotal += latencyMs;
  for (const { call, jev } of scored) {
    board.calls += 1;
    for (const a of city.aspects) {
      const truth = call.truth[a.key];
      if (truth === null || truth === undefined) continue;
      const t = board.aspects[a.key];
      t.scored += 1;
      t.counts[truth] = (t.counts[truth] ?? 0) + 1;
      if (jev[a.key] === truth) t.exact += 1;
      if (a.near ? a.near(jev[a.key], truth) : jev[a.key] === truth) t.near += 1;
      t.confusion[truth] ??= {};
      t.confusion[truth][jev[a.key]] = (t.confusion[truth][jev[a.key]] ?? 0) + 1;
    }
  }
}

// What "always guess the most common answer" would have scored so far.
export function baseline(city: City, tally: Tally, key: string): { exact: number; near: number; guess: string } {
  const aspect = city.aspects.find((a) => a.key === key)!;
  const guess = Object.entries(tally.counts).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "";
  const exact = tally.counts[guess] ?? 0;
  const near = Object.entries(tally.counts).reduce((n, [truth, count]) => n + ((aspect.near ? aspect.near(guess, truth) : guess === truth) ? count : 0), 0);
  return { exact, near, guess };
}

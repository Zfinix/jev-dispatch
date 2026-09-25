const BASE_URL = "https://api.typesafe.ai";
const MODEL = "jev-latest";
const TIMEOUT_MS = 15_000;
const RETRIES = 2;

export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export type Usage = { calls: number; inputTokens: number; outputTokens: number; millis: number };

export class Jev {
  readonly usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, millis: 0 };
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private readonly apiKey: string,
    private readonly concurrency = 3,
  ) {}

  async evaluate(state: string, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    await this.acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        const started = performance.now();
        const response = await fetch(`${BASE_URL}/v1/systemone`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: MODEL, state, questions }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const body = (await response.json()) as {
          answers: Record<string, Answer>;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        this.usage.calls++;
        this.usage.millis += performance.now() - started;
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
          continue;
        }
        if (!response.ok) throw new Error(`Jev returned ${response.status}: ${JSON.stringify(body)}`);
        this.usage.inputTokens += body.usage?.input_tokens ?? 0;
        this.usage.outputTokens += body.usage?.output_tokens ?? 0;
        return body.answers;
      }
    } finally {
      this.release();
    }
  }

  private async acquire() {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}

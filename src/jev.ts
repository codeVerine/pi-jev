import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  JevEvaluationRequest,
  JevEvaluationResponse,
  JevAnswerResult,
  JevSessionStats,
  QuestionConfig,
} from "./types.js";

export type ApiKeySource = "env" | "file";

export const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v4/ai";
export const GATEWAY_JEV_MODEL = "typesafe-ai/jev";

/** Vercel AI Gateway key, used only when no TypeSafe key or custom endpoint is configured. */
export function resolveGatewayKeySource(): { key: string; origin: string } | null {
  const envKey = process.env.AI_GATEWAY_API_KEY?.trim();
  if (envKey) return { key: envKey, origin: "$AI_GATEWAY_API_KEY" };

  const secretPath = path.join(os.homedir(), ".pi", "agent", "secrets", "ai_gateway_api_key");
  try {
    const content = fs.readFileSync(secretPath, "utf8").trim();
    if (content) return { key: content, origin: "~/.pi/agent/secrets/ai_gateway_api_key" };
  } catch {
    // Missing or unreadable file means no file-based key
  }
  return null;
}

export function resolveGatewayKey(): string | null {
  return resolveGatewayKeySource()?.key ?? null;
}

export function resolveBaseURL(): string | null {
  return process.env.PI_JEV_BASE_URL?.trim() || process.env.TYPESAFE_BASE_URL?.trim() || null;
}

/** Resolve the API key together with where it came from, for status reporting. */
export function resolveApiKeySource(): { key: string; source: ApiKeySource; origin: string } | null {
  const envKey = process.env.TYPESAFE_API_KEY?.trim();
  if (envKey) return { key: envKey, source: "env", origin: "$TYPESAFE_API_KEY" };

  const defaultSecretPath = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "secrets",
    "typesafe_api_key"
  );
  if (fs.existsSync(defaultSecretPath)) {
    try {
      const content = fs.readFileSync(defaultSecretPath, "utf8").trim();
      if (content) {
        return { key: content, source: "file", origin: "~/.pi/agent/secrets/typesafe_api_key" };
      }
    } catch {
      // Ignore read errors
    }
  }

  return null;
}

function resolveApiKey(): string | null {
  return resolveApiKeySource()?.key ?? null;
}

export class JevClient {
  private client: TypeSafeClient | null = null;
  private apiKey: string | null = null;
  private apiKeySetInSession = false;
  private baseURL: string | null = null;
  public stats: JevSessionStats = {
    requestsCount: 0,
    totalTokens: 0,
  };

  constructor() {
    this.apiKey = resolveApiKey();
    this.baseURL = resolveBaseURL();
  }

  public isConfigured(): boolean {
    return Boolean(resolveApiKeySource() || this.apiKey || this.getBaseURL() || resolveGatewayKey());
  }

  /** True when requests go through Vercel AI Gateway instead of the TypeSafe API. */
  public usesGateway(): boolean {
    return !resolveApiKeySource() && !this.apiKey && !this.getBaseURL() && Boolean(resolveGatewayKey());
  }

  /** Human-readable description of where the API key came from, or null when unconfigured. */
  public getKeyOrigin(): string | null {
    if (this.apiKeySetInSession) return "set in-session";
    if (this.usesGateway()) return resolveGatewayKeySource()?.origin ?? null;
    return resolveApiKeySource()?.origin ?? null;
  }

  public getBaseURL(): string | null {
    return resolveBaseURL() || this.baseURL;
  }

  public setApiKey(key: string): void {
    this.apiKey = key;
    this.apiKeySetInSession = true;
    this.client = null;
  }

  private getClient(): TypeSafeClient {
    const key = resolveApiKey() || this.apiKey;
    const baseURL = this.getBaseURL();
    if (!key && !baseURL) {
      throw new Error("Missing TYPESAFE_API_KEY. Set it in environment, ~/.pi/agent/secrets/typesafe_api_key, set PI_JEV_BASE_URL for a compatible local endpoint, or set AI_GATEWAY_API_KEY (or ~/.pi/agent/secrets/ai_gateway_api_key) for Vercel AI Gateway.");
    }
    if (!this.client) {
      this.client = new TypeSafeClient({ apiKey: key ?? "", ...(baseURL ? { baseURL } : {}) });
    }
    return this.client;
  }

  public async evaluate(
    request: JevEvaluationRequest,
    signal?: AbortSignal
  ): Promise<JevEvaluationResponse> {
    const startTime = Date.now();
    const gateway = this.usesGateway();
    const client = gateway ? null : this.getClient();

    const formattedQuestions: Record<string, any> = {};
    for (const [id, q] of Object.entries(request.questions)) {
      if (q.type === "choice") {
        formattedQuestions[id] = choice(q.instructions, q.criteria);
      } else if (q.type === "noul") {
        formattedQuestions[id] = noul(q.instructions);
      } else if (q.type === "score") {
        formattedQuestions[id] = score(q.instructions, q.criteria as any);
      }
    }

    const statePayload: any =
      typeof request.state === "string" ? { text: request.state } : request.state;

    try {
      const response: any = client
        ? await client.systemOne({
            state: statePayload,
            questions: formattedQuestions,
            model: request.model,
          }, { signal })
        : await evaluateViaGateway(resolveGatewayKey() ?? "", statePayload, request, signal);

      const elapsedMs = Date.now() - startTime;
      this.stats.requestsCount += 1;
      const usage = response.usage;
      this.stats.totalTokens += (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
      this.stats.lastElapsedMs = elapsedMs;

      const answers: Record<string, JevAnswerResult> = {};
      for (const [id, rawAns] of Object.entries(response.answers || {})) {
        const qConfig = request.questions[id];
        if (!qConfig) continue;

        if (qConfig.type === "choice") {
          const c = (rawAns as any).choice ?? (rawAns as any).value;
          answers[id] = {
            type: "choice",
            value: c,
            confidence: (rawAns as any).confidence,
            distribution: (rawAns as any).probabilities ?? (rawAns as any).distribution,
            raw: rawAns,
          };
        } else if (qConfig.type === "noul") {
          const prob = (rawAns as any).noul ?? (rawAns as any).probability ?? (rawAns as any).value ?? 0;
          answers[id] = {
            type: "noul",
            value: prob,
            raw: rawAns,
          };
        } else if (qConfig.type === "score") {
          const s = (rawAns as any).score ?? (rawAns as any).value ?? 0;
          answers[id] = {
            type: "score",
            value: s,
            confidence: (rawAns as any).confidence,
            distribution: (rawAns as any).probabilities ?? (rawAns as any).distribution,
            raw: rawAns,
          };
        }
      }

      return {
        answers,
        model: response.model || (gateway ? GATEWAY_JEV_MODEL : "jev-latest"),
        usage: response.usage,
        elapsedMs,
      };
    } catch (err: any) {
      this.stats.lastError = err?.message || String(err);
      throw err;
    }
  }
}

/**
 * Vercel AI Gateway serves Jev through the AI SDK evaluation-model protocol rather than TypeSafe's
 * /v1/systemone. Answers are reshaped to the TypeSafe fields `evaluate()` already parses.
 */
async function evaluateViaGateway(
  apiKey: string,
  state: unknown,
  request: JevEvaluationRequest,
  signal?: AbortSignal
): Promise<any> {
  const questions: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(request.questions)) {
    questions[id] = q.type === "noul"
      ? { type: "boolean", instructions: q.instructions }
      : { type: q.type, instructions: q.instructions, criteria: q.criteria };
  }

  const res = await fetchWithRetry(`${GATEWAY_BASE_URL}/evaluation-model`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "ai-model-id": request.model?.includes("/") ? request.model : GATEWAY_JEV_MODEL,
      "ai-evaluation-model-specification-version": "4",
      "ai-gateway-protocol-version": "0.0.1",
      "ai-gateway-auth-method": "api-key",
    },
    body: JSON.stringify({ state, questions }),
    signal,
  });

  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = typeof body?.error?.message === "string" ? `: ${body.error.message}` : "";
    throw new Error(`Jev gateway request failed (HTTP ${res.status})${detail}`);
  }

  const confidence: Record<string, number> = body?.providerMetadata?.typesafe?.confidence ?? {};
  const answers: Record<string, unknown> = {};
  for (const [id, answer] of Object.entries<any>(body?.answers ?? {})) {
    answers[id] = id in confidence ? { ...answer, confidence: confidence[id] } : answer;
  }
  return {
    answers,
    model: body?.model,
    usage: { input_tokens: body?.usage?.inputTokens, output_tokens: body?.usage?.outputTokens },
  };
}

export const GATEWAY_MAX_RETRIES = 2;
const GATEWAY_RETRY_BASE_MS = 250;
const GATEWAY_MAX_RETRY_AFTER_MS = 10_000;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelayMs(attempt: number, res?: Response): number {
  const backoff = GATEWAY_RETRY_BASE_MS * 2 ** attempt;
  const retryAfterSeconds = Number(res?.headers.get("retry-after") ?? NaN);
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) return backoff;
  return Math.min(Math.max(backoff, retryAfterSeconds * 1_000), GATEWAY_MAX_RETRY_AFTER_MS);
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Matches the TypeSafe SDK's default retry policy (two retries on 408, 429, 5xx and connection
 * errors), which the gateway path would otherwise lack. The caller's signal bounds the total time.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch(url, init);
      if (res.ok || !isRetryableStatus(res.status) || attempt === GATEWAY_MAX_RETRIES) return res;
      await res.body?.cancel();
    } catch (err) {
      if (init.signal?.aborted || attempt === GATEWAY_MAX_RETRIES) throw err;
    }
    await sleep(retryDelayMs(attempt, res), init.signal);
  }
}

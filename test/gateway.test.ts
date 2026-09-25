import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { GATEWAY_BASE_URL, GATEWAY_MAX_RETRIES, JevClient } from "../src/jev.js";

const OLD_ENV = { ...process.env };
const OLD_FETCH = globalThis.fetch;

test.afterEach(() => {
  process.env = { ...OLD_ENV };
  globalThis.fetch = OLD_FETCH;
});

function gatewayOnly() {
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.PI_JEV_BASE_URL;
  delete process.env.TYPESAFE_BASE_URL;
  process.env.HOME = "/nonexistent-pi-jev-test-home";
  process.env.AI_GATEWAY_API_KEY = "vck_test";
}

function mockFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

test("AI_GATEWAY_API_KEY configures Jev through Vercel AI Gateway only as a fallback", () => {
  gatewayOnly();
  const client = new JevClient();
  assert.equal(client.isConfigured(), true);
  assert.equal(client.usesGateway(), true);
  assert.equal(client.getKeyOrigin(), "$AI_GATEWAY_API_KEY");

  process.env.TYPESAFE_API_KEY = "ts_key";
  assert.equal(new JevClient().usesGateway(), false);

  delete process.env.TYPESAFE_API_KEY;
  process.env.PI_JEV_BASE_URL = "http://localhost:8000";
  assert.equal(new JevClient().usesGateway(), false);

  delete process.env.PI_JEV_BASE_URL;
  const inSession = new JevClient();
  inSession.setApiKey("runtime");
  assert.equal(inSession.usesGateway(), false);
});

test("gateway requests use the evaluation-model protocol and map answers to Jev results", async () => {
  gatewayOnly();
  const calls = mockFetch(200, {
    model: "typesafe-ai/jev",
    answers: {
      billing: { type: "boolean", probability: 0.96 },
      cat: { type: "choice", choice: "billing", probabilities: { billing: 0.97, bug: 0.03 } },
    },
    usage: { inputTokens: 332, outputTokens: 54 },
    providerMetadata: { typesafe: { confidence: { cat: 0.99 } } },
  });

  const client = new JevClient();
  const res = await client.evaluate({
    state: "Payment failed: card expired",
    questions: {
      billing: { type: "noul", instructions: "Is this a billing issue?" },
      cat: { type: "choice", instructions: "Category?", criteria: { billing: "Billing", bug: null } },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${GATEWAY_BASE_URL}/evaluation-model`);
  assert.equal(calls[0].init.headers.authorization, "Bearer vck_test");
  assert.equal(calls[0].init.headers["ai-model-id"], "typesafe-ai/jev");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.state, { text: "Payment failed: card expired" });
  assert.deepEqual(body.questions.billing, { type: "boolean", instructions: "Is this a billing issue?" });
  assert.equal(body.questions.cat.type, "choice");

  assert.equal(res.answers.billing.type, "noul");
  assert.equal(res.answers.billing.value, 0.96);
  assert.equal(res.answers.cat.value, "billing");
  assert.equal(res.answers.cat.confidence, 0.99);
  assert.deepEqual(res.answers.cat.distribution, { billing: 0.97, bug: 0.03 });
  assert.equal(res.model, "typesafe-ai/jev");
  assert.equal(client.stats.requestsCount, 1);
  assert.equal(client.stats.totalTokens, 386);
});

test("gateway errors report the HTTP status without leaking the key", async () => {
  gatewayOnly();
  mockFetch(401, { error: { message: "Invalid API key" } });
  const client = new JevClient();

  await assert.rejects(
    client.evaluate({ state: "x", questions: { ok: { type: "noul", instructions: "ok?" } } }),
    (err: Error) => /HTTP 401\): Invalid API key/.test(err.message) && !err.message.includes("vck_test")
  );
  assert.match(client.stats.lastError ?? "", /HTTP 401/);
});

function mockFetchSequence(statuses: number[]) {
  const calls: number[] = [];
  globalThis.fetch = (async () => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)];
    calls.push(status);
    return new Response(JSON.stringify(status === 200 ? { answers: {} } : { error: { message: "Service temporarily unavailable" } }), { status });
  }) as typeof fetch;
  return calls;
}

test("gateway retries transient failures like the TypeSafe SDK", async () => {
  gatewayOnly();
  const recovered = mockFetchSequence([503, 429, 200]);
  await new JevClient().evaluate({ state: "x", questions: {} });
  assert.deepEqual(recovered, [503, 429, 200]);

  const exhausted = mockFetchSequence([503]);
  const client = new JevClient();
  await assert.rejects(client.evaluate({ state: "x", questions: {} }), /HTTP 503/);
  assert.equal(exhausted.length, GATEWAY_MAX_RETRIES + 1);
  assert.equal(client.stats.requestsCount, 0);

  const permanent = mockFetchSequence([400]);
  await assert.rejects(new JevClient().evaluate({ state: "x", questions: {} }), /HTTP 400/);
  assert.equal(permanent.length, 1);
});

test("gateway retries stop when the caller aborts", async () => {
  gatewayOnly();
  const calls = mockFetchSequence([503]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("deadline")), 50);
  await assert.rejects(new JevClient().evaluate({ state: "x", questions: {} }, controller.signal), /deadline/);
  assert.equal(calls.length, 1);
});

test("gateway passes through namespaced model ids and ignores TypeSafe model names", async () => {
  gatewayOnly();
  const calls = mockFetch(200, { answers: {} });
  const client = new JevClient();
  await client.evaluate({ state: "x", questions: {}, model: "jev-latest" });
  await client.evaluate({ state: "x", questions: {}, model: "typesafe-ai/jev-next" });
  assert.equal(calls[0].init.headers["ai-model-id"], "typesafe-ai/jev");
  assert.equal(calls[1].init.headers["ai-model-id"], "typesafe-ai/jev-next");
});

test("gateway key can come from Pi's secret store, with the env var taking precedence", (t) => {
  gatewayOnly();
  delete process.env.AI_GATEWAY_API_KEY;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-home-"));
  t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  assert.equal(new JevClient().isConfigured(), false);

  fs.mkdirSync(path.join(home, ".pi", "agent", "secrets"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi", "agent", "secrets", "ai_gateway_api_key"), "vck_file\n");
  const fromFile = new JevClient();
  assert.equal(fromFile.usesGateway(), true);
  assert.equal(fromFile.getKeyOrigin(), "~/.pi/agent/secrets/ai_gateway_api_key");

  process.env.AI_GATEWAY_API_KEY = "vck_env";
  assert.equal(new JevClient().getKeyOrigin(), "$AI_GATEWAY_API_KEY");
  fs.rmSync(home, { recursive: true, force: true });
});

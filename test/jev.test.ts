import test from "node:test";
import assert from "node:assert/strict";
import { JevClient, resolveBaseURL } from "../src/jev.js";

const OLD_ENV = { ...process.env };

test.afterEach(() => {
  process.env = { ...OLD_ENV };
});

test("resolveBaseURL prefers PI_JEV_BASE_URL over TYPESAFE_BASE_URL", () => {
  process.env.TYPESAFE_BASE_URL = "http://typesafe.local";
  process.env.PI_JEV_BASE_URL = "http://pi-jev.local";

  assert.equal(resolveBaseURL(), "http://pi-jev.local");
});

test("custom endpoint configures JevClient without API key", () => {
  delete process.env.TYPESAFE_API_KEY;
  process.env.PI_JEV_BASE_URL = "http://localhost:8000";

  const client = new JevClient();

  assert.equal(client.isConfigured(), true);
  assert.equal(client.getBaseURL(), "http://localhost:8000");
});

test("JevClient stats sum SDK snake_case token usage", async () => {
  const client = new JevClient();
  client.setApiKey("test-key");
  (client as any).client = {
    systemOne: async () => ({
      model: "jev-test",
      usage: { input_tokens: 3, output_tokens: 4 },
      answers: { pick: { choice: "yes" } },
    }),
  };

  await client.evaluate({
    state: "state",
    questions: {
      pick: { type: "choice", instructions: "pick", criteria: { yes: null } },
    },
  });

  assert.equal(client.stats.requestsCount, 1);
  assert.equal(client.stats.totalTokens, 7);
});

test("JevClient reports env key origin instead of in-session", () => {
  process.env.TYPESAFE_API_KEY = "env-key";

  const client = new JevClient();

  assert.equal(client.getKeyOrigin(), "$TYPESAFE_API_KEY");
});

test("JevClient reports explicit runtime key as in-session", () => {
  const client = new JevClient();
  client.setApiKey("runtime-key");

  assert.equal(client.getKeyOrigin(), "set in-session");
});

test("JevClient exposes SDK choice and score probabilities as distribution", async () => {
  const client = new JevClient();
  client.setApiKey("test-key");
  (client as any).client = {
    systemOne: async () => ({
      model: "jev-test",
      answers: {
        pick: { type: "choice", choice: "yes", confidence: 0.9, probabilities: { yes: 0.93, no: 0.07 } },
        grade: { type: "score", score: 2, confidence: 0.8, probabilities: { 1: 0.2, 2: 0.8 } },
      },
    }),
  };

  const res = await client.evaluate({
    state: "state",
    questions: {
      pick: { type: "choice", instructions: "pick", criteria: { yes: null, no: null } },
      grade: { type: "score", instructions: "grade", criteria: ["low", "high"] },
    },
  });

  assert.deepEqual(res.answers.pick.distribution, { yes: 0.93, no: 0.07 });
  assert.equal(res.answers.pick.confidence, 0.9);
  assert.deepEqual(res.answers.grade.distribution, { 1: 0.2, 2: 0.8 });
});

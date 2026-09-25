import test from "node:test";
import assert from "node:assert/strict";
import {
  ResultEvaluator,
  RESULT_EVAL_THRESHOLDS,
  buildResultState,
  decideResultAction,
  parseControlMode,
  type ControlMode,
} from "../src/result-eval.js";
import type { JevClient } from "../src/jev.js";

interface FixtureCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError?: boolean;
}

function turn(text: string, calls: FixtureCall[], extra: Record<string, unknown> = {}) {
  return {
    turnIndex: 1,
    outcome: "completed" as const,
    entries: [] as any[],
    message: {
      role: "assistant",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args })),
      ],
    } as any,
    toolResults: calls.map((c) => ({
      role: "toolResult",
      toolCallId: c.id,
      toolName: c.name,
      content: [{ type: "text", text: c.result }],
      isError: Boolean(c.isError),
      timestamp: 0,
    })) as any[],
    ...extra,
  };
}

function answers(goal: number, progress: number, unresolved: number, next: string, confidence?: number, distribution?: Record<string, number>) {
  return {
    goal_achieved: { type: "noul", value: goal },
    useful_progress: { type: "noul", value: progress },
    unresolved_issue: { type: "noul", value: unresolved },
    next_action: {
      type: "choice",
      value: next,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(distribution ? { distribution } : {}),
    },
  } as any;
}

function evaluator(mode: ControlMode, reply: any, configured = true) {
  const requests: any[] = [];
  const jevClient = {
    isConfigured: () => configured,
    evaluate: async (request: any, signal?: AbortSignal) => {
      requests.push({ request, signal });
      if (typeof reply === "function") return reply(signal);
      return { answers: reply, model: "jev-test", elapsedMs: 3 };
    },
  } as unknown as JevClient;
  const handlers: Record<string, Function> = {};
  const pi: any = { on: (name: string, handler: Function) => (handlers[name] = handler) };
  const evalr = new ResultEvaluator(pi, jevClient, mode);
  evalr.startRun("Fix the failing date parser test in src/date.ts");
  return { evalr, requests, handlers };
}

const edited = [{ id: "c1", name: "edit", args: { path: "src/date.ts" }, result: "Successfully replaced 1 block in src/date.ts." }];

function decisionOf(result: any) {
  return result.entries.find((e: any) => e.type === "custom" && e.customType === "jev-decision").data;
}

function notes(result: any) {
  return result.entries.filter((e: any) => e.type === "custom_message");
}

test("parseControlMode accepts only off, shadow, enforce", () => {
  assert.equal(parseControlMode(" Shadow "), "shadow");
  assert.equal(parseControlMode("enforce"), "enforce");
  assert.equal(parseControlMode("off"), "off");
  assert.equal(parseControlMode("1"), undefined);
  assert.equal(parseControlMode(true), undefined);
});

test("install applies the CLI flag once at session_start", () => {
  const { evalr, handlers } = evaluator("off", answers(0.9, 0.9, 0.1, "accept_result", 0.9));
  let flag: unknown = "enforce";
  (evalr as any).pi.getFlag = () => flag;
  evalr.install();
  handlers.session_start({}, {});
  assert.equal(evalr.mode, "enforce");

  evalr.setMode("shadow");
  flag = "off";
  handlers.session_start({}, {});
  assert.equal(evalr.mode, "shadow");
});

test("install registers turn_end and resets run state on before_agent_start", async () => {
  const { evalr, handlers, requests } = evaluator("shadow", answers(0.9, 0.9, 0.1, "accept_result", 0.9));
  evalr.install();
  assert.ok(handlers.turn_end && handlers.before_agent_start);
  handlers.before_agent_start({ prompt: "second request" });
  await handlers.turn_end(turn("Editing.", edited), {});
  assert.equal(requests[0].request.state.original_request, "second request");
});

test("off mode and unconfigured Jev send no request", async () => {
  const off = evaluator("off", answers(0.1, 0.1, 0.9, "retry_modified", 0.9));
  assert.equal(await off.evalr.onTurnEnd(turn("", edited)), undefined);
  assert.equal(off.requests.length, 0);

  const unconfigured = evaluator("enforce", answers(0.1, 0.1, 0.9, "retry_modified", 0.9), false);
  assert.equal(await unconfigured.evalr.onTurnEnd(turn("", edited)), undefined);
  assert.equal(unconfigured.requests.length, 0);
});

test("aborted turns, turns with only failed calls, and Jev-only turns are skipped", async () => {
  const { evalr, requests } = evaluator("enforce", answers(0.1, 0.1, 0.9, "retry_modified", 0.9));
  assert.equal(await evalr.onTurnEnd(turn("", edited, { outcome: "aborted" })), undefined);
  assert.equal(
    await evalr.onTurnEnd(turn("", [{ id: "e", name: "read", args: { path: "x" }, result: "ENOENT", isError: true }])),
    undefined
  );
  assert.equal(
    await evalr.onTurnEnd(turn("", [{ id: "j", name: "jev_find_tools", args: { query: "db" }, result: "Activated" }])),
    undefined
  );
  assert.equal(requests.length, 0);
});

test("batches the four questions into one request per tool turn", async () => {
  const { evalr, requests } = evaluator("shadow", answers(0.9, 0.9, 0.1, "accept_result", 0.9));
  await evalr.onTurnEnd(turn("Apply the fix.", edited));
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0].request.questions).sort(), [
    "goal_achieved",
    "next_action",
    "unresolved_issue",
    "useful_progress",
  ]);
  assert.equal("retry_same" in requests[0].request.questions.next_action.criteria, false);
});

test("state pairs parallel results by toolCallId and trims inputs", () => {
  const long = `${"x".repeat(2_000)}FAILED test_parse${"y".repeat(2_000)}`;
  const event = turn("Run tests and read the parser.", [
    { id: "a", name: "bash", args: { command: "npm test" }, result: long },
    { id: "b", name: "read", args: { path: "src/date.ts" }, result: "export function parse() {}" },
  ]);
  event.toolResults.reverse();

  const state = buildResultState(event, "Fix the parser", []);
  assert.equal(state.current_subgoal, "Run tests and read the parser.");
  assert.deepEqual(state.tool_calls.map((c) => [c.tool, c.input]), [
    ["read", '{"path":"src/date.ts"}'],
    ["bash", '{"command":"npm test"}'],
  ]);
  assert.ok(state.tool_calls[1].result!.length < 1_600);
  assert.match(state.tool_calls[1].result!, /chars omitted/);

  const bare = buildResultState(turn("", edited), undefined, []);
  assert.equal("current_subgoal" in bare, false);
  assert.equal("original_request" in bare, false);
});

test("recent actions carry at most six prior calls into later turns", async () => {
  const { evalr, requests } = evaluator("shadow", answers(0.9, 0.9, 0.1, "accept_result", 0.9));
  for (let i = 0; i < 8; i++) {
    await evalr.onTurnEnd(turn("", [{ id: `r${i}`, name: "grep", args: { pattern: `p${i}` }, result: "no matches" }]));
  }
  const recent = requests[7].request.state.recent_actions;
  assert.equal(recent.length, 6);
  assert.equal(recent[5].input, '{"pattern":"p6"}');
});

// Fixture 1: successful tool accomplishing the step.
test("fixture: accomplished step leaves the turn untouched", async () => {
  const { evalr } = evaluator("enforce", answers(0.93, 0.9, 0.05, "accept_result", 0.95));
  const result: any = await evalr.onTurnEnd(turn("Apply the fix to parseDate.", edited));
  assert.equal(notes(result).length, 0);
  assert.equal(decisionOf(result).action, "none");
});

// Fixture 2: successful but useless result.
test("fixture: useless successful search asks for a modified retry", async () => {
  const { evalr } = evaluator("enforce", answers(0.05, 0.1, 0.2, "retry_modified", 0.82, { retry_modified: 0.8 }));
  const result: any = await evalr.onTurnEnd(
    turn("Find where parseDate is defined.", [{ id: "g", name: "grep", args: { pattern: "parse_date" }, result: "" }])
  );
  assert.equal(decisionOf(result).action, "retry_modified");
  assert.match(notes(result)[0].content, /Change the target or arguments/);
});

// Fixture 3: successful call revealing an unresolved problem.
test("fixture: an unresolved issue is recorded but adds no note", async () => {
  const { evalr } = evaluator("enforce", answers(0.4, 0.9, 0.85, "accept_result", 0.8));
  const result: any = await evalr.onTurnEnd(
    turn("Build the project.", [{ id: "b", name: "bash", args: { command: "npm run build" }, result: "built in 2s\nwarning: 3 type errors ignored" }])
  );
  assert.equal(decisionOf(result).decision.judgments.unresolved_issue, "yes");
  assert.equal(decisionOf(result).action, "none");
  assert.equal(notes(result).length, 0);
});

// Fixture 4: an exact retry-worthy failure is not this controller's decision.
test("fixture: failed-only turn is left to the tool guard", async () => {
  const { evalr, requests } = evaluator("enforce", answers(0.1, 0.1, 0.9, "retry_modified", 0.99));
  const result = await evalr.onTurnEnd(
    turn("", [{ id: "n", name: "bash", args: { command: "npm install" }, result: "ETIMEDOUT registry.npmjs.org", isError: true }])
  );
  assert.equal(result, undefined);
  assert.equal(requests.length, 0);
});

// Fixture 6: investigation is what the agent is already doing.
test("fixture: a confident investigate choice is recorded but adds no note", async () => {
  const { evalr } = evaluator("enforce", answers(0.4, 0.7, 0.9, "investigate", 0.96));
  const result: any = await evalr.onTurnEnd(
    turn("Check why the service returns 500.", [{ id: "c", name: "bash", args: { command: "curl -s localhost:3000/health" }, result: "{\"status\":\"degraded\"}" }])
  );
  assert.equal(decisionOf(result).decision.nextAction, "investigate");
  assert.equal(decisionOf(result).action, "none");
  assert.equal(notes(result).length, 0);
});

// Fixture 7: genuine user clarification.
test("fixture: ask_user needs its higher threshold", async () => {
  const confident = evaluator("enforce", answers(0.1, 0.3, 0.4, "ask_user", 0.9));
  const clarify: any = await confident.evalr.onTurnEnd(
    turn("Look up the deploy target.", [{ id: "d", name: "read", args: { path: ".env.example" }, result: "DEPLOY_TARGET=<ask ops>" }])
  );
  assert.equal(decisionOf(clarify).action, "ask_user");

  const unsure = evaluator("enforce", answers(0.1, 0.3, 0.4, "ask_user", 0.84));
  const kept: any = await unsure.evalr.onTurnEnd(turn("", edited));
  assert.equal(decisionOf(kept).action, "none");
});

test("goal confidently achieved overrides a contradicting retry choice", () => {
  const decision = decideResultAction(answers(0.9, 0.9, 0.1, "retry_modified", 0.95));
  assert.equal(decision?.action, "none");
});

test("thresholds are inclusive at the exact boundary", () => {
  const t = RESULT_EVAL_THRESHOLDS;
  assert.equal(decideResultAction(answers(0.5, 0.5, 0.5, "retry_modified", t.next_action.retry_modified))?.action, "retry_modified");
  assert.equal(decideResultAction(answers(0.5, 0.5, 0.5, "retry_modified", t.next_action.retry_modified - 0.01))?.action, "none");
  assert.equal(decideResultAction(answers(0.5, 0.5, t.unresolved_issue.yes, "accept_result", 0.9))?.action, "none");
  assert.equal(decideResultAction(answers(t.goal_achieved.yes, 0.5, 0.5, "stop_failure", 0.99))?.action, "none");
  assert.equal(decideResultAction(answers(t.goal_achieved.no, 0.5, 0.5, "accept_result", 0.9))?.judgments.goal_achieved, "no");
});

test("ambiguous probabilities and escalate preserve normal behavior", () => {
  assert.equal(decideResultAction(answers(0.5, 0.5, 0.5, "investigate", 0.5))?.action, "none");
  assert.equal(decideResultAction(answers(0.1, 0.1, 0.5, "escalate", 0.99))?.action, "none");
  assert.equal(decideResultAction(answers(0.1, 0.1, 0.5, "accept_result", 0.99))?.action, "none");
});

test("choice confidence is the weaker of reported confidence and option probability", () => {
  const decision = decideResultAction(answers(0.1, 0.1, 0.5, "stop_failure", 0.95, { stop_failure: 0.6, escalate: 0.4 }));
  assert.equal(decision?.nextActionConfidence, 0.6);
  assert.equal(decision?.action, "none");
  assert.equal(decideResultAction(answers(0.1, 0.1, 0.5, "investigate"))?.action, "none");
});

test("malformed answers fall back without changing the turn", async () => {
  assert.equal(decideResultAction({ ...answers(0.1, 0.1, 0.5, "investigate", 0.9), goal_achieved: { type: "noul", value: "yes" } } as any), null);
  assert.equal(decideResultAction(answers(0.1, 0.1, 0.5, "retry_same", 0.9)), null);

  const { evalr } = evaluator("enforce", { goal_achieved: { type: "noul", value: 2 } });
  const result: any = await evalr.onTurnEnd(turn("", edited));
  assert.equal(decisionOf(result).fallback, "malformed");
  assert.equal(notes(result).length, 0);
});

test("Jev errors and timeouts fall back without changing the turn", async () => {
  const failing = evaluator("enforce", () => {
    throw new Error("503 upstream");
  });
  const failed: any = await failing.evalr.onTurnEnd(turn("", edited));
  assert.equal(decisionOf(failed).fallback, "error");
  assert.equal(notes(failed).length, 0);

  let aborted = false;
  const hanging = evaluator("enforce", (signal: AbortSignal) =>
    new Promise(() => signal.addEventListener("abort", () => (aborted = true)))
  );
  hanging.evalr.timeoutMs = 10;
  const timedOut: any = await hanging.evalr.onTurnEnd(turn("", edited));
  assert.equal(decisionOf(timedOut).fallback, "timeout");
  assert.equal(notes(timedOut).length, 0);
  assert.equal(aborted, true);
});

test("shadow mode records the would-be action and changes nothing else", async () => {
  const prior = { type: "custom" as const, customType: "other-extension", data: 1 };
  const { evalr } = evaluator("shadow", answers(0.05, 0.1, 0.2, "retry_modified", 0.9));
  const result: any = await evalr.onTurnEnd({ ...turn("", edited), entries: [prior] });
  assert.equal(result.continue, undefined);
  assert.deepEqual(result.entries[0], prior);
  assert.equal(notes(result).length, 0);
  const record = decisionOf(result);
  assert.equal(record.mode, "shadow");
  assert.equal(record.action, "retry_modified");
  assert.equal(record.applied, false);
});

test("enforce mode appends one note, keeps earlier entries, and never requests continuation", async () => {
  const prior = { type: "custom" as const, customType: "other-extension", data: 1 };
  const { evalr } = evaluator("enforce", answers(0.05, 0.1, 0.2, "stop_failure", 0.95));
  const result: any = await evalr.onTurnEnd({ ...turn("", edited), entries: [prior] });
  assert.equal(result.continue, undefined);
  assert.deepEqual(result.entries[0], prior);
  assert.equal(notes(result).length, 1);
  assert.equal(notes(result)[0].customType, "jev-result");
  const record = decisionOf(result);
  assert.equal(record.applied, true);
  assert.deepEqual(record.thresholds, RESULT_EVAL_THRESHOLDS);
  assert.equal(record.model, "jev-test");
  assert.ok(record.inputChars > 0);
});

test("decision records never persist tool output", async () => {
  const { evalr } = evaluator("shadow", answers(0.9, 0.9, 0.1, "accept_result", 0.9));
  const secret = "AKIA-SECRET-OUTPUT";
  const result: any = await evalr.onTurnEnd(turn("", [{ id: "s", name: "bash", args: { command: "env" }, result: secret }]));
  assert.equal(JSON.stringify(decisionOf(result)).includes(secret), false);
});

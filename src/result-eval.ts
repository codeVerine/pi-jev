import type {
  ExtensionAPI,
  SessionBoundaryDraft,
  TurnEndEvent,
  TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import type { JevClient } from "./jev.js";
import type { JevAnswerResult, JevEvaluationRequest, JevEvaluationResponse, QuestionConfig } from "./types.js";
import { isJevTool } from "./types.js";

export type ControlMode = "off" | "shadow" | "enforce";

export const RESULT_EVAL_FLAG = "jev-result-eval";

export function parseControlMode(raw: unknown): ControlMode | undefined {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return value === "off" || value === "shadow" || value === "enforce" ? value : undefined;
}

export type NextAction =
  | "accept_result"
  | "retry_modified"
  | "investigate"
  | "ask_user"
  | "stop_failure"
  | "escalate";

/** Control action applied in enforce mode. `none` leaves the turn untouched. */
export type ResultControlAction = "none" | "retry_modified" | "ask_user" | "stop_failure";

export type Judgment = "yes" | "no" | "uncertain";

/**
 * Starting hypotheses, not calibrated values. Every decision record stores the thresholds it used
 * so they can be tuned from shadow-mode sessions.
 *
 * Only course changes intervene. `investigate` and `unresolved_issue` are recorded but never acted
 * on: in shadow sessions Jev chose them on most exploration and debugging turns, where gathering
 * more information is what the agent was already doing, so a note there is noise.
 */
export const RESULT_EVAL_THRESHOLDS = {
  goal_achieved: { yes: 0.85, no: 0.25 },
  useful_progress: { yes: 0.65, no: 0.25 },
  unresolved_issue: { yes: 0.7, no: 0.2 },
  next_action: {
    retry_modified: 0.7,
    ask_user: 0.85,
    stop_failure: 0.9,
  },
} as const;

export const RESULT_EVAL_TIMEOUT_MS = 5_000;

const REQUEST_CHARS = 2_000;
const SUBGOAL_CHARS = 1_000;
const INPUT_CHARS = 500;
const RESULT_CHARS = 1_500;
const RECENT_INPUT_CHARS = 160;
const RECENT_ACTIONS = 6;

// `retry_same` is deliberately absent: Pi gives extensions no way to re-run a tool call, so only
// the main model can act on any retry decision.
const NEXT_ACTION_CRITERIA: Record<NextAction, string> = {
  accept_result: "The results are sufficient for the current step.",
  retry_modified: "The same kind of operation should be attempted again, but its target or arguments need to change.",
  investigate: "More information should be gathered before deciding how to proceed.",
  ask_user: "Material information is missing and the user is the only reasonable source for it.",
  stop_failure: "The current step cannot reasonably be completed with the available tools or context.",
  escalate: "Choosing the next step requires open-ended reasoning.",
};

const RESULT_QUESTIONS: Record<string, QuestionConfig> = {
  goal_achieved: {
    type: "noul",
    instructions:
      "Based only on the tool results and the current step (current_subgoal, or the tool calls themselves when it is absent), did these tool calls accomplish the current step?",
  },
  useful_progress: {
    type: "noul",
    instructions:
      "Do these tool results provide information or changes that materially advance the original request, even if the current step is not fully accomplished?",
  },
  unresolved_issue: {
    type: "noul",
    instructions:
      "Do these tool results reveal a materially unresolved problem, such as a failing check, a warning, or unexpected output, that should be investigated before the related work can be considered complete?",
  },
  next_action: {
    type: "choice",
    instructions: "Which control action best fits these tool results for the current step?",
    criteria: NEXT_ACTION_CRITERIA,
  },
};

const NOTES: Record<Exclude<ResultControlAction, "none">, string> = {
  retry_modified:
    "The last tool results do not accomplish the current step. Change the target or arguments before retrying instead of repeating the same call.",
  ask_user:
    "Information needed for this step appears to be missing, and only the user can provide it. Consider asking the user before continuing.",
  stop_failure:
    "This step does not look achievable with the current tools or context. Explain the blocker instead of retrying.",
};

export interface ToolCallSummary {
  tool: string;
  input: string;
  is_error: boolean;
  result?: string;
}

export interface ResultEvalState {
  original_request?: string;
  current_subgoal?: string;
  tool_calls: ToolCallSummary[];
  recent_actions: ToolCallSummary[];
}

export interface ResultDecision {
  judgments: Record<"goal_achieved" | "useful_progress" | "unresolved_issue", Judgment>;
  nextAction: NextAction;
  nextActionConfidence?: number;
  action: ResultControlAction;
}

export interface ResultDecisionRecord {
  kind: "result_evaluation";
  stage: "turn_end";
  mode: Exclude<ControlMode, "off">;
  turnIndex: number;
  tools: string[];
  model?: string;
  latencyMs: number;
  inputChars: number;
  answers?: Record<string, { value: unknown; confidence?: number; distribution?: Record<string, number> }>;
  thresholds: typeof RESULT_EVAL_THRESHOLDS;
  decision?: ResultDecision;
  action: ResultControlAction;
  applied: boolean;
  fallback?: "timeout" | "error" | "malformed";
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Keeps both ends: errors and summaries usually sit at the tail of tool output. */
function headTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…[${text.length - max} chars omitted]…\n${text.slice(-half)}`;
}

function stringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (part?.type === "text" ? part.text : part?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

export function buildResultState(
  event: Pick<TurnEndEvent, "message" | "toolResults">,
  originalRequest: string | undefined,
  recentActions: ToolCallSummary[]
): ResultEvalState {
  const message: any = event.message;
  const content: any[] = Array.isArray(message?.content) ? message.content : [];
  const subgoal = content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const argsById = new Map<string, unknown>(
    content.filter((part) => part?.type === "toolCall").map((part) => [part.id, part.arguments])
  );

  const toolCalls = event.toolResults
    .filter((result) => !isJevTool(result.toolName))
    .map((result) => ({
      tool: result.toolName,
      input: clip(stringify(argsById.get(result.toolCallId) ?? {}), INPUT_CHARS),
      is_error: result.isError,
      result: headTail(contentText(result.content), RESULT_CHARS),
    }));

  return {
    ...(originalRequest ? { original_request: clip(originalRequest, REQUEST_CHARS) } : {}),
    ...(subgoal ? { current_subgoal: clip(subgoal, SUBGOAL_CHARS) } : {}),
    tool_calls: toolCalls,
    recent_actions: recentActions,
  };
}

function judge(value: number, threshold: { yes: number; no: number }): Judgment {
  if (value >= threshold.yes) return "yes";
  if (value <= threshold.no) return "no";
  return "uncertain";
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Choice confidence is the weaker of the reported confidence and the selected option's probability,
 * using whichever of the two the endpoint returned.
 */
function choiceConfidence(answer: JevAnswerResult): number | undefined {
  const signals = [answer.confidence, answer.distribution?.[String(answer.value)]].filter(isProbability);
  return signals.length ? Math.min(...signals) : undefined;
}

function isIntervention(action: NextAction): action is keyof typeof RESULT_EVAL_THRESHOLDS.next_action {
  return action in RESULT_EVAL_THRESHOLDS.next_action;
}

/** Returns null when the answers are malformed; callers then preserve normal Pi behavior. */
export function decideResultAction(answers: Record<string, JevAnswerResult>): ResultDecision | null {
  const goal = answers.goal_achieved?.value;
  const progress = answers.useful_progress?.value;
  const unresolved = answers.unresolved_issue?.value;
  const next = answers.next_action;
  if (!isProbability(goal) || !isProbability(progress) || !isProbability(unresolved)) return null;
  if (!next || typeof next.value !== "string" || !(next.value in NEXT_ACTION_CRITERIA)) return null;

  const t = RESULT_EVAL_THRESHOLDS;
  const judgments = {
    goal_achieved: judge(goal, t.goal_achieved),
    useful_progress: judge(progress, t.useful_progress),
    unresolved_issue: judge(unresolved, t.unresolved_issue),
  };
  const nextAction = next.value as NextAction;
  const confidence = choiceConfidence(next);
  const threshold = isIntervention(nextAction) ? t.next_action[nextAction] : undefined;
  const confident = threshold !== undefined && confidence !== undefined && confidence >= threshold;
  // A confidently achieved step contradicts any course change.
  const action: ResultControlAction =
    confident && judgments.goal_achieved !== "yes" ? (nextAction as ResultControlAction) : "none";

  return {
    judgments,
    nextAction,
    ...(confidence !== undefined ? { nextActionConfidence: confidence } : {}),
    action,
  };
}

export async function evaluateWithDeadline(
  jevClient: JevClient,
  request: JevEvaluationRequest,
  timeoutMs: number,
  parent?: AbortSignal
): Promise<JevEvaluationResponse> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ResultEvalTimeout());
    }, timeoutMs);
  });

  try {
    return await Promise.race([jevClient.evaluate(request, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  }
}

class ResultEvalTimeout extends Error {
  constructor() {
    super("Jev result evaluation timed out");
  }
}

/**
 * Judges completed tool turns at `turn_end`, after every sibling tool result in the batch exists.
 * Enforce mode only appends a fixed note to context; it never requests extra model turns.
 */
export class ResultEvaluator {
  public mode: ControlMode;
  public last?: ResultDecisionRecord;
  public timeoutMs = RESULT_EVAL_TIMEOUT_MS;
  private originalRequest?: string;
  private recentActions: ToolCallSummary[] = [];

  constructor(
    private pi: ExtensionAPI,
    private jevClient: JevClient,
    mode: ControlMode = "off"
  ) {
    this.mode = mode;
  }

  public setMode(mode: ControlMode): void {
    this.mode = mode;
  }

  public install(): void {
    let flagApplied = false;
    this.pi.on("session_start", () => {
      // Pi resolves CLI flags only after extension factories run; apply the parsed value once.
      if (flagApplied) return;
      flagApplied = true;
      this.mode = parseControlMode(this.pi.getFlag(RESULT_EVAL_FLAG)) ?? this.mode;
    });
    this.pi.on("before_agent_start", (event) => {
      this.startRun(event.prompt);
    });
    this.pi.on("turn_end", async (event, ctx) => this.onTurnEnd(event, ctx.signal));
  }

  public startRun(prompt: string): void {
    this.originalRequest = prompt;
    this.recentActions = [];
  }

  public async onTurnEnd(
    event: Pick<TurnEndEvent, "message" | "toolResults" | "turnIndex" | "entries" | "outcome">,
    signal?: AbortSignal
  ): Promise<TurnEndEventResult | undefined> {
    if (this.mode === "off" || !this.jevClient.isConfigured()) return;
    if (event.outcome !== "completed" || event.message?.role !== "assistant") return;

    const state = buildResultState(event, this.originalRequest, this.recentActions);
    this.recentActions = [
      ...this.recentActions,
      ...state.tool_calls.map(({ tool, input, is_error }) => ({
        tool,
        input: clip(input, RECENT_INPUT_CHARS),
        is_error,
      })),
    ].slice(-RECENT_ACTIONS);

    // Failed calls are the tool guard's domain; this controller judges turns with at least one success.
    if (!state.tool_calls.some((call) => !call.is_error)) return;

    const mode = this.mode;
    const inputChars = stringify(state).length;
    const started = Date.now();
    const record: ResultDecisionRecord = {
      kind: "result_evaluation",
      stage: "turn_end",
      mode,
      turnIndex: event.turnIndex,
      tools: state.tool_calls.map((call) => call.tool),
      latencyMs: 0,
      inputChars,
      thresholds: RESULT_EVAL_THRESHOLDS,
      action: "none",
      applied: false,
    };

    try {
      const response = await evaluateWithDeadline(
        this.jevClient,
        { state: state as unknown as Record<string, unknown>, questions: RESULT_QUESTIONS },
        this.timeoutMs,
        signal
      );
      record.model = response.model;
      record.answers = Object.fromEntries(
        Object.entries(response.answers).map(([id, answer]) => [
          id,
          {
            value: answer.value,
            ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
            ...(answer.distribution ? { distribution: answer.distribution } : {}),
          },
        ])
      );
      const decision = decideResultAction(response.answers);
      if (decision) {
        record.decision = decision;
        record.action = decision.action;
      } else {
        record.fallback = "malformed";
      }
    } catch (err) {
      record.fallback = err instanceof ResultEvalTimeout ? "timeout" : "error";
    }
    record.latencyMs = Date.now() - started;

    const entries: SessionBoundaryDraft[] = [...event.entries];
    if (mode === "enforce" && record.action !== "none") {
      record.applied = true;
      entries.push({
        type: "custom_message",
        customType: "jev-result",
        display: true,
        content: `[Jev result check] ${NOTES[record.action]}`,
        details: { action: record.action, turnIndex: event.turnIndex },
      });
    }
    entries.push({ type: "custom", customType: "jev-decision", data: record });
    this.last = record;
    return { entries };
  }
}

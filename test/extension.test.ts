import test from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/index.js";

function load() {
  const defaults = new Map<string, unknown>();
  const cli = new Map<string, unknown>();
  let parsed = false;
  const handlers: Record<string, Function[]> = {};
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi: any = {
    registerFlag: (name: string, options: any) => defaults.set(name, options.default),
    // Pi only resolves CLI values after every extension factory has run.
    getFlag: (name: string) => (parsed && cli.has(name) ? cli.get(name) : defaults.get(name)),
    on: (name: string, handler: Function) => (handlers[name] ??= []).push(handler),
    events: { on: () => () => {}, emit: () => {} },
    registerTool: () => {},
    registerCommand: (_name: string, options: any) => (command = options.handler),
    getActiveTools: () => [],
    getAllTools: () => [],
  };
  extension(pi);

  const messages: string[] = [];
  const ctx: any = { ui: { setStatus: () => {}, notify: (message: string) => messages.push(message) } };
  return {
    parseCli(values: Record<string, unknown>) {
      for (const [name, value] of Object.entries(values)) cli.set(name, value);
      parsed = true;
    },
    sessionStart: () => handlers.session_start.forEach((handler) => handler({}, ctx)),
    run: async (args: string) => {
      await command!(args, ctx);
      return messages.at(-1)!;
    },
  };
}

test("CLI flags parsed after the factory still enable features", async () => {
  const ext = load();
  ext.parseCli({ "jev-auto": true, "jev-tool-guard": true, "jev-compact": true, "jev-auto-model": true, "jev-agents": true });
  ext.sessionStart();

  const status = await ext.run("status");
  assert.match(status, /Auto mode: on/);
  assert.match(status, /Auto-model: on/);
  assert.match(status, /Tool guard: on/);
  assert.match(status, /Jev compaction: on/);
  assert.match(status, /Agent orchestration: on/);
});

test("later sessions keep runtime toggles instead of reapplying CLI flags", async () => {
  const ext = load();
  ext.parseCli({ "jev-auto": true });
  ext.sessionStart();
  await ext.run("auto off");
  ext.sessionStart();

  assert.match(await ext.run("status"), /Auto mode: off/);
});

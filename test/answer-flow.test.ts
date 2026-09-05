import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { AnswerFlow, answerFormEffect, type AnswerForm, type AnswerResult } from "../src/answer-flow.js";
import { questionFields } from "../src/questions.js";
import { elicitationFields, handlePiElicitation } from "../src/elicitation.js";

const keys = new KeybindingsManager(TUI_KEYBINDINGS);
const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s } as Theme;
const tui = { terminal: { rows: 24 }, requestRender() {} } as TUI;
const down = "\x1b[B", enter = "\r", tab = "\t", back = "\x1b[Z";
const questions = [
  { question: "Which storage?", header: "Storage", multiSelect: false, options: [{ label: "SQLite", description: "Local" }, { label: "Postgres", description: "Remote" }] },
  { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "Search", description: "Find" }, { label: "Export", description: "Save" }] },
];

function harness(form: AnswerForm) {
  const results: AnswerResult[] = [];
  const ui = new AnswerFlow(tui, theme, keys, form, (r) => results.push(r));
  return { ui, results, press: (...inputs: string[]) => inputs.forEach((s) => ui.handleInput(s)) };
}

test("question flow supports multi-select, custom text, back/edit and explicit review", () => {
  const h = harness({ title: "Questions", message: "Review before sending", fields: questionFields({ questions }) });
  h.press(enter); // SQLite
  h.press(" ", down, " "); // both
  h.press(enter); // review
  assert.equal(h.results.length, 0);
  h.press(back, back, down, down, enter, "Custom storage", enter); // replace Q1 with Other
  h.press(tab, enter); // review and submit
  assert.deepEqual(h.results, [{ action: "accept", values: { "Which storage?": "Custom storage", "Which features?": ["Search", "Export"] } }]);
});

test("unanswered/draft questions block submission; cancel discards partial answers", () => {
  const h = harness({ title: "Questions", message: "", fields: questionFields({ questions }) });
  h.press(tab, tab, enter);
  assert.equal(h.results.length, 0);
  assert.match(h.ui.render(90).join("\n"), /required/);
  h.press(enter, "\x1b");
  assert.deepEqual(h.results, [{ action: "cancel" }]);
});

test("MCP fields preserve enum titles/default false, validate constraints and support omission", () => {
  const fields = elicitationFields({ mode: "form", message: "", requestedSchema: {
    type: "object", required: ["enabled", "count", "tags"], properties: {
      enabled: { type: "boolean", default: false },
      count: { type: "integer", minimum: 2, maximum: 8 },
      tags: { type: "array", items: { anyOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }] }, minItems: 1, maxItems: 1 },
      note: { type: "string", minLength: 2 },
    },
  } });
  assert.equal(fields[2]!.options![0]!.label, "Alpha");
  assert.ok(fields[1]!.validate!("1"));
  assert.ok(fields[1]!.validate!("2.5"));
  assert.ok(fields[2]!.validate!(["a", "b"]));
  const h = harness({ title: "MCP", message: "", fields, allowDecline: true });
  h.press(enter, "1", enter);
  assert.equal(h.results.length, 0);
  assert.match(h.ui.render(90).join("\n"), /must be >= 2/);
  h.press("\x7f", "3", enter, " ", enter, "\x0f", enter);
  assert.deepEqual(h.results, [{ action: "accept", values: { enabled: "false", count: "3", tags: ["a"] } }]);
});

test("empty consent distinguishes submit, decline and cancel; narrow/short rendering stays bounded", () => {
  for (const [input, action] of [[enter, "accept"], [down + "|" + enter, "decline"], ["\x1b", "cancel"]] as const) {
    const h = harness({ title: "Consent", message: "Approve?", fields: [], allowDecline: true });
    h.press(...input.split("|"));
    assert.equal(h.results[0]!.action, action);
  }
  const h = harness({ title: "Request", message: "\x1b]52;c;malicious\x07\n" + "你好 ".repeat(300), fields: questionFields({ questions }) });
  for (const width of [1, 20, 50, 100]) {
    const lines = h.ui.render(width);
    assert.ok(lines.every((s) => visibleWidth(s) <= width));
    assert.ok(lines.length <= 24);
    assert.ok(!lines.join("").includes("\x1b]52"));
  }
});

test("elicitation validates deterministic responses, declines unsupported URLs and never prompts in print", async () => {
  const form = { method: "elicitation/create" as const, params: { mode: "form" as const, message: "", requestedSchema: { type: "object" as const, properties: { count: { type: "integer" as const, minimum: 2 } }, required: ["count"] } } };
  const previous = process.env.PI_MCP_ELICITATION_RESPONSE;
  try {
    delete process.env.PI_MCP_ELICITATION_RESPONSE;
    assert.deepEqual(await handlePiElicitation("test", form, undefined), { action: "decline" });
    const ctx = { hasUI: true, ui: { select: async () => { throw new Error("Must not prompt for unsafe URLs"); }, input: async () => undefined, notify() {} } };
    assert.deepEqual(await handlePiElicitation("test", { method: "elicitation/create", params: { mode: "url", message: "Unsafe", url: "file:///tmp/unsafe", elicitationId: "unsafe" } }, ctx), { action: "decline" });
    process.env.PI_MCP_ELICITATION_RESPONSE = '{"count":1}';
    await assert.rejects(handlePiElicitation("test", form, undefined), /Invalid MCP elicitation/);
    process.env.PI_MCP_ELICITATION_RESPONSE = '{"count":3}';
    assert.deepEqual(await handlePiElicitation("test", form, undefined), { action: "accept", content: { count: 3 } });
  } finally {
    if (previous === undefined) delete process.env.PI_MCP_ELICITATION_RESPONSE; else process.env.PI_MCP_ELICITATION_RESPONSE = previous;
  }
});

test("concurrent forms serialize, interruption closes UI and releases the next waiter", async () => {
  let shown = 0, disposed = 0;
  let finish: ((result: AnswerResult) => void) | undefined;
  const ctx = { hasUI: true, mode: "tui", ui: {
    custom(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: AnswerResult) => void) => Component & { dispose?: () => void }) {
      shown++;
      return new Promise<AnswerResult>((resolve) => {
        const done = (result: AnswerResult) => { component.dispose?.(); disposed++; resolve(result); };
        const component = factory(tui, theme, keys, done);
        finish = done;
      });
    },
  } } as unknown as ExtensionContext;
  const controller = new AbortController();
  const form = { title: "Consent", message: "", fields: [] };
  const first = Effect.runPromise(answerFormEffect(ctx, form), { signal: controller.signal });
  const rejected = assert.rejects(first);
  const second = Effect.runPromise(answerFormEffect(ctx, form));
  await new Promise((r) => setImmediate(r));
  assert.equal(shown, 1);
  controller.abort();
  await rejected;
  await new Promise((r) => setImmediate(r));
  assert.equal(disposed, 1);
  assert.equal(shown, 2);
  finish!({ action: "accept", values: {} });
  assert.deepEqual(await second, { action: "accept", values: {} });
  assert.equal(disposed, 2);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import questionsExtension, { questionFields } from "../src/questions.js";

const question = { question: "__proto__", header: "Storage", options: [{ label: "SQLite", description: "Local" }, { label: "Postgres", description: "Remote" }], multiSelect: false };

test("question extension registers the bounded Claude contract and returns only confirmed human answers", async () => {
  let tool: ToolDefinition | undefined;
  questionsExtension({ registerTool: (definition: ToolDefinition) => { tool = definition; }, on() {} } as unknown as ExtensionAPI);
  assert.ok(tool);
  assert.equal(tool.name, "ask_user_question");
  assert.match(JSON.stringify(tool.parameters), /"maxItems":4/);
  assert.match(JSON.stringify(tool.parameters), /"minItems":2/);
  const unavailable = await tool.execute("test", { questions: [question] }, undefined, undefined, { hasUI: false } as ExtensionContext);
  assert.deepEqual(unavailable.details, { status: "unavailable", questions: [question], answers: {} });
  const choices: string[][] = [];
  const ctx = { hasUI: true, mode: "rpc", ui: {
    select: async (_: string, options: string[]) => { choices.push(options); return options[0]; },
    input: async () => undefined, notify() {},
  } } as unknown as ExtensionContext;
  const answered = await tool.execute("test", { questions: [question] }, undefined, undefined, ctx);
  assert.deepEqual(answered.details, { status: "answered", questions: [question], answers: { ["__proto__"]: "SQLite" } });
  assert.equal(choices.length, 2, "Question then explicit review");
  assert.ok(choices[0]!.includes("Other — type your answer"));
  assert.equal(choices[1]![0], "Submit answers");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tool.execute("test", { questions: [question] }, controller.signal, undefined, ctx));
  assert.equal(choices.length, 2, "Pre-aborted calls must not open UI");
  assert.throws(() => questionFields({ questions: [question, question] }), /unique/);
});

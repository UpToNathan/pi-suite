import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { browseMcpEffect } from "../src/mcp-browser.js";
import { handlePiElicitation } from "../src/elicitation.js";
import { McpManager } from "../src/manager.js";
import { root } from "./helpers.js";

const enter = "\r", escape = "\x1b", down = "\x1b[B";
const keys = new KeybindingsManager(TUI_KEYBINDINGS);
const theme = { fg: (_: string, text: string) => text, bold: (s: string) => s } as Theme;
const tui = { terminal: { rows: 24 }, requestRender() {} } as TUI;

function context(steps: ((component: Component) => void)[]) {
  const ctx = { mode: "tui", hasUI: true, ui: {
    input: async () => "lo",
    notify() {},
    custom(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: unknown) => void) => Component) {
      return new Promise((resolve, reject) => {
        const component = factory(tui, theme, keys, resolve);
        const step = steps.shift();
        try {
          assert.ok(step, "Unexpected additional UI");
          for (const width of [20, 90]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
          step(component);
        } catch (error) { reject(error); }
      });
    },
  } } as unknown as ExtensionContext;
  return ctx;
}
function press(component: Component, ...inputs: string[]) { inputs.forEach((data) => component.handleInput?.(data)); }
function contains(component: Component, pattern: RegExp) { assert.match(component.render(100).join("\n"), pattern); }

test("resource browser reads fixtures, resolves templates with completions, and controls subscriptions", async () => {
  const manager = new McpManager({ cwd: root });
  try {
    await manager.initialize({ servers: { fixture: { type: "local", command: [process.execPath, path.join(root, "test/local-mcp-server.mjs")] } } }, { mode: "connect", intent: "explicit", signal: undefined });
    assert.equal(manager.status().fixture?.status, "connected");
    const steps = [
      (c: Component) => press(c, "text-resource", enter),
      (c: Component) => press(c, enter),
      (c: Component) => { contains(c, /fixture resource text/); press(c, escape); },
      (c: Component) => press(c, down, enter),
      (c: Component) => { assert.deepEqual(manager.subscribedResources("fixture"), ["test://text"]); contains(c, /Unsubscribe/); press(c, down, enter); },
      (c: Component) => { assert.deepEqual(manager.subscribedResources("fixture"), []); press(c, escape); },
      (c: Component) => press(c, escape),
    ];
    await Effect.runPromise(browseMcpEffect(context(steps), manager, "fixture", "resources"));
    assert.equal(steps.length, 0);
    const templateSteps = [
      (c: Component) => press(c, "city-resource", enter),
      (c: Component) => { contains(c, /london/); press(c, down, enter); },
      (c: Component) => { contains(c, /test:\/\/cities\/london/); press(c, enter); },
      (c: Component) => { contains(c, /fixture city london/); press(c, escape); },
      (c: Component) => press(c, escape),
      (c: Component) => press(c, escape),
    ];
    await Effect.runPromise(browseMcpEffect(context(templateSteps), manager, "fixture", "resources"));
    assert.equal(templateSteps.length, 0);
    const infoSteps = [(c: Component) => { contains(c, /capabilities/); press(c, escape); }];
    await Effect.runPromise(browseMcpEffect(context(infoSteps), manager, "fixture", "capabilities"));
    assert.equal(infoSteps.length, 0);
    const toolSteps = [
      (c: Component) => press(c, "echo", enter),
      (c: Component) => { contains(c, /inputSchema/); press(c, escape); },
      (c: Component) => press(c, escape),
    ];
    await Effect.runPromise(browseMcpEffect(context(toolSteps), manager, "fixture", "tools"));
    assert.equal(toolSteps.length, 0);
  } finally { await manager.close(); }
});

test("MCP tool cancellation propagates through the SDK into an open elicitation form", { timeout: 5000 }, async () => {
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => { opened = resolve; });
  let disposed = false;
  const ctx = { hasUI: true, mode: "tui", ui: {
    custom(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: unknown) => void) => Component & { dispose?: () => void }) {
      return new Promise((resolve) => {
        const component = factory(tui, theme, keys, (value) => { component.dispose?.(); disposed = true; resolve(value); });
        opened();
      });
    },
  } } as unknown as ExtensionContext;
  const manager = new McpManager({ cwd: root, onElicitation: (server, request, signal) => handlePiElicitation(server, request, ctx, signal) });
  try {
    await manager.initialize({ servers: { fixture: { type: "local", command: [process.execPath, path.join(root, "test/local-mcp-server.mjs")] } } }, { mode: "connect", intent: "explicit", signal: undefined });
    const tool = manager.getToolEntry("fixture_elicit_form");
    assert.ok(tool);
    const controller = new AbortController();
    const call = Effect.runPromise(manager.callToolEffect(tool, {}, { signal: controller.signal }));
    const rejected = assert.rejects(call);
    await ready;
    controller.abort();
    await rejected;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposed, true);
  } finally { await manager.close(); }
});

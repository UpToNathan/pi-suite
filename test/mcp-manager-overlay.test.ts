import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showMcpManagerOverlay, type McpManagerView } from "../src/mcp-manager-overlay.js";

const connectedServerView: McpManagerView = {
  configSource: "/tmp/mcp.json",
  toolMode: "proxy",
  startupMode: "lazy",
  servers: [
    {
      name: "docs",
      type: "remote",
      target: "https://example.com/mcp",
      status: { status: "connected" },
      authStatus: "authenticated",
      hasPrompts: true,
      hasResources: true,
      toolCount: 4,
    },
  ],
};

test("MCP manager renders bounded server details and returns keyboard actions", async () => {
  const harness = createOverlayHarness(connectedServerView);
  const pendingAction = showMcpManagerOverlay(harness.context, connectedServerView);
  const component = harness.component();
  const lines = component.render(90);

  assert.ok(lines.some((line) => line.includes("MCP Servers")));
  assert.ok(lines.some((line) => line.includes("docs")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 90));

  component.handleInput?.("p");
  assert.deepEqual(await pendingAction, { _tag: "prompt", server: connectedServerView.servers[0] });
});

test("MCP manager exposes reload when no servers are configured", async () => {
  const emptyView: McpManagerView = {
    configSource: undefined,
    toolMode: "direct",
    startupMode: "eager",
    servers: [],
  };
  const harness = createOverlayHarness(emptyView);
  const pendingAction = showMcpManagerOverlay(harness.context, emptyView);
  const component = harness.component();

  assert.ok(component.render(80).some((line) => line.includes("No MCP servers configured")));
  component.handleInput?.("r");
  assert.deepEqual(await pendingAction, { _tag: "reload" });
});

function createOverlayHarness(view: McpManagerView): {
  readonly context: ExtensionContext;
  readonly component: () => Component;
} {
  let activeComponent: Component | undefined;
  const tuiValue = {
    terminal: { rows: 30 },
    requestRender() {},
  };
  const themeValue = {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };

  const ui = {
    custom<T>(
      factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (value: T) => void) => Component,
    ): Promise<T> {
      return new Promise<T>((resolve) => {
        // SAFETY: The overlay uses only terminal.rows and requestRender from TUI in this faithful inert harness.
        const tui = tuiValue as unknown as TUI;
        // SAFETY: The overlay uses only fg and bold from Theme in this faithful inert harness.
        const theme = themeValue as unknown as Theme;
        // SAFETY: The overlay does not inspect keybindings, so an empty manager is sufficient for this test boundary.
        const keybindings = {} as KeybindingsManager;
        activeComponent = factory(tui, theme, keybindings, resolve);
      });
    },
  };

  // SAFETY: showMcpManagerOverlay observes only ctx.ui.custom; this harness implements that complete interaction.
  const context = { ui } as unknown as ExtensionContext;
  return {
    context,
    component: () => {
      assert.ok(activeComponent, `Expected overlay component for ${view.servers.length} configured servers`);
      return activeComponent;
    },
  };
}

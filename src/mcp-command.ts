import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { Prompt } from "@modelcontextprotocol/client";
import { formatMcpServerTarget } from "./display.js";
import type { McpManager } from "./manager.js";
import { showMcpManagerOverlay, type McpManagerView, type McpServerView } from "./mcp-manager-overlay.js";
import type { McpConfig, McpStatus } from "./types.js";

/** Runtime operations owned by the Pi extension composition root and used by `/mcp`. */
export interface McpCommandDependencies {
  readonly ensureManager: (ctx: ExtensionCommandContext) => Promise<McpManager>;
  readonly getConfig: () => McpConfig;
  readonly reload: (ctx: ExtensionCommandContext) => Promise<void>;
  readonly refreshRuntime: (ctx: ExtensionCommandContext) => void;
  readonly showStatus: (text: string) => void;
  readonly showAuthorizationUrl: (url: string) => void;
  readonly sendUserMessage: (text: string) => void;
}

/** Run the interactive MCP server manager from the single `/mcp` command. */
export function runMcpCommand(
  ctx: ExtensionCommandContext,
  dependencies: McpCommandDependencies,
): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const manager = yield* Effect.tryPromise({ try: () => dependencies.ensureManager(ctx), catch: (error) => error });
  if (ctx.mode !== "tui") {
    dependencies.showStatus(formatNonInteractiveStatus(manager, dependencies.getConfig()));
    return;
  }

  let selectedServerName: string | undefined;
  while (true) {
    const view = yield* Effect.tryPromise({ try: () => createMcpManagerView(manager, dependencies.getConfig()), catch: (error) => error });
    const action = yield* Effect.tryPromise({ try: () => showMcpManagerOverlay(ctx, view, selectedServerName), catch: (error) => error });
    if ("server" in action) selectedServerName = action.server.name;
    try {
      switch (action._tag) {
        case "close":
          return;
        case "reload":
          yield* Effect.tryPromise({ try: () => runMcpOperation(ctx, "reloading", () => dependencies.reload(ctx)), catch: (error) => error });
          ctx.ui.notify("Reloaded MCP configuration and reconnected enabled servers", "info");
          continue;
        case "connect": {
          const status = yield* Effect.tryPromise({
            try: () => runMcpOperation(ctx, "connecting", () => manager.connect(action.server.name, { intent: "explicit", signal: undefined })),
            catch: (error) => error,
          });
          dependencies.refreshRuntime(ctx);
          notifyConnectionStatus(ctx, action.server.name, status);
          continue;
        }
        case "disconnect":
          yield* Effect.tryPromise({ try: () => runMcpOperation(ctx, "disconnecting", () => manager.disconnect(action.server.name)), catch: (error) => error });
          dependencies.refreshRuntime(ctx);
          ctx.ui.notify(`Disconnected MCP server ${action.server.name}`, "info");
          continue;
        case "authenticate": {
          const status = yield* Effect.tryPromise({
            try: () => runMcpOperation(ctx, "authenticating", () => manager.authenticate(action.server.name, async (url) => dependencies.showAuthorizationUrl(url))),
            catch: (error) => error,
          });
          dependencies.refreshRuntime(ctx);
          notifyConnectionStatus(ctx, action.server.name, status);
          continue;
        }
        case "logout":
          if (yield* Effect.tryPromise({ try: () => confirmMcpLogout(ctx, action.server.name), catch: (error) => error })) {
            yield* Effect.tryPromise({ try: () => runMcpOperation(ctx, "logging out", () => manager.removeAuth(action.server.name)), catch: (error) => error });
            ctx.ui.notify(`Removed OAuth credentials for ${action.server.name}`, "info");
          }
          continue;
        case "prompt": {
          const sent = yield* Effect.tryPromise({ try: () => runMcpPrompt(ctx, manager, action.server.name, dependencies.sendUserMessage), catch: (error) => error });
          if (sent) return;
          continue;
        }
        default:
          return casesHandled(action);
      }
    } catch (error) {
      ctx.ui.notify(mcpCommandError(error), "error");
    }
  }
    }),
  );
}

async function createMcpManagerView(manager: McpManager, config: McpConfig): Promise<McpManagerView> {
  const statuses = manager.status();
  const clients = manager.connectedClients();
  const toolCounts = new Map<string, number>();
  for (const tool of manager.getToolEntries()) toolCounts.set(tool.server, (toolCounts.get(tool.server) ?? 0) + 1);

  const servers = await Effect.runPromise(
    Effect.forEach(
      Object.entries(config.servers).sort(([left], [right]) => left.localeCompare(right)),
      ([name, serverConfig]) =>
        Effect.gen(function* () {
          const client = clients.get(name);
          const authStatus =
            serverConfig.type === "remote" && serverConfig.oauth !== false
              ? yield* Effect.tryPromise({ try: () => manager.authStatus(name), catch: (error) => error })
              : undefined;
          const view: McpServerView = {
            name,
            type: serverConfig.type,
            target: formatMcpServerTarget(serverConfig),
            status: statuses[name] ?? { status: "disabled" },
            authStatus,
            hasPrompts: client?.hasPrompts ?? false,
            hasResources: client?.hasResources ?? false,
            toolCount: toolCounts.get(name) ?? 0,
          };
          return view;
        }),
      { concurrency: "unbounded" },
    ),
  );

  return {
    configSource: config.source,
    toolMode: config.toolMode ?? "direct",
    startupMode: config.startup ?? "lazy",
    servers,
  };
}

function runMcpOperation<T>(
  ctx: ExtensionCommandContext,
  operation: string,
  execute: () => Promise<T>,
): Promise<T> {
  ctx.ui.setStatus("mcp-command", ctx.ui.theme.fg("accent", `mcp:${operation}`));
  return Effect.runPromise(
    Effect.tryPromise({ try: execute, catch: (error) => error }).pipe(
      Effect.ensuring(Effect.sync(() => ctx.ui.setStatus("mcp-command", undefined))),
    ),
  );
}

async function confirmMcpLogout(ctx: ExtensionCommandContext, server: string): Promise<boolean> {
  return ctx.ui.confirm("Remove MCP OAuth credentials?", `Log out of ${server}. You will need to authenticate again.`);
}

function runMcpPrompt(
  ctx: ExtensionCommandContext,
  manager: McpManager,
  server: string,
  sendUserMessage: (text: string) => void,
): Promise<boolean> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () => runMcpOperation(ctx, "loading-prompts", () => manager.prompts({ signal: undefined })),
        catch: (error) => error,
      });
  const prompts = result.prompts.filter((prompt) => prompt.client === server);
  if (prompts.length === 0) {
    ctx.ui.notify(`MCP server ${server} has no prompts`, "warning");
    return false;
  }

  const choices = prompts.map((prompt) => formatPromptChoice(prompt));
  const choice = yield* Effect.tryPromise({ try: () => ctx.ui.select(`MCP prompt — ${server}`, choices), catch: (error) => error });
  if (choice === undefined) return false;
  const selectedIndex = choices.indexOf(choice);
  const selected = prompts[selectedIndex];
  if (selected === undefined) return false;

  const args = yield* Effect.tryPromise({ try: () => collectPromptArguments(ctx, selected), catch: (error) => error });
  if (args === undefined) return false;
  const prompt = yield* Effect.tryPromise({
    try: () => runMcpOperation(ctx, "fetching-prompt", () => manager.getPrompt(server, selected.name, args, { signal: undefined })),
    catch: (error) => error,
  });
  const text = prompt.messages
    ?.map((message) => {
      const content = message.content;
      return typeof content === "object" && content !== null && "type" in content && content.type === "text"
        ? content.text
        : "";
    })
    .filter((content) => content.length > 0)
    .join("\n") ?? "";
  if (!text.trim()) {
    ctx.ui.notify("MCP prompt returned no text content", "warning");
    return false;
  }
      sendUserMessage(text);
      return true;
    }),
  );
}

function collectPromptArguments(
  ctx: ExtensionCommandContext,
  prompt: Prompt,
): Promise<Record<string, string> | undefined> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const values: Record<string, string> = {};
      for (const argument of prompt.arguments ?? []) {
        const value = yield* Effect.tryPromise({
          try: () =>
            ctx.ui.input(
              `${prompt.name} — ${argument.name}${argument.required ? " (required)" : ""}`,
              argument.description ?? (argument.required ? "required" : "optional; leave blank to omit"),
            ),
          catch: (error) => error,
        });
        if (value === undefined) return undefined;
        const trimmed = value.trim();
        if (trimmed.length > 0) values[argument.name] = trimmed;
        else if (argument.required) {
          ctx.ui.notify(`MCP prompt argument ${argument.name} is required`, "warning");
          return undefined;
        }
      }
      return values;
    }),
  );
}

function formatPromptChoice(prompt: Prompt): string {
  return prompt.description ? `${prompt.name} — ${prompt.description}` : prompt.name;
}

function notifyConnectionStatus(ctx: ExtensionCommandContext, server: string, status: McpStatus): void {
  if (status.status === "connected") {
    ctx.ui.notify(`Connected MCP server ${server}`, "info");
    return;
  }
  if (status.status === "failed" || status.status === "needs_client_registration") {
    ctx.ui.notify(`MCP server ${server}: ${status.error}`, "error");
    return;
  }
  ctx.ui.notify(`MCP server ${server}: ${status.status}`, status.status === "needs_auth" ? "warning" : "info");
}

function formatNonInteractiveStatus(manager: McpManager, config: McpConfig): string {
  const statuses = manager.status();
  const servers = Object.keys(config.servers).sort((left, right) => left.localeCompare(right));
  if (servers.length === 0) return "No MCP servers configured";
  return servers.map((name) => `${name}: ${statuses[name]?.status ?? "disabled"}`).join("\n");
}

function mcpCommandError(error: unknown): string {
  return error instanceof Error ? `MCP manager operation failed: ${error.message}` : "MCP manager operation failed";
}

function casesHandled(unexpectedCase: never): never {
  throw new Error(`Unhandled MCP manager action: ${String(unexpectedCase)}`);
}

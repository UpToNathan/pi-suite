import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Tool } from "@modelcontextprotocol/client";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { Effect, Fiber } from "effect";
import { formatResourceContent, formatResourceList, formatResourceTemplateList, toolParameters } from "./catalog.js";
import { loadMcpConfigEffect } from "./config.js";
import { formatMcpServerTarget, redactSecrets } from "./display.js";
import { handlePiElicitation } from "./elicitation.js";
import { McpManager, type McpToolEntry } from "./manager.js";
import { runMcpCommand } from "./mcp-command.js";
import type { CancellableOptions, McpConfig, McpStatus } from "./types.js";
import { optionalString, requiredString } from "./tool-args.js";

const MCP_PROXY_TOOL = "mcp";
const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";
const COMPLETE_MCP_RESOURCE_TOOL = "complete_mcp_resource";
const WATCH_MCP_RESOURCE_TOOL = "watch_mcp_resource";
const MAX_RENDERED_CALL_ARGS_CHARS = 1500;
const MAX_PROXY_SEARCH_RESULTS = 30;

interface RenderTheme {
  fg: (name: "toolTitle" | "muted", text: string) => string;
  bold: (text: string) => string;
}

const ListResourcesParams = Type.Object({
  server: Type.Optional(Type.String({ description: "Optional MCP server name. When omitted, lists resources from every connected server." })),
});

const ReadResourceParams = Type.Object({
  server: Type.String({ description: "MCP server name exactly as returned by list_mcp_resources." }),
  uri: Type.String({ description: "Resource URI exactly as returned by list_mcp_resources." }),
});

const WatchResourceParams = Type.Object({
  server: Type.String({ description: "MCP server name exactly as returned by list_mcp_resources." }),
  uri: Type.String({ description: "Concrete resource URI to watch." }),
  subscribe: Type.Optional(Type.Boolean({ description: "True to subscribe (default), false to unsubscribe." })),
});

const CompleteResourceParams = Type.Object({
  server: Type.String({ description: "MCP server name exactly as returned by list_mcp_resources." }),
  uri: Type.String({ description: "Resource URI template exactly as returned by list_mcp_resources." }),
  argument: Type.String({ description: "Template variable to complete." }),
  value: Type.Optional(Type.String({ description: "Current variable prefix. Defaults to an empty string." })),
});

const McpProxyParams = Type.Object({
  tool: Type.Optional(Type.String({ description: "MCP tool name to call, usually the prefixed <server>_<tool> name from search/list." })),
  args: Type.Optional(Type.String({ description: "Tool arguments as a JSON object string, for example '{\"key\":\"value\"}'." })),
  connect: Type.Optional(Type.String({ description: "Connect or reconnect one configured MCP server and refresh its tool metadata." })),
  describe: Type.Optional(Type.String({ description: "MCP tool name to describe, including its parameters." })),
  search: Type.Optional(Type.String({ description: "Search MCP tools by server, name, and description." })),
  regex: Type.Optional(Type.Boolean({ description: "Treat search as a JavaScript regular expression instead of space-separated terms." })),
  server: Type.Optional(Type.String({ description: "Filter list/search/describe/call to a specific MCP server." })),
  action: Type.Optional(Type.String({ description: "Optional action: 'status', 'resources', 'read-resource', 'complete-resource', 'subscribe-resource', or 'unsubscribe-resource'." })),
  uri: Type.Optional(Type.String({ description: "Resource URI or template for resource actions." })),
  argument: Type.Optional(Type.String({ description: "Template variable for action 'complete-resource'." })),
  value: Type.Optional(Type.String({ description: "Current variable prefix for action 'complete-resource'." })),
});

/** Registers the OpenCode-compatible MCP client extension with Pi. */
export default function opencodeMcpExtension(pi: ExtensionAPI) {
  let manager: McpManager | undefined;
  let config: McpConfig = { servers: {} };
  let registeredToolNames = new Set<string>();
  let latestContext: ExtensionContext | undefined;
  let configGeneration = 0;
  let backgroundConnectionRefresh: Fiber.Fiber<void> | undefined;
  const elicitationContexts = new AsyncLocalStorage<ExtensionContext | undefined>();

  function ensureManager(ctx: ExtensionContext) {
    latestContext = ctx;
    if (manager) return manager;
    manager = new McpManager({
      cwd: ctx.cwd,
      onElicitation: (server, request, signal) => handlePiElicitation(server, request, elicitationContexts.getStore() ?? latestContext, signal),
      onToolsChanged: () => {
        registerDynamicTools();
      },
      onResourceUpdated: (server, uri) => {
        latestContext?.ui.notify(`MCP resource updated: ${server} ${uri}`, "info");
      },
    });
    return manager;
  }

  function loadConfiguredEffect(ctx: ExtensionContext) {
    return Effect.gen(function* () {
        latestContext = ctx;
        const generation = configGeneration + 1;
        configGeneration = generation;
        config = yield* loadMcpConfigEffect({ cwd: ctx.cwd });
        const activeManager = yield* Effect.sync(() => ensureManager(ctx));
        const previous = registeredToolNames;
        registeredToolNames = new Set();
        yield* activeManager.initializeEffect(config, { mode: "configure-only" });
        registerDynamicTools();
        deactivateTools([...previous].filter((name) => !registeredToolNames.has(name)));
        return { activeManager, generation };
      });
  }

  function connectConfiguredServers(activeManager: McpManager, generation: number) {
    return Effect.gen(function* () {
      yield* activeManager.connectAllEffect({ intent: "automatic", signal: undefined });
      if (manager !== activeManager || configGeneration !== generation) return;
      yield* Effect.sync(() => registerDynamicTools());
    });
  }

  function startBackgroundConnectionRefresh(ctx: ExtensionContext, activeManager: McpManager, generation: number) {
    backgroundConnectionRefresh = Effect.runFork(
      connectConfiguredServers(activeManager, generation).pipe(
        Effect.tap(() =>
          manager === activeManager && configGeneration === generation
            ? Effect.sync(() => updateMcpStatus(ctx))
            : Effect.void,
        ),
        Effect.catch((error) => {
          if (manager !== activeManager || configGeneration !== generation) return Effect.void;
          return Effect.sync(() => {
            console.error(`[mcp] background connection refresh failed: ${safeErrorSummary(error)}`);
            updateMcpStatus(ctx);
          });
        }),
      ),
    );
  }

  function registerDynamicTools() {
    const activeManager = manager;
    if (!activeManager) return;

    const current = new Set<string>();
    if (useProxyTool(config)) {
      current.add(MCP_PROXY_TOOL);
      registerMcpProxyTool();
      deactivateTools([...registeredToolNames].filter((name) => !current.has(name)));
      registeredToolNames = current;
      activateTools([...current]);
      return;
    }

    for (const entry of activeManager.getToolEntries()) {
      current.add(entry.key);
      pi.registerTool({
        name: entry.key,
        label: `MCP ${entry.server}/${entry.name}`,
        description: entry.tool.description || `Call MCP tool ${entry.name} on server ${entry.server}`,
        promptSnippet: `Call MCP tool ${entry.name} on server ${entry.server}`,
        promptGuidelines: [`Use ${entry.key} only when the user needs the ${entry.name} MCP tool from server ${entry.server}.`],
        parameters: typeboxToolParameters(entry.tool),
        renderCall(args, theme) {
          return renderToolCall(entry.key, args, theme);
        },
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          const latest = requireManager().getToolEntry(entry.key);
          if (!latest) throw new Error(`MCP tool ${entry.key} is not connected`);
          const effect = requireManager().callToolEffect(latest, isPlainRecord(params) ? params : {}, {
            signal,
            ...(onUpdate ? { onProgress: (progress: { progress: number; total?: number | undefined; message?: string | undefined }) => onUpdate(progressUpdate(progress)) } : {}),
          });
          return elicitationContexts.run(ctx ?? latestContext, () => Effect.runPromise(effect));
        },
      });
    }

    if (activeManager.supportsResources()) {
      current.add(LIST_MCP_RESOURCES_TOOL);
      current.add(READ_MCP_RESOURCE_TOOL);
      if (activeManager.supportsCompletions()) current.add(COMPLETE_MCP_RESOURCE_TOOL);
      current.add(WATCH_MCP_RESOURCE_TOOL);
      registerResourceTools();
    }

    deactivateTools([...registeredToolNames].filter((name) => !current.has(name)));
    registeredToolNames = current;
    activateTools([...current]);
  }

  function registerMcpProxyTool() {
    pi.registerTool({
      name: MCP_PROXY_TOOL,
      label: "MCP",
      description:
        "Gateway for discovering and calling configured MCP server tools without exposing every MCP tool schema in the system prompt.",
      promptSnippet: "Discover and call MCP server tools through a single gateway",
      promptGuidelines: [
        "Use mcp({ search: \"...\" }) when the user may need an MCP server capability that is not already exposed as a direct Pi tool.",
        "Use mcp({ describe: \"tool_name\" }) before calling unfamiliar MCP tools to inspect their required parameters.",
        "Use mcp({ tool: \"tool_name\", args: \"{...}\" }) to call MCP tools; args must be a JSON object string.",
        "Call native Pi tools such as read, bash, edit, and write directly; do not route them through mcp.",
      ],
      parameters: McpProxyParams,
      renderCall(args, theme) {
        return renderMcpProxyCall(args, theme);
      },
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        latestContext = ctx ?? latestContext;
        return elicitationContexts.run(ctx ?? latestContext, () => executeMcpProxy(params, signal, onUpdate));
      },
    });
  }

  function executeMcpProxy(params: unknown, signal: AbortSignal | undefined, onUpdate?: (result: ReturnType<typeof progressUpdate>) => void) {
    return Effect.runPromise(
      Effect.gen(function* () {
        const args = isPlainRecord(params) ? params : {};
    const action = optionalString(args, "action");
    const server = optionalString(args, "server");
    const parsedArgs = parseProxyJsonArgs(optionalString(args, "args"));

    if (action === "resources") return yield* proxyResourcesEffect(server, signal);
    if (action === "read-resource") return yield* proxyReadResourceEffect(server, optionalString(args, "uri"), signal);
    if (action === "subscribe-resource" || action === "unsubscribe-resource") {
      if (!server) return proxyText(`${action} requires \`server\`.`, { mode: action, error: "missing_server" });
      const uri = optionalString(args, "uri");
      if (!uri) return proxyText(`${action} requires \`uri\`.`, { mode: action, server, error: "missing_uri" });
      yield* ensureProxyServerConnectedEffect(server, { signal });
      if (action === "subscribe-resource") yield* requireManager().subscribeResourceEffect(server, uri, { signal });
      else yield* requireManager().unsubscribeResourceEffect(server, uri, { signal });
      return proxyText(`${action === "subscribe-resource" ? "Subscribed to" : "Unsubscribed from"} ${server} ${uri}.`, { mode: action, server, uri });
    }
    if (action === "complete-resource") return yield* proxyCompleteResourceEffect(
      server,
      optionalString(args, "uri"),
      optionalString(args, "argument"),
      optionalString(args, "value") ?? "",
      signal,
    );
    if (action !== undefined && action !== "status") {
      return proxyText(`Unknown MCP action "${action}". Supported actions: status, resources, read-resource, complete-resource, subscribe-resource, unsubscribe-resource.`, {
        mode: "error",
        error: "unknown_action",
        action,
      });
    }

    const tool = optionalString(args, "tool");
    if (tool) return yield* proxyCallEffect(tool, parsedArgs, server, signal, onUpdate);

    const connect = optionalString(args, "connect");
    if (connect) return yield* proxyConnectEffect(connect);

    const describe = optionalString(args, "describe");
    if (describe) return yield* proxyDescribeEffect(describe, server, signal);

    const search = optionalString(args, "search");
    if (search) return yield* proxySearchEffect(search, typeof args.regex === "boolean" ? args.regex : false, server, signal);

    if (server) return yield* proxyListEffect(server, signal);
    return proxyStatus();
      }),
    );
  }

  function proxyCallEffect(
    toolName: string,
    args: Record<string, unknown>,
    server: string | undefined,
    signal: AbortSignal | undefined,
    onUpdate?: (result: ReturnType<typeof progressUpdate>) => void,
  ) {
    return Effect.gen(function* () {
        yield* ensureProxyToolMetadataEffect(toolName, server, { signal });
        const found = findProxyTool(toolName, server);
        if ("error" in found) return proxyText(found.error, found.details);
        return yield* requireManager().callToolEffect(found.entry, args, {
          signal,
          ...(onUpdate ? { onProgress: (progress: { progress: number; total?: number | undefined; message?: string | undefined }) => onUpdate(progressUpdate(progress)) } : {}),
        });
      });
  }

  function proxyConnectEffect(server: string) {
    return Effect.gen(function* () {
        const status = yield* requireManager().connectEffect(server, { intent: "explicit", signal: undefined });
        yield* Effect.sync(() => registerDynamicTools());
        return proxyText(formatStatus(server, config.servers[server], status), { mode: "connect", server, status: status.status });
      });
  }

  function proxyDescribeEffect(toolName: string, server: string | undefined, signal: AbortSignal | undefined) {
    return Effect.gen(function* () {
        yield* ensureProxyToolMetadataEffect(toolName, server, { signal });
        const found = findProxyTool(toolName, server);
        if ("error" in found) return proxyText(found.error, found.details);
        return proxyText(formatProxyToolDescription(found.entry), {
          mode: "describe",
          server: found.entry.server,
          tool: found.entry.key,
          originalName: found.entry.name,
        });
      });
  }

  function proxySearchEffect(query: string, regex: boolean, server: string | undefined, signal: AbortSignal | undefined) {
    return Effect.gen(function* () {
        const pattern = buildSearchPattern(query, regex);
    if ("error" in pattern) return proxyText(pattern.error, pattern.details);
        yield* ensureProxySearchMetadataEffect(server, { signal });
        const matches = proxyToolEntries()
      .filter((entry) => !server || entry.server === server)
      .filter((entry) => pattern.pattern.test(`${entry.key}\n${entry.name}\n${entry.server}\n${entry.tool.description ?? ""}`))
      .sort((a, b) => a.key.localeCompare(b.key));

    if (matches.length === 0) {
      return proxyText(server ? `No MCP tools matching "${query}" on server "${server}".` : `No MCP tools matching "${query}".`, {
        mode: "search",
        query,
        server,
        count: 0,
      });
    }

    const shown = matches.slice(0, MAX_PROXY_SEARCH_RESULTS);
    const lines = [`Found ${matches.length} MCP tool${matches.length === 1 ? "" : "s"} matching "${query}":`, ""];
    for (const entry of shown) {
      lines.push(entry.key);
      lines.push(`  Server: ${entry.server}`);
      lines.push(`  ${entry.tool.description || "(no description)"}`);
      lines.push("");
    }
    if (shown.length < matches.length) lines.push(`Showing first ${shown.length}. Narrow the search or use mcp({ server: "name" }).`);
    lines.push("Use mcp({ describe: \"tool_name\" }) for parameters before calling unfamiliar tools.");

        return proxyText(lines.join("\n").trim(), {
          mode: "search",
          query,
          server,
          count: matches.length,
          matches: shown.map((entry) => ({ server: entry.server, tool: entry.key, name: entry.name })),
          truncated: shown.length < matches.length,
        });
      });
  }

  function proxyListEffect(server: string, signal: AbortSignal | undefined) {
    return Effect.gen(function* () {
        if (!config.servers[server]) {
      return proxyText(`MCP server "${server}" is not configured. Use mcp({}) to see available servers.`, {
        mode: "list",
        server,
        error: "server_not_found",
      });
    }
    yield* ensureProxyServerConnectedEffect(server, { signal });
    const entries = proxyToolEntries().filter((entry) => entry.server === server).sort((a, b) => a.key.localeCompare(b.key));
    if (entries.length === 0) {
      const status = requireManager().status()[server]?.status ?? "disabled";
      return proxyText(`MCP server "${server}" has no connected tools (status: ${status}). Use mcp({ connect: "${server}" }) to retry.`, {
        mode: "list",
        server,
        count: 0,
        status,
      });
    }
    const lines = [`${server} (${entries.length} MCP tool${entries.length === 1 ? "" : "s"}):`, ""];
    for (const entry of entries) {
      lines.push(`- ${entry.key}${entry.tool.description ? ` — ${entry.tool.description}` : ""}`);
    }
    lines.push("", "Use mcp({ describe: \"tool_name\" }) for parameters.");
        return proxyText(lines.join("\n"), {
          mode: "list",
          server,
          count: entries.length,
          tools: entries.map((entry) => entry.key),
        });
      });
  }

  function proxyResourcesEffect(server: string | undefined, signal: AbortSignal | undefined) {
    return Effect.gen(function* () {
        if (server) yield* ensureProxyServerConnectedEffect(server, { signal });
        else yield* ensureProxyServersConnectedEffect({ signal });
    const resourceServers = resourceServerNames();
    if (server && !resourceServers.includes(server)) {
      return proxyText(`MCP server "${server}" does not support resources. Available resource servers: ${resourceServers.join(", ") || "none"}.`, {
        mode: "resources",
        server,
        error: "resources_not_supported",
      });
    }
    const result = yield* requireManager().resourcesEffect(server, { signal });
    const sorted = [...result.resources].sort((a, b) =>
      `${a.client}\u0000${a.name}\u0000${a.uri}`.localeCompare(`${b.client}\u0000${b.name}\u0000${b.uri}`),
    );
    const templates = [...result.templates].sort((a, b) =>
      `${a.client}\u0000${a.name}\u0000${a.uriTemplate}`.localeCompare(`${b.client}\u0000${b.name}\u0000${b.uriTemplate}`),
    );
    const response = {
      resources: formatResourceList(sorted),
      resourceTemplates: formatResourceTemplateList(templates),
      ...(result.failures.length > 0 ? { failures: result.failures } : {}),
    };
        return proxyText(JSON.stringify(response, null, 2), {
          mode: "resources",
          count: sorted.length,
          templates: templates.length,
          servers: resourceServers,
          failures: result.failures.length,
          ...(server ? { server } : {}),
        });
      });
  }

  function proxyReadResourceEffect(server: string | undefined, uri: string | undefined, signal: AbortSignal | undefined) {
    return Effect.gen(function* () {
        if (!server) return proxyText("read-resource requires `server`.", { mode: "read-resource", error: "missing_server" });
    if (!uri) return proxyText("read-resource requires `uri`.", { mode: "read-resource", server, error: "missing_uri" });
    yield* ensureProxyServerConnectedEffect(server, { signal });
    const content = yield* requireManager().readResourceEffect(server, uri, { signal });
    const formatted = formatResourceContent(server, uri, content);
        return {
          content: [{ type: "text" as const, text: formatted.text }, ...formatted.images],
          details: { mode: "read-resource", server, uri, contents: formatted.count, images: formatted.images.length },
        };
      });
  }

  function proxyCompleteResourceEffect(
    server: string | undefined,
    uri: string | undefined,
    argument: string | undefined,
    value: string,
    signal: AbortSignal | undefined,
  ) {
    return Effect.gen(function* () {
      if (!server) return proxyText("complete-resource requires `server`.", { mode: "complete-resource", error: "missing_server" });
      if (!uri) return proxyText("complete-resource requires `uri`.", { mode: "complete-resource", server, error: "missing_uri" });
      if (!argument) return proxyText("complete-resource requires `argument`.", { mode: "complete-resource", server, error: "missing_argument" });
      yield* ensureProxyServerConnectedEffect(server, { signal });
      const result = yield* requireManager().completeEffect(server, {
        ref: { type: "ref/resource", uri },
        argument: { name: argument, value },
      }, { signal });
      return proxyText(JSON.stringify(result.completion, null, 2), {
        mode: "complete-resource",
        server,
        uri,
        argument,
        count: result.completion.values.length,
      });
    });
  }

  function proxyStatus() {
    const statuses = requireManager().status();
    const entries = proxyToolEntries();
    const lines: string[] = [];
    if (config.source) lines.push(`Config: ${config.source}`, "");
    const servers = Object.entries(config.servers);
    if (servers.length === 0) return proxyText("No MCP servers configured.", { mode: "status", servers: [], totalTools: 0 });
    lines.push(`MCP proxy: ${servers.length} server${servers.length === 1 ? "" : "s"}, ${entries.length} connected tool${entries.length === 1 ? "" : "s"}`, "");
    for (const [name, serverConfig] of servers) {
      const count = entries.filter((entry) => entry.server === name).length;
      const status = statuses[name] ?? { status: "disabled" as const };
      const target = formatMcpServerTarget(serverConfig);
      lines.push(`${name}: ${status.status}, ${count} tool${count === 1 ? "" : "s"}${target ? ` (${target})` : ""}`);
    }
    lines.push("", "Use mcp({ search: \"...\" }) to find tools or mcp({ server: \"name\" }) to list one server.");
    return proxyText(lines.join("\n"), {
      mode: "status",
      servers: servers.map(([name]) => ({ name, status: statuses[name]?.status ?? "disabled", tools: entries.filter((entry) => entry.server === name).length })),
      totalTools: entries.length,
    });
  }

  function ensureProxyToolMetadataEffect(toolName: string, server: string | undefined, options: CancellableOptions) {
    if (server) return ensureProxyServerConnectedEffect(server, options);
    const found = findProxyTool(toolName, undefined);
    return "error" in found ? ensureProxyServersConnectedEffect(options) : Effect.void;
  }

  function ensureProxySearchMetadataEffect(server: string | undefined, options: CancellableOptions) {
    return server ? ensureProxyServerConnectedEffect(server, options) : ensureProxyServersConnectedEffect(options);
  }

  function ensureProxyServerConnectedEffect(server: string, options: CancellableOptions) {
    return Effect.gen(function* () {
      if (!config.servers[server]) return;
      yield* requireManager().connectEffect(server, { intent: "automatic", signal: options.signal });
      registerDynamicTools();
      updateLatestMcpStatus();
    });
  }

  function ensureProxyServersConnectedEffect(options: CancellableOptions) {
    return Effect.gen(function* () {
      yield* requireManager().connectAllEffect({ intent: "automatic", signal: options.signal });
      registerDynamicTools();
      updateLatestMcpStatus();
    });
  }

  function proxyToolEntries() {
    return requireManager().getToolEntries();
  }

  function findProxyTool(toolName: string, server: string | undefined): { entry: McpToolEntry } | { error: string; details: Record<string, unknown> } {
    const candidates = proxyToolEntries().filter((entry) => !server || entry.server === server);
    const matches = candidates.filter((entry) => entry.key === toolName || entry.name === toolName);
    const match = matches[0];
    if (matches.length === 1 && match) return { entry: match };
    if (matches.length > 1) {
      return {
        error: `MCP tool "${toolName}" is ambiguous. Use a prefixed name or pass server. Matches: ${matches.map((entry) => `${entry.server}/${entry.name}`).join(", ")}`,
        details: { mode: "error", error: "ambiguous_tool", requestedTool: toolName, matches: matches.map((entry) => entry.key) },
      };
    }
    return {
      error: server
        ? `MCP tool "${toolName}" not found on server "${server}". Use mcp({ server: "${server}" }) to list tools.`
        : `MCP tool "${toolName}" not found. Use mcp({ search: "..." }) to search tools.`,
      details: { mode: "error", error: "tool_not_found", requestedTool: toolName, server },
    };
  }

  function registerResourceTools() {
    pi.registerTool({
      name: LIST_MCP_RESOURCES_TOOL,
      label: "List MCP Resources",
      description:
        "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
      promptSnippet: "List resources from connected MCP servers",
      promptGuidelines: [
        "Use list_mcp_resources before read_mcp_resource when the user asks about available MCP resources or does not provide an exact MCP URI.",
      ],
      parameters: ListResourcesParams,
      renderCall(args, theme) {
        return renderToolCall(LIST_MCP_RESOURCES_TOOL, args, theme);
      },
      async execute(_toolCallId, params, signal) {
        const parsed = parseListResourcesArgs(params);
        const resourceServers = resourceServerNames();
        if (parsed.server && !resourceServers.includes(parsed.server)) {
          throw new Error(
            resourceServers.length === 0
              ? `MCP server "${parsed.server}" does not support resources`
              : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
          );
        }
        const result = await requireManager().resources(parsed.server, { signal });
        const sorted = [...result.resources].sort((a, b) =>
          `${a.client}\u0000${a.name}\u0000${a.uri}`.localeCompare(`${b.client}\u0000${b.name}\u0000${b.uri}`),
        );
        const templates = [...result.templates].sort((a, b) =>
          `${a.client}\u0000${a.name}\u0000${a.uriTemplate}`.localeCompare(`${b.client}\u0000${b.name}\u0000${b.uriTemplate}`),
        );
        const response = {
          resources: formatResourceList(sorted),
          resourceTemplates: formatResourceTemplateList(templates),
          ...(result.failures.length > 0 ? { failures: result.failures } : {}),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          details: {
            count: sorted.length,
            templates: templates.length,
            servers: resourceServers,
            failures: result.failures.length,
            ...(parsed.server ? { server: parsed.server } : {}),
          },
        };
      },
    });

    pi.registerTool({
      name: WATCH_MCP_RESOURCE_TOOL,
      label: "Watch MCP Resource",
      description: "Subscribe or unsubscribe from update notifications for a concrete MCP resource.",
      promptSnippet: "Watch an MCP resource for updates",
      promptGuidelines: ["Use watch_mcp_resource only when ongoing updates to a concrete MCP resource matter."],
      parameters: WatchResourceParams,
      renderCall(args, theme) {
        return renderToolCall(WATCH_MCP_RESOURCE_TOOL, args, theme);
      },
      async execute(_toolCallId, params, signal) {
        const parsed = parseWatchResourceArgs(params);
        if (parsed.subscribe) await requireManager().subscribeResource(parsed.server, parsed.uri, { signal });
        else await requireManager().unsubscribeResource(parsed.server, parsed.uri, { signal });
        return {
          content: [{ type: "text", text: `${parsed.subscribe ? "Subscribed to" : "Unsubscribed from"} ${parsed.server} ${parsed.uri}.` }],
          details: parsed,
        };
      },
    });

    pi.registerTool({
      name: COMPLETE_MCP_RESOURCE_TOOL,
      label: "Complete MCP Resource",
      description: "Request completion candidates for one variable in an MCP resource URI template.",
      promptSnippet: "Complete an MCP resource URI template variable",
      promptGuidelines: [
        "Use complete_mcp_resource with a URI template and variable returned by list_mcp_resources before reading a templated resource.",
      ],
      parameters: CompleteResourceParams,
      renderCall(args, theme) {
        return renderToolCall(COMPLETE_MCP_RESOURCE_TOOL, args, theme);
      },
      async execute(_toolCallId, params, signal) {
        const parsed = parseCompleteResourceArgs(params);
        const result = await requireManager().complete(parsed.server, {
          ref: { type: "ref/resource", uri: parsed.uri },
          argument: { name: parsed.argument, value: parsed.value },
        }, { signal });
        return {
          content: [{ type: "text", text: JSON.stringify(result.completion, null, 2) }],
          details: {
            server: parsed.server,
            uri: parsed.uri,
            argument: parsed.argument,
            count: result.completion.values.length,
          },
        };
      },
    });

    pi.registerTool({
      name: READ_MCP_RESOURCE_TOOL,
      label: "Read MCP Resource",
      description: "Read a specific resource from an MCP server using the server name and resource URI.",
      promptSnippet: "Read a specific MCP resource by server and URI",
      promptGuidelines: [
        "Use read_mcp_resource only with an exact MCP server name and URI returned by list_mcp_resources or supplied by the user.",
      ],
      parameters: ReadResourceParams,
      renderCall(args, theme) {
        return renderToolCall(READ_MCP_RESOURCE_TOOL, args, theme);
      },
      async execute(_toolCallId, params, signal) {
        const parsed = parseReadResourceArgs(params);
        const content = await requireManager().readResource(parsed.server, parsed.uri, { signal });
        const formatted = formatResourceContent(parsed.server, parsed.uri, content);
        return {
          content: [{ type: "text", text: formatted.text }, ...formatted.images],
          details: {
            server: parsed.server,
            uri: parsed.uri,
            contents: formatted.count,
            images: formatted.images.length,
          },
        };
      },
    });
  }

  function resourceServerNames() {
    const activeManager = manager;
    if (!activeManager) return [];
    return Array.from(activeManager.connectedClients())
      .filter(([, entry]) => entry.hasResources)
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b));
  }

  function updateLatestMcpStatus() {
    const ctx = latestContext;
    if (ctx) updateMcpStatus(ctx);
  }

  function updateMcpStatus(ctx: ExtensionContext) {
    const count = Object.values(manager?.status() ?? {}).filter((status) => status.status === "connected").length;
    if (ctx.hasUI && Object.keys(config.servers).length > 0) {
      ctx.ui.setStatus("mcp", `${count} MCP`);
    }
  }

  function activateTools(names: string[]) {
    if (names.length === 0) return;
    const active = new Set(pi.getActiveTools());
    for (const name of names) active.add(name);
    pi.setActiveTools([...active]);
  }

  function deactivateTools(names: string[]) {
    if (names.length === 0) return;
    const active = new Set(pi.getActiveTools());
    for (const name of names) active.delete(name);
    pi.setActiveTools([...active]);
  }

  pi.on("session_start", (_event, ctx) =>
    Effect.runPromise(
      Effect.gen(function* () {
        latestContext = ctx;
        const loaded = yield* loadConfiguredEffect(ctx);
        yield* Effect.sync(() => updateMcpStatus(ctx));
        if (startupMode(config) === "eager") {
          yield* Effect.sync(() => startBackgroundConnectionRefresh(ctx, loaded.activeManager, loaded.generation));
        }
      }),
    ),
  );

  pi.on("session_shutdown", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        configGeneration += 1;
        const pendingConnectionRefresh = backgroundConnectionRefresh;
        const activeManager = manager;
        backgroundConnectionRefresh = undefined;
        if (pendingConnectionRefresh) yield* Fiber.interrupt(pendingConnectionRefresh);
        if (activeManager) yield* activeManager.closeEffect();
        manager = undefined;
        registeredToolNames = new Set();
      }),
    ),
  );

  pi.registerCommand("mcp", {
    description: "Open the interactive MCP server manager",
    handler: (_args, ctx) =>
      runMcpCommand(ctx, {
        ensureManager: (commandContext) => Effect.sync(() => ensureManager(commandContext)),
        getConfig: () => config,
        reload: (commandContext) =>
            Effect.gen(function* () {
              const loaded = yield* loadConfiguredEffect(commandContext);
              yield* loaded.activeManager.connectAllEffect({ intent: "explicit", signal: undefined });
              yield* Effect.sync(() => {
                registerDynamicTools();
                updateMcpStatus(commandContext);
              });
            }),
        refreshRuntime: (commandContext) => {
          registerDynamicTools();
          updateMcpStatus(commandContext);
        },
        showStatus: (text) => showCommandMessage(pi, "MCP Servers", text),
        showAuthorizationUrl: (url) => showCommandMessage(pi, "Open MCP OAuth URL", url),
        sendUserMessage: (text) => pi.sendUserMessage(text),
      }),
  });

  function requireManager() {
    if (!manager) throw new Error("MCP manager has not been initialized");
    return manager;
  }
}

function parseProxyJsonArgs(value: string | undefined) {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid MCP proxy args JSON: ${error.message}`);
    throw error;
  }
  if (!isPlainRecord(parsed)) throw new Error("MCP proxy args must be a JSON object string");
  return parsed;
}

function proxyText(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function progressUpdate(progress: { progress: number; total?: number | undefined; message?: string | undefined }) {
  const amount = progress.total === undefined ? `${progress.progress}` : `${progress.progress}/${progress.total}`;
  return {
    content: [{ type: "text" as const, text: progress.message ? `${amount} — ${progress.message}` : amount }],
    details: { progress },
  };
}

function useProxyTool(config: McpConfig) {
  return config.toolMode === "proxy";
}

function startupMode(config: McpConfig) {
  return config.startup ?? "lazy";
}

function buildSearchPattern(query: string, regex: boolean): { pattern: RegExp } | { error: string; details: Record<string, unknown> } {
  if (!query.trim()) return { error: "MCP search query cannot be empty.", details: { mode: "search", error: "empty_query" } };
  try {
    if (regex) return { pattern: new RegExp(query, "i") };
    const escaped = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return { pattern: new RegExp(escaped.join("|"), "i") };
  } catch {
    return { error: `Invalid MCP search regex: ${query}`, details: { mode: "search", error: "invalid_regex", query } };
  }
}

function formatProxyToolDescription(entry: McpToolEntry) {
  const lines = [entry.key, `Server: ${entry.server}`, `Original name: ${entry.name}`, ""];
  lines.push(entry.tool.description || "(no description)", "");
  lines.push("Parameters:", JSON.stringify(toolParameters(entry.tool), null, 2));
  lines.push("", `Call with: mcp({ tool: "${entry.key}", args: "{...}" })`);
  return lines.join("\n");
}

function parseListResourcesArgs(value: unknown) {
  const args = isPlainRecord(value) ? value : {};
  return { server: optionalString(args, "server") };
}

function parseReadResourceArgs(value: unknown) {
  const args = isPlainRecord(value) ? value : {};
  return { server: requiredString(args, "server"), uri: requiredString(args, "uri") };
}

function parseWatchResourceArgs(value: unknown) {
  const args = isPlainRecord(value) ? value : {};
  return {
    server: requiredString(args, "server"),
    uri: requiredString(args, "uri"),
    subscribe: typeof args.subscribe === "boolean" ? args.subscribe : true,
  };
}

function parseCompleteResourceArgs(value: unknown) {
  const args = isPlainRecord(value) ? value : {};
  return {
    server: requiredString(args, "server"),
    uri: requiredString(args, "uri"),
    argument: requiredString(args, "argument"),
    value: optionalString(args, "value") ?? "",
  };
}

function formatStatus(name: string, serverConfig: McpConfig["servers"][string] | undefined, status: McpStatus) {
  const target = formatMcpServerTarget(serverConfig);
  const detail =
    status.status === "failed" || status.status === "needs_client_registration"
      ? `\n  ${status.error}`
      : status.status === "needs_auth"
        ? "\n  Open /mcp and press a to authenticate."
        : "";
  return `${name}: ${status.status}${target ? `\n  ${target}` : ""}${detail}`;
}

function safeErrorSummary(error: unknown) {
  return error instanceof Error ? `${error.name}: ${redactSecrets(error.message)}` : `thrown ${typeof error}`;
}

function showCommandMessage(pi: ExtensionAPI, title: string, content: string) {
  pi.sendMessage(
    {
      customType: "pi-mcp",
      content: `## ${title}\n\n${content}`,
      display: true,
      details: { title },
    },
    { triggerTurn: false },
  );
}

function typeboxToolParameters(tool: Tool): TSchema {
  const parameters = toolParameters(tool);
  // SAFETY: Pi's extension API accepts TypeBox-compatible JSON Schema. normalizeToolSchema limits MCP schemas
  // to the JSON Schema subset used by TypeBox tool parameters before this interop boundary.
  return parameters as TSchema;
}

function renderMcpProxyCall(args: unknown, theme: RenderTheme) {
  if (!isPlainRecord(args)) return renderToolCall(MCP_PROXY_TOOL, args, theme);
  const title = theme.fg("toolTitle", theme.bold(formatMcpProxyCallTitle(args)));
  const rawArgs = typeof args.args === "string" ? args.args : undefined;
  if (!rawArgs) return new Text(title, 0, 0);
  return new Text(`${title}\n${theme.fg("muted", formatJsonish(rawArgs))}`, 0, 0);
}

function formatMcpProxyCallTitle(args: Record<string, unknown>) {
  if (typeof args.tool === "string") return args.server ? `mcp call ${args.tool} @ ${args.server}` : `mcp call ${args.tool}`;
  if (typeof args.connect === "string") return `mcp connect ${args.connect}`;
  if (typeof args.describe === "string") return args.server ? `mcp describe ${args.describe} @ ${args.server}` : `mcp describe ${args.describe}`;
  if (typeof args.search === "string") return args.server ? `mcp search ${args.search} @ ${args.server}` : `mcp search ${args.search}`;
  if (typeof args.server === "string") return `mcp list ${args.server}`;
  if (typeof args.action === "string") return `mcp ${args.action}`;
  return "mcp status";
}

function renderToolCall(name: string, args: unknown, theme: RenderTheme) {
  const title = theme.fg("toolTitle", theme.bold(name));
  const renderedArgs = formatRenderedCallArgs(args);
  if (!renderedArgs) return new Text(title, 0, 0);
  return new Text(`${title}\n${theme.fg("muted", renderedArgs)}`, 0, 0);
}

function formatRenderedCallArgs(args: unknown) {
  if (!hasUsefulObjectContent(args)) return "";
  return formatJsonish(args);
}

function formatJsonish(value: unknown) {
  let text: string;
  if (typeof value === "string") {
    try {
      text = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      text = value;
    }
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return truncateText(text, MAX_RENDERED_CALL_ARGS_CHARS);
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function hasUsefulObjectContent(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

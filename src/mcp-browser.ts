import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { UriTemplate } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { formatResourceContent } from "./catalog.js";
import type { McpManager } from "./manager.js";
import { safeUiText } from "./answer-flow.js";

/** Open read-only tool metadata or resource discovery from the MCP server manager. */
export function browseMcpEffect(ctx: ExtensionContext, manager: McpManager, server: string, kind: "tools" | "resources" | "capabilities") {
  return Effect.gen(function* () {
    const connected = manager.connectedClients().get(server);
    if (!connected) return yield* Effect.fail(new Error("Connect this server to inspect its capabilities."));
    if (kind === "capabilities") {
      yield* inspectMcpTextEffect(ctx, `${server} — capabilities`, JSON.stringify({
        implementation: connected.client.getServerVersion(),
        protocol: connected.client.getProtocolEra(),
        capabilities: connected.client.getServerCapabilities(),
        instructions: connected.client.getInstructions(),
        subscriptions: manager.subscribedResources(server),
        clientFeatures: { elicitation: ["form", "url"], resources: true, completions: true, sampling: false },
      }, null, 2));
      return;
    }
    while (true) {
      if (!manager.connectedClients().has(server)) return yield* Effect.fail(new Error(`MCP server ${server} disconnected.`));
      if (kind === "tools") {
        const entries = manager.getToolEntries().filter((entry) => entry.server === server);
        const selected = yield* pickMcpItemEffect(ctx, `${server} — tools (inspect only)`, entries.map((entry) => ({ label: entry.name, description: entry.tool.description ?? "" })));
        if (selected === undefined) return;
        const entry = entries[selected]!;
        yield* inspectMcpTextEffect(ctx, `${server}/${entry.name}`, JSON.stringify(entry.tool, null, 2));
      } else {
        const catalog = yield* manager.resourcesEffect(server, { signal: undefined });
        const subscriptions = manager.subscribedResources(server);
        const items = [
          ...catalog.resources.map((r) => ({ label: `${subscriptions.includes(r.uri) ? "● " : ""}${r.name}`, description: r.description ?? r.uri, uri: r.uri, template: false })),
          ...catalog.templates.map((r) => ({ label: `[template] ${r.name}`, description: r.description ?? r.uriTemplate, uri: r.uriTemplate, template: true })),
          ...subscriptions.filter((uri) => !catalog.resources.some((r) => r.uri === uri)).map((uri) => ({ label: `● ${uri}`, description: "Active subscription", uri, template: false })),
        ];
        const selected = yield* pickMcpItemEffect(ctx, `${server} — resources & templates`, items);
        if (selected === undefined) return;
        const item = items[selected]!;
        const uri = item.template ? yield* resolveTemplateEffect(ctx, manager, server, item.uri) : item.uri;
        if (!uri) continue;
        while (true) {
          const supported = !!manager.connectedClients().get(server)?.client.getServerCapabilities()?.resources?.subscribe;
          const subscribed = manager.subscribedResources(server).includes(uri);
          const choices = ["Preview resource", ...(supported ? [subscribed ? "Unsubscribe" : "Subscribe"] : []), "Back"];
          const action = yield* pickMcpItemEffect(ctx, `${server} — ${uri}`, choices.map((label) => ({ label, description: "" })));
          if (action === undefined || choices[action] === "Back") break;
          if (choices[action] === "Preview resource") {
            const result = yield* manager.readResourceEffect(server, uri, { signal: undefined });
            const formatted = formatResourceContent(server, uri, result);
            yield* inspectMcpTextEffect(ctx, `${server} — resource preview`, `${formatted.text}${formatted.images.length ? `\n\n${formatted.images.length} image(s) available through read_mcp_resource; this preview is text-only.` : ""}`);
          } else {
            yield* (subscribed ? manager.unsubscribeResourceEffect(server, uri, { signal: undefined }) : manager.subscribeResourceEffect(server, uri, { signal: undefined }));
            ctx.ui.notify(`${subscribed ? "Unsubscribed from" : "Subscribed to"} ${uri}`, "info");
          }
        }
      }
    }
  });
}

/** Inspect bounded text without sending server content into the conversation. */
export function inspectMcpTextEffect(ctx: ExtensionContext, title: string, text: string, confirmLabel?: string) {
  return Effect.tryPromise({
    try: () => ctx.ui.custom<boolean>((tui, theme, keys, done) => {
      let scroll = 0;
      let maxScroll = 0;
      const content = safeUiText(text.slice(0, 50_000)) + (text.length > 50_000 ? "\n[Preview truncated at 50,000 characters]" : "");
      return {
        invalidate() {},
        handleInput(data) {
          if (keys.matches(data, "tui.select.cancel")) done(false);
          else if (keys.matches(data, "tui.select.confirm")) done(true);
          else if (keys.matches(data, "tui.select.down")) scroll = Math.min(maxScroll, scroll + 1);
          else if (keys.matches(data, "tui.select.up")) scroll = Math.max(0, scroll - 1);
          else if (keys.matches(data, "tui.select.pageDown")) scroll = Math.min(maxScroll, scroll + 10);
          else if (keys.matches(data, "tui.select.pageUp")) scroll = Math.max(0, scroll - 10);
          tui.requestRender();
        },
        render(width) {
          width = Math.max(1, width);
          const lines = wrapTextWithAnsi(content, width);
          const height = Math.max(1, (tui.terminal.rows ?? 24) - 5);
          maxScroll = Math.max(0, lines.length - height);
          scroll = Math.min(scroll, maxScroll);
          return [theme.fg("accent", truncateToWidth(safeUiText(title), width)), ...lines.slice(scroll, scroll + height),
            theme.fg("dim", truncateToWidth(`${scroll + 1}/${lines.length} • ↑↓/PgUp/PgDn scroll • Enter ${confirmLabel ?? "back"} • Esc back`, width))];
        },
      };
    }),
    catch: (error) => error,
  });
}

/** Search a catalog using native Pi input and selection components. */
export function pickMcpItemEffect(ctx: ExtensionContext, title: string, items: readonly { label: string; description: string }[]) {
  return Effect.tryPromise({
    try: () => ctx.ui.custom<number | undefined>((tui, theme, keys, done) => {
      const input = new Input();
      let query = "";
      const makeList = () => new SelectList(items.flatMap((item, index) => `${item.label} ${item.description}`.toLowerCase().includes(query.toLowerCase())
        ? [{ value: String(index), label: safeUiText(item.label), description: safeUiText(item.description) }] : []), Math.max(1, Math.min(12, tui.terminal.rows - 7)), {
          selectedPrefix: (s) => theme.fg("accent", s), selectedText: (s) => theme.fg("accent", s),
          description: (s) => theme.fg("muted", s), scrollInfo: (s) => theme.fg("dim", s), noMatch: (s) => theme.fg("warning", s),
        });
      let list = makeList();
      return {
        get focused() { return input.focused; },
        set focused(value: boolean) { input.focused = value; },
        invalidate() { input.invalidate(); list.invalidate(); },
        handleInput(data) {
          if (keys.matches(data, "tui.select.cancel")) done(undefined);
          else if (keys.matches(data, "tui.select.confirm")) {
            const selected = list.getSelectedItem();
            if (selected) done(Number(selected.value));
          } else if (keys.matches(data, "tui.select.up")) list.handleInput("\x1b[A");
          else if (keys.matches(data, "tui.select.down")) list.handleInput("\x1b[B");
          else {
            input.handleInput(data);
            if (input.getValue() !== query) { query = input.getValue(); list = makeList(); }
          }
          tui.requestRender();
        },
        render(width) {
          width = Math.max(1, width);
          return [theme.fg("accent", truncateToWidth(safeUiText(title), width)), ...input.render(width), ...list.render(width),
            theme.fg("dim", truncateToWidth("Type to filter • ↑↓ move • Enter inspect • Esc back", width))].map((line) => truncateToWidth(line, width));
        },
      };
    }),
    catch: (error) => error,
  });
}

function resolveTemplateEffect(ctx: ExtensionContext, manager: McpManager, server: string, template: string) {
  return Effect.gen(function* () {
    const parsed = new UriTemplate(template);
    const values: Record<string, string> = Object.create(null);
    for (const name of parsed.variableNames) {
      const prefix = yield* Effect.tryPromise({ try: () => ctx.ui.input(`${name} — ${template}`, "Value or completion prefix"), catch: (error) => error });
      if (prefix === undefined) return undefined;
      const suggestions = manager.connectedClients().get(server)?.hasCompletions
        ? yield* manager.completeEffect(server, { ref: { type: "ref/resource", uri: template }, argument: { name, value: prefix }, context: { arguments: values } }, { signal: undefined }).pipe(
            Effect.map((result) => result.completion.values),
            Effect.catch(() => Effect.sync(() => { ctx.ui.notify("Completion unavailable; using your typed value.", "warning"); return [] as string[]; })),
          ) : [];
      const index = suggestions.length ? yield* pickMcpItemEffect(ctx, `Complete ${name}`, [{ label: prefix || "(empty)", description: "Use typed value" }, ...suggestions.map((label) => ({ label, description: "Server suggestion" }))]) : 0;
      if (index === undefined) return undefined;
      values[name] = index === 0 ? prefix : suggestions[index - 1]!;
    }
    return parsed.expand(values);
  });
}

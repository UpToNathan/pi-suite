import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { AuthStatus, McpStatus } from "./types.js";

/** One configured MCP server shown in the interactive manager. */
export interface McpServerView {
  /** Stable configured server name used by MCP operations. */
  readonly name: string;
  /** Whether the server runs locally or uses a remote transport. */
  readonly type: "local" | "remote";
  /** Secret-redacted command or URL shown to the user. */
  readonly target: string | undefined;
  /** Current runtime connection state. */
  readonly status: McpStatus;
  /** Persisted OAuth state for OAuth-capable remote servers. */
  readonly authStatus: AuthStatus | undefined;
  /** Whether the selected server advertises prompts. */
  readonly hasPrompts: boolean;
  /** Whether the selected server advertises resources. */
  readonly hasResources: boolean;
  /** Number of tools currently known for the selected server. */
  readonly toolCount: number;
}

/** Current configuration and runtime state rendered by the MCP manager. */
export interface McpManagerView {
  /** Loaded MCP configuration path, when file-backed. */
  readonly configSource: string | undefined;
  /** Configured MCP tool exposure mode. */
  readonly toolMode: "direct" | "proxy";
  /** Configured MCP startup connection mode. */
  readonly startupMode: "eager" | "lazy";
  /** Configured servers in deterministic display order. */
  readonly servers: readonly McpServerView[];
}

/** User intent returned by the keyboard-driven MCP manager. */
export type McpManagerAction =
  | { readonly _tag: "close" }
  | { readonly _tag: "reload" }
  | { readonly _tag: "connect"; readonly server: McpServerView }
  | { readonly _tag: "disconnect"; readonly server: McpServerView }
  | { readonly _tag: "authenticate"; readonly server: McpServerView }
  | { readonly _tag: "logout"; readonly server: McpServerView }
  | { readonly _tag: "prompt"; readonly server: McpServerView }
  | { readonly _tag: "tools" | "resources" | "capabilities"; readonly server: McpServerView };

/** Show the interactive MCP server manager over the current Pi transcript. */
export async function showMcpManagerOverlay(
  ctx: ExtensionContext,
  view: McpManagerView,
  selectedServerName?: string,
): Promise<McpManagerAction> {
  return ctx.ui.custom<McpManagerAction>(
    (tui, theme, _keybindings, done) => new McpManagerOverlay(tui, theme, view, selectedServerName, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "90%",
        maxHeight: "82%",
      },
    },
  );
}

class McpManagerOverlay {
  private selectedIndex: number;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly view: McpManagerView,
    selectedServerName: string | undefined,
    private readonly done: (action: McpManagerAction) => void,
  ) {
    const selectedIndex = view.servers.findIndex((server) => server.name === selectedServerName);
    this.selectedIndex = Math.max(0, selectedIndex);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done({ _tag: "close" });
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }
    if (data === "r") {
      this.done({ _tag: "reload" });
      return;
    }

    const server = this.getSelectedServer();
    if (server === undefined) return;
    if (data === "c" || matchesKey(data, Key.enter)) this.done({ _tag: "connect", server });
    else if (data === "d") this.done({ _tag: "disconnect", server });
    else if (data === "a" && server.authStatus !== undefined) this.done({ _tag: "authenticate", server });
    else if (data === "l" && server.authStatus !== undefined) this.done({ _tag: "logout", server });
    else if (data === "p" && server.hasPrompts) this.done({ _tag: "prompt", server });
    else if (data === "t" && server.toolCount > 0) this.done({ _tag: "tools", server });
    else if (data === "s" && server.hasResources) this.done({ _tag: "resources", server });
    else if (data === "i" && server.status.status === "connected") this.done({ _tag: "capabilities", server });
  }

  render(width: number): string[] {
    const innerWidth = Math.max(0, width - 2);
    const bodyHeight = this.getBodyHeight();
    const body = innerWidth < 60
      ? this.renderServerList(innerWidth, bodyHeight).map((line) => frameLine(this.theme, line, innerWidth))
      : this.renderTwoColumnBody(innerWidth, bodyHeight);

    return [
      topBorder(this.theme, innerWidth),
      frameLine(this.theme, this.renderHeader(innerWidth), innerWidth),
      divider(this.theme, innerWidth),
      ...body,
      divider(this.theme, innerWidth),
      frameLine(
        this.theme,
        this.theme.fg("dim", "↑↓ move • c connect • d disconnect • a auth • l logout • p prompts • t tools • s resources • i info • r reload • esc close"),
        innerWidth,
      ),
      bottomBorder(this.theme, innerWidth),
    ].map((line) => truncateToWidth(line, Math.max(0, width)));
  }

  invalidate(): void {}

  private renderTwoColumnBody(innerWidth: number, bodyHeight: number): string[] {
    const listWidth = Math.floor((innerWidth - 1) * 0.48);
    const detailWidth = innerWidth - listWidth - 1;
    const separator = this.theme.fg("borderMuted", "│");
    return combineColumns(
      this.renderServerList(listWidth, bodyHeight),
      this.renderSelectedDetails(detailWidth, bodyHeight),
      listWidth,
      detailWidth,
      separator,
    ).map((line) => frameLine(this.theme, line, innerWidth));
  }

  private renderHeader(width: number): string {
    const title = this.theme.fg("accent", this.theme.bold("MCP Servers"));
    const connected = this.view.servers.filter((server) => server.status.status === "connected").length;
    const summary = this.theme.fg(
      "muted",
      `${connected}/${this.view.servers.length} connected • ${this.view.toolMode} • ${this.view.startupMode}`,
    );
    const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(summary));
    return `${title}${" ".repeat(gap)}${summary}`;
  }

  private renderServerList(width: number, height: number): string[] {
    if (this.view.servers.length === 0) {
      return padLines([this.theme.fg("dim", "No MCP servers configured")], height);
    }

    this.selectedIndex = clamp(this.selectedIndex, 0, this.view.servers.length - 1);
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(height / 2), Math.max(0, this.view.servers.length - height)),
    );
    const end = Math.min(this.view.servers.length, start + height);
    const lines: string[] = [];

    for (let index = start; index < end; index += 1) {
      const server = this.view.servers[index];
      if (server === undefined) continue;
      const selected = index === this.selectedIndex;
      const cursor = selected ? "›" : " ";
      const state = statusGlyph(server.status);
      const row = `${cursor} ${state} ${server.name}  ${server.status.status}`;
      lines.push(selected ? this.theme.fg("accent", this.theme.bold(fitLine(row, width))) : fitLine(row, width));
    }

    return padLines(lines, height);
  }

  private renderSelectedDetails(width: number, height: number): string[] {
    const server = this.getSelectedServer();
    if (server === undefined) return padLines([this.theme.fg("dim", "Add servers to your MCP configuration, then press r to reload.")], height);

    const lines = [
      this.theme.fg("accent", this.theme.bold(server.name)),
      "",
      `${this.theme.fg("muted", "Type:")} ${server.type}`,
      `${this.theme.fg("muted", "Status:")} ${server.status.status}`,
      `${this.theme.fg("muted", "Tools [t]:")} ${server.toolCount}`,
      `${this.theme.fg("muted", "Prompts [p]:")} ${server.hasPrompts ? "available" : "none"}`,
      `${this.theme.fg("muted", "Resources [s]:")} ${server.hasResources ? "available" : "none"}`,
      this.theme.fg("dim", "[i] negotiated capabilities & subscriptions"),
    ];
    if (server.authStatus !== undefined) lines.push(`${this.theme.fg("muted", "OAuth:")} ${server.authStatus}`);
    if (server.status.status === "failed" || server.status.status === "needs_client_registration") {
      lines.push("", this.theme.fg("error", server.status.error));
    } else if (server.status.status === "needs_auth") {
      lines.push("", this.theme.fg("warning", "Authentication required — press a"));
    }
    if (server.target !== undefined) lines.push("", this.theme.fg("muted", "Target:"), ...wrapPlainText(server.target, width));
    if (this.view.configSource !== undefined) {
      lines.push("", this.theme.fg("muted", "Config:"), ...wrapPlainText(this.view.configSource, width));
    }
    return padLines(lines.map((line) => truncateToWidth(line, width)), height);
  }

  private moveSelection(delta: number): void {
    if (this.view.servers.length === 0) return;
    this.selectedIndex = clamp(this.selectedIndex + delta, 0, this.view.servers.length - 1);
    this.tui.requestRender();
  }

  private getSelectedServer(): McpServerView | undefined {
    return this.view.servers[this.selectedIndex];
  }

  private getBodyHeight(): number {
    const rows = this.tui.terminal.rows ?? 30;
    return clamp(Math.floor(rows * 0.82) - 7, 1, 30);
  }
}

function statusGlyph(status: McpStatus): string {
  switch (status.status) {
    case "connected":
      return "●";
    case "connecting":
      return "◐";
    case "needs_auth":
    case "needs_client_registration":
      return "!";
    case "failed":
      return "×";
    case "disconnected":
    case "disabled":
      return "○";
  }
}

function fitLine(text: string, width: number): string {
  const truncated = truncateToWidth(text, Math.max(0, width));
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function frameLine(theme: Theme, content: string, innerWidth: number): string {
  return `${theme.fg("borderAccent", "│")}${fitLine(content, innerWidth)}${theme.fg("borderAccent", "│")}`;
}

function topBorder(theme: Theme, innerWidth: number): string {
  return theme.fg("borderAccent", `┌${"─".repeat(innerWidth)}┐`);
}

function divider(theme: Theme, innerWidth: number): string {
  return theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`);
}

function bottomBorder(theme: Theme, innerWidth: number): string {
  return theme.fg("borderAccent", `└${"─".repeat(innerWidth)}┘`);
}

function combineColumns(
  left: readonly string[],
  right: readonly string[],
  leftWidth: number,
  rightWidth: number,
  separator: string,
): string[] {
  const rows = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    lines.push(`${fitLine(left[index] ?? "", leftWidth)}${separator}${fitLine(right[index] ?? "", rightWidth)}`);
  }
  return lines;
}

function padLines(lines: readonly string[], height: number): string[] {
  const padded = [...lines];
  while (padded.length < height) padded.push("");
  return padded.slice(0, height);
}

function wrapPlainText(text: string, width: number): string[] {
  if (width <= 1) return [truncateToWidth(text, 1)];
  const lines: string[] = [];
  for (let offset = 0; offset < text.length; offset += width) lines.push(text.slice(offset, offset + width));
  return lines.length === 0 ? [""] : lines;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

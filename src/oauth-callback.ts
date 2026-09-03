import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Effect } from "effect";
import { OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT, parseRedirectUri } from "./oauth-provider.js";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** Parsed OAuth callback parameters retained for SDK issuer validation. */
export type OAuthCallbackResult = URLSearchParams;

/** Owns one manager's OAuth callback listener and pending browser flows. */
export interface OAuthCallbackRuntime {
  /** Starts the loopback callback listener for the configured redirect URI. */
  start(redirectUri?: string): Promise<void>;
  /** Waits for a callback matching one server and state value. */
  waitForResult(server: string, state: string): Promise<OAuthCallbackResult>;
  /** Cancels the pending callback for one MCP server. */
  cancel(server: string): void;
  /** Closes the listener and rejects all pending callback waits. */
  close(): Promise<void>;
}

type PendingAuth = {
  readonly server: string;
  readonly resolve: (result: OAuthCallbackResult) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};

/** Node loopback implementation of the manager-owned OAuth callback runtime. */
export class NodeOAuthCallbackRuntime implements OAuthCallbackRuntime {
  private server: Server | undefined;
  private currentPort = OAUTH_CALLBACK_PORT;
  private currentPath = OAUTH_CALLBACK_PATH;
  private readonly pendingByState = new Map<string, PendingAuth>();
  private readonly stateByServer = new Map<string, string>();

  /** Starts the callback listener and fails when its loopback port is unavailable. */
  start(redirectUri?: string): Promise<void> {
    return Effect.runPromise(this.startEffect(redirectUri));
  }

  private startEffect(redirectUri?: string) {
    const self = this;
    return Effect.gen(function* () {
      const { port, path } = parseRedirectUri(redirectUri);
      if (self.server && (self.currentPort !== port || self.currentPath !== path)) yield* self.closeEffect();
      if (self.server) return;

      self.currentPort = port;
      self.currentPath = path;
      const nextServer = createServer((request, response) => self.handleRequest(request, response));
      yield* Effect.callback<void, Error>((resume) => {
        nextServer.once("error", (error) =>
          resume(Effect.fail(new Error(`OAuth callback server could not listen on 127.0.0.1:${port}: ${error.message}`))),
        );
        nextServer.listen(port, "127.0.0.1", () => resume(Effect.succeed(undefined)));
      });
      self.server = nextServer;
    });
  }

  /** Waits for callback parameters whose state belongs to the named MCP server. */
  waitForResult(server: string, state: string): Promise<OAuthCallbackResult> {
    this.stateByServer.set(server, state);
    return new Promise<OAuthCallbackResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingByState.get(state);
        if (!pending) return;
        this.removePending(state, pending);
        pending.reject(new Error("OAuth callback timeout - authorization took too long"));
        this.stopIfIdle();
      }, CALLBACK_TIMEOUT_MS);
      this.pendingByState.set(state, { server, resolve, reject, timeout });
    });
  }

  /** Cancels one server's pending callback without affecting another manager or server. */
  cancel(server: string): void {
    const state = this.stateByServer.get(server);
    if (!state) return;
    const pending = this.pendingByState.get(state);
    if (!pending) return;
    this.removePending(state, pending);
    pending.reject(new Error("Authorization cancelled"));
    this.stopIfIdle();
  }

  /** Closes this runtime and rejects all callback waits it owns. */
  close(): Promise<void> {
    return Effect.runPromise(this.closeEffect());
  }

  private closeEffect() {
    const self = this;
    return Effect.gen(function* () {
      const activeServer = self.server;
      self.server = undefined;
      if (activeServer) {
        yield* Effect.callback<void, never>((resume) => {
          activeServer.close(() => resume(Effect.succeed(undefined)));
        });
      }
      for (const [state, pending] of self.pendingByState) {
        self.removePending(state, pending);
        pending.reject(new Error("OAuth callback server stopped"));
      }
    });
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url || "/", `http://127.0.0.1:${this.currentPort}`);
    if (url.pathname !== this.currentPath) {
      response.writeHead(404).end("Not found");
      return;
    }

    const state = url.searchParams.get("state");
    if (!state) {
      sendHtml(response, 400, errorPage("Missing required state parameter"));
      return;
    }
    const pending = this.pendingByState.get(state);
    if (!pending) {
      sendHtml(response, 400, errorPage("Invalid or expired state parameter"));
      return;
    }
    if (url.searchParams.has("error")) {
      this.removePending(state, pending);
      pending.reject(new Error("OAuth authorization server returned an error"));
      sendHtml(response, 200, errorPage("The authorization server did not approve this request."));
      this.stopIfIdle();
      return;
    }
    if (!url.searchParams.has("code")) {
      sendHtml(response, 400, errorPage("No authorization code provided"));
      return;
    }

    this.removePending(state, pending);
    pending.resolve(new URLSearchParams(url.searchParams));
    sendHtml(response, 200, successPage());
    this.stopIfIdle();
  }

  private removePending(state: string, pending: PendingAuth): void {
    clearTimeout(pending.timeout);
    this.pendingByState.delete(state);
    if (this.stateByServer.get(pending.server) === state) this.stateByServer.delete(pending.server);
  }

  private stopIfIdle(): void {
    if (this.pendingByState.size > 0 || !this.server) return;
    this.server.close();
    this.server = undefined;
  }
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function successPage(): string {
  return `<!doctype html><html><head><title>Pi MCP Authorization</title><style>${style()}</style></head><body><main><h1>Authorization Successful</h1><p>You can close this window and return to Pi.</p></main><script>setTimeout(() => window.close(), 2000)</script></body></html>`;
}

function errorPage(error: string): string {
  return `<!doctype html><html><head><title>Pi MCP Authorization Failed</title><style>${style()}</style></head><body><main><h1>Authorization Failed</h1><p>${escapeHtml(error)}</p></main></body></html>`;
}

function style(): string {
  return "body{font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#101014;color:#f4f4f5}main{text-align:center;padding:2rem;max-width:36rem}h1{margin:0 0 1rem}p{color:#c4c4cc}";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

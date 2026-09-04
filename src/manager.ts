import path from "node:path";
import { Effect, Fiber } from "effect";
import { pathToFileURL } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  Client,
  ClientCredentialsProvider,
  CrossAppAccessProvider,
  PrivateKeyJwtProvider,
  StaticPrivateKeyJwtProvider,
  StreamableHTTPClientTransport,
  SSEClientTransport,
  UnauthorizedError,
  discoverAndRequestJwtAuthGrant,
  requestJwtAuthorizationGrant,
} from "@modelcontextprotocol/client";
import type { ClientOptions, CompleteRequestParams, ElicitRequest, ElicitResult, LoggingMessageNotification, McpSubscription, OAuthClientProvider, Prompt, Resource, ResourceTemplateType, ResourceUpdatedNotification, Tool } from "@modelcontextprotocol/client";
import open from "open";
import type {
  AuthStatus,
  CancellableOptions,
  McpConfig,
  McpConnectAllOptions,
  McpConnectOptions,
  McpInitializeOptions,
  McpServerConfig,
  McpStatus,
  OAuthConfig,
} from "./types.js";
import { AuthStore } from "./auth-store.js";
import { resolveHome } from "./config-values.js";
import { redactSecrets } from "./display.js";
import { randomHex } from "./random.js";
import { DEFAULT_TIMEOUT } from "./request-limits.js";
import { mcpToolKey, sanitizeName } from "./tool-names.js";
import { withTimeoutEffect } from "./timeout.js";
import { callMcpToolEffect, listPromptsEffect, listResourceTemplatesEffect, listResourcesEffect, listToolsEffect } from "./catalog.js";
import { McpOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider.js";
import { McpManagerError, OAuthError } from "./errors.js";
import {
  NodeOAuthCallbackRuntime,
  type OAuthCallbackRuntime,
} from "./oauth-callback.js";

const MCP_CLIENT_OPTIONS = {
  capabilities: {
    elicitation: {
      form: { applyDefaults: true },
      url: {},
    },
    roots: {},
  },
  versionNegotiation: { mode: "auto" as const },
  inputRequired: { autoFulfill: true },
} satisfies ClientOptions;

type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport;

interface ManagedClient {
  client: Client;
  transport: Transport;
  config: McpServerConfig;
  tools: Tool[];
}

interface ConnectionResult {
  readonly status: McpStatus;
  readonly client?: Client;
  readonly transport?: Transport;
}

/** Connected MCP client snapshot exposed for extension integration and tests. */
export interface ConnectedMcpClient {
  readonly client: Client;
  readonly hasCompletions: boolean;
  readonly hasPrompts: boolean;
  readonly hasResources: boolean;
  readonly hasTools: boolean;
}

/** Connected MCP tool metadata used to register Pi dynamic tools. */
export interface McpToolEntry {
  readonly server: string;
  readonly name: string;
  readonly key: string;
  readonly client: Client;
  readonly tool: Tool;
  readonly timeout: number;
}

/** Result of listing resources across one or more MCP servers. */
export interface McpResourcesResult {
  readonly resources: Array<Resource & { readonly client: string }>;
  readonly templates: Array<ResourceTemplateType & { readonly client: string }>;
  readonly failures: readonly McpServerFailure[];
}

/** Result of listing prompts across one or more MCP servers. */
export interface McpPromptsResult {
  readonly prompts: Array<Prompt & { readonly client: string; readonly commandName: string }>;
  readonly failures: readonly McpServerFailure[];
}

/** Safe summary for a per-server list failure when partial results remain useful. */
export interface McpServerFailure {
  readonly server: string;
  readonly error: string;
}

interface ManagerOptions {
  cwd: string;
  authStore?: AuthStore;
  onCatalogChanged?: (server: string, kind: "prompts" | "resources") => void | Promise<void>;
  onResourceUpdated?: (server: string, uri: string) => void | Promise<void>;
  onElicitation?: (server: string, request: ElicitRequest) => ElicitResult | Promise<ElicitResult>;
  onToolsChanged?: (server: string) => void | Promise<void>;
  onStatusChanged?: () => void | Promise<void>;
  openAuthorizationUrl?: (url: string) => void | Promise<void>;
  oauthCallbackRuntime?: OAuthCallbackRuntime;
}

/** Manages configured MCP clients, dynamic Pi tool registration data, resources, prompts, and OAuth state. */
export class McpManager {
  private auth: AuthStore;
  private readonly oauthCallbacks: OAuthCallbackRuntime;
  private readonly oauthProviders = new Map<string, Set<McpOAuthProvider>>();
  private clients = new Map<string, ManagedClient>();
  private statuses = new Map<string, McpStatus>();
  private config: McpConfig = { servers: {} };
  private pendingOAuthTransports = new Map<string, TransportWithAuth>();
  private manuallyDisconnected = new Set<string>();
  private connectionAttempts = new Map<string, Fiber.Fiber<McpStatus, unknown>>();
  private resourceSubscriptions = new Map<string, { client: Client; subscription?: McpSubscription; uri: string }>();
  private closed = false;
  private revision = 0;

  /** Creates a manager for one Pi workspace and optional auth/UI callback seams. */
  constructor(private options: ManagerOptions) {
    this.auth = options.authStore ?? new AuthStore();
    this.oauthCallbacks = options.oauthCallbackRuntime ?? new NodeOAuthCallbackRuntime();
  }

  /** Replaces the active MCP configuration and runs the caller-selected startup operation. */
  initialize(config: McpConfig, options: McpInitializeOptions): Promise<void> {
    return Effect.runPromise(this.initializeEffect(config, options));
  }

  /** Effect-native manager initialization. */
  initializeEffect(config: McpConfig, options: McpInitializeOptions) {
    const self = this;
    return Effect.gen(function* () {
      self.closed = false;
      self.revision += 1;
      self.deactivateOAuthProviders();
      yield* self.oauthCallbacks.closeEffect();
      yield* self.closePendingOAuthTransportsEffect();
      yield* self.closeClientsEffect();
      yield* self.closeConnectionAttemptsEffect();
      self.statuses.clear();
      self.config = cloneMcpConfig(config);

      for (const [name, serverConfig] of Object.entries(self.config.servers)) {
        self.statuses.set(name, isConfigDisabled(serverConfig) ? { status: "disabled" } : { status: "disconnected" });
      }

      if (options.mode === "connect") {
        yield* self.connectAllEffect({ intent: options.intent, signal: options.signal });
        return;
      }
      yield* self.emitStatusChangedEffect();
    });
  }

  /** Connects every eligible configured MCP server in parallel and returns the latest status snapshot. */
  connectAll(options: McpConnectAllOptions): Promise<Record<string, McpStatus>> {
    return Effect.runPromise(this.connectAllEffect(options));
  }

  /** Effect-native parallel connection of eligible servers. */
  connectAllEffect(options: McpConnectAllOptions) {
    const self = this;
    return Effect.gen(function* () {
      const targets = Object.entries(self.config.servers).filter(([name, serverConfig]) => {
        const status = self.statuses.get(name);
        return options.intent === "automatic"
          ? self.canAutoConnect(name, serverConfig, status)
          : self.canExplicitConnect(serverConfig);
      });
      const settled = yield* Effect.all(
        targets.map(([name]) => self.connectEffect(name, { intent: options.intent, signal: options.signal })),
        { concurrency: "unbounded", mode: "result" },
      );
      let hasUnhandledFailure = false;
      for (let index = 0; index < settled.length; index++) {
        const result = settled[index];
        const target = targets[index];
        if (!result || !target || result._tag === "Success") continue;
        if (isAbortError(result.failure)) return yield* Effect.fail(result.failure);
        self.statuses.set(target[0], { status: "failed", error: errorMessage(result.failure) });
        hasUnhandledFailure = true;
      }
      if (hasUnhandledFailure) yield* self.emitStatusChangedEffect();
      return self.status();
    });
  }

  /** Returns connection status for every configured MCP server. */
  status() {
    const result: Record<string, McpStatus> = {};
    for (const name of Object.keys(this.config.servers)) {
      result[name] = cloneStatus(this.statuses.get(name) ?? { status: "disabled" });
    }
    return result;
  }

  /** Returns the parsed server configuration keyed by MCP server name. */
  configuredServers() {
    return cloneMcpConfig(this.config).servers;
  }

  /** Returns a snapshot of currently connected MCP clients. */
  connectedClients(): ReadonlyMap<string, ConnectedMcpClient> {
    return new Map(
      Array.from(this.clients, ([name, managed]) => [
        name,
        {
          client: managed.client,
          hasCompletions: !!managed.client.getServerCapabilities()?.completions,
          hasPrompts: !!managed.client.getServerCapabilities()?.prompts,
          hasResources: !!managed.client.getServerCapabilities()?.resources,
          hasTools: !!managed.client.getServerCapabilities()?.tools,
        },
      ]),
    );
  }

  /** Returns the connected MCP tools that should be exposed as Pi tools. */
  getToolEntries(): McpToolEntry[] {
    const result: McpToolEntry[] = [];
    for (const [server, managed] of this.clients) {
      if (this.statuses.get(server)?.status !== "connected") continue;
      for (const tool of managed.tools) {
        result.push({
          server,
          name: tool.name,
          key: mcpToolKey(server, tool.name),
          client: managed.client,
          tool,
          timeout: managed.config.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT,
        });
      }
    }
    return result;
  }

  /** Finds a connected MCP tool by its Pi tool key. */
  getToolEntry(key: string) {
    return this.getToolEntries().find((entry) => entry.key === key);
  }

  /** Calls a connected tool and retries once after a completed OAuth scope step-up. */
  callToolEffect(entry: McpToolEntry, args: Record<string, unknown>, options: CancellableOptions & {
    readonly onProgress?: ((progress: { progress: number; total?: number | undefined; message?: string | undefined }) => void) | undefined;
  }) {
    const call = () => callMcpToolEffect({
      client: entry.client,
      tool: entry.tool,
      args,
      timeout: entry.timeout,
      signal: options.signal,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    return call().pipe(
      Effect.catchIf(
        (error) => error instanceof UnauthorizedError && this.statuses.get(entry.server)?.status === "connected",
        call,
      ),
    );
  }

  /** Connects or reconnects one configured MCP server. */
  connect(name: string, options: McpConnectOptions): Promise<McpStatus> {
    return Effect.runPromise(this.connectEffect(name, options));
  }

  /** Effect-native connection or reconnection of one server. */
  connectEffect(name: string, options: McpConnectOptions) {
    const self = this;
    return Effect.suspend(() => {
      const serverConfig = self.config.servers[name];
      if (!serverConfig) return Effect.fail(new McpManagerError({ message: `MCP server not found: ${name}` }));
      const currentStatus = self.statuses.get(name);
      if (options.intent === "automatic" && !self.canAutoConnect(name, serverConfig, currentStatus)) {
        return Effect.succeed(currentStatus ?? { status: "disabled" as const });
      }
      if (options.intent === "explicit") {
        if (!self.canExplicitConnect(serverConfig)) {
          const disabled = { status: "disabled" as const };
          self.statuses.set(name, disabled);
          return Effect.succeed(disabled);
        }
        self.manuallyDisconnected.delete(name);
      }
      try {
        options.signal?.throwIfAborted();
      } catch (error) {
        return Effect.fail(error);
      }
      const existing = self.connectionAttempts.get(name);
      if (existing) return waitForConnectAttemptEffect(Fiber.join(existing), options.signal);
      const revision = self.revision;
      const attempt = Effect.runFork(self.connectFreshEffect(name, serverConfig, revision, { signal: options.signal }));
      self.connectionAttempts.set(name, attempt);
      attempt.addObserver(() => {
        if (self.connectionAttempts.get(name) === attempt) self.connectionAttempts.delete(name);
      });
      return waitForConnectAttemptEffect(Fiber.join(attempt), options.signal);
    });
  }

  /** Disconnects one configured MCP server for the current runtime. */
  disconnect(name: string) {
    return Effect.runPromise(this.disconnectEffect(name));
  }

  /** Effect-native disconnection of one server. */
  disconnectEffect(name: string) {
    const self = this;
    return Effect.gen(function* () {
      if (!self.config.servers[name]) return yield* Effect.fail(new McpManagerError({ message: `MCP server not found: ${name}` }));
      self.manuallyDisconnected.add(name);
      yield* self.disconnectClientEffect(name, { status: "disabled" });
      yield* Effect.tryPromise({ try: () => Promise.resolve(self.options.onToolsChanged?.(name)), catch: (error) => error });
      yield* self.emitStatusChangedEffect();
    });
  }

  /** Lists resources exposed by connected MCP servers, optionally restricted to one server. */
  resources(server: string | undefined, options: CancellableOptions): Promise<McpResourcesResult> {
    return Effect.runPromise(this.resourcesEffect(server, options));
  }

  /** Effect-native resource listing. */
  resourcesEffect(server: string | undefined, options: CancellableOptions) {
    const targets = Array.from(this.clients).filter(([name, managed]) => {
      if (server && name !== server) return false;
      return !!managed.client.getServerCapabilities()?.resources;
    });
    if (server) {
      const managed = targets[0]?.[1];
      if (!managed) return Effect.succeed<McpResourcesResult>({ resources: [], templates: [], failures: [] });
      const timeout = managed.config.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT;
      return Effect.all([
        listResourcesEffect(managed.client, timeout, options.signal),
        listResourceTemplatesEffect(managed.client, timeout, options.signal),
      ]).pipe(
        Effect.map(([resources, templates]): McpResourcesResult => ({
          resources: resources.map((resource) => ({ ...resource, client: server })),
          templates: templates.map((template) => ({ ...template, client: server })),
          failures: [],
        })),
      );
    }
    return collectPartialEffect(targets, options.signal, (name, managed) => {
      const timeout = managed.config.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT;
      return Effect.all([
        listResourcesEffect(managed.client, timeout, options.signal),
        listResourceTemplatesEffect(managed.client, timeout, options.signal),
      ]).pipe(Effect.map(([resources, templates]) => [{ resources, templates, client: name }]));
    }).pipe(Effect.map((collected): McpResourcesResult => ({
      resources: collected.items.flatMap(({ resources, client }) => resources.map((resource) => ({ ...resource, client }))),
      templates: collected.items.flatMap(({ templates, client }) => templates.map((template) => ({ ...template, client }))),
      failures: collected.failures,
    })));
  }

  /** Requests completion candidates for a prompt argument or resource-template variable. */
  complete(clientName: string, params: CompleteRequestParams, options: CancellableOptions) {
    return Effect.runPromise(this.completeEffect(clientName, params, options));
  }

  /** Effect-native MCP completion request. */
  completeEffect(clientName: string, params: CompleteRequestParams, options: CancellableOptions) {
    const managed = this.clients.get(clientName);
    if (!managed) return Effect.fail(new McpManagerError({ message: `MCP server "${clientName}" is not connected` }));
    if (!managed.client.getServerCapabilities()?.completions) return Effect.fail(new McpManagerError({ message: `MCP server "${clientName}" does not support completions` }));
    return Effect.tryPromise({
      try: () => managed.client.complete(
        params,
        sdkRequestOptions(managed.config.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT, options.signal),
      ),
      catch: (error) => error,
    });
  }

  /** Subscribes to updates for one resource using the negotiated protocol era. */
  subscribeResource(clientName: string, uri: string, options: CancellableOptions) {
    return Effect.runPromise(this.subscribeResourceEffect(clientName, uri, options));
  }

  /** Effect-native resource subscription. */
  subscribeResourceEffect(clientName: string, uri: string, options: CancellableOptions) {
    const self = this;
    return Effect.gen(function* () {
      const managed = self.clients.get(clientName);
      if (!managed) return yield* Effect.fail(new McpManagerError({ message: `MCP server "${clientName}" is not connected` }));
      if (!managed.client.getServerCapabilities()?.resources?.subscribe) return yield* Effect.fail(new McpManagerError({ message: `MCP server "${clientName}" does not support resource subscriptions` }));
      const key = resourceSubscriptionKey(clientName, uri);
      if (self.resourceSubscriptions.has(key)) return;
      const timeout = managed.config.timeout ?? self.config.timeout ?? DEFAULT_TIMEOUT;
      if (managed.client.getProtocolEra() === "modern") {
        const subscription = yield* Effect.tryPromise({
          try: () => managed.client.listen({ resourceSubscriptions: [uri] }, sdkRequestOptions(timeout, options.signal)),
          catch: (error) => error,
        });
        self.resourceSubscriptions.set(key, { client: managed.client, subscription, uri });
        return;
      }
      yield* Effect.tryPromise({
        try: () => managed.client.subscribeResource({ uri }, sdkRequestOptions(timeout, options.signal)),
        catch: (error) => error,
      });
      self.resourceSubscriptions.set(key, { client: managed.client, uri });
    });
  }

  /** Cancels an active resource subscription. */
  unsubscribeResource(clientName: string, uri: string, options: CancellableOptions) {
    return Effect.runPromise(this.unsubscribeResourceEffect(clientName, uri, options));
  }

  /** Effect-native resource unsubscription. */
  unsubscribeResourceEffect(clientName: string, uri: string, options: CancellableOptions) {
    const key = resourceSubscriptionKey(clientName, uri);
    const active = this.resourceSubscriptions.get(key);
    this.resourceSubscriptions.delete(key);
    if (!active) return Effect.void;
    if (active.subscription) return Effect.tryPromise({ try: () => active.subscription!.close(), catch: (error) => error });
    const managed = this.clients.get(clientName);
    if (!managed || managed.client !== active.client) return Effect.void;
    return Effect.tryPromise({
      try: () => managed.client.unsubscribeResource({ uri }, sdkRequestOptions(managed.config.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT, options.signal)),
      catch: (error) => error,
    }).pipe(Effect.asVoid);
  }

  /** Lists prompts exposed by every connected MCP server. */
  prompts(options: CancellableOptions): Promise<McpPromptsResult> {
    return Effect.runPromise(this.promptsEffect(options));
  }

  /** Effect-native prompt listing. */
  promptsEffect(options: CancellableOptions) {
    const targets = Array.from(this.clients).filter(([, managed]) => !!managed.client.getServerCapabilities()?.prompts);
    return collectPartialEffect(targets, options.signal, (name, managed) =>
      listPromptsEffect(managed.client, managed.config.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT, options.signal).pipe(
        Effect.map((prompts) => prompts.map((prompt) => ({
          ...prompt,
          client: name,
          commandName: `${sanitizeName(name)}:${sanitizeName(prompt.name)}`,
        }))),
      ),
    ).pipe(Effect.map((collected): McpPromptsResult => ({ prompts: collected.items, failures: collected.failures })));
  }

  /** Fetches one prompt from a connected MCP server. */
  getPrompt(clientName: string, name: string, args: Record<string, string> | undefined, options: CancellableOptions) {
    return Effect.runPromise(this.getPromptEffect(clientName, name, args, options));
  }

  /** Effect-native prompt fetch. */
  getPromptEffect(clientName: string, name: string, args: Record<string, string> | undefined, options: CancellableOptions) {
    const managed = this.clients.get(clientName);
    if (!managed) return Effect.fail(new McpManagerError({ message: `MCP server "${clientName}" is not connected` }));
    return Effect.tryPromise({
      try: () => managed.client.getPrompt(
        { name, arguments: args },
        sdkRequestOptions(managed.config.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT, options.signal),
      ),
      catch: (error) => error,
    });
  }

  /** Reads one resource from a connected MCP server. */
  readResource(clientName: string, uri: string, options: CancellableOptions) {
    return Effect.runPromise(this.readResourceEffect(clientName, uri, options));
  }

  /** Effect-native resource read. */
  readResourceEffect(clientName: string, uri: string, options: CancellableOptions) {
    const managed = this.clients.get(clientName);
    if (!managed) return Effect.fail(new McpManagerError({ message: `MCP server "${clientName}" is not connected` }));
    if (!managed.client.getServerCapabilities()?.resources) return Effect.fail(new McpManagerError({ message: `MCP server "${clientName}" does not support resources` }));
    return Effect.tryPromise({
      try: () => managed.client.readResource(
        { uri },
        sdkRequestOptions(managed.config.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT, options.signal),
      ),
      catch: (error) => error,
    });
  }

  /** Reports whether any connected MCP server currently supports resources. */
  supportsResources() {
    for (const managed of this.clients.values()) {
      if (managed.client.getServerCapabilities()?.resources) return true;
    }
    return false;
  }

  /** Reports whether any connected MCP server currently supports completions. */
  supportsCompletions() {
    for (const managed of this.clients.values()) {
      if (managed.client.getServerCapabilities()?.completions) return true;
    }
    return false;
  }

  /** Runs the OAuth flow for one remote MCP server and reconnects it after successful authorization. */
  authenticate(name: string, onAuthorizationUrl?: (url: string) => void | Promise<void>): Promise<McpStatus> {
    return Effect.runPromise(this.authenticateEffect(name, onAuthorizationUrl));
  }

  /** Effect-native OAuth authorization workflow. */
  authenticateEffect(name: string, onAuthorizationUrl?: (url: string) => void | Promise<void>) {
    const self = this;
    return Effect.gen(function* () {
      const result = yield* self.startAuthEffect(name);
      if (!result.authorizationUrl) {
        self.oauthCallbacks.cancel(name);
        yield* Fiber.await(result.callbackFiber);
        const client = result.client;
        if (!client) return { status: "failed", error: "OAuth did not return a connected client" } satisfies McpStatus;
        const serverConfig = self.requireRemote(name);
        const tools = client.getServerCapabilities()?.tools
          ? yield* listToolsEffect(client, serverConfig.timeout ?? self.config.timeout ?? DEFAULT_TIMEOUT, undefined)
          : [];
        const transport = result.transport;
        if (!transport) return { status: "failed", error: "OAuth did not return a connected transport" } satisfies McpStatus;
        yield* self.storeClientEffect(name, client, transport, serverConfig, tools);
        yield* self.auth.clearOAuthStateEffect(name);
        return self.statuses.get(name) ?? ({ status: "failed", error: "OAuth did not store a connected status" } satisfies McpStatus);
      }

      yield* self.openAuthorizationUrlEffect(result.authorizationUrl, onAuthorizationUrl);
      const callbackParams = yield* Fiber.join(result.callbackFiber);
      const storedState = yield* self.auth.getOAuthStateEffect(name);
      if (storedState !== result.oauthState || callbackParams.get("state") !== result.oauthState) {
        yield* self.auth.clearOAuthStateEffect(name);
        return yield* Effect.fail(new OAuthError({ message: "OAuth state mismatch" }));
      }
      yield* self.auth.clearOAuthStateEffect(name);
      return yield* self.finishAuthEffect(name, callbackParams);
    });
  }

  /** Removes stored OAuth state and cancels any in-flight authorization for one MCP server. */
  removeAuth(name: string): Promise<void> {
    return Effect.runPromise(this.removeAuthEffect(name));
  }

  /** Effect-native removal of stored authorization. */
  removeAuthEffect(name: string) {
    this.deactivateOAuthProviders(name);
    this.oauthCallbacks.cancel(name);
    const pendingTransport = this.pendingOAuthTransports.get(name);
    this.pendingOAuthTransports.delete(name);
    return (pendingTransport ? safeCloseTransportEffect(pendingTransport) : Effect.void).pipe(
      Effect.andThen(this.auth.removeEffect(name)),
    );
  }

  /** Returns the persisted OAuth status for one MCP server. */
  authStatus(name: string): Promise<AuthStatus> {
    return Effect.runPromise(this.authStatusEffect(name));
  }

  /** Effect-native persisted authorization status. */
  authStatusEffect(name: string) {
    return this.auth.authStatusEffect(name);
  }

  /** Closes all connected MCP clients and any local OAuth callback listener. */
  close(): Promise<void> {
    return Effect.runPromise(this.closeEffect());
  }

  /** Effect-native manager shutdown. */
  closeEffect() {
    const self = this;
    return Effect.gen(function* () {
      self.closed = true;
      self.revision += 1;
      self.deactivateOAuthProviders();
      yield* self.oauthCallbacks.closeEffect();
      yield* self.closePendingOAuthTransportsEffect();
      yield* self.closeClientsEffect();
      yield* self.closeConnectionAttemptsEffect();
    });
  }

  private connectFreshEffect(name: string, serverConfig: McpServerConfig, revision: number, options: CancellableOptions) {
    const self = this;
    return Effect.gen(function* () {
      options.signal?.throwIfAborted();
      yield* self.disconnectClientEffect(name, { status: "connecting" });
      const result = yield* (serverConfig.type === "local"
        ? self.connectLocalEffect(name, serverConfig, options)
        : self.connectRemoteEffect(name, serverConfig, options));
      if (options.signal?.aborted) {
        if (result.client && result.transport) yield* safeCloseClientEffect(result.client, result.transport);
        options.signal.throwIfAborted();
      }
      if (!self.isCurrentRevision(revision)) {
        if (result.client && result.transport) yield* safeCloseClientEffect(result.client, result.transport);
        return { status: "disconnected" as const };
      }
      if (self.manuallyDisconnected.has(name)) {
        if (result.client && result.transport) yield* safeCloseClientEffect(result.client, result.transport);
        const disabled = { status: "disabled" as const };
        self.statuses.set(name, disabled);
        return disabled;
      }
      self.statuses.set(name, result.status);
      if (!result.client || !result.transport) {
        yield* Effect.tryPromise({ try: () => Promise.resolve(self.options.onToolsChanged?.(name)), catch: (error) => error });
        yield* self.emitStatusChangedEffect();
        return result.status;
      }
      const client = result.client;
      const transport = result.transport;
      const tools = yield* (client.getServerCapabilities()?.tools
        ? listToolsEffect(client, serverConfig.timeout ?? self.config.timeout ?? DEFAULT_TIMEOUT, options.signal)
        : Effect.succeed<Tool[]>([])).pipe(
          Effect.catch((error) => safeCloseClientEffect(client, transport).pipe(Effect.andThen(Effect.fail(error)))),
        );
      if (options.signal?.aborted) {
        yield* safeCloseClientEffect(client, transport);
        options.signal.throwIfAborted();
      }
      if (!self.isCurrentRevision(revision)) {
        yield* safeCloseClientEffect(client, transport);
        return { status: "disconnected" as const };
      }
      if (self.manuallyDisconnected.has(name)) {
        yield* safeCloseClientEffect(client, transport);
        const disabled = { status: "disabled" as const };
        self.statuses.set(name, disabled);
        return disabled;
      }
      const collision = findToolKeyCollision(new Map(self.clients).set(name, { client, transport, config: serverConfig, tools }));
      if (collision) {
        const status = { status: "failed" as const, error: collision.message };
        yield* safeCloseClientEffect(client, transport);
        self.statuses.set(name, status);
        yield* Effect.tryPromise({ try: () => Promise.resolve(self.options.onToolsChanged?.(name)), catch: (error) => error });
        yield* self.emitStatusChangedEffect();
        return status;
      }
      self.clients.set(name, { client, transport, config: serverConfig, tools });
      self.watch(name, client);
      yield* Effect.tryPromise({ try: () => Promise.resolve(self.options.onToolsChanged?.(name)), catch: (error) => error });
      yield* self.emitStatusChangedEffect();
      return result.status;
    });
  }

  private connectLocalEffect(name: string, serverConfig: Extract<McpServerConfig, { type: "local" }>, options: CancellableOptions) {
    const [command, ...args] = serverConfig.command;
    if (!command) return Effect.succeed<ConnectionResult>({ status: { status: "failed", error: "Local MCP command is empty" } });
    const cwd = serverConfig.cwd ? path.resolve(this.options.cwd, resolveHome(serverConfig.cwd)) : this.options.cwd;
    const transport = new StdioClientTransport({
      stderr: "pipe",
      command,
      args,
      cwd,
      env: { ...definedProcessEnv(), ...(command === "opencode" ? { BUN_BE_BUN: "1" } : {}), ...serverConfig.environment },
    });
    return Effect.result(
      this.connectTransportEffect(name, transport, serverConfig.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT, options),
    ).pipe(
      Effect.flatMap((result) => {
        if (result._tag === "Success") {
          return Effect.succeed<ConnectionResult>({ client: result.success, transport, status: { status: "connected" } });
        }
        return safeCloseTransportEffect(transport).pipe(
          Effect.andThen(
            isAbortError(result.failure)
              ? Effect.fail(result.failure)
              : Effect.succeed<ConnectionResult>({ status: { status: "failed", error: errorMessage(result.failure) } }),
          ),
        );
      }),
    );
  }

  private connectRemoteEffect(name: string, serverConfig: Extract<McpServerConfig, { type: "remote" }>, options: CancellableOptions) {
    const self = this;
    return Effect.gen(function* () {
      const url = URL.canParse(serverConfig.url) ? new URL(serverConfig.url) : undefined;
      if (!url) return { status: { status: "failed", error: `Invalid MCP URL for "${name}"` } } satisfies ConnectionResult;
      let primaryTransport: StreamableHTTPClientTransport | undefined;
      const authProvider = serverConfig.oauth === false
        ? undefined
        : self.createOAuthProvider(name, serverConfig, (authorizationUrl) =>
            primaryTransport && self.statuses.get(name)?.status === "connected"
              ? self.finishInlineAuthorization(name, serverConfig, primaryTransport, authorizationUrl)
              : undefined,
          );
      primaryTransport = new StreamableHTTPClientTransport(url, transportOptions(authProvider, serverConfig.headers, typeof serverConfig.oauth === "object" && serverConfig.oauth.skipIssuerMetadataValidation));
      const transports: TransportWithAuth[] = [
        primaryTransport,
        new SSEClientTransport(url, transportOptions(authProvider, serverConfig.headers, typeof serverConfig.oauth === "object" && serverConfig.oauth.skipIssuerMetadataValidation)),
      ];
      let lastStatus: McpStatus | undefined;
      for (const transport of transports) {
        const result = yield* Effect.result(
          self.connectTransportEffect(name, transport, serverConfig.timeout ?? self.config.timeout ?? DEFAULT_TIMEOUT, options),
        );
        if (result._tag === "Success") return { client: result.success, transport, status: { status: "connected" } } satisfies ConnectionResult;
        yield* safeCloseTransportEffect(transport);
        if (isAbortError(result.failure)) return yield* Effect.fail(result.failure);
        const message = errorMessage(result.failure);
        const isAuthError = result.failure instanceof UnauthorizedError || (!!authProvider && /oauth|authorization|unauthorized/i.test(message));
        if (isAuthError) {
          const grantType = typeof serverConfig.oauth === "object" ? serverConfig.oauth.grantType : undefined;
          if (grantType && grantType !== "authorization_code") {
            lastStatus = { status: "failed", error: message };
          } else if (/registration|client_id/i.test(message)) {
            lastStatus = { status: "needs_client_registration", error: "Server does not support dynamic client registration. Provide oauth.clientId in config." };
          } else {
            self.pendingOAuthTransports.set(name, transport);
            lastStatus = { status: "needs_auth" };
          }
          break;
        }
        lastStatus = { status: "failed", error: message };
      }
      return { status: lastStatus ?? { status: "failed", error: "Unknown MCP connection error" } } satisfies ConnectionResult;
    });
  }

  private connectTransportEffect(name: string, transport: Transport, timeout: number, options: CancellableOptions) {
    options.signal?.throwIfAborted();
    const client = this.createClient(name);
    return withTimeoutEffect(client.connect(transport), timeout, "MCP connect", options).pipe(Effect.as(client));
  }

  private createClient(server = "unknown") {
    let client: Client | undefined;
    client = new Client(
      { name: "pi", version: "0.1.0" },
      {
        ...MCP_CLIENT_OPTIONS,
        listChanged: {
          tools: {
            onChanged: (error) => {
              if (error) {
                console.error(`[mcp:${server}] tool list refresh failed: ${safeErrorSummary(error)}`);
                return;
              }
              if (!client) return;
              const refreshed = this.handleToolListChanged(server, client);
              refreshed.catch((refreshError) => {
                console.error(`[mcp:${server}] tool list refresh failed: ${safeErrorSummary(refreshError)}`);
              });
            },
          },
          prompts: {
            onChanged: (error) => this.handleCatalogListChanged(server, "prompts", error),
          },
          resources: {
            onChanged: (error) => this.handleCatalogListChanged(server, "resources", error),
          },
        },
      },
    );
    client.setRequestHandler('roots/list', () =>
      Promise.resolve({ roots: [{ uri: pathToFileURL(this.options.cwd).href }] }),
    );
    client.setRequestHandler('elicitation/create', (request) => {
      return this.options.onElicitation?.(server, request) ?? { action: "decline" };
    });
    return client;
  }

  private watch(name: string, client: Client) {
    client.onclose = () => {
      const closed = this.handleClientClosed(name, client);
      closed.catch((error) => {
        console.error(`[mcp:${name}] close handler failed: ${safeErrorSummary(error)}`);
      });
    };

    client.setNotificationHandler('notifications/message', (notification) => {
      logServerMessage(name, notification.params);
    });

    client.setNotificationHandler('notifications/resources/updated', (notification: ResourceUpdatedNotification) => {
      Promise.resolve(this.options.onResourceUpdated?.(name, notification.params.uri)).catch((error) => {
        console.error(`[mcp:${name}] resource update handler failed: ${safeErrorSummary(error)}`);
      });
    });

    if (!client.getServerCapabilities()?.tools) return;
  }

  private handleCatalogListChanged(server: string, kind: "prompts" | "resources", error: Error | null) {
    if (error) {
      console.error(`[mcp:${server}] ${kind} list refresh failed: ${safeErrorSummary(error)}`);
      return;
    }
    Promise.resolve(this.options.onCatalogChanged?.(server, kind)).catch((refreshError) => {
      console.error(`[mcp:${server}] ${kind} list change handler failed: ${safeErrorSummary(refreshError)}`);
    });
  }

  private handleToolListChanged(name: string, client: Client) {
    return Effect.runPromise(this.handleToolListChangedEffect(name, client));
  }

  private handleToolListChangedEffect(name: string, client: Client) {
    const self = this;
    return Effect.gen(function* () {
      const managed = self.clients.get(name);
      if (!managed || managed.client !== client || self.statuses.get(name)?.status !== "connected") return;
      const timeout = managed.config.timeout ?? self.config.timeout ?? DEFAULT_TIMEOUT;
      const tools = yield* listToolsEffect(client, timeout, undefined);
      const collision = findToolKeyCollision(new Map(self.clients).set(name, { ...managed, tools }));
      if (collision) {
        self.clients.delete(name);
        self.statuses.set(name, { status: "failed", error: collision.message });
        yield* safeCloseClientEffect(managed.client, managed.transport);
        yield* Effect.tryPromise({ try: () => Promise.resolve(self.options.onToolsChanged?.(name)), catch: (error) => error });
        yield* self.emitStatusChangedEffect();
        return;
      }
      managed.tools = tools;
      yield* Effect.tryPromise({ try: () => Promise.resolve(self.options.onToolsChanged?.(name)), catch: (error) => error });
    });
  }

  private startAuthEffect(name: string) {
    const self = this;
    return Effect.gen(function* () {
      const serverConfig = yield* Effect.try({ try: () => self.requireRemote(name), catch: (error) => error });
      if (serverConfig.oauth === false) return yield* Effect.fail(new OAuthError({ message: `MCP server ${name} has OAuth disabled` }));
      const oauthConfig = typeof serverConfig.oauth === "object" ? serverConfig.oauth : undefined;
      if (oauthConfig?.grantType && oauthConfig.grantType !== "authorization_code") {
        return yield* Effect.fail(new OAuthError({ message: `MCP server ${name} uses non-interactive ${oauthConfig.grantType} authentication` }));
      }
      const redirectUri = oauthConfig?.redirectUri ??
        (oauthConfig?.callbackPort ? `http://127.0.0.1:${oauthConfig.callbackPort}/mcp/oauth/callback` : undefined);
      const oauthState = randomHex();
      yield* self.oauthCallbacks.startEffect(redirectUri);
      const callbackFiber = Effect.runFork(self.oauthCallbacks.waitForResultEffect(name, oauthState));
      let capturedUrl: URL | undefined;
      let transport: TransportWithAuth | undefined;
      const flow = Effect.gen(function* () {
        yield* self.auth.updateOAuthStateEffect(name, oauthState);
        const authProvider = self.trackOAuthProvider(name, new McpOAuthProvider(
          name,
          serverConfig.url,
          oauthProviderConfig(oauthConfig, redirectUri),
          { onRedirect: (url) => { capturedUrl = url; } },
          self.auth,
        ));
        transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), transportOptions(authProvider, serverConfig.headers, oauthConfig?.skipIssuerMetadataValidation));
        const client = self.createClient(name);
        yield* Effect.tryPromise({ try: () => client.connect(transport!), catch: (error) => error });
        return { authorizationUrl: "", oauthState, callbackFiber, client, transport };
      });
      return yield* flow.pipe(
        Effect.catch((error) => {
          if (error instanceof UnauthorizedError && capturedUrl && transport) {
            self.pendingOAuthTransports.set(name, transport);
            return Effect.succeed({ authorizationUrl: capturedUrl.toString(), oauthState, callbackFiber, client: undefined, transport: undefined });
          }
          const cleanup = transport ? safeCloseTransportEffect(transport) : Effect.void;
          return cleanup.pipe(
            Effect.andThen(Effect.sync(() => self.oauthCallbacks.cancel(name))),
            Effect.andThen(Fiber.await(callbackFiber)),
            Effect.andThen(Effect.fail(error)),
          );
        }),
      );
    });
  }

  private finishAuthEffect(name: string, callbackParams: URLSearchParams) {
    const self = this;
    const transport = this.pendingOAuthTransports.get(name);
    if (!transport) return Effect.fail(new OAuthError({ message: `No pending OAuth flow for MCP server: ${name}` }));
    const flow = Effect.gen(function* () {
      yield* Effect.tryPromise({ try: () => transport.finishAuth(callbackParams), catch: (error) => error });
      const exchangedEntry = yield* self.auth.getEffect(name);
      yield* self.auth.clearCodeVerifierEffect(name);
      if (self.pendingOAuthTransports.get(name) === transport) self.pendingOAuthTransports.delete(name);
      yield* safeCloseTransportEffect(transport);
      const status = yield* self.connectEffect(name, { intent: "explicit", signal: undefined });
      if (status.status === "needs_auth" && exchangedEntry?.tokens) {
        return {
          status: "failed",
          error: "OAuth callback completed and an access token was issued, but the server rejected it on reconnect. The token may have an incompatible audience/resource for this MCP endpoint.",
        } satisfies McpStatus;
      }
      return status;
    });
    return Effect.result(flow).pipe(
      Effect.flatMap((result) => {
        if (result._tag === "Success") return Effect.succeed(result.success);
        if (self.pendingOAuthTransports.get(name) === transport) self.pendingOAuthTransports.delete(name);
        return safeCloseTransportEffect(transport).pipe(
          Effect.as({ status: "failed", error: errorMessage(result.failure) } satisfies McpStatus),
        );
      }),
    );
  }

  private finishInlineAuthorization(
    name: string,
    serverConfig: Extract<McpServerConfig, { type: "remote" }>,
    transport: StreamableHTTPClientTransport,
    authorizationUrl: URL,
  ) {
    const state = authorizationUrl.searchParams.get("state");
    if (!state) return Promise.reject(new OAuthError({ message: "OAuth authorization URL is missing state" }));
    const config = typeof serverConfig.oauth === "object" ? serverConfig.oauth : undefined;
    const redirectUri = config?.redirectUri ??
      (config?.callbackPort ? `http://127.0.0.1:${config.callbackPort}${OAUTH_CALLBACK_PATH}` : undefined);
    const self = this;
    return Effect.runPromise(Effect.gen(function* () {
      yield* self.oauthCallbacks.startEffect(redirectUri);
      const callbackFiber = Effect.runFork(self.oauthCallbacks.waitForResultEffect(name, state));
      yield* self.openAuthorizationUrlEffect(authorizationUrl.toString());
      const params = yield* Fiber.join(callbackFiber);
      if (params.get("state") !== state) return yield* Effect.fail(new OAuthError({ message: "OAuth state mismatch" }));
      yield* Effect.tryPromise({ try: () => transport.finishAuth(params), catch: (error) => error });
    }));
  }

  private createOAuthProvider(
    name: string,
    serverConfig: Extract<McpServerConfig, { type: "remote" }>,
    onRedirect: (url: URL) => void | Promise<void>,
  ): OAuthClientProvider {
    const config = typeof serverConfig.oauth === "object" ? serverConfig.oauth : undefined;
    if (config?.grantType === "client_credentials") {
      if (!config.clientId || !config.clientSecret) throw new Error("client_credentials requires oauth.clientId and oauth.clientSecret");
      return new ClientCredentialsProvider({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        ...(config.scope ? { scope: config.scope } : {}),
        ...(config.expectedIssuer ? { expectedIssuer: config.expectedIssuer } : {}),
      });
    }
    if (config?.grantType === "private_key_jwt") {
      if (!config.clientId) throw new Error("private_key_jwt requires oauth.clientId");
      const common = {
        clientId: config.clientId,
        ...(config.scope ? { scope: config.scope } : {}),
        ...(config.expectedIssuer ? { expectedIssuer: config.expectedIssuer } : {}),
      };
      if (config.jwtBearerAssertion) return new StaticPrivateKeyJwtProvider({ ...common, jwtBearerAssertion: config.jwtBearerAssertion });
      if (!config.privateKey || !config.algorithm) throw new Error("private_key_jwt requires oauth.privateKey and oauth.algorithm");
      return new PrivateKeyJwtProvider({ ...common, privateKey: config.privateKey, algorithm: config.algorithm });
    }
    if (config?.grantType === "cross_app") {
      if (!config.clientId || !config.clientSecret || !config.idpToken || !config.idpClientId) {
        throw new Error("cross_app requires oauth.clientId, oauth.clientSecret, oauth.idpToken, and oauth.idpClientId");
      }
      return new CrossAppAccessProvider({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        ...(config.expectedIssuer ? { expectedIssuer: config.expectedIssuer } : {}),
        assertion: async (context) => {
          const options = {
            audience: context.authorizationServerUrl,
            resource: context.resourceUrl,
            idToken: config.idpToken!,
            clientId: config.idpClientId!,
            ...(config.idpClientSecret ? { clientSecret: config.idpClientSecret } : {}),
            ...(context.scope ? { scope: context.scope } : {}),
            fetchFn: context.fetchFn,
          };
          return config.idpTokenEndpoint
            ? (await requestJwtAuthorizationGrant({ ...options, tokenEndpoint: config.idpTokenEndpoint })).jwtAuthGrant
            : (await discoverAndRequestJwtAuthGrant({ ...options, idpUrl: config.idpUrl! })).jwtAuthGrant;
        },
      });
    }
    return this.trackOAuthProvider(name, new McpOAuthProvider(name, serverConfig.url, config, { onRedirect }, this.auth));
  }

  private trackOAuthProvider(server: string, provider: McpOAuthProvider): McpOAuthProvider {
    const providers = this.oauthProviders.get(server) ?? new Set<McpOAuthProvider>();
    providers.add(provider);
    this.oauthProviders.set(server, providers);
    return provider;
  }

  private deactivateOAuthProviders(server?: string): void {
    const entries = server ? [[server, this.oauthProviders.get(server)] as const] : Array.from(this.oauthProviders);
    for (const [name, providers] of entries) {
      if (!providers) continue;
      for (const provider of providers) provider.deactivate();
      this.oauthProviders.delete(name);
    }
  }

  private requireRemote(name: string) {
    const serverConfig = this.config.servers[name];
    if (!serverConfig) throw new Error(`MCP server not found: ${name}`);
    if (serverConfig.type !== "remote") throw new Error(`MCP server ${name} is not a remote server`);
    if (!URL.canParse(serverConfig.url)) throw new Error(`Invalid MCP URL for "${name}"`);
    return serverConfig;
  }

  private storeClientEffect(name: string, client: Client, transport: Transport, config: McpServerConfig, tools: Tool[]) {
    const self = this;
    return Effect.gen(function* () {
      yield* self.disconnectClientEffect(name, { status: "connected" });
      const collision = findToolKeyCollision(new Map(self.clients).set(name, { client, transport, config, tools }));
      if (collision) {
        yield* safeCloseClientEffect(client, transport);
        self.statuses.set(name, { status: "failed", error: collision.message });
        yield* self.emitStatusChangedEffect();
        return;
      }
      self.statuses.set(name, { status: "connected" });
      self.clients.set(name, { client, transport, config, tools });
      self.watch(name, client);
      yield* Effect.tryPromise({ try: () => Promise.resolve(self.options.onToolsChanged?.(name)), catch: (error) => error });
      yield* self.emitStatusChangedEffect();
    });
  }

  private handleClientClosed(name: string, client: Client) {
    return Effect.runPromise(this.handleClientClosedEffect(name, client));
  }

  private handleClientClosedEffect(name: string, client: Client) {
    const managed = this.clients.get(name);
    if (managed?.client !== client) return Effect.void;
    this.clients.delete(name);
    this.statuses.set(name, { status: "failed", error: "Connection closed" });
    return Effect.tryPromise({ try: () => Promise.resolve(this.options.onToolsChanged?.(name)), catch: (error) => error }).pipe(
      Effect.andThen(this.emitStatusChangedEffect()),
    );
  }

  private disconnectClientEffect(name: string, status: McpStatus) {
    const managed = this.clients.get(name);
    this.clients.delete(name);
    this.statuses.set(name, status);
    return this.closeResourceSubscriptionsEffect(name).pipe(
      Effect.andThen(managed ? safeCloseClientEffect(managed.client, managed.transport) : Effect.void),
    );
  }

  private closeResourceSubscriptionsEffect(server?: string) {
    const subscriptions = Array.from(this.resourceSubscriptions.entries()).filter(([key]) => !server || key.startsWith(`${server}\u0000`));
    for (const [key] of subscriptions) this.resourceSubscriptions.delete(key);
    return Effect.forEach(
      subscriptions,
      ([, active]) => active.subscription
        ? Effect.tryPromise({ try: () => active.subscription!.close(), catch: (error) => error }).pipe(Effect.ignore)
        : Effect.void,
      { concurrency: "unbounded", discard: true },
    );
  }

  private closePendingOAuthTransportsEffect() {
    const transports = Array.from(this.pendingOAuthTransports.values());
    this.pendingOAuthTransports.clear();
    return Effect.forEach(transports, (transport) => safeCloseTransportEffect(transport), {
      concurrency: "unbounded",
      discard: true,
    });
  }

  private closeClientsEffect() {
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    return this.closeResourceSubscriptionsEffect().pipe(Effect.andThen(Effect.forEach(
      clients,
      (managed) => safeCloseClientEffect(managed.client, managed.transport),
      { concurrency: "unbounded", discard: true },
    )));
  }

  private closeConnectionAttemptsEffect() {
    const attempts = Array.from(this.connectionAttempts.values());
    this.connectionAttempts.clear();
    return Effect.forEach(attempts, (attempt) => Fiber.interrupt(attempt), {
      concurrency: "unbounded",
      discard: true,
    });
  }

  private emitStatusChangedEffect() {
    return Effect.tryPromise({
      try: () => Promise.resolve(this.options.onStatusChanged?.()),
      catch: (error) => error,
    });
  }

  private isCurrentRevision(revision: number) {
    return !this.closed && this.revision === revision;
  }

  private canAutoConnect(name: string, config: McpServerConfig, status: McpStatus | undefined): boolean {
    if (isConfigDisabled(config)) return false;
    if (this.manuallyDisconnected.has(name)) return false;

    return status === undefined || status.status === "disconnected" || status.status === "connecting";
  }

  private canExplicitConnect(config: McpServerConfig): boolean {
    return !isConfigDisabled(config);
  }

  private openAuthorizationUrlEffect(url: string, onAuthorizationUrl?: (url: string) => void | Promise<void>) {
    const configuredOpen = this.options.openAuthorizationUrl;
    if (configuredOpen) {
      return Effect.tryPromise({ try: () => Promise.resolve(configuredOpen(url)), catch: (error) => error });
    }
    const launch = Effect.tryPromise({ try: () => open(url), catch: (error) => error }).pipe(
      Effect.flatMap((subprocess) =>
        Effect.callback<void, Error>((resume) => {
          const complete = () => resume(Effect.succeed(undefined));
          const fail = (error: Error) => resume(Effect.fail(error));
          const exit = (code: number | null) => {
            if (code !== null && code !== 0) fail(new Error(`Browser open failed with exit code ${code}`));
          };
          const timer = setTimeout(complete, 500);
          subprocess.once("error", fail);
          subprocess.once("exit", exit);
          return Effect.sync(() => {
            clearTimeout(timer);
            subprocess.removeListener("error", fail);
            subprocess.removeListener("exit", exit);
          });
        }),
      ),
    );
    const fallback = Effect.tryPromise({
      try: () => Promise.resolve(onAuthorizationUrl?.(url)),
      catch: (error) => error,
    });
    return launch.pipe(Effect.catch(() => fallback));
  }
}

function isConfigDisabled(config: McpServerConfig) {
  return config.enabled === false || config.disabled === true;
}

function definedProcessEnv() {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function transportOptions(
  authProvider: OAuthClientProvider | undefined,
  headers: Record<string, string> | undefined,
  skipIssuerMetadataValidation = false,
) {
  return {
    ...(authProvider ? { authProvider } : {}),
    ...(skipIssuerMetadataValidation ? { skipIssuerMetadataValidation: true } : {}),
    ...(headers ? { requestInit: { headers } } : {}),
  };
}

function oauthProviderConfig(config: OAuthConfig | undefined, redirectUri: string | undefined): OAuthConfig | undefined {
  if (!config && !redirectUri) return undefined;
  return {
    ...(config?.clientId !== undefined ? { clientId: config.clientId } : {}),
    ...(config?.clientSecret !== undefined ? { clientSecret: config.clientSecret } : {}),
    ...(config?.scope !== undefined ? { scope: config.scope } : {}),
    ...(config?.callbackPort !== undefined ? { callbackPort: config.callbackPort } : {}),
    ...(redirectUri !== undefined ? { redirectUri } : {}),
  };
}

function cloneMcpConfig(config: McpConfig): McpConfig {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    servers[name] = cloneServerConfig(server);
  }
  return {
    servers,
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
    ...(config.source !== undefined ? { source: config.source } : {}),
    ...(config.toolMode !== undefined ? { toolMode: config.toolMode } : {}),
    ...(config.startup !== undefined ? { startup: config.startup } : {}),
  };
}

function cloneServerConfig(config: McpServerConfig): McpServerConfig {
  if (config.type === "local") {
    return {
      type: "local",
      command: [...config.command],
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      ...(config.environment !== undefined ? { environment: cloneStringRecord(config.environment) } : {}),
      ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
      ...(config.disabled !== undefined ? { disabled: config.disabled } : {}),
      ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
    };
  }

  return {
    type: "remote",
    url: config.url,
    ...(config.headers !== undefined ? { headers: cloneStringRecord(config.headers) } : {}),
    ...(config.oauth !== undefined ? { oauth: cloneOAuthConfig(config.oauth) } : {}),
    ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
    ...(config.disabled !== undefined ? { disabled: config.disabled } : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
  };
}

function cloneOAuthConfig(config: OAuthConfig | false): OAuthConfig | false {
  if (config === false) return false;
  return {
    ...(config.grantType !== undefined ? { grantType: config.grantType } : {}),
    ...(config.clientId !== undefined ? { clientId: config.clientId } : {}),
    ...(config.clientSecret !== undefined ? { clientSecret: config.clientSecret } : {}),
    ...(config.scope !== undefined ? { scope: config.scope } : {}),
    ...(config.callbackPort !== undefined ? { callbackPort: config.callbackPort } : {}),
    ...(config.redirectUri !== undefined ? { redirectUri: config.redirectUri } : {}),
    ...(config.clientMetadataUrl !== undefined ? { clientMetadataUrl: config.clientMetadataUrl } : {}),
    ...(config.expectedIssuer !== undefined ? { expectedIssuer: config.expectedIssuer } : {}),
    ...(config.privateKey !== undefined ? { privateKey: config.privateKey } : {}),
    ...(config.algorithm !== undefined ? { algorithm: config.algorithm } : {}),
    ...(config.jwtBearerAssertion !== undefined ? { jwtBearerAssertion: config.jwtBearerAssertion } : {}),
    ...(config.idpUrl !== undefined ? { idpUrl: config.idpUrl } : {}),
    ...(config.idpTokenEndpoint !== undefined ? { idpTokenEndpoint: config.idpTokenEndpoint } : {}),
    ...(config.idpToken !== undefined ? { idpToken: config.idpToken } : {}),
    ...(config.idpClientId !== undefined ? { idpClientId: config.idpClientId } : {}),
    ...(config.idpClientSecret !== undefined ? { idpClientSecret: config.idpClientSecret } : {}),
    ...(config.skipIssuerMetadataValidation !== undefined ? { skipIssuerMetadataValidation: config.skipIssuerMetadataValidation } : {}),
  };
}

function cloneStringRecord(value: Readonly<Record<string, string>>) {
  return Object.fromEntries(Object.entries(value));
}

function cloneStatus(status: McpStatus): McpStatus {
  switch (status.status) {
    case "connected":
      return { status: "connected" };
    case "connecting":
      return { status: "connecting" };
    case "disconnected":
      return { status: "disconnected" };
    case "disabled":
      return { status: "disabled" };
    case "needs_auth":
      return { status: "needs_auth" };
    case "failed":
      return { status: "failed", error: status.error };
    case "needs_client_registration":
      return { status: "needs_client_registration", error: status.error };
  }
}

function findToolKeyCollision(clients: ReadonlyMap<string, ManagedClient>) {
  const owners = new Map<string, { server: string; tool: string }>();
  for (const [server, managed] of clients) {
    for (const tool of managed.tools) {
      const key = mcpToolKey(server, tool.name);
      const existing = owners.get(key);
      if (existing) {
        return {
          message: `MCP tool name collision for "${key}": ${existing.server}/${existing.tool} and ${server}/${tool.name} both map to the same Pi tool name`,
        };
      }
      owners.set(key, { server, tool: tool.name });
    }
  }
  return undefined;
}

function waitForConnectAttemptEffect<E, R>(attempt: Effect.Effect<McpStatus, E, R>, signal: AbortSignal | undefined) {
  if (!signal) return attempt;
  const aborted = Effect.callback<never, DOMException>((resume) => {
    const handler = () => resume(Effect.fail(new DOMException("MCP connect aborted", "AbortError")));
    signal.addEventListener("abort", handler, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", handler));
  });
  return Effect.sync(() => signal.throwIfAborted()).pipe(Effect.andThen(Effect.race(attempt, aborted)));
}

function resourceSubscriptionKey(server: string, uri: string) {
  return `${server}\u0000${uri}`;
}

function sdkRequestOptions(timeout: number, signal: AbortSignal | undefined) {
  return {
    timeout,
    ...(signal ? { signal } : {}),
  };
}

function collectPartialEffect<T, E, R>(
  targets: Array<[string, ManagedClient]>,
  signal: AbortSignal | undefined,
  list: (name: string, managed: ManagedClient) => Effect.Effect<T[], E, R>,
) {
  return Effect.sync(() => signal?.throwIfAborted()).pipe(
    Effect.andThen(
      Effect.all(
        targets.map(([name, managed]) => list(name, managed).pipe(Effect.map((items) => ({ name, items })))),
        { concurrency: "unbounded", mode: "result" },
      ),
    ),
    Effect.map((settled) => {
      const items: T[] = [];
      const failures: McpServerFailure[] = [];
      for (let index = 0; index < settled.length; index++) {
        const result = settled[index];
        const target = targets[index];
        if (!result || !target) continue;
        if (result._tag === "Success") {
          items.push(...result.success.items);
          continue;
        }
        if (isAbortError(result.failure)) throw result.failure;
        failures.push({ server: target[0], error: safeErrorSummary(result.failure) });
      }
      return { items, failures };
    }),
  );
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function safeCloseClientEffect(client: Client, transport: Transport) {
  return Effect.tryPromise({ try: () => client.close(), catch: (error) => error }).pipe(
    Effect.catch(() => safeCloseTransportEffect(transport)),
    Effect.asVoid,
  );
}

function safeCloseTransportEffect(transport: Transport) {
  return Effect.tryPromise({ try: () => transport.close(), catch: (error) => error }).pipe(Effect.ignore);
}

function errorMessage(error: unknown) {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function logServerMessage(name: string, params: LoggingMessageNotification["params"]) {
  const prefix = `[mcp:${name}]`;
  const message = `${prefix} ${params.logger ? `${params.logger}: ` : ""}${safeLogDataSummary(params.data)}`;
  if (["error", "critical", "alert", "emergency"].includes(params.level)) console.error(message);
  else if (params.level === "warning") console.warn(message);
  else console.info(message);
}

function safeLogDataSummary(data: unknown) {
  if (data === null) return "data=null";
  if (Array.isArray(data)) return `data=array(length=${data.length})`;
  if (typeof data === "object") return `data=object(keys=${Object.keys(data).length})`;
  return `data=${typeof data}`;
}

function safeErrorSummary(error: unknown) {
  return error instanceof Error ? `${error.name}: ${redactSecrets(error.message)}` : `thrown ${typeof error}`;
}

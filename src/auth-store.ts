import { createHash, randomUUID } from "node:crypto";
import { Effect, Semaphore } from "effect";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { lock } from "proper-lockfile";
import type { AuthClientInfo, AuthDiscoveryState, AuthEntry, AuthStatus, AuthTokens } from "./types.js";
import { AuthStoreError } from "./errors.js";

type AuthData = Record<string, AuthEntry>;

const AUTH_WRITE_FENCE = Symbol("AuthWriteFence");
const AUTH_REFRESH_LOCK = Symbol("AuthRefreshLock");
const AUTH_LOCK_STALE_MILLISECONDS = 30_000;
const AUTH_LOCK_UPDATE_MILLISECONDS = 5_000;
const nativeFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const AUTH_LOCK_RETRY_OPTIONS = {
  retries: 100,
  factor: 1.15,
  minTimeout: 20,
  maxTimeout: 250,
  randomize: true,
} as const;

/** Opaque ownership token that prevents superseded OAuth providers from mutating auth state. */
export interface AuthWriteFence {
  readonly [AUTH_WRITE_FENCE]: symbol;
}

/** Cross-process lease that serializes refresh-token rotation for one MCP server. */
export interface AuthRefreshLock {
  readonly [AUTH_REFRESH_LOCK]: symbol;
  /** Effect-native release of the refresh-token rotation lease. */
  readonly releaseEffect: Effect.Effect<void, unknown>;
  /** Releases the refresh-token rotation lease; repeated calls are safe. */
  release(): Promise<void>;
}

/** Persists OAuth client metadata, tokens, and in-flight PKCE state for MCP servers. */
export class AuthStore {
  private filepath: string;
  private readonly mutex = Semaphore.makeUnsafe(1);
  private readonly activeWriteFences = new Map<string, AuthWriteFence>();

  /** Creates an auth store backed by the default Pi MCP auth file or a test-supplied path. */
  constructor(filepath = path.join(homedir(), ".pi", "agent", "mcp-auth.json")) {
    this.filepath = filepath;
  }

  /** Claims auth-write ownership for the newest OAuth provider of one MCP server. */
  createOAuthWriteFence(mcpName: string): AuthWriteFence {
    const fence: AuthWriteFence = { [AUTH_WRITE_FENCE]: Symbol(mcpName) };
    this.activeWriteFences.set(mcpName, fence);
    return fence;
  }

  /** Revokes auth-write ownership when the matching OAuth provider stops. */
  revokeOAuthWriteFence(mcpName: string, fence: AuthWriteFence): void {
    if (this.activeWriteFences.get(mcpName) === fence) this.activeWriteFences.delete(mcpName);
  }

  /** Reads every valid persisted auth entry keyed by configured MCP server name. */
  all(): Promise<AuthData> {
    return Effect.runPromise(this.allEffect());
  }

  private allEffect() {
    return this.mutex.withPermits(1)(this.readEffect());
  }

  /** Reads one valid persisted auth entry, if present. */
  get(mcpName: string): Promise<AuthEntry | undefined> {
    return Effect.runPromise(this.getEffect(mcpName));
  }

  /** Effect-native read of one persisted auth entry. */
  getEffect(mcpName: string) {
    return this.allEffect().pipe(Effect.map((data) => data[mcpName]));
  }

  /** Reads an auth entry only when it was saved for the same remote server URL. */
  getForUrl(mcpName: string, serverUrl: string) {
    return Effect.runPromise(this.getForUrlEffect(mcpName, serverUrl));
  }

  /** Effect-native URL-scoped auth lookup. */
  getForUrlEffect(mcpName: string, serverUrl: string) {
    return this.getEffect(mcpName).pipe(
      Effect.map((entry) => (!entry?.serverUrl || entry.serverUrl !== serverUrl ? undefined : entry)),
    );
  }

  /** Replaces the auth entry for one MCP server. */
  set(mcpName: string, entry: AuthEntry, serverUrl?: string) {
    return Effect.runPromise(this.setEffect(mcpName, entry, serverUrl));
  }

  /** Effect-native replacement of one auth entry. */
  setEffect(mcpName: string, entry: AuthEntry, serverUrl?: string) {
    return this.mutateEffect((data) => ({
      ...data,
      [mcpName]: serverUrl ? { ...entry, serverUrl } : entry,
    }));
  }

  /** Removes all stored auth state for one MCP server. */
  remove(mcpName: string) {
    return Effect.runPromise(this.removeEffect(mcpName));
  }

  /** Effect-native removal of one auth entry. */
  removeEffect(mcpName: string) {
    return this.mutateEffect((data) => {
      const next = { ...data };
      delete next[mcpName];
      return next;
    });
  }

  /** Stores OAuth tokens while retaining a rotating refresh token when a response omits its replacement. */
  updateTokens(mcpName: string, tokens: AuthTokens, serverUrl?: string, fence?: AuthWriteFence): Promise<void> {
    return Effect.runPromise(this.updateTokensEffect(mcpName, tokens, serverUrl, fence));
  }

  /** Effect-native token update preserving rotating refresh tokens. */
  updateTokensEffect(mcpName: string, tokens: AuthTokens, serverUrl?: string, fence?: AuthWriteFence) {
    return this.updateEntryEffect(
      mcpName,
      (entry) => ({
        ...entry,
        tokens:
          tokens.refreshToken === undefined && entry.tokens?.refreshToken !== undefined
            ? { ...tokens, refreshToken: entry.tokens.refreshToken }
            : tokens,
        ...(serverUrl ? { serverUrl } : {}),
      }),
      fence,
    );
  }

  /** Acquires the cross-process refresh-token rotation lock for one MCP server. */
  acquireOAuthRefreshLock(mcpName: string): Promise<AuthRefreshLock> {
    return Effect.runPromise(this.acquireOAuthRefreshLockEffect(mcpName));
  }

  /** Effect-native acquisition of the refresh-token rotation lock. */
  acquireOAuthRefreshLockEffect(mcpName: string) {
    const digest = createHash("sha256").update(mcpName).digest("hex");
    const target = `${this.filepath}.refresh-${digest}`;
    return acquireInterprocessLockEffect(target).pipe(
      Effect.mapError((cause) => new AuthStoreError({ message: `Could not acquire OAuth refresh lock for ${mcpName}`, cause })),
      Effect.map((release): AuthRefreshLock => {
        let released = false;
        const releaseEffect = Effect.suspend(() => {
          if (released) return Effect.void;
          released = true;
          return Effect.tryPromise({ try: () => release(), catch: (error) => error });
        });
        return {
          [AUTH_REFRESH_LOCK]: Symbol(mcpName),
          releaseEffect,
          release: () => Effect.runPromise(releaseEffect),
        };
      }),
    );
  }

  /** Stores OAuth client registration metadata for one MCP server. */
  updateClientInfo(mcpName: string, clientInfo: AuthClientInfo, serverUrl?: string, fence?: AuthWriteFence): Promise<void> {
    return Effect.runPromise(this.updateClientInfoEffect(mcpName, clientInfo, serverUrl, fence));
  }

  /** Effect-native client registration update. */
  updateClientInfoEffect(mcpName: string, clientInfo: AuthClientInfo, serverUrl?: string, fence?: AuthWriteFence) {
    return this.updateEntryEffect(mcpName, (entry) => ({ ...entry, clientInfo, ...(serverUrl ? { serverUrl } : {}) }), fence);
  }

  /** Stores OAuth discovery state for an in-flight browser round trip. */
  updateDiscoveryState(mcpName: string, discoveryState: AuthDiscoveryState, fence?: AuthWriteFence): Promise<void> {
    return Effect.runPromise(this.updateDiscoveryStateEffect(mcpName, discoveryState, fence));
  }

  /** Effect-native discovery-state update. */
  updateDiscoveryStateEffect(mcpName: string, discoveryState: AuthDiscoveryState, fence?: AuthWriteFence) {
    return this.updateEntryEffect(mcpName, (entry) => ({ ...entry, discoveryState }), fence);
  }

  /** Removes OAuth discovery state without clearing unrelated credentials. */
  clearDiscoveryState(mcpName: string, fence?: AuthWriteFence): Promise<void> {
    return Effect.runPromise(this.clearDiscoveryStateEffect(mcpName, fence));
  }

  /** Effect-native discovery-state removal. */
  clearDiscoveryStateEffect(mcpName: string, fence?: AuthWriteFence) {
    return this.clearFieldEffect(mcpName, "discoveryState", fence);
  }

  /** Removes stored OAuth tokens without clearing client registration or flow state. */
  clearTokens(mcpName: string, fence?: AuthWriteFence): Promise<void> {
    return Effect.runPromise(this.clearTokensEffect(mcpName, fence));
  }

  /** Effect-native token removal. */
  clearTokensEffect(mcpName: string, fence?: AuthWriteFence) {
    return this.clearFieldEffect(mcpName, "tokens", fence);
  }

  /** Removes stored OAuth client registration without clearing tokens or flow state. */
  clearClientInfo(mcpName: string, fence?: AuthWriteFence): Promise<void> {
    return Effect.runPromise(this.clearClientInfoEffect(mcpName, fence));
  }

  /** Effect-native client registration removal. */
  clearClientInfoEffect(mcpName: string, fence?: AuthWriteFence) {
    return this.clearFieldEffect(mcpName, "clientInfo", fence);
  }

  /** Stores a PKCE code verifier for an in-flight OAuth flow. */
  updateCodeVerifier(mcpName: string, codeVerifier: string, fence?: AuthWriteFence): Promise<void> {
    return Effect.runPromise(this.updateCodeVerifierEffect(mcpName, codeVerifier, fence));
  }

  /** Effect-native PKCE verifier update. */
  updateCodeVerifierEffect(mcpName: string, codeVerifier: string, fence?: AuthWriteFence) {
    return this.updateEntryEffect(mcpName, (entry) => ({ ...entry, codeVerifier }), fence);
  }

  /** Removes the PKCE code verifier after OAuth completion or cancellation. */
  clearCodeVerifier(mcpName: string, fence?: AuthWriteFence): Promise<void> {
    return Effect.runPromise(this.clearCodeVerifierEffect(mcpName, fence));
  }

  /** Effect-native PKCE verifier removal. */
  clearCodeVerifierEffect(mcpName: string, fence?: AuthWriteFence) {
    return this.clearFieldEffect(mcpName, "codeVerifier", fence);
  }

  /** Stores the OAuth state value for an in-flight OAuth flow. */
  updateOAuthState(mcpName: string, oauthState: string, fence?: AuthWriteFence): Promise<void> {
    return Effect.runPromise(this.updateOAuthStateEffect(mcpName, oauthState, fence));
  }

  /** Effect-native OAuth state update. */
  updateOAuthStateEffect(mcpName: string, oauthState: string, fence?: AuthWriteFence) {
    return this.updateEntryEffect(mcpName, (entry) => ({ ...entry, oauthState }), fence);
  }

  /** Reads the OAuth state value for an in-flight OAuth flow, if present. */
  getOAuthState(mcpName: string) {
    return Effect.runPromise(this.getOAuthStateEffect(mcpName));
  }

  /** Effect-native OAuth state lookup. */
  getOAuthStateEffect(mcpName: string) {
    return this.getEffect(mcpName).pipe(Effect.map((entry) => entry?.oauthState));
  }

  /** Removes the OAuth state value after OAuth completion or cancellation. */
  clearOAuthState(mcpName: string, fence?: AuthWriteFence): Promise<void> {
    return Effect.runPromise(this.clearOAuthStateEffect(mcpName, fence));
  }

  /** Effect-native OAuth state removal. */
  clearOAuthStateEffect(mcpName: string, fence?: AuthWriteFence) {
    return this.clearFieldEffect(mcpName, "oauthState", fence);
  }

  /** Classifies the stored token state for one MCP server. */
  authStatus(mcpName: string): Promise<AuthStatus> {
    return Effect.runPromise(this.authStatusEffect(mcpName));
  }

  /** Effect-native classification of stored token state. */
  authStatusEffect(mcpName: string) {
    return this.getEffect(mcpName).pipe(
      Effect.map((entry): AuthStatus => {
        if (!entry?.tokens) return "not_authenticated";
        if (!entry.tokens.expiresAt) return "authenticated";
        return entry.tokens.expiresAt < Date.now() / 1000 ? "expired" : "authenticated";
      }),
    );
  }

  private updateEntryEffect(mcpName: string, update: (entry: AuthEntry) => AuthEntry, fence?: AuthWriteFence) {
    return this.mutateEffect((data) => {
      if (fence && this.activeWriteFences.get(mcpName) !== fence) return data;
      return { ...data, [mcpName]: update(data[mcpName] ?? {}) };
    });
  }

  private clearFieldEffect(mcpName: string, field: keyof AuthEntry, fence?: AuthWriteFence) {
    return this.mutateEffect((data) => {
      if (fence && this.activeWriteFences.get(mcpName) !== fence) return data;
      const entry = data[mcpName];
      if (!entry) return data;
      return { ...data, [mcpName]: clearAuthEntryField(entry, field) };
    });
  }

  private mutateEffect(update: (data: AuthData) => AuthData) {
    const self = this;
    return this.mutex.withPermits(1)(
      withInterprocessLockEffect(
        this.filepath,
        Effect.gen(function* () {
          yield* self.writeEffect(update(yield* self.readEffect()));
        }),
      ),
    ).pipe(
      Effect.mapError((cause) => new AuthStoreError({ message: "Could not persist MCP OAuth state", cause })),
    );
  }

  private readEffect() {
    const filepath = this.filepath;
    return Effect.gen(function* () {
      if (!existsSync(filepath)) return {};
      const parsed = JSON.parse(yield* Effect.tryPromise({ try: () => readFile(filepath, "utf8"), catch: (error) => error }));
      const result = parseAuthData(parsed);
      if (result.rejected > 0) {
        warnAuthStore(`ignored ${result.rejected} malformed persisted auth ${result.rejected === 1 ? "entry" : "entries"}`);
      }
      return result.data;
    }).pipe(
      Effect.catch((error) => {
        warnAuthStore(`ignored unreadable persisted auth store: ${safeAuthStoreError(error)}`);
        return Effect.succeed<AuthData>({});
      }),
    );
  }

  private writeEffect(data: AuthData) {
    const filepath = this.filepath;
    const tmp = `${filepath}.${process.pid}.${randomUUID()}.tmp`;
    const cleanup = Effect.tryPromise({
      try: () => unlink(tmp),
      catch: (error: unknown) => (isFileNotFoundError(error) ? undefined : error),
    }).pipe(Effect.ignore);
    return Effect.gen(function* () {
      yield* Effect.tryPromise({ try: () => mkdir(path.dirname(filepath), { recursive: true }), catch: (error) => error });
      yield* Effect.tryPromise({ try: () => writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }), catch: (error) => error });
      yield* Effect.tryPromise({ try: () => rename(tmp, filepath), catch: (error) => error });
      yield* Effect.tryPromise({ try: () => chmod(filepath, 0o600), catch: (error) => error });
    }).pipe(Effect.ensuring(cleanup));
  }
}

function withInterprocessLockEffect<A, E, R>(target: string, operation: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    acquireInterprocessLockEffect(target),
    () => operation,
    (release) => Effect.tryPromise({ try: () => release(), catch: () => undefined }).pipe(Effect.ignore),
  );
}

function acquireInterprocessLockEffect(target: string) {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({ try: () => mkdir(path.dirname(target), { recursive: true }), catch: (error) => error });
    const release = yield* Effect.tryPromise({
      try: () => lock(target, {
        realpath: false,
        stale: AUTH_LOCK_STALE_MILLISECONDS,
        update: AUTH_LOCK_UPDATE_MILLISECONDS,
        retries: AUTH_LOCK_RETRY_OPTIONS,
        // proper-lockfile caches metadata on fs; bypass Bun's proxied module object.
        fs: nativeFs,
      }),
      catch: (error) => error,
    });
    const secured = yield* Effect.result(
      Effect.tryPromise({ try: () => chmod(`${target}.lock`, 0o700), catch: (error) => error }),
    );
    if (secured._tag === "Failure") {
      yield* Effect.tryPromise({ try: () => release(), catch: () => undefined }).pipe(Effect.ignore);
      return yield* Effect.fail(secured.failure);
    }
    return release;
  });
}

function parseAuthData(value: unknown): { data: AuthData; rejected: number } {
  if (!isPlainRecord(value)) return { data: {}, rejected: 1 };
  const result: AuthData = {};
  let rejected = 0;
  for (const [name, entry] of Object.entries(value)) {
    const parsed = parseAuthEntry(entry);
    if (parsed) result[name] = parsed;
    else rejected++;
  }
  return { data: result, rejected };
}

function clearAuthEntryField(entry: AuthEntry, field: keyof AuthEntry): AuthEntry {
  switch (field) {
    case "tokens": {
      const { tokens: _tokens, ...next } = entry;
      return next;
    }
    case "clientInfo": {
      const { clientInfo: _clientInfo, ...next } = entry;
      return next;
    }
    case "codeVerifier": {
      const { codeVerifier: _codeVerifier, ...next } = entry;
      return next;
    }
    case "oauthState": {
      const { oauthState: _oauthState, ...next } = entry;
      return next;
    }
    case "discoveryState": {
      const { discoveryState: _discoveryState, ...next } = entry;
      return next;
    }
    case "serverUrl": {
      const { serverUrl: _serverUrl, ...next } = entry;
      return next;
    }
  }
}

function parseAuthEntry(value: unknown): AuthEntry | undefined {
  if (!isPlainRecord(value)) return undefined;

  const tokens = parseAuthTokens(value.tokens);
  if ("tokens" in value && !tokens) return undefined;
  const clientInfo = parseAuthClientInfo(value.clientInfo);
  if ("clientInfo" in value && !clientInfo) return undefined;
  const codeVerifier = optionalString(value.codeVerifier);
  if ("codeVerifier" in value && codeVerifier === undefined) return undefined;
  const oauthState = optionalString(value.oauthState);
  if ("oauthState" in value && oauthState === undefined) return undefined;
  const discoveryState = parseAuthDiscoveryState(value.discoveryState);
  if ("discoveryState" in value && discoveryState === undefined) return undefined;
  const serverUrl = optionalString(value.serverUrl);
  if ("serverUrl" in value && serverUrl === undefined) return undefined;

  return {
    ...(tokens !== undefined ? { tokens } : {}),
    ...(clientInfo !== undefined ? { clientInfo } : {}),
    ...(codeVerifier !== undefined ? { codeVerifier } : {}),
    ...(oauthState !== undefined ? { oauthState } : {}),
    ...(discoveryState !== undefined ? { discoveryState } : {}),
    ...(serverUrl !== undefined ? { serverUrl } : {}),
  };
}

function parseAuthTokens(value: unknown): AuthTokens | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value) || typeof value.accessToken !== "string") return undefined;
  const refreshToken = optionalString(value.refreshToken);
  if ("refreshToken" in value && refreshToken === undefined) return undefined;
  const expiresAt = optionalNumber(value.expiresAt);
  if ("expiresAt" in value && expiresAt === undefined) return undefined;
  const scope = optionalString(value.scope);
  if ("scope" in value && scope === undefined) return undefined;
  const issuer = optionalString(value.issuer);
  if ("issuer" in value && issuer === undefined) return undefined;

  return {
    accessToken: value.accessToken,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(issuer !== undefined ? { issuer } : {}),
  };
}

function parseAuthClientInfo(value: unknown): AuthClientInfo | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value) || typeof value.clientId !== "string") return undefined;
  const clientSecret = optionalString(value.clientSecret);
  if ("clientSecret" in value && clientSecret === undefined) return undefined;
  const clientIdIssuedAt = optionalNumber(value.clientIdIssuedAt);
  if ("clientIdIssuedAt" in value && clientIdIssuedAt === undefined) return undefined;
  const clientSecretExpiresAt = optionalNumber(value.clientSecretExpiresAt);
  if ("clientSecretExpiresAt" in value && clientSecretExpiresAt === undefined) return undefined;
  const issuer = optionalString(value.issuer);
  if ("issuer" in value && issuer === undefined) return undefined;
  const redirectUris = optionalStringArray(value.redirectUris);
  if ("redirectUris" in value && redirectUris === undefined) return undefined;
  const configuredClient = optionalBoolean(value.configuredClient);
  if ("configuredClient" in value && configuredClient === undefined) return undefined;

  return {
    clientId: value.clientId,
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    ...(clientIdIssuedAt !== undefined ? { clientIdIssuedAt } : {}),
    ...(clientSecretExpiresAt !== undefined ? { clientSecretExpiresAt } : {}),
    ...(issuer !== undefined ? { issuer } : {}),
    ...(redirectUris !== undefined ? { redirectUris } : {}),
    ...(configuredClient !== undefined ? { configuredClient } : {}),
  };
}

function parseAuthDiscoveryState(value: unknown): AuthDiscoveryState | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value) || typeof value.authorizationServerUrl !== "string") return undefined;
  const authorizationServerMetadata = optionalJsonRecord(value.authorizationServerMetadata);
  if ("authorizationServerMetadata" in value && authorizationServerMetadata === undefined) return undefined;
  const resourceMetadata = optionalJsonRecord(value.resourceMetadata);
  if ("resourceMetadata" in value && resourceMetadata === undefined) return undefined;
  const resourceMetadataUrl = optionalString(value.resourceMetadataUrl);
  if ("resourceMetadataUrl" in value && resourceMetadataUrl === undefined) return undefined;
  return {
    authorizationServerUrl: value.authorizationServerUrl,
    ...(authorizationServerMetadata ? { authorizationServerMetadata } : {}),
    ...(resourceMetadata ? { resourceMetadata } : {}),
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
  };
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : undefined;
}

function optionalJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) return undefined;
  try {
    const cloned: unknown = JSON.parse(JSON.stringify(value));
    return isPlainRecord(cloned) ? cloned : undefined;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}

function warnAuthStore(message: string) {
  console.warn(`[mcp-auth] ${message}`);
}

function safeAuthStoreError(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : `thrown ${typeof error}`;
}

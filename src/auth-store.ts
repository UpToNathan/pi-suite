import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { lock } from "proper-lockfile";
import type { AuthClientInfo, AuthDiscoveryState, AuthEntry, AuthStatus, AuthTokens } from "./types.js";

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
  /** Releases the refresh-token rotation lease; repeated calls are safe. */
  release(): Promise<void>;
}

/** Persists OAuth client metadata, tokens, and in-flight PKCE state for MCP servers. */
export class AuthStore {
  private filepath: string;
  private queue = Promise.resolve();
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
    return this.withLock(() => this.read());
  }

  /** Reads one valid persisted auth entry, if present. */
  async get(mcpName: string): Promise<AuthEntry | undefined> {
    const data = await this.all();
    return data[mcpName];
  }

  /** Reads an auth entry only when it was saved for the same remote server URL. */
  async getForUrl(mcpName: string, serverUrl: string) {
    const entry = await this.get(mcpName);
    if (!entry?.serverUrl || entry.serverUrl !== serverUrl) return undefined;
    return entry;
  }

  /** Replaces the auth entry for one MCP server. */
  set(mcpName: string, entry: AuthEntry, serverUrl?: string) {
    return this.mutate((data) => ({
      ...data,
      [mcpName]: serverUrl ? { ...entry, serverUrl } : entry,
    }));
  }

  /** Removes all stored auth state for one MCP server. */
  remove(mcpName: string) {
    return this.mutate((data) => {
      const next = { ...data };
      delete next[mcpName];
      return next;
    });
  }

  /** Stores OAuth tokens while retaining a rotating refresh token when a response omits its replacement. */
  updateTokens(mcpName: string, tokens: AuthTokens, serverUrl?: string, fence?: AuthWriteFence): Promise<void> {
    return this.updateEntry(
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
  async acquireOAuthRefreshLock(mcpName: string): Promise<AuthRefreshLock> {
    const digest = createHash("sha256").update(mcpName).digest("hex");
    const target = `${this.filepath}.refresh-${digest}`;
    const release = await acquireInterprocessLock(target);
    let released = false;
    return {
      [AUTH_REFRESH_LOCK]: Symbol(mcpName),
      async release(): Promise<void> {
        if (released) return;
        released = true;
        await release();
      },
    };
  }

  /** Stores OAuth client registration metadata for one MCP server. */
  updateClientInfo(mcpName: string, clientInfo: AuthClientInfo, serverUrl?: string, fence?: AuthWriteFence): Promise<void> {
    return this.updateEntry(mcpName, (entry) => ({ ...entry, clientInfo, ...(serverUrl ? { serverUrl } : {}) }), fence);
  }

  /** Stores OAuth discovery state for an in-flight browser round trip. */
  updateDiscoveryState(mcpName: string, discoveryState: AuthDiscoveryState, fence?: AuthWriteFence): Promise<void> {
    return this.updateEntry(mcpName, (entry) => ({ ...entry, discoveryState }), fence);
  }

  /** Removes OAuth discovery state without clearing unrelated credentials. */
  clearDiscoveryState(mcpName: string, fence?: AuthWriteFence): Promise<void> {
    return this.clearField(mcpName, "discoveryState", fence);
  }

  /** Removes stored OAuth tokens without clearing client registration or flow state. */
  clearTokens(mcpName: string, fence?: AuthWriteFence): Promise<void> {
    return this.clearField(mcpName, "tokens", fence);
  }

  /** Removes stored OAuth client registration without clearing tokens or flow state. */
  clearClientInfo(mcpName: string, fence?: AuthWriteFence): Promise<void> {
    return this.clearField(mcpName, "clientInfo", fence);
  }

  /** Stores a PKCE code verifier for an in-flight OAuth flow. */
  updateCodeVerifier(mcpName: string, codeVerifier: string, fence?: AuthWriteFence): Promise<void> {
    return this.updateEntry(mcpName, (entry) => ({ ...entry, codeVerifier }), fence);
  }

  /** Removes the PKCE code verifier after OAuth completion or cancellation. */
  clearCodeVerifier(mcpName: string, fence?: AuthWriteFence): Promise<void> {
    return this.clearField(mcpName, "codeVerifier", fence);
  }

  /** Stores the OAuth state value for an in-flight OAuth flow. */
  updateOAuthState(mcpName: string, oauthState: string, fence?: AuthWriteFence): Promise<void> {
    return this.updateEntry(mcpName, (entry) => ({ ...entry, oauthState }), fence);
  }

  /** Reads the OAuth state value for an in-flight OAuth flow, if present. */
  async getOAuthState(mcpName: string) {
    return (await this.get(mcpName))?.oauthState;
  }

  /** Removes the OAuth state value after OAuth completion or cancellation. */
  clearOAuthState(mcpName: string, fence?: AuthWriteFence): Promise<void> {
    return this.clearField(mcpName, "oauthState", fence);
  }

  /** Classifies the stored token state for one MCP server. */
  async authStatus(mcpName: string): Promise<AuthStatus> {
    const entry = await this.get(mcpName);
    if (!entry?.tokens) return "not_authenticated";
    if (!entry.tokens.expiresAt) return "authenticated";
    return entry.tokens.expiresAt < Date.now() / 1000 ? "expired" : "authenticated";
  }

  private async updateEntry(
    mcpName: string,
    update: (entry: AuthEntry) => AuthEntry,
    fence?: AuthWriteFence,
  ): Promise<void> {
    await this.mutate((data) => {
      if (fence && this.activeWriteFences.get(mcpName) !== fence) return data;
      return { ...data, [mcpName]: update(data[mcpName] ?? {}) };
    });
  }

  private async clearField(mcpName: string, field: keyof AuthEntry, fence?: AuthWriteFence): Promise<void> {
    await this.mutate((data) => {
      if (fence && this.activeWriteFences.get(mcpName) !== fence) return data;
      const entry = data[mcpName];
      if (!entry) return data;
      return { ...data, [mcpName]: clearAuthEntryField(entry, field) };
    });
  }

  private mutate(update: (data: AuthData) => AuthData): Promise<void> {
    return this.withLock(async () => {
      await withInterprocessLock(this.filepath, async () => {
        await this.write(update(await this.read()));
      });
    });
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async read(): Promise<AuthData> {
    try {
      if (!existsSync(this.filepath)) return {};
      const parsed = JSON.parse(await readFile(this.filepath, "utf8"));
      const result = parseAuthData(parsed);
      if (result.rejected > 0) {
        warnAuthStore(`ignored ${result.rejected} malformed persisted auth ${result.rejected === 1 ? "entry" : "entries"}`);
      }
      return result.data;
    } catch (error) {
      warnAuthStore(`ignored unreadable persisted auth store: ${safeAuthStoreError(error)}`);
      return {};
    }
  }

  private async write(data: AuthData): Promise<void> {
    await mkdir(path.dirname(this.filepath), { recursive: true });
    const tmp = `${this.filepath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(tmp, this.filepath);
      await chmod(this.filepath, 0o600);
    } finally {
      await unlink(tmp).catch((error: unknown) => {
        if (!isFileNotFoundError(error)) throw error;
      });
    }
  }
}

async function withInterprocessLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquireInterprocessLock(target);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function acquireInterprocessLock(target: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(target), { recursive: true });
  const release = await lock(target, {
    realpath: false,
    stale: AUTH_LOCK_STALE_MILLISECONDS,
    update: AUTH_LOCK_UPDATE_MILLISECONDS,
    retries: AUTH_LOCK_RETRY_OPTIONS,
    // proper-lockfile caches metadata on fs; bypass Bun's proxied module object.
    fs: nativeFs,
  });
  try {
    await chmod(`${target}.lock`, 0o700);
    return release;
  } catch (error) {
    await release();
    throw error;
  }
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

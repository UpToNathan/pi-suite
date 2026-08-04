import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { AuthClientInfo, AuthDiscoveryState, AuthTokens, OAuthConfig } from "./types.js";
import { AuthStore, type AuthRefreshLock, type AuthWriteFence } from "./auth-store.js";
import { randomHex } from "./random.js";

const MAX_REFRESH_LOCK_HOLD_MILLISECONDS = 120_000;

/** Default local port used by the OAuth browser callback listener. */
export const OAUTH_CALLBACK_PORT = 19876;
/** Default local path used by the OAuth browser callback listener. */
export const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";

/** Callback hooks used by the MCP SDK OAuth provider integration. */
export interface OAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>;
}

/** Implements the MCP SDK OAuth persistence and redirect contract using Pi's auth store. */
export class McpOAuthProvider implements OAuthClientProvider {
  private active = true;
  private readonly writeFence: AuthWriteFence;
  private refreshLock: AuthRefreshLock | undefined;
  private refreshLockAcquisition: Promise<AuthRefreshLock> | undefined;
  private refreshLockTimeout: NodeJS.Timeout | undefined;

  /** Creates an OAuth provider for one remote MCP server and its persisted auth state. */
  constructor(
    private mcpName: string,
    private serverUrl: string,
    private config: OAuthConfig | undefined,
    private callbacks: OAuthCallbacks,
    private auth: AuthStore,
  ) {
    this.writeFence = auth.createOAuthWriteFence(mcpName);
  }

  /** Redirect URI registered with the OAuth authorization server. */
  get redirectUrl(): string {
    if (this.config?.redirectUri) return this.config.redirectUri;
    const port = this.config?.callbackPort ?? OAUTH_CALLBACK_PORT;
    return `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`;
  }

  /** OAuth client metadata advertised during dynamic client registration. */
  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "Pi MCP",
      client_uri: "https://pi.dev",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config?.clientSecret ? "client_secret_post" : "none",
      ...(this.config?.scope ? { scope: this.config.scope } : {}),
    };
  }

  /** Returns saved static or dynamically registered OAuth client information. */
  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    if (this.config?.clientId) {
      const entry = await this.auth.getForUrl(this.mcpName, this.serverUrl);
      if (ctx?.issuer && entry?.clientInfo?.configuredClient && entry.clientInfo.issuer !== ctx.issuer) return undefined;
      if (ctx?.issuer && !entry?.clientInfo?.configuredClient && this.active) {
        await this.auth.updateClientInfo(
          this.mcpName,
          { clientId: this.config.clientId, issuer: ctx.issuer, configuredClient: true },
          this.serverUrl,
          this.writeFence,
        );
      }
      return {
        client_id: this.config.clientId,
        ...(this.config.clientSecret !== undefined ? { client_secret: this.config.clientSecret } : {}),
        ...(ctx?.issuer ? { issuer: ctx.issuer } : {}),
      };
    }

    const entry = await this.auth.getForUrl(this.mcpName, this.serverUrl);
    if (!entry?.clientInfo || (ctx?.issuer && entry.clientInfo.issuer !== ctx.issuer)) return undefined;
    if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
      return undefined;
    }

    return {
      client_id: entry.clientInfo.clientId,
      ...(entry.clientInfo.clientSecret !== undefined ? { client_secret: entry.clientInfo.clientSecret } : {}),
      ...(entry.clientInfo.clientIdIssuedAt !== undefined ? { client_id_issued_at: entry.clientInfo.clientIdIssuedAt } : {}),
      ...(entry.clientInfo.clientSecretExpiresAt !== undefined
        ? { client_secret_expires_at: entry.clientInfo.clientSecretExpiresAt }
        : {}),
      ...(entry.clientInfo.issuer ? { issuer: entry.clientInfo.issuer } : {}),
    };
  }

  /** Persists dynamically registered OAuth client information. */
  async saveClientInformation(info: StoredOAuthClientInformation): Promise<void> {
    if (!this.active) return;
    const configuredClient = info.client_id === this.config?.clientId;
    const clientInfo: AuthClientInfo = {
      clientId: info.client_id,
      ...(!configuredClient && nonEmptyString(info.client_secret) ? { clientSecret: info.client_secret } : {}),
      ...(info.client_id_issued_at !== undefined ? { clientIdIssuedAt: info.client_id_issued_at } : {}),
      ...(info.client_secret_expires_at !== undefined ? { clientSecretExpiresAt: info.client_secret_expires_at } : {}),
      ...(info.issuer ? { issuer: info.issuer } : {}),
      ...(!configuredClient ? { redirectUris: [this.redirectUrl] } : {}),
      ...(configuredClient ? { configuredClient: true } : {}),
    };
    await this.auth.updateClientInfo(
      this.mcpName,
      clientInfo,
      this.serverUrl,
      this.writeFence,
    );
  }

  /** Returns saved OAuth tokens in the shape expected by the MCP SDK. */
  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    let entry = await this.auth.getForUrl(this.mcpName, this.serverUrl);
    if (!entry?.tokens || (ctx?.issuer && entry.tokens.issuer !== ctx.issuer)) return undefined;

    if (ctx?.issuer && entry.tokens.refreshToken) {
      await this.acquireRefreshLock();
      entry = await this.auth.getForUrl(this.mcpName, this.serverUrl);
      if (!entry?.tokens || entry.tokens.issuer !== ctx.issuer) {
        await this.releaseRefreshLock();
        return undefined;
      }
    }

    const tokens: StoredOAuthTokens = {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
    };
    if (entry.tokens.refreshToken !== undefined) tokens.refresh_token = entry.tokens.refreshToken;
    if (entry.tokens.expiresAt !== undefined) tokens.expires_in = Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000));
    if (entry.tokens.scope !== undefined) tokens.scope = entry.tokens.scope;
    if (entry.tokens.issuer !== undefined) tokens.issuer = entry.tokens.issuer;
    return tokens;
  }

  /** Persists OAuth tokens returned by the MCP SDK after grant or refresh flows. */
  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    if (!this.active) return;
    let retainRefreshLock = false;
    try {
      const existing = await this.auth.getForUrl(this.mcpName, this.serverUrl);
      const authTokens: AuthTokens = {
        accessToken: tokens.access_token,
        ...(nonEmptyString(tokens.refresh_token) ? { refreshToken: tokens.refresh_token } : {}),
        ...(tokens.expires_in !== undefined ? { expiresAt: Date.now() / 1000 + tokens.expires_in } : {}),
        ...(nonEmptyString(tokens.scope) ? { scope: tokens.scope } : {}),
        ...(nonEmptyString(tokens.issuer) ? { issuer: tokens.issuer } : {}),
      };
      await this.auth.updateTokens(
        this.mcpName,
        authTokens,
        this.serverUrl,
        this.writeFence,
      );
      if (!this.active) return;
      await this.auth.clearDiscoveryState(this.mcpName, this.writeFence);
      retainRefreshLock = isIssuerBackstamp(existing?.tokens, authTokens, ctx);
    } finally {
      if (!retainRefreshLock) await this.releaseRefreshLock();
    }
  }

  /** Captures or opens the authorization URL supplied by the MCP SDK. */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.releaseRefreshLock();
    await this.callbacks.onRedirect(authorizationUrl);
  }

  /** Persists the PKCE code verifier supplied by the MCP SDK. */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (!this.active) return;
    await this.auth.updateCodeVerifier(this.mcpName, codeVerifier, this.writeFence);
  }

  /** Returns the PKCE code verifier for the current OAuth flow. */
  async codeVerifier(): Promise<string> {
    const entry = await this.auth.get(this.mcpName);
    if (!entry?.codeVerifier) throw new Error(`No code verifier saved for MCP server: ${this.mcpName}`);
    return entry.codeVerifier;
  }

  /** Persists the OAuth state supplied by the MCP SDK. */
  async saveState(state: string): Promise<void> {
    if (!this.active) return;
    await this.auth.updateOAuthState(this.mcpName, state, this.writeFence);
  }

  /** Returns an existing OAuth state or creates one for the current OAuth flow. */
  async state(): Promise<string> {
    const entry = await this.auth.get(this.mcpName);
    if (entry?.oauthState) return entry.oauthState;
    const state = randomHex();
    await this.auth.updateOAuthState(this.mcpName, state, this.writeFence);
    if (!this.active) throw new Error(`OAuth provider is inactive for MCP server: ${this.mcpName}`);
    return state;
  }

  /** Persists OAuth discovery data across the browser redirect round trip. */
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    if (!this.active) return;
    await this.auth.updateDiscoveryState(this.mcpName, toAuthDiscoveryState(state), this.writeFence);
  }

  /** Returns OAuth discovery data for the active browser round trip. */
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const state = (await this.auth.get(this.mcpName))?.discoveryState;
    if (!state) return undefined;
    // SAFETY: AuthStore parsed the persisted JSON object and this provider originally received these fields from the SDK.
    return state as OAuthDiscoveryState;
  }

  /** Prevents late SDK callbacks from mutating credentials after cancellation or shutdown. */
  deactivate(): void {
    this.active = false;
    this.auth.revokeOAuthWriteFence(this.mcpName, this.writeFence);
    void this.releaseRefreshLock().catch((error: unknown) => {
      warnRefreshLockRelease(this.mcpName, error);
    });
  }

  /** Removes only the credential scope invalidated by the SDK. */
  async invalidateCredentials(type: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (!this.active) return;
    try {
      switch (type) {
        case "all":
          await this.auth.remove(this.mcpName);
          return;
        case "client":
          await this.auth.clearClientInfo(this.mcpName, this.writeFence);
          return;
        case "tokens":
          await this.auth.clearTokens(this.mcpName, this.writeFence);
          return;
        case "verifier":
          await this.auth.clearCodeVerifier(this.mcpName, this.writeFence);
          return;
        case "discovery":
          await this.auth.clearDiscoveryState(this.mcpName, this.writeFence);
      }
    } finally {
      await this.releaseRefreshLock();
    }
  }

  private async acquireRefreshLock(): Promise<void> {
    if (this.refreshLock) return;
    const acquisition = this.refreshLockAcquisition ?? this.auth.acquireOAuthRefreshLock(this.mcpName);
    this.refreshLockAcquisition = acquisition;
    try {
      const refreshLock = await acquisition;
      if (!this.active) {
        await refreshLock.release();
        throw new Error(`OAuth provider is inactive for MCP server: ${this.mcpName}`);
      }
      this.refreshLock = refreshLock;
      if (!this.refreshLockTimeout) {
        this.refreshLockTimeout = setTimeout(() => {
          void this.releaseRefreshLock().catch((error: unknown) => {
            warnRefreshLockRelease(this.mcpName, error);
          });
        }, MAX_REFRESH_LOCK_HOLD_MILLISECONDS);
        this.refreshLockTimeout.unref();
      }
    } finally {
      if (this.refreshLockAcquisition === acquisition) this.refreshLockAcquisition = undefined;
    }
  }

  private async releaseRefreshLock(): Promise<void> {
    if (this.refreshLockTimeout) clearTimeout(this.refreshLockTimeout);
    this.refreshLockTimeout = undefined;
    const refreshLock = this.refreshLock;
    this.refreshLock = undefined;
    if (refreshLock) await refreshLock.release();
  }
}

function toAuthDiscoveryState(state: OAuthDiscoveryState): AuthDiscoveryState {
  return {
    authorizationServerUrl: state.authorizationServerUrl,
    ...(state.authorizationServerMetadata
      ? { authorizationServerMetadata: cloneJsonRecord(state.authorizationServerMetadata) }
      : {}),
    ...(state.resourceMetadata ? { resourceMetadata: cloneJsonRecord(state.resourceMetadata) } : {}),
    ...(state.resourceMetadataUrl ? { resourceMetadataUrl: state.resourceMetadataUrl } : {}),
  };
}

function cloneJsonRecord(value: object): Record<string, unknown> {
  const cloned: unknown = JSON.parse(JSON.stringify(value));
  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) {
    throw new Error("OAuth discovery metadata was not a JSON object");
  }
  // SAFETY: The runtime checks above establish a non-null, non-array object after JSON serialization.
  return cloned as Record<string, unknown>;
}

function isIssuerBackstamp(
  existing: AuthTokens | undefined,
  incoming: AuthTokens,
  ctx: OAuthClientInformationContext | undefined,
): boolean {
  return (
    existing?.issuer === undefined &&
    existing?.accessToken === incoming.accessToken &&
    existing.refreshToken === incoming.refreshToken &&
    ctx?.issuer !== undefined &&
    incoming.issuer === ctx.issuer
  );
}

function warnRefreshLockRelease(mcpName: string, error: unknown): void {
  const summary = error instanceof Error ? `${error.name}: ${error.message}` : `thrown ${typeof error}`;
  console.warn(`[mcp-auth] refresh lock release failed for ${mcpName}: ${summary}`);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Parses a configured redirect URI into the callback listener port and path. */
export function parseRedirectUri(redirectUri?: string): { port: number; path: string } {
  if (!redirectUri) return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH };

  try {
    const url = new URL(redirectUri);
    return {
      port: url.port ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80,
      path: url.pathname || OAUTH_CALLBACK_PATH,
    };
  } catch {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH };
  }
}

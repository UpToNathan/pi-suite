import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { Effect, Semaphore } from "effect";
import type { AuthClientInfo, AuthDiscoveryState, AuthTokens, OAuthConfig } from "./types.js";
import { AuthStore, type AuthRefreshLock, type AuthWriteFence } from "./auth-store.js";
import { randomHex } from "./random.js";
import { OAuthError } from "./errors.js";

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
  private readonly refreshMutex = Semaphore.makeUnsafe(1);
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
    if (config?.clientMetadataUrl) Object.assign(this, { clientMetadataUrl: config.clientMetadataUrl });
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
  clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        if (self.config?.clientId) {
          const entry = yield* self.auth.getForUrlEffect(self.mcpName, self.serverUrl);
          if (ctx?.issuer && entry?.clientInfo?.configuredClient && entry.clientInfo.issuer !== ctx.issuer) return undefined;
          if (ctx?.issuer && !entry?.clientInfo?.configuredClient && self.active) {
            yield* self.auth.updateClientInfoEffect(
              self.mcpName,
              { clientId: self.config.clientId, issuer: ctx.issuer, configuredClient: true },
              self.serverUrl,
              self.writeFence,
            );
          }
          return {
            client_id: self.config.clientId,
            ...(self.config.clientSecret !== undefined ? { client_secret: self.config.clientSecret } : {}),
            ...(ctx?.issuer ? { issuer: ctx.issuer } : {}),
          };
        }

        const entry = yield* self.auth.getForUrlEffect(self.mcpName, self.serverUrl);
        if (!entry?.clientInfo || (ctx?.issuer && entry.clientInfo.issuer !== ctx.issuer)) return undefined;
        if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) return undefined;
        return {
          client_id: entry.clientInfo.clientId,
          ...(entry.clientInfo.clientSecret !== undefined ? { client_secret: entry.clientInfo.clientSecret } : {}),
          ...(entry.clientInfo.clientIdIssuedAt !== undefined ? { client_id_issued_at: entry.clientInfo.clientIdIssuedAt } : {}),
          ...(entry.clientInfo.clientSecretExpiresAt !== undefined
            ? { client_secret_expires_at: entry.clientInfo.clientSecretExpiresAt }
            : {}),
          ...(entry.clientInfo.issuer ? { issuer: entry.clientInfo.issuer } : {}),
        };
      }),
    );
  }

  /** Persists dynamically registered OAuth client information. */
  saveClientInformation(info: StoredOAuthClientInformation): Promise<void> {
    if (!this.active) return Promise.resolve();
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
    return Effect.runPromise(
      this.auth.updateClientInfoEffect(this.mcpName, clientInfo, this.serverUrl, this.writeFence),
    );
  }

  /** Returns saved OAuth tokens in the shape expected by the MCP SDK. */
  tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        let entry = yield* self.auth.getForUrlEffect(self.mcpName, self.serverUrl);
        if (!entry?.tokens || (ctx?.issuer && entry.tokens.issuer !== ctx.issuer)) return undefined;

        if (ctx?.issuer && entry.tokens.refreshToken) {
          yield* self.acquireRefreshLockEffect();
          entry = yield* self.auth.getForUrlEffect(self.mcpName, self.serverUrl);
          if (!entry?.tokens || entry.tokens.issuer !== ctx.issuer) {
            yield* self.releaseRefreshLockEffect();
            return undefined;
          }
        }

        const tokens: StoredOAuthTokens = { access_token: entry.tokens.accessToken, token_type: "Bearer" };
        if (entry.tokens.refreshToken !== undefined) tokens.refresh_token = entry.tokens.refreshToken;
        if (entry.tokens.expiresAt !== undefined) tokens.expires_in = Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000));
        if (entry.tokens.scope !== undefined) tokens.scope = entry.tokens.scope;
        if (entry.tokens.issuer !== undefined) tokens.issuer = entry.tokens.issuer;
        return tokens;
      }),
    );
  }

  /** Persists OAuth tokens returned by the MCP SDK after grant or refresh flows. */
  saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    if (!this.active) return Promise.resolve();
    const self = this;
    let retainRefreshLock = false;
    const save = Effect.gen(function* () {
      const existing = yield* self.auth.getForUrlEffect(self.mcpName, self.serverUrl);
      const authTokens: AuthTokens = {
        accessToken: tokens.access_token,
        ...(nonEmptyString(tokens.refresh_token) ? { refreshToken: tokens.refresh_token } : {}),
        ...(tokens.expires_in !== undefined ? { expiresAt: Date.now() / 1000 + tokens.expires_in } : {}),
        ...(nonEmptyString(tokens.scope) ? { scope: tokens.scope } : {}),
        ...(nonEmptyString(tokens.issuer) ? { issuer: tokens.issuer } : {}),
      };
      yield* self.auth.updateTokensEffect(self.mcpName, authTokens, self.serverUrl, self.writeFence);
      if (!self.active) return;
      yield* self.auth.clearDiscoveryStateEffect(self.mcpName, self.writeFence);
      retainRefreshLock = isIssuerBackstamp(existing?.tokens, authTokens, ctx);
    });
    return Effect.runPromise(
      save.pipe(
        Effect.ensuring(
          Effect.suspend(() => (retainRefreshLock ? Effect.void : self.releaseRefreshLockEffect().pipe(Effect.ignore))),
        ),
      ),
    );
  }

  /** Captures or opens the authorization URL supplied by the MCP SDK. */
  redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    return Effect.runPromise(
      this.releaseRefreshLockEffect().pipe(
        Effect.andThen(
          Effect.tryPromise({ try: () => Promise.resolve(this.callbacks.onRedirect(authorizationUrl)), catch: (error) => error }),
        ),
      ),
    );
  }

  /** Persists the PKCE code verifier supplied by the MCP SDK. */
  saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (!this.active) return Promise.resolve();
    return Effect.runPromise(this.auth.updateCodeVerifierEffect(this.mcpName, codeVerifier, this.writeFence));
  }

  /** Returns the PKCE code verifier for the current OAuth flow. */
  codeVerifier(): Promise<string> {
    const mcpName = this.mcpName;
    return Effect.runPromise(
      this.auth.getEffect(mcpName).pipe(
        Effect.flatMap((entry) =>
          entry?.codeVerifier
            ? Effect.succeed(entry.codeVerifier)
            : Effect.fail(new OAuthError({ message: `No code verifier saved for MCP server: ${mcpName}` })),
        ),
      ),
    );
  }

  /** Persists the OAuth state supplied by the MCP SDK. */
  saveState(state: string): Promise<void> {
    if (!this.active) return Promise.resolve();
    return Effect.runPromise(this.auth.updateOAuthStateEffect(this.mcpName, state, this.writeFence));
  }

  /** Returns an existing OAuth state or creates one for the current OAuth flow. */
  state(): Promise<string> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        const entry = yield* self.auth.getEffect(self.mcpName);
        if (entry?.oauthState) return entry.oauthState;
        const state = randomHex();
        yield* self.auth.updateOAuthStateEffect(self.mcpName, state, self.writeFence);
        if (!self.active) return yield* Effect.fail(new OAuthError({ message: `OAuth provider is inactive for MCP server: ${self.mcpName}` }));
        return state;
      }),
    );
  }

  /** Persists OAuth discovery data across the browser redirect round trip. */
  saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    if (!this.active) return Promise.resolve();
    return Effect.runPromise(this.auth.updateDiscoveryStateEffect(this.mcpName, toAuthDiscoveryState(state), this.writeFence));
  }

  /** Returns OAuth discovery data for the active browser round trip. */
  discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return Effect.runPromise(
      this.auth.getEffect(this.mcpName).pipe(
        Effect.map((entry) => {
          const state = entry?.discoveryState;
          if (!state) return undefined;
          // SAFETY: AuthStore parsed this JSON object after it originally came from the SDK.
          return state as OAuthDiscoveryState;
        }),
      ),
    );
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
  invalidateCredentials(type: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (!this.active) return Promise.resolve();
    const invalidate =
      type === "all"
        ? this.auth.removeEffect(this.mcpName)
        : type === "client"
          ? this.auth.clearClientInfoEffect(this.mcpName, this.writeFence)
          : type === "tokens"
            ? this.auth.clearTokensEffect(this.mcpName, this.writeFence)
            : type === "verifier"
              ? this.auth.clearCodeVerifierEffect(this.mcpName, this.writeFence)
              : this.auth.clearDiscoveryStateEffect(this.mcpName, this.writeFence);
    return Effect.runPromise(invalidate.pipe(Effect.ensuring(this.releaseRefreshLockEffect().pipe(Effect.ignore))));
  }

  private acquireRefreshLockEffect() {
    const self = this;
    return this.refreshMutex.withPermits(1)(
      Effect.gen(function* () {
        if (self.refreshLock) return;
        const refreshLock = yield* self.auth.acquireOAuthRefreshLockEffect(self.mcpName);
        if (!self.active) {
          yield* refreshLock.releaseEffect;
          return yield* Effect.fail(new OAuthError({ message: `OAuth provider is inactive for MCP server: ${self.mcpName}` }));
        }
        self.refreshLock = refreshLock;
        if (!self.refreshLockTimeout) {
          self.refreshLockTimeout = setTimeout(() => {
            Effect.runPromise(self.releaseRefreshLockEffect()).catch((error: unknown) => warnRefreshLockRelease(self.mcpName, error));
          }, MAX_REFRESH_LOCK_HOLD_MILLISECONDS);
          self.refreshLockTimeout.unref();
        }
      }),
    );
  }

  private releaseRefreshLock(): Promise<void> {
    return Effect.runPromise(this.releaseRefreshLockEffect());
  }

  private releaseRefreshLockEffect() {
    const self = this;
    return this.refreshMutex.withPermits(1)(
      Effect.gen(function* () {
        if (self.refreshLockTimeout) clearTimeout(self.refreshLockTimeout);
        self.refreshLockTimeout = undefined;
        const refreshLock = self.refreshLock;
        self.refreshLock = undefined;
        if (refreshLock) yield* refreshLock.releaseEffect;
      }),
    );
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

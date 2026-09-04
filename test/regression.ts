import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Effect } from "effect";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStore, type AuthWriteFence } from "../src/auth-store.js";
import { loadMcpConfig } from "../src/config.js";
import { formatMcpServerTarget, redactSecrets } from "../src/display.js";
import { handlePiElicitation } from "../src/elicitation.js";
import { McpManager } from "../src/manager.js";
import { McpOAuthProvider } from "../src/oauth-provider.js";
import type { AuthTokens, McpConfig, McpServerConfig } from "../src/types.js";
import { root } from "./helpers.js";

async function main() {
  await rejectsInvalidServerConfig();
  await mergesProjectConfigs();
  await loadsProxyToolMode();
  await loadsStartupMode();
  await loadsWebMcpRelay();
  await rejectsMissingEnvironmentPlaceholder();
  redactsDisplayTargets();
  await rejectsMalformedAuthStoreData();
  await acceptsEmptyOptionalAuthStrings();
  await preservesConcurrentAuthStoreUpdatesAcrossProcesses();
  await recoversStaleAuthStoreLock();
  await serializesRefreshTokenRotationAcrossProviders();
  await rejectsUnavailableOAuthCallbackPort();
  await releasesOAuthCallbackPortWhenAuthenticationFails();
  await handlesClientCloseCallbackRejections();
  await rejectsDynamicToolKeyCollisions();
  await configuresWithoutConnecting();
  await automaticConnectSkipsConfigDisabledServers();
  await explicitConnectSkipsConfigDisabledServers();
  await explicitConnectClearsRuntimeDisconnect();
  await concurrentConnectsShareOneInFlightAttempt();
  await connectPropagatesCancellation();
  await returnsImmutableManagerSnapshots();
  await propagatesListCancellation();
  await handlesEmptyFormElicitationConsentDecisions();
  await declinesUrlElicitationWithoutPrefetch();
  await fencesAndScopesOAuthPersistence();
  console.log("regression ok");
}

async function loadsWebMcpRelay() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-webmcp-"));
  await writeFile(path.join(dir, "opencode.json"), JSON.stringify({
    mcp: {
      browser: {
        type: "webmcp",
        allowedOrigins: ["https://app.example.com"],
        port: 9444,
      },
      machine: {
        type: "remote",
        url: "https://mcp.example.com",
        oauth: {
          grantType: "private_key_jwt",
          clientId: "client",
          privateKey: "key",
          algorithm: "ES256",
        },
      },
    },
  }));
  const config = await loadMcpConfig({ cwd: dir });
  const browser = config.servers.browser;
  assert.equal(browser?.type, "local");
  assert.deepEqual(browser.type === "local" ? browser.command : [], [
    "npx", "--yes", "@mcp-b/webmcp-local-relay@5.1.0", "--widget-origin", "https://app.example.com", "--port", "9444",
  ]);
  const machine = config.servers.machine;
  assert.equal(machine?.type, "remote");
  assert.equal(machine?.type === "remote" && typeof machine.oauth === "object" ? machine.oauth.grantType : undefined, "private_key_jwt");
}

async function declinesUrlElicitationWithoutPrefetch() {
  const confirmations: string[] = [];
  let fetches = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response();
  };
  try {
    const result = await handlePiElicitation(
      "executor",
      {
        method: "elicitation/create",
        params: {
          mode: "url",
          message: "Review this authorization request",
          elicitationId: "regression-url-request",
          url: "https://example.test/authorize?request=visible",
        },
      },
      {
        hasUI: true,
        ui: {
          confirm: async (_title, message) => {
            confirmations.push(message);
            return false;
          },
          input: async () => undefined,
          notify: () => undefined,
          select: async () => undefined,
        },
      },
    );
    assert.deepEqual(result, { action: "decline" });
    assert.match(confirmations[0] ?? "", /https:\/\/example\.test\/authorize\?request=visible/);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function fencesAndScopesOAuthPersistence() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-provider-"));
  const auth = new AuthStore(path.join(dir, "auth.json"));
  const provider = new McpOAuthProvider(
    "oauth",
    "https://resource.example/mcp",
    { clientId: "configured-client", clientSecret: "configured-secret" },
    { onRedirect: () => undefined },
    auth,
  );

  await provider.saveClientInformation({
    client_id: "configured-client",
    client_secret: "configured-secret",
    issuer: "https://issuer.example",
  });
  assert.equal((await auth.get("oauth"))?.clientInfo?.clientSecret, undefined);
  assert.equal((await auth.get("oauth"))?.clientInfo?.configuredClient, true);

  await provider.saveDiscoveryState({ authorizationServerUrl: "https://issuer.example" });
  await provider.saveTokens({
    access_token: "expired-immediately",
    refresh_token: "rotating-refresh-token",
    token_type: "Bearer",
    expires_in: 0,
    issuer: "https://issuer.example",
  });
  assert.equal(await auth.authStatus("oauth"), "expired");

  await provider.saveTokens({
    access_token: "refreshed-without-rotation",
    token_type: "Bearer",
    expires_in: 3600,
    issuer: "https://issuer.example",
  });
  assert.equal((await auth.get("oauth"))?.tokens?.refreshToken, "rotating-refresh-token");
  assert.equal((await auth.get("oauth"))?.discoveryState, undefined);

  await provider.saveDiscoveryState({ authorizationServerUrl: "https://issuer.example" });
  await provider.invalidateCredentials("discovery");
  assert.equal((await auth.get("oauth"))?.discoveryState, undefined);
  assert.equal((await auth.get("oauth"))?.tokens?.accessToken, "refreshed-without-rotation");

  provider.deactivate();
  await provider.saveTokens({ access_token: "late-write", token_type: "Bearer" });
  assert.equal((await auth.get("oauth"))?.tokens?.accessToken, "refreshed-without-rotation");

  const pausingAuth = new PausingAuthStore(path.join(dir, "pausing-auth.json"));
  const pausingProvider = new McpOAuthProvider(
    "oauth",
    "https://resource.example/mcp",
    undefined,
    { onRedirect: () => undefined },
    pausingAuth,
  );
  const inFlightSave = pausingProvider.saveTokens({ access_token: "in-flight", token_type: "Bearer" });
  await pausingAuth.waitUntilPaused();
  pausingProvider.deactivate();
  pausingAuth.resume();
  await inFlightSave;
  assert.equal((await pausingAuth.get("oauth"))?.tokens, undefined);
}

async function handlesEmptyFormElicitationConsentDecisions() {
  const cases = [
    { decision: "Continue", expected: { action: "accept", content: {} } },
    { decision: "Decline", expected: { action: "decline" } },
    { decision: undefined, expected: { action: "cancel" } },
  ];

  for (const testCase of cases) {
    const prompts: string[] = [];
    const optionSets: string[][] = [];
    const ctx = {
      hasUI: true,
      ui: {
        select: async (title: string, options: string[]) => {
          prompts.push(title);
          optionSets.push(options);
          return testCase.decision;
        },
        confirm: async (_title: string, _message: string) => false,
        input: async (_title: string, _placeholder?: string) => undefined,
        notify: (_message: string) => undefined,
      },
    } satisfies NonNullable<Parameters<typeof handlePiElicitation>[2]>;

    const result = await handlePiElicitation(
      "executor",
      {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: "Approve Executor tool call?",
          requestedSchema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      },
      ctx,
    );

    assert.deepEqual(result, testCase.expected);
    assert.deepEqual(optionSets[0], ["Continue", "Decline"]);
    assert.equal(prompts[0], "MCP Input Request\nServer: executor\n\nApprove Executor tool call?");
  }
}

async function rejectsInvalidServerConfig() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-invalid-config-"));
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        broken: {
          type: "remote",
          urll: "https://example.test/mcp",
        },
      },
    }),
  );

  await assert.rejects(() => loadMcpConfig({ cwd: dir }), /mcp\.broken\.url must be a non-empty string/);
}

async function mergesProjectConfigs() {
  const project = await mkdtemp(path.join(tmpdir(), "pi-mcp-project-config-"));
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await writeFile(
    path.join(project, "opencode.json"),
    JSON.stringify({
      mcpServers: {
        global: { type: "local", command: ["global-server"] },
        shared: { type: "local", command: ["global-server"] },
      },
    }),
  );
  await writeFile(
    path.join(project, ".pi", "mcp.json"),
    JSON.stringify({
      mcp: {
        project: { type: "local", command: ["project-server"] },
        shared: { type: "local", command: ["project-server"] },
      },
    }),
  );

  const config = await loadMcpConfig({ cwd: project });
  assert.ok(config.servers.global);
  assert.ok(config.servers.project);
  assert.ok(config.servers.shared);
  assert.deepEqual(config.servers.global?.type === "local" ? config.servers.global.command : [], ["global-server"]);
  assert.deepEqual(config.servers.shared?.type === "local" ? config.servers.shared.command : [], ["project-server"]);
}

async function loadsProxyToolMode() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-proxy-config-"));
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        toolMode: "proxy",
        local: {
          type: "local",
          command: ["fixture-server"],
        },
      },
    }),
  );

  const config = await loadMcpConfig({ cwd: dir });
  assert.equal(config.toolMode, "proxy");
  assert.equal(config.servers.local?.type, "local");
  assert.deepEqual(config.servers.local.type === "local" ? config.servers.local.command : [], ["fixture-server"]);
}

async function loadsStartupMode() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-startup-config-"));
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        startup: "eager",
        local: {
          type: "local",
          command: ["fixture-server"],
        },
      },
    }),
  );

  const config = await loadMcpConfig({ cwd: dir });
  assert.equal(config.startup, "eager");
  assert.equal(config.servers.local?.type, "local");
}

async function rejectsMissingEnvironmentPlaceholder() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-missing-env-"));
  delete process.env.PI_MCP_REGRESSION_TOKEN;
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        remote: {
          type: "remote",
          url: "https://example.test/mcp",
          headers: {
            Authorization: "Bearer ${PI_MCP_REGRESSION_TOKEN}",
          },
        },
      },
    }),
  );

  await assert.rejects(() => loadMcpConfig({ cwd: dir }), /missing environment variable PI_MCP_REGRESSION_TOKEN/);
}

async function rejectsMalformedAuthStoreData() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-authdata-"));
  const file = path.join(dir, "auth.json");
  await writeFile(
    file,
    JSON.stringify({
      oauth: {
        tokens: {
          accessToken: { not: "a string" },
          expiresAt: "not a number",
        },
        clientInfo: {
          clientId: 123,
        },
        oauthState: false,
        serverUrl: "https://example.test/mcp",
      },
    }),
  );

  const warnings: string[] = [];
  const previousWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  const store = new AuthStore(file);
  try {
    assert.equal(await store.get("oauth"), undefined);
    assert.equal(await store.authStatus("oauth"), "not_authenticated");
    assert.equal(await store.getOAuthState("oauth"), undefined);
    assert.equal(warnings.some((warning) => warning.includes("malformed persisted auth")), true);
  } finally {
    console.warn = previousWarn;
  }
}

async function acceptsEmptyOptionalAuthStrings() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-auth-empty-strings-"));
  const file = path.join(dir, "auth.json");
  await writeFile(
    file,
    JSON.stringify({
      oauth: {
        tokens: {
          accessToken: "access-token",
          refreshToken: "",
          scope: "",
        },
        clientInfo: {
          clientId: "client-id",
          clientSecret: "",
        },
        codeVerifier: "",
        oauthState: "",
        serverUrl: "https://example.test/mcp",
      },
    }),
  );

  const store = new AuthStore(file);
  const entry = await store.get("oauth");
  assert.equal(entry?.tokens?.accessToken, "access-token");
  assert.equal(entry?.tokens?.refreshToken, "");
  assert.equal(entry?.tokens?.scope, "");
  assert.equal(entry?.clientInfo?.clientSecret, "");
  assert.equal(entry?.codeVerifier, "");
  assert.equal(entry?.oauthState, "");
  assert.equal(await store.authStatus("oauth"), "authenticated");
}

async function preservesConcurrentAuthStoreUpdatesAcrossProcesses() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-auth-concurrency-"));
  const file = path.join(dir, "auth.json");
  const initial = Object.fromEntries(
    Array.from({ length: 2_000 }, (_, index) => [
      `seed-${index}`,
      { tokens: { accessToken: `seed-access-${index}-${"x".repeat(512)}` } },
    ]),
  );
  await writeFile(file, JSON.stringify(initial), { mode: 0o600 });

  const workerPath = path.join(root, "test", "auth-store-worker.ts");
  const startFile = path.join(dir, "start");
  const workers = Array.from({ length: 12 }, (_, index) => {
    const readyFile = path.join(dir, `ready-${index}`);
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, file, `worker-${index}`, readyFile, startFile], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { child, readyFile };
  });

  await waitForFiles(workers.map((worker) => worker.readyFile));
  await writeFile(startFile, "start\n", { mode: 0o600 });
  const exits = await Promise.all(workers.map(({ child }) => once(child, "exit")));
  for (const [code, signal] of exits) assert.equal(code, 0, `auth worker failed: signal=${String(signal)}`);

  const auth = new AuthStore(file);
  const data = await auth.all();
  for (let index = 0; index < workers.length; index++) {
    assert.equal(data[`worker-${index}`]?.tokens?.accessToken, `access-worker-${index}`);
  }
  assert.equal((await stat(file)).mode & 0o777, 0o600);
}

async function recoversStaleAuthStoreLock() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-auth-stale-lock-"));
  const file = path.join(dir, "auth.json");
  const lockDirectory = `${file}.lock`;
  await mkdir(lockDirectory, { mode: 0o700 });
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(lockDirectory, staleTime, staleTime);

  const auth = new AuthStore(file);
  await auth.updateTokens("oauth", { accessToken: "recovered-after-stale-lock" });

  assert.equal((await auth.get("oauth"))?.tokens?.accessToken, "recovered-after-stale-lock");
  await assert.rejects(() => access(lockDirectory), { code: "ENOENT" });
}

async function serializesRefreshTokenRotationAcrossProviders() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-refresh-concurrency-"));
  const file = path.join(dir, "auth.json");
  const issuer = "https://issuer.example";
  const serverUrl = "https://resource.example/mcp";
  const firstAuth = new AuthStore(file);
  await firstAuth.updateTokens(
    "oauth",
    { accessToken: "expired-access", refreshToken: "initial-refresh", issuer },
    serverUrl,
  );
  const firstProvider = new McpOAuthProvider(
    "oauth",
    serverUrl,
    undefined,
    { onRedirect: () => undefined },
    firstAuth,
  );
  const secondProvider = new McpOAuthProvider(
    "oauth",
    serverUrl,
    undefined,
    { onRedirect: () => undefined },
    new AuthStore(file),
  );

  const firstTokens = await firstProvider.tokens({ issuer });
  assert.equal(firstTokens?.refresh_token, "initial-refresh");
  let secondSettled = false;
  const secondTokensPromise = secondProvider.tokens({ issuer }).then((tokens) => {
    secondSettled = true;
    return tokens;
  });
  await sleep(75);
  assert.equal(secondSettled, false);

  await firstProvider.saveTokens(
    { access_token: "first-refreshed-access", refresh_token: "rotated-refresh", token_type: "Bearer", issuer },
    { issuer },
  );
  const secondTokens = await secondTokensPromise;
  assert.equal(secondTokens?.refresh_token, "rotated-refresh");
  await secondProvider.saveTokens(
    { access_token: "second-refreshed-access", token_type: "Bearer", issuer },
    { issuer },
  );
  assert.equal((await firstAuth.get("oauth"))?.tokens?.refreshToken, "rotated-refresh");

  firstProvider.deactivate();
  secondProvider.deactivate();
}

async function waitForFiles(files: readonly string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const present = await Promise.all(files.map((file) => access(file).then(() => true, () => false)));
    if (present.every(Boolean)) return;
    await sleep(10);
  }
  throw new Error("Auth store workers did not reach the concurrency barrier");
}

function redactsDisplayTargets() {
  assert.equal(
    formatMcpServerTarget({
      type: "remote",
      url: "https://user:password@example.test/mcp?token=SECRET123#fragment",
    }),
    "https://example.test/mcp?<redacted>#<redacted>",
  );
  assert.equal(
    formatMcpServerTarget({
      type: "local",
      command: ["fixture-server", "--token", "SECRET123"],
    }),
    "fixture-server (2 args)",
  );
  assert.equal(
    redactSecrets("GET https://user:pass@example.test/mcp?token=SECRET123#fragment Authorization: Bearer SECRET123"),
    "GET https://example.test/mcp?<redacted>#<redacted> Authorization: Bearer <redacted>",
  );
}

async function rejectsUnavailableOAuthCallbackPort() {
  const occupied = await listenOnFreePort();
  const config: McpConfig = {
    servers: {
      oauth: {
        type: "remote",
        url: "http://127.0.0.1:1/mcp",
        oauth: {
          callbackPort: occupied.port,
        },
        timeout: 100,
      },
    },
  };
  const manager = new McpManager({
    cwd: root,
    openAuthorizationUrl: () => {
      throw new Error("opener should not be called when callback port is unavailable");
    },
  });

  try {
    await manager.initialize(config, {
      mode: "connect",
      intent: "explicit",
      signal: undefined,
    });
    await assert.rejects(() => manager.authenticate("oauth"), /OAuth callback server could not listen/);
  } finally {
    await manager.close();
    await occupied.close();
  }
}

async function releasesOAuthCallbackPortWhenAuthenticationFails() {
  const callbackProbe = await listenOnFreePort();
  const callbackPort = callbackProbe.port;
  await callbackProbe.close();

  const manager = new McpManager({ cwd: root });
  await manager.initialize(
    {
      servers: {
        oauth: {
          type: "remote",
          url: "http://127.0.0.1:1/mcp",
          oauth: { callbackPort },
          timeout: 100,
        },
      },
    },
    { mode: "configure-only" },
  );

  try {
    await assert.rejects(() => manager.authenticate("oauth"));
    const releasedPort = await listenOnPort(callbackPort);
    await releasedPort.close();
  } finally {
    await manager.close();
  }
}

async function handlesClientCloseCallbackRejections() {
  const unhandled: string[] = [];
  const loggedErrors: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason instanceof Error ? reason.message : String(reason));
  };
  const previousConsoleError = console.error;
  console.error = (message?: unknown) => {
    loggedErrors.push(String(message));
  };
  process.once("unhandledRejection", onUnhandled);
  let onToolsChanged = async () => undefined;
  let onStatusChanged = async () => undefined;
  const manager = new McpManager({
    cwd: root,
    onToolsChanged: () => onToolsChanged(),
    onStatusChanged: () => onStatusChanged(),
  });

  try {
    await manager.initialize(
      {
        servers: {
          local: {
            type: "local",
            command: [process.execPath, "test/local-mcp-server.mjs"],
            timeout: 10_000,
          },
        },
      },
      {
        mode: "connect",
        intent: "explicit",
        signal: undefined,
      },
    );

    const connected = Array.from(manager.connectedClients().values());
    assert.equal(connected.length, 1);
    const managed = connected[0];
    assert.ok(managed, "expected connected MCP fixture");
    onToolsChanged = async () => {
      throw new Error("tools changed failed");
    };
    onStatusChanged = async () => {
      throw new Error("status changed failed");
    };
    managed.client.onclose?.();
    await sleep(50);
    assert.deepEqual(unhandled, []);
    assert.equal(loggedErrors.some((message) => message.includes("close handler failed")), true);
    await managed.client.close();
  } finally {
    console.error = previousConsoleError;
    process.removeListener("unhandledRejection", onUnhandled);
    await manager.close();
  }
}

async function rejectsDynamicToolKeyCollisions() {
  const manager = new McpManager({ cwd: root });
  try {
    await manager.initialize(
      {
        servers: {
          "a.b": {
            type: "local",
            command: [process.execPath, "test/local-mcp-server.mjs"],
            timeout: 10_000,
          },
          a_b: {
            type: "local",
            command: [process.execPath, "test/local-mcp-server.mjs"],
            timeout: 10_000,
          },
        },
      },
      {
        mode: "connect",
        intent: "explicit",
        signal: undefined,
      },
    );
    const statuses = manager.status();
    const finalStatuses = [statuses["a.b"], statuses.a_b];
    assert.equal(finalStatuses.filter((status) => status?.status === "connected").length, 1);
    assert.equal(finalStatuses.filter((status) => status?.status === "failed").length, 1);
    assert.equal(
      finalStatuses.some((status) => status?.status === "failed" && /tool name collision/.test(status.error)),
      true,
    );
    assert.equal(manager.getToolEntries().filter((entry) => entry.key === "a_b_echo").length, 1);
  } finally {
    await manager.close();
  }
}

async function configuresWithoutConnecting() {
  const manager = new McpManager({ cwd: root });
  try {
    await manager.initialize(
      {
        servers: {
          local: {
            type: "local",
            command: [process.execPath, "test/local-mcp-server.mjs"],
            timeout: 10_000,
          },
        },
      },
      { mode: "configure-only" },
    );
    assert.equal(manager.status().local?.status, "disconnected");
    assert.deepEqual(manager.getToolEntries(), []);

    await manager.connectAll({
      intent: "explicit",
      signal: undefined,
    });
    assert.equal(manager.status().local?.status, "connected");
    assert.equal(manager.getToolEntries().some((entry) => entry.key === "local_echo"), true);
  } finally {
    await manager.close();
  }
}

async function automaticConnectSkipsConfigDisabledServers() {
  const manager = new McpManager({ cwd: root });

  try {
    await manager.initialize(
      {
        servers: {
          off: {
            type: "local",
            command: [process.execPath, "test/local-mcp-server.mjs"],
            disabled: true,
            timeout: 10_000,
          },
        },
      },
      { mode: "configure-only" },
    );

    const status = await manager.connect("off", {
      intent: "automatic",
      signal: undefined,
    });

    assert.equal(status.status, "disabled");
    assert.equal(manager.status().off?.status, "disabled");
    assert.deepEqual(manager.getToolEntries(), []);
  } finally {
    await manager.close();
  }
}

async function explicitConnectSkipsConfigDisabledServers() {
  const manager = new McpManager({ cwd: root });

  try {
    await manager.initialize(
      {
        servers: {
          off: {
            type: "local",
            command: [process.execPath, "test/local-mcp-server.mjs"],
            disabled: true,
            timeout: 10_000,
          },
        },
      },
      { mode: "configure-only" },
    );

    const status = await manager.connect("off", {
      intent: "explicit",
      signal: undefined,
    });

    assert.equal(status.status, "disabled");
    assert.equal(manager.status().off?.status, "disabled");
    assert.deepEqual(manager.getToolEntries(), []);
  } finally {
    await manager.close();
  }
}

async function explicitConnectClearsRuntimeDisconnect() {
  const manager = new McpManager({ cwd: root });

  try {
    await manager.initialize(
      {
        servers: {
          local: {
            type: "local",
            command: [process.execPath, "test/local-mcp-server.mjs"],
            timeout: 10_000,
          },
        },
      },
      {
        mode: "connect",
        intent: "explicit",
        signal: undefined,
      },
    );

    await manager.disconnect("local");

    assert.equal(manager.status().local?.status, "disabled");

    const automaticStatus = await manager.connect("local", {
      intent: "automatic",
      signal: undefined,
    });

    assert.equal(automaticStatus.status, "disabled");

    const explicitStatus = await manager.connect("local", {
      intent: "explicit",
      signal: undefined,
    });

    assert.equal(explicitStatus.status, "connected");
    assert.equal(manager.getToolEntries().some((entry) => entry.key === "local_echo"), true);
  } finally {
    await manager.close();
  }
}

async function concurrentConnectsShareOneInFlightAttempt() {
  const startsDir = await mkdtemp(path.join(tmpdir(), "pi-mcp-starts-"));
  const startsFile = path.join(startsDir, "starts.txt");
  const script = await writeDelayedRecordingFixtureScript(startsFile, 300);
  const manager = new McpManager({ cwd: root });

  try {
    await manager.initialize(
      {
        servers: {
          slow: {
            type: "local",
            command: [process.execPath, script],
            timeout: 10_000,
          },
        },
      },
      { mode: "configure-only" },
    );

    const first = manager.connect("slow", {
      intent: "automatic",
      signal: undefined,
    });

    const second = manager.connect("slow", {
      intent: "automatic",
      signal: undefined,
    });

    const [firstStatus, secondStatus] = await Promise.all([first, second]);

    assert.equal(firstStatus.status, "connected");
    assert.equal(secondStatus.status, "connected");
    assert.equal(await readStartCount(startsFile), 2);
  } finally {
    await manager.close();
  }
}

async function connectPropagatesCancellation() {
  const startsDir = await mkdtemp(path.join(tmpdir(), "pi-mcp-starts-"));
  const startsFile = path.join(startsDir, "starts.txt");
  const script = await writeDelayedRecordingFixtureScript(startsFile, 300);
  const controller = new AbortController();
  const manager = new McpManager({ cwd: root });

  try {
    await manager.initialize(
      {
        servers: {
          slow: {
            type: "local",
            command: [process.execPath, script],
            timeout: 10_000,
          },
        },
      },
      { mode: "configure-only" },
    );

    const pending = manager.connect("slow", {
      intent: "automatic",
      signal: controller.signal,
    });

    controller.abort();

    await assert.rejects(() => pending, { name: "AbortError" });
  } finally {
    await manager.close();
  }
}

async function returnsImmutableManagerSnapshots() {
  const servers: Record<string, McpServerConfig> = {
    a: {
      type: "remote",
      url: "http://127.0.0.1:1/mcp",
      disabled: true,
    },
  };
  const manager = new McpManager({ cwd: root });
  await manager.initialize({ servers }, { mode: "configure-only" });

  servers.b = {
    type: "remote",
    url: "http://127.0.0.1:1/mcp",
    disabled: true,
  };
  assert.deepEqual(Object.keys(manager.status()), ["a"]);

  const status = manager.status();
  assert.ok(status.a);
  Reflect.set(status.a, "status", "connected");
  assert.equal(manager.status().a?.status, "disabled");

  const configured = manager.configuredServers();
  Reflect.set(configured, "c", {
    type: "remote",
    url: "http://127.0.0.1:1/mcp",
    disabled: true,
  });
  assert.deepEqual(Object.keys(manager.configuredServers()), ["a"]);
}

async function propagatesListCancellation() {
  const controller = new AbortController();
  controller.abort();
  const manager = new McpManager({ cwd: root });
  await assert.rejects(() => manager.resources(undefined, { signal: controller.signal }), { name: "AbortError" });
}

async function listenOnFreePort() {
  return listenOnPort(0);
}

async function listenOnPort(port: number) {
  const server = createServer((_req, res) => {
    res.end("occupied");
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(typeof address === "object" && address, "expected local server address");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function writeDelayedRecordingFixtureScript(startsFile: string, delayMs: number) {
  const script = path.join(await mkdtemp(path.join(tmpdir(), "pi-mcp-delayed-fixture-")), "fixture.mjs");
  await writeFile(
    script,
    `import { appendFile } from "node:fs/promises";\n` +
      `import { createRequire } from "node:module";\n` +
      `import { setTimeout as sleep } from "node:timers/promises";\n` +
      `import { pathToFileURL } from "node:url";\n` +
      `const require = createRequire(${JSON.stringify(path.join(root, "package.json"))});\n` +
      `const { McpServer } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/server")).href);\n` +
      `const { StdioServerTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/server/stdio")).href);\n` +
      `const { z } = await import(pathToFileURL(require.resolve("zod/v4")).href);\n` +
      `await appendFile(${JSON.stringify(startsFile)}, "1\\n");\n` +
      `await sleep(${JSON.stringify(delayMs)});\n` +
      `const server = new McpServer({ name: "pi-mcp-delayed-fixture", version: "1.0.0" });\n` +
      `server.registerTool("echo", { title: "Echo", inputSchema: z.object({ message: z.string().optional() }) }, async ({ message }) => ({ content: [{ type: "text", text: String(message ?? "") }] }));\n` +
      `await server.connect(new StdioServerTransport());\n`,
  );
  return script;
}

class PausingAuthStore extends AuthStore {
  private readonly reachedPause = makeDeferred();
  private readonly resumePause = makeDeferred();

  override updateTokensEffect(mcpName: string, tokens: AuthTokens, serverUrl?: string, fence?: AuthWriteFence) {
    this.reachedPause.resolve();
    return Effect.promise(() => this.resumePause.promise).pipe(
      Effect.andThen(super.updateTokensEffect(mcpName, tokens, serverUrl, fence)),
    );
  }

  async waitUntilPaused(): Promise<void> {
    await this.reachedPause.promise;
  }

  resume(): void {
    this.resumePause.resolve();
  }
}

function makeDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function readStartCount(startsFile: string) {
  try {
    return (await readFile(startsFile, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();

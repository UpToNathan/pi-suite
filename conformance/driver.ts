import assert from "node:assert/strict";
import { Effect } from "effect";
import { AuthStore } from "../src/auth-store.js";
import { McpManager } from "../src/manager.js";
import type { McpConfig, OAuthConfig } from "../src/types.js";
import { findFreePort } from "../test/helpers.js";

const scenario = process.env.MCP_CONFORMANCE_SCENARIO;
const serverUrl = process.argv[2];
const authFile = process.env.PI_MCP_CONFORMANCE_AUTH_FILE;
if (!scenario || !serverUrl || !authFile) throw new Error("Conformance driver requires scenario, server URL, and isolated auth file");

const context = parseScenarioContext(process.env.MCP_CONFORMANCE_CONTEXT);
const callbackPort = await findFreePort();
const oauth: OAuthConfig = {
  callbackPort,
  ...(scenario === "auth/basic-cimd" ? { clientMetadataUrl: "https://conformance-test.local/client-metadata.json" } : {}),
  ...(scenario === "auth/client-credentials-basic" ? { grantType: "client_credentials" } : {}),
  ...(scenario === "auth/client-credentials-jwt" ? { grantType: "private_key_jwt" } : {}),
  ...(scenario === "auth/cross-app-access-complete-flow" ? { grantType: "cross_app" } : {}),
  ...(scenario === "auth/2025-03-26-oauth-metadata-backcompat" ? { skipIssuerMetadataValidation: true } : {}),
  ...(context.clientId ? { clientId: context.clientId } : {}),
  ...(context.clientSecret ? { clientSecret: context.clientSecret } : {}),
  ...(context.privateKey ? { privateKey: context.privateKey } : {}),
  ...(context.algorithm ? { algorithm: context.algorithm } : {}),
  ...(context.idpUrl ? { idpUrl: context.idpUrl } : {}),
  ...(context.idpTokenEndpoint ? { idpTokenEndpoint: context.idpTokenEndpoint } : {}),
  ...(context.idpToken ? { idpToken: context.idpToken } : {}),
  ...(context.idpClientId ? { idpClientId: context.idpClientId } : {}),
};
const manager = new McpManager({
  cwd: process.cwd(),
  authStore: new AuthStore(authFile),
  onElicitation: () => ({ action: "accept", content: {} }),
  openAuthorizationUrl: async (authorizationUrl) => {
    const response = await fetch(authorizationUrl, { redirect: "manual" });
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error(`Conformance authorization endpoint did not redirect: HTTP ${response.status}`);
    const callback = await fetch(new URL(location, authorizationUrl));
    await callback.body?.cancel();
    if (!callback.ok) throw new Error(`Conformance OAuth callback failed: HTTP ${callback.status}`);
  },
});

const config: McpConfig = {
  timeout: 60_000,
  servers: {
    conformance: { type: "remote", url: serverUrl, timeout: 60_000, oauth },
  },
};

try {
  await manager.initialize(config, { mode: "connect", intent: "explicit", signal: undefined });
  if (manager.status().conformance?.status === "needs_auth") {
    const status = await manager.authenticate("conformance");
    if (status.status !== "connected") throw new Error(`Conformance OAuth failed: ${JSON.stringify(status)}`);
  }
  if (manager.status().conformance?.status !== "connected") {
    throw new Error(`Conformance MCP connection failed: ${JSON.stringify(manager.status().conformance)}`);
  }

  if (scenario === "initialize") {
    assert.equal(manager.connectedClients().get("conformance")?.client.getProtocolEra(), "legacy");
  } else if (scenario === "tools_call") {
    await callConformanceTool("add_numbers", { a: 5, b: 3 });
  } else if (scenario === "elicitation-sep1034-client-defaults") {
    await callConformanceTool("test_client_elicitation_defaults", {});
  } else if (scenario === "sse-retry") {
    await callConformanceTool("test_reconnection", {});
  } else if (scenario.startsWith("auth/")) {
    await callConformanceTool("test-tool", {});
  } else {
    throw new Error(`Unsupported conformance scenario: ${scenario}`);
  }
} finally {
  await manager.close();
}

async function callConformanceTool(name: string, args: Record<string, unknown>): Promise<void> {
  const entry = manager.getToolEntries().find((tool) => tool.name === name);
  if (!entry) throw new Error(`Conformance tool was not listed: ${name}`);
  await Effect.runPromise(manager.callToolEffect(entry, args, { signal: undefined }));
}

type ScenarioContext = {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly privateKey?: string;
  readonly algorithm?: string;
  readonly idpUrl?: string;
  readonly idpTokenEndpoint?: string;
  readonly idpToken?: string;
  readonly idpClientId?: string;
};

function parseScenarioContext(raw: string | undefined): ScenarioContext {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error("Conformance scenario context is not valid JSON", { cause });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const clientId = Reflect.get(value, "client_id");
  const clientSecret = Reflect.get(value, "client_secret");
  const strings = (key: string) => {
    const item = Reflect.get(value, key);
    return typeof item === "string" ? item : undefined;
  };
  const privateKey = strings("private_key_pem");
  const algorithm = strings("signing_algorithm");
  const idpUrl = strings("idp_issuer");
  const idpTokenEndpoint = strings("idp_token_endpoint");
  const idpToken = strings("idp_id_token");
  const idpClientId = strings("idp_client_id");
  return {
    ...(typeof clientId === "string" ? { clientId } : {}),
    ...(typeof clientSecret === "string" ? { clientSecret } : {}),
    ...(privateKey ? { privateKey } : {}),
    ...(algorithm ? { algorithm } : {}),
    ...(idpUrl ? { idpUrl } : {}),
    ...(idpTokenEndpoint ? { idpTokenEndpoint } : {}),
    ...(idpToken ? { idpToken } : {}),
    ...(idpClientId ? { idpClientId } : {}),
  };
}

import assert from "node:assert/strict";
import { AuthStore } from "../src/auth-store.js";
import { callMcpTool } from "../src/catalog.js";
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
  ...(context.clientId ? { clientId: context.clientId } : {}),
  ...(context.clientSecret ? { clientSecret: context.clientSecret } : {}),
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
  await callMcpTool({ client: entry.client, tool: entry.tool, args, timeout: 60_000, signal: undefined });
}

type ScenarioContext = {
  readonly clientId?: string;
  readonly clientSecret?: string;
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
  return {
    ...(typeof clientId === "string" ? { clientId } : {}),
    ...(typeof clientSecret === "string" ? { clientSecret } : {}),
  };
}

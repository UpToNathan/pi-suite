import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStore } from "../src/auth-store.js";
import { McpManager } from "../src/manager.js";
import type { McpConfig } from "../src/types.js";
import { callTool, findFreePort, fixtureStats, root, startMcpFixture } from "./helpers.js";

async function main() {
  const fixture = await startMcpFixture({ oauth: true });
  const tempDir = await mkdtemp(path.join(tmpdir(), "pi-mcp-oauth-"));
  const auth = new AuthStore(path.join(tempDir, "mcp-auth.json"));
  const callbackPort = await findFreePort();
  let openedAuthorizationUrl = false;
  const manager = new McpManager({
    cwd: root,
    authStore: auth,
    openAuthorizationUrl: async (authorizationUrl) => {
      openedAuthorizationUrl = true;
      const callback = await followAuthorizationRedirect(authorizationUrl);
      assert.equal(callback.searchParams.get("state"), await auth.getOAuthState("oauth"));
      assert.ok(callback.searchParams.get("code"), "expected authorization code");
      assert.equal(callback.searchParams.get("iss"), new URL(fixture.url).origin);
      const response = await fetch(callback.href);
      assert.equal(response.ok, true);
      await response.body?.cancel();
    },
  });

  try {
    const config: McpConfig = {
      timeout: 10_000,
      servers: {
        oauth: {
          type: "remote",
          url: fixture.url,
          timeout: 10_000,
          oauth: {
            callbackPort,
          },
        },
      },
    };

    await manager.initialize(config, {
      mode: "connect",
      intent: "explicit",
      signal: undefined,
    });
    assert.equal(manager.status().oauth?.status, "needs_auth");
    assert.equal(await manager.authStatus("oauth"), "not_authenticated");

    const status = await manager.authenticate("oauth");
    assert.equal(openedAuthorizationUrl, true);
    assert.equal(status.status, "connected");
    assert.equal(manager.status().oauth?.status, "connected");
    assert.equal(await manager.authStatus("oauth"), "authenticated");

    const firstAuthEntry = await auth.get("oauth");
    assert.equal(firstAuthEntry?.serverUrl, fixture.url);
    assert.ok(firstAuthEntry?.clientInfo?.clientId);
    assert.equal(firstAuthEntry?.clientInfo?.issuer, new URL(fixture.url).origin);
    assert.deepEqual(firstAuthEntry?.clientInfo?.redirectUris, [`http://127.0.0.1:${callbackPort}/mcp/oauth/callback`]);
    assert.ok(firstAuthEntry?.tokens?.accessToken);
    assert.equal(firstAuthEntry?.tokens?.issuer, new URL(fixture.url).origin);
    assert.equal(firstAuthEntry?.discoveryState, undefined);
    assert.ok(firstAuthEntry?.tokens?.refreshToken);

    const firstEcho = await callTool(manager, "oauth_echo", { message: "before-refresh" });
    assert.equal(firstEcho.content[0]?.type, "text");
    assert.equal(firstEcho.content[0]?.text, "echo:before-refresh");

    const statsAfterAuth = await fixtureStats(fixture.statsUrl);
    assert.equal(statsAfterAuth.registrations, 1);
    assert.equal(statsAfterAuth.authorizationCodeGrants, 1);
    assert.equal(statsAfterAuth.refreshGrants, 0);

    await fetch(fixture.expireUrl);
    const beforeRefresh = await auth.get("oauth");

    const refreshedEcho = await callTool(manager, "oauth_echo", { message: "after-refresh" });
    assert.equal(refreshedEcho.content[0]?.type, "text");
    assert.equal(refreshedEcho.content[0]?.text, "echo:after-refresh");

    const afterRefresh = await auth.get("oauth");
    assert.notEqual(afterRefresh?.tokens?.accessToken, beforeRefresh?.tokens?.accessToken);
    assert.notEqual(afterRefresh?.tokens?.refreshToken, beforeRefresh?.tokens?.refreshToken);

    const statsAfterRefresh = await fixtureStats(fixture.statsUrl);
    assert.equal(statsAfterRefresh.refreshGrants, 1);
    assert.ok(statsAfterRefresh.protectedRequests >= 2);

    await rejectsInvalidCallbackIssuer(fixture, tempDir, "mismatch");
    await rejectsInvalidCallbackIssuer(fixture, tempDir, "missing");

    await manager.removeAuth("oauth");
    assert.equal(await manager.authStatus("oauth"), "not_authenticated");
    assert.equal((await auth.get("oauth"))?.tokens, undefined);

    console.log("oauth smoke ok");
  } finally {
    await manager.close();
    fixture.child.kill("SIGTERM");
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function rejectsInvalidCallbackIssuer(
  fixture: Awaited<ReturnType<typeof startMcpFixture>> & { statsUrl: string },
  tempDir: string,
  mode: "mismatch" | "missing",
) {
  const callbackPort = await findFreePort();
  const auth = new AuthStore(path.join(tempDir, `invalid-issuer-${mode}.json`));
  const before = await fixtureStats(fixture.statsUrl);
  const manager = new McpManager({
    cwd: root,
    authStore: auth,
    openAuthorizationUrl: async (authorizationUrl) => {
      const callback = await followAuthorizationRedirect(authorizationUrl);
      if (mode === "mismatch") callback.searchParams.set("iss", "https://attacker.invalid");
      else callback.searchParams.delete("iss");
      const response = await fetch(callback);
      assert.equal(response.ok, true);
      await response.body?.cancel();
    },
  });
  try {
    await manager.initialize(
      {
        timeout: 10_000,
        servers: {
          oauth: { type: "remote", url: fixture.url, timeout: 10_000, oauth: { callbackPort } },
        },
      },
      { mode: "connect", intent: "explicit", signal: undefined },
    );
    const status = await manager.authenticate("oauth");
    assert.equal(status.status, "failed");
    assert.match(status.status === "failed" ? status.error : "", /issuer|iss/i);
    assert.equal((await fixtureStats(fixture.statsUrl)).authorizationCodeGrants, before.authorizationCodeGrants);
  } finally {
    await manager.close();
  }
}

async function followAuthorizationRedirect(authorizationUrl: string) {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location, "expected redirect location");
  await response.body?.cancel();
  return new URL(location);
}

await main();

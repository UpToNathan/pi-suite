import assert from "node:assert/strict";
import { formatResourceContent } from "../src/catalog.js";
import { McpManager } from "../src/manager.js";
import type { McpConfig } from "../src/types.js";
import { callTool, root, sleep, startMcpFixture } from "./helpers.js";

async function main() {
  const httpFixture = await startMcpFixture();
  const toolsChanged: string[] = [];
  const elicitations: string[] = [];
  const urlRequests: string[] = [];

  const manager = new McpManager({
    cwd: root,
    onToolsChanged: (server) => {
      toolsChanged.push(server);
    },
    onElicitation: (server, request) => {
      elicitations.push(`${server}:${request.params.message}`);
      if (request.params.mode === "url") {
        urlRequests.push(request.params.url);
        return { action: "accept" };
      }
      return {
        action: "accept",
        content: {
          name: `${server}-user`,
          count: 7,
          confirm: true,
          color: "green",
        },
      };
    },
  });

  try {
    const config: McpConfig = {
      timeout: 10_000,
      servers: {
        local: {
          type: "local",
          command: [process.execPath, "test/local-mcp-server.mjs"],
          timeout: 10_000,
        },
        legacy: {
          type: "local",
          command: [process.execPath, "test/local-mcp-server.mjs", "--legacy"],
          timeout: 10_000,
        },
        remote: {
          type: "remote",
          url: httpFixture.url,
          oauth: false,
          timeout: 10_000,
        },
      },
    };

    await manager.initialize(config, {
      mode: "connect",
      intent: "explicit",
      signal: undefined,
    });
    assert.equal(manager.status().local?.status, "connected");
    assert.equal(manager.status().remote?.status, "connected");
    assert.equal(manager.status().legacy?.status, "connected");
    const clients = manager.connectedClients();
    assert.equal(clients.get("local")?.client.getProtocolEra(), "modern");
    assert.equal(clients.get("remote")?.client.getProtocolEra(), "modern");
    assert.equal(clients.get("legacy")?.client.getProtocolEra(), "legacy");

    const toolKeys = new Set(manager.getToolEntries().map((entry) => entry.key));
    for (const key of [
      "local_echo",
      "local_structured",
      "local_image",
      "local_resource_content",
      "local_fail",
      "local_elicit_form",
      "local_elicit_url",
      "local_list_roots",
      "local_notify_tools_changed",
      "remote_echo",
      "remote_elicit_form",
    ]) {
      assert.equal(toolKeys.has(key), true, `missing tool ${key}`);
    }

    const echo = await callTool(manager, "local_echo", { message: "ok" });
    assert.equal(echo.content[0]?.type, "text");
    assert.equal(echo.content[0]?.text, "echo:ok");

    const structured = await callTool(manager, "local_structured", { label: "alpha", count: 2 });
    assert.deepEqual(structured.details.structuredContent, { label: "alpha", count: 2, ok: true });

    const image = await callTool(manager, "local_image", {});
    assert.equal(image.content[0]?.type, "image");
    assert.equal(image.content[0]?.mimeType, "image/png");

    const resourceContent = await callTool(manager, "local_resource_content", {});
    assert.equal(resourceContent.content[0]?.type, "text");
    assert.match(resourceContent.content[0]?.text ?? "", /embedded resource text/);

    await assert.rejects(() => callTool(manager, "local_fail", {}), /fixture failure/);

    const roots = await callTool(manager, "local_list_roots", {});
    assert.match(JSON.stringify(roots.details.structuredContent), /file:\/\//);

    const localElicitation = await callTool(manager, "local_elicit_form", {});
    assert.deepEqual(localElicitation.details.structuredContent, {
      action: "accept",
      content: { name: "local-user", count: 7, confirm: true, color: "green" },
    });

    const remoteElicitation = await callTool(manager, "remote_elicit_form", {});
    assert.deepEqual(remoteElicitation.details.structuredContent, {
      action: "accept",
      content: { name: "remote-user", count: 7, confirm: true, color: "green" },
    });

    const urlElicitation = await callTool(manager, "local_elicit_url", {});
    assert.deepEqual(urlElicitation.details.structuredContent, { action: "accept" });
    assert.deepEqual(urlRequests, ["https://example.test/approve"]);

    const legacyElicitation = await callTool(manager, "legacy_elicit_form", {});
    assert.deepEqual(legacyElicitation.details.structuredContent, {
      action: "accept",
      content: { name: "legacy-user", count: 7, confirm: true, color: "green" },
    });

    const resourceResult = await manager.resources(undefined, { signal: undefined });
    assert.deepEqual(resourceResult.failures, []);
    assert.equal(resourceResult.resources.some((resource) => resource.client === "local" && resource.uri === "test://text"), true);
    assert.equal(resourceResult.resources.some((resource) => resource.client === "remote" && resource.uri === "test://image"), true);

    const textResource = await manager.readResource("local", "test://text", { signal: undefined });
    const formattedText = formatResourceContent("local", "test://text", textResource);
    assert.match(formattedText.text, /fixture resource text/);

    const imageResource = await manager.readResource("local", "test://image", { signal: undefined });
    const formattedImage = formatResourceContent("local", "test://image", imageResource);
    assert.equal(formattedImage.images.length, 1);

    const promptResult = await manager.prompts({ signal: undefined });
    assert.deepEqual(promptResult.failures, []);
    const prompts = promptResult.prompts;
    assert.equal(prompts.some((prompt) => prompt.client === "local" && prompt.name === "review"), true);

    const prompt = await manager.getPrompt("local", "review", { topic: "MCP" }, { signal: undefined });
    assert.match(JSON.stringify(prompt.messages), /Review MCP from the fixture prompt/);

    assert.equal(clients.get("local")?.client.getServerCapabilities()?.tools?.listChanged, true);
    const localChangeCount = toolsChanged.filter((server) => server === "local").length;
    await callTool(manager, "local_notify_tools_changed", {});
    await sleep(500);
    assert.ok(toolsChanged.filter((server) => server === "local").length > localChangeCount);
    assert.equal(elicitations.includes("local:Fixture form request"), true);
    assert.equal(elicitations.includes("remote:Fixture form request"), true);
    assert.equal(elicitations.includes("legacy:Fixture form request"), true);
    assert.equal(elicitations.includes("local:Fixture URL request"), true);

    console.log("smoke ok");
  } finally {
    await manager.close();
    httpFixture.child.kill("SIGTERM");
  }
}

await main();

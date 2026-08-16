import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import opencodeMcpExtension from "../src/index.js";

test("pi-mcp registers one slash command entrypoint", () => {
  const commandNames: string[] = [];
  const extensionApi = {
    on() {},
    registerCommand(name: string) {
      commandNames.push(name);
    },
  };

  // SAFETY: Extension initialization observes only on and registerCommand; command handlers are not invoked in this registration test.
  opencodeMcpExtension(extensionApi as unknown as ExtensionAPI);

  assert.deepEqual(commandNames, ["mcp"]);
});

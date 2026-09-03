import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { AuthStore } from "../src/auth-store.js";
import { McpManagerError } from "../src/errors.js";
import { McpManager } from "../src/manager.js";

test("Effect-native auth persistence round-trips state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-suite-effect-auth-"));
  const auth = new AuthStore(path.join(dir, "auth.json"));
  await Effect.runPromise(auth.updateOAuthStateEffect("server", "state"));
  assert.equal(await Effect.runPromise(auth.getOAuthStateEffect("server")), "state");
});

test("Effect-native manager operations expose typed failures", async () => {
  const manager = new McpManager({ cwd: process.cwd() });
  const result = await Effect.runPromise(
    Effect.result(manager.connectEffect("missing", { intent: "explicit", signal: undefined })),
  );
  assert.equal(result._tag, "Failure");
  if (result._tag === "Failure") assert.ok(result.failure instanceof McpManagerError);
});

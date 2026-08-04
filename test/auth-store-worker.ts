import { access, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { AuthStore } from "../src/auth-store.js";

const [authFile, mcpName, readyFile, startFile] = process.argv.slice(2);
if (!authFile || !mcpName || !readyFile || !startFile) {
  throw new Error("Auth store worker requires auth file, server name, ready file, and start file");
}

await writeFile(readyFile, "ready\n", { mode: 0o600 });
while (true) {
  try {
    await access(startFile);
    break;
  } catch {
    await sleep(5);
  }
}

const auth = new AuthStore(authFile);
await auth.updateTokens(mcpName, { accessToken: `access-${mcpName}` });

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expandLineReferences } from "../src/line-references.js";

test("expands chiron.nvim line references with optional messages", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-line-reference-"));
  await writeFile(join(cwd, "example.ts"), "zero\none\ntwo\nthree\n");

  assert.equal(
    await expandLineReferences("Explain this\n@example.ts#L2-L3", cwd),
    "Explain this\n[Selection example.ts#L2-L3]\n\n--- example.ts:2-3 ---\n2 | one\n3 | two\n--- end selection ---",
  );
  assert.match(await expandLineReferences("@example.ts#L4", cwd), /4 \| three/);
});

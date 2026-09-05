import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REFERENCE = /@([^\s#]+)#L([1-9]\d*)(?:-L([1-9]\d*))?/g;
const MAX_LINES = 2_000;
const MAX_CHARS = 50_000;

/** Expands GitHub-style line references emitted by chiron.nvim into agent-readable source context. */
export async function expandLineReferences(text: string, cwd: string): Promise<string> {
  const matches = [...text.matchAll(REFERENCE)];
  if (matches.length === 0) return text;

  let output = "";
  let cursor = 0;
  for (const match of matches) {
    output += text.slice(cursor, match.index);
    output += await expandReference(match[0], match[1]!, Number(match[2]), Number(match[3] ?? match[2]), cwd);
    cursor = match.index! + match[0].length;
  }
  return output + text.slice(cursor);
}

async function expandReference(reference: string, path: string, first: number, last: number, cwd: string) {
  if (last < first || last - first + 1 > MAX_LINES) return `[Invalid line reference: ${reference}]`;
  try {
    const lines = (await readFile(resolve(cwd, path), "utf8")).split(/\r?\n/);
    if (first > lines.length) return `[Line reference outside file: ${reference}]`;
    const actualLast = Math.min(last, lines.length);
    let content = lines
      .slice(first - 1, actualLast)
      .map((line, index) => `${first + index} | ${line}`)
      .join("\n");
    if (content.length > MAX_CHARS) content = `${content.slice(0, MAX_CHARS)}\n[Selection truncated]`;
    return `[Selection ${reference.slice(1)}]\n\n--- ${path}:${first}-${actualLast} ---\n${content}\n--- end selection ---`;
  } catch (error) {
    return `[Unable to read ${reference}: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

/** Registers expansion of editor-supplied file and line references. */
export default function lineReferencesExtension(pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    const text = await expandLineReferences(event.text, ctx.cwd);
    return text === event.text ? { action: "continue" } : { action: "transform", text };
  });
}

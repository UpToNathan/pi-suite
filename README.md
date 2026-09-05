# pi-suite

Effect-native Pi extensions for OpenCode-style MCP support and editor integration.

## Requirements

Pi Suite requires Node.js 20 or newer. It negotiates the stateless MCP 2026-07-28 protocol when available and automatically falls back to compatible 2025-era servers.

## Install

From GitHub:

```bash
pi install git:github.com/UpToNathan/pi-suite
```

For a temporary run:

```bash
pi -e /Users/dmmulroy/Documents/pi-suite
```

## Neovim line references

The line-reference extension expands GitHub-style references such as `@src/index.ts#L12-L20` into the exact numbered source lines before the agent starts. This is the format emitted by `chiron.nvim` when sending a visual selection, with or without an accompanying message. References are limited to 2,000 lines and 50,000 characters.

## Configuration

The extension reads OpenCode-compatible MCP config from, in order:

1. `PI_MCP_CONFIG` as a JSON string or path to a JSON/JSONC file
2. `.pi/mcp.json` or `.pi/mcp.jsonc`
3. `opencode.json`, `opencode.jsonc`, `.opencode/opencode.json`, `.opencode/opencode.jsonc`
4. `~/.pi/agent/mcp.json` or `~/.pi/agent/mcp.jsonc`

Supported flat OpenCode shape:

```jsonc
{
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp"],
      "enabled": true,
      "timeout": 30000
    },
    "docs": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${DOCS_TOKEN}"
      }
    }
  }
}
```

Also supported:

```jsonc
{
  "mcp": {
    "timeout": 30000,
    "startup": "lazy",
    "servers": {
      "playwright": {
        "type": "local",
        "command": ["npx", "-y", "@playwright/mcp"]
      }
    }
  }
}
```

`startup` controls connection timing:

In direct tool mode, `startup: "lazy"` means MCP tools are not registered at
startup. Open `/mcp`, select a server, and press `c` to connect it, or press `r`
to reload the configuration and connect enabled servers. Use `startup: "eager"`
if you want direct MCP tools to appear automatically without blocking Pi startup.

In proxy tool mode, the `mcp` gateway registers immediately. With
`startup: "lazy"`, it connects enabled servers on demand.

`"eager"` starts connecting enabled servers in the background after Pi startup.
Eager connects run in parallel and do not block Pi's `session_start` handler.

`${ENV_VAR}` placeholders in `environment`, `headers`, `url`, `cwd`, and OAuth string settings are expanded from the process environment.

### OAuth grant types

`oauth.grantType` supports `authorization_code` (default), `client_credentials`, `private_key_jwt`, and `cross_app`. Client Metadata Document URLs, issuer compatibility, private keys, static JWT assertions, and IdP token-exchange settings are available through the corresponding camelCase OAuth fields documented by `OAuthConfig` in `src/types.ts`.

## Command

`/mcp` opens a keyboard-driven server manager inspired by Pi's worktree manager.
It shows connection, OAuth, tool, prompt, resource, target, and configuration
details without adding a separate slash command for every operation.

- `↑`/`↓` selects a server.
- `enter` or `c` connects or reconnects it.
- `d` disconnects it for the current runtime.
- `a` starts OAuth when available.
- `l` confirms and removes stored OAuth credentials.
- `p` browses prompts, collects arguments with completions, and previews content before sending.
- `t` searches tools and inspects descriptions, annotations, and input/output schemas without executing them.
- `s` browses resources and URI templates, previews content, and manages subscriptions. Template variables offer server completions.
- `i` shows negotiated protocol-era information, server capabilities/instructions, and active subscriptions.
- `r` reloads configuration and reconnects enabled servers.
- `esc` closes the manager.

Outside TUI mode, `/mcp` reports the current server statuses without opening the
interactive manager.

In direct tool mode, connected MCP tools are registered as Pi tools using OpenCode's sanitized name convention:

```text
<server>_<tool>
```

To hide individual MCP tools from the system prompt and expose only a progressive-disclosure gateway, set `toolMode` (or `mode`) to `"proxy"`. With the default `startup: "lazy"`, this registers the gateway at startup without connecting MCP servers until the gateway needs them:

```jsonc
{
  "mcp": {
    "toolMode": "proxy",
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp"]
    }
  }
}
```

Proxy usage:

```js
mcp({})                                      // status
mcp({ server: "playwright" })              // list one server's tools
mcp({ search: "screenshot" })              // search tools
mcp({ describe: "playwright_take_screenshot" })
mcp({ tool: "playwright_take_screenshot", args: '{"fullPage":true}' })
mcp({ action: "resources", server: "docs" })
mcp({ action: "complete-resource", server: "docs", uri: "docs://{topic}", argument: "topic", value: "auth" })
mcp({ action: "read-resource", server: "docs", uri: "file://..." })
```

The extension also registers `list_mcp_resources`, `complete_mcp_resource`, and `read_mcp_resource` in direct mode when connected servers support the corresponding MCP capabilities. Resource listings include both concrete resources and URI templates. In proxy mode, these are available through the `mcp` gateway actions instead.

MCP prompt argument completions are shown as choices in `/mcp` when the server advertises completion support. Prompt text, images, embedded resources, and resource links are forwarded to Pi; unsupported audio is reported explicitly.

## Elicitation

The MCP client advertises form and URL elicitation support. Modern servers use 2026 multi-round-trip `input_required` results; legacy server-initiated elicitation uses the same UI.

In the TUI, requests open a keyboard-driven form showing the originating server and message. Fields support titled single/multi-select enums, booleans, text, numeric values, defaults, and optional omission. Free-form string arrays use JSON syntax. JSON Schema constraints are checked before submission; invalid input stays editable.

Use `Tab` / `Shift+Tab` to move between fields and review, `↑↓` or numbers for choices, `Space` to toggle multi-select choices, and `Enter` to save/continue. `Ctrl+O` omits an optional field; server-side defaults may still apply. On the review page, select an answer and press `Enter` to edit it, or select **Submit answers**. **Decline request** refuses the request; `Esc` cancels without sending partial answers. While editing an Other answer, `Esc` returns to choices. `PgUp` / `PgDn` scroll long content.

URL requests show the destination and require explicit approval before opening an HTTP(S) URL. Passwords and API keys belong in that browser flow, not in form answers. RPC uses sequential native dialogs and a final review; print/JSON declines by default. Concurrent question/form requests queue, and cancellation dismisses active input.

Resource and schema inspectors are read-only and do not add their contents to the model context. Previews are capped at 50,000 characters; resource previews are text-only (images remain available through MCP resource tools).

For deterministic non-interactive runs, set `PI_MCP_ELICITATION_RESPONSE` to either an elicitation result object:

```bash
PI_MCP_ELICITATION_RESPONSE='{"action":"accept","content":{"name":"test","count":1,"confirm":true,"color":"green"}}'
```

or directly to a content object, which is treated as an accepted response.

## Structured questions

The separate `ask_user_question` extension follows Claude Code's [AskUserQuestion contract](https://code.claude.com/docs/en/agent-sdk/user-input#question-format): 1–4 questions, 2–4 described options each, short headers (up to 12 characters), and single- or multi-select answers. The UI automatically adds **Other** for custom text and always requires review before submission.

```js
ask_user_question({
  questions: [{
    question: "Which storage should we use?",
    header: "Storage",
    options: [
      { label: "SQLite (Recommended)", description: "Local, no separate service." },
      { label: "Postgres", description: "Shared database for multiple writers." }
    ],
    multiSelect: false
  }]
})
```

Results map the original question text to the selected label, custom text, or an array for multi-select. Cancelled requests return no partial answers. Answers are limited to 4,000 characters each and stored in the tool result for transcript/branch replay; expand the result to review them. Optional plain-text `preview` fields support ASCII comparisons, not executable HTML. RPC uses dialogs; print/JSON reports the UI as unavailable rather than inventing answers.

## Local fixture

This repo includes a local MCP fixture server for development:

```bash
npm run mcp-fixture
```

It can also run as a local Streamable HTTP server with OAuth:

```bash
node test/local-mcp-server.mjs --http --oauth
```

The smoke suite starts modern stdio and stateless Streamable HTTP fixtures plus a legacy-only fallback fixture. It exercises tools, structured content, resources, prompts, roots, subscriptions/listen list changes, and multi-round-trip elicitation:

```bash
npm run smoke
```

OAuth and token refresh are covered separately:

```bash
npm run smoke:oauth
```

Roots, logging notifications, Dynamic Client Registration, and HTTP+SSE fallback are retained only for compatibility; the 2026 protocol deprecates them.

Official client conformance runs through the real manager, auth store, and callback runtime:

```bash
npm run test:conformance
```

Reviewed expected gaps are documented in `conformance/README.md` and the fail-closed baseline.

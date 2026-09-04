# MCP client conformance

The official `@modelcontextprotocol/conformance` referee runs through Pi-MCP's real path:

```text
conformance referee -> driver.sh -> driver.ts -> McpManager -> AuthStore/OAuth callback runtime
```

Run all scenarios with the fail-closed reviewed baseline:

```sh
npm run test:conformance
```

Run one scenario while developing:

```sh
bash conformance/run.sh --scenario initialize
bash conformance/run.sh --scenario auth/metadata-default --verbose
```

Each process uses an isolated auth file and dynamically allocated callback port. Results are written to `conformance/results/` unless `CONFORMANCE_RESULTS_DIR` is set. `CONFORMANCE_TIMEOUT_MS` changes the default 90-second timeout.

`baseline-client.yml` records only reviewed environmental gaps. Unexpected failures and stale entries fail the command. The sole baseline entry is the SSE retry timing scenario: reconnection and `Last-Event-ID` behavior pass, but heavily parallel CI runs can exceed the referee's advisory timing window.

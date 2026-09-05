#!/usr/bin/env node
import http from "node:http";
import { randomUUID } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { completable, createMcpHandler, inputRequired, inputResponse, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const ONE_BY_ONE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function createFixtureServer() {
  const server = new McpServer(
    {
      name: "pi-mcp-fixture",
      version: "1.0.0",
    },
    {
      capabilities: {
        logging: {},
        resources: { subscribe: true },
      },
    },
  );

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echo a message back as text.",
      inputSchema: z.object({
              message: z.string().describe("Message to echo"),
            }),
    },
    async ({ message }, ctx) => {
      await server.sendLoggingMessage({ level: "info", data: `echo:${message}` }, ctx.sessionId);
      return {
        content: [{ type: "text", text: `echo:${message}` }],
      };
    },
  );

  server.registerTool(
    "progress",
    {
      title: "Progress",
      description: "Emit one progress update before completing.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      if (progressToken !== undefined) {
        await ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken, progress: 1, total: 2, message: "halfway" },
        });
      }
      return { content: [{ type: "text", text: "progress complete" }] };
    },
  );

  server.registerTool(
    "structured",
    {
      title: "Structured",
      description: "Return structured content and text content.",
      inputSchema: z.object({
              label: z.string().describe("Label for the structured result"),
              count: z.number().int().default(1).describe("Count to return"),
            }),
      outputSchema: z.object({
              label: z.string(),
              count: z.number(),
              ok: z.boolean(),
            }),
    },
    async ({ label, count }) => {
      const structuredContent = { label, count, ok: true };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "image",
    {
      title: "Image",
      description: "Return a tiny PNG image.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: "image", mimeType: "image/png", data: ONE_BY_ONE_PNG }],
    }),
  );

  server.registerTool(
    "audio",
    {
      title: "Audio",
      description: "Return audio unsupported by Pi's tool-result content model.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: "audio", mimeType: "audio/wav", data: "UklGRg==" }],
    }),
  );

  server.registerTool(
    "resource_link",
    {
      title: "Resource Link",
      description: "Return a link to an MCP resource.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{
        type: "resource_link",
        name: "Linked text resource",
        uri: "test://text",
        description: "Fixture resource link",
        mimeType: "text/plain",
      }],
    }),
  );

  server.registerTool(
    "resource_content",
    {
      title: "Resource Content",
      description: "Return MCP resource content from a tool.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        {
          type: "resource",
          resource: {
            uri: "test://text",
            mimeType: "text/plain",
            text: "embedded resource text",
          },
        },
      ],
    }),
  );

  server.registerTool(
    "fail",
    {
      title: "Fail",
      description: "Return an MCP tool error result.",
      inputSchema: z.object({}),
    },
    async () => ({
      isError: true,
      content: [{ type: "text", text: "fixture failure" }],
    }),
  );

  server.registerTool(
    "elicit_form",
    {
      title: "Elicit Form",
      description: "Request form input from the MCP client.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const response = inputResponse(ctx.mcpReq.inputResponses, "form");
      if (response.kind === "missing") {
        return inputRequired({
          inputRequests: {
            form: inputRequired.elicit({
              message: "Fixture form request",
              requestedSchema: z.object({
                name: z.string().describe("Name to return"),
                count: z.number().int().default(1).describe("Count to return"),
                confirm: z.boolean().default(true).describe("Confirmation flag"),
                color: z.enum(["red", "green", "blue"]).default("green").describe("Color"),
              }),
            }),
          },
        });
      }
      const result =
        response.kind === "elicit"
          ? { action: response.action, ...(response.content ? { content: response.content } : {}) }
          : { action: "decline" };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "elicit_url",
    {
      title: "Elicit URL",
      description: "Request explicit consent before opening a URL.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const response = inputResponse(ctx.mcpReq.inputResponses, "url");
      if (response.kind === "missing") {
        return inputRequired({
          inputRequests: {
            url: inputRequired.elicitUrl({
              message: "Fixture URL request",
              url: "https://example.test/approve",
            }),
          },
        });
      }
      const result = response.kind === "elicit" ? { action: response.action } : { action: "decline" };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "list_roots",
    {
      title: "List Roots",
      description: "Ask the MCP client for roots.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const response = inputResponse(ctx.mcpReq.inputResponses, "roots");
      if (response.kind === "missing") {
        return inputRequired({ inputRequests: { roots: inputRequired.listRoots() } });
      }
      const roots = response.kind === "roots" ? { roots: response.roots } : { roots: [] };
      return {
        content: [{ type: "text", text: JSON.stringify(roots) }],
        structuredContent: roots,
      };
    },
  );

  server.registerTool(
    "notify_tools_changed",
    {
      title: "Notify Tools Changed",
      description: "Send a tools/list_changed notification.",
      inputSchema: z.object({}),
    },
    async () => {
      await server.sendToolListChanged();
      return {
        content: [{ type: "text", text: "sent tools/list_changed" }],
      };
    },
  );

  server.registerTool(
    "notify_resource_updated",
    {
      title: "Notify Resource Updated",
      description: "Send a resources/updated notification.",
      inputSchema: z.object({}),
    },
    async () => {
      await server.server.sendResourceUpdated({ uri: "test://text" });
      return { content: [{ type: "text", text: "sent resources/updated" }] };
    },
  );

  server.registerTool(
    "notify_catalog_changed",
    {
      title: "Notify Catalog Changed",
      description: "Send prompt and resource list_changed notifications.",
      inputSchema: z.object({}),
    },
    async () => {
      await server.sendPromptListChanged();
      await server.sendResourceListChanged();
      return {
        content: [{ type: "text", text: "sent prompt and resource list_changed" }],
      };
    },
  );

  server.registerResource(
    "text-resource",
    "test://text",
    {
      title: "Text Resource",
      description: "Fixture text resource",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [{ uri: "test://text", mimeType: "text/plain", text: "fixture resource text" }],
    }),
  );

  server.registerResource(
    "image-resource",
    "test://image",
    {
      title: "Image Resource",
      description: "Fixture image resource",
      mimeType: "image/png",
    },
    async () => ({
      contents: [{ uri: "test://image", mimeType: "image/png", blob: ONE_BY_ONE_PNG }],
    }),
  );

  server.registerResource(
    "city-resource",
    new ResourceTemplate("test://cities/{city}", {
      list: undefined,
      complete: { city: (value) => ["london", "lisbon"].filter((city) => city.startsWith(value)) },
    }),
    {
      title: "City Resource",
      description: "Fixture city resource template",
      mimeType: "text/plain",
    },
    async (uri, { city }) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: `fixture city ${city}` }],
    }),
  );

  server.registerPrompt(
    "review",
    {
      title: "Review Prompt",
      description: "Create a review prompt for a topic.",
      argsSchema: z.object({
              topic: completable(
                z.string().describe("Topic to review"),
                (value) => ["MCP"].filter((topic) => topic.toLowerCase().startsWith(value.toLowerCase())),
              ),
            }),
    },
    ({ topic }) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `Review ${topic} from the fixture prompt.` },
        },
      ],
    }),
  );

  server.registerPrompt(
    "multimodal",
    {
      title: "Multimodal Prompt",
      description: "Return every current MCP prompt content type.",
      argsSchema: z.object({}),
    },
    () => ({
      messages: [
        { role: "user", content: { type: "image", mimeType: "image/png", data: ONE_BY_ONE_PNG } },
        { role: "assistant", content: { type: "resource_link", name: "Linked text resource", uri: "test://text" } },
        { role: "user", content: { type: "resource", resource: { uri: "test://text", mimeType: "text/plain", text: "embedded prompt resource" } } },
        { role: "assistant", content: { type: "audio", mimeType: "audio/wav", data: "UklGRg==" } },
      ],
    }),
  );

  return server;
}

async function startStdio() {
  console.error("pi-mcp fixture server running on stdio");
  if (process.argv.includes("--legacy")) {
    const server = createFixtureServer();
    await server.connect(new StdioServerTransport());
    return;
  }
  await serveStdio(() => createFixtureServer());
}

async function startHttp() {
  const port = Number(process.env.PI_MCP_FIXTURE_PORT ?? readArg("--port") ?? 38765);
  const oauth = process.argv.includes("--oauth") ? createOAuthFixtureState() : undefined;
  const mcpHandler = createMcpHandler(() => createFixtureServer());
  const nodeMcpHandler = toNodeHandler(mcpHandler);
  const nodeServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (oauth && (await handleOAuthFixtureRoute(req, res, url, oauth))) return;
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("not found");
      return;
    }
    if (oauth && !authorizeMcpRequest(req, res, oauth)) return;
    await nodeMcpHandler(req, res);
  });

  await new Promise((resolve) => nodeServer.listen(port, "127.0.0.1", resolve));
  const address = nodeServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const origin = `http://127.0.0.1:${actualPort}`;
  console.log(JSON.stringify({ url: `${origin}/mcp`, statsUrl: `${origin}/fixture/stats`, expireUrl: `${origin}/fixture/expire` }));

  const shutdown = () => {
    void mcpHandler.close();
    nodeServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function createOAuthFixtureState() {
  return {
    clients: new Map(),
    codes: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
    sequence: 0,
    stats: {
      registrations: 0,
      authorizationCodes: 0,
      authorizationCodeGrants: 0,
      refreshGrants: 0,
      protectedRequests: 0,
    },
  };
}

async function handleOAuthFixtureRoute(req, res, url, oauth) {
  const origin = url.origin;
  if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
    sendJson(res, 200, {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp:tools"],
    });
    return true;
  }

  if (url.pathname === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      scopes_supported: ["mcp:tools"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
    return true;
  }

  if (url.pathname === "/register" && req.method === "POST") {
    const body = JSON.parse(await readBody(req));
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
      sendOAuthError(res, 400, "invalid_client_metadata", "redirect_uris is required");
      return true;
    }
    const client = {
      ...body,
      client_id: `client-${randomUUID()}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
    };
    oauth.clients.set(client.client_id, client);
    oauth.stats.registrations++;
    sendJson(res, 201, client);
    return true;
  }

  if (url.pathname === "/authorize" && req.method === "GET") {
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const codeChallenge = url.searchParams.get("code_challenge");
    const client = clientId ? oauth.clients.get(clientId) : undefined;
    if (!client || !redirectUri || !codeChallenge || !client.redirect_uris.includes(redirectUri)) {
      sendOAuthError(res, 400, "invalid_request", "invalid authorization request");
      return true;
    }
    const code = `code-${randomUUID()}`;
    oauth.codes.set(code, {
      clientId,
      codeChallenge,
      redirectUri,
      resource: url.searchParams.get("resource") ?? undefined,
      scope: url.searchParams.get("scope") ?? "",
    });
    oauth.stats.authorizationCodes++;

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    const state = url.searchParams.get("state");
    if (state) redirect.searchParams.set("state", state);
    redirect.searchParams.set("iss", origin);
    res.writeHead(302, { location: redirect.href }).end();
    return true;
  }

  if (url.pathname === "/token" && req.method === "POST") {
    const params = new URLSearchParams(await readBody(req));
    const grantType = params.get("grant_type");
    const clientId = params.get("client_id");
    if (!clientId || !oauth.clients.has(clientId)) {
      sendOAuthError(res, 401, "invalid_client", "unknown client");
      return true;
    }

    if (grantType === "authorization_code") {
      const code = params.get("code");
      const codeData = code ? oauth.codes.get(code) : undefined;
      if (!code || !codeData || codeData.clientId !== clientId) {
        sendOAuthError(res, 400, "invalid_grant", "invalid authorization code");
        return true;
      }
      oauth.codes.delete(code);
      oauth.stats.authorizationCodeGrants++;
      sendJson(res, 200, issueTokens(oauth, codeData));
      return true;
    }

    if (grantType === "refresh_token") {
      const refreshToken = params.get("refresh_token");
      const refreshData = refreshToken ? oauth.refreshTokens.get(refreshToken) : undefined;
      if (!refreshToken || !refreshData || refreshData.clientId !== clientId) {
        sendOAuthError(res, 400, "invalid_grant", "invalid refresh token");
        return true;
      }
      oauth.refreshTokens.delete(refreshToken);
      oauth.stats.refreshGrants++;
      sendJson(res, 200, issueTokens(oauth, refreshData));
      return true;
    }

    sendOAuthError(res, 400, "unsupported_grant_type", "unsupported grant type");
    return true;
  }

  if (url.pathname === "/fixture/stats") {
    sendJson(res, 200, oauthStats(oauth));
    return true;
  }

  if (url.pathname === "/fixture/expire") {
    for (const token of oauth.accessTokens.values()) token.expiresAt = Date.now() - 1000;
    sendJson(res, 200, oauthStats(oauth));
    return true;
  }

  return false;
}

function issueTokens(oauth, input) {
  const accessToken = `access-${++oauth.sequence}`;
  const refreshToken = `refresh-${++oauth.sequence}`;
  const tokenData = {
    clientId: input.clientId,
    resource: input.resource,
    scope: input.scope ?? "",
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
  oauth.accessTokens.set(accessToken, tokenData);
  oauth.refreshTokens.set(refreshToken, tokenData);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: tokenData.scope,
  };
}

function authorizeMcpRequest(req, res, oauth) {
  const header = req.headers.authorization;
  const match = typeof header === "string" ? /^Bearer (.+)$/.exec(header) : undefined;
  const token = match ? oauth.accessTokens.get(match[1]) : undefined;
  if (!token || token.expiresAt < Date.now()) {
    sendBearerChallenge(req, res, token ? "Token has expired" : "Missing or invalid bearer token");
    return false;
  }
  oauth.stats.protectedRequests++;
  return true;
}

function sendBearerChallenge(req, res, description) {
  const origin = `http://${req.headers.host || "127.0.0.1"}`;
  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource/mcp`;
  res
    .writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": `Bearer error="invalid_token", error_description="${description}", resource_metadata="${resourceMetadata}", scope="mcp:tools"`,
    })
    .end(JSON.stringify({ error: "invalid_token", error_description: description }));
}

function oauthStats(oauth) {
  return {
    ...oauth.stats,
    clients: oauth.clients.size,
    authorizationCodes: oauth.codes.size,
    accessTokens: oauth.accessTokens.size,
    refreshTokens: oauth.refreshTokens.size,
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function sendOAuthError(res, status, error, errorDescription) {
  sendJson(res, status, { error, error_description: errorDescription });
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes("--http")) {
  await startHttp();
} else {
  await startStdio();
}

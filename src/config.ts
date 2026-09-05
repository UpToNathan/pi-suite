import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { McpConfig, McpServerConfig, McpStartupMode, McpToolMode, OAuthConfig } from "./types.js";
import { expandEnv, resolveHome } from "./config-values.js";

interface LoadOptions {
  cwd: string;
}

type ServerEntryMode = "strict" | "discover";

/** Effect-native MCP configuration loader. */
export function loadMcpConfigEffect(options: LoadOptions) {
  return Effect.gen(function* () {
    const envConfig = process.env.PI_MCP_CONFIG;
    if (envConfig) {
      const expanded = resolveHome(expandEnv(envConfig, "PI_MCP_CONFIG"));
      if (existsSync(expanded)) return parseConfig(yield* readConfig(expanded), expanded);
      return parseConfig(envConfig, "PI_MCP_CONFIG");
    }

    const configs: McpConfig[] = [];
    for (const file of candidateConfigFiles(options.cwd)) {
      if (existsSync(file)) configs.push(parseConfig(yield* readConfig(file), file));
    }
    return mergeConfigs(configs.reverse());
  });
}

/** Promise boundary retained for Pi's extension API. */
export function loadMcpConfig(options: LoadOptions): Promise<McpConfig> {
  return Effect.runPromise(loadMcpConfigEffect(options));
}

function readConfig(file: string) {
  return Effect.tryPromise({
    try: () => readFile(file, "utf8"),
    catch: (error) => error,
  });
}

function mergeConfigs(configs: McpConfig[]): McpConfig {
  const servers: Record<string, McpServerConfig> = {};
  let timeout: number | undefined;
  let toolMode: McpToolMode | undefined;
  let startup: McpStartupMode | undefined;

  for (const config of configs) {
    Object.assign(servers, config.servers);
    timeout = config.timeout ?? timeout;
    toolMode = config.toolMode ?? toolMode;
    startup = config.startup ?? startup;
  }

  return {
    servers,
    ...(timeout !== undefined ? { timeout } : {}),
    ...(toolMode !== undefined ? { toolMode } : {}),
    ...(startup !== undefined ? { startup } : {}),
    ...(configs.length > 0 ? { source: configs.map((config) => config.source).filter(Boolean).join(", ") } : {}),
  };
}

function candidateConfigFiles(cwd: string) {
  return [
    path.join(cwd, ".pi", "mcp.json"),
    path.join(cwd, ".pi", "mcp.jsonc"),
    path.join(cwd, "opencode.json"),
    path.join(cwd, "opencode.jsonc"),
    path.join(cwd, ".opencode", "opencode.json"),
    path.join(cwd, ".opencode", "opencode.jsonc"),
    path.join(homedir(), ".pi", "agent", "mcp.json"),
    path.join(homedir(), ".pi", "agent", "mcp.jsonc"),
  ];
}

function parseConfig(text: string, source: string): McpConfig {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`Invalid MCP config JSONC in ${source}`);
  }
  if (!isPlainRecord(parsed)) return { servers: {}, source };

  if ("mcp" in parsed || "mcpServers" in parsed) {
    const key = "mcp" in parsed ? "mcp" : "mcpServers";
    const section = parsed[key];
    if (!isPlainRecord(section)) {
      throw new Error(`Invalid MCP config in ${source}: ${key} must be an object`);
    }
    return parseMcpSection(section, source, key, "strict");
  }

  if (looksLikeFlatMcpSection(parsed)) {
    return parseMcpSection(parsed, source, "mcp", "discover");
  }

  return { servers: {}, source };
}

function parseMcpSection(section: Record<string, unknown>, source: string, pathLabel: string, entryMode: ServerEntryMode): McpConfig {
  const servers: Record<string, McpServerConfig> = {};
  const timeout = parseOptionalPositiveInt(section.timeout, `${pathLabel}.timeout`, source);
  const toolMode = parseToolMode(section, pathLabel, source);
  const startup = parseStartupMode(section, pathLabel, source);

  if ("servers" in section) {
    if (!isPlainRecord(section.servers)) {
      throw new Error(`Invalid MCP config in ${source}: ${pathLabel}.servers must be an object`);
    }
    for (const [name, raw] of Object.entries(section.servers)) {
      servers[name] = parseServer(raw, timeout, `${pathLabel}.servers.${name}`, source);
    }
    return makeConfig(source, servers, timeout, toolMode, startup);
  }

  for (const [name, raw] of Object.entries(section)) {
    if (name === "timeout" || name === "toolMode" || name === "mode" || name === "proxy" || name === "startup") continue;
    if (entryMode === "discover" && !looksLikeServerEntry(raw)) continue;
    servers[name] = parseServer(raw, timeout, `${pathLabel}.${name}`, source);
  }

  return makeConfig(source, servers, timeout, toolMode, startup);
}

function parseToolMode(section: Record<string, unknown>, pathLabel: string, source: string): McpToolMode | undefined {
  const rawMode = section.toolMode ?? section.mode;
  if (rawMode !== undefined) {
    if (rawMode !== "direct" && rawMode !== "proxy") {
      throw new Error(`Invalid MCP config in ${source}: ${pathLabel}.toolMode must be "direct" or "proxy"`);
    }
    return rawMode;
  }
  if (section.proxy !== undefined) {
    if (typeof section.proxy !== "boolean") {
      throw new Error(`Invalid MCP config in ${source}: ${pathLabel}.proxy must be a boolean`);
    }
    return section.proxy ? "proxy" : "direct";
  }
  return undefined;
}

function parseStartupMode(section: Record<string, unknown>, pathLabel: string, source: string): McpStartupMode | undefined {
  if (section.startup === undefined) return undefined;
  if (section.startup !== "eager" && section.startup !== "lazy") {
    throw new Error(`Invalid MCP config in ${source}: ${pathLabel}.startup must be "eager" or "lazy"`);
  }
  return section.startup;
}

function parseServer(value: unknown, defaultTimeout: number | undefined, pathLabel: string, source: string): McpServerConfig {
  if (!isPlainRecord(value)) {
    throw new Error(`Invalid MCP config in ${source}: ${pathLabel} must be an object`);
  }
  if (value.type !== "local" && value.type !== "remote") {
    throw new Error(`Invalid MCP config in ${source}: ${pathLabel}.type must be "local" or "remote"`);
  }

  const timeout = parseOptionalPositiveInt(value.timeout, `${pathLabel}.timeout`, source) ?? defaultTimeout;
  const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined;
  const disabled = typeof value.disabled === "boolean" ? value.disabled : undefined;

  if (value.type === "local") {
    const command = parseCommand(value.command, `${pathLabel}.command`, source);
    const cwd = parseOptionalExpandedString(value.cwd, `${pathLabel}.cwd`, source);
    const environment = parseOptionalStringRecord(value.environment, `${pathLabel}.environment`, source);
    return {
      type: "local",
      command,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(environment !== undefined ? { environment } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(disabled !== undefined ? { disabled } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  const headers = parseOptionalStringRecord(value.headers, `${pathLabel}.headers`, source);
  const oauth = parseOAuth(value.oauth, `${pathLabel}.oauth`, source);
  return {
    type: "remote",
    url: parseRequiredExpandedString(value.url, `${pathLabel}.url`, source),
    ...(headers !== undefined ? { headers } : {}),
    ...(oauth !== undefined ? { oauth } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

function parseCommand(value: unknown, pathLabel: string, source: string) {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`Invalid MCP config in ${source}: ${pathLabel} must be a non-empty string array`);
  }
  return value.map((item) => expandEnv(item, `${source} ${pathLabel}`));
}

function parseOptionalStringRecord(value: unknown, pathLabel: string, source: string) {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new Error(`Invalid MCP config in ${source}: ${pathLabel} must be an object of strings`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`Invalid MCP config in ${source}: ${pathLabel}.${key} must be a string`);
    }
    result[key] = expandEnv(item, `${source} ${pathLabel}.${key}`);
  }
  return result;
}

function parseOAuth(value: unknown, pathLabel: string, source: string): OAuthConfig | false | undefined {
  if (value === undefined) return undefined;
  if (value === false) return false;
  if (!isPlainRecord(value)) {
    throw new Error(`Invalid MCP config in ${source}: ${pathLabel} must be an object or false`);
  }

  const clientId =
    stringAt(value, "clientId", `${pathLabel}.clientId`, source) ?? stringAt(value, "client_id", `${pathLabel}.client_id`, source);
  const clientSecret =
    stringAt(value, "clientSecret", `${pathLabel}.clientSecret`, source) ??
    stringAt(value, "client_secret", `${pathLabel}.client_secret`, source);
  const scope = stringAt(value, "scope", `${pathLabel}.scope`, source);
  const callbackPort =
    parseOptionalPositiveInt(value.callbackPort, `${pathLabel}.callbackPort`, source) ??
    parseOptionalPositiveInt(value.callback_port, `${pathLabel}.callback_port`, source);
  const redirectUri =
    stringAt(value, "redirectUri", `${pathLabel}.redirectUri`, source) ??
    stringAt(value, "redirect_uri", `${pathLabel}.redirect_uri`, source);
  const grantType = stringAt(value, "grantType", `${pathLabel}.grantType`, source) ?? stringAt(value, "grant_type", `${pathLabel}.grant_type`, source);
  if (grantType !== undefined && !["authorization_code", "client_credentials", "private_key_jwt", "cross_app"].includes(grantType)) {
    throw new Error(`Invalid MCP config in ${source}: ${pathLabel}.grantType is not supported`);
  }
  const optional = (camel: string, snake: string) =>
    stringAt(value, camel, `${pathLabel}.${camel}`, source) ?? stringAt(value, snake, `${pathLabel}.${snake}`, source);
  const clientMetadataUrl = optional("clientMetadataUrl", "client_metadata_url");
  const expectedIssuer = optional("expectedIssuer", "expected_issuer");
  const privateKey = optional("privateKey", "private_key");
  const algorithm = optional("algorithm", "signing_algorithm");
  const jwtBearerAssertion = optional("jwtBearerAssertion", "jwt_bearer_assertion");
  const idpUrl = optional("idpUrl", "idp_url");
  const idpTokenEndpoint = optional("idpTokenEndpoint", "idp_token_endpoint");
  const idpToken = optional("idpToken", "idp_token");
  const idpClientId = optional("idpClientId", "idp_client_id");
  const idpClientSecret = optional("idpClientSecret", "idp_client_secret");
  const skipIssuerMetadataValidation = value.skipIssuerMetadataValidation ?? value.skip_issuer_metadata_validation;
  if (skipIssuerMetadataValidation !== undefined && typeof skipIssuerMetadataValidation !== "boolean") {
    throw new Error(`Invalid MCP config in ${source}: ${pathLabel}.skipIssuerMetadataValidation must be a boolean`);
  }
  return {
    ...(grantType !== undefined ? { grantType: grantType as NonNullable<OAuthConfig["grantType"]> } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(callbackPort !== undefined ? { callbackPort } : {}),
    ...(redirectUri !== undefined ? { redirectUri } : {}),
    ...(clientMetadataUrl !== undefined ? { clientMetadataUrl } : {}),
    ...(expectedIssuer !== undefined ? { expectedIssuer } : {}),
    ...(privateKey !== undefined ? { privateKey } : {}),
    ...(algorithm !== undefined ? { algorithm } : {}),
    ...(jwtBearerAssertion !== undefined ? { jwtBearerAssertion } : {}),
    ...(idpUrl !== undefined ? { idpUrl } : {}),
    ...(idpTokenEndpoint !== undefined ? { idpTokenEndpoint } : {}),
    ...(idpToken !== undefined ? { idpToken } : {}),
    ...(idpClientId !== undefined ? { idpClientId } : {}),
    ...(idpClientSecret !== undefined ? { idpClientSecret } : {}),
    ...(skipIssuerMetadataValidation !== undefined ? { skipIssuerMetadataValidation } : {}),
  };
}

function stringAt(record: Record<string, unknown>, key: string, pathLabel: string, source: string) {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid MCP config in ${source}: ${pathLabel} must be a string`);
  }
  return expandEnv(value, `${source} ${pathLabel}`);
}

function parseRequiredExpandedString(value: unknown, pathLabel: string, source: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid MCP config in ${source}: ${pathLabel} must be a non-empty string`);
  }
  return expandEnv(value, `${source} ${pathLabel}`);
}

function parseOptionalExpandedString(value: unknown, pathLabel: string, source: string) {
  if (value === undefined) return undefined;
  return parseRequiredExpandedString(value, pathLabel, source);
}

function parseOptionalPositiveInt(value: unknown, pathLabel: string, source: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid MCP config in ${source}: ${pathLabel} must be a positive integer`);
  }
  return value;
}

function makeConfig(
  source: string,
  servers: Record<string, McpServerConfig>,
  timeout: number | undefined,
  toolMode: McpToolMode | undefined,
  startup: McpStartupMode | undefined,
): McpConfig {
  return {
    servers,
    source,
    ...(timeout !== undefined ? { timeout } : {}),
    ...(toolMode !== undefined ? { toolMode } : {}),
    ...(startup !== undefined ? { startup } : {}),
  };
}

function looksLikeFlatMcpSection(section: Record<string, unknown>) {
  if ("timeout" in section || "servers" in section) return true;
  return Object.values(section).some(looksLikeServerEntry);
}

function looksLikeServerEntry(value: unknown) {
  return isPlainRecord(value) && "type" in value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

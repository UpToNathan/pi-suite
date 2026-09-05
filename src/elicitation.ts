import type { ElicitRequest, ElicitResult, JsonSchemaType } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { ElicitResultSchema } from "@modelcontextprotocol/core";
import open from "open";
import { Effect } from "effect";
import { answerFormEffect, type AnswerContext, type AnswerField, type AnswerValue } from "./answer-flow.js";

type FormParams = Extract<ElicitRequest["params"], { requestedSchema: unknown }>;
type ElicitationContent = NonNullable<ElicitResult["content"]>;

/** Handle server input at the SDK boundary, including cancellation of active/queued UI. */
export async function handlePiElicitation(server: string, request: ElicitRequest, ctx: AnswerContext | undefined, signal?: AbortSignal): Promise<ElicitResult> {
  signal?.throwIfAborted();
  return Effect.runPromise(handlePiElicitationEffect(server, request, ctx), { ...(signal ? { signal } : {}) });
}

/** Effect-native form and URL consent; never opens a browser without explicit approval. */
export function handlePiElicitationEffect(server: string, request: ElicitRequest, ctx: AnswerContext | undefined) {
  return Effect.gen(function* () {
    const params = request.params;
    const env = responseFromEnv();
    if (env) {
      if (env.action === "accept" && "requestedSchema" in params) validateContent(params, env.content ?? {});
      return env;
    }
    if (!ctx?.hasUI) return { action: "decline" } satisfies ElicitResult;
    if (params.mode === "url") {
      const url = new URL(params.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        ctx.ui.notify("MCP URL requests require an HTTP(S) URL without embedded credentials.", "error");
        return { action: "decline" } satisfies ElicitResult;
      }
      const decision = yield* answerFormEffect(ctx, {
        title: `MCP ${server} — browser request`,
        message: `${params.message}\n\nDestination: ${url.origin}\n${params.url}\n\nOnly continue if you trust this destination. Complete sensitive input in the browser, not in Pi.`,
        fields: [], allowDecline: true, submitLabel: "Open in browser",
      });
      if (decision.action !== "accept") return { action: decision.action } satisfies ElicitResult;
      return yield* Effect.tryPromise({ try: () => open(params.url), catch: (error) => error }).pipe(
        Effect.as<ElicitResult>({ action: "accept" }),
        Effect.catch(() => Effect.sync(() => {
          ctx.ui.notify("Could not open MCP URL. Request declined; retry when a browser is available.", "error");
          return { action: "decline" } satisfies ElicitResult;
        })),
      );
    }
    if (!("requestedSchema" in params)) return { action: "decline" } satisfies ElicitResult;
    const fields = elicitationFields(params);
    const result = yield* answerFormEffect(ctx, {
      title: `MCP Input Request — ${server}`,
      message: `${params.message}\n\nAnswers are sent to MCP server ${server} only after submission. Do not enter passwords or API keys.`,
      fields, allowDecline: true,
    });
    if (result.action !== "accept") return { action: result.action } satisfies ElicitResult;
    const content = Object.fromEntries(Object.entries(result.values).map(([name, value]) => [name, decodeValue(params.requestedSchema.properties[name]!, value)]));
    validateContent(params, content);
    return { action: "accept", content } satisfies ElicitResult;
  });
}

/** Adapt MCP primitive schemas to native inputs, titled choices, defaults, and validation. */
export function elicitationFields(params: FormParams): AnswerField[] {
  const validator = new AjvJsonSchemaValidator();
  return Object.entries(params.requestedSchema.properties).map(([id, schema]): AnswerField => {
    const options = schema.type === "boolean"
      ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }]
      : enumOptions(schema.type === "array" && isRecord(schema.items) ? schema.items : schema);
    // SDK wire schemas allow explicit undefined in optional keys; JSON Schema has the same runtime shape.
    const check = validator.getValidator(schema as JsonSchemaType);
    const initial = schema.default === undefined ? undefined : Array.isArray(schema.default)
      ? (options.length ? schema.default : JSON.stringify(schema.default)) : String(schema.default);
    return {
      id, label: typeof schema.title === "string" ? schema.title : id,
      prompt: [schema.description, schema.type === "array" && !options.length ? "Enter a JSON array of strings." : undefined].filter(Boolean).join("\n"),
      required: params.requestedSchema.required?.includes(id) ?? false,
      ...(options.length ? { options, multiple: schema.type === "array" } : {}),
      ...(initial !== undefined ? { initial } : {}),
      validate: (value) => {
        if (value === undefined) return undefined;
        try { return check(decodeValue(schema, value)).errorMessage; }
        catch (error) { return error instanceof Error ? error.message : "Invalid value"; }
      },
    };
  });
}

function decodeValue(schema: Record<string, unknown>, value: AnswerValue): ElicitationContent[string] {
  if (schema.type === "boolean") return value === "true";
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "string" || !value.trim() || !Number.isFinite(Number(value))) throw new Error("Enter a finite number.");
    return Number(value);
  }
  if (schema.type === "array") {
    const parsed: unknown = Array.isArray(value) ? value : JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) throw new Error("Enter a JSON array of strings.");
    return parsed;
  }
  return value;
}

function enumOptions(schema: Record<string, unknown>): { value: string; label: string }[] {
  const titled = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(titled)) return titled.filter(isRecord).flatMap((item) => typeof item.const === "string" ? [{ value: item.const, label: typeof item.title === "string" ? item.title : item.const }] : []);
  if (!Array.isArray(schema.enum)) return [];
  return schema.enum.flatMap((value, index) => typeof value === "string" ? [{ value, label: Array.isArray(schema.enumNames) && typeof schema.enumNames[index] === "string" ? schema.enumNames[index] : value }] : []);
}

function validateContent(params: FormParams, content: ElicitationContent) {
  const result = new AjvJsonSchemaValidator().getValidator(params.requestedSchema as JsonSchemaType)(content);
  if (!result.valid) throw new Error(`Invalid MCP elicitation response: ${result.errorMessage}`);
}

function responseFromEnv(): ElicitResult | undefined {
  const raw = process.env.PI_MCP_ELICITATION_RESPONSE?.trim();
  if (!raw) return undefined;
  if (raw === "accept" || raw === "decline" || raw === "cancel") return { action: raw };
  const parsed: unknown = JSON.parse(raw);
  const result = isRecord(parsed) && typeof parsed.action === "string" ? parsed : { action: "accept", content: parsed };
  const elicitation = ElicitResultSchema.safeParse(result);
  if (elicitation.success) return elicitation.data;
  throw new Error("PI_MCP_ELICITATION_RESPONSE must be an elicitation result object or content object");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

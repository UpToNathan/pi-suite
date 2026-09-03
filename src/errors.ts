import { Schema } from "effect";

/** Typed failure from persisted OAuth state operations. */
export class AuthStoreError extends Schema.TaggedErrorClass<AuthStoreError>()("AuthStoreError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Typed failure from an OAuth workflow. */
export class OAuthError extends Schema.TaggedErrorClass<OAuthError>()("OAuthError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Typed failure from MCP manager orchestration. */
export class McpManagerError extends Schema.TaggedErrorClass<McpManagerError>()("McpManagerError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

// Single source of truth for the qqbot plugin `configSchema` (JSON Schema).
//
// Consumed by index.ts (default-export `plugin.configSchema`) and channel.ts
// (`qqbotPlugin.configSchema.schema`). The static copy embedded in
// `openclaw.plugin.json` MUST stay in sync — enforced by the parity test in
// `config.test.ts`. Field set mirrors the Zod schema in `config.ts`
// (`QQBotAccountSchema` / `QQBotConfigSchema`); when a config field is added or
// changed, edit it here (and only here among the TS sources) plus the Zod
// schema, then update `openclaw.plugin.json` to match.
//
// Design doc §4.1 (P0-A) — eliminates the three hand-copied schemas drifting.

/** Loose JSON-Schema object shape used for the account / config schemas. */
export interface QQBotJsonSchema {
  type: "object";
  additionalProperties: boolean;
  properties: Record<string, unknown>;
  [key: string]: unknown;
}

function asrJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      appId: { type: ["string", "number"] },
      secretId: { type: "string" },
      secretKey: { type: "string" },
    },
  };
}

function inboundMediaJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      dir: { type: "string" },
      keepDays: { type: "number", minimum: 0 },
    },
  };
}

/**
 * Account-level JSON Schema property set. Mirrors `QQBotAccountSchema` in
 * config.ts. Returned by a function so the top-level account block and each
 * `accounts` entry get independent objects (no shared mutable references).
 */
function qqBotAccountJsonProperties(): Record<string, unknown> {
  return {
    name: { type: "string" },
    enabled: { type: "boolean" },
    appId: { type: ["string", "number"] },
    clientSecret: { type: "string" },
    streaming: { type: "boolean" },
    displayAliases: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    asr: asrJsonSchema(),
    markdownSupport: { type: "boolean" },
    c2cMarkdownDeliveryMode: {
      type: "string",
      enum: ["passive", "proactive-table-only", "proactive-all"],
    },
    c2cMarkdownChunkStrategy: {
      type: "string",
      enum: ["markdown-block", "length"],
    },
    c2cMarkdownSafeChunkByteLimit: { type: "integer", minimum: 1 },
    typingHeartbeatMode: {
      type: "string",
      enum: ["none", "idle", "always"],
    },
    typingHeartbeatIntervalMs: { type: "integer", minimum: 1 },
    typingInputSeconds: { type: "integer", minimum: 1 },
    dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
    groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
    requireMention: { type: "boolean" },
    allowFrom: { type: "array", items: { type: "string" } },
    groupAllowFrom: { type: "array", items: { type: "string" } },
    historyLimit: { type: "integer", minimum: 0 },
    textChunkLimit: { type: "integer", minimum: 1 },
    replyFinalOnly: { type: "boolean" },
    longTaskNoticeDelayMs: { type: "integer", minimum: 0 },
    maxFileSizeMB: { type: "number", exclusiveMinimum: 0 },
    mediaTimeoutMs: { type: "integer", minimum: 1 },
    autoSendLocalPathMedia: { type: "boolean" },
    inboundMedia: inboundMediaJsonSchema(),
  };
}

/**
 * JSON Schema for a single account config (used as the `accounts` map value).
 * Mirrors `QQBotAccountSchema`.
 */
export function buildQQBotAccountJsonSchema(): QQBotJsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: qqBotAccountJsonProperties(),
  };
}

/**
 * JSON Schema for the full channel config: account-level fields (the base /
 * default-account block) plus `defaultAccount` and the `accounts` map.
 * Mirrors `QQBotConfigSchema`.
 */
export function buildQQBotConfigJsonSchema(): QQBotJsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ...qqBotAccountJsonProperties(),
      defaultAccount: { type: "string" },
      accounts: {
        type: "object",
        additionalProperties: buildQQBotAccountJsonSchema(),
      },
    },
  };
}

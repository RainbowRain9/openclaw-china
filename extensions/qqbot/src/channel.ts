// Re-export for index.ts
export { DEFAULT_ACCOUNT_ID } from "./config.js";

/**
 * QQ Bot ChannelPlugin 实现
 */

import type { ResolvedQQBotAccount, QQBotConfig } from "./types.js";
import {
  DEFAULT_ACCOUNT_ID,
  listQQBotAccountIds,
  resolveDefaultQQBotAccountId,
  mergeQQBotAccountConfig,
  QQBOT_CHANNEL_ID,
  QQBOT_CONFIG_CHANNEL_ID,
  QQBOT_CONFIG_PREFIXES,
  resolveQQBotCredentials,
  resolveQQBotChannelConfig,
  stripQQBotChannelPrefix,
  type PluginConfig,
  withQQBotChannelConfig,
} from "./config.js";
import { buildQQBotConfigJsonSchema } from "./config-schema.js";
import { qqbotOnboardingAdapter } from "./onboarding.js";
import { qqbotOutbound } from "./outbound.js";
import { monitorQQBotProvider, stopQQBotMonitorForAccount } from "./monitor.js";
import { setQQBotRuntime } from "./runtime.js";


const meta = {
  id: QQBOT_CHANNEL_ID,
  label: "QQ Bot",
  selectionLabel: "QQ Bot",
  docsPath: "/channels/qqbot",
  docsLabel: "qqbot",
  blurb: "QQ 开放平台机器人消息",
  aliases: ["qq"],
  order: 72,
} as const;


function resolveQQBotAccount(params: {
  cfg: PluginConfig;
  accountId?: string;
}): ResolvedQQBotAccount {
  const { cfg, accountId = DEFAULT_ACCOUNT_ID } = params;
  const merged = mergeQQBotAccountConfig(cfg, accountId);
  const baseEnabled = resolveQQBotChannelConfig(cfg)?.enabled !== false;
  const enabled = baseEnabled && merged.enabled !== false;
  const credentials = resolveQQBotCredentials(merged);
  const configured = Boolean(credentials);

  return {
    accountId,
    enabled,
    configured,
    appId: credentials?.appId,
    streaming: merged.streaming === true,
    markdownSupport: merged.markdownSupport ?? true,
    c2cMarkdownDeliveryMode: merged.c2cMarkdownDeliveryMode ?? "proactive-table-only",
    c2cMarkdownChunkStrategy: merged.c2cMarkdownChunkStrategy ?? "markdown-block",
  };
}

export const qqbotPlugin = {
  id: QQBOT_CHANNEL_ID,

  meta: {
    ...meta,
  },

  capabilities: {
    chatTypes: ["direct", "group", "channel"] as const,
    media: true,
    reactions: false,
    threads: false,
    edit: false,
    reply: true,
    polls: false,
    blockStreaming: false,
    activeSend: true,
  },

  messaging: {
    normalizeTarget: (raw: string): string | undefined => {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;
      let value = stripQQBotChannelPrefix(trimmed);
      if (/^(user|group|channel):/i.test(value)) {
        return value;
      }
      if (value.startsWith("@")) {
        const next = value.slice(1).trim();
        return next ? `user:${next}` : undefined;
      }
      if (value.startsWith("#")) {
        const next = value.slice(1).trim();
        return next ? `group:${next}` : undefined;
      }
      const compact = value.replace(/\s+/g, "");
      if (/^[a-zA-Z0-9]{8,}$/.test(compact)) {
        return `user:${compact}`;
      }
      return value;
    },
    targetResolver: {
      looksLikeId: (raw: string, normalized?: string) => {
        const candidate = (normalized ?? raw).trim();
        if (!candidate) return false;
        if (/^(user|group|channel):/i.test(candidate)) return true;
        if (/^[@#]/.test(raw.trim())) return true;
        return /^[a-zA-Z0-9]{8,}$/.test(candidate);
      },
      hint: "Use user:<openid> for C2C, group:<group_openid> for groups, channel:<channel_id> for QQ channels.",
    },
    formatTargetDisplay: (params: {
      target: string;
      display?: string;
      kind?: "user" | "group" | "channel";
    }) => {
      const { target, display, kind } = params;
      if (display?.trim()) {
        const trimmed = display.trim();
        if (trimmed.startsWith("@") || trimmed.startsWith("#")) {
          return trimmed;
        }
        if (kind === "user") return `@${trimmed}`;
        if (kind === "group" || kind === "channel") return `#${trimmed}`;
        return trimmed;
      }
      return target;
    },
  },

  configSchema: {
    schema: buildQQBotConfigJsonSchema(),
  },

  reload: { configPrefixes: [...QQBOT_CONFIG_PREFIXES] },

  onboarding: qqbotOnboardingAdapter,

  config: {
    listAccountIds: (cfg: PluginConfig): string[] => listQQBotAccountIds(cfg),
    resolveAccount: (cfg: PluginConfig, accountId?: string): ResolvedQQBotAccount =>
      resolveQQBotAccount({ cfg, accountId }),
    defaultAccountId: (): string => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: (params: { cfg: PluginConfig; accountId?: string; enabled: boolean }): PluginConfig => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const existing = resolveQQBotChannelConfig(params.cfg) ?? {};

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return withQQBotChannelConfig(
          params.cfg,
          { ...existing, enabled: params.enabled } as QQBotConfig
        );
      }

      const accounts = (existing as QQBotConfig).accounts ?? {};
      const account = accounts[accountId] ?? {};
      return withQQBotChannelConfig(
        params.cfg,
        {
          ...existing,
          accounts: {
            ...accounts,
            [accountId]: { ...account, enabled: params.enabled },
          },
        } as QQBotConfig
      );
    },
    deleteAccount: (params: { cfg: PluginConfig; accountId?: string }): PluginConfig => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return withQQBotChannelConfig(params.cfg);
      }

      const existing = resolveQQBotChannelConfig(params.cfg);
      if (!existing?.accounts?.[accountId]) return params.cfg;

      const { [accountId]: _removed, ...remainingAccounts } = existing.accounts;
      return withQQBotChannelConfig(
        params.cfg,
        {
          ...existing,
          accounts: Object.keys(remainingAccounts).length > 0 ? remainingAccounts : undefined,
        } as QQBotConfig
      );
    },
    isConfigured: (_account: ResolvedQQBotAccount, cfg: PluginConfig, accountId?: string): boolean => {
      const id = accountId ?? _account.accountId;
      const merged = mergeQQBotAccountConfig(cfg, id);
      return Boolean(merged.appId && merged.clientSecret);
    },
    describeAccount: (account: ResolvedQQBotAccount) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: (params: { cfg: PluginConfig; accountId?: string }): string[] => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const merged = mergeQQBotAccountConfig(params.cfg, accountId);
      return merged.allowFrom ?? [];
    },
    formatAllowFrom: (params: { allowFrom: (string | number)[] }): string[] =>
      params.allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },

  security: {
    collectWarnings: (params: { cfg: PluginConfig }): string[] => {
      const qqCfg = resolveQQBotChannelConfig(params.cfg);
      const groupPolicy = qqCfg?.groupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- QQ groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.${QQBOT_CONFIG_CHANNEL_ID}.groupPolicy="allowlist" + channels.${QQBOT_CONFIG_CHANNEL_ID}.groupAllowFrom to restrict senders.`,
      ];
    },
  },

  setup: {
    resolveAccountId: (params: { cfg: PluginConfig; accountId?: string }): string =>
      params.accountId ?? resolveDefaultQQBotAccountId(params.cfg),
    applyAccountConfig: (params: { cfg: PluginConfig; accountId?: string; config?: Record<string, unknown> }): PluginConfig => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const existing = resolveQQBotChannelConfig(params.cfg) ?? {};

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return withQQBotChannelConfig(
          params.cfg,
          { ...existing, ...params.config, enabled: true } as QQBotConfig
        );
      }

      const accounts = (existing as QQBotConfig).accounts ?? {};
      return withQQBotChannelConfig(
        params.cfg,
        {
          ...existing,
          accounts: {
            ...accounts,
            [accountId]: { ...accounts[accountId], ...params.config, enabled: true },
          },
        } as QQBotConfig
      );
    },
  },

  outbound: qqbotOutbound,

  gateway: {
    startAccount: async (ctx: {
      cfg: PluginConfig;
      runtime?: unknown;
      abortSignal?: AbortSignal;
      accountId: string;
      setStatus?: (status: Record<string, unknown>) => void;
      log?: { info: (msg: string) => void; error: (msg: string) => void };
    }): Promise<void> => {
      ctx.setStatus?.({ accountId: ctx.accountId });
      ctx.log?.info(`[${QQBOT_CHANNEL_ID}] starting gateway for account ${ctx.accountId}`);

      if (ctx.runtime) {
        const candidate = ctx.runtime as {
          channel?: {
            routing?: { resolveAgentRoute?: unknown };
            reply?: {
              dispatchReplyFromConfig?: unknown;
              dispatchReplyWithBufferedBlockDispatcher?: unknown;
              dispatchReplyWithDispatcher?: unknown;
            };
          };
        };
        const hasRouting = Boolean(candidate.channel?.routing?.resolveAgentRoute);
        const hasReply =
          Boolean(candidate.channel?.reply?.dispatchReplyWithDispatcher) ||
          Boolean(candidate.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) ||
          Boolean(candidate.channel?.reply?.dispatchReplyFromConfig);
        if (
          hasRouting &&
          hasReply
        ) {
          setQQBotRuntime(ctx.runtime as Record<string, unknown>);
        }
      }

      await monitorQQBotProvider({
        config: ctx.cfg,
        runtime:
          (ctx.runtime as { log?: (msg: string) => void; error?: (msg: string) => void }) ?? {
            log: ctx.log?.info ?? console.log,
            error: ctx.log?.error ?? console.error,
          },
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
        setStatus: ctx.setStatus,
      });
    },
    stopAccount: async (ctx: { accountId: string }): Promise<void> => {
      stopQQBotMonitorForAccount(ctx.accountId);
    },

    getStatus: () => ({ connected: true }),
  },
};

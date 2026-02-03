/**
 * 企业微信自建应用 ChannelPlugin 实现
 *
 * 与普通 wecom 智能机器人不同，自建应用支持主动发送消息
 */

import type { ResolvedWecomAppAccount, WecomAppConfig } from "./types.js";
import {
  DEFAULT_ACCOUNT_ID,
  listWecomAppAccountIds,
  resolveDefaultWecomAppAccountId,
  resolveWecomAppAccount,
  resolveAllowFrom,
  resolveGroupAllowFrom,
  resolveRequireMention,
  WecomAppConfigJsonSchema,
  type PluginConfig,
} from "./config.js";
import { registerWecomAppWebhookTarget } from "./monitor.js";
import { setWecomAppRuntime } from "./runtime.js";
import { sendWecomAppMessage, stripMarkdown, downloadAndSendImage } from "./api.js";

const meta = {
  id: "wecom-app",
  label: "WeCom App",
  selectionLabel: "WeCom Self-built App (企微自建应用)",
  docsPath: "/channels/wecom-app",
  docsLabel: "wecom-app",
  blurb: "企业微信自建应用，支持主动发送消息",
  aliases: ["qywx-app", "企微自建应用", "企业微信自建应用"],
  order: 84,
} as const;

const unregisterHooks = new Map<string, () => void>();

export const wecomAppPlugin = {
  id: "wecom-app",

  meta: {
    ...meta,
  },

  capabilities: {
    chatTypes: ["direct", "group"] as const,
    media: true,
    reactions: false,
    threads: false,
    edit: false,
    reply: true,
    polls: false,
    /** 自建应用支持主动发送 */
    activeSend: true,
  },

  configSchema: WecomAppConfigJsonSchema,

  reload: { configPrefixes: ["channels.wecom-app"] },

  config: {
    listAccountIds: (cfg: PluginConfig): string[] => listWecomAppAccountIds(cfg),

    resolveAccount: (cfg: PluginConfig, accountId?: string): ResolvedWecomAppAccount =>
      resolveWecomAppAccount({ cfg, accountId }),

    defaultAccountId: (cfg: PluginConfig): string => resolveDefaultWecomAppAccountId(cfg),

    setAccountEnabled: (params: { cfg: PluginConfig; accountId?: string; enabled: boolean }): PluginConfig => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccount = Boolean(params.cfg.channels?.["wecom-app"]?.accounts?.[accountId]);
      if (!useAccount) {
        return {
          ...params.cfg,
          channels: {
            ...params.cfg.channels,
            "wecom-app": {
              ...(params.cfg.channels?.["wecom-app"] ?? {}),
              enabled: params.enabled,
            } as WecomAppConfig,
          },
        };
      }

      return {
        ...params.cfg,
        channels: {
          ...params.cfg.channels,
          "wecom-app": {
            ...(params.cfg.channels?.["wecom-app"] ?? {}),
            accounts: {
              ...(params.cfg.channels?.["wecom-app"]?.accounts ?? {}),
              [accountId]: {
                ...(params.cfg.channels?.["wecom-app"]?.accounts?.[accountId] ?? {}),
                enabled: params.enabled,
              },
            },
          } as WecomAppConfig,
        },
      };
    },

    deleteAccount: (params: { cfg: PluginConfig; accountId?: string }): PluginConfig => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const next = { ...params.cfg };
      const current = next.channels?.["wecom-app"];
      if (!current) return next;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        const { accounts: _ignored, defaultAccount: _ignored2, ...rest } = current as WecomAppConfig;
        next.channels = {
          ...next.channels,
          "wecom-app": { ...(rest as WecomAppConfig), enabled: false },
        };
        return next;
      }

      const accounts = { ...(current.accounts ?? {}) };
      delete accounts[accountId];

      next.channels = {
        ...next.channels,
        "wecom-app": {
          ...(current as WecomAppConfig),
          accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
        },
      };

      return next;
    },

    isConfigured: (account: ResolvedWecomAppAccount): boolean => account.configured,

    describeAccount: (account: ResolvedWecomAppAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      canSendActive: account.canSendActive,
      webhookPath: account.config.webhookPath ?? "/wecom-app",
    }),

    resolveAllowFrom: (params: { cfg: PluginConfig; accountId?: string }): string[] => {
      const account = resolveWecomAppAccount({ cfg: params.cfg, accountId: params.accountId });
      return resolveAllowFrom(account.config);
    },

    formatAllowFrom: (params: { allowFrom: (string | number)[] }): string[] =>
      params.allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },

  groups: {
    resolveRequireMention: (params: {
      cfg: PluginConfig;
      accountId?: string;
      account?: ResolvedWecomAppAccount;
    }): boolean => {
      const account = params.account ?? resolveWecomAppAccount({ cfg: params.cfg ?? {}, accountId: params.accountId });
      return resolveRequireMention(account.config);
    },
  },

  /**
   * 目录解析 - 用于将 wecom-app:XXX 格式的 target 解析为可投递目标
   */
  directory: {
    /**
     * 解析目标地址
     * 将 wecom-app:XXX 格式的 target 解析为可用的投递对象
     */
    resolveTarget: (params: {
      cfg: PluginConfig;
      target: string;  // e.g., "wecom-app:CaiHongYu" or "wecom-app:group:chat123"
    }): {
      channel: string;
      accountId?: string;
      to: string;
    } | null => {
      const prefix = "wecom-app:";
      
      // 只处理 wecom-app: 开头的 target
      if (!params.target.startsWith(prefix)) {
        return null;
      }
      
      const withoutPrefix = params.target.slice(prefix.length);
      
      // 解析 accountId（如果包含 @ 符号）
      let accountId: string | undefined;
      let to = withoutPrefix;
      
      if (withoutPrefix.includes("@")) {
        const parts = withoutPrefix.split("@");
        to = parts[0]!;
        accountId = parts[1];
      }
      
      // 标准化目标格式
      if (to.startsWith("group:")) {
        // 群聊: group:xxx
        return {
          channel: "wecom-app",
          accountId,
          to,
        };
      } else if (to.startsWith("user:")) {
        // 显式用户: user:xxx
        return {
          channel: "wecom-app",
          accountId,
          to,
        };
      } else {
        // 默认为用户ID，添加 user: 前缀
        return {
          channel: "wecom-app",
          accountId,
          to: `user:${to}`,
        };
      }
    },
  },

  /**
   * 主动发送消息 (自建应用特有功能)
   */
  outbound: {
    deliveryMode: "direct",

    /**
     * 主动发送文本消息
     */
    sendText: async (params: {
      cfg: PluginConfig;
      accountId?: string;
      to: string;
      text: string;
      options?: { markdown?: boolean };
    }): Promise<{
      channel: string;
      ok: boolean;
      messageId: string;
      error?: Error;
    }> => {
      const account = resolveWecomAppAccount({ cfg: params.cfg, accountId: params.accountId });

      if (!account.canSendActive) {
        return {
          channel: "wecom-app",
          ok: false,
          messageId: "",
          error: new Error("Account not configured for active sending (missing corpId, corpSecret, or agentId)"),
        };
      }

      // 解析 to: 支持格式 "wecom-app:user:xxx" / "wecom-app:group:xxx" / "wecom-app:xxx" / "user:xxx" / "group:xxx" / "xxx"
      let to = params.to;

      // 1. 先剥离 channel 前缀 "wecom-app:"
      const channelPrefix = "wecom-app:";
      if (to.startsWith(channelPrefix)) {
        to = to.slice(channelPrefix.length);
      }

      // 2. 解析剩余部分: "group:xxx" / "user:xxx" / "xxx"
      let target: { userId?: string; chatid?: string } = {};
      if (to.startsWith("group:")) {
        target = { chatid: to.slice(6) };
      } else if (to.startsWith("user:")) {
        target = { userId: to.slice(5) };
      } else {
        target = { userId: to };
      }

      try {
        const result = await sendWecomAppMessage(account, target, params.text);
        return {
          channel: "wecom-app",
          ok: result.ok,
          messageId: result.msgid ?? "",
          error: result.ok ? undefined : new Error(result.errmsg ?? "send failed"),
        };
      } catch (err) {
        return {
          channel: "wecom-app",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },

    /**
     * 发送媒体消息（图片）
     * OpenClaw outbound 适配器要求的接口
     */
    sendMedia: async (params: {
      cfg: PluginConfig;
      accountId?: string;
      to: string;
      mediaUrl: string;
      text?: string;
      mimeType?: string;
    }): Promise<{
      channel: string;
      ok: boolean;
      messageId: string;
      error?: Error;
    }> => {
      console.log(`[wecom-app] sendMedia called: to=${params.to}, mediaUrl=${params.mediaUrl}`);

      const account = resolveWecomAppAccount({
        cfg: params.cfg,
        accountId: params.accountId,
      });

      console.log(`[wecom-app] Account resolved: canSendActive=${account.canSendActive}`);

      if (!account.canSendActive) {
        const error = new Error("Account not configured for active sending (missing corpId, corpSecret, or agentId)");
        console.error(`[wecom-app] sendMedia error:`, error.message);
        return {
          channel: "wecom-app",
          ok: false,
          messageId: "",
          error,
        };
      }

      // 解析 to: 支持格式 "wecom-app:user:xxx" / "wecom-app:group:xxx" / "wecom-app:xxx" / "user:xxx" / "group:xxx" / "xxx"
      let to = params.to;

      // 1. 先剥离 channel 前缀 "wecom-app:"
      const channelPrefix = "wecom-app:";
      if (to.startsWith(channelPrefix)) {
        to = to.slice(channelPrefix.length);
      }

      // 2. 解析剩余部分: "group:xxx" / "user:xxx" / "xxx"
      let target: { userId?: string; chatid?: string } = {};
      if (to.startsWith("group:")) {
        target = { chatid: to.slice(6) };
      } else if (to.startsWith("user:")) {
        target = { userId: to.slice(5) };
      } else {
        target = { userId: to };
      }

      console.log(`[wecom-app] Target parsed:`, target);

      try {
        // 使用 api.ts 中的 downloadAndSendImage 函数
        // 流程: 下载图片 → 上传素材 → 发送图片
        const result = await downloadAndSendImage(account, target, params.mediaUrl);

        console.log(`[wecom-app] downloadAndSendImage returned: ok=${result.ok}, msgid=${result.msgid}, errcode=${result.errcode}, errmsg=${result.errmsg}`);

        return {
          channel: "wecom-app",
          ok: result.ok,
          messageId: result.msgid ?? "",
          error: result.ok ? undefined : new Error(result.errmsg ?? "send failed"),
        };
      } catch (err) {
        console.error(`[wecom-app] sendMedia catch error:`, err);
        return {
          channel: "wecom-app",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
  },

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

      if (ctx.runtime) {
        const candidate = ctx.runtime as {
          channel?: {
            routing?: { resolveAgentRoute?: unknown };
            reply?: { dispatchReplyFromConfig?: unknown };
          };
        };
        if (candidate.channel?.routing?.resolveAgentRoute && candidate.channel?.reply?.dispatchReplyFromConfig) {
          setWecomAppRuntime(ctx.runtime as Record<string, unknown>);
        }
      }

      const account = resolveWecomAppAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      if (!account.configured) {
        ctx.log?.info(`[wecom-app] account ${ctx.accountId} not configured; webhook not registered`);
        ctx.setStatus?.({ accountId: ctx.accountId, running: false, configured: false });
        return;
      }

      const path = (account.config.webhookPath ?? "/wecom-app").trim();
      const unregister = registerWecomAppWebhookTarget({
        account,
        config: (ctx.cfg ?? {}) as PluginConfig,
        runtime: {
          log: ctx.log?.info ?? console.log,
          error: ctx.log?.error ?? console.error,
        },
        path,
        statusSink: (patch) => ctx.setStatus?.({ accountId: ctx.accountId, ...patch }),
      });

      const existing = unregisterHooks.get(ctx.accountId);
      if (existing) existing();
      unregisterHooks.set(ctx.accountId, unregister);

      ctx.log?.info(`[wecom-app] webhook registered at ${path} for account ${ctx.accountId} (canSendActive=${account.canSendActive})`);
      ctx.setStatus?.({
        accountId: ctx.accountId,
        running: true,
        configured: true,
        canSendActive: account.canSendActive,
        webhookPath: path,
        lastStartAt: Date.now(),
      });
    },

    stopAccount: async (ctx: { accountId: string; setStatus?: (status: Record<string, unknown>) => void }): Promise<void> => {
      const unregister = unregisterHooks.get(ctx.accountId);
      if (unregister) {
        unregister();
        unregisterHooks.delete(ctx.accountId);
      }
      ctx.setStatus?.({ accountId: ctx.accountId, running: false, lastStopAt: Date.now() });
    },
  },
};

export { DEFAULT_ACCOUNT_ID } from "./config.js";

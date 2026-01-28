/**
 * @moltbot-china/dingtalk
 * 钉钉渠道插件入口
 *
 * 导出:
 * - dingtalkPlugin: ChannelPlugin 实现
 * - sendMessageDingtalk: 发送消息函数
 * - DEFAULT_ACCOUNT_ID: 默认账户 ID
 *
 * Requirements: 1.1
 */

import { dingtalkPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";

/**
 * Moltbot 插件 API 接口（简化版）
 * 实际类型来自 moltbot/plugin-sdk
 */
export interface MoltbotPluginApi {
  registerChannel: (opts: { plugin: unknown }) => void;
  [key: string]: unknown;
}

// 导出 ChannelPlugin
export { dingtalkPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";

// 导出发送消息函数
export { sendMessageDingtalk } from "./src/send.js";

// 导出类型
export type { DingtalkConfig, ResolvedDingtalkAccount, DingtalkSendResult } from "./src/types.js";

/**
 * 钉钉插件定义
 *
 * 包含:
 * - id: 插件标识符
 * - name: 插件名称
 * - description: 插件描述
 * - configSchema: 配置 JSON Schema
 * - register: 注册函数，调用 api.registerChannel
 *
 * Requirements: 1.1
 */
const plugin = {
  id: "dingtalk",
  name: "DingTalk",
  description: "钉钉消息渠道插件",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      clientId: { type: "string" },
      clientSecret: { type: "string" },
      dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
      groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
      requireMention: { type: "boolean" },
      allowFrom: { type: "array", items: { type: "string" } },
      groupAllowFrom: { type: "array", items: { type: "string" } },
      historyLimit: { type: "integer", minimum: 0 },
      textChunkLimit: { type: "integer", minimum: 1 },
    },
  },

  /**
   * 注册钉钉渠道插件
   *
   * 调用 api.registerChannel 将 dingtalkPlugin 注册到 Moltbot
   *
   * Requirements: 1.1
   */
  register(api: MoltbotPluginApi) {
    api.registerChannel({ plugin: dingtalkPlugin });
  },
};

export default plugin;

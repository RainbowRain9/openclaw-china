/**
 * @openclaw-china/qqbot
 * QQ Bot 渠道插件入口
 */

import { qqbotPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
import { QQBOT_CHANNEL_ID, QQBOT_CONFIG_CHANNEL_ID } from "./src/config.js";
import { buildQQBotConfigJsonSchema } from "./src/config-schema.js";
import { setQQBotRuntime, getQQBotRuntime } from "./src/runtime.js";
import { registerChinaSetupCli, showChinaInstallHint } from "@openclaw-china/shared";

export interface MoltbotPluginApi {
  registerChannel: (opts: { plugin: unknown }) => void;
  runtime?: unknown;
  [key: string]: unknown;
}

export { qqbotPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
export { QQBOT_CHANNEL_ID, QQBOT_CONFIG_CHANNEL_ID } from "./src/config.js";
export { setQQBotRuntime, getQQBotRuntime } from "./src/runtime.js";
export {
  listKnownQQBotTargets,
  getKnownQQBotTarget,
  removeKnownQQBotTarget,
  clearKnownQQBotTargets,
  sendProactiveQQBotMessage,
} from "./src/proactive.js";
export type { QQBotConfig, QQBotAccountConfig, ResolvedQQBotAccount, QQBotSendResult } from "./src/types.js";
export type { KnownQQBotTarget } from "./src/proactive.js";

const plugin = {
  id: QQBOT_CHANNEL_ID,
  name: "QQ Bot",
  description: "QQ 开放平台机器人消息渠道插件",
  configSchema: buildQQBotConfigJsonSchema(),

  register(api: MoltbotPluginApi) {
    registerChinaSetupCli(api, { channels: [QQBOT_CONFIG_CHANNEL_ID] });
    showChinaInstallHint(api);

    if (api.runtime) {
      setQQBotRuntime(api.runtime as Record<string, unknown>);
    }
    api.registerChannel({ plugin: qqbotPlugin });
  },
};

export default plugin;

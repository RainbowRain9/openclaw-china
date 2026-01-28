/**
 * 钉钉插件运行时管理
 *
 * 提供对 Moltbot 核心运行时的访问
 */

/**
 * Moltbot 插件运行时接口（简化版）
 * 实际类型来自 moltbot/plugin-sdk
 */
export interface PluginRuntime {
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  [key: string]: unknown;
}

let runtime: PluginRuntime | null = null;

/**
 * 设置钉钉插件运行时
 * @param next Moltbot 插件运行时实例
 */
export function setDingtalkRuntime(next: PluginRuntime): void {
  runtime = next;
}

/**
 * 获取钉钉插件运行时
 * @returns Moltbot 插件运行时实例
 * @throws 如果运行时未初始化
 */
export function getDingtalkRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Dingtalk runtime not initialized");
  }
  return runtime;
}

/**
 * 企业微信自建应用发送消息封装
 *
 * 提供业务层简化 API，规范化 target 格式，统一调用入口
 *
 * 使用示例：
 * - 私聊：sendWecomDM("caihongyu", { text: "Hello" })
 */

import type { ResolvedWecomAppAccount, WecomAppSendTarget } from "./types.js";
import { sendWecomAppMessage, downloadAndSendImage } from "./api.js";

/**
 * 发送消息选项
 */
export type SendMessageOptions = {
  /** 文本内容 */
  text?: string;
  /** 媒体文件路径或 URL（图片） */
  mediaPath?: string;
};

/**
 * 发送消息结果
 */
export type SendResult = {
  ok: boolean;
  msgid?: string;
  error?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Target 规范化
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 规范化目标格式
 *
 * 输入格式（用户侧传入）：
 * - 私聊："caihongyu" 或 "user:caihongyu"
 * - 带 channel 前缀："wecom-app:user:caihongyu"
 *
 * 输出格式（OpenClaw 标准）：
 * - 私聊："user:caihongyu"
 */
export function normalizeTarget(
  target: string,
  type: "user"
): string {
  let normalized = target.trim();

  // 移除 channel 前缀
  const channelPrefix = "wecom-app:";
  if (normalized.startsWith(channelPrefix)) {
    normalized = normalized.slice(channelPrefix.length);
  }

  // 如果已有正确的类型前缀，直接返回
  if (type === "user" && normalized.startsWith("user:")) {
    return normalized;
  }

  // 移除可能存在的错误前缀
  if (normalized.startsWith("user:")) {
    normalized = normalized.slice(5);
  }

  // 添加正确的类型前缀
  return `user:${normalized}`;
}

/**
 * 将规范化的 target 字符串解析为 WecomAppSendTarget
 */
export function parseTarget(target: string): WecomAppSendTarget {
  if (target.startsWith("user:")) {
    return { userId: target.slice(5) };
  }
  // 默认当作用户 ID
  return { userId: target };
}

// ─────────────────────────────────────────────────────────────────────────────
// 发送消息封装
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 发送私聊消息
 *
 * @param account - 已解析的账户配置
 * @param userId - 用户 ID（如 "caihongyu"），支持带 "user:" 前缀
 * @param options - 消息选项
 *
 * @example
 * ```ts
 * // 发送文本
 * await sendWecomDM(account, "caihongyu", { text: "Hello!" });
 *
 * // 发送图片
 * await sendWecomDM(account, "caihongyu", { mediaPath: "/path/to/image.jpg" });
 *
 * // 发送文本和图片
 * await sendWecomDM(account, "caihongyu", {
 *   text: "Check out this image!",
 *   mediaPath: "https://example.com/image.jpg"
 * });
 * ```
 */
export async function sendWecomDM(
  account: ResolvedWecomAppAccount,
  userId: string,
  options: SendMessageOptions
): Promise<SendResult> {
  if (!account.canSendActive) {
    return {
      ok: false,
      error: "Account not configured for active sending (missing corpId, corpSecret, or agentId)",
    };
  }

  const normalizedTarget = normalizeTarget(userId, "user");
  const target = parseTarget(normalizedTarget);

  return sendMessage(account, target, options);
}

/**
 * 内部统一发送函数
 */
async function sendMessage(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  options: SendMessageOptions
): Promise<SendResult> {
  const results: SendResult[] = [];

  // 发送文本消息
  if (options.text?.trim()) {
    try {
      const textResult = await sendWecomAppMessage(account, target, options.text);
      results.push({
        ok: textResult.ok,
        msgid: textResult.msgid,
        error: textResult.ok ? undefined : textResult.errmsg,
      });
    } catch (err) {
      results.push({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 发送媒体消息（图片）
  if (options.mediaPath?.trim()) {
    try {
      const mediaResult = await downloadAndSendImage(account, target, options.mediaPath);
      results.push({
        ok: mediaResult.ok,
        msgid: mediaResult.msgid,
        error: mediaResult.ok ? undefined : mediaResult.errmsg,
      });
    } catch (err) {
      results.push({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 如果没有任何内容发送
  if (results.length === 0) {
    return {
      ok: false,
      error: "No content to send (need text or mediaPath)",
    };
  }

  // 汇总结果
  const allOk = results.every((r) => r.ok);
  const errors = results.filter((r) => r.error).map((r) => r.error);
  const msgids = results.filter((r) => r.msgid).map((r) => r.msgid);

  return {
    ok: allOk,
    msgid: msgids.join(",") || undefined,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 通用发送函数（自动识别目标格式）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 发送消息（自动识别目标格式）
 *
 * 支持多种 target 格式：
 * - "user:xxx" → 私聊
 * - "wecom-app:user:xxx" → 私聊（带 channel 前缀）
 * - "xxx" → 私聊（裸 ID，默认当作用户）
 *
 * @param account - 已解析的账户配置
 * @param target - 目标（支持 "user:xxx"、"wecom-app:user:xxx"、"xxx" 格式）
 * @param options - 消息选项
 */
export async function sendWecom(
  account: ResolvedWecomAppAccount,
  target: string,
  options: SendMessageOptions
): Promise<SendResult> {
  if (!account.canSendActive) {
    return {
      ok: false,
      error: "Account not configured for active sending (missing corpId, corpSecret, or agentId)",
    };
  }

  // 移除 channel 前缀
  let normalizedTarget = target.trim();
  const channelPrefix = "wecom-app:";
  if (normalizedTarget.startsWith(channelPrefix)) {
    normalizedTarget = normalizedTarget.slice(channelPrefix.length);
  }

  // 解析目标（只支持 user:）
  const parsedTarget = parseTarget(normalizedTarget);

  return sendMessage(account, parsedTarget, options);
}

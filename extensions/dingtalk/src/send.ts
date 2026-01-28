/**
 * 钉钉发送消息 API
 *
 * 提供:
 * - sendMessageDingtalk: 发送文本消息（单聊/群聊）
 *
 * API 文档:
 * - 单聊: https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches
 * - 群聊: https://open.dingtalk.com/document/orgapp/the-robot-sends-a-group-message
 */

import { getAccessToken } from "./client.js";
import type { DingtalkConfig, DingtalkSendResult } from "./types.js";

/** 钉钉 API 基础 URL */
const DINGTALK_API_BASE = "https://api.dingtalk.com";

/** HTTP 请求超时时间（毫秒） */
const REQUEST_TIMEOUT = 30000;

/**
 * 发送消息参数
 */
export interface SendMessageParams {
  /** 钉钉配置 */
  cfg: DingtalkConfig;
  /** 目标 ID（用户 ID 或会话 ID） */
  to: string;
  /** 消息文本内容 */
  text: string;
  /** 聊天类型 */
  chatType: "direct" | "group";
}

/**
 * 钉钉 API 错误响应
 */
interface DingtalkApiError {
  code?: string;
  message?: string;
  requestid?: string;
}

/**
 * 发送文本消息到钉钉
 *
 * 根据 chatType 调用不同的 API:
 * - direct: /v1.0/robot/oToMessages/batchSend (单聊批量发送)
 * - group: /v1.0/robot/groupMessages/send (群聊发送)
 *
 * @param params 发送参数
 * @returns 发送结果
 * @throws Error 如果凭证未配置或 API 调用失败
 */
export async function sendMessageDingtalk(
  params: SendMessageParams
): Promise<DingtalkSendResult> {
  const { cfg, to, text, chatType } = params;

  // 验证凭证
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("DingTalk credentials not configured (clientId, clientSecret required)");
  }

  // 获取 Access Token
  const accessToken = await getAccessToken(cfg.clientId, cfg.clientSecret);

  if (chatType === "direct") {
    return sendDirectMessage({ cfg, to, text, accessToken });
  } else {
    return sendGroupMessage({ cfg, to, text, accessToken });
  }
}


/**
 * 发送单聊消息
 *
 * 调用 /v1.0/robot/oToMessages/batchSend API
 *
 * @internal
 */
async function sendDirectMessage(params: {
  cfg: DingtalkConfig;
  to: string;
  text: string;
  accessToken: string;
}): Promise<DingtalkSendResult> {
  const { cfg, to, text, accessToken } = params;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(
      `${DINGTALK_API_BASE}/v1.0/robot/oToMessages/batchSend`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": accessToken,
        },
        body: JSON.stringify({
          robotCode: cfg.clientId,
          userIds: [to],
          msgKey: "sampleText",
          msgParam: JSON.stringify({ content: text }),
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `DingTalk direct message send failed: HTTP ${response.status}`;

      try {
        const errorData = JSON.parse(errorText) as DingtalkApiError;
        if (errorData.message) {
          errorMessage = `DingTalk direct message send failed: ${errorData.message} (code: ${errorData.code ?? "unknown"})`;
        }
      } catch {
        errorMessage = `${errorMessage} - ${errorText}`;
      }

      throw new Error(errorMessage);
    }

    const data = (await response.json()) as {
      processQueryKey?: string;
      invalidStaffIdList?: string[];
      flowControlledStaffIdList?: string[];
    };

    // 检查是否有无效用户
    if (data.invalidStaffIdList && data.invalidStaffIdList.length > 0) {
      throw new Error(
        `DingTalk direct message send failed: invalid user IDs: ${data.invalidStaffIdList.join(", ")}`
      );
    }

    return {
      messageId: data.processQueryKey ?? `dm_${Date.now()}`,
      conversationId: to,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`DingTalk direct message send timed out after ${REQUEST_TIMEOUT}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 发送群聊消息
 *
 * 调用 /v1.0/robot/groupMessages/send API
 *
 * @internal
 */
async function sendGroupMessage(params: {
  cfg: DingtalkConfig;
  to: string;
  text: string;
  accessToken: string;
}): Promise<DingtalkSendResult> {
  const { cfg, to, text, accessToken } = params;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(
      `${DINGTALK_API_BASE}/v1.0/robot/groupMessages/send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": accessToken,
        },
        body: JSON.stringify({
          robotCode: cfg.clientId,
          openConversationId: to,
          msgKey: "sampleText",
          msgParam: JSON.stringify({ content: text }),
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `DingTalk group message send failed: HTTP ${response.status}`;

      try {
        const errorData = JSON.parse(errorText) as DingtalkApiError;
        if (errorData.message) {
          errorMessage = `DingTalk group message send failed: ${errorData.message} (code: ${errorData.code ?? "unknown"})`;
        }
      } catch {
        errorMessage = `${errorMessage} - ${errorText}`;
      }

      throw new Error(errorMessage);
    }

    const data = (await response.json()) as {
      processQueryKey?: string;
    };

    return {
      messageId: data.processQueryKey ?? `gm_${Date.now()}`,
      conversationId: to,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`DingTalk group message send timed out after ${REQUEST_TIMEOUT}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

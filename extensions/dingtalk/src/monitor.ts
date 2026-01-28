/**
 * 钉钉 Stream 连接管理
 * 
 * 使用 dingtalk-stream SDK 建立持久连接接收消息
 * 
 * Requirements: 3.1, 3.3, 3.4, 3.5
 */

import { DWClient, TOPIC_ROBOT, EventAck } from "dingtalk-stream";
import { createDingtalkClientFromConfig } from "./client.js";
import { handleDingtalkMessage } from "./bot.js";
import type { DingtalkConfig } from "./config.js";
import type { DingtalkRawMessage } from "./types.js";

/**
 * Monitor 配置选项
 */
export interface MonitorDingtalkOpts {
  /** 钉钉渠道配置 */
  config?: {
    channels?: {
      dingtalk?: DingtalkConfig;
    };
  };
  /** 运行时环境 */
  runtime?: {
    log?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  /** 中止信号，用于优雅关闭 */
  abortSignal?: AbortSignal;
  /** 账户 ID */
  accountId?: string;
}

/** 当前活跃的 Stream 客户端 */
let currentClient: DWClient | null = null;

/**
 * 启动钉钉 Stream 连接监控
 * 
 * 使用 DWClient 建立 Stream 连接，注册 TOPIC_ROBOT 回调处理消息。
 * 支持 abortSignal 进行优雅关闭。
 * 
 * @param opts 监控配置选项
 * @returns Promise<void> 连接关闭时 resolve
 * @throws Error 如果凭证未配置
 * 
 * Requirements: 3.1, 3.3, 3.4, 3.5
 */
export async function monitorDingtalkProvider(opts: MonitorDingtalkOpts = {}): Promise<void> {
  const { config, runtime, abortSignal, accountId = "default" } = opts;
  
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  
  // 获取钉钉配置
  const dingtalkCfg = config?.channels?.dingtalk;
  if (!dingtalkCfg) {
    throw new Error("DingTalk configuration not found");
  }
  
  // 创建 Stream 客户端
  let client: DWClient;
  try {
    client = createDingtalkClientFromConfig(dingtalkCfg);
  } catch (err) {
    error(`[dingtalk] failed to create client: ${String(err)}`);
    throw err;
  }
  
  currentClient = client;
  
  log(`[dingtalk] starting Stream connection for account ${accountId}...`);
  
  return new Promise<void>((resolve, reject) => {
    // 清理函数
    const cleanup = () => {
      if (currentClient === client) {
        currentClient = null;
      }
      try {
        client.disconnect();
      } catch (err) {
        error(`[dingtalk] failed to disconnect client: ${String(err)}`);
      }
    };
    
    // 处理中止信号
    const handleAbort = () => {
      log("[dingtalk] abort signal received, stopping Stream client");
      cleanup();
      abortSignal?.removeEventListener("abort", handleAbort);
      resolve();
    };
    
    // 检查是否已经中止
    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }
    
    // 注册中止信号监听器
    abortSignal?.addEventListener("abort", handleAbort, { once: true });
    
    try {
      // 注册 TOPIC_ROBOT 回调处理消息
      client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
        try {
          // 解析消息数据
          const rawMessage = JSON.parse(res.data) as DingtalkRawMessage;
          
          log(`[dingtalk] received message from ${rawMessage.senderId} (type=${rawMessage.msgtype})`);
          
          // 处理消息（使用全局 runtime，不再传递 getRuntime）
          await handleDingtalkMessage({
            cfg: config,
            raw: rawMessage,
            accountId,
            log,
            error,
          });
          
          // 返回成功确认
          return EventAck.SUCCESS;
        } catch (err) {
          error(`[dingtalk] error handling message: ${String(err)}`);
          // 即使处理失败也返回成功，避免消息重试
          return EventAck.SUCCESS;
        }
      });
      
      // 启动 Stream 连接
      client.connect();
      
      log("[dingtalk] Stream client connected");
    } catch (err) {
      cleanup();
      abortSignal?.removeEventListener("abort", handleAbort);
      error(`[dingtalk] failed to start Stream connection: ${String(err)}`);
      reject(err);
    }
  });
}

/**
 * 停止钉钉 Stream 监控
 * 
 * 用于手动停止当前活跃的 Stream 连接
 */
export function stopDingtalkMonitor(): void {
  if (currentClient) {
    try {
      currentClient.disconnect();
    } catch (err) {
      console.error(`[dingtalk] failed to disconnect client: ${String(err)}`);
    } finally {
      currentClient = null;
    }
  }
}

/**
 * 获取当前 Stream 客户端状态
 * 
 * 用于诊断和测试
 * 
 * @returns 是否有活跃的客户端连接
 */
export function isMonitorActive(): boolean {
  return currentClient !== null;
}

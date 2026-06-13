/**
 * QQ Bot WebSocket 网关连接管理
 * 支持多账户并发连接
 */
import WebSocket from "ws";
import { HttpError } from "@openclaw-china/shared";
import { createLogger, type Logger } from "./logger.js";
import { handleQQBotDispatch } from "./bot.js";
import {
  mergeQQBotAccountConfig,
  DEFAULT_ACCOUNT_ID,
  type PluginConfig,
} from "./config.js";
import { clearTokenCache, getAccessToken, getGatewayUrl, getPluginUserAgent } from "./client.js";
import { clearSession, loadSession, saveSession } from "./session-store.js";

export interface MonitorQQBotOpts {
  config?: PluginConfig;
  runtime?: {
    log?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  abortSignal?: AbortSignal;
  accountId?: string;
  setStatus?: (status: Record<string, unknown>) => void;
}

type GatewayPayload = {
  op?: number;
  t?: string;
  s?: number | null;
  id?: string;
  d?: unknown;
};

const INTENTS = {
  GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
};

const DEFAULT_INTENTS =
  INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C;

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000, 60000];
// 频率限制 / 快速断开后的等待时间
const RATE_LIMIT_DELAY_MS = 60000;
// op:9 Invalid Session 后的固定重连间隔
const INVALID_SESSION_RECONNECT_DELAY_MS = 3000;
// 重连上限（避免无限重试）
const MAX_RECONNECT_ATTEMPTS = 100;
// 快速断开检测：连接后很快断开视为异常，连续达阈值则退避
const MAX_QUICK_DISCONNECT_COUNT = 3;
const QUICK_DISCONNECT_THRESHOLD_MS = 5000;

function formatGatewayConnectError(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body?.trim();
    if (body) {
      return `${err.message}; body=${body}`;
    }
    return err.message;
  }
  return String(err);
}

/**
 * 活动连接状态（每个账户独立）
 */
interface ActiveConnection {
  socket: WebSocket | null;
  promise: Promise<void> | null;
  stop: (() => void) | null;
  sessionId: string | null;
  lastSeq: number | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  connecting: boolean;
  /** 上次连接成功（socket open）的时间戳，用于快速断开检测 */
  lastConnectAt: number;
  /** 连续快速断开次数 */
  quickDisconnectCount: number;
  /** 下次 connect 前是否需要刷新 token（close 4004 / op:9 invalid session） */
  shouldRefreshToken: boolean;
}

function isConnectionIdle(conn: ActiveConnection | undefined): boolean {
  if (!conn) return true;
  return !conn.socket && !conn.promise && !conn.connecting;
}

// 按账户 ID 管理的连接映射
const activeConnections = new Map<string, ActiveConnection>();

/**
 * 获取或创建账户的连接状态
 */
function getOrCreateConnection(accountId: string): ActiveConnection {
  let conn = activeConnections.get(accountId);
  if (!conn) {
    conn = {
      socket: null,
      promise: null,
      stop: null,
      sessionId: null,
      lastSeq: null,
      heartbeatTimer: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      connecting: false,
      lastConnectAt: 0,
      quickDisconnectCount: 0,
      shouldRefreshToken: false,
    };
    activeConnections.set(accountId, conn);
  }
  return conn;
}

/**
 * 清理账户的定时器
 */
function clearTimers(conn: ActiveConnection): void {
  if (conn.heartbeatTimer) {
    clearInterval(conn.heartbeatTimer);
    conn.heartbeatTimer = null;
  }
  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
  }
}

/**
 * 清理账户的 WebSocket
 */
function cleanupSocket(conn: ActiveConnection, expectedSocket?: WebSocket): boolean {
  if (expectedSocket && conn.socket !== expectedSocket) {
    return false;
  }
  clearTimers(conn);
  if (conn.socket) {
    try {
      if (conn.socket.readyState === WebSocket.OPEN) {
        conn.socket.close();
      }
    } catch {
      // ignore
    }
    conn.socket = null;
  }
  return true;
}

export async function monitorQQBotProvider(opts: MonitorQQBotOpts = {}): Promise<void> {
  const { config, runtime, abortSignal, accountId = DEFAULT_ACCOUNT_ID, setStatus } = opts;
  const logger = createLogger("qqbot", {
    log: runtime?.log,
    error: runtime?.error,
  });

  const existingConn = activeConnections.get(accountId);
  if (!existingConn) {
    // continue
  } else if (isConnectionIdle(existingConn)) {
    activeConnections.delete(accountId);
  }

  const conn = activeConnections.get(accountId);

  // 如果该账户已有活动连接或正在建立连接，返回现有 promise
  const existingPromise = conn?.promise;
  if (existingPromise) {
    return existingPromise;
  }
  if (conn?.socket) {
    throw new Error(`QQBot monitor state invalid for account ${accountId}: active socket without promise`);
  }

  const qqCfg = config ? mergeQQBotAccountConfig(config, accountId) : undefined;
  if (!qqCfg) {
    throw new Error("QQBot configuration not found");
  }

  if (!qqCfg.appId || !qqCfg.clientSecret) {
    throw new Error(`QQBot not configured for account ${accountId} (missing appId or clientSecret)`);
  }

  const nextConn = conn ?? getOrCreateConnection(accountId);

  nextConn.promise = new Promise<void>((resolve, reject) => {
    let stopped = false;

    // 安全网：捕获 WS 握手异步错误（如 403 Unexpected server response），
    // 防止进程崩溃。仅吞掉 WS 握手类错误，其它重新抛出交上层处理。
    // 多账户并发下每个账户装一个 handler，finish 时严格移除，避免泄漏。
    const uncaughtHandler = (err: Error) => {
      if (err.message?.includes("Unexpected server response")) {
        logger.error(`caught WS handshake error (non-fatal): ${err.message}`);
        return;
      }
      throw err;
    };

    const finish = (err?: unknown) => {
      if (stopped) return;
      stopped = true;
      abortSignal?.removeEventListener("abort", onAbort);
      process.off("uncaughtException", uncaughtHandler);
      cleanupSocket(nextConn);
      nextConn.connecting = false;
      nextConn.sessionId = null;
      nextConn.lastSeq = null;
      nextConn.promise = null;
      nextConn.stop = null;
      nextConn.reconnectAttempt = 0;
      nextConn.lastConnectAt = 0;
      nextConn.quickDisconnectCount = 0;
      nextConn.shouldRefreshToken = false;
      activeConnections.delete(accountId);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const onAbort = () => {
      logger.info("abort signal received, stopping gateway");
      finish();
    };

    nextConn.stop = () => {
      logger.info("stop requested");
      finish();
    };

    const scheduleReconnect = (reason: string, customDelayMs?: number) => {
      if (stopped) return;
      if (nextConn.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        logger.error(`max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached; giving up`);
        finish(new Error(`QQBot gateway exceeded max reconnect attempts for account ${accountId}`));
        return;
      }
      // 取消已挂起的重连定时器，允许用新的延迟重新调度
      if (nextConn.reconnectTimer) {
        clearTimeout(nextConn.reconnectTimer);
        nextConn.reconnectTimer = null;
      }
      const delay =
        customDelayMs ??
        RECONNECT_DELAYS_MS[Math.min(nextConn.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
      nextConn.reconnectAttempt += 1;
      logger.warn(`[reconnect] ${reason}; retry in ${delay}ms (attempt ${nextConn.reconnectAttempt})`);
      nextConn.reconnectTimer = setTimeout(() => {
        nextConn.reconnectTimer = null;
        void connect();
      }, delay);
    };

    const startHeartbeat = (intervalMs: number) => {
      if (nextConn.heartbeatTimer) {
        clearInterval(nextConn.heartbeatTimer);
      }
      nextConn.heartbeatTimer = setInterval(() => {
        if (!nextConn.socket || nextConn.socket.readyState !== WebSocket.OPEN) return;
        const payload = JSON.stringify({ op: 1, d: nextConn.lastSeq });
        nextConn.socket.send(payload);
      }, intervalMs);
    };

    const sendIdentify = (token: string) => {
      if (!nextConn.socket || nextConn.socket.readyState !== WebSocket.OPEN) return;
      const payload = {
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents: DEFAULT_INTENTS,
          shard: [0, 1],
        },
      };
      nextConn.socket.send(JSON.stringify(payload));
    };

    const sendResume = (token: string, session: string, seq: number) => {
      if (!nextConn.socket || nextConn.socket.readyState !== WebSocket.OPEN) return;
      const payload = {
        op: 6,
        d: {
          token: `QQBot ${token}`,
          session_id: session,
          seq,
        },
      };
      nextConn.socket.send(JSON.stringify(payload));
    };

    /** 持久化当前 session 状态（带节流写），用于跨进程重启 RESUME。 */
    const persistSession = () => {
      if (!nextConn.sessionId) return;
      saveSession({
        sessionId: nextConn.sessionId,
        lastSeq: nextConn.lastSeq,
        lastConnectedAt: nextConn.lastConnectAt,
        intentLevelIndex: 0,
        accountId,
        savedAt: Date.now(),
        appId: qqCfg.appId as string,
      });
    };

    const handleGatewayPayload = async (payload: GatewayPayload, activeSocket: WebSocket) => {
      if (stopped || nextConn.socket !== activeSocket) {
        return;
      }
      if (typeof payload.s === "number") {
        nextConn.lastSeq = payload.s;
        // 每条带 s 的事件更新持久化的 lastSeq（节流写），支持跨重启 RESUME
        if (nextConn.sessionId) {
          persistSession();
        }
      }

      switch (payload.op) {
        case 10: {
          const hello = payload.d as { heartbeat_interval?: number } | undefined;
          const interval = hello?.heartbeat_interval ?? 30000;
          startHeartbeat(interval);

          const token = await getAccessToken(qqCfg.appId as string, qqCfg.clientSecret as string);
          if (stopped || nextConn.socket !== activeSocket) {
            return;
          }
          if (nextConn.sessionId && typeof nextConn.lastSeq === "number") {
            sendResume(token, nextConn.sessionId, nextConn.lastSeq);
          } else {
            sendIdentify(token);
          }
          return;
        }
        case 11:
          // Heartbeat ACK - 更新 lastEventAt 让 OpenClaw 健康检查感知连接存活
          setStatus?.({ lastEventAt: Date.now() });
          return;
        case 7:
          if (!cleanupSocket(nextConn, activeSocket)) {
            return;
          }
          scheduleReconnect("server requested reconnect");
          return;
        case 9: {
          // op:9 Invalid Session：读取 d.canResume，仅不可恢复时清 session
          const canResume = payload.d as boolean | undefined;
          if (!canResume) {
            nextConn.sessionId = null;
            nextConn.lastSeq = null;
            clearSession(accountId);
            nextConn.shouldRefreshToken = true;
          }
          if (!cleanupSocket(nextConn, activeSocket)) {
            return;
          }
          scheduleReconnect("invalid session", INVALID_SESSION_RECONNECT_DELAY_MS);
          return;
        }
        case 0: {
          const eventType = payload.t ?? "";
          if (eventType === "READY") {
            const ready = payload.d as { session_id?: string } | undefined;
            if (ready?.session_id) {
              nextConn.sessionId = ready.session_id;
            }
            nextConn.reconnectAttempt = 0;
            persistSession();
            logger.info("gateway ready");
            return;
          }
          if (eventType === "RESUMED") {
            nextConn.reconnectAttempt = 0;
            logger.info("gateway resumed");
            return;
          }
          if (eventType) {
            await handleQQBotDispatch({
              eventType,
              eventData: payload.d,
              eventId: payload.id,
              cfg: opts.config,
              accountId,
              logger,
            });
          }
          return;
        }
        default:
          return;
      }
    };

    const connect = async () => {
      if (stopped || nextConn.connecting) return;
      nextConn.connecting = true;

      try {
        cleanupSocket(nextConn);

        // 恢复持久化的 session（5 分钟窗口内、appId 匹配），实现跨进程重启 RESUME
        const saved = loadSession(accountId, qqCfg.appId as string);
        if (saved?.sessionId) {
          nextConn.sessionId = saved.sessionId;
          nextConn.lastSeq = saved.lastSeq;
          logger.info(`restored session: sessionId=${saved.sessionId}, lastSeq=${saved.lastSeq}`);
        }
        // 上次因 4004 / op:9 标记需刷新 token，下次连接前清缓存
        if (nextConn.shouldRefreshToken) {
          clearTokenCache(qqCfg.appId as string);
          nextConn.shouldRefreshToken = false;
        }

        const token = await getAccessToken(qqCfg.appId as string, qqCfg.clientSecret as string);
        if (stopped) return;
        const gatewayUrl = await getGatewayUrl(token);
        if (stopped) return;
        logger.info(`connecting gateway: ${gatewayUrl}`);

        const ws = new WebSocket(gatewayUrl, { headers: { "User-Agent": getPluginUserAgent() } });
        nextConn.socket = ws;
        if (stopped) {
          cleanupSocket(nextConn, ws);
          return;
        }

        ws.on("open", () => {
          nextConn.lastConnectAt = Date.now();
          logger.info("gateway socket opened");
        });

        ws.on("message", (data) => {
          const raw = typeof data === "string" ? data : data.toString();
          let payload: GatewayPayload;
          try {
            payload = JSON.parse(raw) as GatewayPayload;
          } catch (err) {
            logger.warn(`failed to parse gateway payload: ${String(err)}`);
            return;
          }
          void handleGatewayPayload(payload, ws).catch((err) => {
            logger.error(`gateway dispatch error: ${String(err)}`);
          });
        });

        ws.on("close", (code, reason) => {
          if (!cleanupSocket(nextConn, ws)) {
            return;
          }
          const codeNum = typeof code === "number" ? code : 1000;
          logger.warn(`gateway socket closed (${code}) ${String(reason)}`);

          // close-code 感知重连（见 QQ 官方文档）
          // 4914/4915: 机器人下架/封禁 —— 不重连
          if (codeNum === 4914 || codeNum === 4915) {
            logger.error(
              `bot is ${codeNum === 4914 ? "offline/sandbox-only" : "banned"} (code ${codeNum}); halting reconnect`,
            );
            finish();
            return;
          }
          // 4004: token 无效 —— 标记刷新后重连
          if (codeNum === 4004) {
            nextConn.shouldRefreshToken = true;
            scheduleReconnect("invalid token (4004)");
            return;
          }
          // 4008: 限流 —— 等待 60s 后重连
          if (codeNum === 4008) {
            scheduleReconnect("rate limited (4008)", RATE_LIMIT_DELAY_MS);
            return;
          }
          // 4006/4007/4009: 会话失效/seq 无效/超时 —— 清 session 重新 identify
          if (codeNum === 4006 || codeNum === 4007 || codeNum === 4009) {
            nextConn.sessionId = null;
            nextConn.lastSeq = null;
            clearSession(accountId);
            nextConn.shouldRefreshToken = true;
          } else if (codeNum >= 4900 && codeNum <= 4913) {
            // 4900-4913: 内部错误 —— 清 session 重新 identify
            nextConn.sessionId = null;
            nextConn.lastSeq = null;
            clearSession(accountId);
            nextConn.shouldRefreshToken = true;
          }

          // 快速断开检测：连接后 <5s 即断开，连续达阈值则退避
          const connectionDuration = nextConn.lastConnectAt
            ? Date.now() - nextConn.lastConnectAt
            : Number.POSITIVE_INFINITY;
          if (connectionDuration < QUICK_DISCONNECT_THRESHOLD_MS) {
            nextConn.quickDisconnectCount += 1;
            if (nextConn.quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
              logger.error(
                `too many quick disconnects (${nextConn.quickDisconnectCount}); possible permission/appId/secret issue`,
              );
              nextConn.quickDisconnectCount = 0;
              if (codeNum !== 1000) {
                scheduleReconnect("quick-disconnect backoff", RATE_LIMIT_DELAY_MS);
              }
              return;
            }
          } else {
            nextConn.quickDisconnectCount = 0;
          }

          if (codeNum !== 1000) {
            scheduleReconnect(`socket closed (${codeNum})`);
          }
        });

        ws.on("error", (err) => {
          if (stopped || nextConn.socket !== ws) {
            return;
          }
          logger.error(`gateway socket error: ${String(err)}`);
        });
      } catch (err) {
        logger.error(`gateway connect failed: ${formatGatewayConnectError(err)}`);
        cleanupSocket(nextConn);
        scheduleReconnect("connect failed");
      } finally {
        nextConn.connecting = false;
      }
    };

    if (abortSignal?.aborted) {
      finish();
      return;
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    process.on("uncaughtException", uncaughtHandler);
    void connect();
  });

  return nextConn.promise;
}

/**
 * 停止指定账户的连接
 */
export function stopQQBotMonitorForAccount(accountId: string = DEFAULT_ACCOUNT_ID): void {
  const conn = activeConnections.get(accountId);
  if (!conn) return;

  if (conn.stop) {
    conn.stop();
    return;
  }

  cleanupSocket(conn);
  activeConnections.delete(accountId);
}

/**
 * 停止所有账户的连接
 */
export function stopAllQQBotMonitors(): void {
  for (const accountId of activeConnections.keys()) {
    stopQQBotMonitorForAccount(accountId);
  }
}

/**
 * @deprecated 使用 stopQQBotMonitorForAccount 或 stopAllQQBotMonitors
 * 为了向后兼容，停止默认账户
 */
export function stopQQBotMonitor(): void {
  stopQQBotMonitorForAccount(DEFAULT_ACCOUNT_ID);
}

/**
 * 检查指定账户是否有活动连接
 */
export function isQQBotMonitorActiveForAccount(accountId: string = DEFAULT_ACCOUNT_ID): boolean {
  const conn = activeConnections.get(accountId);
  return Boolean(conn?.socket);
}

/**
 * @deprecated 使用 isQQBotMonitorActiveForAccount
 */
export function isQQBotMonitorActive(): boolean {
  return isQQBotMonitorActiveForAccount(DEFAULT_ACCOUNT_ID);
}

/**
 * 获取所有活动账户 ID
 */
export function getActiveAccountIds(): string[] {
  return Array.from(activeConnections.keys());
}

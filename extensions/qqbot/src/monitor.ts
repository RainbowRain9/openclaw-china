/**
 * QQ Bot WebSocket 网关连接管理
 */

import WebSocket from "ws";
import { createLogger, type Logger } from "./logger.js";
import { handleQQBotDispatch } from "./bot.js";
import { QQBotConfigSchema } from "./config.js";
import { clearTokenCache, getAccessToken, getGatewayUrl } from "./client.js";
import type { QQBotConfig } from "./types.js";

export interface MonitorQQBotOpts {
  config?: {
    channels?: {
      qqbot?: QQBotConfig;
    };
  };
  runtime?: {
    log?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  abortSignal?: AbortSignal;
  accountId?: string;
}

type GatewayPayload = {
  op?: number;
  t?: string;
  s?: number | null;
  d?: unknown;
};

const INTENTS = {
  GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
};

const DEFAULT_INTENTS =
  INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C;

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 20000, 30000];

let activeSocket: WebSocket | null = null;
let activeAccountId: string | null = null;
let activePromise: Promise<void> | null = null;
let activeStop: (() => void) | null = null;

export async function monitorQQBotProvider(opts: MonitorQQBotOpts = {}): Promise<void> {
  const { config, runtime, abortSignal, accountId = "default" } = opts;
  const logger = createLogger("qqbot", {
    log: runtime?.log,
    error: runtime?.error,
  });

  if (activeSocket) {
    if (activeAccountId && activeAccountId !== accountId) {
      throw new Error(`QQBot already running for account ${activeAccountId}`);
    }
    if (activePromise) {
      return activePromise;
    }
    throw new Error("QQBot monitor state invalid: active socket without promise");
  }

  const rawCfg = config?.channels?.qqbot;
  const parsed = rawCfg ? QQBotConfigSchema.safeParse(rawCfg) : null;
  const qqCfg = parsed?.success ? parsed.data : rawCfg;
  if (!qqCfg) {
    throw new Error("QQBot configuration not found");
  }

  if (!qqCfg.appId || !qqCfg.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  activePromise = new Promise<void>((resolve, reject) => {
    let stopped = false;
    let reconnectAttempt = 0;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let sessionId: string | null = null;
    let lastSeq: number | null = null;
    let connecting = false;

    const clearTimers = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const cleanupSocket = () => {
      clearTimers();
      if (activeSocket) {
        try {
          if (activeSocket.readyState === WebSocket.OPEN) {
            activeSocket.close();
          }
        } catch {
          // ignore
        }
      }
      activeSocket = null;
    };

    const finish = (err?: unknown) => {
      if (stopped) return;
      stopped = true;
      abortSignal?.removeEventListener("abort", onAbort);
      cleanupSocket();
      activeAccountId = null;
      activePromise = null;
      activeStop = null;
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

    activeStop = () => {
      logger.info("stop requested");
      finish();
    };

    const scheduleReconnect = (reason: string) => {
      if (stopped) return;
      if (reconnectTimer) return;
      const delay =
        RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
      reconnectAttempt += 1;
      logger.warn(`[reconnect] ${reason}; retry in ${delay}ms`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    const startHeartbeat = (intervalMs: number) => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      heartbeatTimer = setInterval(() => {
        if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
        const payload = JSON.stringify({ op: 1, d: lastSeq });
        activeSocket.send(payload);
      }, intervalMs);
    };

    const sendIdentify = (token: string) => {
      if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
      const payload = {
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents: DEFAULT_INTENTS,
          shard: [0, 1],
        },
      };
      activeSocket.send(JSON.stringify(payload));
    };

    const sendResume = (token: string, session: string, seq: number) => {
      if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
      const payload = {
        op: 6,
        d: {
          token: `QQBot ${token}`,
          session_id: session,
          seq,
        },
      };
      activeSocket.send(JSON.stringify(payload));
    };

    const handleGatewayPayload = async (payload: GatewayPayload) => {
      if (typeof payload.s === "number") {
        lastSeq = payload.s;
      }

      switch (payload.op) {
        case 10: {
          const hello = payload.d as { heartbeat_interval?: number } | undefined;
          const interval = hello?.heartbeat_interval ?? 30000;
          startHeartbeat(interval);

          const token = await getAccessToken(qqCfg.appId as string, qqCfg.clientSecret as string);
          if (sessionId && typeof lastSeq === "number") {
            sendResume(token, sessionId, lastSeq);
          } else {
            sendIdentify(token);
          }
          return;
        }
        case 11:
          return;
        case 7:
          cleanupSocket();
          scheduleReconnect("server requested reconnect");
          return;
        case 9:
          sessionId = null;
          lastSeq = null;
          clearTokenCache();
          cleanupSocket();
          scheduleReconnect("invalid session");
          return;
        case 0: {
          const eventType = payload.t ?? "";
          if (eventType === "READY") {
            const ready = payload.d as { session_id?: string } | undefined;
            if (ready?.session_id) {
              sessionId = ready.session_id;
            }
            reconnectAttempt = 0;
            logger.info("gateway ready");
            return;
          }
          if (eventType === "RESUMED") {
            reconnectAttempt = 0;
            logger.info("gateway resumed");
            return;
          }
          if (eventType) {
            await handleQQBotDispatch({
              eventType,
              eventData: payload.d,
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
      if (stopped || connecting) return;
      connecting = true;

      try {
        cleanupSocket();
        const token = await getAccessToken(qqCfg.appId as string, qqCfg.clientSecret as string);
        const gatewayUrl = await getGatewayUrl(token);
        logger.info(`connecting gateway: ${gatewayUrl}`);

        const ws = new WebSocket(gatewayUrl);
        activeSocket = ws;
        activeAccountId = accountId;

        ws.on("open", () => {
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
          void handleGatewayPayload(payload).catch((err) => {
            logger.error(`gateway dispatch error: ${String(err)}`);
          });
        });

        ws.on("close", (code, reason) => {
          logger.warn(`gateway socket closed (${code}) ${String(reason)}`);
          cleanupSocket();
          scheduleReconnect("socket closed");
        });

        ws.on("error", (err) => {
          logger.error(`gateway socket error: ${String(err)}`);
        });
      } catch (err) {
        logger.error(`gateway connect failed: ${String(err)}`);
        cleanupSocket();
        scheduleReconnect("connect failed");
      } finally {
        connecting = false;
      }
    };

    if (abortSignal?.aborted) {
      finish();
      return;
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    void connect();
  });

  return activePromise;
}

export function stopQQBotMonitor(): void {
  if (activeStop) {
    activeStop();
    return;
  }
  if (activeSocket) {
    try {
      activeSocket.close();
    } catch {
      // ignore
    }
    activeSocket = null;
    activeAccountId = null;
    activePromise = null;
    activeStop = null;
  }
}

export function isQQBotMonitorActive(): boolean {
  return activeSocket !== null;
}

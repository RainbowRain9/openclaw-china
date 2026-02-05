/**
 * QQ Bot 入站消息处理
 */

import {
  checkDmPolicy,
  checkGroupPolicy,
  createLogger,
  type Logger,
  appendCronHiddenPrompt,
  extractMediaFromText,
} from "@openclaw-china/shared";
import { QQBotConfigSchema, type QQBotConfig } from "./config.js";
import { qqbotOutbound } from "./outbound.js";
import { getQQBotRuntime } from "./runtime.js";
import type { InboundContext, QQInboundMessage } from "./types.js";
import * as fs from "node:fs";

type DispatchParams = {
  eventType: string;
  eventData: unknown;
  cfg?: {
    channels?: {
      qqbot?: QQBotConfig;
    };
  };
  accountId: string;
  logger?: Logger;
};

function toString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function parseC2CMessage(data: unknown): QQInboundMessage | null {
  const payload = data as Record<string, unknown>;
  const content = toString(payload.content);
  const id = toString(payload.id);
  const timestamp = toNumber(payload.timestamp) ?? Date.now();
  const author = (payload.author ?? {}) as Record<string, unknown>;
  const senderId = toString(author.user_openid);
  if (!content || !id || !senderId) return null;

  return {
    type: "direct",
    senderId,
    senderName: toString(author.username),
    content,
    messageId: id,
    timestamp,
    mentionedBot: false,
  };
}

function parseGroupMessage(data: unknown): QQInboundMessage | null {
  const payload = data as Record<string, unknown>;
  const content = toString(payload.content);
  const id = toString(payload.id);
  const timestamp = toNumber(payload.timestamp) ?? Date.now();
  const groupOpenid = toString(payload.group_openid);
  const author = (payload.author ?? {}) as Record<string, unknown>;
  const senderId = toString(author.member_openid);
  if (!content || !id || !senderId || !groupOpenid) return null;

  return {
    type: "group",
    senderId,
    senderName: toString(author.nickname) ?? toString(author.username),
    content,
    messageId: id,
    timestamp,
    groupOpenid,
    mentionedBot: true,
  };
}

function parseChannelMessage(data: unknown): QQInboundMessage | null {
  const payload = data as Record<string, unknown>;
  const content = toString(payload.content);
  const id = toString(payload.id);
  const timestamp = toNumber(payload.timestamp) ?? Date.now();
  const channelId = toString(payload.channel_id);
  const guildId = toString(payload.guild_id);
  const author = (payload.author ?? {}) as Record<string, unknown>;
  const senderId = toString(author.id);
  if (!content || !id || !senderId || !channelId) return null;

  return {
    type: "channel",
    senderId,
    senderName: toString(author.username),
    content,
    messageId: id,
    timestamp,
    channelId,
    guildId,
    mentionedBot: true,
  };
}

function parseDirectMessage(data: unknown): QQInboundMessage | null {
  const payload = data as Record<string, unknown>;
  const content = toString(payload.content);
  const id = toString(payload.id);
  const timestamp = toNumber(payload.timestamp) ?? Date.now();
  const guildId = toString(payload.guild_id);
  const author = (payload.author ?? {}) as Record<string, unknown>;
  const senderId = toString(author.id);
  if (!content || !id || !senderId) return null;

  return {
    type: "direct",
    senderId,
    senderName: toString(author.username),
    content,
    messageId: id,
    timestamp,
    guildId,
    mentionedBot: false,
  };
}

function resolveInbound(eventType: string, data: unknown): QQInboundMessage | null {
  switch (eventType) {
    case "C2C_MESSAGE_CREATE":
      return parseC2CMessage(data);
    case "GROUP_AT_MESSAGE_CREATE":
      return parseGroupMessage(data);
    case "AT_MESSAGE_CREATE":
      return parseChannelMessage(data);
    case "DIRECT_MESSAGE_CREATE":
      return parseDirectMessage(data);
    default:
      return null;
  }
}

function resolveChatTarget(event: QQInboundMessage): { to: string; peerId: string; peerKind: "group" | "dm" } {
  if (event.type === "group") {
    const group = event.groupOpenid ?? "";
    return {
      to: `group:${group}`,
      peerId: `group:${group}`,
      peerKind: "group",
    };
  }
  if (event.type === "channel") {
    const channel = event.channelId ?? "";
    return {
      to: `channel:${channel}`,
      peerId: `channel:${channel}`,
      peerKind: "group",
    };
  }
  return {
    to: `user:${event.senderId}`,
    peerId: event.senderId,
    peerKind: "dm",
  };
}

function resolveEnvelopeFrom(event: QQInboundMessage): string {
  if (event.type === "group") {
    return `group:${event.groupOpenid ?? "unknown"}`;
  }
  if (event.type === "channel") {
    return `channel:${event.channelId ?? "unknown"}`;
  }
  return event.senderName?.trim() || event.senderId;
}

function extractLocalMediaFromText(params: {
  text: string;
  logger?: Logger;
}): { text: string; mediaUrls: string[] } {
  const { text, logger } = params;
  const result = extractMediaFromText(text, {
    removeFromText: true,
    checkExists: true,
    existsSync: (p: string) => {
      const exists = fs.existsSync(p);
      if (!exists) {
        logger?.warn?.(`[media] local file not found: ${p}`);
      }
      return exists;
    },
    parseMediaLines: false,
    parseMarkdownImages: true,
    parseHtmlImages: false,
    parseBarePaths: true,
    parseMarkdownLinks: true,
  });

  const mediaUrls = result.all
    .filter((m) => m.isLocal && m.localPath)
    .map((m) => m.localPath as string);

  return { text: result.text, mediaUrls };
}

function extractMediaLinesFromText(params: {
  text: string;
  logger?: Logger;
}): { text: string; mediaUrls: string[] } {
  const { text, logger } = params;
  const result = extractMediaFromText(text, {
    removeFromText: true,
    checkExists: true,
    existsSync: (p: string) => {
      const exists = fs.existsSync(p);
      if (!exists) {
        logger?.warn?.(`[media] local file not found: ${p}`);
      }
      return exists;
    },
    parseMediaLines: true,
    parseMarkdownImages: false,
    parseHtmlImages: false,
    parseBarePaths: false,
    parseMarkdownLinks: false,
  });

  const mediaUrls = result.all
    .map((m) => (m.isLocal ? m.localPath ?? m.source : m.source))
    .filter((m): m is string => typeof m === "string" && m.trim().length > 0);

  return { text: result.text, mediaUrls };
}

function buildInboundContext(params: {
  event: QQInboundMessage;
  sessionKey: string;
  accountId: string;
  body?: string;
  rawBody?: string;
  commandBody?: string;
}): InboundContext {
  const { event, sessionKey, accountId } = params;
  const body = params.body ?? event.content;
  const rawBody = params.rawBody ?? event.content;
  const commandBody = params.commandBody ?? event.content;
  const chatType = event.type === "group" || event.type === "channel" ? "group" : "direct";
  const { to } = resolveChatTarget(event);
  const from =
    event.type === "group"
      ? `qqbot:group:${event.groupOpenid ?? ""}`
      : event.type === "channel"
        ? `qqbot:channel:${event.channelId ?? ""}`
        : `qqbot:${event.senderId}`;

  return {
    Body: body,
    RawBody: rawBody,
    CommandBody: commandBody,
    From: from,
    To: to,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: chatType,
    GroupSubject: event.type === "group" ? event.groupOpenid : event.channelId,
    SenderName: event.senderName,
    SenderId: event.senderId,
    Provider: "qqbot",
    MessageSid: event.messageId,
    Timestamp: event.timestamp,
    WasMentioned: event.mentionedBot,
    CommandAuthorized: true,
    OriginatingChannel: "qqbot",
    OriginatingTo: to,
  };
}

async function dispatchToAgent(params: {
  inbound: QQInboundMessage;
  cfg: unknown;
  qqCfg: QQBotConfig;
  accountId: string;
  logger: Logger;
}): Promise<void> {
  const { inbound, cfg, qqCfg, accountId, logger } = params;
  const runtime = getQQBotRuntime();
  const routing = runtime.channel?.routing?.resolveAgentRoute;
  if (!routing) {
    logger.warn("routing API not available");
    return;
  }

  const target = resolveChatTarget(inbound);
  const route = routing({
    cfg,
    channel: "qqbot",
    accountId,
    peer: { kind: target.peerKind, id: target.peerId },
  });

  const replyApi = runtime.channel?.reply;
  if (!replyApi) {
    logger.warn("reply API not available");
    return;
  }

  const sessionApi = runtime.channel?.session;
  const storePath = sessionApi?.resolveStorePath?.(
    (cfg as Record<string, unknown>)?.session?.store,
    { agentId: route.agentId }
  );

  const envelopeOptions = replyApi.resolveEnvelopeFormatOptions?.(cfg);
  const previousTimestamp =
    storePath && sessionApi?.readSessionUpdatedAt
      ? sessionApi.readSessionUpdatedAt({ storePath, sessionKey: route.sessionKey })
      : null;
  const rawBody = inbound.content;
  const envelopeFrom = resolveEnvelopeFrom(inbound);
  const inboundBody =
    replyApi.formatInboundEnvelope
      ? replyApi.formatInboundEnvelope({
          channel: "QQ",
          from: envelopeFrom,
          body: rawBody,
          timestamp: inbound.timestamp,
          previousTimestamp: previousTimestamp ?? undefined,
          chatType: inbound.type === "direct" ? "direct" : "group",
          senderLabel: inbound.senderName ?? inbound.senderId,
          sender: { id: inbound.senderId, name: inbound.senderName ?? undefined },
          envelope: envelopeOptions,
        })
      : replyApi.formatAgentEnvelope
        ? replyApi.formatAgentEnvelope({
            channel: "QQ",
            from: envelopeFrom,
            timestamp: inbound.timestamp,
            previousTimestamp: previousTimestamp ?? undefined,
            envelope: envelopeOptions,
            body: rawBody,
          })
        : rawBody;

  const inboundCtx = buildInboundContext({
    event: inbound,
    sessionKey: route.sessionKey,
    accountId: route.accountId ?? accountId,
    body: inboundBody,
    rawBody,
    commandBody: rawBody,
  });

  const finalizeInboundContext = replyApi?.finalizeInboundContext as
    | ((ctx: InboundContext) => InboundContext)
    | undefined;
  const finalCtx = finalizeInboundContext ? finalizeInboundContext(inboundCtx) : inboundCtx;

  let cronBase = "";
  if (typeof finalCtx.RawBody === "string" && finalCtx.RawBody) {
    cronBase = finalCtx.RawBody;
  } else if (typeof finalCtx.Body === "string" && finalCtx.Body) {
    cronBase = finalCtx.Body;
  } else if (typeof finalCtx.CommandBody === "string" && finalCtx.CommandBody) {
    cronBase = finalCtx.CommandBody;
  }

  if (cronBase) {
    const nextCron = appendCronHiddenPrompt(cronBase);
    if (nextCron !== cronBase) {
      finalCtx.BodyForAgent = nextCron;
    }
  }

  if (storePath && sessionApi?.recordInboundSession) {
    try {
      const mainSessionKeyRaw = (route as Record<string, unknown>)?.mainSessionKey;
      const mainSessionKey =
        typeof mainSessionKeyRaw === "string" && mainSessionKeyRaw.trim()
          ? mainSessionKeyRaw
          : undefined;
      const isGroup = inbound.type === "group" || inbound.type === "channel";
      const updateLastRoute =
        !isGroup
          ? {
              sessionKey: mainSessionKey ?? route.sessionKey,
              channel: "qqbot",
              to: (finalCtx.OriginatingTo ?? finalCtx.To ?? `user:${inbound.senderId}`) as string,
              accountId: route.accountId ?? accountId,
            }
          : undefined;

      const recordSessionKey =
        typeof finalCtx.SessionKey === "string" && finalCtx.SessionKey.trim()
          ? finalCtx.SessionKey
          : route.sessionKey;

      await sessionApi.recordInboundSession({
        storePath,
        sessionKey: recordSessionKey,
        ctx: finalCtx,
        updateLastRoute,
        onRecordError: (err: unknown) => {
          logger.warn(`failed to record inbound session: ${String(err)}`);
        },
      });
    } catch (err) {
      logger.warn(`failed to record inbound session: ${String(err)}`);
    }
  }

  const textApi = runtime.channel?.text;
  const limit =
    textApi?.resolveTextChunkLimit?.({
      cfg,
      channel: "qqbot",
      defaultLimit: qqCfg.textChunkLimit ?? 1500,
    }) ?? (qqCfg.textChunkLimit ?? 1500);

  const chunkMode = textApi?.resolveChunkMode?.(cfg, "qqbot");
  const tableMode = textApi?.resolveMarkdownTableMode?.({
    cfg,
    channel: "qqbot",
    accountId: route.accountId ?? accountId,
  });
  const resolvedTableMode = tableMode ?? "bullets";
  const chunkText = (text: string): string[] => {
    if (textApi?.chunkMarkdownText && limit > 0) {
      return textApi.chunkMarkdownText(text, limit);
    }
    if (textApi?.chunkTextWithMode && limit > 0) {
      return textApi.chunkTextWithMode(text, limit, chunkMode);
    }
    return [text];
  };

  const replyFinalOnly = qqCfg.replyFinalOnly ?? false;

  const deliver = async (payload: unknown, info?: { kind?: string }): Promise<void> => {
    if (replyFinalOnly && info?.kind && info.kind !== "final") return;
    const typed = payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] } | undefined;
    const rawText = typed?.text ?? "";
    const mediaLineResult = extractMediaLinesFromText({
      text: rawText,
      logger,
    });
    const localMediaResult = extractLocalMediaFromText({
      text: mediaLineResult.text,
      logger,
    });
    const trimmed = localMediaResult.text.trim();

    const payloadMediaUrls = Array.isArray(typed?.mediaUrls)
      ? typed?.mediaUrls
      : typed?.mediaUrl
        ? [typed.mediaUrl]
        : [];

    const mediaQueue: string[] = [];
    const seenMedia = new Set<string>();
    const addMedia = (value?: string) => {
      const next = value?.trim();
      if (!next) return;
      if (seenMedia.has(next)) return;
      seenMedia.add(next);
      mediaQueue.push(next);
    };

    for (const url of payloadMediaUrls) addMedia(url);
    for (const url of mediaLineResult.mediaUrls) addMedia(url);
    for (const url of localMediaResult.mediaUrls) addMedia(url);

    if (trimmed) {
      const converted = textApi?.convertMarkdownTables
        ? textApi.convertMarkdownTables(trimmed, resolvedTableMode)
        : trimmed;
      const chunks = chunkText(converted);
      for (const chunk of chunks) {
        const result = await qqbotOutbound.sendText({
          cfg: { channels: { qqbot: qqCfg } },
          to: target.to,
          text: chunk,
          replyToId: inbound.messageId,
        });
        if (result.error) {
          logger.error(`sendText failed: ${result.error}`);
        }
      }
    }

    for (const mediaUrl of mediaQueue) {
      const result = await qqbotOutbound.sendMedia({
        cfg: { channels: { qqbot: qqCfg } },
        to: target.to,
        mediaUrl,
      });
      if (result.error) {
        logger.error(`sendMedia failed: ${result.error}`);
        const fallback = `📎 ${mediaUrl}`;
        const fallbackResult = await qqbotOutbound.sendText({
          cfg: { channels: { qqbot: qqCfg } },
          to: target.to,
          text: fallback,
          replyToId: inbound.messageId,
        });
        if (fallbackResult.error) {
          logger.error(`sendText fallback failed: ${fallbackResult.error}`);
        }
      }
    }
  };

  const humanDelay = replyApi.resolveHumanDelayConfig?.(cfg, route.agentId);
  const dispatchBuffered = replyApi.dispatchReplyWithBufferedBlockDispatcher;
  if (dispatchBuffered) {
    await dispatchBuffered({
      ctx: finalCtx,
      cfg,
      dispatcherOptions: {
        deliver,
        humanDelay,
        onError: (err: unknown, info: { kind: string }) => {
          logger.error(`${info.kind} reply failed: ${String(err)}`);
        },
        onSkip: (_payload: unknown, info: { kind: string; reason: string }) => {
          if (info.reason !== "silent") {
            logger.info(`reply skipped: ${info.reason}`);
          }
        },
      },
    });
    return;
  }

  const dispatcherResult = replyApi.createReplyDispatcherWithTyping
    ? replyApi.createReplyDispatcherWithTyping({
        deliver,
        humanDelay,
        onError: (err: unknown, info: { kind: string }) => {
          logger.error(`${info.kind} reply failed: ${String(err)}`);
        },
      })
    : {
        dispatcher: replyApi.createReplyDispatcher?.({
          deliver,
          humanDelay,
          onError: (err: unknown, info: { kind: string }) => {
            logger.error(`${info.kind} reply failed: ${String(err)}`);
          },
        }),
        replyOptions: {},
        markDispatchIdle: () => undefined,
      };

  if (!dispatcherResult.dispatcher || !replyApi.dispatchReplyFromConfig) {
    logger.warn("dispatcher not available, skipping reply");
    return;
  }

  await replyApi.dispatchReplyFromConfig({
    ctx: finalCtx,
    cfg,
    dispatcher: dispatcherResult.dispatcher,
    replyOptions: dispatcherResult.replyOptions,
  });

  dispatcherResult.markDispatchIdle?.();
}

function shouldHandleMessage(event: QQInboundMessage, qqCfg: QQBotConfig, logger: Logger): boolean {
  if (event.type === "direct") {
    const dmPolicy = qqCfg.dmPolicy ?? "open";
    const allowed = checkDmPolicy({
      dmPolicy,
      senderId: event.senderId,
      allowFrom: qqCfg.allowFrom ?? [],
    });
    if (!allowed.allowed) {
      logger.info(`dm blocked: ${allowed.reason ?? "policy"}`);
      return false;
    }
    return true;
  }

  const groupPolicy = qqCfg.groupPolicy ?? "open";
  const conversationId =
    event.type === "group"
      ? event.groupOpenid ?? ""
      : event.channelId ?? "";
  const allowed = checkGroupPolicy({
    groupPolicy,
    conversationId,
    groupAllowFrom: qqCfg.groupAllowFrom ?? [],
    requireMention: qqCfg.requireMention ?? true,
    mentionedBot: event.mentionedBot,
  });
  if (!allowed.allowed) {
    logger.info(`group blocked: ${allowed.reason ?? "policy"}`);
    return false;
  }
  return true;
}

export async function handleQQBotDispatch(params: DispatchParams): Promise<void> {
  const logger = params.logger ?? createLogger("qqbot");
  const inbound = resolveInbound(params.eventType, params.eventData);
  if (!inbound) {
    return;
  }

  const rawCfg = params.cfg?.channels?.qqbot;
  const parsedCfg = rawCfg ? QQBotConfigSchema.safeParse(rawCfg) : null;
  const qqCfg = parsedCfg?.success ? parsedCfg.data : rawCfg;
  if (!qqCfg) {
    logger.warn("qqbot config missing, ignoring inbound message");
    return;
  }
  if (!qqCfg.enabled) {
    logger.info("qqbot disabled, ignoring inbound message");
    return;
  }

  if (!shouldHandleMessage(inbound, qqCfg, logger)) {
    return;
  }

  const content = inbound.content.trim();
  if (!content) {
    return;
  }

  await dispatchToAgent({
    inbound: { ...inbound, content },
    cfg: params.cfg,
    qqCfg,
    accountId: params.accountId,
    logger,
  });
}

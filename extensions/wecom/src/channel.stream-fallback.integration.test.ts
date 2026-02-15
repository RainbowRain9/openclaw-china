import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { wecomPlugin } from "./channel.js";
import { clearOutboundReplyState } from "./outbound-reply.js";
import { decryptWecomEncrypted, encryptWecomPlaintext, computeWecomMsgSignature } from "./crypto.js";
import { handleWecomWebhookRequest, registerWecomWebhookTarget } from "./monitor.js";
import { clearWecomRuntime, setWecomRuntime } from "./runtime.js";
import type { ResolvedWecomAccount } from "./types.js";

const token = "token123";
const encodingAESKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const receiveId = "corp123";

const cfg = {
  channels: {
    wecom: {
      enabled: true,
      token,
      encodingAESKey,
    },
  },
};

function createRequest(method: string, url: string, body?: string): IncomingMessage {
  const stream = new Readable({
    read() {
      return;
    },
  });
  if (body) {
    stream.push(body);
  }
  stream.push(null);
  (stream as IncomingMessage).method = method;
  (stream as IncomingMessage).url = url;
  return stream as IncomingMessage;
}

function createResponseRecorder() {
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 200,
    setHeader: () => {
      return;
    },
    end: (data?: string | Buffer) => {
      if (data === undefined) return;
      chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    },
  } as unknown as ServerResponse;

  return {
    res,
    getBody: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function buildAccount(): ResolvedWecomAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    token,
    encodingAESKey,
    receiveId,
    config: {
      webhookPath: "/wecom",
    },
  };
}

function buildEncryptedWebhook(params: {
  nonce: string;
  timestamp: string;
  payload: Record<string, unknown>;
}): IncomingMessage {
  const encrypt = encryptWecomPlaintext({
    encodingAESKey,
    receiveId,
    plaintext: JSON.stringify(params.payload),
  });
  const signature = computeWecomMsgSignature({
    token,
    timestamp: params.timestamp,
    nonce: params.nonce,
    encrypt,
  });
  const query = new URLSearchParams({
    timestamp: params.timestamp,
    nonce: params.nonce,
    msg_signature: signature,
  });
  return createRequest("POST", `/wecom?${query.toString()}`, JSON.stringify({ encrypt }));
}

describe("wecom stream fallback integration", () => {
  beforeEach(() => {
    clearOutboundReplyState();
    clearWecomRuntime();
  });

  afterEach(() => {
    clearWecomRuntime();
  });

  it("appends media into active stream when response_url is not available", async () => {
    let releaseDispatch: (() => void) | null = null;
    setWecomRuntime({
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            sessionKey: "session-1",
            accountId: "default",
            agentId: "agent-1",
          }),
        },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async () => {
            await new Promise<void>((resolve) => {
              releaseDispatch = resolve;
            });
          },
        },
      },
    });

    const unregister = registerWecomWebhookTarget({
      account: buildAccount(),
      config: cfg,
      runtime: {},
      path: "/wecom",
    });

    try {
      const inboundReq = buildEncryptedWebhook({
        timestamp: "1700001001",
        nonce: "n1",
        payload: {
          msgtype: "text",
          msgid: "m-stream-1",
          chattype: "single",
          from: { userid: "alice" },
          text: { content: "hi" },
        },
      });
      const inboundRes = createResponseRecorder();

      const handledInbound = await handleWecomWebhookRequest(inboundReq, inboundRes.res);
      expect(handledInbound).toBe(true);

      const initialEncrypted = JSON.parse(inboundRes.getBody()) as { encrypt: string };
      const initialPlain = decryptWecomEncrypted({
        encodingAESKey,
        receiveId,
        encrypt: initialEncrypted.encrypt,
      });
      const initialPayload = JSON.parse(initialPlain) as {
        msgtype?: string;
        stream?: { id?: string };
      };
      expect(initialPayload.msgtype).toBe("stream");
      const streamId = String(initialPayload.stream?.id ?? "");
      expect(streamId).toBeTruthy();

      const sendResult = await wecomPlugin.outbound.sendMedia({
        cfg,
        to: "user:alice",
        mediaUrl: "https://cdn.example.com/report.pdf",
        mimeType: "application/pdf",
        text: "附件如下",
      });

      expect(sendResult.ok).toBe(true);
      expect(sendResult.messageId).toContain("stream:");

      const refreshReq = buildEncryptedWebhook({
        timestamp: "1700001002",
        nonce: "n2",
        payload: {
          msgtype: "stream",
          msgid: "m-refresh-1",
          chattype: "single",
          from: { userid: "alice" },
          stream: { id: streamId },
        },
      });
      const refreshRes = createResponseRecorder();

      const handledRefresh = await handleWecomWebhookRequest(refreshReq, refreshRes.res);
      expect(handledRefresh).toBe(true);

      const refreshEncrypted = JSON.parse(refreshRes.getBody()) as { encrypt: string };
      const refreshPlain = decryptWecomEncrypted({
        encodingAESKey,
        receiveId,
        encrypt: refreshEncrypted.encrypt,
      });
      const refreshPayload = JSON.parse(refreshPlain) as {
        msgtype?: string;
        stream?: { content?: string };
      };
      expect(refreshPayload.msgtype).toBe("stream");
      expect(String(refreshPayload.stream?.content ?? "")).toContain(
        "[下载文件](https://cdn.example.com/report.pdf)"
      );
    } finally {
      releaseDispatch?.();
      unregister();
    }
  });
});

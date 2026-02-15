import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { decryptWecomEncrypted, encryptWecomPlaintext, computeWecomMsgSignature } from "./crypto.js";
import { handleWecomWebhookRequest, registerWecomWebhookTarget } from "./monitor.js";
import type { ResolvedWecomAccount } from "./types.js";

const token = "token123";
const encodingAESKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const receiveId = "corp123";

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
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    end: (data?: string | Buffer) => {
      if (data === undefined) return;
      chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    },
  } as unknown as ServerResponse;

  return {
    res,
    headers,
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

describe("wecom webhook", () => {
  it("handles GET verification", async () => {
    const account = buildAccount();
    const unregister = registerWecomWebhookTarget({
      account,
      config: { channels: { wecom: {} } },
      runtime: {},
      path: "/wecom",
    });

    const plaintext = "hello";
    const echostr = encryptWecomPlaintext({
      encodingAESKey,
      receiveId,
      plaintext,
    });

    const timestamp = "1700000000";
    const nonce = "nonce";
    const signature = computeWecomMsgSignature({
      token,
      timestamp,
      nonce,
      encrypt: echostr,
    });

    const params = new URLSearchParams({
      timestamp,
      nonce,
      msg_signature: signature,
      echostr,
    });

    const req = createRequest("GET", `/wecom?${params.toString()}`);
    const recorder = createResponseRecorder();

    const handled = await handleWecomWebhookRequest(req, recorder.res);

    expect(handled).toBe(true);
    expect(recorder.getBody()).toBe(plaintext);

    unregister();
  });

  it("handles POST and returns stream placeholder", async () => {
    const account = buildAccount();
    const unregister = registerWecomWebhookTarget({
      account,
      config: { channels: { wecom: {} } },
      runtime: {},
      path: "/wecom",
    });

    const message = {
      msgtype: "text",
      msgid: "m1",
      chattype: "single",
      from: { userid: "user1" },
      text: { content: "hi" },
    };
    const plain = JSON.stringify(message);
    const encrypt = encryptWecomPlaintext({
      encodingAESKey,
      receiveId,
      plaintext: plain,
    });

    const timestamp = "1700000001";
    const nonce = "nonce2";
    const signature = computeWecomMsgSignature({
      token,
      timestamp,
      nonce,
      encrypt,
    });

    const params = new URLSearchParams({
      timestamp,
      nonce,
      msg_signature: signature,
    });

    const req = createRequest("POST", `/wecom?${params.toString()}`, JSON.stringify({ encrypt }));
    const recorder = createResponseRecorder();

    const handled = await handleWecomWebhookRequest(req, recorder.res);
    expect(handled).toBe(true);

    const encryptedReply = JSON.parse(recorder.getBody()) as { encrypt: string };
    const decryptedReply = decryptWecomEncrypted({
      encodingAESKey,
      receiveId,
      encrypt: encryptedReply.encrypt,
    });
    const replyPayload = JSON.parse(decryptedReply) as { msgtype?: string; stream?: { content?: string } };

    expect(replyPayload.msgtype).toBe("stream");
    expect(replyPayload.stream?.content).toBe("稍等~");

    unregister();
  });
});

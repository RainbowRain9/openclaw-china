import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearOutboundReplyState } from "./outbound-reply.js";

vi.mock("./monitor.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor.js")>("./monitor.js");
  return {
    ...actual,
    appendWecomActiveStreamChunk: vi.fn(),
  };
});

import { wecomPlugin } from "./channel.js";
import { appendWecomActiveStreamChunk } from "./monitor.js";

const cfg = {
  channels: {
    wecom: {
      enabled: true,
      token: "token-1",
      encodingAESKey: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    },
  },
};

describe("wecom outbound stream fallback", () => {
  beforeEach(() => {
    clearOutboundReplyState();
    vi.restoreAllMocks();
    vi.mocked(appendWecomActiveStreamChunk).mockReset();
  });

  it("sendText appends chunk to active stream when response_url is unavailable", async () => {
    vi.mocked(appendWecomActiveStreamChunk).mockReturnValue(true);
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await wecomPlugin.outbound.sendText({
      cfg,
      to: "user:alice",
      text: "hello from stream",
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toContain("stream:");
    expect(appendWecomActiveStreamChunk).toHaveBeenCalledWith({
      accountId: "default",
      to: "user:alice",
      chunk: "hello from stream",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sendMedia appends markdown chunk to active stream when response_url is unavailable", async () => {
    vi.mocked(appendWecomActiveStreamChunk).mockReturnValue(true);
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await wecomPlugin.outbound.sendMedia({
      cfg,
      to: "user:alice",
      mediaUrl: "https://cdn.example.com/report.pdf",
      mimeType: "application/pdf",
      text: "请查看附件",
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toContain("stream:");
    expect(appendWecomActiveStreamChunk).toHaveBeenCalledWith({
      accountId: "default",
      to: "user:alice",
      chunk: expect.stringContaining("[下载文件](https://cdn.example.com/report.pdf)"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

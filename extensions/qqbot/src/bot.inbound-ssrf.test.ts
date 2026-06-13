import { describe, expect, it, vi } from "vitest";

// Design doc §4.5 (P0-B) + §12.2: inbound SSRF wiring — an internal-IP
// attachment URL must NOT trigger a download (guard called before fetch).

const sharedMocks = vi.hoisted(() => ({
  downloadToTempFile: vi.fn(),
  fetchMediaFromUrl: vi.fn(),
  transcribeTencentFlash: vi.fn(),
}));

vi.mock("@openclaw-china/shared", async () => {
  const actual = await vi.importActual<typeof import("@openclaw-china/shared")>(
    "@openclaw-china/shared"
  );
  return {
    ...actual,
    downloadToTempFile: sharedMocks.downloadToTempFile,
    fetchMediaFromUrl: sharedMocks.fetchMediaFromUrl,
    transcribeTencentFlash: sharedMocks.transcribeTencentFlash,
  };
});

import type { Logger } from "@openclaw-china/shared";
import { resolveInboundAttachmentsForAgent } from "./bot.js";
import type { QQBotAccountConfig, QQInboundAttachment } from "./types.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

const baseCfg = {
  asr: { enabled: false },
  mediaTimeoutMs: 30000,
  maxFileSizeMB: 100,
} as unknown as QQBotAccountConfig;

describe("resolveInboundAttachmentsForAgent SSRF guard", () => {
  it("skips downloading an image attachment whose URL is a cloud-metadata IP", async () => {
    sharedMocks.downloadToTempFile.mockReset();
    const logger = createLogger();

    const attachment: QQInboundAttachment = {
      url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      filename: "evidence.png",
      contentType: "image/png",
    };

    const result = await resolveInboundAttachmentsForAgent({
      attachments: [attachment],
      qqCfg: baseCfg,
      logger,
    });

    expect(sharedMocks.downloadToTempFile).not.toHaveBeenCalled();
    expect(result.attachments[0].localImagePath).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("still downloads a public-URL image attachment", async () => {
    sharedMocks.downloadToTempFile.mockReset();
    sharedMocks.downloadToTempFile.mockResolvedValue({ path: "/tmp/cached.png" });
    const logger = createLogger();

    const attachment: QQInboundAttachment = {
      url: "https://93.184.216.34/photo.png",
      filename: "photo.png",
      contentType: "image/png",
    };

    await resolveInboundAttachmentsForAgent({
      attachments: [attachment],
      qqCfg: baseCfg,
      logger,
    });

    expect(sharedMocks.downloadToTempFile).toHaveBeenCalledTimes(1);
  });

  it("skips voice ASR fetch when the attachment URL is internal", async () => {
    sharedMocks.fetchMediaFromUrl.mockReset();
    sharedMocks.transcribeTencentFlash.mockReset();
    const logger = createLogger();

    const cfg = {
      asr: { enabled: true, appId: "a", secretId: "s", secretKey: "k" },
      mediaTimeoutMs: 30000,
      maxFileSizeMB: 100,
    } as unknown as QQBotAccountConfig;

    const attachment: QQInboundAttachment = {
      url: "http://10.0.0.5/voice.silk",
      filename: "voice.silk",
      contentType: "audio/silk",
    };

    const result = await resolveInboundAttachmentsForAgent({
      attachments: [attachment],
      qqCfg: cfg,
      logger,
    });

    expect(sharedMocks.fetchMediaFromUrl).not.toHaveBeenCalled();
    expect(sharedMocks.transcribeTencentFlash).not.toHaveBeenCalled();
    expect(result.hasVoiceTranscript).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});

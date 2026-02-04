/**
 * Integration Tests for DingTalk Media Message Flow
 * 
 * Feature: dingtalk-media-receive
 * Validates: Requirements 9.1, 9.2, 9.4, 4.2
 * 
 * These tests verify the complete flow from raw message to InboundContext
 * with proper media field assignment and error recovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractFileFromMessage,
  parseRichTextMessage,
  downloadRichTextImages,
  cleanupFile,
  type DownloadedFile,
  type ExtractedFileInfo,
} from "./media.js";
import {
  buildInboundContext,
  buildFileContextMessage,
  type InboundContext,
} from "./bot.js";
import type { DingtalkMessageContext, DingtalkRawMessage } from "./types.js";

/**
 * Helper function to simulate media field assignment logic from handleDingtalkMessage.
 * 
 * NOTE: This is a simplified version for testing purposes. The actual implementation
 * in bot.ts has additional logic for:
 * - Text-only richText messages (sets Body from textParts when imageCodes is empty)
 * - Determining mediaBody based on textParts vs image count
 * 
 * This helper focuses on testing the media field assignment after download completes.
 */
function assignMediaFieldsToContext(
  inboundCtx: InboundContext,
  downloadedMedia: DownloadedFile | null,
  extractedFileInfo: ExtractedFileInfo | null,
  downloadedRichTextImages: DownloadedFile[],
  mediaBody: string | null,
  richTextParseResult?: { textParts: string[]; imageCodes: string[]; mentions: string[] } | null,
  audioRecognition?: string | null
): InboundContext {
  const ctx = { ...inboundCtx };

  if (downloadedMedia) {
    ctx.MediaPath = downloadedMedia.path;
    ctx.MediaType = downloadedMedia.contentType;

    if (mediaBody) {
      ctx.Body = mediaBody;
      ctx.RawBody = mediaBody;
      ctx.CommandBody = mediaBody;
    }

    if (extractedFileInfo?.msgType === "file") {
      if (extractedFileInfo.fileName) {
        ctx.FileName = extractedFileInfo.fileName;
      }
      if (extractedFileInfo.fileSize !== undefined) {
        ctx.FileSize = extractedFileInfo.fileSize;
      }
    }

    if (extractedFileInfo?.msgType === "audio" && extractedFileInfo.recognition) {
      ctx.Transcript = extractedFileInfo.recognition;
    }
  }

  if (audioRecognition && !ctx.Transcript) {
    ctx.Transcript = audioRecognition;
  }

  if (downloadedRichTextImages.length > 0) {
    ctx.MediaPaths = downloadedRichTextImages.map(f => f.path);
    ctx.MediaTypes = downloadedRichTextImages.map(f => f.contentType);

    if (mediaBody) {
      ctx.Body = mediaBody;
      ctx.RawBody = mediaBody;
      ctx.CommandBody = mediaBody;
    }
  } else if (richTextParseResult && richTextParseResult.textParts.length > 0) {
    // Text-only richText path: set Body from textParts when no images downloaded
    const textBody = richTextParseResult.textParts.join("\n");
    ctx.Body = textBody;
    ctx.RawBody = textBody;
    ctx.CommandBody = textBody;
  }

  return ctx;
}

/**
 * Helper to create a base message context for testing
 */
function createBaseMessageContext(overrides?: Partial<DingtalkMessageContext>): DingtalkMessageContext {
  return {
    conversationId: "conv-123",
    messageId: "msg-456",
    senderId: "user-789",
    senderNick: "Test User",
    chatType: "direct",
    content: "",
    contentType: "picture",
    mentionedBot: false,
    robotCode: "robot-001",
    ...overrides,
  };
}

describe("Integration: Media Message Flow (Task 10.1)", () => {
  describe("Picture message → download → InboundContext with MediaPath", () => {
    it("should extract file info and set MediaPath/MediaType for picture message", () => {
      // Arrange: Raw picture message from DingTalk
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "picture",
        content: {
          downloadCode: "pic-download-code-789",
        },
        robotCode: "robot-001",
      };

      // Act: Extract file info (simulating first step of handleDingtalkMessage)
      const extractedFileInfo = extractFileFromMessage(rawMessage);

      // Assert: File info extracted correctly (Requirement 9.1)
      expect(extractedFileInfo).not.toBeNull();
      expect(extractedFileInfo?.downloadCode).toBe("pic-download-code-789");
      expect(extractedFileInfo?.msgType).toBe("picture");

      // Simulate successful download
      const downloadedMedia: DownloadedFile = {
        path: "/tmp/dingtalk-file-123456.jpg",
        contentType: "image/jpeg",
        size: 102400,
        fileName: undefined,
      };

      // Build base context
      const baseCtx = createBaseMessageContext({ contentType: "picture" });
      const inboundCtx = buildInboundContext(baseCtx, "session-key", "account-id");

      // Build media body
      const mediaBody = buildFileContextMessage("picture");
      // Check it's a picture message format
      expect(mediaBody).toMatch(/^\[.+\]$/);
      expect(mediaBody.length).toBeGreaterThan(2);

      // Assign media fields (simulating handleDingtalkMessage logic)
      const finalCtx = assignMediaFieldsToContext(
        inboundCtx,
        downloadedMedia,
        extractedFileInfo,
        [],
        mediaBody
      );

      // Assert: InboundContext has correct media fields (Requirement 9.2)
      expect(finalCtx.MediaPath).toBe("/tmp/dingtalk-file-123456.jpg");
      expect(finalCtx.MediaType).toBe("image/jpeg");
      // Body should be set to media description
      expect(finalCtx.Body).toMatch(/^\[.+\]$/);
    });

    it("should use pictureDownloadCode fallback for picture message", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "picture",
        content: {
          pictureDownloadCode: "pic-fallback-code-999",
        },
        robotCode: "robot-001",
      };

      const extractedFileInfo = extractFileFromMessage(rawMessage);

      expect(extractedFileInfo).not.toBeNull();
      expect(extractedFileInfo?.downloadCode).toBe("pic-fallback-code-999");
      expect(extractedFileInfo?.msgType).toBe("picture");
    });
  });

  describe("File message → download → InboundContext with FileName/FileSize", () => {
    it("should extract file info and set FileName/FileSize for file message", () => {
      // Arrange: Raw file message from DingTalk
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "file",
        content: {
          downloadCode: "file-download-code-111",
          fileName: "report.pdf",
          fileSize: 2048000,
        },
        robotCode: "robot-001",
      };

      // Act: Extract file info
      const extractedFileInfo = extractFileFromMessage(rawMessage);

      // Assert: File info extracted correctly with fileName and fileSize
      expect(extractedFileInfo).not.toBeNull();
      expect(extractedFileInfo?.downloadCode).toBe("file-download-code-111");
      expect(extractedFileInfo?.msgType).toBe("file");
      expect(extractedFileInfo?.fileName).toBe("report.pdf");
      expect(extractedFileInfo?.fileSize).toBe(2048000);

      // Simulate successful download
      const downloadedMedia: DownloadedFile = {
        path: "/tmp/dingtalk-file-222333.pdf",
        contentType: "application/pdf",
        size: 2048000,
        fileName: "report.pdf",
      };

      // Build base context
      const baseCtx = createBaseMessageContext({ contentType: "file" });
      const inboundCtx = buildInboundContext(baseCtx, "session-key", "account-id");

      // Build media body
      const mediaBody = buildFileContextMessage("file", "report.pdf");
      // Check it contains the filename
      expect(mediaBody).toContain("report.pdf");
      expect(mediaBody).toMatch(/^\[.+: report\.pdf\]$/);

      // Assign media fields
      const finalCtx = assignMediaFieldsToContext(
        inboundCtx,
        downloadedMedia,
        extractedFileInfo,
        [],
        mediaBody
      );

      // Assert: InboundContext has correct file fields (Requirements 7.5, 7.6)
      expect(finalCtx.MediaPath).toBe("/tmp/dingtalk-file-222333.pdf");
      expect(finalCtx.MediaType).toBe("application/pdf");
      expect(finalCtx.FileName).toBe("report.pdf");
      expect(finalCtx.FileSize).toBe(2048000);
      // Body should contain the filename
      expect(finalCtx.Body).toContain("report.pdf");
    });

    it("should handle archive file with correct body message", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "file",
        content: {
          downloadCode: "file-download-code-222",
          fileName: "backup.zip",
          fileSize: 5120000,
        },
        robotCode: "robot-001",
      };

      const extractedFileInfo = extractFileFromMessage(rawMessage);
      expect(extractedFileInfo?.fileName).toBe("backup.zip");

      const mediaBody = buildFileContextMessage("file", "backup.zip");
      // Check that it contains the filename and is wrapped in brackets
      expect(mediaBody).toContain("backup.zip");
      expect(mediaBody.startsWith("[")).toBe(true);
      expect(mediaBody.endsWith("]")).toBe(true);
    });

    it("should handle code file with correct body message", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "file",
        content: {
          downloadCode: "file-download-code-333",
          fileName: "script.py",
          fileSize: 1024,
        },
        robotCode: "robot-001",
      };

      const extractedFileInfo = extractFileFromMessage(rawMessage);
      expect(extractedFileInfo?.fileName).toBe("script.py");

      const mediaBody = buildFileContextMessage("file", "script.py");
      // Check that it contains the filename and is a code file type message
      expect(mediaBody).toContain("script.py");
      expect(mediaBody).toMatch(/^\[.+: script\.py\]$/);
    });
  });

  describe("Audio message handling", () => {
    it("should treat audio with recognition as text and skip media fields", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "audio",
        content: {
          downloadCode: "audio-download-code-444",
          duration: 5000,
          recognition: "Hello, this is a voice message",
        },
        robotCode: "robot-001",
      };

      const extractedFileInfo = extractFileFromMessage(rawMessage);

      expect(extractedFileInfo).not.toBeNull();
      expect(extractedFileInfo?.downloadCode).toBe("audio-download-code-444");
      expect(extractedFileInfo?.msgType).toBe("audio");
      expect(extractedFileInfo?.duration).toBe(5000);
      expect(extractedFileInfo?.recognition).toBe("Hello, this is a voice message");

      const baseCtx = createBaseMessageContext({
        contentType: "audio",
        content: "Hello, this is a voice message",
      });
      const inboundCtx = buildInboundContext(baseCtx, "session-key", "account-id");

      const finalCtx = assignMediaFieldsToContext(
        inboundCtx,
        null,
        null,
        [],
        null,
        null,
        "Hello, this is a voice message"
      );

      expect(finalCtx.Body).toBe("Hello, this is a voice message");
      expect(finalCtx.MediaPath).toBeUndefined();
      expect(finalCtx.MediaType).toBeUndefined();
      expect(finalCtx.Transcript).toBe("Hello, this is a voice message");
    });

    it("should treat audio without recognition as a file message", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "audio",
        content: {
          downloadCode: "audio-download-code-445",
          duration: 5000,
        },
        robotCode: "robot-001",
      };

      const extractedFileInfo = extractFileFromMessage(rawMessage);

      expect(extractedFileInfo).not.toBeNull();
      expect(extractedFileInfo?.downloadCode).toBe("audio-download-code-445");
      expect(extractedFileInfo?.msgType).toBe("audio");
      expect(extractedFileInfo?.duration).toBe(5000);
      expect(extractedFileInfo?.recognition).toBeUndefined();

      const downloadedMedia: DownloadedFile = {
        path: "/tmp/dingtalk-file-444556.amr",
        contentType: "audio/amr",
        size: 51200,
      };

      const baseCtx = createBaseMessageContext({ contentType: "audio", content: "" });
      const inboundCtx = buildInboundContext(baseCtx, "session-key", "account-id");

      const mediaBody = buildFileContextMessage("audio");
      expect(mediaBody).toMatch(/^\[.+\]$/);
      expect(mediaBody.length).toBeGreaterThan(2);

      const finalCtx = assignMediaFieldsToContext(
        inboundCtx,
        downloadedMedia,
        extractedFileInfo,
        [],
        mediaBody
      );

      expect(finalCtx.MediaPath).toBe("/tmp/dingtalk-file-444556.amr");
      expect(finalCtx.MediaType).toBe("audio/amr");
      expect(finalCtx.Transcript).toBeUndefined();
      expect(finalCtx.Body).toMatch(/^\[.+\]$/);
    });
  });

  describe("Video message → download → InboundContext", () => {
    it("should extract video info with duration", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "video",
        content: {
          downloadCode: "video-download-code-555",
          duration: 30000,
        },
        robotCode: "robot-001",
      };

      const extractedFileInfo = extractFileFromMessage(rawMessage);

      expect(extractedFileInfo).not.toBeNull();
      expect(extractedFileInfo?.downloadCode).toBe("video-download-code-555");
      expect(extractedFileInfo?.msgType).toBe("video");
      expect(extractedFileInfo?.duration).toBe(30000);

      const mediaBody = buildFileContextMessage("video");
      // Check it's a video message format
      expect(mediaBody).toMatch(/^\[.+\]$/);
      expect(mediaBody.length).toBeGreaterThan(2);
    });

    it("should use videoDownloadCode fallback for video message", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "video",
        content: {
          videoDownloadCode: "video-fallback-code-666",
        },
        robotCode: "robot-001",
      };

      const extractedFileInfo = extractFileFromMessage(rawMessage);

      expect(extractedFileInfo).not.toBeNull();
      expect(extractedFileInfo?.downloadCode).toBe("video-fallback-code-666");
    });
  });

  describe("JSON string content parsing", () => {
    it("should parse JSON string content for picture message", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "picture",
        content: JSON.stringify({
          downloadCode: "json-pic-code-777",
        }),
        robotCode: "robot-001",
      };

      const extractedFileInfo = extractFileFromMessage(rawMessage);

      expect(extractedFileInfo).not.toBeNull();
      expect(extractedFileInfo?.downloadCode).toBe("json-pic-code-777");
    });

    it("should parse JSON string content for file message", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "file",
        content: JSON.stringify({
          downloadCode: "json-file-code-888",
          fileName: "data.json",
          fileSize: 512,
        }),
        robotCode: "robot-001",
      };

      const extractedFileInfo = extractFileFromMessage(rawMessage);

      expect(extractedFileInfo).not.toBeNull();
      expect(extractedFileInfo?.downloadCode).toBe("json-file-code-888");
      expect(extractedFileInfo?.fileName).toBe("data.json");
      expect(extractedFileInfo?.fileSize).toBe(512);
    });
  });
});

describe("Integration: Error Recovery (Task 10.3)", () => {
  describe("Download failure → graceful degradation to text", () => {
    it("should continue with text content when file extraction returns null", () => {
      // Arrange: Text message (not a media message)
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "text",
        text: { content: "Hello, world!" },
        robotCode: "robot-001",
      };

      // Act: Try to extract file info
      const extractedFileInfo = extractFileFromMessage(rawMessage);

      // Assert: Returns null for non-media message
      expect(extractedFileInfo).toBeNull();

      // Build context without media fields (graceful degradation)
      const baseCtx = createBaseMessageContext({
        content: "Hello, world!",
        contentType: "text",
      });
      const inboundCtx = buildInboundContext(baseCtx, "session-key", "account-id");

      // No media fields should be set
      expect(inboundCtx.MediaPath).toBeUndefined();
      expect(inboundCtx.MediaType).toBeUndefined();
      expect(inboundCtx.Body).toBe("Hello, world!");
    });

    it("should handle missing downloadCode gracefully", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "picture",
        content: {
          // No downloadCode or pictureDownloadCode
        },
        robotCode: "robot-001",
      };

      const extractedFileInfo = extractFileFromMessage(rawMessage);

      // Should return null when downloadCode is missing
      expect(extractedFileInfo).toBeNull();
    });

    it("should handle invalid content gracefully", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "picture",
        content: "invalid-json-{{{",
        robotCode: "robot-001",
      };

      const extractedFileInfo = extractFileFromMessage(rawMessage);

      // Should return null for invalid JSON
      expect(extractedFileInfo).toBeNull();
    });

    it("should simulate graceful degradation flow when download fails", () => {
      // Arrange: Valid picture message
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "picture",
        content: {
          downloadCode: "pic-code-999",
        },
        robotCode: "robot-001",
      };

      // Extract file info successfully
      const extractedFileInfo = extractFileFromMessage(rawMessage);
      expect(extractedFileInfo).not.toBeNull();

      // Simulate download failure (downloadedMedia = null)
      const downloadedMedia: DownloadedFile | null = null;

      // Build context without media (graceful degradation - Requirement 9.4)
      const baseCtx = createBaseMessageContext({
        content: "", // Original text content
        contentType: "picture",
      });
      const inboundCtx = buildInboundContext(baseCtx, "session-key", "account-id");

      // When download fails, don't assign media fields
      const finalCtx = assignMediaFieldsToContext(
        inboundCtx,
        downloadedMedia,
        extractedFileInfo,
        [],
        null
      );

      // Assert: No media fields set (graceful degradation)
      expect(finalCtx.MediaPath).toBeUndefined();
      expect(finalCtx.MediaType).toBeUndefined();
    });
  });

  describe("Partial richText download failure → continue with successful images", () => {
    it("should parse richText with multiple images", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "richText",
        content: {
          richText: [
            { type: "text", text: "Check out these images:" },
            { type: "picture", downloadCode: "img-code-1" },
            { type: "picture", downloadCode: "img-code-2" },
            { type: "picture", downloadCode: "img-code-3" },
          ],
        },
        robotCode: "robot-001",
      };

      const result = parseRichTextMessage(rawMessage);

      expect(result).not.toBeNull();
      expect(result?.textParts).toEqual(["Check out these images:"]);
      expect(result?.imageCodes).toEqual(["img-code-1", "img-code-2", "img-code-3"]);
    });

    it("should handle text-only richText without media download", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "richText",
        content: {
          richText: [
            { type: "text", text: "Hello" },
            { type: "text", text: "World" },
          ],
        },
        robotCode: "robot-001",
      };

      const result = parseRichTextMessage(rawMessage);

      expect(result).not.toBeNull();
      expect(result?.textParts).toEqual(["Hello", "World"]);
      expect(result?.imageCodes).toEqual([]); // No images

      // When imageCodes is empty, skip media download (Requirement 3.6)
      const baseCtx = createBaseMessageContext({
        content: result?.textParts.join("\n") ?? "",
        contentType: "richText",
      });
      const inboundCtx = buildInboundContext(baseCtx, "session-key", "account-id");

      // No media fields should be set for text-only richText
      expect(inboundCtx.MediaPath).toBeUndefined();
      expect(inboundCtx.MediaPaths).toBeUndefined();
      expect(inboundCtx.Body).toBe("Hello\nWorld");
    });

    it("should simulate partial download success for richText images", () => {
      // Arrange: richText with text and 3 images
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "richText",
        content: {
          richText: [
            { type: "text", text: "Images:" },
            { type: "picture", downloadCode: "img-code-1" },
            { type: "picture", downloadCode: "img-code-2" },
            { type: "picture", downloadCode: "img-code-3" },
          ],
        },
        robotCode: "robot-001",
      };

      const result = parseRichTextMessage(rawMessage);
      expect(result?.imageCodes.length).toBe(3);
      expect(result?.textParts).toEqual(["Images:"]);

      // Simulate partial download success (2 out of 3 succeeded)
      const downloadedRichTextImages: DownloadedFile[] = [
        { path: "/tmp/img-1.jpg", contentType: "image/jpeg", size: 1024 },
        // img-2 failed
        { path: "/tmp/img-3.jpg", contentType: "image/jpeg", size: 2048 },
      ];

      const baseCtx = createBaseMessageContext({ contentType: "richText" });
      const inboundCtx = buildInboundContext(baseCtx, "session-key", "account-id");

      // In actual implementation, when textParts exist, Body is set to text content
      // The mediaBody is determined by: textParts.length > 0 ? textParts.join("\n") : image count description
      const mediaBody = result?.textParts.join("\n") ?? "";

      const finalCtx = assignMediaFieldsToContext(
        inboundCtx,
        null,
        null,
        downloadedRichTextImages,
        mediaBody,
        result
      );

      // Assert: Only successful downloads are in MediaPaths (Requirement 4.2)
      expect(finalCtx.MediaPaths).toEqual(["/tmp/img-1.jpg", "/tmp/img-3.jpg"]);
      expect(finalCtx.MediaTypes).toEqual(["image/jpeg", "image/jpeg"]);
      expect(finalCtx.MediaPaths?.length).toBe(2); // Only 2 succeeded
      // Body should be the text content, not image count (matching actual implementation)
      expect(finalCtx.Body).toBe("Images:");
    });

    it("should use image count description when richText has no text", () => {
      // Arrange: richText with only images, no text
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "richText",
        content: {
          richText: [
            { type: "picture", downloadCode: "img-code-1" },
            { type: "picture", downloadCode: "img-code-2" },
          ],
        },
        robotCode: "robot-001",
      };

      const result = parseRichTextMessage(rawMessage);
      expect(result?.imageCodes.length).toBe(2);
      expect(result?.textParts).toEqual([]); // No text

      // Simulate successful downloads
      const downloadedRichTextImages: DownloadedFile[] = [
        { path: "/tmp/img-1.jpg", contentType: "image/jpeg", size: 1024 },
        { path: "/tmp/img-2.jpg", contentType: "image/jpeg", size: 2048 },
      ];

      const baseCtx = createBaseMessageContext({ contentType: "richText" });
      const inboundCtx = buildInboundContext(baseCtx, "session-key", "account-id");

      // When no text, use image count description
      const mediaBody = downloadedRichTextImages.length === 1 
        ? "[图片]" 
        : `[${downloadedRichTextImages.length}张图片]`;

      const finalCtx = assignMediaFieldsToContext(
        inboundCtx,
        null,
        null,
        downloadedRichTextImages,
        mediaBody,
        result
      );

      expect(finalCtx.MediaPaths?.length).toBe(2);
      // Body should be image count description when no text
      expect(finalCtx.Body).toContain("2");
    });

    it("should handle all richText image downloads failing", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "1",
        conversationId: "conv-456",
        msgtype: "richText",
        content: {
          richText: [
            { type: "text", text: "Failed images:" },
            { type: "picture", downloadCode: "img-code-1" },
            { type: "picture", downloadCode: "img-code-2" },
          ],
        },
        robotCode: "robot-001",
      };

      const result = parseRichTextMessage(rawMessage);
      expect(result?.imageCodes.length).toBe(2);

      // Simulate all downloads failing
      const downloadedRichTextImages: DownloadedFile[] = [];

      const baseCtx = createBaseMessageContext({ contentType: "richText" });
      const inboundCtx = buildInboundContext(baseCtx, "session-key", "account-id");

      // When all downloads fail but text exists, Body should be set to text
      const finalCtx = assignMediaFieldsToContext(
        inboundCtx,
        null,
        null,
        downloadedRichTextImages,
        null,
        result
      );

      // Assert: No media fields set when all downloads fail
      expect(finalCtx.MediaPaths).toBeUndefined();
      expect(finalCtx.MediaTypes).toBeUndefined();
      // But Body should still have the text content
      expect(finalCtx.Body).toBe("Failed images:");
    });
  });

  describe("RichText with mentions", () => {
    it("should extract mentions from richText", () => {
      const rawMessage: DingtalkRawMessage = {
        senderId: "user-123",
        senderNick: "Test User",
        conversationType: "2",
        conversationId: "conv-456",
        msgtype: "richText",
        content: {
          richText: [
            { type: "at", userId: "mentioned-user-1" },
            { type: "text", text: "Hello" },
            { type: "at", userId: "mentioned-user-2" },
          ],
        },
        robotCode: "robot-001",
      };

      const result = parseRichTextMessage(rawMessage);

      expect(result).not.toBeNull();
      expect(result?.mentions).toEqual(["mentioned-user-1", "mentioned-user-2"]);
      expect(result?.textParts).toEqual(["Hello"]);
    });
  });
});

describe("Integration: File cleanup", () => {
  it("should handle cleanup of non-existent file gracefully", async () => {
    // cleanupFile should not throw for non-existent files
    await expect(cleanupFile("/tmp/non-existent-file-12345.jpg")).resolves.toBeUndefined();
  });

  it("should handle cleanup with undefined path", async () => {
    await expect(cleanupFile(undefined)).resolves.toBeUndefined();
  });
});

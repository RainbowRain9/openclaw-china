import { describe, expect, it } from "vitest";

import {
  getUtf8ByteLength,
  splitTextByByteLimit,
  truncateTextByByteLimit,
  WECHAT_TEXT_BYTE_LIMIT,
} from "./text.js";

describe("wechat-mp text utils", () => {
  describe("getUtf8ByteLength", () => {
    it("calculates ASCII byte length", () => {
      expect(getUtf8ByteLength("hello")).toBe(5);
      expect(getUtf8ByteLength("12345")).toBe(5);
    });

    it("calculates Chinese character byte length (3 bytes per char)", () => {
      expect(getUtf8ByteLength("你好")).toBe(6); // 2 chars * 3 bytes
      expect(getUtf8ByteLength("测试")).toBe(6);
    });

    it("calculates mixed content byte length", () => {
      expect(getUtf8ByteLength("hello你好")).toBe(11); // 5 + 6
      expect(getUtf8ByteLength("abc测试123")).toBe(12); // 3 + 6 + 3
    });

    it("handles empty string", () => {
      expect(getUtf8ByteLength("")).toBe(0);
    });
  });

  describe("splitTextByByteLimit", () => {
    it("returns single chunk when within limit", () => {
      const text = "a".repeat(100);
      const chunks = splitTextByByteLimit(text, 200);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it("splits at exact byte limit boundary", () => {
      const text = "a".repeat(3000);
      const chunks = splitTextByByteLimit(text, 1000);
      expect(chunks.length).toBeGreaterThan(1);

      // Each chunk should be within limit
      for (const chunk of chunks) {
        expect(getUtf8ByteLength(chunk)).toBeLessThanOrEqual(1000);
      }
    });

    it("splits at paragraph boundary (\\n\\n)", () => {
      const part1 = "a".repeat(500);
      const part2 = "b".repeat(500);
      const text = `${part1}\n\n${part2}`;
      const chunks = splitTextByByteLimit(text, 600);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0]).toContain(part1);
      expect(chunks[1]).toContain(part2);
    });

    it("splits at horizontal rule (---)", () => {
      const part1 = "a".repeat(500);
      const part2 = "b".repeat(500);
      const text = `${part1}\n---\n${part2}`;
      const chunks = splitTextByByteLimit(text, 600);

      expect(chunks.length).toBeGreaterThan(1);
    });

    it("splits at Chinese sentence boundary", () => {
      const part1 = "中".repeat(300); // 900 bytes
      const part2 = "文".repeat(300); // 900 bytes
      const text = `${part1}。${part2}`;
      const chunks = splitTextByByteLimit(text, 1000);

      expect(chunks.length).toBeGreaterThan(1);
    });

    it("does not truncate multi-byte characters", () => {
      // Create text that would be exactly at boundary
      const chinese = "你".repeat(683); // 2049 bytes, slightly over limit
      const chunks = splitTextByByteLimit(chinese, WECHAT_TEXT_BYTE_LIMIT);

      // Verify no characters are corrupted
      const rejoined = chunks.join("");
      expect(rejoined).toBe(chinese);
    });

    it("handles mixed ASCII and Chinese content", () => {
      const part1 = "hello " + "中".repeat(300);
      const part2 = "world " + "文".repeat(300);
      const text = `${part1}\n\n${part2}`;
      const chunks = splitTextByByteLimit(text, 1000);

      // Each chunk should be within limit
      for (const chunk of chunks) {
        expect(getUtf8ByteLength(chunk)).toBeLessThanOrEqual(1000);
      }
    });

    it("splits very long text into multiple chunks", () => {
      const text = "a".repeat(10000);
      const chunks = splitTextByByteLimit(text, WECHAT_TEXT_BYTE_LIMIT);

      expect(chunks.length).toBeGreaterThan(4);

      // Verify all content is preserved
      expect(chunks.join("")).toBe(text);
    });

    it("handles text with multiple paragraph breaks", () => {
      const paragraphs = [
        "First paragraph with some content here.",
        "Second paragraph with more content here.",
        "Third paragraph with even more content here.",
      ];
      const text = paragraphs.join("\n\n");
      const chunks = splitTextByByteLimit(text, 50);

      // Should split into multiple chunks at boundaries
      expect(chunks.length).toBeGreaterThanOrEqual(3);

      // Verify content preserved
      const rejoined = chunks.join(" ");
      expect(rejoined).toContain("First paragraph");
      expect(rejoined).toContain("Second paragraph");
      expect(rejoined).toContain("Third paragraph");
    });

    it("handles leading/trailing whitespace in short text", () => {
      const text = "   hello world   ";
      const chunks = splitTextByByteLimit(text, 100);

      // Short text within limit is returned as-is
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe("   hello world   ");
    });
  });

  describe("truncateTextByByteLimit", () => {
    it("returns full text when within limit", () => {
      const text = "hello world";
      const truncated = truncateTextByByteLimit(text, 100);
      expect(truncated).toBe(text);
    });

    it("truncates at exact byte limit boundary", () => {
      const text = "a".repeat(3000);
      const truncated = truncateTextByByteLimit(text, 1000);
      expect(getUtf8ByteLength(truncated)).toBeLessThanOrEqual(1000);
      expect(truncated.length).toBeLessThan(text.length);
    });

    it("truncates at paragraph boundary when possible", () => {
      const part1 = "a".repeat(500);
      const part2 = "b".repeat(500);
      const text = `${part1}\n\n${part2}`;
      const truncated = truncateTextByByteLimit(text, 600);

      expect(truncated).toContain(part1);
      expect(truncated).not.toContain(part2);
    });

    it("truncates at sentence boundary for Chinese text", () => {
      const part1 = "中".repeat(200); // 600 bytes
      const part2 = "文".repeat(200); // 600 bytes
      const text = `${part1}。${part2}`;
      const truncated = truncateTextByByteLimit(text, 700);

      expect(getUtf8ByteLength(truncated)).toBeLessThanOrEqual(700);
      expect(truncated).toContain(part1);
    });

    it("does not truncate multi-byte characters", () => {
      // Create text that would be exactly at boundary
      const chinese = "你".repeat(700); // 2100 bytes
      const truncated = truncateTextByByteLimit(chinese, 1000);

      // Verify no characters are corrupted - all characters should be valid
      expect(() => Buffer.from(truncated, "utf8")).not.toThrow();
      expect(getUtf8ByteLength(truncated)).toBeLessThanOrEqual(1000);
    });

    it("handles empty string", () => {
      const truncated = truncateTextByByteLimit("", 100);
      expect(truncated).toBe("");
    });

    it("handles very small limit", () => {
      const text = "hello world";
      const truncated = truncateTextByByteLimit(text, 5);
      expect(getUtf8ByteLength(truncated)).toBeLessThanOrEqual(5);
    });
  });
});

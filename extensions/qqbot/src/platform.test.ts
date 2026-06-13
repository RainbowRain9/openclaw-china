import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHomeDir, getQQBotDataDir, qqbotDataDirPath } from "./platform.js";

// Design doc §4.2 (P0-E) + §10 Phase-1 DoR #3: fork-local getDataDir helper.
// getQQBotDataDir creates real dirs under ~/.openclaw/qqbot, so tests use a
// throwaway subdirectory and clean it up.
const TEST_SUB = `__platform-test-${process.pid}__`;

function testDirPath(...extra: string[]): string {
  return join(homedir(), ".openclaw", "qqbot", TEST_SUB, ...extra);
}

describe("platform data-dir helpers", () => {
  afterEach(() => {
    const root = join(homedir(), ".openclaw", "qqbot", TEST_SUB);
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("getHomeDir returns a non-empty home path", () => {
    expect(getHomeDir().length).toBeGreaterThan(0);
  });

  it("qqbotDataDirPath resolves under ~/.openclaw/qqbot without touching the filesystem", () => {
    expect(qqbotDataDirPath()).toBe(join(homedir(), ".openclaw", "qqbot"));
    expect(qqbotDataDirPath("data")).toBe(join(homedir(), ".openclaw", "qqbot", "data"));
    expect(existsSync(testDirPath())).toBe(false);
  });

  it("getQQBotDataDir matches the upstream contract consumed by session-store.ts", () => {
    const dir = getQQBotDataDir(TEST_SUB, "sessions");
    expect(dir).toBe(testDirPath("sessions"));
    expect(existsSync(dir)).toBe(true);
  });

  it("getQQBotDataDir creates nested missing directories", () => {
    const dir = getQQBotDataDir(TEST_SUB, "a", "b", "c");
    expect(existsSync(dir)).toBe(true);
  });

  it("getQQBotDataDir is idempotent when the directory already exists", () => {
    getQQBotDataDir(TEST_SUB, "once");
    expect(() => getQQBotDataDir(TEST_SUB, "once")).not.toThrow();
  });
});

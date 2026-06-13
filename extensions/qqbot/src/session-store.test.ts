import { existsSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qqbotDataDirPath } from "./platform.js";
import {
  clearSession,
  loadSession,
  saveSession,
  updateLastSeq,
  type SessionState,
} from "./session-store.js";

// Design doc §4.2 (P0-E): session persistence roundtrip + expiry + appId guard + throttle.

const SESSION_DIR = qqbotDataDirPath("sessions");
const ACCOUNT_ID = `__ss-test-${process.pid}__`;
const APP_ID = "10-test-app-id";

function sessionPath(): string {
  return join(SESSION_DIR, `session-${ACCOUNT_ID}.json`);
}

function freshState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "sess-abc",
    lastSeq: 42,
    lastConnectedAt: Date.now(),
    intentLevelIndex: 0,
    accountId: ACCOUNT_ID,
    savedAt: Date.now(),
    appId: APP_ID,
    ...overrides,
  };
}

function writeRawSession(raw: Record<string, unknown>): void {
  writeFileSync(sessionPath(), JSON.stringify(raw), "utf-8");
}

describe("session-store persistence", () => {
  afterEach(() => {
    clearSession(ACCOUNT_ID);
    if (existsSync(sessionPath())) rmSync(sessionPath(), { force: true });
  });

  it("round-trips a saved session and matches appId", () => {
    saveSession(freshState({ sessionId: "sess-xyz", lastSeq: 7 }));

    const loaded = loadSession(ACCOUNT_ID, APP_ID);
    expect(loaded).not.toBeNull();
    expect(loaded?.sessionId).toBe("sess-xyz");
    expect(loaded?.lastSeq).toBe(7);
    expect(loaded?.appId).toBe(APP_ID);
  });

  it("returns null and deletes a session older than 5 minutes", () => {
    writeRawSession({ ...freshState(), savedAt: Date.now() - 6 * 60 * 1000 });

    const loaded = loadSession(ACCOUNT_ID, APP_ID);
    expect(loaded).toBeNull();
    expect(existsSync(sessionPath())).toBe(false);
  });

  it("returns null and deletes a session whose appId no longer matches", () => {
    saveSession(freshState({ appId: "old-app" }));

    const loaded = loadSession(ACCOUNT_ID, "different-app");
    expect(loaded).toBeNull();
    expect(existsSync(sessionPath())).toBe(false);
  });

  it("returns null when required fields are missing", () => {
    writeRawSession({ ...freshState(), sessionId: null, lastSeq: null });

    expect(loadSession(ACCOUNT_ID, APP_ID)).toBeNull();
  });

  it("clearSession removes the persisted file", () => {
    saveSession(freshState());
    expect(existsSync(sessionPath())).toBe(true);

    clearSession(ACCOUNT_ID);
    expect(existsSync(sessionPath())).toBe(false);
  });
});

describe("session-store save throttle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearSession(ACCOUNT_ID);
  });
  afterEach(() => {
    clearSession(ACCOUNT_ID);
    vi.useRealTimers();
  });

  it("coalesces rapid saves into the latest state", () => {
    // First save lands immediately (throttle cold-start).
    saveSession(freshState({ sessionId: "first", lastSeq: 1 }));
    expect(loadSession(ACCOUNT_ID, APP_ID)?.sessionId).toBe("first");

    // Second save within SAVE_THROTTLE_MS is deferred.
    saveSession(freshState({ sessionId: "second", lastSeq: 2 }));
    expect(loadSession(ACCOUNT_ID, APP_ID)?.sessionId).toBe("first");

    // Flush the deferred throttle timer (> 1s).
    vi.advanceTimersByTime(1100);
    expect(loadSession(ACCOUNT_ID, APP_ID)?.sessionId).toBe("second");
    expect(loadSession(ACCOUNT_ID, APP_ID)?.lastSeq).toBe(2);
  });

  it("updateLastSeq persists a new sequence after the throttle window", () => {
    saveSession(freshState({ lastSeq: 1 }));
    // Let the throttle window pass so the next save lands immediately.
    vi.advanceTimersByTime(1100);
    updateLastSeq(ACCOUNT_ID, 99);

    expect(loadSession(ACCOUNT_ID, APP_ID)?.lastSeq).toBe(99);
  });
});

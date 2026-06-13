// Fork-local platform helpers for resolving the qqbot data directory.
//
// Centralizes the `~/.openclaw/qqbot/...` path convention that was previously
// inlined in ref-index-store.ts / proactive.ts. Mirrors the upstream
// `@tencent-connect/openclaw-qqbot` utils/platform.ts contract so that ported
// modules (e.g. session-store.ts) can import `getQQBotDataDir` verbatim.
//
// Design doc §4.2 (P0-E) + §10 Phase-1 DoR #3.

import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Robust user home directory.
 *
 * Priority: `os.homedir()` → `$HOME` / `%USERPROFILE%` → `os.tmpdir()`.
 * Handles the rare case where `os.homedir()` returns empty on a misconfigured
 * environment.
 */
export function getHomeDir(): string {
  const home = homedir();
  if (home) return home;
  const envHome = process.env.HOME || process.env.USERPROFILE;
  if (envHome) return envHome;
  return tmpdir();
}

/**
 * Absolute path under `~/.openclaw/qqbot` — pure, no filesystem access.
 *
 * Use this for path constants computed at module load (avoids eager directory
 * creation); callers that need the directory to exist should use
 * `getQQBotDataDir` instead.
 */
export function qqbotDataDirPath(...subPaths: string[]): string {
  return join(getHomeDir(), ".openclaw", "qqbot", ...subPaths);
}

/**
 * Absolute path under `~/.openclaw/qqbot`, creating the directory (and any
 * missing parents) if it does not yet exist. Matches the upstream contract
 * consumed by `session-store.ts` (`getQQBotDataDir("sessions")`).
 */
export function getQQBotDataDir(...subPaths: string[]): string {
  const dir = qqbotDataDirPath(...subPaths);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

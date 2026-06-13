import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_ACCOUNT_ID, QQBOT_CHANNEL_ID, type PluginConfig } from "./config.js";
import { qqbotOutbound } from "./outbound.js";
import { qqbotDataDirPath } from "./platform.js";
import type { QQBotSendResult, QQChatType } from "./types.js";

const DEFAULT_KNOWN_TARGETS_PATH = join(qqbotDataDirPath("data"), "known-targets.json");
// Legacy layout (~/.openclaw/data/qqbot) — intentionally different base, kept
// for one-time migration lookup only.
const LEGACY_KNOWN_TARGETS_PATH = join(homedir(), ".openclaw", "data", "qqbot", "known-targets.json");

type KnownQQBotTargetKind = "user" | "group" | "channel";

type KnownQQBotTargetStoreOptions = {
  filePath?: string;
};

export interface KnownQQBotTarget {
  accountId: string;
  kind: KnownQQBotTargetKind;
  target: string;
  displayName?: string;
  sourceChatType: QQChatType;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface ListKnownQQBotTargetsParams extends KnownQQBotTargetStoreOptions {
  accountId?: string;
  kind?: KnownQQBotTargetKind;
  limit?: number;
}

export interface GetKnownQQBotTargetParams extends KnownQQBotTargetStoreOptions {
  accountId?: string;
  target: string;
}

export interface RemoveKnownQQBotTargetParams extends KnownQQBotTargetStoreOptions {
  accountId?: string;
  target: string;
}

export interface ClearKnownQQBotTargetsParams extends KnownQQBotTargetStoreOptions {
  accountId?: string;
  kind?: KnownQQBotTargetKind;
}

type UpsertKnownQQBotTargetParams = KnownQQBotTargetStoreOptions & {
  target: KnownQQBotTarget;
};

function resolveKnownTargetsFilePath(options?: KnownQQBotTargetStoreOptions): string {
  return options?.filePath?.trim() || DEFAULT_KNOWN_TARGETS_PATH;
}

function ensureKnownTargetsDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function migrateLegacyKnownTargets(filePath: string): void {
  if (filePath !== DEFAULT_KNOWN_TARGETS_PATH) {
    return;
  }
  if (existsSync(filePath) || !existsSync(LEGACY_KNOWN_TARGETS_PATH)) {
    return;
  }

  ensureKnownTargetsDir(filePath);
  try {
    renameSync(LEGACY_KNOWN_TARGETS_PATH, filePath);
  } catch {
    copyFileSync(LEGACY_KNOWN_TARGETS_PATH, filePath);
    rmSync(LEGACY_KNOWN_TARGETS_PATH, { force: true });
  }
}

function compareTargetsByLastSeenDesc(a: KnownQQBotTarget, b: KnownQQBotTarget): number {
  if (b.lastSeenAt !== a.lastSeenAt) {
    return b.lastSeenAt - a.lastSeenAt;
  }
  return a.target.localeCompare(b.target);
}

function normalizeKnownQQBotTarget(target: KnownQQBotTarget): KnownQQBotTarget {
  const accountId = target.accountId.trim() || DEFAULT_ACCOUNT_ID;
  const normalized: KnownQQBotTarget = {
    accountId,
    kind: target.kind,
    target: target.target.trim(),
    sourceChatType: target.sourceChatType,
    firstSeenAt: Math.trunc(target.firstSeenAt),
    lastSeenAt: Math.trunc(target.lastSeenAt),
  };

  const displayName = target.displayName?.trim();
  if (displayName) {
    normalized.displayName = displayName;
  }
  return normalized;
}

function parseKnownTargets(raw: string, filePath: string): KnownQQBotTarget[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid known QQBot targets file: ${filePath}`);
  }

  return parsed
    .filter((entry): entry is KnownQQBotTarget => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as Record<string, unknown>;
      return (
        typeof candidate.accountId === "string" &&
        typeof candidate.kind === "string" &&
        typeof candidate.target === "string" &&
        typeof candidate.sourceChatType === "string" &&
        typeof candidate.firstSeenAt === "number" &&
        typeof candidate.lastSeenAt === "number"
      );
    })
    .map((entry) => normalizeKnownQQBotTarget(entry))
    .filter((entry) => entry.target.length > 0);
}

function readKnownTargets(options?: KnownQQBotTargetStoreOptions): KnownQQBotTarget[] {
  const filePath = resolveKnownTargetsFilePath(options);
  migrateLegacyKnownTargets(filePath);
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return [];
  }
  return parseKnownTargets(raw, filePath).sort(compareTargetsByLastSeenDesc);
}

function writeKnownTargets(targets: KnownQQBotTarget[], options?: KnownQQBotTargetStoreOptions): void {
  const filePath = resolveKnownTargetsFilePath(options);
  migrateLegacyKnownTargets(filePath);
  if (targets.length === 0) {
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
    return;
  }

  ensureKnownTargetsDir(filePath);
  writeFileSync(filePath, `${JSON.stringify(targets, null, 2)}\n`, "utf8");
}

export function upsertKnownQQBotTarget(params: UpsertKnownQQBotTargetParams): KnownQQBotTarget {
  const next = normalizeKnownQQBotTarget(params.target);
  if (!next.target) {
    throw new Error("Known QQBot target requires a non-empty target");
  }

  const targets = readKnownTargets(params);
  const index = targets.findIndex(
    (entry) => entry.accountId === next.accountId && entry.target === next.target
  );

  if (index >= 0) {
    const existing = targets[index] as KnownQQBotTarget;
    targets[index] = {
      ...existing,
      kind: next.kind,
      sourceChatType: next.sourceChatType,
      displayName: next.displayName ?? existing.displayName,
      lastSeenAt: next.lastSeenAt,
    };
  } else {
    targets.push(next);
  }

  targets.sort(compareTargetsByLastSeenDesc);
  writeKnownTargets(targets, params);
  return index >= 0 ? (targets.find((entry) => entry.accountId === next.accountId && entry.target === next.target) as KnownQQBotTarget) : next;
}

export function listKnownQQBotTargets(params: ListKnownQQBotTargetsParams = {}): KnownQQBotTarget[] {
  let targets = readKnownTargets(params);
  if (params.accountId?.trim()) {
    targets = targets.filter((entry) => entry.accountId === params.accountId?.trim());
  }
  if (params.kind) {
    targets = targets.filter((entry) => entry.kind === params.kind);
  }
  if (typeof params.limit === "number" && params.limit > 0) {
    targets = targets.slice(0, params.limit);
  }
  return targets;
}

export function getKnownQQBotTarget(params: GetKnownQQBotTargetParams): KnownQQBotTarget | undefined {
  const target = params.target.trim();
  if (!target) return undefined;

  const matches = readKnownTargets(params).filter((entry) => {
    if (entry.target !== target) return false;
    if (params.accountId?.trim()) {
      return entry.accountId === params.accountId.trim();
    }
    return true;
  });

  return matches[0];
}

export function removeKnownQQBotTarget(params: RemoveKnownQQBotTargetParams): boolean {
  const target = params.target.trim();
  if (!target) return false;

  const before = readKnownTargets(params);
  const filtered = before.filter((entry) => {
    if (entry.target !== target) return true;
    if (params.accountId?.trim()) {
      return entry.accountId !== params.accountId.trim();
    }
    return false;
  });

  if (filtered.length === before.length) {
    return false;
  }

  writeKnownTargets(filtered, params);
  return true;
}

export function clearKnownQQBotTargets(params: ClearKnownQQBotTargetsParams = {}): number {
  const before = readKnownTargets(params);
  const filtered = before.filter((entry) => {
    if (params.accountId?.trim() && entry.accountId !== params.accountId.trim()) {
      return true;
    }
    if (params.kind && entry.kind !== params.kind) {
      return true;
    }
    return false;
  });

  const removed = before.length - filtered.length;
  if (removed === 0) {
    return 0;
  }

  writeKnownTargets(filtered, params);
  return removed;
}

export async function sendProactiveQQBotMessage(params: {
  cfg: PluginConfig;
  to: string;
  text?: string;
  mediaUrl?: string;
  accountId?: string;
}): Promise<QQBotSendResult> {
  const to = params.to.trim();
  if (!to) {
    return { channel: QQBOT_CHANNEL_ID, error: "to is required for proactive send" };
  }

  if (params.mediaUrl?.trim()) {
    return qqbotOutbound.sendMedia({
      cfg: params.cfg,
      to,
      mediaUrl: params.mediaUrl.trim(),
      text: params.text,
      accountId: params.accountId,
    });
  }

  const text = params.text?.trim();
  if (!text) {
    return { channel: QQBOT_CHANNEL_ID, error: "text or mediaUrl is required for proactive send" };
  }

  return qqbotOutbound.sendText({
    cfg: params.cfg,
    to,
    text,
    accountId: params.accountId,
  });
}

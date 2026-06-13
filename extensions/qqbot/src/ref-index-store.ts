import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { qqbotDataDirPath } from "./platform.js";

export interface RefAttachmentSummary {
  type: "image" | "voice" | "video" | "file" | "unknown";
  filename?: string;
  contentType?: string;
  localPath?: string;
  url?: string;
  transcript?: string;
  transcriptSource?: "stt" | "asr" | "tts" | "fallback";
}

export interface RefIndexEntry {
  content: string;
  senderId: string;
  senderName?: string;
  timestamp: number;
  isBot?: boolean;
  attachments?: RefAttachmentSummary[];
}

type StoredRefIndexEntry = RefIndexEntry & {
  _createdAt: number;
};

type RefIndexLine = {
  k: string;
  v: RefIndexEntry;
  t: number;
};

const REF_INDEX_FILE = join(qqbotDataDirPath("data"), "ref-index.jsonl");
const MAX_CONTENT_LENGTH = 500;
const MAX_ENTRIES = 50000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COMPACT_THRESHOLD_RATIO = 2;

let cache: Map<string, StoredRefIndexEntry> | null = null;
let totalLinesOnDisk = 0;

function normalizeRefIdx(refIdx: string): string | undefined {
  const next = refIdx.trim();
  return next ? next : undefined;
}

function ensureStorageDir(): void {
  mkdirSync(dirname(REF_INDEX_FILE), { recursive: true });
}

function truncateContent(content: string): string {
  return content.trim().slice(0, MAX_CONTENT_LENGTH);
}

function sanitizeAttachmentSummary(
  attachment: RefAttachmentSummary
): RefAttachmentSummary | undefined {
  const type = attachment.type;
  const filename = attachment.filename?.trim();
  const contentType = attachment.contentType?.trim();
  const localPath = attachment.localPath?.trim();
  const url = attachment.url?.trim();
  const transcript = attachment.transcript?.trim();

  if (!filename && !contentType && !localPath && !url && !transcript && type === "unknown") {
    return undefined;
  }

  return {
    type,
    ...(filename ? { filename } : {}),
    ...(contentType ? { contentType } : {}),
    ...(localPath ? { localPath } : {}),
    ...(url ? { url } : {}),
    ...(transcript ? { transcript } : {}),
    ...(transcript && attachment.transcriptSource ? { transcriptSource: attachment.transcriptSource } : {}),
  };
}

function sanitizeEntry(entry: RefIndexEntry): RefIndexEntry {
  const senderId = entry.senderId.trim() || "unknown";
  const senderName = entry.senderName?.trim();
  const timestamp = Number.isFinite(entry.timestamp) ? Math.trunc(entry.timestamp) : Date.now();
  const attachments = entry.attachments
    ?.map((attachment) => sanitizeAttachmentSummary(attachment))
    .filter((attachment): attachment is RefAttachmentSummary => Boolean(attachment));

  return {
    content: truncateContent(entry.content),
    senderId,
    ...(senderName ? { senderName } : {}),
    timestamp,
    ...(entry.isBot ? { isBot: true } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

function shouldCompact(): boolean {
  if (!cache) return false;
  return totalLinesOnDisk > cache.size * COMPACT_THRESHOLD_RATIO && totalLinesOnDisk > 1000;
}

function compactFile(): void {
  if (!cache) return;

  try {
    ensureStorageDir();
    const tempPath = `${REF_INDEX_FILE}.tmp`;
    const lines: string[] = [];

    for (const [key, entry] of cache.entries()) {
      lines.push(
        JSON.stringify({
          k: key,
          v: sanitizeEntry(entry),
          t: entry._createdAt,
        } satisfies RefIndexLine)
      );
    }

    writeFileSync(tempPath, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
    renameSync(tempPath, REF_INDEX_FILE);
    totalLinesOnDisk = cache.size;
  } catch {
    // Leave the in-memory cache intact even if compaction fails.
  }
}

function evictIfNeeded(): void {
  if (!cache || cache.size < MAX_ENTRIES) return;

  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry._createdAt > TTL_MS) {
      cache.delete(key);
    }
  }

  if (cache.size < MAX_ENTRIES) {
    return;
  }

  const sorted = [...cache.entries()].sort((left, right) => left[1]._createdAt - right[1]._createdAt);
  const removeCount = cache.size - MAX_ENTRIES + 1;
  for (let index = 0; index < removeCount; index += 1) {
    const key = sorted[index]?.[0];
    if (key) {
      cache.delete(key);
    }
  }
}

function loadCache(): Map<string, StoredRefIndexEntry> {
  if (cache) {
    return cache;
  }

  cache = new Map<string, StoredRefIndexEntry>();
  totalLinesOnDisk = 0;

  try {
    if (!existsSync(REF_INDEX_FILE)) {
      return cache;
    }

    const now = Date.now();
    const raw = readFileSync(REF_INDEX_FILE, "utf8");
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      totalLinesOnDisk += 1;

      try {
        const parsed = JSON.parse(trimmed) as Partial<RefIndexLine>;
        const key = typeof parsed.k === "string" ? normalizeRefIdx(parsed.k) : undefined;
        const createdAt = typeof parsed.t === "number" && Number.isFinite(parsed.t) ? parsed.t : undefined;
        if (!key || createdAt === undefined || !parsed.v || typeof parsed.v !== "object") {
          continue;
        }
        if (now - createdAt > TTL_MS) {
          continue;
        }

        const entry = sanitizeEntry(parsed.v as RefIndexEntry);
        cache.set(key, {
          ...entry,
          _createdAt: createdAt,
        });
      } catch {
        // Ignore malformed lines and keep loading.
      }
    }

    if (shouldCompact()) {
      compactFile();
    }
  } catch {
    cache = new Map<string, StoredRefIndexEntry>();
    totalLinesOnDisk = 0;
  }

  return cache;
}

function appendLine(line: RefIndexLine): void {
  try {
    ensureStorageDir();
    appendFileSync(REF_INDEX_FILE, `${JSON.stringify(line)}\n`, "utf8");
    totalLinesOnDisk += 1;
  } catch {
    // Persistence is best-effort; keep the in-memory cache even if disk write fails.
  }
}

function restoreEntry(entry: StoredRefIndexEntry): RefIndexEntry {
  const sanitized = sanitizeEntry(entry);
  return {
    content: sanitized.content,
    senderId: sanitized.senderId,
    ...(sanitized.senderName ? { senderName: sanitized.senderName } : {}),
    timestamp: sanitized.timestamp,
    ...(sanitized.isBot ? { isBot: true } : {}),
    ...(sanitized.attachments ? { attachments: sanitized.attachments } : {}),
  };
}

function formatAttachmentSummary(attachment: RefAttachmentSummary): string {
  const sourceParts = [
    attachment.localPath?.trim() ? `本地: ${attachment.localPath.trim()}` : undefined,
    attachment.url?.trim() ? `链接: ${attachment.url.trim()}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const sourceSuffix = sourceParts.length > 0 ? ` (${sourceParts.join(" | ")})` : "";

  if (attachment.type === "image") {
    return `[图片${attachment.filename?.trim() ? `: ${attachment.filename.trim()}` : ""}]${sourceSuffix}`;
  }

  if (attachment.type === "voice") {
    if (attachment.transcript?.trim()) {
      const sourceLabel =
        attachment.transcriptSource === "asr"
          ? "官方识别"
          : attachment.transcriptSource === "stt"
            ? "本地识别"
            : attachment.transcriptSource === "tts"
              ? "TTS 原文"
              : attachment.transcriptSource === "fallback"
                ? "兜底文本"
                : undefined;
      return `[语音消息: ${attachment.transcript.trim()}${sourceLabel ? ` (${sourceLabel})` : ""}]${sourceSuffix}`;
    }
    return `[语音消息]${sourceSuffix}`;
  }

  if (attachment.type === "video") {
    return `[视频${attachment.filename?.trim() ? `: ${attachment.filename.trim()}` : ""}]${sourceSuffix}`;
  }

  if (attachment.type === "file") {
    return `[文件${attachment.filename?.trim() ? `: ${attachment.filename.trim()}` : ""}]${sourceSuffix}`;
  }

  return `[附件${attachment.filename?.trim() ? `: ${attachment.filename.trim()}` : ""}]${sourceSuffix}`;
}

export function setRefIndex(refIdx: string, entry: RefIndexEntry): void {
  const key = normalizeRefIdx(refIdx);
  if (!key) return;

  const store = loadCache();
  evictIfNeeded();

  const nextEntry = sanitizeEntry(entry);
  const createdAt = Date.now();
  store.set(key, {
    ...nextEntry,
    _createdAt: createdAt,
  });

  appendLine({
    k: key,
    v: nextEntry,
    t: createdAt,
  });

  if (shouldCompact()) {
    compactFile();
  }
}

export function getRefIndex(refIdx: string): RefIndexEntry | null {
  const key = normalizeRefIdx(refIdx);
  if (!key) return null;

  const store = loadCache();
  const entry = store.get(key);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry._createdAt > TTL_MS) {
    store.delete(key);
    return null;
  }

  return restoreEntry(entry);
}

export function formatRefEntryForAgent(entry: RefIndexEntry): string {
  const content = entry.content.trim();
  const parts = content ? [content] : [];

  for (const attachment of entry.attachments ?? []) {
    parts.push(formatAttachmentSummary(attachment));
  }

  return parts.join("\n") || "[空消息]";
}

export function flushRefIndex(): void {
  if (shouldCompact()) {
    compactFile();
  }
}

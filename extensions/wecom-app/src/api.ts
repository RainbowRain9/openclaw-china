/**
 * 企业微信自建应用 API
 * 
 * 提供 Access Token 缓存和主动发送消息能力
 */
import type { ResolvedWecomAppAccount, WecomAppSendTarget, AccessTokenCacheEntry } from "./types.js";

/** Access Token 缓存 (key: corpId:agentId) */
const accessTokenCache = new Map<string, AccessTokenCacheEntry>();

/** Access Token 有效期: 2小时减去5分钟缓冲 */
const ACCESS_TOKEN_TTL_MS = 7200 * 1000 - 5 * 60 * 1000;

/**
 * 移除 Markdown 格式，转换为纯文本
 * 方案 C: 代码块缩进，标题用【】标记，表格简化
 * 企业微信文本消息不支持 Markdown
 */
export function stripMarkdown(text: string): string {
  let result = text;

  // 1. 代码块：提取内容并缩进（保留语言标识）
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const trimmedCode = code.trim();
    if (!trimmedCode) return "";
    const langLabel = lang ? `[${lang}]\n` : "";
    const indentedCode = trimmedCode
      .split("\n")
      .map((line: string) => `    ${line}`)
      .join("\n");
    return `\n${langLabel}${indentedCode}\n`;
  });

  // 2. 标题：用【】标记
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "【$1】");

  // 3. 粗体/斜体：保留文字（排除 URL 中的下划线）
  result = result
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    // 只替换独立的斜体标记（前后有空格或标点），避免匹配 URL 中的下划线
    .replace(/(?<![\w/])_(.+?)_(?![\w/])/g, "$1");

  // 4. 列表项转为点号
  result = result.replace(/^[-*]\s+/gm, "· ");

  // 5. 有序列表保持编号
  result = result.replace(/^(\d+)\.\s+/gm, "$1. ");

  // 6. 行内代码保留内容
  result = result.replace(/`([^`]+)`/g, "$1");

  // 7. 删除线
  result = result.replace(/~~(.*?)~~/g, "$1");

  // 8. 链接：保留文字和 URL
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // 9. 图片：显示 alt 文字
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[图片: $1]");

  // 10. 表格：简化为对齐文本
  result = result.replace(
    /\|(.+)\|\n\|[-:| ]+\|\n((?:\|.+\|\n?)*)/g,
    (_match, header, body) => {
      const headerCells = header.split("|").map((c: string) => c.trim()).filter(Boolean);
      const rows = body.trim().split("\n").map((row: string) => 
        row.split("|").map((c: string) => c.trim()).filter(Boolean)
      );
      
      // 计算每列最大宽度
      const colWidths = headerCells.map((h: string, i: number) => {
        const maxRowWidth = Math.max(...rows.map((r: string[]) => (r[i] || "").length));
        return Math.max(h.length, maxRowWidth);
      });
      
      // 格式化表头
      const formattedHeader = headerCells
        .map((h: string, i: number) => h.padEnd(colWidths[i]))
        .join("  ");
      
      // 格式化数据行
      const formattedRows = rows
        .map((row: string[]) => 
          headerCells.map((_: string, i: number) => 
            (row[i] || "").padEnd(colWidths[i])
          ).join("  ")
        )
        .join("\n");
      
      return `${formattedHeader}\n${formattedRows}\n`;
    }
  );

  // 11. 引用块：去掉 > 前缀
  result = result.replace(/^>\s?/gm, "");

  // 12. 水平线
  result = result.replace(/^[-*_]{3,}$/gm, "────────────");

  // 13. 多个换行合并
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * 获取 Access Token (带缓存)
 */
export async function getAccessToken(account: ResolvedWecomAppAccount): Promise<string> {
  if (!account.corpId || !account.corpSecret) {
    throw new Error("corpId or corpSecret not configured");
  }

  const key = `${account.corpId}:${account.agentId ?? "default"}`;
  const cached = accessTokenCache.get(key);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(account.corpId)}&corpsecret=${encodeURIComponent(account.corpSecret)}`;
  const resp = await fetch(url);
  const data = (await resp.json()) as { errcode?: number; errmsg?: string; access_token?: string };

  if (data.errcode !== undefined && data.errcode !== 0) {
    throw new Error(`gettoken failed: ${data.errmsg ?? "unknown error"} (errcode=${data.errcode})`);
  }

  if (!data.access_token) {
    throw new Error("gettoken returned empty access_token");
  }

  accessTokenCache.set(key, {
    token: data.access_token,
    expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
  });

  return data.access_token;
}

/**
 * 清除指定账户的 Access Token 缓存
 */
export function clearAccessTokenCache(account: ResolvedWecomAppAccount): void {
  const key = `${account.corpId}:${account.agentId ?? "default"}`;
  accessTokenCache.delete(key);
}

/**
 * 清除所有 Access Token 缓存
 */
export function clearAllAccessTokenCache(): void {
  accessTokenCache.clear();
}

/** 发送消息结果 */
export type SendMessageResult = {
  ok: boolean;
  errcode?: number;
  errmsg?: string;
  invaliduser?: string;
  invalidparty?: string;
  invalidtag?: string;
  msgid?: string;
};

/**
 * 发送企业微信应用消息
 * 
 * @param account - 已解析的账户配置
 * @param target - 发送目标 (userId 或 chatid)
 * @param message - 消息内容 (会自动移除 Markdown 格式)
 */
export async function sendWecomAppMessage(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  message: string
): Promise<SendMessageResult> {
  if (!account.canSendActive) {
    return {
      ok: false,
      errcode: -1,
      errmsg: "Account not configured for active sending (missing corpId, corpSecret, or agentId)",
    };
  }

  const token = await getAccessToken(account);
  const text = stripMarkdown(message);

  const payload: Record<string, unknown> = {
    msgtype: "text",
    agentid: account.agentId,
    text: { content: text },
  };

  if (target.chatid) {
    payload.chatid = target.chatid;
  } else if (target.userId) {
    payload.touser = target.userId;
  } else {
    return {
      ok: false,
      errcode: -1,
      errmsg: "No target specified (need userId or chatid)",
    };
  }

  // NOTE: WeCom API requires access_token to be passed as a query parameter.
  // This can expose the token in server logs, browser history, and referrer headers.
  // Ensure that any logging of this URL redacts the access_token parameter.
  const resp = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as SendMessageResult & { errcode?: number };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    invaliduser: data.invaliduser,
    invalidparty: data.invalidparty,
    invalidtag: data.invalidtag,
    msgid: data.msgid,
  };
}

/**
 * 发送 Markdown 格式消息 (仅企业微信客户端支持)
 */
export async function sendWecomAppMarkdownMessage(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  markdownContent: string
): Promise<SendMessageResult> {
  if (!account.canSendActive) {
    return {
      ok: false,
      errcode: -1,
      errmsg: "Account not configured for active sending (missing corpId, corpSecret, or agentId)",
    };
  }

  const token = await getAccessToken(account);

  const payload: Record<string, unknown> = {
    msgtype: "markdown",
    agentid: account.agentId,
    markdown: { content: markdownContent },
  };

  if (target.chatid) {
    payload.chatid = target.chatid;
  } else if (target.userId) {
    payload.touser = target.userId;
  } else {
    return {
      ok: false,
      errcode: -1,
      errmsg: "No target specified (need userId or chatid)",
    };
  }

  const resp = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as SendMessageResult & { errcode?: number };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    invaliduser: data.invaliduser,
    invalidparty: data.invalidparty,
    invalidtag: data.invalidtag,
    msgid: data.msgid,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 图片消息支持
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MIME 类型映射表
 */
const MIME_TYPE_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
} as const;

/**
 * 根据文件扩展名获取 MIME 类型
 */
function getMimeType(filename: string, contentType?: string): string {
  // 优先使用响应头的 Content-Type
  if (contentType) {
    return contentType.split(';')[0].trim();
  }

  // 回退到文件扩展名推断
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0];
  return MIME_TYPE_MAP[ext || ''] || 'image/jpeg';
}

/**
 * 下载图片
 * @param imageUrl 图片 URL
 * @returns 图片 Buffer
 */
export async function downloadImage(imageUrl: string): Promise<{ buffer: Buffer; contentType?: string }> {
  const resp = await fetch(imageUrl);
  if (!resp.ok) {
    throw new Error(`Download image failed: HTTP ${resp.status}`);
  }
  const arrayBuffer = await resp.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: resp.headers.get('content-type') || undefined,
  };
}

/**
 * 上传图片素材获取 media_id
 * @param account 账户配置
 * @param imageBuffer 图片数据
 * @param filename 文件名
 * @param contentType MIME 类型（可选）
 * @returns media_id
 */
export async function uploadImageMedia(
  account: ResolvedWecomAppAccount,
  imageBuffer: Buffer,
  filename = "image.jpg",
  contentType?: string
): Promise<string> {
  if (!account.canSendActive) {
    throw new Error("Account not configured for active sending");
  }

  const token = await getAccessToken(account);
  const mimeType = getMimeType(filename, contentType);
  const boundary = `----FormBoundary${Date.now()}`;

  // 构造 multipart/form-data
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="media"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, imageBuffer, footer]);

  const resp = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${encodeURIComponent(token)}&type=image`,
    {
      method: "POST",
      body: body,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
    }
  );

  const data = (await resp.json()) as { errcode?: number; errmsg?: string; media_id?: string };

  if (data.errcode !== undefined && data.errcode !== 0) {
    throw new Error(`Upload image failed: ${data.errmsg ?? "unknown error"} (errcode=${data.errcode})`);
  }

  if (!data.media_id) {
    throw new Error("Upload image returned empty media_id");
  }

  return data.media_id;
}

/**
 * 发送图片消息
 * @param account 账户配置
 * @param target 发送目标
 * @param mediaId 图片 media_id
 */
export async function sendWecomAppImageMessage(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  mediaId: string
): Promise<SendMessageResult> {
  if (!account.canSendActive) {
    return {
      ok: false,
      errcode: -1,
      errmsg: "Account not configured for active sending (missing corpId, corpSecret, or agentId)",
    };
  }

  const token = await getAccessToken(account);

  const payload: Record<string, unknown> = {
    msgtype: "image",
    agentid: account.agentId,
    image: { media_id: mediaId },
  };

  if (target.chatid) {
    payload.chatid = target.chatid;
  } else if (target.userId) {
    payload.touser = target.userId;
  } else {
    return {
      ok: false,
      errcode: -1,
      errmsg: "No target specified (need userId or chatid)",
    };
  }

  const resp = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as SendMessageResult & { errcode?: number };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    invaliduser: data.invaliduser,
    invalidparty: data.invalidparty,
    invalidtag: data.invalidtag,
    msgid: data.msgid,
  };
}

/**
 * 下载并发送图片（完整流程）
 * @param account 账户配置
 * @param target 发送目标
 * @param imageUrl 图片 URL
 */
export async function downloadAndSendImage(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  imageUrl: string
): Promise<SendMessageResult> {
  try {
    console.log(`[wecom-app] Downloading image from: ${imageUrl}`);

    // 1. 下载图片
    const { buffer: imageBuffer, contentType } = await downloadImage(imageUrl);
    console.log(`[wecom-app] Image downloaded, size: ${imageBuffer.length} bytes, contentType: ${contentType || 'unknown'}`);

    // 2. 提取文件扩展名
    const extMatch = imageUrl.match(/\.([^.]+)$/);
    const ext = extMatch ? `.${extMatch[1]}` : '.jpg';
    const filename = `image${ext}`;

    // 3. 上传获取 media_id
    console.log(`[wecom-app] Uploading image to WeCom media API, filename: ${filename}`);
    const mediaId = await uploadImageMedia(account, imageBuffer, filename, contentType);
    console.log(`[wecom-app] Image uploaded, media_id: ${mediaId}`);

    // 4. 发送图片消息
    console.log(`[wecom-app] Sending image to target:`, target);
    const result = await sendWecomAppImageMessage(account, target, mediaId);
    console.log(`[wecom-app] Image sent, ok: ${result.ok}, msgid: ${result.msgid}, errcode: ${result.errcode}, errmsg: ${result.errmsg}`);

    return result;
  } catch (err) {
    console.error(`[wecom-app] downloadAndSendImage error:`, err);
    return {
      ok: false,
      errcode: -1,
      errmsg: err instanceof Error ? err.message : String(err),
    };
  }
}

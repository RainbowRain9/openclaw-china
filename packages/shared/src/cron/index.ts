const CRON_HIDDEN_PROMPT = `
When creating or updating a cron task, use the main session's last route as the delivery target.
- Do not ask the user for userId/chatId
- sessionTarget="isolated"
- payload.kind="agentTurn"
- payload.deliver=true
- Do not set payload.channel/to (fall back to last route automatically)
- Do not call the message tool to send`;

const CRON_TRIGGER_KEYWORDS = [
  "定时",
  "提醒",
  "每分钟",
  "每小时",
  "每天",
  "每周",
  "几点",
  "早上",
  "晚上",
  "工作日",
  "cron",
  "remind",
  "reminder",
  "schedule",
  "scheduled",
  "every minute",
  "every hour",
  "every day",
  "daily",
  "every week",
  "weekly",
  "weekday",
  "workday",
  "morning",
  "evening",
];

const CRON_TRIGGER_PATTERNS = [
  /提醒我/u,
  /帮我定时/u,
  /每.+提醒/u,
  /每天.+发/u,
  /remind me/iu,
  /set (a )?reminder/iu,
  /every .+ remind/iu,
  /every day .+ (send|post|notify)/iu,
  /schedule .+ (reminder|message|notification)/iu,
];

const CRON_EXCLUDE_PATTERNS = [
  /是什么意思/u,
  /区别/u,
  /为什么/u,
  /\bhelp\b/iu,
  /文档/u,
  /怎么用/u,
  /what does|what's|meaning of/iu,
  /difference/iu,
  /why/iu,
  /\bdocs?\b/iu,
  /documentation/iu,
  /how to/iu,
  /usage/iu,
];

export function shouldInjectCronHiddenPrompt(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  const lowered = normalized.toLowerCase();

  for (const pattern of CRON_EXCLUDE_PATTERNS) {
    if (pattern.test(lowered)) return false;
  }

  for (const keyword of CRON_TRIGGER_KEYWORDS) {
    if (lowered.includes(keyword.toLowerCase())) return true;
  }

  return CRON_TRIGGER_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function splitCronHiddenPrompt(text: string): { base: string; prompt?: string } {
  const idx = text.indexOf(CRON_HIDDEN_PROMPT);
  if (idx === -1) {
    return { base: text };
  }
  const base = text.slice(0, idx).trimEnd();
  return { base, prompt: CRON_HIDDEN_PROMPT };
}

export function appendCronHiddenPrompt(text: string): string {
  if (!shouldInjectCronHiddenPrompt(text)) return text;
  if (text.includes(CRON_HIDDEN_PROMPT)) return text;
  return `${text}\n\n${CRON_HIDDEN_PROMPT}`;
}

export function applyCronHiddenPromptToContext<
  T extends { Body?: string; RawBody?: string; CommandBody?: string }
>(ctx: T): boolean {
  const base =
    (typeof ctx.RawBody === "string" && ctx.RawBody) ||
    (typeof ctx.Body === "string" && ctx.Body) ||
    (typeof ctx.CommandBody === "string" && ctx.CommandBody) ||
    "";

  if (!base) return false;

  const next = appendCronHiddenPrompt(base);
  if (next === base) return false;

  ctx.CommandBody = next;
  return true;
}

export { CRON_HIDDEN_PROMPT };

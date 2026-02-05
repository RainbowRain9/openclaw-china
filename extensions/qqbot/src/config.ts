import { z } from "zod";

export const QQBotConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  appId: z.string().optional(),
  clientSecret: z.string().optional(),
  markdownSupport: z.boolean().optional().default(false),
  dmPolicy: z.enum(["open", "pairing", "allowlist"]).optional().default("open"),
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional().default("open"),
  requireMention: z.boolean().optional().default(true),
  allowFrom: z.array(z.string()).optional(),
  groupAllowFrom: z.array(z.string()).optional(),
  historyLimit: z.number().int().min(0).optional().default(10),
  textChunkLimit: z.number().int().positive().optional().default(1500),
  replyFinalOnly: z.boolean().optional().default(false),
});

export type QQBotConfig = z.infer<typeof QQBotConfigSchema>;

export function isConfigured(config: QQBotConfig | undefined): boolean {
  return Boolean(config?.appId && config?.clientSecret);
}

export function resolveQQBotCredentials(
  config: QQBotConfig | undefined
): { appId: string; clientSecret: string } | undefined {
  if (!config?.appId || !config?.clientSecret) return undefined;
  return { appId: config.appId, clientSecret: config.clientSecret };
}

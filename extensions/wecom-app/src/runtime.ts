/**
 * 企业微信自建应用插件运行时管理
 */

export interface PluginRuntime {
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  channel?: {
    routing?: {
      resolveAgentRoute?: (params: {
        cfg: unknown;
        channel: string;
        accountId?: string;
        peer: { kind: string; id: string };
      }) => { sessionKey: string; accountId: string; agentId?: string };
    };
    reply?: {
      dispatchReplyFromConfig?: (params: {
        ctx: unknown;
        cfg: unknown;
        dispatcher?: unknown;
        replyOptions?: unknown;
      }) => Promise<{ queuedFinal: boolean; counts: { final: number } }>;
      dispatchReplyWithBufferedBlockDispatcher?: (params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: { text?: string }) => Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }) => Promise<void>;
      finalizeInboundContext?: (ctx: unknown) => unknown;
      createReplyDispatcher?: (params: unknown) => unknown;
      createReplyDispatcherWithTyping?: (params: unknown) => {
        dispatcher: unknown;
        replyOptions?: unknown;
        markDispatchIdle?: () => void;
      };
      resolveHumanDelayConfig?: (cfg: unknown, agentId?: string) => unknown;
      resolveEnvelopeFormatOptions?: (cfg: unknown) => unknown;
      formatAgentEnvelope?: (params: {
        channel: string;
        from: string;
        previousTimestamp?: number;
        envelope?: unknown;
        body: string;
      }) => string;
    };
    session?: {
      resolveStorePath?: (store: unknown, params: { agentId?: string }) => string | undefined;
      readSessionUpdatedAt?: (params: { storePath?: string; sessionKey: string }) => number | null;
      recordInboundSession?: (params: {
        storePath: string;
        sessionKey: string;
        ctx: unknown;
        onRecordError?: (err: unknown) => void;
      }) => Promise<void>;
    };
    text?: {
      resolveMarkdownTableMode?: (params: { cfg: unknown; channel: string; accountId?: string }) => unknown;
      convertMarkdownTables?: (text: string, mode: unknown) => string;
    };
  };
  system?: {
    enqueueSystemEvent?: (message: string, options?: unknown) => void;
  };
  [key: string]: unknown;
}

let runtime: PluginRuntime | null = null;

/**
 * 设置企业微信自建应用运行时
 */
export function setWecomAppRuntime(next: PluginRuntime): void {
  runtime = next;
}

/**
 * 获取企业微信自建应用运行时 (必须已初始化)
 */
export function getWecomAppRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WeCom App runtime not initialized. Make sure the plugin is properly registered with Moltbot.");
  }
  return runtime;
}

/**
 * 尝试获取企业微信自建应用运行时 (可能为 null)
 */
export function tryGetWecomAppRuntime(): PluginRuntime | null {
  return runtime;
}

/**
 * 检查运行时是否已初始化
 */
export function isWecomAppRuntimeInitialized(): boolean {
  return runtime !== null;
}

/**
 * 清除运行时
 */
export function clearWecomAppRuntime(): void {
  runtime = null;
}

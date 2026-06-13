import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  MockWebSocket: class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: InstanceType<typeof MockWebSocket>[] = [];

    readonly url: string;
    readonly options: { headers?: Record<string, string> } | undefined;
    readonly sent: Array<Record<string, unknown>> = [];
    readyState = MockWebSocket.OPEN;
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(url: string, options?: { headers?: Record<string, string> }) {
      this.url = url;
      this.options = options;
      MockWebSocket.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      const handlers = this.listeners.get(event) ?? [];
      handlers.push(handler);
      this.listeners.set(event, handlers);
      return this;
    }

    send(payload: string): void {
      try {
        this.sent.push(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        this.sent.push({ raw: payload });
      }
    }

    emitMessage(payload: unknown): void {
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      this.emit("message", body);
    }

    emitClose(code = 1000, reason = "closed"): void {
      if (this.readyState === MockWebSocket.CLOSED) return;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code, reason);
    }

    close(): void {
      this.emitClose();
    }

    static reset(): void {
      MockWebSocket.instances = [];
    }

    private emit(event: string, ...args: unknown[]): void {
      for (const handler of this.listeners.get(event) ?? []) {
        handler(...args);
      }
    }
  },
  clearTokenCache: vi.fn(),
  getAccessToken: vi.fn(),
  getGatewayUrl: vi.fn(),
  getPluginUserAgent: vi.fn().mockReturnValue("QQBotPlugin/test (Node/test; test)"),
  handleQQBotDispatch: vi.fn(),
  loadSession: vi.fn().mockReturnValue(null),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("ws", () => ({
  default: mocks.MockWebSocket,
}));

vi.mock("./client.js", () => ({
  clearTokenCache: mocks.clearTokenCache,
  getAccessToken: mocks.getAccessToken,
  getGatewayUrl: mocks.getGatewayUrl,
  getPluginUserAgent: mocks.getPluginUserAgent,
}));

vi.mock("./session-store.js", () => ({
  loadSession: mocks.loadSession,
  saveSession: mocks.saveSession,
  clearSession: mocks.clearSession,
}));

vi.mock("./bot.js", () => ({
  handleQQBotDispatch: mocks.handleQQBotDispatch,
}));

vi.mock("./logger.js", () => ({
  createLogger: () => mocks.logger,
}));

import {
  getActiveAccountIds,
  isQQBotMonitorActiveForAccount,
  monitorQQBotProvider,
  stopAllQQBotMonitors,
  stopQQBotMonitorForAccount,
} from "./monitor.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const baseConfig = {
  channels: {
    "qqbot-china": {
      appId: "app-1",
      clientSecret: "secret-1",
    },
  },
};

describe("QQBot monitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.MockWebSocket.reset();
    mocks.getAccessToken.mockResolvedValue("token-1");
    mocks.getGatewayUrl.mockResolvedValue("wss://gateway.example/ws");
  });

  afterEach(() => {
    stopAllQQBotMonitors();
    vi.useRealTimers();
  });

  it("reports inactive when no connection exists", () => {
    expect(isQQBotMonitorActiveForAccount("missing")).toBe(false);
  });

  it("reuses the in-flight monitor start for duplicate account starts", async () => {
    const tokenDeferred = deferred<string>();
    mocks.getAccessToken.mockReturnValueOnce(tokenDeferred.promise);

    const first = monitorQQBotProvider({ config: baseConfig, accountId: "dragon" });
    await flushMicrotasks();
    const second = monitorQQBotProvider({ config: baseConfig, accountId: "dragon" });

    expect(getActiveAccountIds()).toEqual(["dragon"]);
    expect(mocks.MockWebSocket.instances).toHaveLength(0);

    tokenDeferred.resolve("token-1");
    await flushMicrotasks();

    expect(mocks.getGatewayUrl).toHaveBeenCalledTimes(1);
    expect(mocks.MockWebSocket.instances).toHaveLength(1);
    expect(isQQBotMonitorActiveForAccount("dragon")).toBe(true);

    stopQQBotMonitorForAccount("dragon");

    const completion = await Promise.race([
      Promise.allSettled([first, second]).then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    expect(completion).toBe("settled");
    expect(isQQBotMonitorActiveForAccount("dragon")).toBe(false);
  });

  it("does not create a websocket after aborting an in-flight connect", async () => {
    const gatewayDeferred = deferred<string>();
    mocks.getGatewayUrl.mockReturnValueOnce(gatewayDeferred.promise);
    const controller = new AbortController();

    const running = monitorQQBotProvider({
      config: baseConfig,
      accountId: "snake",
      abortSignal: controller.signal,
    });
    await flushMicrotasks();

    controller.abort();
    await running;

    gatewayDeferred.resolve("wss://gateway.example/ws");
    await flushMicrotasks();

    expect(mocks.MockWebSocket.instances).toHaveLength(0);
    expect(getActiveAccountIds()).toEqual([]);
    expect(isQQBotMonitorActiveForAccount("snake")).toBe(false);
  });

  it("ignores stale socket events after reconnecting the same account", async () => {
    vi.useFakeTimers();

    const running = monitorQQBotProvider({ config: baseConfig, accountId: "phoenix" });
    await flushMicrotasks();

    expect(mocks.MockWebSocket.instances).toHaveLength(1);
    const firstSocket = mocks.MockWebSocket.instances[0];
    firstSocket?.emitMessage({ op: 7 });
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(mocks.MockWebSocket.instances).toHaveLength(2);
    const secondSocket = mocks.MockWebSocket.instances[1];
    expect(secondSocket?.readyState).toBe(mocks.MockWebSocket.OPEN);

    firstSocket?.emitClose(1006, "stale-close");
    firstSocket?.emitMessage({ op: 10, d: { heartbeat_interval: 30000 } });
    await flushMicrotasks();

    expect(secondSocket?.readyState).toBe(mocks.MockWebSocket.OPEN);
    expect(mocks.getAccessToken).toHaveBeenCalledTimes(2);
    expect(mocks.getGatewayUrl).toHaveBeenCalledTimes(2);

    stopQQBotMonitorForAccount("phoenix");
    await running;
  });

  it("does not leave account entries behind when config validation fails", async () => {
    await expect(
      monitorQQBotProvider({
        config: { channels: { "qqbot-china": {} } },
        accountId: "broken",
      })
    ).rejects.toThrow("missing appId or clientSecret");

    expect(getActiveAccountIds()).toEqual([]);
    expect(isQQBotMonitorActiveForAccount("broken")).toBe(false);
    expect(mocks.MockWebSocket.instances).toHaveLength(0);
  });

  // ── P0-E: hardened WS lifecycle (session RESUME, close-code, UA, guard) ──

  it("attaches a User-Agent header to the WebSocket handshake", async () => {
    monitorQQBotProvider({ config: baseConfig, accountId: "ua-test" });
    await flushMicrotasks();

    const socket = mocks.MockWebSocket.instances[0];
    expect(socket?.options?.headers?.["User-Agent"]).toBe("QQBotPlugin/test (Node/test; test)");
    expect(mocks.getPluginUserAgent).toHaveBeenCalled();
  });

  it("persists the session on READY (enables cross-restart RESUME)", async () => {
    monitorQQBotProvider({ config: baseConfig, accountId: "ready-test" });
    await flushMicrotasks();
    const socket = mocks.MockWebSocket.instances[0];

    socket?.emitMessage({ op: 10, d: { heartbeat_interval: 30000 } });
    await flushMicrotasks();
    socket?.emitMessage({ op: 0, t: "READY", d: { session_id: "sess-ready" }, s: 1 });
    await flushMicrotasks();

    expect(mocks.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "ready-test", sessionId: "sess-ready", appId: "app-1" }),
    );
  });

  it("sends op:6 RESUME on Hello when a session was restored", async () => {
    mocks.loadSession.mockReturnValueOnce({
      sessionId: "sess-saved",
      lastSeq: 5,
      lastConnectedAt: 0,
      intentLevelIndex: 0,
      accountId: "resume-test",
      savedAt: Date.now(),
      appId: "app-1",
    });

    monitorQQBotProvider({ config: baseConfig, accountId: "resume-test" });
    await flushMicrotasks();
    const socket = mocks.MockWebSocket.instances[0];

    socket?.emitMessage({ op: 10, d: { heartbeat_interval: 30000 } });
    await flushMicrotasks();

    const ops = socket?.sent.map((p) => p.op) ?? [];
    expect(ops).toContain(6); // RESUME
    expect(ops).not.toContain(2); // not IDENTIFY
  });

  it("sends op:2 IDENTIFY on Hello when no session was restored", async () => {
    monitorQQBotProvider({ config: baseConfig, accountId: "identify-test" });
    await flushMicrotasks();
    const socket = mocks.MockWebSocket.instances[0];

    socket?.emitMessage({ op: 10, d: { heartbeat_interval: 30000 } });
    await flushMicrotasks();

    const ops = socket?.sent.map((p) => p.op) ?? [];
    expect(ops).toContain(2); // IDENTIFY
  });

  it("halts and does not reconnect on close 4914 (bot offline)", async () => {
    const running = monitorQQBotProvider({ config: baseConfig, accountId: "halt-test" });
    await flushMicrotasks();
    const socket = mocks.MockWebSocket.instances[0];

    socket?.emitClose(4914, "offline");
    await running;

    expect(mocks.MockWebSocket.instances).toHaveLength(1);
    expect(isQQBotMonitorActiveForAccount("halt-test")).toBe(false);
  });

  it("clears the persisted session and flags token refresh on close 4006", async () => {
    monitorQQBotProvider({ config: baseConfig, accountId: "c4006" });
    await flushMicrotasks();
    mocks.clearSession.mockClear();

    mocks.MockWebSocket.instances[0]?.emitClose(4006, "session invalid");
    await flushMicrotasks();

    expect(mocks.clearSession).toHaveBeenCalledWith("c4006");
  });

  it("waits ~60s before reconnecting on close 4008 (rate limited)", async () => {
    vi.useFakeTimers();
    try {
      monitorQQBotProvider({ config: baseConfig, accountId: "c4008" });
      await flushMicrotasks();
      expect(mocks.getAccessToken).toHaveBeenCalledTimes(1);

      mocks.MockWebSocket.instances[0]?.emitClose(4008, "rate limited");

      await vi.advanceTimersByTimeAsync(59000);
      expect(mocks.MockWebSocket.instances).toHaveLength(1); // not yet reconnected

      await vi.advanceTimersByTimeAsync(2000); // total > 60s
      await flushMicrotasks();
      expect(mocks.MockWebSocket.instances).toHaveLength(2); // reconnected
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the session on op:9 Invalid Session when canResume is false", async () => {
    monitorQQBotProvider({ config: baseConfig, accountId: "op9" });
    await flushMicrotasks();
    mocks.clearSession.mockClear();

    mocks.MockWebSocket.instances[0]?.emitMessage({ op: 9, d: false });
    await flushMicrotasks();

    expect(mocks.clearSession).toHaveBeenCalledWith("op9");
  });

  it("does not clear the session on op:9 when canResume is true", async () => {
    monitorQQBotProvider({ config: baseConfig, accountId: "op9resume" });
    await flushMicrotasks();
    mocks.clearSession.mockClear();

    mocks.MockWebSocket.instances[0]?.emitMessage({ op: 9, d: true });
    await flushMicrotasks();

    expect(mocks.clearSession).not.toHaveBeenCalled();
  });

  it("installs and removes a process uncaughtException guard per account", async () => {
    const before = process.listenerCount("uncaughtException");

    const running = monitorQQBotProvider({ config: baseConfig, accountId: "guard-test" });
    await flushMicrotasks();
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);

    stopQQBotMonitorForAccount("guard-test");
    await running;
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });
});


import { describe, expect, it, vi } from "vitest";

// Design doc §4.5 (P0-B) + §12.2 test matrix: inbound SSRF guard.
const dnsResolve = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({
  default: { resolve: dnsResolve },
}));

import { isReservedAddr, validateRemoteUrl } from "./ssrf-guard.js";

describe("isReservedAddr", () => {
  it("flags IPv4 private / loopback / link-local / metadata ranges", () => {
    expect(isReservedAddr("127.0.0.1")).toBe(true);
    expect(isReservedAddr("10.1.2.3")).toBe(true);
    expect(isReservedAddr("192.168.1.1")).toBe(true);
    expect(isReservedAddr("169.254.169.254")).toBe(true); // cloud metadata
    expect(isReservedAddr("0.0.0.0")).toBe(true);
  });

  it("matches the 172.16/12 range exactly (16-31 only)", () => {
    expect(isReservedAddr("172.16.0.1")).toBe(true);
    expect(isReservedAddr("172.31.255.255")).toBe(true);
    // Just outside the range — must NOT be reserved
    expect(isReservedAddr("172.15.0.1")).toBe(false);
    expect(isReservedAddr("172.32.0.1")).toBe(false);
  });

  it("flags IPv6 loopback / unspecified / link-local / ULA", () => {
    expect(isReservedAddr("::1")).toBe(true);
    expect(isReservedAddr("::")).toBe(true);
    expect(isReservedAddr("fe80::1")).toBe(true);
    expect(isReservedAddr("fc00::1")).toBe(true);
    expect(isReservedAddr("fd00::1")).toBe(true);
  });

  it("does not flag public addresses", () => {
    expect(isReservedAddr("8.8.8.8")).toBe(false);
    expect(isReservedAddr("114.114.114.114")).toBe(false);
  });
});

describe("validateRemoteUrl", () => {
  it("throws for a direct internal IP", async () => {
    await expect(validateRemoteUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /SSRF/,
    );
    await expect(validateRemoteUrl("http://10.0.0.1/x")).rejects.toThrow(/SSRF/);
  });

  it("rejects non-http(s) schemes (file:/// etc.)", async () => {
    await expect(validateRemoteUrl("file:///etc/passwd")).rejects.toThrow(/不支持的协议/);
    await expect(validateRemoteUrl("ftp://example.com/x")).rejects.toThrow(/不支持的协议/);
  });

  it("throws when a public domain resolves to an internal IP (DNS rebinding)", async () => {
    dnsResolve.mockResolvedValue(["10.0.0.5"]);
    await expect(validateRemoteUrl("https://example.com/x")).rejects.toThrow(/解析到内网地址/);
  });

  it("passes when a public domain resolves to a public IP", async () => {
    dnsResolve.mockResolvedValue(["93.184.216.34"]);
    await expect(validateRemoteUrl("https://example.com/x")).resolves.toBeUndefined();
  });

  it("does not throw on DNS failure (defers to the subsequent network error)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    dnsResolve.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(validateRemoteUrl("https://nonexistent.invalid/x")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("passes for a direct public IP without touching DNS", async () => {
    dnsResolve.mockReset();
    await expect(validateRemoteUrl("https://8.8.8.8/x")).resolves.toBeUndefined();
    expect(dnsResolve).not.toHaveBeenCalled();
  });
});

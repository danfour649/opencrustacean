import { describe, expect, it } from "vitest";
import { resolveEmptyReplyRecovery } from "./empty-reply-recovery.js";
import type { FollowupRun } from "./queue/types.js";

const baseRun = {
  run: {
    sessionKey: "agent:main:test",
    agentId: "main",
  },
  enqueuedAt: Date.now(),
} as unknown as FollowupRun;

const retriedRun = {
  ...baseRun,
  emptyReplyRetry: true,
} as unknown as FollowupRun;

const defaultParams = {
  isInteractive: true,
  isMessageToolOnly: false,
  hasPendingContinuation: false,
  hasExplicitSilentReply: false,
  hasCommittedDelivery: false,
};

describe("resolveEmptyReplyRecovery", () => {
  it("schedules a one-shot retry for an interactive empty run", () => {
    const result = resolveEmptyReplyRecovery({ base: baseRun, ...defaultParams });
    expect(result.kind).toBe("retry");
    if (result.kind === "retry") {
      expect(result.run.emptyReplyRetry).toBe(true);
      expect(result.run.prompt).toContain("without producing a visible reply");
      expect(result.run.disableCollectBatching).toBe(true);
      expect(result.run.run.suppressNextUserMessagePersistence).toBe(true);
    }
  });

  it("does not retry twice: a retried run falls through to the banner", () => {
    const result = resolveEmptyReplyRecovery({ base: retriedRun, ...defaultParams });
    expect(result.kind).toBe("banner");
  });

  it("does not retry when the banner would not be shown (silent expected)", () => {
    const result = resolveEmptyReplyRecovery({
      base: baseRun,
      ...defaultParams,
      silentExpected: true,
    });
    expect(result.kind).toBe("none");
  });

  it("retries on the first configured fallback model when provided", () => {
    const modelRun = {
      ...baseRun,
      run: {
        ...baseRun.run,
        provider: "deepseek",
        model: "deepseek-v4-flash",
      },
    } as unknown as FollowupRun;
    const result = resolveEmptyReplyRecovery({
      base: modelRun,
      ...defaultParams,
      fallbackModels: ["xai/grok-4.3", "claude-cli/claude-sonnet-5"],
    });
    expect(result.kind).toBe("retry");
    if (result.kind === "retry") {
      expect(result.run.run.provider).toBe("xai");
      expect(result.run.run.model).toBe("grok-4.3");
    }
  });

  it("keeps the original model when no fallback models are configured", () => {
    const modelRun = {
      ...baseRun,
      run: {
        ...baseRun.run,
        provider: "deepseek",
        model: "deepseek-v4-flash",
      },
    } as unknown as FollowupRun;
    const result = resolveEmptyReplyRecovery({ base: modelRun, ...defaultParams });
    expect(result.kind).toBe("retry");
    if (result.kind === "retry") {
      expect(result.run.run.provider).toBe("deepseek");
      expect(result.run.run.model).toBe("deepseek-v4-flash");
    }
  });

  it("never overrides a user-locked model choice", () => {
    const lockedRun = {
      ...baseRun,
      run: {
        ...baseRun.run,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        modelSelectionLocked: true,
      },
    } as unknown as FollowupRun;
    const result = resolveEmptyReplyRecovery({
      base: lockedRun,
      ...defaultParams,
      fallbackModels: ["xai/grok-4.3"],
    });
    expect(result.kind).toBe("retry");
    if (result.kind === "retry") {
      expect(result.run.run.provider).toBe("deepseek");
      expect(result.run.run.model).toBe("deepseek-v4-flash");
    }
  });

  it("does not retry heartbeats, message-tool-only, or committed deliveries", () => {
    expect(
      resolveEmptyReplyRecovery({ base: baseRun, ...defaultParams, isHeartbeat: true }).kind,
    ).toBe("none");
    expect(
      resolveEmptyReplyRecovery({ base: baseRun, ...defaultParams, isMessageToolOnly: true }).kind,
    ).toBe("none");
    expect(
      resolveEmptyReplyRecovery({ base: baseRun, ...defaultParams, hasCommittedDelivery: true })
        .kind,
    ).toBe("none");
    expect(
      resolveEmptyReplyRecovery({ base: baseRun, ...defaultParams, isInteractive: false }).kind,
    ).toBe("none");
  });
});

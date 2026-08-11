import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type {
  DispatchReplyWithBufferedBlockDispatcher,
  DispatchReplyWithDispatcher,
} from "../../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import type { RecordInboundSession } from "../session.types.js";
import { dispatchAssembledChannelTurn, dispatchRoutedChannelTurn } from "./lifecycle.js";
import type { ChannelDeliveryInfo } from "./types.js";

const dispatchReplyWithBufferedBlockDispatcherCore = vi.hoisted(() => vi.fn());
const dispatchReplyWithRoutedChannelDispatcherCore = vi.hoisted(() => vi.fn());
const getGlobalHookRunner = vi.hoisted(() => vi.fn());
const claimPreparedPendingFinalDelivery = vi.hoisted(() => vi.fn());
const settlePendingFinalDelivery = vi.hoisted(() => vi.fn());

vi.mock("../../auto-reply/reply/provider-dispatcher.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../auto-reply/reply/provider-dispatcher.js")>();
  return {
    ...actual,
    dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherCore,
  };
});

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessageWithRoutedChannelDispatcher: dispatchReplyWithRoutedChannelDispatcherCore,
  };
});

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/hook-runner-global.js")>();
  return { ...actual, getGlobalHookRunner };
});

vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: vi.fn(async () => []),
}));

vi.mock("../../infra/outbound/delivery-completion.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/delivery-completion.js")>();
  return { ...actual, claimPreparedPendingFinalDelivery, settlePendingFinalDelivery };
});

const cfg: OpenClawConfig = {};

function createCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    CommandAuthorized: false,
    From: "sender",
    To: "target",
    SessionKey: "agent:main:test:peer",
    Provider: "test",
    Surface: "test",
    ...overrides,
  };
}

const recordInboundSession: RecordInboundSession = async () => {};

function pendingCompletion(suffix: string) {
  return {
    context: { channel: "telegram", to: "chat-1", accountId: "acct" },
    createdAt: 100,
    deliveryId: `delivery-${suffix}`,
    intentId: `intent-${suffix}`,
    sessionId: `session-${suffix}`,
    sessionKey: `agent:main:telegram:${suffix}`,
    storePath: "/tmp/sessions.json",
  };
}

describe("channel turn direct delivery custody", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGlobalHookRunner.mockReturnValue(null);
    claimPreparedPendingFinalDelivery.mockImplementation(async (_completion, state: string) => ({
      state,
      applied: true,
    }));
    settlePendingFinalDelivery.mockImplementation(async (_completion, state: string) => ({
      state,
    }));
  });

  it("claims custody after payload rewrites and before platform I/O", async () => {
    const order: string[] = [];
    const completion = pendingCompletion("direct");
    const sourcePayload = setReplyPayloadMetadata(
      { text: "reply" },
      { pendingFinalDeliveryCompletion: completion },
    );
    const dispatch: DispatchReplyWithDispatcher = async (params) => {
      await params.dispatcherOptions.deliver(sourcePayload, { kind: "final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    };
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(dispatch);
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending: vi.fn(async ({ content }: { content: string }) => ({
        content: `${content} + hook`,
      })),
    });
    claimPreparedPendingFinalDelivery.mockImplementation(async (_completion, state: string) => {
      order.push(`settle:${state}`);
      return { state, applied: true };
    });
    settlePendingFinalDelivery.mockImplementation(async (_completion, state: string) => {
      order.push(`settle:${state}`);
      return { state };
    });
    const deliver = vi.fn(async (payload: ReplyPayload, info: ChannelDeliveryInfo) => {
      expect(getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion).toEqual(completion);
      order.push("preflight");
      await info.onPlatformSendDispatch?.();
      order.push("platform");
      return { messageIds: ["direct-1"], visibleReplySent: true };
    });

    await dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      accountId: "acct",
      route: { agentId: "main", sessionKey: completion.sessionKey },
      ctxPayload: createCtx({ Surface: "telegram", OriginatingTo: "chat-1" }),
      delivery: {
        preparePayload: (payload) => ({ ...payload, text: `${payload.text} + prepared` }),
        deliver,
      },
    });

    expect(order).toEqual(["preflight", "settle:queued", "platform", "settle:delivered"]);
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ text: "reply + prepared + hook" });
  });

  it("classifies failures from a legacy adapter that ignores custody", async () => {
    const completion = pendingCompletion("legacy");
    const sourcePayload = setReplyPayloadMetadata(
      { text: "reply" },
      { pendingFinalDeliveryCompletion: completion },
    );
    const dispatch: DispatchReplyWithBufferedBlockDispatcher = async (params) => {
      await params.dispatcherOptions.deliver(sourcePayload, { kind: "final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    };
    const run = (error: Error) =>
      dispatchAssembledChannelTurn({
        cfg,
        agentId: "main",
        storePath: "/tmp/sessions.json",
        channel: "telegram",
        accountId: "acct",
        routeSessionKey: completion.sessionKey,
        ctxPayload: createCtx({ To: "123", OriginatingTo: "123" }),
        recordInboundSession,
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
        delivery: {
          deliver: async () => {
            throw error;
          },
        },
      });

    const preflight = new PlatformMessageNotDispatchedError("legacy preflight failed", {
      cause: new Error("local preflight"),
    });
    await expect(run(preflight)).rejects.toBe(preflight);
    expect(claimPreparedPendingFinalDelivery).not.toHaveBeenCalled();
    expect(settlePendingFinalDelivery).not.toHaveBeenCalled();

    const permanentRejection = new PlatformMessageNotDispatchedError(
      "media-only payload rejected before dispatch",
      { cause: undefined, retryable: false },
    );
    await expect(run(permanentRejection)).rejects.toBe(permanentRejection);
    expect(claimPreparedPendingFinalDelivery).not.toHaveBeenCalled();
    expect(settlePendingFinalDelivery).toHaveBeenCalledExactlyOnceWith(
      { kind: "pending-final", ...completion },
      "suppressed",
    );

    const ambiguous = new Error("legacy adapter failed after entry");
    await expect(run(ambiguous)).rejects.toBe(ambiguous);
    expect(claimPreparedPendingFinalDelivery).toHaveBeenCalledWith(
      { kind: "pending-final", ...completion },
      "queued",
    );
    expect(settlePendingFinalDelivery).toHaveBeenCalledWith(
      { kind: "pending-final", ...completion },
      "unknown",
    );
  });

  it("terminalizes deferred provider failures after direct custody", async () => {
    const completion = pendingCompletion("deferred");
    const payload = setReplyPayloadMetadata(
      { text: "reply" },
      { pendingFinalDeliveryCompletion: completion },
    );
    const dispatch: DispatchReplyWithDispatcher = async (params) => {
      await params.dispatcherOptions.deliver(payload, { kind: "final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    };
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(dispatch);
    const finalizationError = new Error("deferred provider result failed");

    await expect(
      dispatchRoutedChannelTurn({
        cfg,
        channel: "telegram",
        accountId: "acct",
        route: { agentId: "main", sessionKey: completion.sessionKey },
        ctxPayload: createCtx({ Surface: "telegram", OriginatingTo: "chat-1" }),
        delivery: {
          deliver: async (_payload, info) => {
            await info.onPlatformSendDispatch?.();
            return {
              visibleReplySent: false,
              finalization: Promise.reject(finalizationError),
            };
          },
        },
      }),
    ).rejects.toBe(finalizationError);
    expect(claimPreparedPendingFinalDelivery).toHaveBeenCalledWith(
      { kind: "pending-final", ...completion },
      "queued",
    );
    expect(settlePendingFinalDelivery).toHaveBeenCalledWith(
      { kind: "pending-final", ...completion },
      "unknown",
    );
  });
});

import type { FollowupRun } from "./queue/types.js";

const EMPTY_REPLY_RETRY_MARKER = "empty-reply-retry";

const EMPTY_REPLY_RETRY_PROMPT =
  "[System] Your previous turn finished without producing a visible reply. " +
  "Answer the user's last message now with a visible text reply. " +
  "Only call tools if strictly necessary to answer; otherwise reply directly.";

export type EmptyReplyRecovery =
  | { kind: "none" }
  | { kind: "retry"; run: FollowupRun }
  | { kind: "banner" };

/**
 * Resolve the one-shot auto-recovery for an interactive run that finished
 * without producing a visible reply. The guard mirrors
 * buildEmptyInteractiveReplyPayload: when the no-visible-reply banner would be
 * shown and this run has not already been retried, schedule a nudge retry
 * instead. A second empty run falls through to the banner.
 */
export function resolveEmptyReplyRecovery(params: {
  base: FollowupRun;
  isInteractive: boolean;
  isHeartbeat?: boolean;
  silentExpected?: boolean;
  allowEmptyAssistantReplyAsSilent?: boolean;
  isMessageToolOnly: boolean;
  hasPendingContinuation: boolean;
  hasExplicitSilentReply: boolean;
  hasCommittedDelivery: boolean;
  /** Configured fallback model refs (\"provider/model\"); the retry prefers the
   * first one so a model that habitually ends turns empty is not re-run as-is. */
  fallbackModels?: readonly string[];
}): EmptyReplyRecovery {
  if (
    !params.isInteractive ||
    params.isHeartbeat === true ||
    params.silentExpected === true ||
    params.allowEmptyAssistantReplyAsSilent === true ||
    params.isMessageToolOnly ||
    params.hasPendingContinuation ||
    params.hasExplicitSilentReply ||
    params.hasCommittedDelivery
  ) {
    return { kind: "none" };
  }
  // The one-shot recovery has already been spent (by this mechanism or the
  // stranded-reply mechanism): never stack a second retry on top of a retry.
  if (params.base.emptyReplyRetry === true || params.base.strandedReplyRetry === true) {
    return { kind: "banner" };
  }
  return {
    kind: "retry",
    run: buildEmptyReplyRetryFollowupRun(params.base, params.fallbackModels),
  };
}

function resolveEmptyReplyFallbackRef(
  base: FollowupRun,
  fallbackModels: readonly string[] | undefined,
): { provider: string; model: string } | undefined {
  // Never override a user-locked model choice; the pipeline fallback surface
  // only applies to auto-selected models.
  if (base.run.modelSelectionLocked === true) {
    return undefined;
  }
  const ref = fallbackModels?.find((candidate) => candidate.includes("/"));
  if (!ref) {
    return undefined;
  }
  const slash = ref.indexOf("/");
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

function buildEmptyReplyRetryFollowupRun(
  base: FollowupRun,
  fallbackModels: readonly string[] | undefined,
): FollowupRun {
  const run = { ...base.run, suppressNextUserMessagePersistence: true };
  const fallbackRef = resolveEmptyReplyFallbackRef(base, fallbackModels);
  if (fallbackRef) {
    run.provider = fallbackRef.provider;
    run.model = fallbackRef.model;
  }
  return {
    ...base,
    prompt: EMPTY_REPLY_RETRY_PROMPT,
    summaryLine: EMPTY_REPLY_RETRY_MARKER,
    emptyReplyRetry: true,
    disableCollectBatching: true,
    transcriptPrompt: undefined,
    userTurnTranscriptRecorder: undefined,
    currentInboundContext: undefined,
    turnAdoptionLifecycle: undefined,
    run,
  };
}

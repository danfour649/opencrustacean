// Durable rolling transcript for the machine-wide OpenClaw conversation.
import { randomUUID } from "node:crypto";
import { createSqliteAuditRecordStore } from "../infra/sqlite-audit-record-store.js";

type SystemAgentTranscriptEntry = {
  role: "user" | "assistant" | "reset";
  text: string;
  at: number;
  sessionId?: string;
};

type StoredSystemAgentTranscriptEntry = Omit<SystemAgentTranscriptEntry, "sessionId">;

type SystemAgentTranscriptTurn = {
  role: "user" | "assistant";
  text: string;
  at: number;
};

const SYSTEM_AGENT_TRANSCRIPT_SCOPE = "system-agent-transcript";
const SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES = 1_000;
const SYSTEM_AGENT_TRANSCRIPT_SESSION_KEY_PREFIX = "session:";

function openTranscriptStore(env?: NodeJS.ProcessEnv) {
  return createSqliteAuditRecordStore<StoredSystemAgentTranscriptEntry>({
    scope: SYSTEM_AGENT_TRANSCRIPT_SCOPE,
    maxEntries: SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES,
    ...(env ? { env } : {}),
  });
}

function createTranscriptEntryKey(turn: SystemAgentTranscriptEntry): string {
  const suffix = `${turn.at}:${randomUUID()}`;
  return turn.sessionId
    ? `${SYSTEM_AGENT_TRANSCRIPT_SESSION_KEY_PREFIX}${Buffer.from(turn.sessionId, "utf8").toString("base64url")}:${suffix}`
    : suffix;
}

function readTranscriptSessionId(key: string): string | undefined {
  if (!key.startsWith(SYSTEM_AGENT_TRANSCRIPT_SESSION_KEY_PREFIX)) {
    return undefined;
  }
  const encoded = key.slice(SYSTEM_AGENT_TRANSCRIPT_SESSION_KEY_PREFIX.length).split(":", 1)[0];
  if (!encoded) {
    return undefined;
  }
  const sessionId = Buffer.from(encoded, "base64url").toString("utf8");
  return sessionId && Buffer.from(sessionId, "utf8").toString("base64url") === encoded
    ? sessionId
    : undefined;
}

/** Append one already-sanitized engine history turn to the rolling logbook. */
export function appendTranscriptTurn(
  turn: SystemAgentTranscriptEntry,
  opts: { env?: NodeJS.ProcessEnv } = {},
): void {
  const { sessionId: _sessionId, ...storedTurn } = turn;
  // Keep session attribution in the audit key, not the payload. Released readers
  // return payloads verbatim, so adding fields there would break downgrade responses.
  openTranscriptStore(opts.env).register(createTranscriptEntryKey(turn), storedTurn, turn.at);
}

/** Mark a durable context boundary without deleting earlier logbook rows. */
export function appendTranscriptReset(
  opts: { env?: NodeJS.ProcessEnv; sessionId?: string } = {},
): void {
  appendTranscriptTurn(
    {
      role: "reset",
      text: "",
      at: Date.now(),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    },
    opts,
  );
}

/**
 * Read the newest window in conversational (oldest-first) order. Markers are
 * never exposed; seeding may additionally start after the newest marker.
 */
export function readTranscriptTail(
  limit: number,
  opts: { afterLastReset?: boolean; env?: NodeJS.ProcessEnv; sessionId?: string } = {},
): SystemAgentTranscriptTurn[] {
  if (limit <= 0) {
    return [];
  }
  const readLimit = opts.sessionId ? SYSTEM_AGENT_TRANSCRIPT_MAX_ENTRIES : limit;
  const entries = openTranscriptStore(opts.env)
    .latest({ limit: readLimit })
    .toReversed()
    .map((entry) => ({ ...entry.value, sessionId: readTranscriptSessionId(entry.key) }));
  // New reset markers fence only their owning session. Legacy unattributed markers
  // remain global so upgraded installs preserve the old machine-wide boundary.
  const resetIndex = opts.afterLastReset
    ? entries.findLastIndex(
        (turn) =>
          turn.role === "reset" &&
          (opts.sessionId === undefined ||
            turn.sessionId === undefined ||
            turn.sessionId === opts.sessionId),
      )
    : -1;
  const window = opts.afterLastReset ? entries.slice(resetIndex + 1) : entries;
  return window
    .filter(
      (turn): turn is SystemAgentTranscriptEntry & { role: "user" | "assistant" } =>
        turn.role !== "reset" && (!opts.sessionId || turn.sessionId === opts.sessionId),
    )
    .slice(-limit)
    .map(({ role, text, at }) => ({ role, text, at }));
}

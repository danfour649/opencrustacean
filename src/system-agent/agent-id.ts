import { normalizeAgentId } from "../routing/session-key.js";

export const SYSTEM_AGENT_ID = "openclaw";

export const SYSTEM_AGENT_ROSTER_ENTRIES = [
  { id: SYSTEM_AGENT_ID, kind: "system" },
  { id: "crestodian", kind: "system" },
] as const;

// The product name itself is reserved so no agent can squat on it.
const RESERVED_PRODUCT_AGENT_ID = "opencrustacean";

const RESERVED_SYSTEM_AGENT_IDS = new Set([
  ...SYSTEM_AGENT_ROSTER_ENTRIES.map((entry) => normalizeAgentId(entry.id)),
  normalizeAgentId(RESERVED_PRODUCT_AGENT_ID),
]);

export function isReservedSystemAgentId(agentId: string): boolean {
  return RESERVED_SYSTEM_AGENT_IDS.has(normalizeAgentId(agentId));
}

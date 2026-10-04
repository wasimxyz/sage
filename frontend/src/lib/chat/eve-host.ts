import type { ChatAgentStatusKind } from "@/bridge";

export const packagedEveHost = "http://127.0.0.1:2001";

export const eveHealthPollMs = 4000;
export const eveStartupPollMs = 250;
export const eveStartupGraceMs = 8000;

const packagedDownMessage = "Sage could not start the Chat agent.";

const devDownMessage =
  "The Chat agent isn't running. Start it with npm --prefix agent run dev.";

export type AgentHealth =
  | { kind: "checking" }
  | { kind: "down"; message: string }
  | { kind: "ready" };

/** The `chat.agent` status, or null where Sage owns no port of its own. */
export type SidecarStatus = ChatAgentStatusKind | null;

export interface AgentHealthInput {
  downMessage: string;
  graceMs?: number;
  healthOk: boolean;
  nowMs: number;
  sidecar: SidecarStatus;
  startedAtMs: number;
}

/**
 * A packaged build is ready only when `chat.agent` reports `ready` and health
 * answers `{ "ok": true }`. Health is public, so another program bound to 2001
 * can answer it; the status is what proves Sage started the process that
 * answers Chat. `sidecar` is null in `make dev`, where the agent starts on its
 * own and health decides.
 */
export function agentHealthDecision(input: AgentHealthInput): AgentHealth {
  if (input.sidecar !== null && input.sidecar !== "ready") {
    return { kind: "down", message: input.downMessage };
  }
  if (input.healthOk) {
    return { kind: "ready" };
  }
  const graceMs = input.graceMs ?? eveStartupGraceMs;
  if (input.sidecar === "ready" && input.nowMs - input.startedAtMs < graceMs) {
    return { kind: "checking" };
  }
  return { kind: "down", message: input.downMessage };
}

export function sameAgentHealth(
  left: AgentHealth,
  right: AgentHealth
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "down" && right.kind === "down") {
    return left.message === right.message;
  }
  return true;
}

export function eveHost(): string {
  return import.meta.env.DEV ? "" : packagedEveHost;
}

export function withChatAuthorization(
  headers: Record<string, string>,
  token: string | null
): Record<string, string> {
  if (token === null || token.length === 0) {
    return headers;
  }
  return {
    ...headers,
    authorization: `Bearer ${token}`,
  };
}

export function eveHealthUrl(): string {
  return `${eveHost()}/eve/v1/health`;
}

export function agentDownMessage(packagedMessage?: string): string {
  if (import.meta.env.DEV) {
    return devDownMessage;
  }
  if (packagedMessage !== undefined && packagedMessage.length > 0) {
    return packagedMessage;
  }
  return packagedDownMessage;
}

export function isEveHealthOk(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "ok" in body &&
    (body as { ok: unknown }).ok === true
  );
}

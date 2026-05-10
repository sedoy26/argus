// In-memory event log for the Argus signal-api.
//
// Every interesting action (signal received, score escalation, guardian
// trigger) appends a typed Event to a ring buffer. The dashboard polls
// GET /events to render the live activity feed.
//
// Ring size: last 200 events — more than enough for any demo session.

export type EventKind =
  | 'signal_received'   // a watcher submitted a signal
  | 'score_changed'     // TEE consensus score escalated or changed
  | 'guardian_trigger'  // score crossed threshold — guardian revokes approvals
  | 'tx_blocked'        // SWAT-004 phishing TX intercepted before broadcast
  | 'boot'              // applet boot info snapshot
  | 'info';             // generic informational message

export interface ArgusEvent {
  id: number;
  ts: number;          // unix millis
  kind: EventKind;
  /** Short one-liner for the feed. */
  message: string;
  /** Structured detail — varies per kind. */
  detail: Record<string, unknown>;
}

const RING_SIZE = 200;
const ring: ArgusEvent[] = [];
let nextId = 1;

export function emit(kind: EventKind, message: string, detail: Record<string, unknown> = {}): ArgusEvent {
  const ev: ArgusEvent = { id: nextId++, ts: Date.now(), kind, message, detail };
  ring.push(ev);
  if (ring.length > RING_SIZE) ring.shift();
  return ev;
}

/** Return events newer than `afterId` (inclusive if afterId===0). */
export function since(afterId: number): ArgusEvent[] {
  if (afterId === 0) return [...ring];
  const idx = ring.findIndex((e) => e.id > afterId);
  if (idx < 0) return [];
  return ring.slice(idx);
}

/** Latest snapshot of the event log (for initial page load). */
export function latest(n = 50): ArgusEvent[] {
  return ring.slice(-n);
}

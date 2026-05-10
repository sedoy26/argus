// Mirrors the wire types served by signal-api + ens-resolver gateway.

export type Score = 'NONE' | 'YELLOW' | 'ORANGE' | 'RED' | 'CRITICAL';

export interface ConsensusEnvelope {
  score: Score;
  confidence: number;
  count: number;
  confirmed: number;
  addr: string;
  summary: string;
  last_signal_ts: number;
  applet_ts_ns: number;
  code_hash: string;
  boot_commitment: string;
  attestation: string;
}

export interface BootInfo {
  boot_commitment: string;
  code_hash: string;
  code_hash_input: string;
  boot_ts_ns: number;
  now_ns: number;
  signal_count: number;
  max_signals: number;
}

export interface HealthInfo {
  status: 'ok' | 'unreachable';
  bridge: string;
}

export interface GatewayPreview {
  addr: string;
  records: Record<string, string>;
  envelope?: ConsensusEnvelope;
}

export type EventKind =
  | 'signal_received'
  | 'score_changed'
  | 'guardian_trigger'
  | 'tx_blocked'
  | 'boot'
  | 'info';

export interface ArgusEvent {
  id: number;
  ts: number;
  kind: EventKind;
  message: string;
  detail: Record<string, unknown>;
}

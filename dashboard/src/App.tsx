import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPublicClient, http, type Abi } from 'viem';
import { getEnsText } from 'viem/actions';
import { normalize } from 'viem/ens';
import { sepolia } from 'viem/chains';
import {
  buildAdminDemoResetMessage,
  buildAdminModerationMessage,
  buildEnrollmentSignMessage,
  connectWithEthereumProvider,
  revokeWalletConnection,
  getAccess,
  getAuthNonce,
  adminDecideEnrollment,
  adminListEnrollments,
  getBoot,
  getEvents,
  getHealth,
  getPreview,
  getRisk,
  postDemoReset,
  submitEnrollmentRequest,
  submitIntel,
  createSocialAgent,
  deleteSocialAgent,
  listSocialAgents,
  walletPersonalSign,
  type AccessInfo,
  type EnrollmentRow,
  type IntelResult,
  type SocialAgentRow,
} from './api';
import type {
  ArgusEvent,
  BootInfo,
  ConsensusEnvelope,
  EventKind,
  GatewayPreview,
  HealthInfo,
  Score,
} from './types';
import { AppBackdrop, BrandMark, ParallaxLogo } from './ui/AppShell';
import {
  clearActiveEthereumProvider,
  discoverWalletOptions,
  getActiveEthereumProvider,
  setActiveEthereumProvider,
  type WalletOption,
} from './walletProvider';

// ---------------------------------------------------------------------------
// ArgusRegistry on-chain client
// ---------------------------------------------------------------------------

const REGISTRY_ADDRESS = '0xc91Ed23CF4945b26a4ff510295A105677D66F1EB' as const;
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

const REGISTRY_ABI = [
  { name: 'allAgents', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'tuple[]', components: [
    { name: 'addr', type: 'address' },
    { name: 'role', type: 'uint8' },
    { name: 'status', type: 'uint8' },
    { name: 'ensName', type: 'string' },
    { name: 'specialty', type: 'string' },
    { name: 'reputation', type: 'uint256' },
    { name: 'signalCount', type: 'uint256' },
    { name: 'registeredAt', type: 'uint256' },
    { name: 'approvedAt', type: 'uint256' },
  ]}] },
  { name: 'approveAgent', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'agent', type: 'address' }], outputs: [] },
  { name: 'revokeAgent',  type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'agent', type: 'address' }, { name: 'reason', type: 'string' }], outputs: [] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const satisfies Abi;

const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });

type RegistryAgent = {
  addr: string; role: number; status: number; ensName: string; specialty: string;
  reputation: bigint; signalCount: bigint; registeredAt: bigint; approvedAt: bigint;
};

const ROLE_LABEL = ['Scout', 'Guardian', 'Watcher'];
const STATUS_LABEL = ['Pending', 'Active', 'Revoked'];
const STATUS_COLOR = [
  'bg-amber-400/20 text-amber-300 border-amber-400/30',
  'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  'bg-zinc-700/40 text-zinc-500 border-zinc-600/30',
];
const ROLE_COLOR = ['text-sky-300', 'text-rose-300', 'text-purple-300'];

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const WALLET_SESSION = 'argus.wallet';
/** Session key for EIP-6963 wallet uuid or legacy-* / window-ethereum (re-binds signing to the same extension). */
const WALLET_PROVIDER_ID = 'argus.walletProviderId';
const ADDON_SOCIAL_SCOUT = 'argus.addon.socialScout';
const WATCHED_KEY = 'argus.watched.v2';
const DEMO_CONTRACT = '0x3b38fe80891ec608829e941ef965e1c96d3460d6';
const DEMO_CONTRACT_NAME = 'FakeSwapNet';

/** Wildcard parent for `[addr].<parent>` ENS CCIP (set to your deployed risks zone). */
const ARGUS_ENS_RISK_PARENT =
  import.meta.env.VITE_ARGUS_ENS_PARENT ?? 'risks.argus-security.eth';

const DEFAULT_WATCHED: string[] = [DEMO_CONTRACT];

function loadWatched(): string[] {
  try {
    const raw = localStorage.getItem(WATCHED_KEY);
    if (!raw) return DEFAULT_WATCHED;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return DEFAULT_WATCHED;
    return arr.filter((s): s is string => typeof s === 'string' && ADDR_RE.test(s));
  } catch {
    return DEFAULT_WATCHED;
  }
}
function saveWatched(list: string[]): void {
  localStorage.setItem(WATCHED_KEY, JSON.stringify(list));
}

// ---------------------------------------------------------------------------
// score helpers
// ---------------------------------------------------------------------------

const SCORE_ORDER: Record<Score, number> = { NONE: 0, YELLOW: 1, ORANGE: 2, RED: 3, CRITICAL: 4 };

const SCORE_BG: Record<Score, string> = {
  NONE: 'bg-zinc-700/40 text-zinc-300 ring-zinc-600/40',
  YELLOW: 'bg-amber-400/20 text-amber-200 ring-amber-300/40',
  ORANGE: 'bg-orange-400/25 text-orange-200 ring-orange-300/40',
  RED: 'bg-rose-500/30 text-rose-200 ring-rose-400/40',
  CRITICAL: 'bg-red-500/40 text-red-100 ring-red-300/60 animate-pulse',
};

const SCORE_PILL: Record<string, string> = {
  NONE: 'bg-zinc-700 text-zinc-300',
  YELLOW: 'bg-amber-400/80 text-zinc-900',
  ORANGE: 'bg-orange-400/80 text-zinc-900',
  RED: 'bg-rose-500/80 text-white',
  CRITICAL: 'bg-red-600 text-white animate-pulse',
};

function ScoreBadge({ score }: { score: Score }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${SCORE_BG[score]}`}>
      {score}
    </span>
  );
}

function Hex({ value, len = 8 }: { value: string; len?: number }) {
  if (!value) return <span className="text-zinc-500">—</span>;
  if (value.length < len * 2 + 2) return <span className="mono">{value}</span>;
  return (
    <span title={value} className="mono cursor-help" onClick={() => navigator.clipboard.writeText(value)}>
      {value.slice(0, 2 + len)}…{value.slice(-len)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

function usePoll<T>(fetcher: () => Promise<T>, intervalMs: number, deps: React.DependencyList) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  const refetch = useCallback(async () => {
    try {
      setData(await fetchRef.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    let active = true;
    void (async () => {
      while (active) { await refetch(); await new Promise((r) => setTimeout(r, intervalMs)); }
    })();
    return () => { active = false; };
  }, [refetch, intervalMs]);

  return { data, error, refetch };
}

interface RiskState {
  envelope?: ConsensusEnvelope;
  preview?: GatewayPreview | null;
  error?: string;
  fetchedAt: number;
}

function useRisks(addresses: string[]) {
  const [risks, setRisks] = useState<Record<string, RiskState>>({});

  const refetchAll = useCallback(() => {
    addresses.forEach((addr) => {
      void Promise.all([getRisk(addr), getPreview(addr)]).then(
        ([envelope, preview]) => setRisks((r) => ({ ...r, [addr]: { envelope, preview, fetchedAt: Date.now() } })),
        (err) => setRisks((r) => ({ ...r, [addr]: { ...r[addr], error: (err as Error).message, fetchedAt: Date.now() } })),
      );
    });
  }, [addresses]);

  useEffect(() => {
    refetchAll();
    const t = setInterval(refetchAll, 3000);
    return () => clearInterval(t);
  }, [refetchAll]);

  return { risks, refetchAll };
}

function useEvents(refreshKey: number) {
  const [events, setEvents] = useState<ArgusEvent[]>([]);
  const latestId = useRef(0);

  useEffect(() => {
    let active = true;
    latestId.current = 0;
    setEvents([]);

    const poll = async () => {
      while (active) {
        try {
          const evs = await getEvents(latestId.current > 0 ? latestId.current : undefined);
          if (evs.length > 0) {
            latestId.current = evs[evs.length - 1]!.id;
            setEvents((prev) => {
              const existing = new Set(prev.map((e) => e.id));
              const fresh = evs.filter((e) => !existing.has(e.id));
              if (fresh.length === 0) return prev;
              const next = [...prev, ...fresh];
              return next.length > 150 ? next.slice(-150) : next;
            });
          }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 1500));
      }
    };
    void poll();
    return () => { active = false; };
  }, [refreshKey]);

  return events;
}

// ---------------------------------------------------------------------------
// shared small components
// ---------------------------------------------------------------------------

const KIND_ICON: Record<EventKind, string> = {
  signal_received: '📡',
  score_changed: '📊',
  guardian_trigger: '🛡️',
  tx_blocked: '⛔',
  boot: '🔧',
  info: 'ℹ️',
};
const KIND_COLOR: Record<EventKind, string> = {
  signal_received: 'text-sky-300 border-sky-500/30 bg-sky-500/10',
  score_changed: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
  guardian_trigger: 'text-rose-300 border-rose-500/40 bg-rose-500/15',
  tx_blocked: 'text-orange-300 border-orange-500/40 bg-orange-500/10',
  boot: 'text-zinc-400 border-zinc-600/30 bg-zinc-700/20',
  info: 'text-zinc-400 border-zinc-600/30 bg-zinc-700/10',
};

/** Plain-language detail shown when an event row is expanded. */
function EventExplainer({ ev }: { ev: ArgusEvent }) {
  const d = ev.detail;
  const lines: string[] = [];
  switch (ev.kind) {
    case 'signal_received': {
      const addr = String(d.address ?? '').toLowerCase();
      lines.push(
        `An Argus agent published a signed intelligence signal for contract ${addr.slice(0, 10)}…${addr.slice(-6)}.`,
        `Submitter: ${String(d.submitter ?? '—')}. Verdict: ${String(d.verdict ?? '—')}. Threat type: ${String(d.threatType ?? '—')}.`,
        'Signals are hashed and fed into the TEE consensus engine; multiple corroborating agents increase the risk score.',
      );
      if (d.reputation != null) lines.push(`Agent reputation attached to this signal: ${String(d.reputation)}/100.`);
      if (d.evidence_hash) lines.push(`Evidence hash: ${String(d.evidence_hash).slice(0, 18)}… (canonical JSON of the finding).`);
      break;
    }
    case 'score_changed': {
      lines.push(
        `TEE consensus updated the risk ladder for ${String(d.address ?? '').slice(0, 10)}… based on how many independent CONFIRMED signals Argus has seen.`,
        `Confirmed: ${String(d.confirmed ?? '?')} of ${String(d.count ?? '?')} total. A higher score means more independent agreement on a real threat.`,
      );
      if (d.attestation) lines.push(`Latest attestation fingerprint: ${String(d.attestation).slice(0, 20)}…`);
      break;
    }
    case 'guardian_trigger': {
      lines.push(
        'The risk score crossed the automatic protection threshold. The Guardian agent is now sending on-chain transactions to set affected token approvals to zero.',
        'Signing uses Space KMS where configured, so the revocation key is not held on this laptop.',
      );
      break;
    }
    case 'tx_blocked': {
      lines.push(
        'SWAT-004: before a suspicious swap could broadcast, Argus simulated the transaction against Sourcify verification and TEE risk data.',
        'Phishing sites often point at contracts that are not verified like the real Uniswap router; that mismatch alone can block the tx.',
        'This path does not revoke your existing DEX approvals — it only blocks this one malicious interaction.',
      );
      if (d.nonce) lines.push(`Attestation nonce: ${String(d.nonce).slice(0, 22)}… (replay-resistant proof bundle).`);
      break;
    }
    case 'boot': {
      lines.push('The signal-api service (or TEE bridge) started or reconnected. Boot metadata is shown for audit trails.');
      break;
    }
    case 'info': {
      if (d.x402) {
        lines.push(
          'Apify X402: the scout paid for this actor run with USDC on Base (ERC-3009 TransferWithAuthorization).',
          d.apifySettlementTx
            ? `Settlement reference: ${String(d.apifySettlementTx).slice(0, 28)}…`
            : 'Payment completed per Apify X402 headers (see Apify console for settlement tx when present).',
        );
      } else if (d.space_kms_signed || d.signed_via === 'space_kms') {
        lines.push(
          'Guardian revocation was signed inside SpaceComputer Orbitport KMS — the operator never saw the raw secp256k1 key.',
          'Configure ORBITPORT_CLIENT_ID, ORBITPORT_CLIENT_SECRET, and KMS_KEY_ID on the guardian; set ARGUS_TELEMETRY_SECRET on signal-api to ingest this line into the feed.',
        );
      } else if (d.sourcifyVerificationUrl) {
        lines.push(
          `Sourcify.dev contract API: ${String(d.sourcifyVerificationUrl)}`,
          'Full / partial matches include creation bytecode metadata and ABI — Argus uses that structured data, not only raw source text.',
        );
      } else {
        lines.push('Platform activity. See the message above for the exact operation.');
      }
      break;
    }
    default: {
      lines.push('Platform activity. See the message above for the exact operation.');
    }
  }
  return (
    <div className="mt-2.5 pt-2.5 border-t border-white/10 space-y-1.5 text-[11px] leading-relaxed text-(--color-argus-muted)">
      {lines.map((t, i) => (
        <p key={i}>{t}</p>
      ))}
    </div>
  );
}

function EventRow({ ev }: { ev: ArgusEvent }) {
  const [open, setOpen] = useState(false);
  const color = KIND_COLOR[ev.kind];
  const icon = KIND_ICON[ev.kind];
  const time = new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const d = ev.detail;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setOpen((v) => !v);
        }
      }}
      className={`rounded-xl border px-3 py-2.5 text-xs ${color} transition-all duration-200 cursor-pointer select-none hover:bg-black/20 hover:scale-[1.008] hover:shadow-md motion-reduce:hover:scale-100 ${open ? 'ring-1 ring-amber-400/25 shadow-md' : ''}`}
    >
      <div className="flex items-start gap-2">
        <span className="text-base leading-none mt-0.5 shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="font-medium break-all leading-snug pr-1">{ev.message}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[9px] uppercase tracking-wide opacity-50 hidden sm:inline">{open ? 'less' : 'more'}</span>
              <span className="text-[10px] opacity-50 w-4 text-center">{open ? '▼' : '▶'}</span>
              <span className="text-[10px] opacity-60 mono">{time}</span>
            </div>
          </div>
          {ev.kind === 'signal_received' && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 opacity-80">
              <span className="mono opacity-70">{String(d.submitter ?? '')}</span>
              {d.score != null && (
                <span className={`inline-block rounded px-1.5 py-0 text-[10px] font-bold ${SCORE_PILL[String(d.score)] ?? 'bg-zinc-700'}`}>
                  {String(d.score)}
                </span>
              )}
              <span className="opacity-60">rep:{String(d.reputation ?? '?')}</span>
            </div>
          )}
          {ev.kind === 'score_changed' && (
            <div className="mt-1 flex items-center gap-2 flex-wrap opacity-80">
              <span className={`inline-block rounded px-1.5 py-0 text-[10px] font-bold ${SCORE_PILL[String(d.prev)] ?? 'bg-zinc-700'}`}>
                {String(d.prev ?? 'NONE')}
              </span>
              <span className="opacity-50">→</span>
              <span className={`inline-block rounded px-1.5 py-0 text-[10px] font-bold ${SCORE_PILL[String(d.score)] ?? 'bg-zinc-700'}`}>
                {String(d.score)}
              </span>
              <span className="opacity-60 mono text-[10px]">attest:{String(d.attestation ?? '').slice(0, 12)}…</span>
            </div>
          )}
          {ev.kind === 'guardian_trigger' && (
            <div className="mt-1 opacity-80 font-semibold">
              revoking all approvals for{' '}
              <span className="mono">{String(d.address ?? '').slice(0, 10)}…</span>
            </div>
          )}
          {ev.kind === 'tx_blocked' && (() => {
            const verified = d.sourcify_match != null && d.sourcify_match !== 'null';
            return (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 opacity-80">
              <span className="font-semibold">SWAT-004</span>
              <span>
                Sourcify:{' '}
                <span className={`font-medium ${verified ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {verified ? String(d.sourcify_match) : 'NOT VERIFIED'}
                </span>
              </span>
              <span>
                TEE:{' '}
                <span className="font-mono">{String(d.score ?? 'NONE')}</span>
              </span>
              <span className="text-emerald-400 font-medium">· funds protected</span>
            </div>
            );
          })()}
          {ev.kind === 'info' && (d.space_kms_signed === true || d.signed_via === 'space_kms') && (
            <div className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 border border-emerald-400/35 px-2 py-0.5 text-[10px] font-semibold text-emerald-100">
              Signed via Space KMS ✓
            </div>
          )}
          {ev.kind === 'info' && d.x402 === true && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="inline-flex rounded-full bg-amber-500/15 border border-amber-400/35 px-2 py-0.5 text-[10px] font-semibold text-amber-50">
                Apify X402 (USDC on Base) ✓
              </span>
              {typeof d.apifySettlementTx === 'string' && d.apifySettlementTx.length > 6 && (
                <span className="mono text-[10px] text-(--color-argus-muted) truncate max-w-[200px]" title={String(d.apifySettlementTx)}>
                  settlement {String(d.apifySettlementTx).slice(0, 20)}…
                </span>
              )}
            </div>
          )}
          {open && <EventExplainer ev={ev} />}
        </div>
      </div>
    </div>
  );
}

function EventFeed({ events, filter }: { events: ArgusEvent[]; filter?: EventKind[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const visible = filter ? events.filter((e) => filter.includes(e.kind)) : events;

  useEffect(() => {
    if (autoScroll && bottomRef.current) bottomRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [visible, autoScroll]);

  return (
    <section className="flex flex-col glass-surface glass-surface-hover overflow-hidden motion-safe:hover:-translate-y-0.5">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs font-semibold uppercase tracking-wider text-(--color-argus-muted)">live event feed</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-(--color-argus-muted)">
          <span className="hidden sm:inline opacity-70">click row · more</span>
          <span>{visible.length} events</span>
          <button
            onClick={() => setAutoScroll((v) => !v)}
            className={`rounded px-1.5 py-0.5 border ${autoScroll ? 'border-emerald-500/40 text-emerald-400' : 'border-(--color-argus-border)'}`}
          >
            {autoScroll ? '⬇ auto' : 'manual'}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto max-h-[420px] p-3 space-y-2">
        {visible.length === 0 && (
          <div className="text-xs text-(--color-argus-muted) text-center py-8">
            waiting for events…
          </div>
        )}
        {visible.map((ev) => <EventRow key={ev.id} ev={ev} />)}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// landing
// ---------------------------------------------------------------------------

function LandingPage({ onConnect }: { onConnect: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const glowRaf = useRef<number | null>(null);
  const glowPos = useRef<{ x: number; y: number } | null>(null);

  const flushLandingGlow = useCallback(() => {
    glowRaf.current = null;
    const glow = glowRef.current;
    const p = glowPos.current;
    if (!glow || !p) return;
    glow.style.background = `radial-gradient(ellipse 420px 360px at ${p.x}px ${p.y}px, rgba(255, 252, 245, 0.038) 0%, rgba(251, 211, 141, 0.016) 42%, rgba(186, 210, 253, 0.009) 58%, transparent 82%)`;
  }, []);

  const onLandingCardMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    glowPos.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (glowRaf.current == null) {
      glowRaf.current = requestAnimationFrame(flushLandingGlow);
    }
  };

  const onLandingCardEnter = () => {
    const glow = glowRef.current;
    if (glow) glow.style.opacity = '1';
  };

  const onLandingCardLeave = () => {
    glowPos.current = null;
    if (glowRaf.current != null) {
      cancelAnimationFrame(glowRaf.current);
      glowRaf.current = null;
    }
    const glow = glowRef.current;
    if (glow) {
      glow.style.opacity = '0';
      glow.style.background = 'transparent';
    }
  };

  return (
    <div className="relative min-h-screen text-(--color-argus-text) flex flex-col items-center justify-center px-6 py-16 overflow-hidden">
      <AppBackdrop />
      <div className="relative z-10 w-full max-w-md">
        <div
          ref={cardRef}
          className="glass-surface glass-landing-card relative overflow-hidden px-8 py-10 text-center space-y-7 motion-safe:hover:-translate-y-0.5"
          onMouseMove={onLandingCardMove}
          onMouseEnter={onLandingCardEnter}
          onMouseLeave={onLandingCardLeave}
        >
          <div ref={glowRef} className="glass-landing-spotlight" aria-hidden />
          <div className="relative z-10 space-y-7">
            <ParallaxLogo className="h-44 w-44 sm:h-48 sm:w-48" intensity={26} />
            <div>
              <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-amber-100 via-amber-300 to-amber-600 bg-clip-text text-transparent">
                Argus
              </h1>
              <p className="mt-1 text-xs uppercase tracking-[0.2em] text-(--color-argus-gold-dim)">hundred-eyed guardian</p>
            </div>
            <p className="text-sm text-(--color-argus-muted) leading-relaxed text-left">
              In myth, Argus never slept — a hundred eyes, none ever closed. Our network doesn&apos;t sleep either.
              Independent watchers scan every contract you&apos;ve touched, verified by tamper-proof code no one controls.
              The moment something turns dangerous, your wallet is already protected.
            </p>
            <p className="text-sm font-medium text-(--color-argus-text)/90 leading-snug">
              Connect your wallet. See what Argus sees.
            </p>
            {err && (
              <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-400/25 rounded-xl px-3 py-2 backdrop-blur-sm">
                {err}
              </div>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  setErr('');
                  try {
                    await onConnect();
                  } catch (e) {
                    setErr((e as Error).message ?? 'connect failed');
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
              className="glass-cta w-full px-8 py-3.5 rounded-xl text-zinc-950 font-semibold text-sm disabled:opacity-40"
            >
              {busy ? 'Opening wallet…' : 'Connect your wallet'}
            </button>
            <p className="text-[11px] text-(--color-argus-muted)">Sepolia testnet · MetaMask or any injected wallet</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function WalletPickerModal({
  choices,
  error,
  onPick,
  onClose,
}: {
  choices: WalletOption[];
  error: string;
  onPick: (w: WalletOption) => Promise<void>;
  onClose: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
      <button
        type="button"
        className="absolute inset-0 glass-modal-backdrop"
        aria-label="Close"
        onClick={() => {
          if (!busyId) onClose();
        }}
      />
      <div className="relative z-10 glass-modal-panel max-w-sm w-full p-6 space-y-4 shadow-2xl">
        <div className="flex justify-between items-start gap-3">
          <h2 className="text-sm font-semibold text-(--color-argus-text)">Choose a wallet</h2>
          <button
            type="button"
            disabled={!!busyId}
            className="text-xs text-(--color-argus-muted) hover:text-zinc-200 disabled:opacity-40"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
        <p className="text-xs text-(--color-argus-muted) leading-relaxed">
          Multiple extensions were detected. Pick the one you want for signing and transactions (e.g. MetaMask for a normal-user flow).
        </p>
        {error ? (
          <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-400/25 rounded-xl px-3 py-2">{error}</div>
        ) : null}
        <ul className="space-y-2 max-h-[min(52vh,360px)] overflow-y-auto pr-1">
          {choices.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                disabled={!!busyId}
                onClick={() => {
                  void (async () => {
                    setBusyId(w.id);
                    try {
                      await onPick(w);
                    } finally {
                      setBusyId(null);
                    }
                  })();
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-white/10 hover:bg-(--color-argus-card) text-left transition disabled:opacity-45"
              >
                {w.icon ? (
                  <img src={w.icon} alt="" className="h-9 w-9 rounded-lg shrink-0 bg-zinc-900" />
                ) : (
                  <div className="h-9 w-9 rounded-lg bg-zinc-700 shrink-0" aria-hidden />
                )}
                <span className="text-sm font-medium text-(--color-argus-text)">{w.name}</span>
                {busyId === w.id ? (
                  <span className="ml-auto h-4 w-4 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin shrink-0" aria-hidden />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function loadSocialAddon(): boolean {
  try {
    return localStorage.getItem(ADDON_SOCIAL_SCOUT) === '1';
  } catch {
    return false;
  }
}

function saveSocialAddon(on: boolean): void {
  try {
    localStorage.setItem(ADDON_SOCIAL_SCOUT, on ? '1' : '0');
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------

type Role = 'scout' | 'user' | 'admin';

function Header({
  health, boot, role, onRoleChange, wallet, onDisconnect, showScoutTab, showAdminTab,
}: {
  health: HealthInfo | null;
  boot: BootInfo | null;
  role: Role;
  onRoleChange: (r: Role) => void;
  wallet: string | null;
  onDisconnect: () => void | Promise<void>;
  showScoutTab: boolean;
  showAdminTab: boolean;
}) {
  const ok = health?.status === 'ok';
  return (
    <header className="glass-header sticky top-0 z-20 motion-safe:transition-shadow motion-safe:hover:shadow-[0_8px_40px_rgba(0,0,0,0.35)]">
      <div className="max-w-7xl mx-auto px-6 sm:px-8 py-5 flex flex-wrap items-center justify-between gap-y-4 gap-x-4">
        <div className="flex items-center gap-4 min-w-0">
          <BrandMark className="h-[3.25rem] w-[3.25rem] sm:h-14 sm:w-14" />
          <div className="min-w-0">
            <div className="text-base sm:text-lg font-semibold tracking-tight text-amber-50">Argus</div>
            <div className="text-xs sm:text-sm text-(--color-argus-muted) truncate">the hundred-eyed guardian of Web3</div>
          </div>
        </div>

        {/* Role switcher */}
        <div className="flex items-center rounded-xl border border-white/10 bg-white/[0.04] backdrop-blur-md p-1 text-sm font-medium shadow-inner shadow-black/20">
          {showScoutTab && (
            <button type="button" onClick={() => onRoleChange('scout')}
              className={`px-3.5 py-2 rounded-lg transition ${role === 'scout' ? 'bg-amber-400/90 text-zinc-950' : 'text-(--color-argus-muted) hover:text-(--color-argus-text)'}`}>
              Scout
            </button>
          )}
          <button type="button" onClick={() => onRoleChange('user')}
            className={`px-3.5 py-2 rounded-lg transition ${role === 'user' ? 'bg-sky-500/80 text-white' : 'text-(--color-argus-muted) hover:text-(--color-argus-text)'}`}>
            User
          </button>
          {showAdminTab && (
            <button type="button" onClick={() => onRoleChange('admin')}
              className={`px-3.5 py-2 rounded-lg transition ${role === 'admin' ? 'bg-violet-500/80 text-white' : 'text-(--color-argus-muted) hover:text-(--color-argus-text)'}`}>
              Admin
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 text-sm flex-wrap justify-end">
          {wallet && (
            <div className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.04] backdrop-blur-md px-3 py-1.5 shadow-sm">
              <span className="mono text-xs text-(--color-argus-muted) max-w-[140px] truncate" title={wallet}>{wallet.slice(0, 6)}…{wallet.slice(-4)}</span>
              <button type="button" onClick={() => void onDisconnect()} className="text-xs text-rose-400 hover:text-rose-300">Log out</button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 shrink-0 rounded-full ${ok ? 'bg-emerald-400' : 'bg-rose-500'}`} />
            <span className="text-(--color-argus-muted) text-xs sm:text-sm">bridge {health?.bridge ?? '—'}</span>
          </div>
          {boot && (
            <div className="hidden sm:flex items-center gap-4 text-xs sm:text-sm">
              <span className="text-(--color-argus-muted)">code <Hex value={boot.code_hash} len={5} /></span>
              <span className="text-(--color-argus-muted)">signals {boot.signal_count}/{boot.max_signals}</span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// SCOUT view
// ---------------------------------------------------------------------------

const PIPELINE_LABELS: Record<string, string> = {
  fetching_tweet: 'Fetching tweet via Apify…',
  tweet_fetched: 'Tweet fetched',
  resolving_address: 'Resolving contract address…',
  address_resolved: 'Contract address resolved',
  submitting_signal: 'Submitting to TEE…',
  done: 'TEE consensus complete',
};

function IntelPanel({ onDone, allowSocialSource = true }: { onDone: () => void; allowSocialSource?: boolean }) {
  const [tweetUrl, setTweetUrl] = useState('');
  const [freeText, setFreeText] = useState('');
  const [mode, setMode] = useState<'tweet' | 'text'>('tweet');
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [result, setResult] = useState<IntelResult | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!allowSocialSource && mode === 'tweet') setMode('text');
  }, [allowSocialSource, mode]);

  const submit = async () => {
    setBusy(true);
    setErr('');
    setResult(null);
    setSteps(['submitting']);

    try {
      const args = mode === 'tweet'
        ? { tweetUrl: tweetUrl.trim(), text: freeText.trim() }
        : { text: freeText.trim() };
      const res = await submitIntel(args);
      setSteps(res.steps);
      setResult(res);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setSteps([]);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !busy && (
    mode === 'tweet'
      ? tweetUrl.trim().length > 0
      : freeText.trim().length > 0
  );

  return (
    <div className="glass-surface glass-surface-hover overflow-hidden border-amber-400/25 motion-safe:hover:-translate-y-0.5">
      {/* header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-amber-400/20 bg-amber-400/5">
        <span className="text-amber-300 text-base">🔍</span>
        <span className="text-sm font-semibold text-amber-200">Submit Threat Intel</span>
        <span className="ml-auto text-[10px] text-(--color-argus-muted) bg-(--color-argus-bg) px-2 py-0.5 rounded-full border border-(--color-argus-border)">
          scout.agents.argus-security.eth
        </span>
      </div>

      <div className="p-4 space-y-4">
        {!allowSocialSource && (
          <p className="text-[10px] text-(--color-argus-muted) border border-(--color-argus-border) rounded-md px-2 py-1.5 bg-(--color-argus-bg)">
            <span className="text-amber-300/90 font-medium">Social URL pipeline</span> (Reddit / X + Apify) is an add-on.
            Enable it under <span className="font-medium">User → Bundles</span> after you have scout access, or use <span className="font-medium">Free text</span> below.
          </p>
        )}
        {/* mode tabs */}
        {allowSocialSource && (
        <div className="flex rounded-md border border-(--color-argus-border) bg-(--color-argus-bg) p-0.5 text-xs w-fit">
          <button type="button"
            onClick={() => setMode('tweet')}
            className={`px-3 py-1 rounded transition ${mode === 'tweet' ? 'bg-amber-400/80 text-zinc-900 font-medium' : 'text-(--color-argus-muted)'}`}
          >
            Source URL
          </button>
          <button type="button"
            onClick={() => setMode('text')}
            className={`px-3 py-1 rounded transition ${mode === 'text' ? 'bg-amber-400/80 text-zinc-900 font-medium' : 'text-(--color-argus-muted)'}`}
          >
            Free text
          </button>
        </div>
        )}

        {mode === 'tweet' ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-(--color-argus-muted)">
                Post URL
              </label>
              <input
                value={tweetUrl}
                onChange={(e) => setTweetUrl(e.target.value)}
                placeholder="https://reddit.com/r/… or https://x.com/…"
                className="mono w-full bg-(--color-argus-bg) border border-(--color-argus-border) rounded-md px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400/60 placeholder:text-zinc-600"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-(--color-argus-muted)">
                Post text <span className="text-zinc-600 normal-case">(optional — auto-fetched for Reddit)</span>
              </label>
              <textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                rows={2}
                placeholder="@FakeSwapNet has an arbitrary call vulnerability…"
                className="w-full bg-(--color-argus-bg) border border-(--color-argus-border) rounded-md px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400/60 placeholder:text-zinc-600 resize-none"
              />
            </div>
            <p className="text-[10px] text-(--color-argus-muted)">
              Reddit posts are fetched automatically. For Twitter, paste the tweet text too.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-(--color-argus-muted)">
              Vulnerability description
            </label>
            <textarea
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              rows={3}
              placeholder="@FakeSwapNet has an arbitrary call vulnerability — execute() can drain all user approvals."
              className="w-full bg-(--color-argus-bg) border border-(--color-argus-border) rounded-md px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400/60 placeholder:text-zinc-600 resize-none"
            />
            <p className="text-[10px] text-(--color-argus-muted)">
              Mention @FakeSwapNet or include a 0x contract address. No Twitter needed.
            </p>
          </div>
        )}

        {err && (
          <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-md px-3 py-2">
            {err}
          </div>
        )}

        <button
          disabled={!canSubmit}
          onClick={() => void submit()}
          className="w-full py-2 text-sm font-semibold rounded-lg bg-amber-400/90 hover:bg-amber-300 text-zinc-950 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          {busy ? 'Processing…' : '🚨 Submit Intel'}
        </button>

        {/* pipeline steps */}
        {(steps.length > 0 || result) && (
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-(--color-argus-muted)">Pipeline</div>
            <div className="space-y-1">
              {['fetching_tweet', 'tweet_fetched', 'resolving_address', 'address_resolved', 'submitting_signal', 'done']
                .filter((s) => mode === 'tweet' || !['fetching_tweet', 'tweet_fetched'].includes(s))
                .map((s) => {
                  const done = steps.includes(s) || (result !== null);
                  const active = busy && !steps.includes(s) && steps.length > 0;
                  return (
                    <div key={s} className={`flex items-center gap-2 text-xs transition-all ${done ? 'text-emerald-400' : active ? 'text-amber-300' : 'text-zinc-600'}`}>
                      <span className="shrink-0 w-4 text-center">
                        {done ? '✓' : active ? '⋯' : '○'}
                      </span>
                      <span>{PIPELINE_LABELS[s] ?? s}</span>
                    </div>
                  );
                })}
            </div>
            {result && (
              <div className="mt-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300 space-y-1">
                <div className="font-semibold">Pipeline complete</div>
                <div className="mono opacity-80">{result.contractAddress}</div>
                <div className="flex items-center gap-2">
                  <span>Score:</span>
                  <span className={`font-bold ${result.consensus.score === 'CRITICAL' ? 'text-red-400 animate-pulse' : 'text-amber-300'}`}>
                    {result.consensus.score}
                  </span>
                  <span className="opacity-60">({result.consensus.confirmed}/{result.consensus.count} confirmed)</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function normalizeSocialProfileInput(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z0-9_-]{2,32}$/i.test(t) && !t.includes('/') && !t.includes('.')) {
    return `https://www.reddit.com/user/${t.replace(/^u\//i, '')}`;
  }
  return t;
}

function SocialAgentPanel({ onAgentsChanged }: { onAgentsChanged: () => void }) {
  const [profileUrl, setProfileUrl] = useState('');
  const [pollSec, setPollSec] = useState(120);
  const [agents, setAgents] = useState<SocialAgentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const refresh = useCallback(() => {
    void listSocialAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  const deploy = () => {
    void (async () => {
      const u = normalizeSocialProfileInput(profileUrl);
      if (!u) {
        setErr('Paste a profile URL (or a Reddit username only)');
        return;
      }
      setBusy(true);
      setErr('');
      try {
        await createSocialAgent({ profileUrl: u, pollSec });
        setProfileUrl('');
        refresh();
        onAgentsChanged();
      } catch (e) {
        setErr((e as Error).message ?? 'failed');
      } finally {
        setBusy(false);
      }
    })();
  };

  const stop = (id: string) => {
    void (async () => {
      try {
        await deleteSocialAgent(id);
        refresh();
        onAgentsChanged();
      } catch (e) {
        setErr((e as Error).message ?? 'stop failed');
      }
    })();
  };

  return (
    <div className="glass-surface glass-surface-hover overflow-hidden border-sky-400/20 motion-safe:hover:-translate-y-0.5">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-sky-500/20 bg-sky-500/5">
        <span className="text-sky-300 text-base">🤖</span>
        <span className="text-sm font-semibold text-sky-200">Social scout agent</span>
        <span className="ml-auto text-[10px] text-(--color-argus-muted) bg-(--color-argus-bg) px-2 py-0.5 rounded-full border border-(--color-argus-border)">
          server poll
        </span>
      </div>
      <div className="p-4 space-y-3 text-xs">
        <p className="text-(--color-argus-muted) leading-relaxed">
          Paste a <span className="text-sky-300 font-medium">public profile URL</span> —{' '}
          <span className="mono">reddit.com/user/…</span> (demo, no API key) or{' '}
          <span className="mono">x.com/handle</span> (needs <span className="font-medium">APIFY_TOKEN</span> on signal-api).
          New posts that mention the demo contract or a <span className="mono">0x…</span> address run the same intel corroboration as manual Scout;{' '}
          <span className="text-amber-300">guardian_trigger</span> fires when consensus crosses RED. Keep your guardian process running for on-chain revokes.
        </p>
        <div className="space-y-1">
          <label className="text-[10px] uppercase text-(--color-argus-muted)">Profile URL</label>
          <input
            value={profileUrl}
            onChange={(e) => setProfileUrl(e.target.value)}
            placeholder="https://www.reddit.com/user/Sedoy26 — or bare Reddit name — or https://x.com/…"
            className="mono w-full bg-(--color-argus-bg) border border-(--color-argus-border) rounded-md px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-sky-500/50"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase text-(--color-argus-muted)">Poll every (seconds)</label>
          <input
            type="number"
            min={30}
            max={600}
            value={pollSec}
            onChange={(e) => setPollSec(Number(e.target.value) || 120)}
            className="w-full bg-(--color-argus-bg) border border-(--color-argus-border) rounded-md px-3 py-1.5 text-xs"
          />
        </div>
        {err && <div className="text-[11px] text-rose-400">{err}</div>}
        <button
          type="button"
          disabled={busy}
          onClick={deploy}
          className="w-full py-2 text-xs font-semibold rounded-lg bg-sky-600/80 hover:bg-sky-500/80 text-white disabled:opacity-40"
        >
          {busy ? 'Starting…' : 'Deploy agent'}
        </button>

        <div className="pt-2 border-t border-(--color-argus-border) space-y-2">
          <div className="text-[10px] uppercase text-(--color-argus-muted)">Active agents</div>
          {agents.length === 0 && (
            <p className="text-[11px] text-(--color-argus-muted)">
              None — if you see 404 here, the dashboard proxy is not reaching signal-api (check Vite <span className="mono">VITE_API_TARGET</span>).
            </p>
          )}
          {agents.map((a) => (
            <div key={a.id} className="flex items-start justify-between gap-2 rounded-md border border-(--color-argus-border) bg-(--color-argus-bg)/50 px-2 py-1.5">
              <div className="min-w-0">
                <div className="font-medium text-sky-200">
                  <span className="text-[10px] uppercase text-(--color-argus-muted) mr-1">{a.platform}</span>
                  <span className="break-all">{a.profileUrl}</span>
                </div>
                <div className="text-[10px] text-(--color-argus-muted) mono truncate">
                  id {a.id} · poll {Math.round(a.pollMs / 1000)}s · posts {a.postsProcessed}
                </div>
                {a.lastError && <div className="text-[10px] text-rose-400/90 mt-0.5">{a.lastError}</div>}
              </div>
              <button type="button" onClick={() => stop(a.id)} className="shrink-0 text-[10px] text-rose-400 hover:text-rose-300">
                Stop
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ContractCard({ addr, state, onSelect, isSelected }: {
  addr: string; state: RiskState | undefined; onSelect: () => void; isSelected: boolean;
}) {
  const env = state?.envelope;
  const score = (env?.score ?? 'NONE') as Score;
  return (
    <button
      onClick={onSelect}
      className={`text-left glass-surface glass-surface-hover p-4 motion-safe:hover:-translate-y-1 ${isSelected ? 'border-amber-400/50 ring-1 ring-amber-400/25 shadow-[0_0_28px_rgba(251,191,36,0.12)]' : ''}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="mono text-sm truncate" title={addr}>{addr.slice(0, 10)}…{addr.slice(-8)}</div>
        <ScoreBadge score={score} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
        <div>
          <div className="text-(--color-argus-muted)">confirmed</div>
          <div className="text-base font-semibold">{env?.confirmed ?? 0}/{env?.count ?? 0}</div>
        </div>
        <div>
          <div className="text-(--color-argus-muted)">confidence</div>
          <div className="text-base font-semibold">{env?.confidence ?? 0}</div>
        </div>
        <div>
          <div className="text-(--color-argus-muted)">last signal</div>
          <div className="text-sm">{env?.last_signal_ts ? new Date(env.last_signal_ts * 1000).toLocaleTimeString() : '—'}</div>
        </div>
      </div>
      {env?.summary && (
        <div className="mt-3 text-[11px] text-(--color-argus-muted) line-clamp-2">{env.summary}</div>
      )}
    </button>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <div className="text-xs text-(--color-argus-muted) uppercase tracking-wider">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function DetailPanel({ addr, state }: { addr: string; state: RiskState | undefined }) {
  const env = state?.envelope;
  const records = state?.preview?.records ?? {};
  return (
    <section className="glass-surface glass-surface-hover p-5 space-y-5 motion-safe:hover:-translate-y-0.5">
      <div>
        <div className="text-xs uppercase tracking-wider text-(--color-argus-muted)">contract</div>
        <div className="mono text-sm break-all">{addr}</div>
      </div>
      {env && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Field label="score"><ScoreBadge score={env.score} /></Field>
          <Field label="confidence">{env.confidence}</Field>
          <Field label="confirmed / total">{env.confirmed} / {env.count}</Field>
          <Field label="last signal ts">{env.last_signal_ts ? new Date(env.last_signal_ts * 1000).toLocaleString() : '—'}</Field>
          <Field label="code_hash" wide><Hex value={env.code_hash} /></Field>
          <Field label="boot_commitment" wide><Hex value={env.boot_commitment} /></Field>
          <Field label="attestation" wide><Hex value={env.attestation} /></Field>
        </div>
      )}
      {env?.summary && (
        <div className="text-xs">
          <div className="text-(--color-argus-muted) uppercase tracking-wider mb-1">summary</div>
          <div className="mono text-zinc-200">{env.summary}</div>
        </div>
      )}
      {Object.keys(records).length > 0 && (
        <div className="text-xs">
          <div className="text-(--color-argus-muted) uppercase tracking-wider mb-1">ENS records (gateway)</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {Object.entries(records).filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <span className="text-(--color-argus-muted) min-w-[120px]">{k}</span>
                <span className="mono break-all">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// USER view
// ---------------------------------------------------------------------------

const USER_APPROVALS = [
  { spender: DEMO_CONTRACT, label: DEMO_CONTRACT_NAME, amount: 'unlimited', token: 'USDC' },
  { spender: DEMO_CONTRACT, label: DEMO_CONTRACT_NAME, amount: '5,000', token: 'DAI' },
];

function BundlesCard({
  approvedScout,
  socialOn,
  onSocialChange,
}: {
  approvedScout: boolean;
  socialOn: boolean;
  onSocialChange: (on: boolean) => void;
}) {
  return (
    <div className="glass-surface glass-surface-hover p-4 space-y-3 motion-safe:hover:-translate-y-0.5">
      <div className="text-xs font-semibold uppercase tracking-wider text-(--color-argus-muted)">Bundles &amp; add-ons</div>
      <div className="text-xs text-(--color-argus-muted) space-y-1">
        <p><span className="text-emerald-400 font-medium">Included for everyone:</span> Sourcify watcher agent — automated SWAT-style source checks land in the live feed without any toggle.</p>
        <p><span className="text-amber-300 font-medium">Optional add-on:</span> Social URL scout (Reddit / X + Apify). Prefer <span className="font-medium">X402</span> (<code className="mono text-[10px]">APIFY_X402_PRIVATE_KEY</code> on signal-api) for Apify bounty flow; bearer <span className="mono text-[10px]">APIFY_TOKEN</span> still supported.</p>
      </div>
      <label className={`flex items-center gap-2 text-xs ${approvedScout ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}>
        <input
          type="checkbox"
          checked={socialOn}
          disabled={!approvedScout}
          onChange={(e) => {
            const v = e.target.checked;
            saveSocialAddon(v);
            onSocialChange(v);
          }}
        />
        <span>Enable social URL scout (Apify-backed)</span>
      </label>
      {!approvedScout && (
        <p className="text-[10px] text-(--color-argus-muted)">Request Scout access below — an admin must approve before this add-on applies.</p>
      )}
    </div>
  );
}

function UserWalletSnapshot({ score }: { score: Score }) {
  const n = USER_APPROVALS.length;
  const riskTier = SCORE_ORDER[score];
  const atRiskCount = riskTier >= 3 ? n : riskTier >= 2 ? Math.min(1, n) : 0;
  return (
    <div className="glass-surface glass-surface-hover p-4 motion-safe:hover:-translate-y-0.5">
      <div className="text-xs font-semibold uppercase tracking-wider text-amber-200/90 mb-2">Your wallet — demo snapshot</div>
      <p className="text-sm text-(--color-argus-text)">
        <span className="font-semibold text-amber-100">{n}</span> active token allowance{n === 1 ? '' : 's'} on the demo contract{' '}
        <span className="mono text-xs opacity-90">{DEMO_CONTRACT.slice(0, 8)}…</span>
      </p>
      <p className="text-sm mt-2 text-(--color-argus-muted)">
        Argus risk for that contract:{' '}
        <span className={`font-semibold ${riskTier >= 3 ? 'text-rose-300' : riskTier >= 2 ? 'text-amber-200' : 'text-emerald-300'}`}>{score}</span>
        {atRiskCount > 0 ? (
          <span className="text-rose-200/90"> — {atRiskCount} allowance{atRiskCount === 1 ? '' : 's'} flagged at elevated risk in this demo.</span>
        ) : (
          <span> — no demo allowances in the critical band for your current score.</span>
        )}
      </p>
    </div>
  );
}

function EnsCcipRiskLookup() {
  const [addr, setAddr] = useState(DEMO_CONTRACT);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [score, setScore] = useState<string | null>(null);

  const run = () => {
    void (async () => {
      setBusy(true);
      setErr('');
      setScore(null);
      try {
        const a = addr.trim().toLowerCase();
        if (!ADDR_RE.test(a)) {
          setErr('Enter a valid 0x address');
          return;
        }
        const name = normalize(`${a}.${ARGUS_ENS_RISK_PARENT}`);
        const gw =
          import.meta.env.VITE_GATEWAY_URL?.replace(/\/$/, '') ??
          (typeof window !== 'undefined' ? `${window.location.origin}/gw` : '');
        const gatewayUrls = [`${gw}/lookup/{sender}/{data}.json`];
        const text = await getEnsText(publicClient, {
          name,
          key: 'score',
          gatewayUrls,
        });
        setScore(text ?? '(empty — name may not be wired on Sepolia)');
      } catch (e) {
        setErr((e as Error).message ?? 'ENS / CCIP resolution failed');
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="glass-surface glass-surface-hover p-4 space-y-3 motion-safe:hover:-translate-y-0.5">
      <div className="text-xs font-semibold uppercase tracking-wider text-sky-200/90">ENS CCIP-Read — live risk text record</div>
      <p className="text-[11px] text-(--color-argus-muted) leading-relaxed">
        Resolves <span className="mono">{`0x…${ARGUS_ENS_RISK_PARENT}`}</span> via viem + your Argus gateway (EIP-3668). Requires the wildcard name to use ArgusRiskResolver on Sepolia.
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="0x contract address"
          className="mono flex-1 bg-(--color-argus-bg) border border-(--color-argus-border) rounded-lg px-3 py-2 text-xs"
        />
        <button
          type="button"
          disabled={busy}
          onClick={run}
          className="px-4 py-2 rounded-lg bg-sky-600/80 hover:bg-sky-500/80 text-white text-xs font-semibold disabled:opacity-40"
        >
          {busy ? 'Resolving…' : 'Resolve score'}
        </button>
      </div>
      {err && <div className="text-[11px] text-rose-400">{err}</div>}
      {score != null && (
        <div className="text-sm">
          <span className="text-(--color-argus-muted)">score text record: </span>
          <span className="font-mono font-semibold text-sky-200">{score}</span>
        </div>
      )}
    </div>
  );
}

function RegistryExplorerStrip() {
  const [rows, setRows] = useState<RegistryAgent[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const raw = await publicClient.readContract({
          address: REGISTRY_ADDRESS,
          abi: REGISTRY_ABI,
          functionName: 'allAgents',
        });
        setRows(raw as RegistryAgent[]);
      } catch (e) {
        setErr((e as Error).message ?? 'registry read failed');
      }
    })();
  }, []);

  const active = rows.filter((a) => a.status === 1).slice(0, 8);

  function trustLabel(a: RegistryAgent): string {
    const s = `${a.specialty} ${a.ensName}`.toLowerCase();
    if (s.includes('kms')) return 'KMS-attested';
    if (Number(a.reputation) >= 90) return 'High trust';
    return 'Registry';
  }

  return (
    <div className="glass-surface glass-surface-hover p-4 space-y-3 motion-safe:hover:-translate-y-0.5">
      <div className="text-xs font-semibold uppercase tracking-wider text-violet-200/90">On-chain agent registry (Sepolia)</div>
      {err && <div className="text-[11px] text-rose-400">{err}</div>}
      {!err && active.length === 0 && (
        <p className="text-xs text-(--color-argus-muted)">No active agents yet — deploy / seed ArgusRegistry.</p>
      )}
      <div className="grid sm:grid-cols-2 gap-2">
        {active.map((a) => (
          <div
            key={a.addr}
            className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className={`font-medium ${ROLE_COLOR[a.role] ?? 'text-zinc-300'}`}>{ROLE_LABEL[a.role] ?? `R${a.role}`}</span>
              <span className="text-[10px] px-1.5 py-0 rounded bg-amber-500/15 text-amber-100 border border-amber-400/25">{trustLabel(a)}</span>
            </div>
            <div className="mono text-(--color-argus-muted) mt-1 truncate" title={a.addr}>{a.addr.slice(0, 12)}…{a.addr.slice(-6)}</div>
            {a.ensName && <div className="mono text-violet-300/90 truncate mt-0.5" title={a.ensName}>{a.ensName}</div>}
            <div className="text-(--color-argus-muted) mt-1">rep {String(a.reputation)} · signals {String(a.signalCount)}</div>
            {a.specialty && <div className="text-[10px] text-zinc-500 mt-1 line-clamp-2">{a.specialty}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

type EnrollRole = 'scout' | 'guardian' | 'watcher';

const ENROLL_ROLE_META: Record<
  EnrollRole,
  { label: string; short: string; hint: string; icon: string }
> = {
  scout: {
    label: 'Scout',
    short: 'Intel',
    hint: 'Submit social / URL intelligence for corroboration.',
    icon: '🔭',
  },
  guardian: {
    label: 'Guardian',
    short: 'Protect',
    hint: 'Participate in automated approval-revoke operations.',
    icon: '🛡️',
  },
  watcher: {
    label: 'Watcher',
    short: 'Analyze',
    hint: 'Contribute Sourcify-style contract analysis signals.',
    icon: '👁️',
  },
};

/** Left rail: pill per special role → modal → same enrollment queue as admin moderation. */
function RoleApplicationsRail({
  wallet,
  access,
  onDone,
}: {
  wallet: string | null;
  access: AccessInfo | null;
  onDone: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState<EnrollRole | null>(null);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  if (!wallet || !access) return null;

  if (access.privileged) {
    return (
      <div className="glass-surface border-emerald-500/20 p-4 space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-200/90">Special roles</div>
        <p className="text-[11px] text-(--color-argus-muted) leading-relaxed">
          This wallet is <span className="text-emerald-300/95">privileged</span> — Scout / Admin are already available. No enrollment request needed.
        </p>
      </div>
    );
  }

  const hasRole = (r: EnrollRole) => access.approvedRoles.includes(r);
  const pendingRole = access.pending?.requestedRole as EnrollRole | undefined;
  const anyPending = !!access.pending;

  const submit = (role: EnrollRole) => {
    void (async () => {
      setBusy(true);
      setToast('');
      try {
        const { nonce } = await getAuthNonce('user', wallet);
        const message = buildEnrollmentSignMessage({
          address: wallet,
          role,
          description: description.trim(),
          nonce,
        });
        const signature = await walletPersonalSign(wallet, message);
        await submitEnrollmentRequest({
          address: wallet,
          role,
          description: description.trim(),
          nonce,
          signature,
        });
        setToast('Submitted — an admin will review.');
        setOpen(null);
        setDescription('');
        await Promise.resolve(onDone());
      } catch (e) {
        setToast((e as Error).message ?? 'Request failed');
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <>
      <div className="glass-surface border-violet-500/20 p-4 space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-violet-200/90">Special roles</div>
        {!access.authStrict && (
          <p className="text-[11px] text-sky-200/90 leading-relaxed rounded-lg border border-sky-500/25 bg-sky-500/10 px-3 py-2">
            Open-access deployment — requests still create a <span className="font-medium text-sky-100">pending</span> row for admins to review when they use the Admin tab.
          </p>
        )}
        <p className="text-[11px] text-(--color-argus-muted) leading-relaxed">
          Tap a role, add a short pitch — admins see it as <span className="text-violet-300">pending</span> in their queue.
        </p>
        {anyPending && (
          <div className="text-[11px] rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-amber-100/95">
            Pending: <span className="font-semibold capitalize">{pendingRole ?? '—'}</span>
          </div>
        )}
        <div className="flex flex-col gap-2">
          {(['scout', 'guardian', 'watcher'] as const).map((r) => {
            const meta = ENROLL_ROLE_META[r];
            const approved = hasRole(r);
            const isPendingHere = pendingRole === r;
            const blocked = anyPending && !isPendingHere;
            return (
              <button
                key={r}
                type="button"
                disabled={approved || anyPending}
                onClick={() => {
                  if (approved || anyPending) return;
                  setDescription('');
                  setToast('');
                  setOpen(r);
                }}
                className={`w-full flex items-center gap-2.5 rounded-full border px-3 py-2 text-left text-sm font-medium transition ${
                  approved
                    ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200 cursor-default'
                    : isPendingHere
                      ? 'border-amber-400/40 bg-amber-500/15 text-amber-100 cursor-default'
                      : blocked
                        ? 'border-(--color-argus-border) bg-white/[0.03] text-zinc-500 cursor-not-allowed'
                        : 'border-violet-500/35 bg-violet-600/15 text-violet-100 hover:bg-violet-600/25 hover:border-violet-400/50'
                }`}
              >
                <span className="shrink-0 text-base">{meta.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{meta.label}</span>
                  <span className="block text-[10px] font-normal opacity-70 truncate">{meta.short}</span>
                </span>
                {approved && <span className="shrink-0 text-[11px] text-emerald-300">✓</span>}
                {isPendingHere && <span className="shrink-0 text-[11px] text-amber-300">…</span>}
              </button>
            );
          })}
        </div>
        {toast && (
          <p className={`text-[11px] leading-snug ${toast.includes('fail') || toast.toLowerCase().includes('error') ? 'text-rose-400' : 'text-emerald-400/90'}`}>
            {toast}
          </p>
        )}
      </div>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-5 sm:p-6 glass-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="role-apply-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(null);
          }}
        >
          <div
            className="w-full max-w-lg glass-modal-panel border-violet-500/45 p-6 sm:p-7 space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="role-apply-title" className="text-base font-semibold text-violet-100">
                  Apply as {ENROLL_ROLE_META[open].label}
                </h2>
                <p className="text-sm text-(--color-argus-muted) mt-1 leading-relaxed">{ENROLL_ROLE_META[open].hint}</p>
              </div>
              <button
                type="button"
                className="text-(--color-argus-muted) hover:text-white text-xl leading-none px-1.5"
                onClick={() => setOpen(null)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] uppercase tracking-wide text-(--color-argus-muted)">Why you + links (min 12 chars)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                placeholder="Background, relevant accounts, what you’ll contribute…"
                className="w-full min-h-[8.5rem] bg-(--color-argus-bg) border border-(--color-argus-border) rounded-lg px-3.5 py-2.5 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-violet-500/50"
              />
            </div>
            <div className="flex gap-2.5 justify-end pt-1">
              <button
                type="button"
                className="px-4 py-2 text-sm rounded-lg border border-(--color-argus-border) text-(--color-argus-muted) hover:text-(--color-argus-text)"
                onClick={() => setOpen(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || description.trim().length < 12}
                onClick={() => submit(open)}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-violet-600/85 hover:bg-violet-500/85 text-white disabled:opacity-40"
              >
                {busy ? 'Signing…' : 'Sign & submit'}
              </button>
            </div>
            <p className="text-[11px] text-(--color-argus-muted) leading-relaxed">One-time nonce + wallet signature — same flow as the admin moderation queue.</p>
          </div>
        </div>
      )}
    </>
  );
}

function EnrollmentModeration({ wallet, onChanged }: { wallet: string; onChanged: () => void | Promise<void> }) {
  const [rows, setRows] = useState<EnrollmentRow[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    void (async () => {
      setBusy(true);
      setErr('');
      try {
        const { nonce } = await getAuthNonce('admin', wallet);
        const message = buildAdminModerationMessage({ action: 'list', nonce });
        const signature = await walletPersonalSign(wallet, message);
        const list = await adminListEnrollments({ adminAddress: wallet, nonce, signature });
        setRows(list);
      } catch (e) {
        setErr((e as Error).message ?? 'load failed');
      } finally {
        setBusy(false);
      }
    })();
  };

  const decide = (id: number, decision: 'approve' | 'reject') => {
    void (async () => {
      setBusy(true);
      setErr('');
      try {
        const { nonce } = await getAuthNonce('admin', wallet);
        const message = buildAdminModerationMessage({ action: decision, enrollmentId: id, nonce });
        const signature = await walletPersonalSign(wallet, message);
        await adminDecideEnrollment({
          adminAddress: wallet,
          nonce,
          signature,
          enrollmentId: id,
          decision,
        });
        await load();
        onChanged();
      } catch (e) {
        setErr((e as Error).message ?? 'action failed');
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="glass-surface glass-surface-hover border-violet-400/25 p-5 space-y-3 mb-6 bg-violet-950/10 motion-safe:hover:-translate-y-0.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold text-violet-200">Pending contributor requests</div>
        <button
          type="button"
          disabled={busy}
          onClick={load}
          className="text-xs px-3 py-1.5 rounded-lg border border-violet-500/40 text-violet-200 hover:bg-violet-500/10 disabled:opacity-40"
        >
          {busy ? '…' : '↻ Load queue (sign)'}
        </button>
      </div>
      {err && <div className="text-xs text-rose-400">{err}</div>}
      {rows.length === 0 && !err && (
        <p className="text-xs text-(--color-argus-muted)">No pending rows (or list not loaded yet).</p>
      )}
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="rounded-lg border border-(--color-argus-border) bg-(--color-argus-bg)/60 p-3 text-xs space-y-2">
            <div className="flex flex-wrap gap-2 items-baseline justify-between">
              <span className="mono text-violet-200">{r.address.slice(0, 10)}…{r.address.slice(-6)}</span>
              <span className="text-amber-300 font-medium">{r.requestedRole}</span>
            </div>
            <p className="text-(--color-argus-muted) whitespace-pre-wrap">{r.description}</p>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => decide(r.id, 'approve')} className="px-2 py-1 rounded bg-emerald-600/70 text-white text-[11px]">Approve</button>
              <button type="button" disabled={busy} onClick={() => decide(r.id, 'reject')} className="px-2 py-1 rounded bg-zinc-700 text-zinc-200 text-[11px]">Reject</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TxBlockedHighlight({ ev }: { ev: ArgusEvent }) {
  const [open, setOpen] = useState(false);
  const sm = ev.detail.sourcify_match;
  const verified = sm != null && sm !== 'null' && sm !== '';
  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      className={`w-full text-left text-xs text-orange-200/90 bg-orange-500/5 border border-orange-500/25 rounded-lg px-3 py-2 transition hover:bg-orange-500/10 ${open ? 'ring-1 ring-orange-400/30' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium">SWAT-004 — Fake Uniswap drain attempt intercepted</div>
        <span className="shrink-0 text-[10px] opacity-60">{open ? '▼' : '▶'}</span>
      </div>
      <div className="mt-0.5 opacity-70">
        Sourcify:{' '}
        <span className={verified ? 'text-emerald-400' : 'text-rose-400'}>
          {verified ? String(sm) : 'NOT VERIFIED'}
        </span>
        {' · '}TEE: <span className="mono">{String(ev.detail.score ?? 'NONE')}</span>
        {' · '}<span className="text-emerald-400">funds protected</span>
      </div>
      {open && <EventExplainer ev={ev} />}
    </button>
  );
}

function UserView({
  events,
  riskState,
  wallet,
  access,
  onAccessRefresh,
  socialOn,
  onSocialChange,
}: {
  events: ArgusEvent[];
  riskState: RiskState | undefined;
  wallet: string | null;
  access: AccessInfo | null;
  onAccessRefresh: () => Promise<void>;
  socialOn: boolean;
  onSocialChange: (on: boolean) => void;
}) {
  const score = (riskState?.envelope?.score ?? 'NONE') as Score;
  const isAtRisk = SCORE_ORDER[score] >= 3;
  const guardianFired = events.some((e) => e.kind === 'guardian_trigger');
  const txBlocked = events.filter((e) => e.kind === 'tx_blocked');
  const alertEvents = events.filter((e) => ['score_changed', 'guardian_trigger', 'signal_received', 'tx_blocked'].includes(e.kind));
  const approvedScout = !!(access && (access.privileged || access.approvedRoles.includes('scout')));
  /** Left rail whenever we know access — not gated on authStrict (that hides the whole column in dev/Railway). */
  const showRoleRail = !!(wallet && access);

  const bannerClass = isAtRisk
    ? 'border-red-500/50 bg-red-500/10'
    : 'border-emerald-500/30 bg-emerald-500/5';

  return (
    <div className={showRoleRail ? 'grid gap-6 md:grid-cols-[minmax(0,13rem)_1fr] lg:grid-cols-[minmax(0,15.5rem)_1fr] items-start' : 'space-y-6'}>
      {showRoleRail && (
        <aside className="space-y-3 md:sticky md:top-24 lg:top-28 order-2 md:order-1 self-start">
          <RoleApplicationsRail wallet={wallet} access={access} onDone={onAccessRefresh} />
        </aside>
      )}
      <div className={showRoleRail ? 'space-y-6 min-w-0 order-1 md:order-2' : 'space-y-6'}>
      <UserWalletSnapshot score={score} />
      <RegistryExplorerStrip />
      <EnsCcipRiskLookup />
      {wallet && (
        <BundlesCard
          approvedScout={approvedScout}
          socialOn={socialOn}
          onSocialChange={onSocialChange}
        />
      )}

      {/* status banner */}
      <div className={`glass-surface glass-surface-hover p-5 motion-safe:hover:-translate-y-0.5 ${bannerClass}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-(--color-argus-muted) mb-1">
              {DEMO_CONTRACT_NAME} — {DEMO_CONTRACT.slice(0, 10)}…{DEMO_CONTRACT.slice(-6)}
            </div>
            {isAtRisk ? (
              <>
                <div className="text-2xl font-bold text-red-300 flex items-center gap-2">
                  <span className="animate-pulse">⚠️</span> Critical Risk Detected
                </div>
                <div className="mt-1 text-sm text-red-200/80">
                  Arbitrary call vulnerability — execute() can drain all user approvals
                </div>
              </>
            ) : (
              <>
                <div className="text-2xl font-bold text-emerald-300 flex items-center gap-2">
                  ✓ No Active Threats
                </div>
                <div className="mt-1 text-sm text-(--color-argus-muted)">
                  Argus is monitoring this contract for vulnerabilities
                </div>
              </>
            )}
          </div>
          <ScoreBadge score={score} />
        </div>
      </div>

      {/* guardian status */}
      <div className={`glass-surface glass-surface-hover p-4 text-sm motion-safe:hover:-translate-y-0.5 ${guardianFired ? 'border-rose-400/35 bg-rose-500/10' : ''}`}>
        <div className="flex items-center gap-2 font-semibold mb-2">
          <span>🛡️</span>
          <span className={guardianFired ? 'text-rose-300' : 'text-(--color-argus-muted)'}>
            Guardian Agent
          </span>
          <span className={`ml-auto text-xs font-medium px-2 py-0.5 rounded-full ${guardianFired ? 'bg-rose-500/20 text-rose-300' : 'bg-zinc-700/60 text-zinc-400'}`}>
            {guardianFired ? 'ACTIVE — REVOKING' : 'MONITORING'}
          </span>
        </div>
        <p className="text-xs text-(--color-argus-muted)">
          {guardianFired
            ? 'Guardian detected CRITICAL risk. Revoking token approvals for all monitored wallets via Space KMS. No action required.'
            : 'Watching for CRITICAL and RED signals. Will auto-revoke your approvals if a verified threat is confirmed.'}
        </p>
      </div>

      {/* TX intercept alerts (SWAT-004 — independent from approval revocation) */}
      {txBlocked.length > 0 && (
        <div className="glass-surface border-orange-400/35 bg-orange-500/10 p-4 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-orange-300 text-sm">
            <span>⛔</span>
            <span>Phishing Transaction Intercepted</span>
            <span className="ml-auto text-xs font-medium px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-300">
              {txBlocked.length} blocked
            </span>
          </div>
          {txBlocked.slice(-2).map((ev) => (
            <TxBlockedHighlight key={ev.id} ev={ev} />
          ))}
        </div>
      )}

      {/* your approvals */}
      <div className="glass-surface overflow-hidden">
        <div className="px-4 py-2.5 border-b border-white/10 text-xs font-semibold uppercase tracking-wider text-(--color-argus-muted)">
          Your Approvals
        </div>
        <div className="divide-y divide-(--color-argus-border)">
          {USER_APPROVALS.map((a, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3 text-sm">
              <div>
                <div className="font-medium">{a.label}</div>
                <div className="text-xs mono text-(--color-argus-muted)">{a.spender.slice(0, 10)}…</div>
              </div>
              <div className="text-right">
                <div className={`text-xs font-medium ${guardianFired ? 'line-through text-zinc-600' : 'text-zinc-300'}`}>
                  {a.amount} {a.token}
                </div>
                {guardianFired && (
                  <div className="text-[10px] text-emerald-400 font-medium mt-0.5">revoked by Argus</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* simplified alert feed */}
      <div className="rounded-xl border border-(--color-argus-border) bg-(--color-argus-card)/60 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-(--color-argus-border) flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs font-semibold uppercase tracking-wider text-(--color-argus-muted)">Alerts</span>
          <span className="text-[10px] text-(--color-argus-muted) ml-auto">
            <span className="hidden sm:inline opacity-70 mr-2">tap row · detail</span>
            {alertEvents.length} events
          </span>
        </div>
        <div className="max-h-[320px] overflow-y-auto p-3 space-y-2">
          {alertEvents.length === 0 && (
            <div className="text-xs text-(--color-argus-muted) text-center py-6">no alerts yet</div>
          )}
          {alertEvents.map((ev) => <EventRow key={ev.id} ev={ev} />)}
        </div>
      </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AdminView – on-chain ArgusRegistry management
// ---------------------------------------------------------------------------

function AdminView({
  wallet,
  onAccessRefresh,
  onDemoReset,
}: {
  wallet: string;
  onAccessRefresh: () => Promise<void>;
  onDemoReset: () => void;
}) {
  const [agents, setAgents] = useState<RegistryAgent[]>([]);
  const [owner, setOwner] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [demoResetBusy, setDemoResetBusy] = useState(false);
  const [demoResetMsg, setDemoResetMsg] = useState('');
  const [txStatus, setTxStatus] = useState<Record<string, string>>({});
  const [filterRole, setFilterRole] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState<number | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [regAddr, setRegAddr] = useState('');
  const [regEns, setRegEns] = useState('');
  const [regSpecialty, setRegSpecialty] = useState('');
  const [regRole, setRegRole] = useState(0);
  const [regErr, setRegErr] = useState('');

  const fetchRegistry = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [rawAgents, ownerAddr] = await Promise.all([
        publicClient.readContract({ address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'allAgents' }),
        publicClient.readContract({ address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'owner' }),
      ]);
      setAgents(rawAgents as RegistryAgent[]);
      setOwner(ownerAddr as string);
    } catch (e) {
      setError((e as Error).message ?? 'Failed to load registry');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchRegistry(); }, [fetchRegistry]);


  const sendTx = useCallback(async (agentAddr: string, action: 'approve' | 'revoke') => {
    const eth = getActiveEthereumProvider();

    if (!eth) {
      setTxStatus(prev => ({ ...prev, [agentAddr]: '⚠ Wallet not connected — copy calldata below' }));
      return;
    }

    setTxStatus(prev => ({ ...prev, [agentAddr]: 'pending…' }));
    try {
      const accounts = await eth.request({ method: 'eth_requestAccounts' }) as string[];
      const from = accounts[0];

      const { encodeFunctionData } = await import('viem');
      const data = action === 'approve'
        ? encodeFunctionData({
            abi: REGISTRY_ABI,
            functionName: 'approveAgent',
            args: [agentAddr as `0x${string}`],
          })
        : encodeFunctionData({
            abi: REGISTRY_ABI,
            functionName: 'revokeAgent',
            args: [agentAddr as `0x${string}`, 'revoked by admin'],
          });

      const txHash = await eth.request({
        method: 'eth_sendTransaction',
        params: [{ from, to: REGISTRY_ADDRESS, data }],
      }) as string;

      setTxStatus(prev => ({ ...prev, [agentAddr]: `sent: ${txHash.slice(0, 18)}…` }));
      setTimeout(() => void fetchRegistry(), 4000);
    } catch (e) {
      setTxStatus(prev => ({ ...prev, [agentAddr]: `error: ${(e as Error).message?.slice(0, 60)}` }));
    }
  }, [fetchRegistry]);

  const counts = useMemo(() => ({
    total: agents.length,
    active: agents.filter(a => a.status === 1).length,
    pending: agents.filter(a => a.status === 0).length,
    revoked: agents.filter(a => a.status === 2).length,
  }), [agents]);

  const filtered = useMemo(() => agents.filter(a =>
    (filterRole === null || a.role === filterRole) &&
    (filterStatus === null || a.status === filterStatus)
  ), [agents, filterRole, filterStatus]);

  const runHostedDemoReset = () => {
    void (async () => {
      setDemoResetBusy(true);
      setDemoResetMsg('');
      try {
        const { nonce } = await getAuthNonce('admin', wallet);
        const message = buildAdminDemoResetMessage({ nonce });
        const signature = await walletPersonalSign(wallet, message);
        const res = await postDemoReset({ adminAddress: wallet, nonce, signature });
        setDemoResetMsg(res.note ?? 'Hosted demo state cleared.');
        await onAccessRefresh();
        onDemoReset();
      } catch (e) {
        setDemoResetMsg((e as Error).message ?? 'Reset failed');
      } finally {
        setDemoResetBusy(false);
      }
    })();
  };

  const submitRegister = () => {
    if (!ADDR_RE.test(regAddr)) { setRegErr('invalid address'); return; }
    if (!regEns) { setRegErr('ENS name required'); return; }
    setRegErr('');
    const eth = getActiveEthereumProvider();
    if (!eth) { setRegErr('Connect with a browser wallet for write ops'); return; }
    void (async () => {
      try {
        const accounts = await eth.request({ method: 'eth_requestAccounts' }) as string[];
        const from = accounts[0];
        // Use viem encodeFunctionData for correct ABI encoding of
        // registerAndApprove(address,uint8,string,string,uint256)
        const { encodeFunctionData } = await import('viem');
        const data = encodeFunctionData({
          abi: [{
            name: 'registerAndApprove',
            type: 'function',
            inputs: [
              { name: 'agent',      type: 'address' },
              { name: 'role',       type: 'uint8'   },
              { name: 'ensName',    type: 'string'  },
              { name: 'specialty',  type: 'string'  },
              { name: 'reputation', type: 'uint256' },
            ],
            outputs: [],
            stateMutability: 'nonpayable',
          }],
          functionName: 'registerAndApprove',
          args: [
            regAddr as `0x${string}`,
            regRole,
            regEns,
            regSpecialty || '',
            BigInt(75),
          ],
        });
        const txHash = await eth.request({ method: 'eth_sendTransaction', params: [{ from, to: REGISTRY_ADDRESS, data }] }) as string;
        setTxStatus(prev => ({ ...prev, register: `sent: ${txHash.slice(0, 18)}…` }));
        setRegisterOpen(false);
        setRegAddr(''); setRegEns(''); setRegSpecialty('');
        setTimeout(() => void fetchRegistry(), 4000);
      } catch (e) { setRegErr((e as Error).message?.slice(0, 80)); }
    })();
  };

  return (
    <div className="space-y-6">
      <EnrollmentModeration wallet={wallet} onChanged={onAccessRefresh} />

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold">Agent Registry</h1>
          <p className="text-sm text-(--color-argus-muted) mt-1">
            Manage on-chain agents — approve scouts, guardians & watchers.
            <span className="ml-2 mono text-[10px] text-violet-400">{REGISTRY_ADDRESS.slice(0, 10)}…</span>
          </p>
          {owner && (
            <p className="text-[11px] text-(--color-argus-muted) mt-1">
              Registry owner: <span className="mono text-violet-300">{owner.slice(0, 14)}…{owner.slice(-6)}</span>
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={() => void fetchRegistry()}
            className="px-3 py-1.5 text-xs rounded-lg border border-(--color-argus-border) text-(--color-argus-muted) hover:text-(--color-argus-text) transition flex items-center gap-1.5">
            {loading ? <span className="animate-spin">↻</span> : '↻'} Refresh
          </button>
          <button onClick={() => setRegisterOpen(v => !v)}
            className="px-3 py-1.5 text-xs rounded-lg bg-violet-600/80 hover:bg-violet-500/80 text-white font-medium transition">
            + Register agent
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Total', value: counts.total, color: 'text-zinc-200' },
          { label: 'Active', value: counts.active, color: 'text-emerald-400' },
          { label: 'Pending', value: counts.pending, color: 'text-amber-400' },
          { label: 'Revoked', value: counts.revoked, color: 'text-zinc-500' },
        ].map(s => (
          <div key={s.label} className="rounded-xl border border-(--color-argus-border) bg-(--color-argus-card)/40 p-4 text-center">
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-(--color-argus-muted) mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Register form */}
      {registerOpen && (
        <div className="rounded-xl border border-violet-500/30 bg-violet-900/10 p-5 space-y-4">
          <div className="text-sm font-medium text-violet-300">Register & Approve New Agent</div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[11px] text-(--color-argus-muted)">Wallet address *</label>
              <input value={regAddr} onChange={e => setRegAddr(e.target.value)} placeholder="0x…"
                className="w-full mono bg-(--color-argus-bg) border border-(--color-argus-border) rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500/60" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-(--color-argus-muted)">ENS name *</label>
              <input value={regEns} onChange={e => setRegEns(e.target.value)} placeholder="scout.agents.argus-security.eth"
                className="w-full mono bg-(--color-argus-bg) border border-(--color-argus-border) rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500/60" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-(--color-argus-muted)">Specialty</label>
              <input value={regSpecialty} onChange={e => setRegSpecialty(e.target.value)} placeholder="e.g. rug-pull-detection"
                className="w-full bg-(--color-argus-bg) border border-(--color-argus-border) rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500/60" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-(--color-argus-muted)">Role</label>
              <select value={regRole} onChange={e => setRegRole(Number(e.target.value))}
                className="w-full bg-(--color-argus-bg) border border-(--color-argus-border) rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500/60">
                {ROLE_LABEL.map((l, i) => <option key={i} value={i}>{l}</option>)}
              </select>
            </div>
          </div>
          {regErr && <div className="text-[11px] text-rose-400">{regErr}</div>}
          {txStatus['register'] && <div className="text-[11px] text-violet-300 mono">{txStatus['register']}</div>}
          <div className="flex gap-2">
            <button onClick={submitRegister}
              className="px-4 py-2 text-xs rounded-lg bg-violet-600/80 hover:bg-violet-500/80 text-white font-medium transition">
              Register & Approve
            </button>
            <button onClick={() => setRegisterOpen(false)}
              className="px-4 py-2 text-xs rounded-lg border border-(--color-argus-border) text-(--color-argus-muted) hover:text-(--color-argus-text) transition">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-[11px] text-(--color-argus-muted)">Filter:</span>
        <div className="flex gap-1 text-[11px]">
          {[null, ...ROLE_LABEL.map((_, i) => i)].map(r => (
            <button key={r ?? 'all'} onClick={() => setFilterRole(r)}
              className={`px-2.5 py-1 rounded-md border transition ${filterRole === r ? 'border-violet-500/60 bg-violet-500/20 text-violet-300' : 'border-(--color-argus-border) text-(--color-argus-muted) hover:text-(--color-argus-text)'}`}>
              {r === null ? 'All roles' : ROLE_LABEL[r]}
            </button>
          ))}
        </div>
        <div className="flex gap-1 text-[11px]">
          {[null, 0, 1, 2].map(s => (
            <button key={s ?? 'all'} onClick={() => setFilterStatus(s)}
              className={`px-2.5 py-1 rounded-md border transition ${filterStatus === s ? 'border-violet-500/60 bg-violet-500/20 text-violet-300' : 'border-(--color-argus-border) text-(--color-argus-muted) hover:text-(--color-argus-text)'}`}>
              {s === null ? 'All status' : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-900/10 px-4 py-3 text-sm text-rose-300">{error}</div>
      )}

      {/* Agent table */}
      {loading ? (
        <div className="text-sm text-(--color-argus-muted) animate-pulse">Loading registry from Sepolia…</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-(--color-argus-muted)">No agents match the current filter.</div>
      ) : (
        <div className="space-y-2">
          {filtered.map(agent => (
            <AgentRow key={agent.addr} agent={agent} txStatus={txStatus[agent.addr]}
              onApprove={() => void sendTx(agent.addr, 'approve')}
              onRevoke={() => void sendTx(agent.addr, 'revoke')}
            />
          ))}
        </div>
      )}

      <div className="rounded-xl border border-amber-500/25 bg-amber-950/15 p-4 space-y-2">
        <div className="text-sm font-medium text-amber-200/95">Hosted demo environment</div>
        <p className="text-[11px] text-(--color-argus-muted) leading-relaxed">
          Clears signal-api in-memory scores, the live event feed, social pollers, and demo enrollments.
          In standalone mode consensus returns to NONE. Guardian revoke on Sepolia is not undone — re-approve MockUSDC with cast if needed.
        </p>
        <button
          type="button"
          disabled={demoResetBusy}
          onClick={runHostedDemoReset}
          className="px-3 py-2 text-xs rounded-lg border border-amber-500/40 bg-amber-600/20 text-amber-100 font-medium hover:bg-amber-600/30 transition disabled:opacity-40"
        >
          {demoResetBusy ? 'Waiting for wallet…' : 'Reset hosted demo state'}
        </button>
        {demoResetMsg && (
          <p className={`text-[11px] leading-snug ${demoResetMsg.toLowerCase().includes('fail') || demoResetMsg.toLowerCase().includes('error') || demoResetMsg.toLowerCase().includes('unauthorized') ? 'text-rose-400' : 'text-emerald-400/90'}`}>
            {demoResetMsg}
          </p>
        )}
      </div>
    </div>
  );
}

function AgentRow({ agent, txStatus, onApprove, onRevoke }: {
  agent: RegistryAgent;
  txStatus?: string;
  onApprove: () => void;
  onRevoke: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const since = agent.approvedAt > 0n
    ? new Date(Number(agent.approvedAt) * 1000).toLocaleDateString()
    : new Date(Number(agent.registeredAt) * 1000).toLocaleDateString();

  return (
    <div className={`rounded-xl border bg-(--color-argus-card)/40 transition ${agent.status === 0 ? 'border-amber-400/30' : agent.status === 1 ? 'border-(--color-argus-border)' : 'border-zinc-700/40 opacity-60'}`}>
      <button onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left">
        {/* Status dot */}
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${agent.status === 0 ? 'bg-amber-400 animate-pulse' : agent.status === 1 ? 'bg-emerald-400' : 'bg-zinc-600'}`} />

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs font-medium ${ROLE_COLOR[agent.role] ?? 'text-zinc-300'}`}>
              {ROLE_LABEL[agent.role] ?? `Role ${agent.role}`}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_COLOR[agent.status] ?? ''}`}>
              {STATUS_LABEL[agent.status] ?? `Status ${agent.status}`}
            </span>
            {agent.ensName && (
              <span className="mono text-[11px] text-violet-300 truncate">{agent.ensName}</span>
            )}
          </div>
          <div className="mono text-[11px] text-(--color-argus-muted) mt-0.5">
            {agent.addr.slice(0, 14)}…{agent.addr.slice(-8)}
            {agent.specialty && <span className="ml-2 text-zinc-500">· {agent.specialty}</span>}
          </div>
        </div>

        {/* Stats */}
        <div className="hidden sm:flex items-center gap-4 text-[11px] text-(--color-argus-muted)">
          <span title="Reputation">★ {agent.reputation.toString()}</span>
          <span title="Signals submitted">{agent.signalCount.toString()} signals</span>
          <span title="Date">{since}</span>
        </div>

        <span className="text-[10px] text-(--color-argus-muted)">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-(--color-argus-border)/40 pt-3 space-y-3">
          <div className="grid sm:grid-cols-3 gap-3 text-[11px]">
            <div><span className="text-(--color-argus-muted)">Address</span><br /><span className="mono text-zinc-200">{agent.addr}</span></div>
            <div><span className="text-(--color-argus-muted)">Reputation</span><br /><span className="text-zinc-200">{agent.reputation.toString()} pts</span></div>
            <div><span className="text-(--color-argus-muted)">Signals</span><br /><span className="text-zinc-200">{agent.signalCount.toString()}</span></div>
            <div><span className="text-(--color-argus-muted)">Registered</span><br /><span className="text-zinc-200">{new Date(Number(agent.registeredAt) * 1000).toLocaleString()}</span></div>
            {agent.approvedAt > 0n && (
              <div><span className="text-(--color-argus-muted)">Approved</span><br /><span className="text-zinc-200">{new Date(Number(agent.approvedAt) * 1000).toLocaleString()}</span></div>
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2 items-center pt-1">
            {agent.status === 0 && (
              <button onClick={onApprove}
                className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600/70 hover:bg-emerald-500/70 text-white font-medium transition">
                Approve
              </button>
            )}
            {agent.status === 1 && (
              <button onClick={onRevoke}
                className="px-3 py-1.5 text-xs rounded-lg bg-rose-700/50 hover:bg-rose-600/60 text-rose-200 font-medium transition border border-rose-600/30">
                Revoke
              </button>
            )}
            {txStatus && (
              <span className={`mono text-[11px] ${txStatus.startsWith('error') ? 'text-rose-400' : txStatus.startsWith('sent') ? 'text-emerald-400' : 'text-amber-300'}`}>
                {txStatus}
              </span>
            )}
          </div>

          {/* Calldata fallback */}
          {agent.status === 0 && (
            <details className="mt-1">
              <summary className="text-[10px] text-(--color-argus-muted) cursor-pointer hover:text-zinc-300">Show raw calldata (no MetaMask)</summary>
              <div className="mt-1 mono text-[10px] bg-(--color-argus-bg) rounded p-2 break-all text-violet-300">
                {`approveAgent(${agent.addr}) → 0xdaea85c5000000000000000000000000${agent.addr.slice(2).toLowerCase()}`}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function readWalletSession(): string | null {
  try {
    const raw = sessionStorage.getItem(WALLET_SESSION);
    if (!raw || !ADDR_RE.test(raw)) return null;
    return raw.toLowerCase();
  } catch {
    return null;
  }
}

/** Drop legacy sessions that only stored an address (signing would still use the wrong `window.ethereum`). */
function readInitialWallet(): string | null {
  const addr = readWalletSession();
  if (!addr) return null;
  try {
    if (!sessionStorage.getItem(WALLET_PROVIDER_ID)) {
      sessionStorage.removeItem(WALLET_SESSION);
      return null;
    }
  } catch {
    return null;
  }
  return addr;
}

export function App() {
  const [wallet, setWallet] = useState<string | null>(readInitialWallet);
  /** False on first paint when restoring a session until we re-bind the same extension via EIP-6963 id. */
  const [walletTransportReady, setWalletTransportReady] = useState(() => readInitialWallet() == null);
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);
  const [walletPickerChoices, setWalletPickerChoices] = useState<WalletOption[]>([]);
  const [walletPickerErr, setWalletPickerErr] = useState('');
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const [accessErr, setAccessErr] = useState('');
  const [socialAddon, setSocialAddon] = useState(loadSocialAddon);
  const [role, setRole] = useState<Role>('user');
  const roleInitForWallet = useRef<string | null>(null);
  const [watched, setWatched] = useState<string[]>(loadWatched);
  const [selected, setSelected] = useState<string | undefined>(watched[0]);
  const { data: health } = usePoll(getHealth, 5_000, []);
  const { data: boot } = usePoll(getBoot, 5_000, []);
  const { risks, refetchAll } = useRisks(watched);
  const [eventsTick, setEventsTick] = useState(0);
  const events = useEvents(eventsTick);

  const bumpAfterDemoReset = useCallback(() => {
    setEventsTick((t) => t + 1);
    void refetchAll();
  }, [refetchAll]);

  const refreshAccess = useCallback(async (addr?: string | null) => {
    const a = (addr ?? wallet)?.toLowerCase();
    if (!a) {
      setAccess(null);
      return;
    }
    try {
      setAccessErr('');
      const ac = await getAccess(a);
      setAccess(ac);
    } catch (e) {
      setAccessErr((e as Error).message ?? 'access failed');
      setAccess(null);
    }
  }, [wallet]);

  useEffect(() => {
    if (!wallet) {
      setAccess(null);
      return;
    }
    void refreshAccess(wallet);
  }, [wallet, refreshAccess]);

  const showScoutTab = !!(access && (access.privileged || access.approvedRoles.includes('scout')));
  const showAdminTab = !!access?.isAdmin;
  const allowSocialSource = !!(access && (access.privileged || (access.approvedRoles.includes('scout') && socialAddon)));

  useEffect(() => {
    if (role === 'scout' && !showScoutTab) setRole('user');
    if (role === 'admin' && !showAdminTab) setRole('user');
  }, [role, showScoutTab, showAdminTab]);

  useEffect(() => {
    if (!wallet || !access) return;
    if (roleInitForWallet.current === wallet) return;
    roleInitForWallet.current = wallet;
    setRole(access.privileged ? 'scout' : 'user');
  }, [wallet, access]);

  useEffect(() => {
    let pid: string | null = null;
    try {
      pid = sessionStorage.getItem(WALLET_PROVIDER_ID);
    } catch {
      setWalletTransportReady(true);
      return;
    }
    const addr = readWalletSession();
    if (!addr || !pid) {
      setWalletTransportReady(true);
      return;
    }
    void (async () => {
      const opts = await discoverWalletOptions();
      const o = opts.find((x) => x.id === pid);
      if (o) {
        setActiveEthereumProvider(o.provider);
        setWalletTransportReady(true);
        return;
      }
      clearActiveEthereumProvider();
      try {
        sessionStorage.removeItem(WALLET_PROVIDER_ID);
        sessionStorage.removeItem(WALLET_SESSION);
      } catch { /* ignore */ }
      setWallet(null);
      setAccess(null);
      setWalletTransportReady(true);
    })();
  }, []);

  const beginConnect = useCallback(async () => {
    const opts = await discoverWalletOptions();
    if (opts.length === 0) {
      throw new Error('No browser wallet found. Install MetaMask or another wallet extension.');
    }
    if (opts.length === 1) {
      const only = opts[0]!;
      const addr = await connectWithEthereumProvider(only.provider);
      try {
        sessionStorage.setItem(WALLET_SESSION, addr);
        sessionStorage.setItem(WALLET_PROVIDER_ID, only.id);
      } catch { /* ignore */ }
      roleInitForWallet.current = null;
      setWallet(addr);
      await refreshAccess(addr);
      return;
    }
    setWalletPickerErr('');
    setWalletPickerChoices(opts);
    setWalletPickerOpen(true);
  }, [refreshAccess]);

  const completeWalletPick = useCallback(async (opt: WalletOption) => {
    setWalletPickerErr('');
    try {
      const addr = await connectWithEthereumProvider(opt.provider);
      try {
        sessionStorage.setItem(WALLET_SESSION, addr);
        sessionStorage.setItem(WALLET_PROVIDER_ID, opt.id);
      } catch { /* ignore */ }
      roleInitForWallet.current = null;
      setWalletPickerOpen(false);
      setWallet(addr);
      await refreshAccess(addr);
    } catch (e) {
      setWalletPickerErr((e as Error).message ?? 'connect failed');
    }
  }, [refreshAccess]);

  const clearWalletSession = useCallback(() => {
    try {
      sessionStorage.removeItem(WALLET_SESSION);
      sessionStorage.removeItem(WALLET_PROVIDER_ID);
    } catch { /* ignore */ }
    clearActiveEthereumProvider();
    roleInitForWallet.current = null;
    setWallet(null);
    setAccess(null);
    setAccessErr('');
    setRole('user');
    setWalletTransportReady(true);
  }, []);

  const disconnect = useCallback(() => {
    void (async () => {
      await revokeWalletConnection();
      clearWalletSession();
    })();
  }, [clearWalletSession]);

  useEffect(() => {
    if (!wallet || !walletTransportReady) return;
    const eth = getActiveEthereumProvider() as
      | {
          on?: (ev: string, fn: (...args: unknown[]) => void) => void;
          removeListener?: (ev: string, fn: (...args: unknown[]) => void) => void;
          off?: (ev: string, fn: (...args: unknown[]) => void) => void;
        }
      | undefined;
    const subOn = eth?.on;
    const subOff = eth?.removeListener ?? eth?.off;
    if (typeof subOn !== 'function' || typeof subOff !== 'function') return;

    const onAccountsChanged = (accounts: unknown) => {
      const list = Array.isArray(accounts) ? (accounts as string[]) : [];
      if (list.length === 0) {
        clearWalletSession();
        return;
      }
      const next = list[0]?.toLowerCase();
      if (next && /^0x[0-9a-f]{40}$/.test(next)) {
        try {
          sessionStorage.setItem(WALLET_SESSION, next);
        } catch { /* ignore */ }
        roleInitForWallet.current = null;
        setWallet(next);
        void refreshAccess(next);
      }
    };

    try {
      subOn('accountsChanged', onAccountsChanged);
    } catch (e) {
      // e.g. Argent X / broken multiplexers throw inside `.on` (`_events` undefined)
      console.warn('[Argus] skipping accountsChanged listener (wallet provider incompatible)', e);
      return;
    }

    return () => {
      try {
        subOff('accountsChanged', onAccountsChanged);
      } catch { /* ignore */ }
    };
  }, [wallet, walletTransportReady, clearWalletSession, refreshAccess]);

  useEffect(() => saveWatched(watched), [watched]);

  const addAddress = (a: string) => { setWatched((w) => (w.includes(a) ? w : [...w, a])); setSelected(a); };
  const removeAddress = (a: string) => {
    setWatched((w) => w.filter((x) => x !== a));
    setSelected((s) => (s === a ? watched.find((x) => x !== a) : s));
  };

  const cards = useMemo(() => {
    return [...watched].sort((a, b) => {
      const sa = (risks[a]?.envelope?.score ?? 'NONE') as Score;
      const sb = (risks[b]?.envelope?.score ?? 'NONE') as Score;
      return SCORE_ORDER[sb] - SCORE_ORDER[sa];
    });
  }, [watched, risks]);

  if (!wallet) {
    return (
      <>
        <LandingPage onConnect={beginConnect} />
        {walletPickerOpen ? (
          <WalletPickerModal
            choices={walletPickerChoices}
            error={walletPickerErr}
            onPick={completeWalletPick}
            onClose={() => {
              setWalletPickerOpen(false);
              setWalletPickerErr('');
            }}
          />
        ) : null}
      </>
    );
  }

  if (!walletTransportReady) {
    return (
      <div className="relative min-h-screen text-(--color-argus-text) flex flex-col items-center justify-center gap-4 px-6">
        <AppBackdrop />
        <div className="relative z-10 glass-surface px-8 py-10 flex flex-col items-center gap-4">
          <div className="h-12 w-12 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin" />
          <p className="text-sm text-(--color-argus-muted)">Preparing your wallet…</p>
          <button type="button" onClick={() => void disconnect()} className="text-xs text-rose-400 hover:text-rose-300">
            Log out
          </button>
        </div>
      </div>
    );
  }

  if (!access && !accessErr) {
    return (
      <div className="relative min-h-screen text-(--color-argus-text) flex flex-col items-center justify-center gap-4 px-6">
        <AppBackdrop />
        <div className="relative z-10 glass-surface px-8 py-10 flex flex-col items-center gap-4">
          <div className="h-12 w-12 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin" />
          <p className="text-sm text-(--color-argus-muted)">Loading access…</p>
          <button type="button" onClick={() => void disconnect()} className="text-xs text-rose-400 hover:text-rose-300">
            Log out
          </button>
        </div>
      </div>
    );
  }

  if (accessErr || !access) {
    return (
      <div className="relative min-h-screen text-(--color-argus-text) flex flex-col items-center justify-center gap-4 px-6">
        <AppBackdrop />
        <div className="relative z-10 glass-surface px-8 py-10 max-w-md w-full text-center space-y-4">
          <p className="text-sm text-rose-400">{accessErr || 'Could not load access policy.'}</p>
          <button
            type="button"
            onClick={() => void refreshAccess(wallet)}
            className="text-xs px-4 py-2 rounded-xl glass-surface glass-surface-hover border-white/10"
          >
            Retry
          </button>
          <button type="button" onClick={() => void disconnect()} className="text-xs text-(--color-argus-muted) hover:text-zinc-300">
            Log out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen text-(--color-argus-text)">
      <AppBackdrop />
      <Header
        health={health}
        boot={boot}
        role={role}
        onRoleChange={setRole}
        wallet={wallet}
        onDisconnect={disconnect}
        showScoutTab={showScoutTab}
        showAdminTab={showAdminTab}
      />

      {role === 'scout' ? (
        /* ── Scout view ────────────────────────────────────────────── */
        <main className="relative z-10 max-w-7xl mx-auto px-6 py-6 grid gap-6 lg:grid-cols-[340px_1fr]">
          {/* left: intel panel + watchlist */}
          <aside className="space-y-4">
            <IntelPanel onDone={refetchAll} allowSocialSource={allowSocialSource} />
            <SocialAgentPanel onAgentsChanged={refetchAll} />

            {/* watchlist (collapsed-style) */}
            <div className="glass-surface glass-surface-hover p-4 space-y-3 motion-safe:hover:-translate-y-0.5">
              <div className="text-xs uppercase tracking-wider text-(--color-argus-muted)">Watched contracts</div>
              <div className="space-y-1">
                {watched.map((a) => {
                  const score = (risks[a]?.envelope?.score ?? 'NONE') as Score;
                  return (
                    <button
                      key={a}
                      onClick={() => setSelected(a)}
                      className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-xs hover:bg-(--color-argus-card) transition ${selected === a ? 'bg-(--color-argus-card)' : ''}`}
                    >
                      <span className="mono truncate">{a.slice(0, 10)}…{a.slice(-6)}</span>
                      <ScoreBadge score={score} />
                    </button>
                  );
                })}
                {/* add new */}
                <AddressInput onAdd={addAddress} watched={watched} onRemove={removeAddress} />
              </div>
            </div>

            {boot && (
              <div className="glass-surface p-3 text-[11px] text-(--color-argus-muted) space-y-1">
                <div>code_hash <Hex value={boot.code_hash} len={5} /></div>
                <div>boot_commit <Hex value={boot.boot_commitment} len={5} /></div>
                <div>signals {boot.signal_count} / {boot.max_signals}</div>
              </div>
            )}
          </aside>

          {/* right: full event feed + contract details */}
          <section className="space-y-6">
            <EventFeed events={events} />
            <div className="grid sm:grid-cols-2 gap-3">
              {cards.map((addr) => (
                <ContractCard key={addr} addr={addr} state={risks[addr]} onSelect={() => setSelected(addr)} isSelected={selected === addr} />
              ))}
            </div>
            {selected && <DetailPanel addr={selected} state={risks[selected]} />}
          </section>
        </main>
      ) : role === 'user' ? (
        /* ── User view ─────────────────────────────────────────────── */
        <main className="relative z-10 max-w-5xl mx-auto px-6 py-8">
          <div className="mb-6">
            <h1 className="text-lg font-semibold">Your Wallet Protection</h1>
            <p className="text-sm text-(--color-argus-muted) mt-1">
              Argus monitors your token approvals and automatically revokes them if a verified threat is detected.
            </p>
          </div>
          <UserView
            events={events}
            riskState={risks[DEMO_CONTRACT]}
            wallet={wallet}
            access={access}
            onAccessRefresh={() => refreshAccess(wallet)}
            socialOn={socialAddon}
            onSocialChange={(on) => {
              saveSocialAddon(on);
              setSocialAddon(on);
            }}
          />
        </main>
      ) : (
        /* ── Admin view ────────────────────────────────────────────── */
        <main className="relative z-10 max-w-5xl mx-auto px-6 py-8">
          <AdminView
            wallet={wallet}
            onAccessRefresh={() => refreshAccess(wallet)}
            onDemoReset={bumpAfterDemoReset}
          />
        </main>
      )}

      <footer className="relative z-10 max-w-7xl mx-auto px-6 py-8">
        <div className="glass-surface px-4 py-3 text-[11px] text-(--color-argus-muted) text-center">
          polling every 3s · dev: Vite /api & /gw proxies · prod: VITE_SIGNAL_API & VITE_GATEWAY_URL
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// small address input (used in scout sidebar)
// ---------------------------------------------------------------------------

function AddressInput({ onAdd, watched, onRemove }: { onAdd: (a: string) => void; watched: string[]; onRemove: (a: string) => void }) {
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);

  const submit = () => {
    const v = value.trim().toLowerCase();
    if (!ADDR_RE.test(v)) { setErr('invalid address'); return; }
    if (watched.includes(v)) { setErr('already watching'); return; }
    setErr(''); setValue(''); onAdd(v); setOpen(false);
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="w-full text-[10px] px-2.5 py-1.5 rounded-md border border-dashed border-(--color-argus-border) text-(--color-argus-muted) hover:bg-(--color-argus-card)">
        + add address
      </button>
    );
  }
  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex gap-1.5">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setOpen(false); }}
          placeholder="0x…"
          autoFocus
          className="mono flex-1 bg-(--color-argus-bg) border border-(--color-argus-border) rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400/60"
        />
        <button onClick={submit} className="px-2 py-1 text-xs rounded bg-amber-400/80 text-zinc-950 font-medium">add</button>
        <button onClick={() => setOpen(false)} className="px-2 py-1 text-xs text-(--color-argus-muted) hover:text-zinc-200">×</button>
      </div>
      {err && <div className="text-[10px] text-rose-400">{err}</div>}
      {watched.length > 1 && (
        <div className="text-[10px] text-(--color-argus-muted)">
          {watched.map((a) => (
            <span key={a} className="mr-2">
              {a.slice(0, 8)}… <button onClick={() => onRemove(a)} className="text-rose-400 hover:text-rose-300">×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

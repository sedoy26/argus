import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getBoot,
  getHealth,
  getPreview,
  getRisk,
  submitSignal,
  type SubmitSignalArgs,
} from './api';
import type {
  BootInfo,
  ConsensusEnvelope,
  GatewayPreview,
  HealthInfo,
  Score,
} from './types';

// ---------------------------------------------------------------------------
// localStorage-backed watchlist
// ---------------------------------------------------------------------------

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const WATCHED_KEY = 'argus.watched.v1';
const DEFAULT_WATCHED: string[] = [
  '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
];

function loadWatched(): string[] {
  try {
    const raw = localStorage.getItem(WATCHED_KEY);
    if (!raw) return DEFAULT_WATCHED;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return DEFAULT_WATCHED;
    return arr.filter(
      (s): s is string => typeof s === 'string' && ADDR_RE.test(s),
    );
  } catch {
    return DEFAULT_WATCHED;
  }
}

function saveWatched(list: string[]): void {
  localStorage.setItem(WATCHED_KEY, JSON.stringify(list));
}

// ---------------------------------------------------------------------------
// score colours
// ---------------------------------------------------------------------------

const SCORE_BG: Record<Score, string> = {
  NONE: 'bg-zinc-700/40 text-zinc-300 ring-zinc-600/40',
  YELLOW: 'bg-amber-400/20 text-amber-200 ring-amber-300/40',
  ORANGE: 'bg-orange-400/25 text-orange-200 ring-orange-300/40',
  RED: 'bg-rose-500/30 text-rose-200 ring-rose-400/40',
  CRITICAL: 'bg-red-500/40 text-red-100 ring-red-300/60 animate-pulse',
};

function ScoreBadge({ score }: { score: Score }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${SCORE_BG[score]}`}
    >
      {score}
    </span>
  );
}

function Hex({ value, len = 8 }: { value: string; len?: number }) {
  if (!value) return <span className="text-zinc-500">—</span>;
  if (value.length < len * 2 + 2) return <span className="mono">{value}</span>;
  return (
    <span
      title={value}
      className="mono cursor-help"
      onClick={() => navigator.clipboard.writeText(value)}
    >
      {value.slice(0, 2 + len)}…{value.slice(-len)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

interface RiskState {
  envelope?: ConsensusEnvelope;
  preview?: GatewayPreview | null;
  error?: string;
  fetchedAt: number;
}

function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: React.DependencyList,
): { data: T | null; error: string | null; refetch: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  const refetch = useCallback(async () => {
    try {
      const v = await fetchRef.current();
      setData(v);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    let active = true;
    void (async () => {
      while (active) {
        await refetch();
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    })();
    return () => {
      active = false;
    };
  }, [refetch, intervalMs]);

  return { data, error, refetch };
}

function useRisks(addresses: string[]): {
  risks: Record<string, RiskState>;
  refetchAll: () => void;
} {
  const [risks, setRisks] = useState<Record<string, RiskState>>({});

  const refetchAll = useCallback(() => {
    addresses.forEach((addr) => {
      void Promise.all([getRisk(addr), getPreview(addr)]).then(
        ([envelope, preview]) => {
          setRisks((r) => ({
            ...r,
            [addr]: { envelope, preview, fetchedAt: Date.now() },
          }));
        },
        (err) => {
          setRisks((r) => ({
            ...r,
            [addr]: {
              ...r[addr],
              error: (err as Error).message,
              fetchedAt: Date.now(),
            },
          }));
        },
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

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

function Header({
  health,
  boot,
}: {
  health: HealthInfo | null;
  boot: BootInfo | null;
}) {
  const ok = health?.status === 'ok';
  return (
    <header className="border-b border-(--color-argus-border) bg-(--color-argus-card)/80 backdrop-blur sticky top-0 z-20">
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-amber-300 via-orange-400 to-rose-500 grid place-items-center text-zinc-950 font-bold text-sm">
            Ar
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight">Argus</div>
            <div className="text-xs text-(--color-argus-muted)">
              the hundred-eyed guardian of Web3
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6 text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${ok ? 'bg-emerald-400' : 'bg-rose-500'}`}
            />
            <span className="text-(--color-argus-muted)">
              bridge {health?.bridge ?? '—'}
            </span>
          </div>
          {boot && (
            <div className="flex items-center gap-4">
              <div className="text-(--color-argus-muted)">
                code <Hex value={boot.code_hash} len={6} />
              </div>
              <div className="text-(--color-argus-muted)">
                signals {boot.signal_count}/{boot.max_signals}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function WatchlistInput({
  onAdd,
  watched,
  onRemove,
}: {
  onAdd: (a: string) => void;
  watched: string[];
  onRemove: (a: string) => void;
}) {
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const submit = () => {
    const v = value.trim().toLowerCase();
    if (!ADDR_RE.test(v)) {
      setErr('not a 20-byte 0x address');
      return;
    }
    if (watched.includes(v)) {
      setErr('already watching');
      return;
    }
    setErr('');
    setValue('');
    onAdd(v);
  };
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label className="text-xs uppercase tracking-wider text-(--color-argus-muted)">
          add address
        </label>
        <div className="flex gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="0x…"
            className="mono flex-1 bg-(--color-argus-bg) border border-(--color-argus-border) rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400/60"
          />
          <button
            onClick={submit}
            className="px-3 py-1.5 text-sm rounded-md bg-amber-400/90 hover:bg-amber-300 text-zinc-950 font-medium"
          >
            watch
          </button>
        </div>
        {err && <div className="text-xs text-rose-400">{err}</div>}
      </div>
      <div className="space-y-1">
        <label className="text-xs uppercase tracking-wider text-(--color-argus-muted)">
          watching
        </label>
        <div className="space-y-1">
          {watched.length === 0 && (
            <div className="text-xs text-(--color-argus-muted)">empty</div>
          )}
          {watched.map((a) => (
            <div
              key={a}
              className="flex items-center justify-between gap-2 text-xs mono py-0.5"
            >
              <span className="truncate" title={a}>
                {a.slice(0, 10)}…{a.slice(-6)}
              </span>
              <button
                onClick={() => onRemove(a)}
                className="text-(--color-argus-muted) hover:text-rose-400"
                title="stop watching"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ContractCard({
  addr,
  state,
  onSelect,
  isSelected,
}: {
  addr: string;
  state: RiskState | undefined;
  onSelect: () => void;
  isSelected: boolean;
}) {
  const env = state?.envelope;
  const score = (env?.score ?? 'NONE') as Score;
  const summary = env?.summary || '—';
  const updated = env?.last_signal_ts
    ? new Date(env.last_signal_ts * 1000).toLocaleTimeString()
    : '—';
  return (
    <button
      onClick={onSelect}
      className={`text-left rounded-xl border p-4 hover:bg-(--color-argus-card) transition ${
        isSelected
          ? 'border-amber-400/60 bg-(--color-argus-card)'
          : 'border-(--color-argus-border) bg-(--color-argus-card)/50'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="mono text-sm truncate" title={addr}>
          {addr.slice(0, 10)}…{addr.slice(-8)}
        </div>
        <ScoreBadge score={score} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
        <div>
          <div className="text-(--color-argus-muted)">confirmed</div>
          <div className="text-base font-semibold">
            {env?.confirmed ?? 0}/{env?.count ?? 0}
          </div>
        </div>
        <div>
          <div className="text-(--color-argus-muted)">confidence</div>
          <div className="text-base font-semibold">{env?.confidence ?? 0}</div>
        </div>
        <div>
          <div className="text-(--color-argus-muted)">last signal</div>
          <div className="text-sm">{updated}</div>
        </div>
      </div>
      <div className="mt-3 text-[11px] text-(--color-argus-muted) line-clamp-2">
        {summary}
      </div>
    </button>
  );
}

function DetailPanel({
  addr,
  state,
}: {
  addr: string;
  state: RiskState | undefined;
}) {
  const env = state?.envelope;
  const records = state?.preview?.records ?? {};
  return (
    <section className="rounded-xl border border-(--color-argus-border) bg-(--color-argus-card)/60 p-5 space-y-5">
      <div>
        <div className="text-xs uppercase tracking-wider text-(--color-argus-muted)">
          contract
        </div>
        <div className="mono text-sm break-all">{addr}</div>
      </div>
      {env && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Field label="score">
            <ScoreBadge score={env.score} />
          </Field>
          <Field label="confidence">{env.confidence}</Field>
          <Field label="confirmed / total">
            {env.confirmed} / {env.count}
          </Field>
          <Field label="last signal ts">
            {env.last_signal_ts
              ? new Date(env.last_signal_ts * 1000).toLocaleString()
              : '—'}
          </Field>
          <Field label="code_hash" wide>
            <Hex value={env.code_hash} />
          </Field>
          <Field label="boot_commitment" wide>
            <Hex value={env.boot_commitment} />
          </Field>
          <Field label="attestation" wide>
            <Hex value={env.attestation} />
          </Field>
        </div>
      )}
      {env?.summary && (
        <div className="text-xs">
          <div className="text-(--color-argus-muted) uppercase tracking-wider mb-1">
            summary
          </div>
          <div className="mono text-zinc-200">{env.summary}</div>
        </div>
      )}
      {Object.keys(records).length > 0 && (
        <div className="text-xs">
          <div className="text-(--color-argus-muted) uppercase tracking-wider mb-1">
            ENS records (gateway)
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {Object.entries(records)
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span className="text-(--color-argus-muted) min-w-[120px]">
                    {k}
                  </span>
                  <span className="mono break-all">{v}</span>
                </div>
              ))}
          </div>
        </div>
      )}
      {!env && state?.error && (
        <div className="text-xs text-rose-400">error: {state.error}</div>
      )}
    </section>
  );
}

function Field({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <div className="text-xs text-(--color-argus-muted) uppercase tracking-wider">
        {label}
      </div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function SubmitForm({
  defaultAddr,
  onSubmitted,
}: {
  defaultAddr?: string;
  onSubmitted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [args, setArgs] = useState<SubmitSignalArgs>({
    contractAddress: defaultAddr ?? '',
    chainId: 31337,
    threatType: 'SWAT-001',
    verdict: 'CONFIRMED',
    evidence: { source: 'manual', note: 'submitted from dashboard' },
    submitter: 'dashboard.argus.eth',
    reputation: 80,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (defaultAddr) setArgs((a) => ({ ...a, contractAddress: defaultAddr }));
  }, [defaultAddr]);

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await submitSignal(args);
      onSubmitted();
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full text-xs px-3 py-1.5 rounded-md border border-dashed border-(--color-argus-border) text-(--color-argus-muted) hover:bg-(--color-argus-card)"
      >
        + submit manual signal
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-(--color-argus-border) bg-(--color-argus-bg) p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-(--color-argus-muted)">
          manual signal
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-(--color-argus-muted) hover:text-zinc-200 text-xs"
        >
          ×
        </button>
      </div>
      <Input
        label="contract"
        mono
        value={args.contractAddress}
        onChange={(v) => setArgs((a) => ({ ...a, contractAddress: v }))}
      />
      <div className="grid grid-cols-2 gap-2">
        <Input
          label="threat"
          value={args.threatType}
          onChange={(v) => setArgs((a) => ({ ...a, threatType: v }))}
        />
        <Select
          label="verdict"
          value={args.verdict}
          options={['CONFIRMED', 'UNCONFIRMED', 'DISPUTED']}
          onChange={(v) =>
            setArgs((a) => ({
              ...a,
              verdict: v as SubmitSignalArgs['verdict'],
            }))
          }
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input
          label="submitter"
          value={args.submitter}
          onChange={(v) => setArgs((a) => ({ ...a, submitter: v }))}
        />
        <Input
          label="reputation"
          value={String(args.reputation)}
          onChange={(v) =>
            setArgs((a) => ({ ...a, reputation: Number(v) || 0 }))
          }
        />
      </div>
      {err && <div className="text-xs text-rose-400">{err}</div>}
      <button
        disabled={busy}
        onClick={submit}
        className="w-full text-xs px-3 py-1.5 rounded-md bg-amber-400/90 hover:bg-amber-300 text-zinc-950 font-medium disabled:opacity-50"
      >
        {busy ? 'submitting…' : 'submit'}
      </button>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-(--color-argus-muted)">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full mt-0.5 bg-(--color-argus-bg) border border-(--color-argus-border) rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400/60 ${mono ? 'mono' : ''}`}
      />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-(--color-argus-muted)">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full mt-0.5 bg-(--color-argus-bg) border border-(--color-argus-border) rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400/60"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

export function App() {
  const [watched, setWatched] = useState<string[]>(loadWatched);
  const [selected, setSelected] = useState<string | undefined>(watched[0]);
  const { data: health } = usePoll(getHealth, 5_000, []);
  const { data: boot } = usePoll(getBoot, 5_000, []);
  const { risks, refetchAll } = useRisks(watched);

  useEffect(() => saveWatched(watched), [watched]);

  const addAddress = (a: string) => {
    setWatched((w) => (w.includes(a) ? w : [...w, a]));
    setSelected(a);
  };
  const removeAddress = (a: string) => {
    setWatched((w) => w.filter((x) => x !== a));
    setSelected((s) =>
      s === a ? watched.find((x) => x !== a) ?? undefined : s,
    );
  };

  // Sort cards: highest score first.
  const cards = useMemo(() => {
    const order: Record<Score, number> = {
      CRITICAL: 4,
      RED: 3,
      ORANGE: 2,
      YELLOW: 1,
      NONE: 0,
    };
    return [...watched].sort((a, b) => {
      const sa = (risks[a]?.envelope?.score ?? 'NONE') as Score;
      const sb = (risks[b]?.envelope?.score ?? 'NONE') as Score;
      return order[sb] - order[sa];
    });
  }, [watched, risks]);

  return (
    <div className="min-h-screen text-(--color-argus-text)">
      <Header health={health} boot={boot} />
      <main className="max-w-7xl mx-auto px-6 py-6 grid gap-6 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-6">
          <WatchlistInput
            onAdd={addAddress}
            watched={watched}
            onRemove={removeAddress}
          />
          <SubmitForm
            defaultAddr={selected ?? watched[0]}
            onSubmitted={refetchAll}
          />
          {boot && (
            <div className="rounded-md border border-(--color-argus-border) bg-(--color-argus-card)/40 p-3 text-[11px] text-(--color-argus-muted) space-y-1">
              <div>
                code_hash <Hex value={boot.code_hash} len={5} />
              </div>
              <div>
                boot_commit <Hex value={boot.boot_commitment} len={5} />
              </div>
              <div>
                signals {boot.signal_count} / {boot.max_signals}
              </div>
            </div>
          )}
        </aside>
        <section className="space-y-6">
          {cards.length === 0 && (
            <div className="text-sm text-(--color-argus-muted)">
              add an address to start watching.
            </div>
          )}
          <div className="grid sm:grid-cols-2 gap-3">
            {cards.map((addr) => (
              <ContractCard
                key={addr}
                addr={addr}
                state={risks[addr]}
                onSelect={() => setSelected(addr)}
                isSelected={selected === addr}
              />
            ))}
          </div>
          {selected && <DetailPanel addr={selected} state={risks[selected]} />}
        </section>
      </main>
      <footer className="max-w-7xl mx-auto px-6 py-6 text-[11px] text-(--color-argus-muted)">
        polling every 3s · proxy /api → signal-api · /gw → ens-resolver
      </footer>
    </div>
  );
}

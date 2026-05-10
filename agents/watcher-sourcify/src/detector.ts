// SWAT-001 — Approval-abuse via arbitrary external call.
// SWAT-002 — Authentication via tx.origin (phishing / proxy bypass class).
//
// Pattern: a function takes an address and a bytes parameter and
// performs `<address>.call(<bytes>)` (or `.delegatecall` /
// `.staticcall`) without an access-control guard. With any user
// approval to the contract, an attacker can pivot through that call
// into `transferFrom(victim, attacker, amount)` and drain funds.
//
// We use string + regex scans rather than a proper Solidity parser.
// For hackathon-scale source files this is enough; documented
// limitations:
//   - assembly blocks are not modelled
//   - inline functions captured via function pointers are missed
//   - require(msg.sender == ROLE) only catches "==" exact form
//   - we don't follow modifiers across files

import type { SolFile } from './sourcify.ts';

export type ThreatType = 'SWAT-001' | 'SWAT-002';

export interface Detection {
  threatType: ThreatType;
  /** File the finding came from. */
  file: string;
  /** Function name that contains the vulnerability. */
  function: string;
  /** Reconstructed function header
   *  `name(addrType addrName, bytesType bytesName, ...)`. */
  signature: string;
  /** Body excerpt that triggered the match (whitespace-collapsed). */
  bodySnippet: string;
  /** "delegatecall" is more dangerous than "call" — flag it. */
  callKind: 'call' | 'delegatecall' | 'staticcall';
  /** True if the function had an obvious owner/role guard or
   *  `require(msg.sender == ...)` early in its body. We don't
   *  suppress the detection, but a downstream submitter can lower
   *  its reputation if guarded. */
  accessControlled: boolean;
}

export interface DetectorReport {
  detections: Detection[];
  /** All files we scanned, for evidence. */
  scannedFiles: string[];
}

export function detectAll(files: SolFile[]): DetectorReport {
  const detections: Detection[] = [];
  for (const f of files) {
    detections.push(...detectInFile(f));
    detections.push(...detectTxOriginMisuse(f));
  }
  return { detections, scannedFiles: files.map((f) => f.name) };
}

/** SWAT-002 — `tx.origin` used as an authorization primitive (anti-pattern). */
function detectTxOriginMisuse(file: SolFile): Detection[] {
  const stripped = stripComments(file.content);
  if (!/\btx\.origin\b/.test(stripped)) return [];
  // Ignore comments-only: stripComments already removed // and /* */
  const out: Detection[] = [];
  for (const fn of iterateFunctions(stripped)) {
    if (!/\btx\.origin\b/.test(fn.body)) continue;
    out.push({
      threatType: 'SWAT-002',
      file: file.name,
      function: fn.name,
      signature: `${fn.name}(${normalizeParams(fn.params)})`,
      bodySnippet: extractSnippet(fn.body),
      callKind: 'call',
      accessControlled: looksAccessControlled(fn.modifiers, fn.body),
    });
  }
  if (out.length === 0) {
    out.push({
      threatType: 'SWAT-002',
      file: file.name,
      function: '(file)',
      signature: 'tx.origin reference',
      bodySnippet: 'tx.origin',
      callKind: 'call',
      accessControlled: false,
    });
  }
  return out;
}

function detectInFile(file: SolFile): Detection[] {
  const stripped = stripComments(file.content);
  const detections: Detection[] = [];
  for (const fn of iterateFunctions(stripped)) {
    const params = parseParams(fn.params);
    const addrParams = params.filter((p) => p.type.startsWith('address'));
    const bytesParams = params.filter((p) => p.type.startsWith('bytes'));
    if (addrParams.length === 0 || bytesParams.length === 0) continue;

    for (const addr of addrParams) {
      for (const bytesP of bytesParams) {
        const callKind = findArbitraryCall(fn.body, addr.name, bytesP.name);
        if (!callKind) continue;
        detections.push({
          threatType: 'SWAT-001',
          file: file.name,
          function: fn.name,
          signature: `${fn.name}(${normalizeParams(fn.params)})`,
          bodySnippet: extractSnippet(fn.body),
          callKind,
          accessControlled: looksAccessControlled(fn.modifiers, fn.body),
        });
      }
    }
  }
  return detections;
}

// ---------------------------------------------------------------------------
// Source scanners
// ---------------------------------------------------------------------------

function stripComments(s: string): string {
  // Order matters: block comments first (they may span lines), then //.
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

interface FunctionExtract {
  name: string;
  params: string;
  modifiers: string;
  body: string;
}

/** Walks the source text, yielding each `function NAME(...) ... { ... }`
 *  with brace-balanced bodies. We use matchAll() (not stateful regex)
 *  and skip any header whose start sits inside an already-consumed
 *  function body. */
function* iterateFunctions(src: string): Generator<FunctionExtract> {
  const headerRe = /function\s+(\w+)\s*\(([^)]*)\)\s*([^{;]*)\{/g;
  let cursor = 0;
  for (const m of src.matchAll(headerRe)) {
    if (m.index === undefined || m.index < cursor) continue;
    const name = m[1]!;
    const params = m[2]!;
    const modifiers = m[3]!;
    const bodyStart = m.index + m[0].length;
    const bodyEnd = matchClosingBrace(src, bodyStart);
    if (bodyEnd < 0) continue;
    yield {
      name,
      params,
      modifiers,
      body: src.slice(bodyStart, bodyEnd),
    };
    cursor = bodyEnd + 1;
  }
}

/** Given an index pointing AFTER an opening `{`, return the index of
 *  the matching closing `}`, or -1 if not found. Quotes/strings inside
 *  the body are crude — we ignore curly braces inside double-quoted
 *  strings. */
function matchClosingBrace(s: string, start: number): number {
  let depth = 1;
  let i = start;
  let inString = false;
  let stringChar = '';
  while (i < s.length) {
    const c = s[i]!;
    if (inString) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === stringChar) inString = false;
    } else {
      if (c === '"' || c === "'") {
        inString = true;
        stringChar = c;
      } else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    i++;
  }
  return -1;
}

interface SolParam {
  type: string;
  name: string;
}

function parseParams(s: string): SolParam[] {
  const trimmed = s.trim();
  if (!trimmed) return [];
  return trimmed
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      // Tokens: e.g. "address target", "bytes calldata data",
      // "address payable to". Type is everything before the LAST
      // identifier token.
      const tokens = p.split(/\s+/);
      if (tokens.length === 0) return null;
      const name = tokens[tokens.length - 1]!;
      const type = tokens.slice(0, -1).join(' ');
      return { type, name };
    })
    .filter((x): x is SolParam => !!x && x.name.length > 0);
}

function normalizeParams(s: string): string {
  return s
    .split(',')
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(', ');
}

function findArbitraryCall(
  body: string,
  addrName: string,
  bytesName: string,
): 'call' | 'delegatecall' | 'staticcall' | null {
  // Match patterns like:
  //   target.call(data)
  //   target.call{value: ...}(data)
  //   target.delegatecall(data)
  //   (bool ok, ) = target.call(data);
  const pat = new RegExp(
    `\\b${escapeRe(addrName)}\\s*\\.(call|delegatecall|staticcall)\\s*` +
      `(?:\\{[^}]*\\}\\s*)?` +
      `\\(\\s*${escapeRe(bytesName)}\\b`,
    'm',
  );
  const m = body.match(pat);
  if (!m) return null;
  return m[1] as 'call' | 'delegatecall' | 'staticcall';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksAccessControlled(modifiers: string, body: string): boolean {
  if (/\bonlyOwner\b|\bonlyAdmin\b|\bauthOnly\b|\bonlyRole\b/.test(modifiers))
    return true;
  // `require(msg.sender == ...)` or `if (msg.sender != ...) revert`.
  return (
    /require\s*\(\s*msg\.sender\s*==/.test(body) ||
    /if\s*\(\s*msg\.sender\s*!=/.test(body)
  );
}

function extractSnippet(body: string, max = 220): string {
  const trimmed = body.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + '…';
}

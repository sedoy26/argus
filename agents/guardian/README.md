# Argus Guardian

Watches a contract address for risk-score escalation; when it crosses
the threshold, revokes every protected wallet's approval to that
address on every guarded token.

## Architecture

```
                    signal-api
                        │
                  GET /risk/:addr
                        │
                        ▼
                  ┌───────────┐         build approve(spender, 0)
   protected ───► │  Guardian │────────► sign  ───► sendRawTransaction
   wallets        │   loop    │                      to RPC
                  └───────────┘
                        │
                        ▼
                     Signer
                  ┌─────┴─────┐
            LocalSigner   KmsSigner
            (privKey)     (Orbitport)
```

The signer abstraction is the point: in development you can use
`LocalSigner` (a viem `privateKeyToAccount`); in production you wire
`KmsSigner` to SpaceComputer Orbitport KMS where the key is generated
inside the KMS, never seen by this process. Combined with on-chain
session-key scoping (ERC-4337) at the smart-wallet layer, the guardian
*physically cannot* sign anything outside its allowed set.

## Configuration

Environment variables (see `.env.example`):

| Var | Required | Notes |
|---|---|---|
| `RPC_URL` | yes | EVM RPC endpoint |
| `GUARDIAN_SPENDER` | yes | address to monitor + revoke approvals to |
| `GUARDIAN_TOKENS` | yes | comma-separated ERC-20 token addresses |
| `GUARDIAN_THRESHOLD` | no | default `CRITICAL`; one of NONE/YELLOW/ORANGE/RED/CRITICAL |
| `GUARDIAN_POLL_MS` | no | default `5000` |
| `ARGUS_API` | no | default `http://127.0.0.1:8787` |
| `GUARDIAN_PRIVATE_KEY` | path A | `0x`-prefixed 32-byte hex; selects `LocalSigner` |
| `ORBITPORT_CLIENT_ID` | path B | + `ORBITPORT_CLIENT_SECRET` + `KMS_KEY_ID`; selects `KmsSigner` |

If neither signer path is fully configured the guardian errors at
startup.

## Running

```bash
bun install
cp .env.example .env
# fill in .env, then:
bun run start
```

## Smoke test (local Anvil, no KMS, no testnet)

The smoke spins a fresh Anvil, deploys MockUSDC + FakeSwapNet from
`contracts/out/`, approves max, escalates the spender to CRITICAL via
signal-api, runs `guardian.revokeAll()`, and confirms the attacker can
no longer drain via FakeSwapNet's arbitrary-call vulnerability.

Prereqs:

1. `forge build` in `contracts/`
2. signal-api up on :8787
3. applet up on :4000 (`make qemu` in `platform/tee/`)

```bash
bun run smoke
```

## KMS path (when you have credentials)

1. Register at https://accounts.spacecomputer.io for client ID/secret.
2. Create an ETHEREUM-scheme key once and remember its `KeyId` and
   `Address`:
   ```ts
   const key = await sdk.kms.createKey({
     alias: 'argus-guardian',
     keySpec: 'ECC_SECG_P256K1',
     keyUsage: 'SIGN_VERIFY',
     scheme: 'ETHEREUM',
   });
   ```
3. Fund the address on the target chain (Sepolia / Anvil / mainnet).
4. Set `ORBITPORT_CLIENT_ID` / `ORBITPORT_CLIENT_SECRET` / `KMS_KEY_ID`
   (and optionally `KMS_KEY_ADDRESS` to skip the recovery probe).
5. `bun run start`.

The guardian will sign each revoke with `kms.sign({ messageType:
"DIGEST", signingAlgorithm: "ETHEREUM_SECP256K1" })` against the
keccak-256 digest of the unsigned EIP-1559 transaction.

# Argus contracts

Solidity contracts deployed alongside the Argus consensus engine. Built
with [Foundry](https://book.getfoundry.sh/).

## Layout

```
contracts/
├── foundry.toml
├── src/
│   └── ArgusRiskResolver.sol     ENS wildcard resolver (EIP-3668 + ENSIP-10)
├── test/
│   └── ArgusRiskResolver.t.sol
├── script/
│   └── Deploy.s.sol              parameterised Sepolia deploy
└── lib/                          forge-std (vendored, not a submodule)
```

## ArgusRiskResolver

ENS wildcard resolver for `*.<your-name>.eth`. Every `resolve(name,
data)` call reverts with `OffchainLookup` pointing at the off-chain
Argus gateway (`platform/ens-resolver/`); the gateway extracts the
contract address from the leading wildcard label, queries the Argus
consensus envelope from the signal-api, and ABI-encodes the answer.

Wire-up sequence (Sepolia or mainnet):

1. Deploy this contract with one or more public gateway URLs.
2. On the ENS name you want to act as the wildcard root (e.g.
   `risks.argus.eth`), call `ENS.setResolver(node, <this contract>)`.
3. Resolution of any subname like `0xdead...risks.argus.eth` now
   returns Argus-attested risk records.

There is no on-chain signature verification: the trust anchor is the
gateway URL plus the TEE attestation tag the gateway returns inside
the consensus envelope. This is fine for hackathon / demo use; for
production, wrap responses in an Ed25519 signature and verify it in
`resolveCallback`.

## Build & test

```bash
forge install              # if lib/forge-std is missing
forge build
forge test
```

## Deploy (Sepolia)

```bash
export SEPOLIA_RPC_URL=https://...
export PRIVATE_KEY=0x...
export ARGUS_URLS='https://gateway.argus.example/lookup/{sender}/{data}.json'
# optional:
# export ARGUS_OWNER=0x...

forge script script/Deploy.s.sol:Deploy \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast \
  --verify
```

The script logs the deployed address and current owner.

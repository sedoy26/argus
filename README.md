# Argus

**The hundred-eyed guardian of Web3.**

A TEE-verified security intelligence network for Ethereum. Watchers report threats, the platform verifies them inside a Trusted Execution Environment against Sourcify source code, and risk scores are published via ENS so any wallet can check any contract. Autonomous guardians revoke approvals using keys that no operator can extract.

Built for **ETHPrague 2026**.

## The trust stack

| Layer | Trust guarantee | Sponsor tech |
|---|---|---|
| Consensus | Computed by attested code in TrustZone | SpaceComputer GoTEE (QEMU → USB Armory) |
| Verification | Cross-checked against actual source | Sourcify API + Parquet/BigQuery |
| Distribution | Resolvable by any ENS-aware client | ENS CCIP-Read wildcard resolver |
| Execution | Signing key unreachable by operator | SpaceComputer KMS |
| Intelligence | Off-chain feeds paid per-request | Apify + X402 |

See [`architecture-vision.md`](./architecture-vision.md) for the full design.

## Repo layout

```
contracts/        Solidity — FakeSwapNet, MockUSDC, ArgusRegistry, RecoveryVault
platform/
  tee/            GoTEE Trusted Applet (Rust) + Normal World host (Go)
  signal-api/     Signal submission endpoint
  ens-resolver/   CCIP-Read wildcard gateway
  risk-db/        Risk score storage
agents/
  watcher-sourcify/  Source-code pattern detector
  watcher-onchain/   On-chain event monitor
  scout-apify/       X402-paid intelligence scraper
  guardian/          KMS-signed protection agent
dashboard/        React + Vite frontend
scripts/          Deploy, setup, demo helpers
presentation/     Slides + backup demo video
```

## Quickstart

Components are independent — each subdirectory has its own setup. See per-component READMEs once added.

For pre-hackathon prep checklist, see Section 8 of `architecture-vision.md`.

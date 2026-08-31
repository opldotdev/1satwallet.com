# 1Sat Wallet

The BRC-100 web wallet served at [1satwallet.com](https://1satwallet.com).
[opldotdev/1satwallet.com](https://github.com/opldotdev/1satwallet.com) is the
authoritative repository and `main` is its only release branch. Links to the
historical
[opldotdev/1sat-website:omega](https://github.com/opldotdev/1sat-website/tree/omega)
source describe the project's history and are not a current merge or deployment
target.

The app can use a BRC-100 wallet supplied by 1Sat Wallet Desktop, an injected
wallet such as Yours, or an embedded mobile host. It also includes its own web
wallet and exposes that wallet to other websites through the CWI bridge.

The wallet owns balances, send/receive, owned assets, activity, identity,
certificates, permissions, backup/import, providers, and hosted-wallet access.
Marketplace discovery, collections, listings, trading, publisher tools, and
market analytics remain the responsibility of [1sat.market](https://1sat.market).
The two products should link to one another instead of duplicating their core
workflows.

## Getting started

Install dependencies, configure the environment, and start the development
server:

```bash
bun install
cp .env.example .env.local
bun run dev
```

Open [http://localhost:8255](http://localhost:8255).

Before submitting changes, run:

```bash
bun run lint
bunx tsc --noEmit
bun run build
```

## Architecture

- `@1sat/connect` discovers and monitors external BRC-100 wallets.
- `@1sat/wallet-browser` supplies the built-in browser wallet.
- `@1sat/actions` implements 1Sat asset and payment operations over a standard
  BRC-100 `WalletInterface`.
- `@1sat/client` connects the UI to the public services at `api.1sat.app`.
- `wallet.1sat.app` stores and synchronizes the built-in BRC-100 wallet.

See [docs/BRC100_GAP_ANALYSIS.md](docs/BRC100_GAP_ANALYSIS.md) for the standards
comparison, supported connection modes, and remaining product work.

## Deployment

The new Vercel project, environment ownership, domain cutover, and security
headers are defined in [docs/deployment.md](docs/deployment.md). The review
path, release gate, rollback runbook, and release-notes template live in
[docs/release.md](docs/release.md). Production must be public; Preview
protection is an explicit project policy. Do not promote a build until the
release gate is green.

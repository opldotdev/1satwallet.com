# 1Sat Wallet

A web wallet for Bitcoin SV and 1Sat assets at [1satwallet.com](https://1satwallet.com).
Use the built-in browser wallet or connect a compatible BRC-100 wallet.

## Getting started

```bash
bun install
cp .env.example .env.local
bun run dev
```

Open [http://localhost:8255](http://localhost:8255).

## Checks

```bash
bun run lint
bunx tsc --noEmit
bun run build
```

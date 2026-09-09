# Safe Agent UI

Next.js demo for Safe issuers: deploy/import Safe, create agent EOAs, mint anonymous OPRF notes, cash out clear tokens to an agent.

Plan: [`../docs/SAFE-AGENT-UI-MVP.md`](../docs/SAFE-AGENT-UI-MVP.md)

Style/structure follows `sodawallet/packages/nextjs` (sidebar shell, `--wallet-*` tokens, RainbowKit + wagmi).

## Setup

```bash
cd wallet/safe-agent-ui
cp .env.example .env.local
npm install
npm run dev
```

Open [http://localhost:3010](http://localhost:3010).

## What’s working now (Phase 0 / early Phase 1)

- App shell (Soda green theme, sidebar, MetaMask connect, Arb Sepolia guard)
- Safe **import** (ownership check) and **deploy** 1-of-1 (canonical Safe 1.4.1)
- Agents create/list/delete (localStorage, including private keys — demo only)
- Notes placeholder + off-chain assign
- Treasury / Act balance reads when `NEXT_PUBLIC_UNDERLYING` is set

## Next

- Shield + private balance
- On-chain mintOPRFToken + decrypt
- Agent-paid redeem to clear

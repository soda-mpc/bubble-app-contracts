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

## What’s working now

- App shell (Soda green theme, sidebar, MetaMask connect, Arb Sepolia guard)
- Safe **import**, **deploy 1-of-1**, and **deploy k-of-n** (e.g. 2-of-3 with local demo co-owners)
- Shared AES for IT inspection; personal Bubble keys for vault decrypt (`owner = Safe` after contract view)
- Treasury: MultiSend shield + view grants, encrypted private transfer, decrypt
- Agents create/list/delete (localStorage, including private keys — demo only)
- Notes mint / assign / agent cash-out when tokens are configured

## Next

- Paste external co-signer EIP-712 signatures (multi-device)
- Safe Transaction Service / pending-tx queue
- Facilitator gasless spend path
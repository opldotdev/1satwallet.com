# OrdLock listing create OFF (OPL-4693 / OPL-4694)

`ORDLOCK_LISTING_DISABLED` is **true** on this site.

## Policy

- **Create** listing: OFF (wallet UI + action dispatch).
- **Buy** existing listings: ON.
- **Cancel** existing listings: ON.

This repo (`opldotdev/1satwallet.com`) is the live omega/wallet web surface.
Wallet listing-create UI lives here, so both site and wallet tickets apply.

## What changed here

- Kill switch: `lib/ordlock.ts` (`ORDLOCK_LISTING_DISABLED`).
- Create paths throw `LISTING_CREATE_OFF_MESSAGE` before `sellOrdinal` /
  `sellOpns`.
- Wallet ordinal List control and OpNS List for sale are hidden.
- Market browse / My Listings keep buy and cancel.

## Do not mix

Ty Everett / BSV dependency upgrade PRs are a separate wave. Not this change.
Cancel-listed-UTXO on load / BSV sweep is OPL-4696.

## Re-enable

Flip `ORDLOCK_LISTING_DISABLED` after the replacement contract lands.

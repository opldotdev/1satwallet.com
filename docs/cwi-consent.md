# Hosted CWI consent

The hosted consent surface uses the `GroupedPermissions`,
`CounterpartyPermissions`, and `PermissionRequest` types exported by the
installed official wallet toolbox.

- BRC-73 grouped requests are parsed before display. Privileged entries,
  unsafe numeric values, reserved baskets, malformed verifier/counterparty
  keys, duplicate certificate fields, and invalid Level 2 scopes cannot be
  approved.
- Every grouped item is independently selectable. Protocol, basket, and
  certificate grants can expire after 30 days or remain until revoked.
- Spending prompts show the structured total and all wallet-provided line
  items, including the fee. The user must choose one-time or a standing monthly
  authorization. A standing amount must exactly equal the pending request.
- PACT prompts accept only Level 2 protocols and show both the full application
  origin and full counterparty public key.
- `/manifest.json` declares schema version 1 and no app permissions because the
  website currently requires no grouped permission declaration of its own.

## 1Color (testnet)

On testnet the built-in wallet registers the BRC-207 color module
(`@bsv/color-permission-module`) under `p color`. The module keeps no grants
and asks the host on every token operation; `lib/cwi/color-consent.ts` (a port
of Yours `src/services/colorConsent.ts`, 1color branch) answers:

- The wallet itself (the admin originator, exact match) is approved without a
  prompt. An app on another port of the wallet's host is asked like any app.
- A read of a `p color` basket (`color_access` with a basket) is approved by a
  saved basket grant for that app and basket. Otherwise the user is asked
  (`basketAccess` prompt), unless the app passed `seekPermission: false`, which
  declines; an approval saves the grant until revoked.
- A `listActions` naming `p color` labels, every send or handoff
  (`color_send`, titled "Token Handoff" for a handoff), every signature of an
  app-built transaction (`color_signature`) and every relinquish
  (`color_relinquish`) is asked every time and saves nothing.
- An unreadable message or an unknown type is declined without a prompt and
  logged.

Prompts go through `requestAssetPermission` to the CWI relay, with the
wallet's chain, as the 1Sat asset modules' prompts do. A decline makes the
module throw `ColorConsentDeclinedError` to the app.

Basket grants live only in IndexedDB (`1sat-wallet-permissions:` +
`1satwallet-color-<chain>`, `IndexedDbPermissionStore` from
`@1sat/wallet-browser`), not as on-chain permission tokens like the rest of
the manager's grants. `/wallet/permissions` lists them under "1Color token
access" with revoke. If the store cannot be read, the request fails with
"Could not read saved 1Color permissions." and the detail is logged; if a
grant cannot be saved, the approved read goes ahead and the next one asks
again.

The permissions manager also passes `p color` `getPublicKey` and
`verifySignature` to the module without a prompt (this wallet reveals public
keys without asking), and receipts through `internalizeAction` are verified by
the module against the overlay. A funded `createAction` with a color plan is
covered by the manager's spending authorization and the `color_send` consent
at signing; a decline aborts the action. An app's plain `listActions` never
shows `p color` actions or outputs; one that names a `p color` label sees the
actions carrying it, once the user approves. Mainnet has no color module, so
`p color` stays unsupported there.

The website does not treat this UI as proof that the full BRC-116 lifecycle is
production-ready. OPL-3993 must make persistent individual grants settle only
after token creation, OPL-3994 must invalidate revoked permission caches
immediately, and OPL-4005 must replace the observable same-origin channel token
with a trust-anchored encrypted hosted transport. External provider and funded
monthly-rollover certification also remain required.

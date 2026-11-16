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
  prompt, before its message is read. Apps arrive as a hostname without a
  port, and the relay, bridge and redirect flows refuse an app on the
  wallet's own hostname, so no app matches it.
- A read of a `p color` basket (`color_access` with a basket) is approved by a
  saved basket grant for that app and basket. Otherwise the user is asked
  (`basketAccess` prompt), unless the app passed `seekPermission: false`, which
  declines; an approval saves the grant until revoked.
- A `listActions` naming `p color` labels, every send (`color_send`), every
  signature of an app-built transaction (`color_signature`) and every
  relinquish (`color_relinquish`) is asked every time and saves nothing.
- An app's unreadable message or unknown type is declined without a prompt and
  logged.

Prompts go through `requestAssetPermission` to the CWI relay, with the
wallet's chain, as the 1Sat asset modules' prompts do. A decline makes the
module throw `ColorConsentDeclinedError` to the app.

Basket grants live only in IndexedDB, one store per wallet and chain
(`1sat-wallet-permissions:` + `1satwallet-color-<chain>-<identityKey>`,
`IndexedDbPermissionStore` from `@1sat/wallet-browser`), not as on-chain
permission tokens like the rest of the manager's grants, so a grant one wallet
gave never answers for another wallet in the same browser. Removing the wallet
deletes its own store first, then any other color grant store the browser
lists, in parallel. Each delete is logged; one blocked by an open connection is
logged, waited for at most 5 seconds, and finishes once that connection
closes. A failed database listing is logged and skipped. When the wallet is
locked (its identity key unknown) and the browser cannot list databases,
nothing can be deleted and a warning is logged.
`/wallet/permissions` lists the current wallet's grants under "1Color token
access" with revoke, and reloads them whenever the page is seen again. If the
store cannot be read, the request fails with "Could not read saved 1Color
permissions." and the detail is logged; a failed store call is logged and the
store is opened afresh on the next call, so a transient IndexedDB failure does
not stick. If a grant cannot be saved, the approved read goes ahead and the
next one asks again.

### Routes the color consent does not prompt

- **Token handoffs are refused to apps.** A `createAction` with a `p color
  plan` label and a BRC-177 `p nosend expiry …` label is a handoff. For one
  that asks for less than a held output, the module splits that output first
  (`createAction` → `fund` → `settleFunding` → `splitExact` → `split`), signing
  and broadcasting the split through the raw wallet before anyone is asked and
  outside the manager's spending authorization and limits. The module the
  manager registers (`appGatedColorModule` in `lib/wallet/color-module.ts`)
  refuses such a request from any originator but the wallet itself, logs it,
  and throws "Token handoffs are not available to apps yet." before the module
  runs. The wallet's own handoffs reach the bare module unchanged.
- **Other app token sends are gated by `color_send`, not the spending
  prompt.** The module funds them with token inputs from the wallet. From
  wallet-toolbox-client 2.17.0 the manager computes an app's spend from the
  args after the module changed them, so those inputs are subtracted from the
  app's spend and listed as "No input description provided": the spending
  prompt can under-report a token move. The module asks `color_send` in
  `signAction` before it signs any input it funded (the only other place it
  signs funded inputs is the handoff split, refused above), and a decline
  aborts the action. `tests/color-app-funded-send.test.ts` checks this through
  the manager.
- **The identity key never comes through a protocol.** The manager hands a
  `p ` protocol's `getPublicKey` to its module before its own identity-key
  check, and the wallet returns the identity key whenever `identityKey` is
  set. So `getPublicKey({ identityKey: true, protocolID: [2, "p color …"] })`
  would return the identity key with no prompt (the same holds for the 1Sat
  modules' `p ` schemes on both chains). The module-identifier guard refuses an
  app's `getPublicKey` that sets `identityKey` together with any `protocolID`
  (`identity-key-with-protocol`). `getPublicKey({ identityKey: true })` on its
  own gets the manager's normal identity-key prompt. Other `p color`
  `getPublicKey` and `verifySignature` calls go to the module without a prompt
  (this wallet reveals public keys without asking).
- **Apps never read custody records.** A `p color` output's
  `customInstructions` is its custody record, whose `senderIdentityKey` is the
  wallet's identity key, and a saved basket grant answers a basket read with no
  prompt. So the module-identifier guard strips `customInstructions` from an
  app's `listOutputs` of a `p color` basket, and from every output of a
  `p color` action an app lists (outputs in `p color` baskets are already
  hidden). The wallet's own reads keep them.
- **Receipts are accepted without a prompt.** An app's `internalizeAction`
  into a `p color` value or authority basket goes to the module, which has no
  receive message type and asks nobody, as in Yours (1color branch) and the
  module itself. Each receipt must be a BRC-162 token output whose basket
  matches its asset and role, owned by this wallet (its custody key derives to
  the output's lock), of a supported asset, and admitted and unspent in the
  asset's overlay; anything else is refused. Receiving tokens the overlay has
  admitted to keys this wallet owns cannot spend or reveal anything, so this is
  accepted by design.

An app's plain `listActions` never shows `p color` actions or outputs; one
that names a `p color` label sees the actions carrying it, once the user
approves. Mainnet has no color module, so `p color` stays unsupported there.

### Known upstream issue: staged inputs after a failed createAction

When an app's (or the wallet's) `p color` `createAction` fails after the
module funded it (for example the user declines the spending authorization,
another module or the wallet throws), the module keeps the funded token
outputs in its in-memory `staged` set: only `onResponse` unstages them, and the
permissions manager calls no module hook on failure. Those outputs are then
skipped by later sends and refused as explicit inputs until the wallet is
reopened (`dispose` clears them). Nothing is spent or lost. The fix belongs
upstream (a failure hook in the manager and unstaging in the module); this
wallet does not work around it.

The website does not treat this UI as proof that the full BRC-116 lifecycle is
production-ready. OPL-3993 must make persistent individual grants settle only
after token creation, OPL-3994 must invalidate revoked permission caches
immediately, and OPL-4005 must replace the observable same-origin channel token
with a trust-anchored encrypted hosted transport. External provider and funded
monthly-rollover certification also remain required.

# 1Sat Wallet P2P settlement profile

Status: draft implementation plan for OPL-4156

Standards authority: [draft BRC-178](https://github.com/opldotdev/BRCs/pull/6)

The trading floor settles two-party NFT (1Sat Ordinal), BSV21, BSV, and mixed
trades with the collaborative atomic exchange profile in draft BRC-178. This
document only records how `1satwallet.com` coordinates that standard. It does
not define a second transaction or signing protocol.

## Required boundaries

- `@1sat/actions` constructs and reconstructs the final funded transaction,
  traces 1Sat Ordinal NFT satoshis, validates BSV21 conservation and overlay
  fees, signs contributed inputs, verifies scripts, and completes the retained
  BRC-100 action.
- Each connected wallet independently reviews the final transaction and signs
  only its own asset inputs with `SIGHASH_ALL | SIGHASH_FORKID`.
- Convex authenticates and orders coordination messages, records bounded
  commitments and recovery state, and relays evidence. Convex never has wallet
  authority and never decides that a transaction is valid on a wallet's behalf.
- Presence, cursors, identity display, audio, trade-window UX, and offer editing
  are product features. They are not part of BRC-178.

The coordination envelope uses profile `brc-178` and wire version `1`. All
amounts are canonical decimal strings. Identity keys, hashes, and outpoints are
lowercase canonical encodings. Unknown fields fail closed.

## Settlement flow

1. Both participants authenticate and lock the same offer.
2. The fixed builder and fee payer create one settlement attempt.
3. Each wallet selects fresh, unspent assets and supplies receiver-controlled
   destinations. BSV21 selection uses the ordinary `bsv21` basket; Ordinal
   NFTs use the ordinary `1sat` basket.
4. The builder wallet creates an unfixed BRC-100 action with
   `signAndProcess: false` and `randomizeOutputs: false`, then retains the action
   reference locally.
5. Both wallets reconstruct and review the final funded transaction. The
   `templateHash` is SHA-256 of the raw transaction with every input script
   empty, exactly as draft BRC-178 specifies. `manifestHash` is review metadata,
   not a competing authorization commitment.
6. Each wallet signs its owned asset inputs and locally verifies the resulting
   unlocking scripts before releasing them.
7. The builder verifies both authorizations and completes the retained action.
8. Chain acceptance, BSV21 overlay admission, and wallet internalization are
   tracked separately. A timeout is an unknown outcome, not a failed trade.

## Coordinator responsibilities

The coordinator keeps the existing signed BRC-77 command log and enforces:

- exact session, attempt, participant, sender, recipient, chain, expiry, and
  locked-offer bindings;
- monotonically increasing signer revisions and one-use nonces;
- idempotent replay of identical commands and rejection of changed bytes;
- one fixed builder and fee payer per attempt;
- one compare-and-set broadcast lease;
- monotonic recovery and terminal states; and
- bounded retention of commitments, evidence hashes, and redacted errors.

Application-local reservation IDs and destination proofs may travel in these
messages, but they are not BRC-178 authorization. A reservation is not a global
UTXO lock. A destination proof helps the application authenticate the receiver
choice; the receiving wallet must still derive or approve that destination and
commit it through final transaction signing.

Convex must not store private keys, seeds, derivation secrets, BRC-100 action
references, permission grants, unlocking scripts, or unrelated wallet inputs.

## BSV21 requirements

BSV21 support is mandatory for the trading floor:

- selected inputs must be active, unspent transfer outputs for the exact token
  ID with current validity evidence;
- amounts use checked unsigned 64-bit arithmetic;
- receiver amount plus owner change must equal selected input amount for every
  token ID independently;
- deploy, mint, authority, burn, implicit burn, and cross-token netting fail
  closed;
- current required overlay-fee outputs are part of final transaction review;
  and
- settlement is not complete until every required overlay admits the expected
  outputs.

The connected wallet owns permission policy and prompts. The site must not
depend on the retired `1sat module` dispatch path or substitute a web dialog for
the provider prompt.

## Release gates

Atomic trading remains disabled until all of these are complete:

- the draft BRC is reviewed and its final number/profile name is confirmed;
- the `@1sat/actions` primitive is reviewed, released, and consumed here;
- the wallet UI displays exact sends, receives, change, mining fees, overlay
  fees, counterparty identity, and expiry from the final transaction;
- built-in, Yours-injected, 1Sat Desktop, and embedded mobile providers pass
  two-device certification for Ordinal NFT and BSV21 exchanges;
- the evidence service proves exact transaction acceptance and BSV21 overlay
  admission; and
- receipt-driven internalization is idempotent and recovery-tested.

The detailed coordinator API and deployment boundary are documented in
[`p2p-settlement-coordinator.md`](./p2p-settlement-coordinator.md).

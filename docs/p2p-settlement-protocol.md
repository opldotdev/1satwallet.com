# 1Sat Wallet P2P settlement profile

Status: draft implementation boundary for OPL-4156 and OPL-4162

Standards authority: [draft BRC-178](https://github.com/opldotdev/BRCs/pull/6)

The trading floor exchanges 1Sat Ordinal NFTs, BSV21, ordinary BSV, or a mix
of those assets in one Bitcoin transaction. The transaction settles every leg
or none of them.

## The protocol is the transaction

The existing trading floor already authenticates trade requests and offer
updates with BRC-77. Locking both offers confirms the terms; it is not a
transaction signature. Each wallet then resolves its offer to current asset
outpoints, token change, fees, and receiver-approved destinations.

1. If ordinary BSV is offered, its payer is the builder. Without a BSV leg, the
   first confirmer or initiator may build. Builder selection never causes an
   early signature.
2. After both concrete contributions are available, the builder asks its
   BRC-100 wallet to construct and fund one unsigned action
   with `signAndProcess: false` and `randomizeOutputs: false`.
3. The builder keeps the returned action reference local and sends the
   candidate transaction plus its validation data to the peer.
4. Each wallet independently reconstructs and reviews the same candidate.
5. Each asset owner signs only its own asset inputs with
   `SIGHASH_ALL | SIGHASH_FORKID` and returns the unlocking scripts or an
   equivalent partially signed transaction.
6. The builder verifies the scripts, signs its funding inputs, and broadcasts
   the unchanged transaction. A BSV-only builder has no separate asset
   authorization; its wallet authorizes the funding inputs in this step.
7. Both wallets independently observe the result and internalize their received
   outputs.

The Bitcoin input signatures are the spend authorization. The website does not
add a separately signed settlement offer, canonical JSON commitment, settlement
identifier, attempt object, transaction-authorization hash, or authorization
expiry.

## Relay boundary

BRC-77 remains useful because Convex is an untrusted relay. Its signatures
authenticate which wallet sent a relay command; they do not authorize a spend.
A future direct peer transport may use BRC-103 instead.

The minimal relay should reuse the existing ready `p2pSessions` record and carry
only:

- each party's bounded concrete contribution;
- one final candidate transaction from the selected builder;
- one signature response from each asset owner for that exact candidate; and
- the final transaction ID or an outcome-unknown marker needed for reconnect.

Changed candidate bytes require a fresh wallet review and fresh Bitcoin
signatures. Convex must never receive a wallet action reference, private key,
seed, derivation secret, or permission grant.

The removed draft coordinator was intentionally not retained: its prepare,
contribution, manifest, authorization, attempt, lease, and receipt state machine
duplicated the existing offer negotiation and the transaction checks performed
by the wallets.

Historical asynchronous 1Sat listings use
`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY` because a seller signs before a buyer
adds funding. This live trade flow waits for both contributions and the final
funded transaction, so it uses `SIGHASH_ALL | SIGHASH_FORKID`. A BIP-174 PSBT
can transport metadata and partial signatures but does not change those
signature commitments; Atomic BEEF is the preferred BSV transaction container.

## Required wallet validation

`@1sat/actions` owns transaction construction and validation. Before signing,
each wallet must verify the exact inputs, outputs, order, scripts, satoshi
amounts, sequences, fees, version, and lock time.

For 1Sat Ordinal NFTs it must also verify the current tip, ownership, provenance,
and final satoshi placement.

For BSV21 it must also verify active unspent transfer tips, exact token ID,
checked uint64 quantities, independent conservation per token ID, exact change,
and every required overlay-fee output. Deploy, mint, authority, burn, implicit
burn, and cross-token netting fail closed.

The connected wallet owns its permission policy and approval UI. The site uses
the standard `1sat` and `bsv21` baskets and does not depend on the retired
`1sat module` dispatch path.

## Release gates

Atomic trading remains unavailable until:

- the draft BRC and `@1sat/actions` implementation are reviewed and released;
- the minimal transport for candidate transaction data is selected and bounded;
- the trade dialog renders exact sends, receives, change, mining fees, overlay
  fees, and counterparty identity from the reconstructed candidate;
- built-in, Yours-injected, 1Sat Desktop, and embedded mobile providers pass
  two-device NFT and BSV21 certification; and
- uncertain broadcast, BSV21 overlay admission, reconnect, and idempotent
  internalization paths are tested end to end.

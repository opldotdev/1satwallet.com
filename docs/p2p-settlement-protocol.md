<!-- markdownlint-disable MD013 -->

# 1Sat P2P atomic settlement protocol

Status: implementation specification for OPL-4156

Protocol identifier: `1sat-p2p-settlement`

Wire version: `1`

Scope: two-party mainnet settlement of ordinals and BSV21 tokens, with BSV used for network funding and protocol fees

## Decision summary

Version 1 settles both sides of a trade in **one Bitcoin transaction**. Every asset owner verifies the final transaction and signs only the inputs they own with `SIGHASH_ALL | SIGHASH_FORKID`. The designated builder's BRC-100 wallet contributes transaction funding and change, but the builder cannot change an asset recipient, token amount, input, fee output, or any other transaction effect after either party signs.

The protocol deliberately separates three kinds of authority:

1. BRC-77 signatures authenticate negotiation and coordinator commands.
2. BRC-100 wallet calls authorize local key use and produce the actual input signatures.
3. Chain and overlay evidence establish settlement. A Convex state or UI action never establishes ownership.

BSV21 offers remain value-based during negotiation. Concrete BSV21 tips are selected, overlay-validated, and soft-reserved only after both offers are locked and settlement begins. This prevents long-lived disclosure and reservation of wallet inventory.

The current `1sat-sdk` cosign flow is **not** this protocol. It transfers already cosign-wrapped BSV21 inputs through one cosigner wallet. It does not exchange arbitrary inputs owned by two independent BRC-100 wallets, does not settle an ordinal leg atomically against a token leg, and must not be presented as a general swap primitive.

## Normative language and references

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative.

This protocol builds on:

- BRC-100 for wallet actions, signatures, aborts, and internalization.
- BRC-77 for signed application messages already used by the website's P2P command log.
- BRC-99 only as a namespace rule. Ordinary asset storage uses baskets `1sat` and `bsv21`; this protocol does not require a `p 1sat ...` basket or action label.
- BRC-116 for wallet permission behavior. The wallet, not the web page or Convex, owns the final permission decision and originator policy.

## Security properties

Version 1 provides:

- **Atomic asset exchange:** either the one transaction spends all offered inputs and creates all agreed outputs, or it does neither.
- **Exact authorization:** each input signature commits to every input outpoint, sequence, output script, output amount, transaction version, and lock time.
- **Token conservation:** for every token ID, selected BSV21 input quantity equals receiver quantity plus owner change. Mint, auth, and implicit burn are forbidden.
- **Offer binding:** every settlement artifact commits to the locked offer revisions, both identity keys, chain, session, attempt, and expiry.
- **Replay resistance:** BRC-77 command nonces remain one-use; partial input signatures are accepted only for one exact template and attempt.
- **Coordinator containment:** a malicious coordinator may delay or withhold settlement, but cannot alter a signed transaction or complete only one leg.
- **Truthful recovery:** broadcast, overlay admission, and wallet internalization are distinct observable states.

Version 1 does not provide:

- A global UTXO lock against another application using the same wallet. Reservations are local leases; a conflicting spend causes a safe failure, not half a trade.
- Fair liveness against a participant who refuses to sign or a builder who withholds the completed transaction.
- Privacy from the counterparty for the concrete inputs needed to validate and sign the transaction.
- A general multi-party or order-book matching protocol.

## Participants and fixed roles

Each settlement has exactly two participant identity keys, `partyA` and `partyB`, copied from the mutually locked negotiation. Identity key ordering is lexicographic and is used only for canonicalization.

One participant is the `builder` and `feePayer`. In version 1 they MUST be the same identity. This participant's BRC-100 wallet creates the signable action, contributes ordinary BSV funding inputs, pays mining fees and BSV21 overlay fees, and receives BSV change. The builder is selected in the locked settlement intent and cannot change within an attempt.

The website or a Convex worker acts as a `coordinator`. It relays authenticated state and evidence. It never receives a BRC-100 action reference, wallet secret, seed, private derivation data, or unencrypted key material.

If a negotiated trade includes an explicit BSV payment leg, version 1 requires the BSV payer to be the builder. A generic BRC-100 application cannot select and partially sign another wallet's ordinary funding inputs. Trades that would require the non-builder to pay BSV MUST reverse the builder role before locking or be rejected as unsupported.

## Data normalization and commitments

### Primitive normalization

- Wire network is the literal `main` or `test`, matching the current SDK and
  provider contract. User-facing code may call these mainnet and testnet, but
  it MUST convert to the wire literal before hashing or signing. Production
  rejects `test` and every chain mismatch.
- Identity public keys are lowercase compressed SEC hex.
- Transaction IDs are lowercase 64-character hex. BSV21 token IDs are the
  canonical deployment outpoint `txid_vout`, not a bare transaction ID.
- Outpoints use canonical `txid_vout`, where `vout` is an unsigned base-10 integer without leading zeroes.
- Satoshi and BSV21 quantities are base-10 strings without a sign or leading zeroes. Zero is allowed only where a field explicitly says so.
- BSV21 atomic quantities MUST be in `1..18446744073709551615` and all intermediate sums MUST be checked without `uint64` overflow, matching the overlay's `uint64` quantity domain.
- Times are integer Unix milliseconds.
- Hex is lowercase and has no `0x` prefix.
- Unknown fields are rejected. Wire messages are not open extension bags.

### Canonical JSON

All control-plane commitments use RFC 8785 JSON Canonicalization Scheme (JCS), UTF-8, followed by SHA-256:

```text
digest(object) = lowercaseHex(SHA256(UTF8(JCS(object))))
```

Implementations MUST NOT use ordinary `JSON.stringify` output as a cross-wallet commitment. Amounts remain strings so JavaScript number coercion cannot change them.

### Locked offer commitment

`offerDigest` commits to the last mutually locked state:

```ts
type LockedOfferCommitmentV1 = {
  protocol: "1sat-p2p-settlement"
  version: 1
  chain: "main" | "test"
  sessionId: string
  parties: [string, string] // lexicographically sorted identity keys
  offers: Array<{
    owner: string
    revision: number
    items: Array<
      | { kind: "ordinal"; outpoint: string }
      | { kind: "bsv21"; tokenId: string; amount: string }
      | { kind: "bsv"; satoshis: string }
    >
  }> // sorted by owner; item order is semantic and preserved
  builder: string
  feePayer: string
  expiresAt: number
}
```

Duplicate ordinal outpoints, duplicate BSV legs for one `(owner, tokenId)`, zero quantities, an identity not in `parties`, and `builder !== feePayer` are invalid. A wallet recomputes `offerDigest` from signed locked offers; it does not accept the coordinator's digest on faith.

### Transaction template commitment

The builder obtains the final signable transaction from `wallet.createAction({ options: { signAndProcess: false, randomizeOutputs: false } })`. Wallet-added funding inputs and change are therefore known before either participant signs.

Define `unsignedTxHex` as the standard raw transaction serialization with every input unlocking script replaced by an empty script, while retaining final input order, outpoints, sequences, outputs, version, and lock time. The BEEF container is not used as a canonical transaction commitment because equivalent BEEF encodings may order proofs differently.

```ts
type TemplateManifestV1 = {
  protocol: "1sat-p2p-settlement"
  version: 1
  chain: "main" | "test"
  sessionId: string
  settlementId: string
  attempt: number
  offerDigest: string
  builder: string
  expiresAt: number
  unsignedTxHash: string // SHA256(raw unsigned transaction bytes)
  inputs: Array<{
    index: number
    outpoint: string
    owner: string | "builder-funding"
    purpose: "ordinal" | "bsv21" | "bsv-funding"
    tokenId?: string
    tokenAmount?: string
    sourceSatoshis: string
    sourceScriptHash: string
  }> // exact transaction order
  outputs: Array<{
    index: number
    owner: string | "overlay-fee" | "builder-change"
    purpose:
      | "ordinal-receipt"
      | "bsv21-receipt"
      | "bsv21-change"
      | "bsv-payment"
      | "overlay-fee"
      | "builder-change"
    satoshis: string
    scriptHash: string
    tokenId?: string
    tokenAmount?: string
    sourceOrdinal?: string
  }> // exact transaction order
  overlayPolicies: Array<{
    tokenId: string
    statusCheckedAt: number
    feeAddress: string
    feePerOutput: string
    countedOutputs: number
    totalFee: string
  }> // sorted by tokenId
}

templateHash = digest(TemplateManifestV1)
```

Every participant MUST reconstruct the manifest from the AtomicBEEF, source evidence, locked offer, receiver destinations, and fresh overlay responses. A manifest sent by the coordinator is only a proposal.

`sourceScriptHash` and `scriptHash` are SHA-256 of raw script bytes. The manifest does not expose wallet custom instructions. Those remain local wallet metadata.

## Version 1 messages

Every message is carried inside the existing signed P2P command envelope. The envelope MUST bind `type`, `version`, `chain`, `sessionId`, `settlementId`, `attempt`, sender identity, recipient identity, monotonically increasing session revision, one-use nonce, `issuedAt`, `expiresAt`, and the message body. Server-side BRC-77 verification and role checks occur before any state mutation.

### `settlement.prepare`

Sent by each participant after both offers are locked:

```ts
{
  offerDigest: string
  walletIdentity: string
  providerInstanceId: string // random public instance handle, not a secret
  capabilities: {
    exactTemplateReview: true
    externalInputSignature: true
    localReservationLease: true
    internalizeAction: true
  }
}
```

A wallet switch changes `walletIdentity` or `providerInstanceId`, invalidates the attempt, and releases its local leases. Settlement restarts with `attempt + 1`.

### `settlement.contribution`

Produced only after both prepare messages are accepted:

```ts
{
  offerDigest: string
  reservationId: string
  reservationExpiresAt: number
  inputs: Array<{
    outpoint: string
    purpose: "ordinal" | "bsv21"
    tokenId?: string
    tokenAmount?: string
    sourceSatoshis: string
    sourceScriptHash: string
    sourceBeefHash: string
  }>
  destinations: Array<{
    legIndex: number
    purpose: "ordinal-receipt" | "bsv21-receipt" | "bsv-payment"
    lockingScript: string
    satoshis: string
    tokenId?: string
    tokenAmount?: string
    destinationProof: string
  }>
  contributionHash: string
}
```

The full source AtomicBEEF and receiver insertion remittance travel as bounded opaque settlement artifacts or directly between clients. Convex stores their hashes and expiry, not arbitrary private wallet metadata. `destinationProof` is a wallet signature over the destination fields, settlement identity, attempt, receiver identity, and sender identity. The receiving wallet MUST regenerate or verify that it controls each destination; a remote display name or raw script is not ownership proof.

### `settlement.template`

Sent by the builder after `createAction` returns:

```ts
{
  offerDigest: string
  contributionHashes: [string, string]
  templateHash: string
  manifest: TemplateManifestV1
  signableBeefHash: string
}
```

The builder retains the BRC-100 `reference` locally. It MUST NOT be sent to the peer or stored in Convex. The signable AtomicBEEF artifact is content-addressed by `signableBeefHash`, size-bounded, encrypted in transit, and deleted after the recovery retention window.

### `settlement.authorize`

Sent only after a wallet independently validates the final transaction:

```ts
{
  offerDigest: string
  templateHash: string
  contributionHash: string
  authorizedInputs: Array<{
    inputIndex: number
    unlockingScriptHash: string
  }> // sorted by inputIndex; exactly the sender's owned inputs
  authorizationExpiresAt: number
}
```

The associated opaque payload contains unlocking scripts only for indexes owned by the sender. Each unlocking script is locally script-verified against the source output before relay. The BRC-77 authorization is necessary control-plane evidence, but the unlocking scripts' `SIGHASH_ALL | SIGHASH_FORKID` signatures are the on-chain authority.

No participant sends an unlocking script until all of these checks pass:

1. Identity, chain, session, attempt, offer digest, and expiry match.
2. Every agreed asset input is present exactly once and no unagreed asset input is present.
3. Every receiver destination was approved by its owner.
4. Each ordinal is still unspent and maps to its exact recipient output.
5. Every selected BSV21 tip is still active and unspent in the configured overlay.
6. Per-token input, receipt, and change quantities conserve exactly.
7. Overlay fee outputs match current policies and are not paid twice.
8. Explicit BSV payment, mining funding, and change effects match the intent and builder role.
9. The template contains no unknown script/output purpose.
10. The wallet's native BRC-100 permission UI approves the verified effects.

### `settlement.broadcast-claim`

The builder claims the one broadcast lease with:

```ts
{
  templateHash: string
  authorizationHashes: [string, string]
  broadcaster: string
  leaseId: string
  leaseExpiresAt: number
}
```

Convex grants this with a compare-and-set only when both authorizations are current. The claim reduces duplicate calls; it is not proof that no participant broadcast out of band.

### `settlement.broadcast-result`

```ts
{
  templateHash: string
  rawTxHash: string
  txid: string
  broadcaster: string
  submittedAt: number
  providerResult: "accepted" | "already-known" | "unknown" | "rejected"
  evidenceHash: string
}
```

`accepted` and `already-known` move to chain verification. `unknown` moves to outcome recovery. `rejected` is terminal only after input-spend checks prove the exact transaction did not win.

### Cancellation, expiry, and failure

- `settlement.cancel` is accepted only before the first unlocking script is relayed.
- A denial or expiry before authorization aborts the builder's BRC-100 action and releases local leases.
- Once any unlocking script has been relayed, the UI MUST say **authorization submitted; checking outcome**. Cancellation cannot promise that the transaction will not broadcast.
- Any new template uses `attempt + 1`, new contributions, new reservations, a new BRC-100 action, and new signatures. A template is never patched in place.

## State machine

| State | Entry condition | Legal next states |
| --- | --- | --- |
| `locked` | Both offer revisions signed and locked | `preparing`, `expired`, `cancelled` |
| `preparing` | Settlement ID, attempt, builder fixed | `contributing`, `expired`, `cancelled`, `failed` |
| `contributing` | Both wallets declared capabilities | `constructing`, `expired`, `cancelled`, `failed` |
| `constructing` | Both contributions current and reserved | `reviewing`, `expired`, `cancelled`, `failed` |
| `reviewing` | Final AtomicBEEF and template published | `partially_authorized`, `authorized`, `expired`, `cancelled`, `failed` |
| `partially_authorized` | One participant relayed an unlock | `authorized`, `outcome_unknown`, `failed` |
| `authorized` | Both exact-template authorizations accepted | `broadcasting`, `outcome_unknown` |
| `broadcasting` | Builder holds broadcast lease | `verifying`, `outcome_unknown`, `failed` |
| `verifying` | Exact tx submitted or already known | `overlay_pending`, `internalizing`, `conflicted`, `outcome_unknown` |
| `overlay_pending` | Chain tx found; one or more token topics pending | `internalizing`, `conflicted`, `outcome_unknown` |
| `internalizing` | Chain and all required overlays accept | `settled`, `outcome_unknown` |
| `outcome_unknown` | Submission or evidence is ambiguous | `verifying`, `overlay_pending`, `internalizing`, `settled`, `conflicted`, `failed` |
| `settled` | Evidence and both wallet receipts complete | terminal |
| `conflicted` | A committed input was spent by a different tx | terminal |
| `expired` / `cancelled` / `failed` | Safe pre-broadcast terminal condition established | terminal |

States are monotonic. Duplicate messages with the same message digest return the prior result. The same nonce with different bytes, stale revisions, an invalid role, or a terminal-state regression is rejected.

## Asset preparation

### Ordinals

An ordinal offer names a concrete outpoint. At contribution and again immediately before authorization, the owner MUST verify:

- the source transaction and output exist;
- the output is unspent;
- the wallet controls its locking script and has its spend instructions;
- the advertised inscription/origin metadata still resolves to that tip; and
- the output has exactly the expected satoshi semantics.

The built transaction MUST be traced using transaction input/output satoshi order. Each offered ordinal's first satoshi MUST land in its named receiver output. The implementation MUST NOT assume the wallet preserves a requested input index or that “the first output” is sufficient after funding inputs/change are added. The final signable transaction is authoritative.

Ordinal receipt outputs are one satoshi unless the source protocol explicitly requires another amount. Version 1 rejects an ordinal source it cannot trace unambiguously.

### BSV21 tip selection and reservation

Negotiation discloses only `(tokenId, amount)`. After settlement preparation:

1. Load ordinary wallet basket `bsv21` for the exact token ID.
2. Query the configured BSV21 overlay for current token status, each candidate outpoint, active state, and unspent state.
3. Reject auth, mint, burn, malformed, inactive, wrong-token, zero-amount, overflowed, or spent outputs.
4. Sort candidates by atomic amount descending, then canonical outpoint ascending.
5. Select until the requested amount is met. This deterministic greedy rule is simple and bounded; it does not claim to minimize change.
6. Create a wallet-local lease on the selected outpoints bound to settlement ID, attempt, offer digest, wallet/provider instance, and expiry.
7. Revalidate all selected tips after template construction and immediately before signing.

The lease prevents this settlement-capable client from offering the same tip twice. It cannot stop another app from spending the output. A provider without local lease support is not certified for settlement v1. A conflicting chain spend fails safely because the one atomic transaction cannot partially spend.

### Token conservation and outputs

For each distinct token ID:

```text
sum(active selected transfer inputs)
  = sum(counterparty receipt outputs) + sum(owner change outputs)
```

Version 1 permits only `op=transfer` BSV21 inputs and outputs. It rejects deploy, mint, auth, burn, and implicit remainder. Change is mandatory when input quantity exceeds the locked offered amount. Token identity is derived from validated script data, never UI labels.

Each BSV21 receipt and change output uses the SDK's canonical BSV21 inscription and a receiver-approved spend script. Every such output is inserted into the owner's ordinary `bsv21` basket after settlement.

### Overlay fees

For every distinct token ID, fetch current `fee_address` and `fee_per_output` at construction. Count all new BSV21 outputs for that token, including receiver outputs and token change. Compute:

```text
tokenOverlayFee = fee_per_output * tokenOutputCount
```

The multiplication is overflow-checked. Add one ordinary BSV fee output only
when `tokenOverlayFee > 0`; a zero-satoshi fee output is forbidden. Fee
policies and check time enter the template manifest. Different token IDs
remain separate fee records even when their fee addresses match. A fee policy
change before authorization invalidates the attempt and requires a rebuild;
it is not silently absorbed.

### BSV funding, payments, and change

All asset inputs are external inputs to the builder's `createAction`. The builder wallet adds ordinary funding inputs and BSV change through normal BRC-100 accounting. `randomizeOutputs` MUST be false. The final transaction is inspected after wallet funding; requested indexes are never assumed.

An explicit negotiated BSV payment is a named receiver output and must be funded by the builder. Mining fee, overlay fees, explicit BSV payment, and builder change are shown separately in authorization UI. The peer neither selects nor signs the builder's unrelated funding inputs.

The builder's wallet action reference and allocated change remain local. Pre-sign failure calls `abortAction(reference)`. After `signAction`, the action is not aborted; recovery inspects its result and the chain.

## BRC-100 signing boundary

The reusable `1sat-sdk` settlement primitive MUST:

1. Assemble and validate asset source BEEF supplied by both wallets.
2. Ask the builder wallet to create the final funded signable action with all asset inputs declared external.
3. Parse the returned AtomicBEEF and locate inputs by outpoint rather than assumed position.
4. Produce per-owner signing requests containing only exact input indexes, full BIP-143 preimages, and local spend metadata references.
5. In each owner's process, use its stored `protocolID`, `keyID`, and `counterparty` to call `createSignature` for its own P2PKH or supported PushDrop input.
6. Build and locally script-verify each unlocking script.
7. Require `SIGHASH_ALL | SIGHASH_FORKID` (`0x41`). `ANYONECANPAY`, `SINGLE`, and `NONE` are forbidden.
8. Give all verified asset unlocking scripts to the builder wallet's `signAction({ reference, spends })`, which signs its funding inputs and broadcasts.

This matches the existing `signP2PKHInput`, `signOrdinalInput`, and `completeSignedAction` model without sharing wallet references. The new primitive must generalize it across two wallet owners and perform the full settlement checks described here.

The transaction permission prompt belongs to each BRC-100 wallet. Built-in mode may render the project's asset-aware permission UI; injected, desktop, and embedded providers render their own. The website MUST NOT substitute a web confirmation for the wallet call.

Ordinary baskets remain `1sat` and `bsv21`. Permission modules are optional provider policy under BRC-116. Settlement correctness MUST NOT depend on the deprecated “1sat module” dispatch path or on a `p 1sat ...` basket.

## Construction and authorization sequence

```mermaid
sequenceDiagram
    participant A as Party A wallet
    participant C as Signed coordinator
    participant B as Party B / builder wallet
    participant O as BSV21 overlay + chain

    A->>C: locked offer A (BRC-77)
    B->>C: locked offer B (BRC-77)
    C-->>A: prepare(offerDigest, attempt)
    C-->>B: prepare(offerDigest, attempt)
    A->>O: validate ordinal/tokens; select BSV21 tips
    B->>O: validate ordinal/tokens; select BSV21 tips
    A->>C: signed contribution + artifact hashes
    B->>C: signed contribution + artifact hashes
    B->>B: createAction(signAndProcess:false)
    B->>C: signed final template + AtomicBEEF hash
    C-->>A: exact AtomicBEEF
    A->>A: reconstruct effects; native wallet review; sign owned inputs
    B->>B: reconstruct effects; native wallet review; sign owned inputs
    A->>C: authorize(templateHash) + opaque unlock artifact
    B->>C: authorize(templateHash) + opaque unlock artifact
    B->>C: claim broadcast lease
    B->>B: script-verify all unlocks; signAction(reference, spends)
    B->>O: submit exact completed AtomicBEEF
    B->>C: txid + evidence hash
    C->>O: independently verify tx and token topics
    C-->>A: verified receipt data
    C-->>B: verified receipt data
    A->>A: internalize owned outputs idempotently
    B->>B: internalize owned outputs idempotently
```

## Broadcast idempotency and outcome recovery

The idempotency key is `(settlementId, attempt, templateHash)`. Only the fixed builder may obtain the broadcast lease. The coordinator stores one raw transaction hash and eventual txid for that key.

Retries obey these rules:

- Retry submission only with the exact same completed transaction bytes and therefore the same txid.
- An “already known” response is success pending independent evidence.
- Never rebuild with the same attempt. A rebuild increments `attempt`, refreshes tips and fee policies, makes a new wallet action, and requires both wallets to authorize again.
- Never mark failed only because an RPC call timed out.

For `outcome_unknown`:

1. Derive the expected txid from the completed raw transaction, if available.
2. Query independent transaction services for that exact txid.
3. Query the spend status of every committed asset input.
4. If the exact transaction is found, continue overlay verification and internalization.
5. If any input is spent by a different transaction, mark `conflicted`; do not reuse any selected tips.
6. If no input is spent and the exact transaction remains absent, retry the exact bytes during a bounded recovery window.
7. After the window, retain `outcome_unknown` until authoritative input-spend evidence permits `failed` or `conflicted`. Do not tell users their assets are released merely because a lease expired.

## Overlay verification and internalization

Chain broadcast and BSV21 overlay admission are separate results. For each token ID, the coordinator or evidence service submits the exact AtomicBEEF idempotently and verifies that every expected token output is indexed, active, unspent, and has the expected amount/token ID.

State remains `overlay_pending` when the transaction exists but indexing is delayed. Overlay rejection is surfaced with reason and evidence. It does not reverse the chain transaction.

After required chain and overlay evidence:

- Each receiver calls `internalizeAction` with the same final AtomicBEEF.
- Ordinals use basket insertion into ordinary basket `1sat`.
- BSV21 receipts and change use basket insertion into ordinary basket `bsv21`.
- An explicit BSV payment uses the wallet's standard payment remittance.
- Output indexes are derived from the final transaction and manifest, not from pre-build hints.
- Each wallet supplies only insertion remittance it created or verified for its own destinations.

Internalization is idempotent. A wallet checks whether the exact outpoint is already tracked before retrying. Failure to internalize is a recoverable local accounting failure, not a failed on-chain trade.

## Minimal evidence receipt

```ts
type SettlementReceiptV1 = {
  protocol: "1sat-p2p-settlement"
  version: 1
  chain: "main" | "test"
  sessionId: string
  settlementId: string
  attempt: number
  offerDigest: string
  templateHash: string
  txid: string
  rawTxHash: string
  parties: [string, string]
  outputs: Array<{
    outpoint: string
    owner: string
    purpose: "ordinal-receipt" | "bsv21-receipt" | "bsv21-change" | "bsv-payment"
    tokenId?: string
    tokenAmount?: string
    sourceOrdinal?: string
  }>
  overlays: Array<{
    tokenId: string
    status: "accepted" | "pending" | "rejected"
    checkedAt: number
    evidenceHash: string
  }>
  internalization: Array<{
    owner: string
    status: "pending" | "complete" | "failed"
    checkedAt: number
    receiptHash?: string
  }>
}
```

Convex may persist the receipt, signed command digests, bounded redacted errors, and expiring artifact hashes. It MUST NOT persist private keys, seeds, wallet action references, derivation secrets, unrelated wallet inputs, permission grants, or raw permission UI data.

## Disconnect, expiry, replay, and substitution behavior

- **Disconnect before contribution:** retain signed locked offer until expiry; no tips are reserved.
- **Disconnect after reservation but before authorization:** reconnect may resume the same attempt if wallet/provider identity, contribution, lease, and template remain current. Otherwise abort and increment attempt.
- **Disconnect after authorization:** enter outcome recovery. Never silently unlock/re-offer the inputs.
- **Expiry before any unlock:** abort the builder action, release local leases, mark expired.
- **Expiry after an unlock is relayed:** do not discard the artifact or claim cancellation; recover outcome until exact tx or conflicts are known.
- **Replay:** repeated identical signed command returns its original result; nonce reuse with different content is rejected.
- **Signer substitution:** message signer, wallet identity, contribution owner, input owner, and locked participant must all match. A wallet/provider switch starts a new attempt.
- **Destination substitution:** receiver destination proof, reconstructed script ownership, and final output script must all match.
- **Template substitution:** any byte-level change affecting the unsigned transaction changes `unsignedTxHash` and `templateHash`; old authorizations are rejected.
- **Double spend:** final pre-sign validation catches known conflicts. A race after signing can only make the entire settlement transaction lose; it cannot settle one leg.
- **Duplicate broadcast:** same bytes are idempotent. Different bytes under the same attempt are rejected and investigated.

## Threat model

| Threat | Required defense | Residual outcome |
| --- | --- | --- |
| Coordinator invents ownership or marks complete | BRC-77 role verification plus independent chain/overlay evidence | Coordinator can delay UI progress only |
| Peer spoofs identity/display fields | Bind identity keys from locked commands; display verification separately | Unverified profile remains visibly unverified |
| Peer swaps a destination | Receiver proof and local regeneration; exact template review | Attempt rejected |
| Builder adds an output or changes amount | Manifest reconstruction and `SIGHASH_ALL + FORKID` | Builder cannot use existing signatures |
| Builder removes the other leg after receiving a signature | Signature commits all inputs and outputs | Modified transaction is invalid |
| Participant reuses a partial signature | Session/attempt/template authorization binding; exact sighash | Only identical transaction can use it |
| Stale/spent ordinal or token tip | Fresh overlay/chain checks before contribution and signing | Atomic transaction fails or attempt rebuilds |
| Same token tips reserved in two trades | Wallet-local leases plus final checks | One transaction wins; the other conflicts atomically |
| Token inflation or wrong-token change | Parse every BSV21 script and conserve per token ID | Reject before authorization |
| Overlay fee underpayment/change | Fresh per-token fee policy in committed manifest | Rebuild when policy changes |
| Builder withholds after both signatures | Recovery and truthful “authorization submitted” state | Liveness loss; no unilateral theft |
| Broadcast RPC times out after acceptance | Expected txid and input-spend recovery | State remains outcome unknown until evidence |
| Overlay indexes slowly | Separate `overlay_pending` state and idempotent resubmit | Wallet inventory may lag, trade not falsely failed |
| Internalization fails | Receipt-driven idempotent retry | Chain ownership exists; local inventory is pending |
| Convex/artifact database leaks | Store hashes/minimum receipt; TTL opaque artifacts; no secrets | Public transaction data may be exposed, not keys |
| Permission UI is spoofed by page | Require the actual provider's BRC-100 calls and prompt | Provider denial aborts safely |
| Wallet/provider switches mid-attempt | Bind provider instance and wallet identity | New attempt and fresh signatures required |

## Conformance vectors

### Vector A: ordinal for BSV21

Locked trade:

- Party A gives ordinal `aa…aa_0` to Party B.
- Party B gives `100` atomic units of token `11…11_0` to Party A.
- Party A is builder and fee payer.

At settlement, Party B's wallet selects active tips `bb…bb_1 = 75` and `cc…cc_2 = 40`. The transaction MUST contain:

- both token inputs and the ordinal input;
- an ordinal output controlled by B that receives the exact ordinal satoshi;
- a BSV21 receipt output of `100` token `11…11_0` controlled by A;
- a BSV21 change output of `15` token `11…11_0` controlled by B;
- if `fee_per_output = 3`, one `6` satoshi output to that token's fee address because two BSV21 outputs were created;
- A's wallet funding inputs and BSV change; and
- no other asset or data output.

Changing `100` to `99`, omitting the `15` change, paying only `3` overlay-fee satoshis, moving the ordinal sat to another output, or replacing either destination MUST fail before signing.

### Vector B: BSV21 for BSV21

Locked trade:

- Party A gives `30` of token `22…22_0` to Party B.
- Party B gives `9` of token `33…33_0` to Party A.
- Party A is builder and fee payer.

Selected tips are A:`50` of token `22…22_0`; B:`7 + 5` of token `33…33_0`. Required token outputs are:

- B receives `30` of `22…22_0`; A receives `20` change of `22…22_0`.
- A receives `9` of `33…33_0`; B receives `3` change of `33…33_0`.

If fee rates are `2` and `5` satoshis per output respectively, overlay fee outputs are `4` satoshis for `22…22_0` and `10` satoshis for `33…33_0`. Token quantities never net across IDs. Replacing the two `33…33_0` inputs with one unverified `9` tip, folding both token fee records together, treating atomic units as display decimals, or omitting either change output MUST fail.

### Negative vectors required in SDK tests

- Wrong chain, participant, locked revision, offer digest, or wallet/provider instance.
- Expired contribution, reservation, template, authorization, or broadcast lease.
- Duplicate nonce with changed content and identical message with a new signer.
- Unknown fields, noncanonical outpoints, leading-zero quantities, zero token outputs, `uint64` overflow.
- Ordinal spent, token tip spent, inactive token, wrong token ID, auth/mint/burn input.
- Missing source BEEF, mismatched source satoshis/script hash, invalid insertion remittance.
- Output substitution, extra asset output, token inflation, missing change, excess change, fee underpayment.
- `ANYONECANPAY`, `SINGLE`, `NONE`, wrong input index, wrong source subscript, invalid unlocking script.
- Builder wallet reorders inputs or outputs: implementation locates by content and traces the final transaction rather than trusting requested indexes.
- Broadcast timeout followed by exact tx discovery; timeout followed by different spender; duplicate exact broadcast.
- Overlay delay, overlay rejection, internalization retry, already-internalized output.

## Responsibility map

### OPL-4162 — signed and idempotent coordinator

- Implement the message envelopes, roles, state table, compare-and-set revisions, one-use nonces, expiries, broadcast lease, and monotonic terminal behavior.
- Persist only commitments, minimum receipt fields, and TTL-bounded opaque artifact references.
- Drive outcome recovery from evidence; never manufacture wallet authorization or mark settled from a UI event.

### OPL-4163 — `1sat-sdk` settlement primitive

- Implement JCS commitments and schemas, contribution validation, deterministic tip selection, reservation adapter, final funded-template reconstruction, ordinal sat tracing, per-token conservation/fee checks, and per-owner exact signing requests.
- Generalize the existing external-input signing helpers to two owners without sharing action references.
- Export vectors for mixed and token/token swaps. This is the only package that defines transaction construction semantics.

### OPL-4164 — wallet-native authorization UX

- Render effects reconstructed from the final AtomicBEEF: exact sends/receives, token IDs and atomic/display amounts, ordinal previews, overlay/mining fees, BSV payment/change, builder, counterparty verification, and expiry.
- Use built-in asset-aware permission UI or the connected wallet's native BRC-100 prompt.
- Show denial, stale template, disconnect, `overlay_pending`, internalization pending, conflict, and outcome-unknown states truthfully.

### OPL-4165 — provider certification

- Run two-device/two-identity transactions across built-in, Yours injection, 1Sat Desktop, and mobile embedded/WebView pairs.
- Prove provider support for exact-template review, arbitrary owned external-input signing, local reservations, wallet switch invalidation, and idempotent internalization.
- Capture before/after inventory, transaction/BEEF hashes, txid, overlay facts, provider versions, redacted logs, screenshots, failure/recovery cases, and simultaneous-session races.

### OPL-4166 — evidence and internalization

- Independently locate exact transaction outputs, verify each BSV21 topic, build the minimum receipt, and internalize owned outputs idempotently.
- Keep broadcast, overlay, and wallet-accounting states distinct. Handle delayed indexing, reorg/conflict evidence, and reconnect retries.

## Release gates and unresolved decisions

Atomic trading MUST remain disabled until OPL-4163 through OPL-4166 pass their tests and provider certification.

The following are explicit implementation gates, not details for UI code to guess:

1. **External provider capability:** certification must confirm that each provider permits `createSignature` over the exact asset-input BIP-143 preimage using stored derivation metadata. BRC-100 exposes the primitive, but provider policy may deny it.
2. **Reservation adapter location:** built-in mode can persist leases beside wallet inventory. Injected/desktop providers need either SDK-local durable leases scoped to provider identity or a provider-native lease API. The adapter contract belongs in OPL-4163; unsupported providers fail capability negotiation.
3. **Artifact transport:** choose a size-bounded encrypted relay or direct peer channel for AtomicBEEF and unlock artifacts. Convex stores content hashes and expiry only. Limits and retention must be fixed before OPL-4162 ships.
4. **Overlay evidence endpoint:** OPL-4166 must select the authoritative API response/receipt used for `accepted`, including behavior during reorgs. A successful submit call alone is insufficient.
5. **Destination derivation profile:** OPL-4163 must publish one receiver-derived protocol/key-ID/remittance profile compatible with all certified wallets. It must use ordinary `1sat`/`bsv21` baskets and must not make the deprecated 1Sat permission module a consensus dependency.
6. **Fee policy churn:** this specification requires rebuild on any fee policy change before authorization. Certification should measure whether the policy endpoint needs a bounded freshness window to avoid needless rebuilds.

Until these gates are closed, the product may demonstrate signed negotiation but must not claim that a trade has settled atomically.

# P2P settlement coordinator

The Convex coordinator implements the application control-plane state machine
around [draft BRC-178](https://github.com/opldotdev/BRCs/pull/6), as summarized
in [`p2p-settlement-protocol.md`](./p2p-settlement-protocol.md). It does not
build, sign, broadcast, or prove a transaction by itself.

## Deployment configuration

- `P2P_SETTLEMENT_CHAIN` is optional and defaults to `main`. Set it to `test`
  only for an isolated test deployment.
- `P2P_SETTLEMENT_VERIFIER_IDENTITY` is the compressed BRC-77 identity public
  key of the independent chain/overlay evidence service. Without it, evidence
  and terminal failure reports fail closed, so a settlement cannot be marked
  settled.

Both values belong in the Convex deployment environment. The verifier's private
key never belongs in Convex or Vercel.

## Signed mutations

Every mutation uses the existing BRC-77 command envelope and additionally binds
the protocol/wire version, chain, session ID, settlement ID, attempt, locked
offer digest and revisions, fixed participants, builder/fee payer, recipient,
expiry, and a monotonically increasing per-signer revision.

The public mutations are:

- `settlement.prepare`
- `settlement.contribution`
- `settlement.template`
- `settlement.authorize`
- `settlement.broadcast-claim`
- `settlement.broadcast-result`
- `settlement.evidence`
- `settlement.internalize`
- `settlement.cancel`
- `settlement.timeout`
- `settlement.failure`

An identical signed command is idempotent, including during recovery after its
short command expiry. Reusing its nonce with different bytes fails. A new
attempt is permitted only after a safe pre-broadcast terminal attempt and must
reuse the unchanged locked offer commitment; a conflicted or ambiguous attempt
cannot be silently replaced.

## Persistence boundary

Convex stores commitments, reservation/authorization expiries, the exact input
indexes each participant must authorize, the broadcast lease and transaction
hashes, independent evidence hashes, and internalization receipts. It does not
store BRC-100 action references, BEEF payloads, unlocking scripts, private keys,
seeds, derivation data, or permission grants.

The template intake validates contiguous indexes, participant roles, exact
ordinal input-to-receipt mapping, uint64-safe BSV21 conservation, per-token
overlay output counts, and overlay fee totals. Wallets still independently
reconstruct and validate the transaction before signing; Convex validation is
not a substitute for the wallet boundary.

`accepted` and `already-known` provider results move only to verification. A
signed verifier report proving the exact transaction plus all required BSV21
overlay admissions moves only to internalization. The record becomes `settled`
only after both participant wallets submit complete internalization receipts.

Terminal records and signed command results are retained for 24 hours and then
removed by the Convex cron. Expiry after any authorization moves to outcome
recovery rather than claiming that inputs are released.

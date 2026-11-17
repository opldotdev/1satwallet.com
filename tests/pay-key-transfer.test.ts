import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { OneSatContext } from "@1sat/actions";
import { BSV20 } from "@1sat/templates";
import {
	P2PKH,
	PrivateKey,
	ProtoWallet,
	PublicKey,
	Script,
	type WalletInterface,
	type WalletOutput,
} from "@bsv/sdk";
import { RECEIVE_ADDRESS_PREFIX } from "@/lib/receive-address-manager";
import {
	identityDepositAddress,
	type MoveRequest,
	type PayKeyTransferActions,
	PayKeyTransferIncompleteError,
	transferPayKeyWallet,
} from "@/lib/wallet/pay-key-transfer";

// Fixed test keys on testnet; nothing here signs or broadcasts.
const identityWif = PrivateKey.fromHex("03".repeat(32)).toWif();
const tokenId = `${"dd".repeat(32)}_0`;

const op = (n: number) => `${n.toString(16).padStart(64, "0")}.0`;

function output(n: number, extra: Partial<WalletOutput> = {}): WalletOutput {
	return {
		outpoint: op(n),
		satoshis: 1,
		spendable: true,
		tags: [],
		customInstructions: JSON.stringify({
			protocolID: [0, "onesat"],
			keyID: op(n),
			counterparty: "self",
		}),
		...extra,
	};
}

/** A pay-key wallet whose baskets the fake actions empty as they move. */
function fakeWallet(baskets: Record<string, WalletOutput[]>) {
	const store = new Map(
		Object.entries(baskets).map(([k, v]): [string, WalletOutput[]] => [
			k,
			[...v],
		]),
	);
	const remove = (outpoints: string[]) => {
		for (const [basket, outputs] of store) {
			store.set(
				basket,
				outputs.filter((o) => !outpoints.includes(o.outpoint)),
			);
		}
	};
	const wallet = {
		listOutputs: async ({
			basket,
			offset = 0,
			limit = 10,
		}: {
			basket: string;
			offset?: number;
			limit?: number;
		}) => {
			const all = store.get(basket) ?? [];
			return {
				totalOutputs: all.length,
				outputs: all.slice(offset, offset + limit),
			};
		},
	} as unknown as WalletInterface;
	const ctx = { wallet, chain: "test" } as unknown as OneSatContext;
	return { ctx, store, remove };
}

function recordingActions(
	remove: (outpoints: string[]) => void,
	store: Map<string, WalletOutput[]>,
	fail: (request: MoveRequest) => string | null = () => null,
) {
	const calls: { kind: string; detail: unknown }[] = [];
	let n = 0;
	const actions: PayKeyTransferActions = {
		move: async (_wallet, request) => {
			calls.push({ kind: "move", detail: request });
			const error = fail(request);
			if (error) return { error };
			remove(request.sources.map((s) => s.output.outpoint));
			return { txid: `move-${++n}` };
		},
		sendBsv21: async (_ctx, input) => {
			calls.push({ kind: "bsv21", detail: input });
			remove((store.get("bsv21") ?? []).map((o) => o.outpoint));
			return { txid: "bsv21-1" };
		},
		sendAllBsv: async (_ctx, input) => {
			calls.push({ kind: "all", detail: input });
			remove((store.get("default") ?? []).map((o) => o.outpoint));
			return { txid: "all-1" };
		},
	};
	return { actions, calls };
}

describe("identity deposit address", () => {
	it("is the [0,'onesat'] '1sat 0' self address of the identity key, the one the identity wallet syncs", async () => {
		const address = await identityDepositAddress(identityWif, "test");
		const { publicKey } = await new ProtoWallet(
			PrivateKey.fromWif(identityWif),
		).getPublicKey({
			protocolID: [0, "onesat"],
			keyID: `${RECEIVE_ADDRESS_PREFIX} 0`,
			forSelf: true,
		});
		assert.equal(address, PublicKey.fromString(publicKey).toAddress("testnet"));
		// syncAddresses runs with this prefix from index 0.
		assert.equal(RECEIVE_ADDRESS_PREFIX, "1sat");
	});
});

describe("pay-key wallet transfer", () => {
	// The failure paths log in full; keep test output (and Next's patched
	// console in a full run) out of it.
	const originalError = console.error;
	beforeEach(() => {
		console.error = () => undefined;
	});
	afterEach(() => {
		console.error = originalError;
	});

	it("moves BSV, ordinals, BSV-21 and BSV-20 from every basket to the identity deposit address", async () => {
		const address = await identityDepositAddress(identityWif, "test");
		const p2pkh = new P2PKH().lock(address).toHex();
		const { ctx, store, remove } = fakeWallet({
			"1sat": [
				output(1),
				output(2, { tags: ["type:image/png"] }),
				// A cancelled listing comes back as a plain ordinal.
				output(3),
				// BSV-20 inscription filed as an ordinal, amount in its CI.
				output(4, {
					tags: ["type:application/bsv-20"],
					customInstructions: JSON.stringify({
						protocolID: [0, "onesat"],
						keyID: op(4),
						tick: "PEPE",
						amt: "700",
					}),
				}),
			],
			"p 1sat ordinals": [output(5)],
			opns: [output(6)],
			bsv20: [output(7, { tags: ["bsv20:FREN", "amt:42"] })],
			bsv21: [
				output(8, { tags: [`bsv21:${tokenId}`, "amt:10"] }),
				output(9, { tags: [`bsv21:${tokenId}`, "amt:15"] }),
			],
			"1sat-deposit": [output(10, { satoshis: 5000 })],
			default: [output(11, { satoshis: 90000 }), output(12, { satoshis: 1 })],
		});
		const { actions, calls } = recordingActions(remove, store);

		const result = await transferPayKeyWallet(ctx, identityWif, actions);

		assert.equal(result.address, address);
		const moves = calls
			.filter((c) => c.kind === "move")
			.map((c) => c.detail as MoveRequest);

		// Ordinals from every ordinal basket (current, older name, OpNS) in
		// one move: plain P2PKH, input i to output i, satoshis kept.
		const ordinalMove = moves[0];
		assert.deepEqual(
			ordinalMove.sources.map((s) => s.output.outpoint),
			[op(1), op(2), op(3), op(5), op(6)],
		);
		assert.deepEqual(
			ordinalMove.outputs,
			ordinalMove.sources.map(() => ({ lockingScript: p2pkh, satoshis: 1 })),
		);

		// BSV-20: one per transaction, a new transfer for the same tick and
		// amount, locked to the deposit address.
		const bsv20Moves = moves.filter((m) =>
			m.outputs.some((o) => o.lockingScript !== p2pkh),
		);
		assert.equal(bsv20Moves.length, 2);
		for (const m of bsv20Moves) {
			assert.equal(m.sources.length, 1);
			assert.equal(m.outputs.length, 1);
		}
		const decoded = bsv20Moves.map((m) =>
			BSV20.decode(Script.fromHex(m.outputs[0].lockingScript)),
		);
		const byTick = new Map(
			decoded.map((d) => [d?.tokenData.tick, d?.tokenData]),
		);
		assert.equal(byTick.get("PEPE")?.op, "transfer");
		assert.equal(String(byTick.get("PEPE")?.amt), "700");
		assert.equal(String(byTick.get("FREN")?.amt), "42");
		for (const m of bsv20Moves) {
			assert.ok(m.outputs[0].lockingScript.endsWith(p2pkh));
		}

		// BSV-21: the token's whole balance in one send, overlay check on.
		const bsv21 = calls.find((c) => c.kind === "bsv21")?.detail as {
			tokenId: string;
			recipients: { amount: bigint; destination: { address: string } }[];
			validateOverlay?: boolean;
		};
		assert.equal(bsv21.tokenId, tokenId);
		assert.equal(bsv21.recipients[0].amount, 25n);
		assert.equal(bsv21.recipients[0].destination.address, address);
		assert.equal(bsv21.validateOverlay, undefined);

		// Deposit-basket BSV is gathered into change; the send-all goes last.
		const depositMove = moves.at(-1);
		assert.deepEqual(
			depositMove?.sources.map((s) => s.output.outpoint),
			[op(10)],
		);
		// Gathered into change (no outputs), then sent with the rest.
		assert.deepEqual(depositMove?.outputs, []);
		assert.equal(calls.at(-1)?.kind, "all");
		assert.deepEqual(calls.at(-1)?.detail, { destination: address });

		assert.ok(result.txids.includes("all-1"));
		assert.ok(result.txids.includes("bsv21-1"));
		for (const outputs of store.values()) assert.equal(outputs.length, 0);
	});

	it("leaves listed, locked and unreadable outputs alone and refuses with what is left", async () => {
		const { ctx, store, remove } = fakeWallet({
			"1sat": [
				output(1),
				output(2, { tags: ["ordlock"] }),
				// BSV-21 filed under an ordinal basket: a plain move would burn it.
				output(3, { tags: [`bsv21:${tokenId}`, "amt:5"] }),
				// BSV-20 with no amount anywhere.
				output(4, { tags: ["type:application/bsv-20"] }),
			],
			lock: [output(5, { satoshis: 1000 })],
			default: [output(6, { satoshis: 5000 })],
		});
		const { actions, calls } = recordingActions(remove, store);

		await assert.rejects(
			transferPayKeyWallet(ctx, identityWif, actions),
			(error: unknown) => {
				assert.ok(error instanceof PayKeyTransferIncompleteError);
				const left = new Map(error.left.map((l) => [l.outpoint, l.reason]));
				assert.deepEqual([...left.keys()].sort(), [op(2), op(3), op(4), op(5)]);
				assert.match(left.get(op(2)) ?? "", /still listed/);
				assert.match(left.get(op(3)) ?? "", /BSV-21/);
				assert.match(left.get(op(4)) ?? "", /BSV-20 tick or amount unknown/);
				assert.match(left.get(op(5)) ?? "", /time-locked/);
				assert.match(error.message, /not switched to the identity key/);
				assert.match(error.message, /4 outputs could not be moved/);
				assert.ok(error.transferTxids.length > 0);
				return true;
			},
		);
		const moved = calls
			.filter((c) => c.kind === "move")
			.flatMap((c) =>
				(c.detail as MoveRequest).sources.map((s) => s.output.outpoint),
			);
		assert.deepEqual(moved, [op(1)]);
	});

	it("reports the failed move for each output it could not send", async () => {
		const { ctx, store, remove } = fakeWallet({
			"1sat": [output(1)],
			default: [output(2, { satoshis: 5000 })],
		});
		const { actions } = recordingActions(
			remove,
			store,
			() => "insufficient funds",
		);
		await assert.rejects(
			transferPayKeyWallet(ctx, identityWif, actions),
			(error: unknown) => {
				assert.ok(error instanceof PayKeyTransferIncompleteError);
				assert.equal(error.left.length, 1);
				assert.match(error.left[0].reason, /failed: insufficient funds/);
				assert.match(error.message, /insufficient funds/);
				assert.match(error.errors[0], /insufficient funds/);
				return true;
			},
		);
	});
});

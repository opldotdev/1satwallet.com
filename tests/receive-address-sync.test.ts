import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	createContext,
	type OneSatContext,
	type ProcessedTxStore,
	signP2PKHInput,
	syncAddresses,
} from "@1sat/actions";
import { BSV21, Inscription } from "@1sat/templates";
import { BSV21_BASKET, DEPOSIT_BASKET, ORDINALS_BASKET } from "@1sat/types";
import type { OneSatServices } from "@1sat/wallet-browser";
import {
	Beef,
	type InternalizeActionArgs,
	LockingScript,
	P2PKH,
	PrivateKey,
	ProtoWallet,
	Spend,
	Transaction,
	UnlockingScript,
	type WalletInterface,
} from "@bsv/sdk";
import {
	buildReceiveAddressManager,
	deriveReceiveAddress,
	RECEIVE_ADDRESS_PREFIX,
} from "@/lib/receive-address-manager";
import { createDefaultReceiveAddressState } from "@/lib/receive-address-state";
import {
	clearDiagnostics,
	getDiagnosticEvents,
} from "@/lib/runtime-diagnostics";
import {
	receiveAddressStoreNamespace,
	syncReceiveAddresses,
} from "@/lib/wallet/receive-address-sync";

const rootKey = PrivateKey.fromHex("2".repeat(64));
const identityKey = rootKey.toPublicKey().toString();
const dataDir = mkdtempSync(join(tmpdir(), "receive-sync-"));
after(() => rmSync(dataDir, { recursive: true, force: true }));

/** BRC-29, the protocol the Receive addresses are derived under. */
const BRC29: [2, string] = [2, "3241645161d8"];
/** base64("1sat") + " " + base64 of the 4-byte big-endian index. */
const receiveKeyID = (index: number) =>
	`${Buffer.from("1sat").toString("base64")} ${Buffer.from([0, 0, 0, index]).toString("base64")}`;

class MemoryStore implements ProcessedTxStore {
	txids = new Set<string>();
	lastScore = 0;
	closed = 0;
	async has(txid: string) {
		return this.txids.has(txid);
	}
	async add(txid: string) {
		this.txids.add(txid);
	}
	async getLastScore() {
		return this.lastScore;
	}
	async setLastScore(score: number) {
		this.lastScore = score;
	}
	async close() {
		this.closed++;
	}
}

interface Deposit {
	outpoint: string;
	satoshis: number;
	customInstructions: string;
	tags: string[];
	beef: number[];
}

/**
 * A wallet over the root key that keeps what is internalized into the
 * deposit basket, lists it back as the toolbox does, and plays the two-phase
 * createAction / signAction the deposit sweep uses.
 */
function fakeWallet() {
	const proto = new ProtoWallet(rootKey);
	const internalized: InternalizeActionArgs[] = [];
	const listed: string[] = [];
	const deposits: Deposit[] = [];
	const created: { inputs: { outpoint: string }[] }[] = [];
	const signed: {
		spends: Record<number, { unlockingScript: string }>;
		tx: Transaction;
	}[] = [];
	const aborted: string[] = [];
	let pending: Transaction | null = null;
	const wallet = {
		getPublicKey: (args: Parameters<ProtoWallet["getPublicKey"]>[0]) =>
			proto.getPublicKey(args),
		createSignature: (args: Parameters<ProtoWallet["createSignature"]>[0]) =>
			proto.createSignature(args),
		getHeight: async () => ({ height: 1000 }),
		internalizeAction: async (args: InternalizeActionArgs) => {
			internalized.push(args);
			const tx = Transaction.fromAtomicBEEF(args.tx);
			for (const output of args.outputs) {
				const remittance = output.insertionRemittance;
				if (remittance?.basket !== DEPOSIT_BASKET) continue;
				deposits.push({
					outpoint: `${tx.id("hex")}.${output.outputIndex}`,
					satoshis: tx.outputs[output.outputIndex].satoshis ?? 0,
					customInstructions: remittance.customInstructions ?? "",
					tags: remittance.tags ?? [],
					beef: Array.from(args.tx),
				});
			}
			return { accepted: true };
		},
		listOutputs: async (args: { basket: string }) => {
			listed.push(args.basket);
			if (args.basket !== DEPOSIT_BASKET || deposits.length === 0) {
				return { totalOutputs: 0, outputs: [] };
			}
			const beef = new Beef();
			for (const deposit of deposits) beef.mergeBeef(deposit.beef);
			return {
				totalOutputs: deposits.length,
				outputs: deposits.map(({ beef: _beef, ...output }) => ({
					...output,
					spendable: true,
				})),
				BEEF: beef.toBinary(),
			};
		},
		createAction: async (args: {
			inputBEEF: number[];
			inputs: { outpoint: string }[];
		}) => {
			created.push(args);
			// The wallet's change output takes the inputs, less a fee.
			const beef = Beef.fromBinary(args.inputBEEF);
			const tx = new Transaction();
			let total = 0;
			for (const input of args.inputs) {
				const [txid, vout] = input.outpoint.split(".");
				const source = beef.findTransactionForSigning(txid);
				assert.ok(source, "the sweep hands over the deposit's BEEF");
				tx.addInput({
					sourceTransaction: source,
					sourceOutputIndex: Number(vout),
					unlockingScript: new UnlockingScript(),
				});
				total += source.outputs[Number(vout)].satoshis ?? 0;
			}
			tx.addOutput({
				satoshis: total - 100,
				lockingScript: new P2PKH().lock(rootKey.toAddress()),
			});
			pending = tx;
			return {
				signableTransaction: { tx: tx.toAtomicBEEF(), reference: "sweep" },
			};
		},
		signAction: async (args: {
			spends: Record<number, { unlockingScript: string }>;
		}) => {
			assert.ok(pending);
			signed.push({ spends: args.spends, tx: pending });
			deposits.length = 0;
			return { txid: pending.id("hex") };
		},
		abortAction: async (args: { reference: string }) => {
			aborted.push(args.reference);
			return { aborted: true };
		},
	} as unknown as WalletInterface;
	return { wallet, internalized, listed, created, signed, aborted };
}

const otherAddress = PrivateKey.fromHex("3".repeat(64)).toAddress();

/**
 * A payment of `satoshis` locked by `lockingScript`, spending its parent's
 * output 0 (10,000 sats to someone else unless `from` says otherwise), seen
 * by the indexer at `score`.
 */
function payment(
	lockingScript: LockingScript,
	satoshis: number,
	{
		score = 900,
		from = {
			lockingScript: new P2PKH().lock(otherAddress),
			satoshis: 10_000,
		},
	}: {
		score?: number;
		from?: { lockingScript: LockingScript; satoshis: number };
	} = {},
) {
	const source = new Transaction();
	source.addOutput(from);
	const tx = new Transaction();
	tx.addInput({
		sourceTransaction: source,
		sourceOutputIndex: 0,
		unlockingScript: new LockingScript(),
	});
	tx.addOutput({ satoshis, lockingScript });
	const beef = new Beef();
	beef.mergeTransaction(tx);
	return { tx, source, score, txid: tx.id("hex"), beef: beef.toBinary() };
}

/**
 * The indexer seam `syncAddresses` reads: `owner.sync` streams outputs for
 * the addresses asked about, `beef` serves the transactions.
 */
function fakeServices(
	paid: Map<string, ReturnType<typeof payment>>,
	queried: string[][],
	from: (number | undefined)[] = [],
) {
	const txs = new Map<string, Transaction>();
	for (const { tx, source } of paid.values()) {
		txs.set(tx.id("hex"), tx);
		txs.set(source.id("hex"), source);
	}
	const beefs = new Map(
		[...paid.values()].map(({ txid, beef }) => [txid, beef]),
	);
	return {
		owner: {
			async *sync(addresses: string[], since?: number) {
				queried.push(addresses);
				from.push(since);
				for (const address of addresses) {
					const hit = paid.get(address);
					if (hit && (since === undefined || hit.score > since)) {
						yield { outpoint: `${hit.txid}_0`, score: hit.score };
					}
				}
			},
		},
		bsv21: {
			getTokenDetails: async () => ({ token: { sym: "TST", dec: 0 } }),
			getTokenByTxid: async () => ({}),
		},
		beef: {
			getBeef: async (txid: string) => {
				const beef = beefs.get(txid);
				return beef ? Uint8Array.from(beef) : undefined;
			},
			getRawTx: async (txid: string) => {
				const tx = txs.get(txid);
				if (!tx) throw new Error("raw tx not found");
				return Uint8Array.from(tx.toBinary());
			},
		},
	} as unknown as OneSatServices;
}

async function setup(chain: "main" | "test") {
	const fake = fakeWallet();
	const { addressManager } = await buildReceiveAddressManager({
		wallet: fake.wallet,
		chain,
		identityKey,
		state: createDefaultReceiveAddressState(),
	});
	return { ...fake, addressManager };
}

/** Every address job the owned sync runs, as `use-sync-engine` wires them. */
async function runOwnedAddressSync(
	ctx: OneSatContext,
	addressManager: Awaited<ReturnType<typeof setup>>["addressManager"],
) {
	await syncAddresses.execute(ctx, {
		prefix: RECEIVE_ADDRESS_PREFIX,
		count: addressManager.getAddresses().length || 5,
	});
	await syncReceiveAddresses(ctx, addressManager, new MemoryStore());
}

type Remittance = {
	basket: string;
	tags?: string[];
	customInstructions?: string;
};

function onlyOutput(internalized: InternalizeActionArgs[]) {
	assert.equal(internalized.length, 1);
	const [output] = internalized[0].outputs;
	assert.equal(internalized[0].outputs.length, 1);
	assert.equal(output.protocol, "basket insertion");
	const remittance = output.insertionRemittance as Remittance;
	const ci = JSON.parse(remittance.customInstructions ?? "{}") as {
		protocolID: [2, string];
		keyID: string;
		counterparty?: string;
	};
	return { output, basket: remittance.basket, tags: remittance.tags, ci };
}

/**
 * Spends `vout` of `paid` the way `sweepDeposit` does, from the recorded
 * custom instructions, and runs the script interpreter on it.
 */
async function spendWith(
	ctx: OneSatContext,
	paid: Transaction,
	ci: { protocolID: [2, string]; keyID: string; counterparty?: string },
) {
	const spend = new Transaction();
	spend.addInput({
		sourceTransaction: paid,
		sourceOutputIndex: 0,
		unlockingScript: new UnlockingScript(),
	});
	spend.addOutput({
		satoshis: 1,
		lockingScript: new P2PKH().lock(rootKey.toAddress()),
	});
	const unlock = await signP2PKHInput(
		ctx,
		spend,
		0,
		ci.protocolID,
		ci.keyID,
		ci.counterparty ?? "self",
	);
	assert.equal(typeof unlock, "string", "the wallet signs the input");
	const source = paid.outputs[0];
	return new Spend({
		sourceTXID: paid.id("hex"),
		sourceOutputIndex: 0,
		sourceSatoshis: source.satoshis ?? 0,
		lockingScript: source.lockingScript,
		transactionVersion: spend.version,
		otherInputs: [],
		outputs: spend.outputs,
		unlockingScript: UnlockingScript.fromHex(unlock as string),
		inputSequence: 0xffffffff,
		inputIndex: 0,
		lockTime: spend.lockTime,
	}).validate();
}

describe("the web wallet's own Receive addresses", () => {
	it("picks up a payment to Receive index 0 in the owned sync", async () => {
		const { wallet, internalized, addressManager } = await setup("main");
		const receive0 = addressManager.getAddressAtIndex(0);
		assert.ok(receive0);
		const paid = new Map([
			[receive0.address, payment(new P2PKH().lock(receive0.address), 5000)],
		]);
		const queried: string[][] = [];
		const ctx = createContext(wallet, {
			chain: "main",
			services: fakeServices(paid, queried),
			dataDir,
		});

		await runOwnedAddressSync(ctx, addressManager);

		assert.equal(
			internalized.length,
			1,
			"a payment to the shown Receive address is internalized",
		);
		// `syncAddresses` still scans only its own sets; the new task is what
		// asks about the shown address.
		const [deposit, receive] = queried;
		assert.equal(deposit.includes(receive0.address), false);
		assert.deepEqual(receive, addressManager.getAddresses());
	});

	it("records plain BSV under BRC-29 and the Receive keyID, then sweeps it", async () => {
		const {
			wallet,
			internalized,
			listed,
			created,
			signed,
			aborted,
			addressManager,
		} = await setup("main");
		const receive0 = addressManager.getAddressAtIndex(0);
		assert.ok(receive0);
		const paid = payment(new P2PKH().lock(receive0.address), 5000);
		const ctx = createContext(wallet, {
			chain: "main",
			services: fakeServices(new Map([[receive0.address, paid]]), []),
		});
		const store = new MemoryStore();

		const result = await syncReceiveAddresses(ctx, addressManager, store);

		assert.deepEqual(result, { processed: 1, failed: 0 });
		const { output, basket, ci } = onlyOutput(internalized);
		assert.equal(output.outputIndex, 0);
		assert.equal(basket, DEPOSIT_BASKET);
		assert.deepEqual(ci.protocolID, BRC29);
		assert.equal(ci.keyID, receiveKeyID(0));
		assert.equal(ci.counterparty, "self");
		assert.equal(await spendWith(ctx, paid.tx, ci), true);

		// sweepDeposit itself read the deposit back and signed it from those
		// custom instructions; the signature it produced unlocks the output.
		assert.deepEqual(listed, [DEPOSIT_BASKET]);
		assert.deepEqual(
			created.map(({ inputs }) => inputs.map(({ outpoint }) => outpoint)),
			[[`${paid.txid}.0`]],
		);
		assert.deepEqual(aborted, []);
		assert.equal(signed.length, 1);
		const [{ spends, tx: sweep }] = signed;
		const source = paid.tx.outputs[0];
		assert.equal(
			new Spend({
				sourceTXID: paid.txid,
				sourceOutputIndex: 0,
				sourceSatoshis: source.satoshis ?? 0,
				lockingScript: source.lockingScript,
				transactionVersion: sweep.version,
				otherInputs: [],
				outputs: sweep.outputs,
				unlockingScript: UnlockingScript.fromHex(spends[0].unlockingScript),
				inputSequence: 0xffffffff,
				inputIndex: 0,
				lockTime: sweep.lockTime,
			}).validate(),
			true,
		);

		// Already processed: a second run does not internalize it again, and
		// its sweep (every run) finds the basket empty.
		assert.deepEqual(await syncReceiveAddresses(ctx, addressManager, store), {
			processed: 0,
			failed: 0,
		});
		assert.equal(internalized.length, 1);
		assert.equal(signed.length, 1);
		assert.deepEqual(listed, [DEPOSIT_BASKET, DEPOSIT_BASKET]);
	});

	it("records a 1-sat ordinal at Receive index 1 in the ordinals basket", async () => {
		const { wallet, internalized, addressManager } = await setup("main");
		const receive1 = addressManager.getAddressAtIndex(1);
		assert.ok(receive1);
		const ordinal = Inscription.fromText("hello", "text/plain", {
			scriptPrefix: new P2PKH().lock(receive1.address),
		}).lock();
		const paid = payment(ordinal, 1);
		const ctx = createContext(wallet, {
			chain: "main",
			services: fakeServices(new Map([[receive1.address, paid]]), []),
		});

		const result = await syncReceiveAddresses(
			ctx,
			addressManager,
			new MemoryStore(),
		);

		assert.deepEqual(result, { processed: 1, failed: 0 });
		const { basket, ci } = onlyOutput(internalized);
		assert.equal(basket, ORDINALS_BASKET);
		assert.deepEqual(ci.protocolID, BRC29);
		assert.equal(ci.keyID, receiveKeyID(1));
		assert.equal(await spendWith(ctx, paid.tx, ci), true);
	});

	it("records a BSV-21 transfer at Receive index 2 in the bsv21 basket", async () => {
		const { wallet, internalized, addressManager } = await setup("main");
		const receive2 = addressManager.getAddressAtIndex(2);
		assert.ok(receive2);
		const tokenId = `${"ab".repeat(32)}_0`;
		const paid = payment(
			BSV21.transfer(tokenId, 100n).lock(new P2PKH().lock(receive2.address)),
			1,
			{
				from: {
					lockingScript: BSV21.transfer(tokenId, 100n).lock(
						new P2PKH().lock(otherAddress),
					),
					satoshis: 1,
				},
			},
		);
		const ctx = createContext(wallet, {
			chain: "main",
			services: fakeServices(new Map([[receive2.address, paid]]), []),
		});

		const result = await syncReceiveAddresses(
			ctx,
			addressManager,
			new MemoryStore(),
		);

		assert.deepEqual(result, { processed: 1, failed: 0 });
		const { basket, tags, ci } = onlyOutput(internalized);
		assert.equal(basket, BSV21_BASKET);
		assert.ok(tags?.includes(`bsv21:${tokenId}`));
		assert.deepEqual(ci.protocolID, BRC29);
		assert.equal(ci.keyID, receiveKeyID(2));
		assert.equal(ci.counterparty, "self");
		assert.equal(await spendWith(ctx, paid.tx, ci), true);
	});

	it("scans a Receive address added after the cursor moved from the start", async () => {
		const { wallet, internalized, addressManager } = await setup("main");
		const receive0 = addressManager.getAddressAtIndex(0);
		assert.ok(receive0);
		const receive5 = await deriveReceiveAddress({
			wallet,
			chain: "main",
			identityKey,
			index: 5,
		});
		// Paid long ago, below the cursor the first run leaves behind.
		const paid = new Map([
			[receive0.address, payment(new P2PKH().lock(receive0.address), 5000)],
			[
				receive5.address,
				payment(new P2PKH().lock(receive5.address), 7000, { score: 100 }),
			],
		]);
		const queried: string[][] = [];
		const from: (number | undefined)[] = [];
		const ctx = createContext(wallet, {
			chain: "main",
			services: fakeServices(paid, queried, from),
		});
		const store = new MemoryStore();

		// Indices 0-4: cursor to 900.
		await syncReceiveAddresses(ctx, addressManager, store);
		assert.equal(store.lastScore, 900);
		assert.equal(internalized.length, 1);

		// The manager gains index 5: it is scanned from the start, the rest
		// from the cursor.
		const window = addressManager.getAddresses();
		addressManager.addAddress(receive5);
		queried.length = 0;
		from.length = 0;
		await syncReceiveAddresses(ctx, addressManager, store);

		assert.deepEqual(queried, [window, [receive5.address]]);
		assert.deepEqual(from, [900, undefined]);
		assert.equal(internalized.length, 2);
		const { ci } = onlyOutput(internalized.slice(1));
		assert.equal(ci.keyID, receiveKeyID(5));

		// Now covered: the next run reads index 5 from the cursor too.
		queried.length = 0;
		from.length = 0;
		await syncReceiveAddresses(ctx, addressManager, store);
		assert.deepEqual(queried, [[...window, receive5.address]]);
		assert.deepEqual(from, [900]);
		assert.equal(internalized.length, 2);
	});

	it("syncs the testnet Receive addresses on testnet", async () => {
		const { wallet, internalized, addressManager } = await setup("test");
		const receive0 = addressManager.getAddressAtIndex(0);
		assert.ok(receive0);
		assert.match(receive0.address, /^[mn]/);
		const paid = payment(new P2PKH().lock(receive0.address), 5000);
		const ctx = createContext(wallet, {
			chain: "test",
			services: fakeServices(new Map([[receive0.address, paid]]), []),
		});

		await syncReceiveAddresses(ctx, addressManager, new MemoryStore());

		const { basket, ci } = onlyOutput(internalized);
		assert.equal(basket, DEPOSIT_BASKET);
		assert.equal(ci.keyID, receiveKeyID(0));
		assert.equal(await spendWith(ctx, paid.tx, ci), true);
	});

	it("keeps its own cursor and never opens the syncAddresses store", async () => {
		const { wallet, addressManager } = await setup("main");
		const receive0 = addressManager.getAddressAtIndex(0);
		assert.ok(receive0);
		const paid = payment(new P2PKH().lock(receive0.address), 5000);
		const ownDir = mkdtempSync(join(tmpdir(), "receive-cursor-"));
		try {
			const ctx = createContext(wallet, {
				chain: "main",
				services: fakeServices(new Map([[receive0.address, paid]]), []),
				dataDir: ownDir,
			});
			const store = new MemoryStore();

			await syncReceiveAddresses(ctx, addressManager, store);

			// Height 1000, score 900: past the reorg window, so the cursor moves.
			assert.equal(store.lastScore, 900);
			assert.equal(store.txids.has(paid.txid), true);
			assert.equal(store.txids.has(`covered:${receive0.address}`), true);
			assert.equal(store.closed, 1);
			// syncAddresses keeps its store at `sync-<key>.db` here (IndexedDB
			// `sync-processed-<key>` in the browser): never created.
			assert.deepEqual(readdirSync(ownDir), []);
			assert.notEqual(
				receiveAddressStoreNamespace("main", identityKey),
				identityKey,
			);
			assert.notEqual(
				receiveAddressStoreNamespace("main", identityKey),
				receiveAddressStoreNamespace("test", identityKey),
			);
		} finally {
			rmSync(ownDir, { recursive: true, force: true });
		}
	});

	it("holds the cursor back and counts the item when internalizing fails", async () => {
		const { wallet, addressManager } = await setup("main");
		const receive0 = addressManager.getAddressAtIndex(0);
		assert.ok(receive0);
		const paid = payment(new P2PKH().lock(receive0.address), 5000);
		const failing = {
			...wallet,
			internalizeAction: async () => {
				throw new Error("storage refused");
			},
		} as unknown as WalletInterface;
		const ctx = createContext(failing, {
			chain: "main",
			services: fakeServices(new Map([[receive0.address, paid]]), []),
		});
		const store = new MemoryStore();
		clearDiagnostics();
		const originalError = console.error;
		console.error = () => undefined;
		let result: Awaited<ReturnType<typeof syncReceiveAddresses>>;
		try {
			result = await syncReceiveAddresses(ctx, addressManager, store);
		} finally {
			console.error = originalError;
		}

		assert.deepEqual(result, { processed: 0, failed: 1 });
		const [event] = getDiagnosticEvents();
		assert.equal(event.operation, "wallet.sync.receiveAddresses.internalize");
		assert.deepEqual(event.context, { retryable: true, errorName: "Error" });
		assert.equal(store.lastScore, 0);
		assert.equal(store.txids.size, 0);
	});

	it("is wired into the owned sync after the existing tasks", () => {
		const engine = readFileSync(
			join(process.cwd(), "providers/hooks/use-sync-engine.ts"),
			"utf8",
		);
		assert.match(
			engine,
			/receiveAddresses: \(\) =>\s*syncReceiveAddresses\(\s*ctx,\s*addressManager,\s*openReceiveAddressStore\(chain, identityKey\),/,
		);
		assert.match(
			engine,
			/"addresses",\s*"payments",\s*"cosignDeliveries",\s*"handleInbox",\s*"receiveAddresses",\s*\]/,
		);
	});
});

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
import { Inscription } from "@1sat/templates";
import { DEPOSIT_BASKET, ORDINALS_BASKET } from "@1sat/types";
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

function fakeWallet() {
	const proto = new ProtoWallet(rootKey);
	const internalized: InternalizeActionArgs[] = [];
	const listed: string[] = [];
	const wallet = {
		getPublicKey: (args: Parameters<ProtoWallet["getPublicKey"]>[0]) =>
			proto.getPublicKey(args),
		createSignature: (args: Parameters<ProtoWallet["createSignature"]>[0]) =>
			proto.createSignature(args),
		getHeight: async () => ({ height: 1000 }),
		internalizeAction: async (args: InternalizeActionArgs) => {
			internalized.push(args);
			return { accepted: true };
		},
		// The deposit sweep finds an empty basket in these tests.
		listOutputs: async (args: { basket: string }) => {
			listed.push(args.basket);
			return { totalOutputs: 0, outputs: [] };
		},
	} as unknown as WalletInterface;
	return { wallet, internalized, listed };
}

/** A payment of `satoshis` locked by `lockingScript`, with its funding parent. */
function payment(lockingScript: LockingScript, satoshis: number) {
	const source = new Transaction();
	source.addOutput({
		satoshis: 10_000,
		lockingScript: new P2PKH().lock(
			PrivateKey.fromHex("3".repeat(64)).toAddress(),
		),
	});
	const tx = new Transaction();
	tx.addInput({
		sourceTransaction: source,
		sourceOutputIndex: 0,
		unlockingScript: new LockingScript(),
	});
	tx.addOutput({ satoshis, lockingScript });
	const beef = new Beef();
	beef.mergeTransaction(tx);
	return { tx, source, txid: tx.id("hex"), beef: beef.toBinary() };
}

/**
 * The indexer seam `syncAddresses` reads: `owner.sync` streams outputs for
 * the addresses asked about, `beef` serves the transactions.
 */
function fakeServices(
	paid: Map<string, ReturnType<typeof payment>>,
	queried: string[][],
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
			async *sync(addresses: string[]) {
				queried.push(addresses);
				for (const address of addresses) {
					const hit = paid.get(address);
					if (hit) yield { outpoint: `${hit.txid}_0`, score: 900 };
				}
			},
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
	const { wallet, internalized, listed } = fakeWallet();
	const { addressManager } = await buildReceiveAddressManager({
		wallet,
		chain,
		identityKey,
		state: createDefaultReceiveAddressState(),
	});
	return { wallet, internalized, listed, addressManager };
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
	return { output, basket: remittance.basket, ci };
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
		const { wallet, internalized, listed, addressManager } =
			await setup("main");
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
		// The deposit sweep ran over the deposit basket.
		assert.deepEqual(listed, [DEPOSIT_BASKET]);
		assert.equal(await spendWith(ctx, paid.tx, ci), true);

		// Already processed: a second run does not internalize it again.
		await syncReceiveAddresses(ctx, addressManager, store);
		assert.equal(internalized.length, 1);
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

	it("is wired into the owned sync beside the address task", () => {
		const engine = readFileSync(
			join(process.cwd(), "providers/hooks/use-sync-engine.ts"),
			"utf8",
		);
		assert.match(
			engine,
			/receiveAddresses: \(\) =>\s*syncReceiveAddresses\(\s*ctx,\s*addressManager,\s*openReceiveAddressStore\(chain, identityKey\),/,
		);
		assert.match(engine, /"addresses",\s*"receiveAddresses",/);
	});
});

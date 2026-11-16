import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { OneSatContext } from "@1sat/actions";
import { OneColor } from "@1sat/templates";
import {
	assetBasket,
	COLOR_KEY_ID,
	ColorConsentDeclinedError,
	ColorPlan,
	type ColorRemittance,
	colorProtocolID,
	colorTopic,
	createColorModule,
	ISSUE,
} from "@bsv/color-permission-module";
import {
	Beef,
	type CreateActionArgs,
	type CreateActionResult,
	type ListOutputsArgs,
	type ListOutputsResult,
	LockingScript,
	type LookupAnswer,
	P2PKH,
	PrivateKey,
	ProtoWallet,
	PublicKey,
	type SignActionArgs,
	type SignActionResult,
	Spend,
	type STEAK,
	Transaction,
	UnlockingScript,
	Utils,
	type WalletInterface,
} from "@bsv/sdk";
import { type PermissionsModuleAction, sdk } from "@bsv/wallet-toolbox-client";
import { clearDiagnostics } from "@/lib/runtime-diagnostics";
import { appGatedColorModule } from "@/lib/wallet/color-module";
import {
	describeOneColorMintFailure,
	ONE_COLOR_DECIMALS_UNREADABLE,
	type OneColorActionSet,
	oneColorDecimalsError,
	prepareOneColorMint,
	runOneColorMint,
} from "@/lib/wallet/one-color-actions";
import {
	type Mint1ColorInput,
	type Mint1ColorResult,
	mintOneColor,
	mintOneColorOrThrow,
} from "@/lib/wallet/one-color-mint";

const ASSET_TXID = "ab".repeat(32);
const ASSET_ID = `${ASSET_TXID}_0`;
const KEY = PrivateKey.fromHex("01".repeat(32));
const IDENTITY = KEY.toPublicKey().toString();
const proto = new ProtoWallet(KEY);

const originalError = console.error;
beforeEach(() => {
	console.error = () => {};
});
afterEach(() => {
	console.error = originalError;
	clearDiagnostics();
});

/** Records the one createAction and answers it with a transaction of its outputs. */
function recordingWallet() {
	const created: CreateActionArgs[] = [];
	const other: string[] = [];
	const wallet = {
		getPublicKey: (args: Parameters<WalletInterface["getPublicKey"]>[0]) =>
			proto.getPublicKey(args),
		createAction: async (args: CreateActionArgs) => {
			created.push(args);
			const tx = new Transaction();
			for (const output of args.outputs ?? []) {
				tx.addOutput({
					lockingScript: LockingScript.fromHex(output.lockingScript),
					satoshis: output.satoshis,
				});
			}
			return { txid: tx.id("hex"), tx: tx.toAtomicBEEF() };
		},
	};
	const ctx = {
		wallet: new Proxy(wallet, {
			get(target, prop) {
				if (prop in target) return target[prop as keyof typeof target];
				return () => {
					other.push(String(prop));
					throw new Error(`unexpected wallet call ${String(prop)}`);
				};
			},
		}) as unknown as WalletInterface,
		chain: "test",
	} as unknown as OneSatContext;
	return { ctx, created, other };
}

/** The P2PKH lock of this wallet's key for a kept output's custody. */
async function ownLock(derivationPrefix: string, derivationSuffix: string) {
	const { publicKey } = await proto.getPublicKey({
		protocolID: colorProtocolID(ASSET_ID, derivationPrefix, derivationSuffix),
		keyID: COLOR_KEY_ID,
		counterparty: IDENTITY,
		forSelf: true,
	});
	return new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex();
}

/** The one createAction, checked exactly against the module test's request. */
async function expectMintAction(
	created: CreateActionArgs[],
	expected: {
		description: string;
		outputs: Array<{ role: "value" | "authority"; amount: bigint }>;
		operations: string[];
	},
) {
	assert.equal(created.length, 1);
	const args = created[0];
	assert.equal(args.description, expected.description);
	assert.deepEqual(args.options, { randomizeOutputs: false });
	assert.equal(args.inputs, undefined);
	assert.equal(args.inputBEEF, undefined);

	const plan = ColorPlan.fromLabels(args.labels);
	assert.ok(plan);
	assert.deepEqual(args.labels, ColorPlan.toLabels(plan));
	assert.deepEqual(plan.assets, [ASSET_ID]);
	assert.deepEqual(
		plan.operations,
		expected.operations.map((operation) => ({ assetId: ASSET_ID, operation })),
	);
	assert.deepEqual(plan.inputPositions, []);
	assert.deepEqual(plan.changePositions, []);
	assert.deepEqual(plan.sighashTypes, []);

	const outputs = args.outputs ?? [];
	assert.equal(outputs.length, expected.outputs.length);
	assert.deepEqual(
		plan.ownedOutputs.map((owned) => owned.outputIndex),
		expected.outputs.map((_, index) => index),
	);
	const remittanceStrings = new Set<string>();
	for (const [index, want] of expected.outputs.entries()) {
		const output = outputs[index];
		assert.deepEqual(Object.keys(output).sort(), [
			"lockingScript",
			"outputDescription",
			"satoshis",
		]);
		assert.equal(output.satoshis, 1);
		const owned: ColorRemittance = plan.ownedOutputs[index];
		// A fresh custody per output, naming the asset (never ISSUE) and this wallet.
		assert.equal(owned.assetId, ASSET_ID);
		assert.equal(owned.senderIdentityKey, IDENTITY);
		assert.match(owned.derivationPrefix, /^[A-Za-z0-9+/]{22}==$/);
		assert.match(owned.derivationSuffix, /^[A-Za-z0-9+/]{22}==$/);
		remittanceStrings.add(owned.derivationPrefix);
		remittanceStrings.add(owned.derivationSuffix);

		const token = OneColor.decode(LockingScript.fromHex(output.lockingScript));
		assert.ok(token);
		assert.equal(token.role, want.role);
		assert.equal(token.tokenId, ASSET_ID);
		assert.equal(token.amount, want.amount);
		assert.equal(
			token.lock.toHex(),
			await ownLock(owned.derivationPrefix, owned.derivationSuffix),
		);
		assert.equal(
			output.outputDescription,
			want.role === "value" ? "Minted 1Color tokens" : "1Color mint authority",
		);
	}
	assert.equal(remittanceStrings.size, expected.outputs.length * 2);
	return args;
}

describe("mintOneColor", () => {
	it("mints and keeps a replacement authority: value then authority, [mint, authority-transfer]", async () => {
		const { ctx, created, other } = recordingWallet();
		const result = await mintOneColor(ctx, {
			assetId: ASSET_ID,
			amount: 2_500n,
		});
		assert.equal(result.error, undefined);
		await expectMintAction(created, {
			description: "Mint 2500 1Color tokens",
			outputs: [
				{ role: "value", amount: 2_500n },
				{ role: "authority", amount: 0n },
			],
			operations: ["mint", "authority-transfer"],
		});
		assert.equal(result.assetId, ASSET_ID);
		assert.equal(result.authorityOutpoint, `${result.txid}.1`);
		assert.equal(
			Transaction.fromAtomicBEEF(result.tx ?? []).id("hex"),
			result.txid,
		);
		assert.deepEqual(other, []);
	});

	it("a final mint ends minting: value only, [mint, authority-end]", async () => {
		const { ctx, created } = recordingWallet();
		const result = await mintOneColor(ctx, {
			assetId: ASSET_ID,
			amount: "7",
			endMinting: true,
		});
		assert.equal(result.error, undefined);
		await expectMintAction(created, {
			description: "Mint 7 1Color tokens and end minting",
			outputs: [{ role: "value", amount: 7n }],
			operations: ["mint", "authority-end"],
		});
		assert.equal(result.authorityOutpoint, undefined);
	});

	it("ending without minting requests no outputs: [authority-end]", async () => {
		const { ctx, created } = recordingWallet();
		const result = await mintOneColor(ctx, {
			assetId: ASSET_ID,
			amount: 0n,
			endMinting: true,
		});
		assert.equal(result.error, undefined);
		await expectMintAction(created, {
			description: "End 1Color minting",
			outputs: [],
			operations: ["authority-end"],
		});
	});

	it("refuses amount 0 without endMinting, a bad asset id and an amount above 2^64-1 before the wallet is asked", async () => {
		const { ctx, created } = recordingWallet();
		assert.deepEqual(
			await mintOneColor(ctx, { assetId: ASSET_ID, amount: 0n }),
			{
				error: "amount-must-be-positive",
			},
		);
		for (const assetId of [ISSUE, ASSET_TXID, `${ASSET_TXID}.0`, "x_0"]) {
			assert.deepEqual(await mintOneColor(ctx, { assetId, amount: 1n }), {
				error: "invalid-asset-id: expected <txid>_<vout>",
			});
		}
		assert.deepEqual(
			await mintOneColor(ctx, { assetId: ASSET_ID, amount: 2n ** 64n }),
			{ error: "amount-out-of-range" },
		);
		assert.deepEqual(
			await mintOneColor(ctx, { assetId: ASSET_ID, amount: -1n }),
			{ error: "amount-out-of-range" },
		);
		for (const amount of ["abc", "1.5", "", "0x10", "1e3"]) {
			assert.deepEqual(await mintOneColor(ctx, { assetId: ASSET_ID, amount }), {
				error: "invalid-amount",
			});
		}
		assert.equal(created.length, 0);
	});

	it("mintOneColorOrThrow throws input errors and the wallet's own error object", async () => {
		const { ctx, created } = recordingWallet();
		await assert.rejects(
			mintOneColorOrThrow(ctx, { assetId: ASSET_ID, amount: 0n }),
			{ message: "amount-must-be-positive" },
		);
		await assert.rejects(
			mintOneColorOrThrow(ctx, { assetId: ASSET_ID, amount: "1.5" }),
			{ message: "invalid-amount" },
		);
		await assert.rejects(
			mintOneColorOrThrow(ctx, { assetId: "x_0", amount: 1n }),
			{ message: "invalid-asset-id: expected <txid>_<vout>" },
		);
		assert.equal(created.length, 0);

		const review = Object.assign(new Error("WERR_REVIEW_ACTIONS"), {
			name: "WERR_REVIEW_ACTIONS",
			sendWithResults: [{ txid: ASSET_TXID, status: "failed" }],
			cause: new Error("broadcast rejected"),
		});
		const failing = {
			wallet: {
				getPublicKey: proto.getPublicKey.bind(proto),
				createAction: async () => {
					throw review;
				},
			},
		} as unknown as OneSatContext;
		const thrown = await mintOneColorOrThrow(failing, {
			assetId: ASSET_ID,
			amount: 1n,
		}).catch((error: unknown) => error);
		assert.equal(thrown, review);
	});

	it("a txid without the transaction is a mint that went out", async () => {
		const txidOnly = {
			wallet: {
				getPublicKey: proto.getPublicKey.bind(proto),
				createAction: async () => ({ txid: ASSET_TXID }),
			},
		} as unknown as OneSatContext;
		assert.deepEqual(
			await mintOneColor(txidOnly, { assetId: ASSET_ID, amount: 1n }),
			{
				txid: ASSET_TXID,
				assetId: ASSET_ID,
				authorityOutpoint: `${ASSET_TXID}.1`,
			},
		);
	});

	it("reports a createAction failure as its error and an empty result as no-transaction", async () => {
		const failing = {
			wallet: {
				getPublicKey: proto.getPublicKey.bind(proto),
				createAction: async () => {
					throw new Error("WERR_INSUFFICIENT_FUNDS: insufficient funds");
				},
			},
		} as unknown as OneSatContext;
		assert.deepEqual(
			await mintOneColor(failing, { assetId: ASSET_ID, amount: 1n }),
			{ error: "WERR_INSUFFICIENT_FUNDS: insufficient funds" },
		);
		const empty = {
			wallet: {
				getPublicKey: proto.getPublicKey.bind(proto),
				createAction: async () => ({}),
			},
		} as unknown as OneSatContext;
		assert.deepEqual(
			await mintOneColor(empty, { assetId: ASSET_ID, amount: 1n }),
			{ error: "no-transaction" },
		);
	});
});

describe("describeOneColorMintFailure", () => {
	const notSent = (error: unknown) => {
		const failure = describeOneColorMintFailure(error);
		assert.equal(failure.mayHaveBeenSent, false, String(error));
		return failure.message;
	};

	it("says nothing was sent only for the module's consent refusal", () => {
		assert.equal(
			notSent(new ColorConsentDeclinedError("color_send")),
			"The wallet declined the mint. Nothing was sent.",
		);
		for (const error of [
			`BRC-207: insufficient spendable authority of ${ASSET_ID}`,
			`BRC-207: the overlay has no admitted deploy for ${ASSET_ID}`,
			`BRC-207: a ${ASSET_ID} input is no longer spendable`,
			`No 1Color overlay is configured for token ${ASSET_ID} on this network.`,
			"WERR_INSUFFICIENT_FUNDS: Insufficient funds in the available inputs",
			"amount-must-be-positive",
			"amount-out-of-range",
			"invalid-asset-id: expected <txid>_<vout>",
		]) {
			assert.doesNotMatch(notSent(new Error(error)), /Nothing was sent/);
		}
	});

	it("maps the module's refusals before signing to specific messages", () => {
		assert.match(
			notSent(
				new Error(`BRC-207: insufficient spendable authority of ${ASSET_ID}`),
			),
			/mint authority isn't spendable/,
		);
		assert.match(
			notSent(
				new Error(
					`BRC-207: the overlay has no admitted deploy for ${ASSET_ID}`,
				),
			),
			/hasn't admitted this token/,
		);
		assert.match(
			notSent(new Error(`BRC-207: a ${ASSET_ID} input is no longer spendable`)),
			/spent elsewhere/,
		);
		assert.match(notSent(new Error("insufficient funds")), /Not enough BSV/);
		const toolbox = Object.assign(
			new Error("Insufficient funds in the available inputs"),
			{ name: "WERR_INSUFFICIENT_FUNDS" },
		);
		assert.match(notSent(toolbox), /Not enough BSV/);
		assert.equal(notSent(new Error("invalid-amount")), "Enter a valid amount.");
	});

	it("a later failure that only mentions funds is not the toolbox's refusal", () => {
		for (const message of [
			"overlay submit failed: insufficient funds",
			"broadcast: WERR_INSUFFICIENT_FUNDS from a peer",
		]) {
			const failure = describeOneColorMintFailure(new Error(message));
			assert.equal(failure.mayHaveBeenSent, true, message);
			assert.match(failure.message, /may have gone out/);
		}
	});

	it("treats anything after signing as possibly sent, without inviting a repeat", () => {
		for (const error of [
			new Error("overlay submit 503"),
			new Error("no-transaction"),
			new Error("WERR_REVIEW_ACTIONS"),
			"weird",
		]) {
			const failure = describeOneColorMintFailure(error);
			assert.equal(failure.mayHaveBeenSent, true);
			assert.match(failure.message, /may have gone out/);
			assert.match(failure.message, /before minting again/);
			assert.doesNotMatch(failure.message, /Nothing was sent|[Tt]ry again/);
		}
	});
});

describe("runOneColorMint", () => {
	const harness = (
		result: Mint1ColorResult | { throws: unknown },
		options: { refreshFails?: boolean } = {},
	) => {
		const calls: Mint1ColorInput[] = [];
		const logged: Array<{ operation: string; error: unknown }> = [];
		let refreshed = 0;
		const actions: Pick<OneColorActionSet, "mint"> = {
			mint: async (_ctx, input) => {
				calls.push(input);
				if ("throws" in result) throw result.throws;
				return result;
			},
		};
		const run = (endMinting: boolean, amount = 2_500n) =>
			runOneColorMint(
				{} as OneSatContext,
				{ assetId: ASSET_ID, amount, endMinting },
				{
					actions,
					log: (operation, error) => logged.push({ operation, error }),
					refresh: async () => {
						refreshed++;
						if (options.refreshFails) throw new Error("refresh down");
					},
				},
			);
		return { calls, logged, run, refreshed: () => refreshed };
	};

	it("passes the exact input, refreshes, and reports the txid", async () => {
		const { calls, logged, run, refreshed } = harness({
			txid: ASSET_TXID,
			tx: [1],
		});
		assert.deepEqual(await run(false), {
			ok: true,
			txid: ASSET_TXID,
			endedMinting: false,
		});
		assert.deepEqual(calls, [
			{ assetId: ASSET_ID, amount: "2500", endMinting: false },
		]);
		assert.equal(refreshed(), 1);
		assert.deepEqual(logged, []);
	});

	it("logs the very error thrown, refreshes and classifies a failure", async () => {
		const consent = new ColorConsentDeclinedError("color_send");
		const declined = harness({ throws: consent });
		const outcome = await declined.run(true, 0n);
		assert.deepEqual(outcome, {
			ok: false,
			message: "The wallet declined the mint. Nothing was sent.",
			mayHaveBeenSent: false,
		});
		assert.equal(declined.logged[0].operation, "mint-end");
		// The same instance, so the log keeps its name, stack and fields.
		assert.equal(declined.logged[0].error, consent);
		assert.equal(declined.refreshed(), 1);

		const review = Object.assign(new Error("WERR_REVIEW_ACTIONS"), {
			name: "WERR_REVIEW_ACTIONS",
			sendWithResults: [{ txid: ASSET_TXID, status: "failed" }],
		});
		const thrown = harness({ throws: review }, { refreshFails: true });
		const failed = await thrown.run(false);
		assert.equal(failed.ok, false);
		assert.equal(!failed.ok && failed.mayHaveBeenSent, true);
		assert.deepEqual(
			thrown.logged.map((entry) => entry.operation),
			["mint", "holdings-refresh"],
		);
		assert.equal(thrown.logged[0].error, review);
	});

	it("runs the throwing mint by default", async () => {
		const logged: unknown[] = [];
		const outcome = await runOneColorMint(
			{} as OneSatContext,
			{ assetId: "x_0", amount: 1n, endMinting: false },
			{
				log: (_operation, error) => logged.push(error),
				refresh: async () => {},
			},
		);
		assert.deepEqual(outcome, {
			ok: false,
			message: "This token's id isn't valid, so it can't be minted.",
			mayHaveBeenSent: false,
		});
		assert.ok(logged[0] instanceof Error);
	});
});

// End to end through the color module, with the module test's fakes ported
// (`ColorPermissionModule.operations.test.ts`, `fixtures.ts`).

interface StoredOutput {
	tx: Transaction;
	vout: number;
	basket?: string;
	customInstructions?: string;
	tags?: string[];
	reservedBy?: string;
	spent: boolean;
}

function validInput(tx: Transaction, inputIndex: number): boolean {
	const input = tx.inputs[inputIndex];
	const sourceTransaction = input.sourceTransaction;
	assert.ok(sourceTransaction);
	const source = sourceTransaction.outputs[input.sourceOutputIndex];
	return new Spend({
		sourceTXID: sourceTransaction.id("hex"),
		sourceOutputIndex: input.sourceOutputIndex,
		sourceSatoshis: source.satoshis ?? 0,
		lockingScript: source.lockingScript,
		transactionVersion: tx.version,
		otherInputs: tx.inputs.filter((_, index) => index !== inputIndex),
		outputs: tx.outputs,
		inputIndex,
		unlockingScript: input.unlockingScript ?? new UnlockingScript(),
		inputSequence: input.sequence ?? 0xffffffff,
		lockTime: tx.lockTime,
	}).validate();
}

/** The wallet beneath the permissions manager: real keys, an in-memory output store, two-phase actions. */
class FakeWallet {
	readonly outputs = new Map<string, StoredOutput>();
	readonly pending = new Map<
		string,
		{ tx: Transaction; args: CreateActionArgs }
	>();
	#next = 0;

	getPublicKey: WalletInterface["getPublicKey"] = (args) =>
		proto.getPublicKey(args);
	createSignature: WalletInterface["createSignature"] = (args) =>
		proto.createSignature(args);
	encrypt: WalletInterface["encrypt"] = (args) => proto.encrypt(args);
	decrypt: WalletInterface["decrypt"] = (args) => proto.decrypt(args);

	store(
		tx: Transaction,
		vout: number,
		basket?: string,
		customInstructions?: string,
		tags?: string[],
	) {
		this.outputs.set(`${tx.id("hex")}.${vout}`, {
			tx,
			vout,
			basket,
			customInstructions,
			tags,
			spent: false,
		});
	}

	async listOutputs(args: ListOutputsArgs): Promise<ListOutputsResult> {
		const inventory = args.basket === sdk.specOpBasketPrefixOutputs;
		const records = [...this.outputs.entries()]
			.filter(([, output]) =>
				inventory
					? !output.spent &&
						output.basket?.startsWith(`${args.tags?.[0]} `) === true
					: !output.spent &&
						output.reservedBy === undefined &&
						output.basket === args.basket &&
						(!args.tags?.length ||
							args.tags.some((tag) => output.tags?.includes(tag))),
			)
			.sort(([a], [b]) => (a < b ? -1 : 1));
		const offset = args.offset ?? 0;
		const page = inventory
			? records
			: records.slice(offset, offset + (args.limit ?? 10));
		const beef = new Beef();
		const result: ListOutputsResult = {
			totalOutputs: records.length,
			outputs: page.map(([outpoint, output]) => {
				if (args.include === "entire transactions") {
					beef.mergeTransaction(output.tx);
				}
				return {
					outpoint,
					satoshis: output.tx.outputs[output.vout].satoshis ?? 0,
					spendable: output.reservedBy === undefined,
					lockingScript:
						args.include === "locking scripts"
							? output.tx.outputs[output.vout].lockingScript.toHex()
							: undefined,
					customInstructions: args.includeCustomInstructions
						? output.customInstructions
						: undefined,
					tags: args.includeTags ? [...(output.tags ?? [])] : undefined,
				};
			}),
		};
		if (args.include === "entire transactions") result.BEEF = beef.toBinary();
		return result;
	}

	async createAction(args: CreateActionArgs): Promise<CreateActionResult> {
		const beef = args.inputBEEF ? Beef.fromBinary(args.inputBEEF) : new Beef();
		const tx = new Transaction();
		const reference = `reference-${this.#next++}`;
		for (const input of args.inputs ?? []) {
			const found = beef.findTxid(input.outpoint.split(".")[0]);
			if (!found || found.isTxidOnly) {
				throw new Error("Every input must have a sourceTransaction");
			}
			const stored = this.outputs.get(input.outpoint);
			if (!stored || stored.spent || stored.reservedBy !== undefined) {
				throw new Error(`input ${input.outpoint} is not available`);
			}
			stored.reservedBy = reference;
			tx.addInput({
				sourceTransaction: stored.tx,
				sourceOutputIndex: stored.vout,
				unlockingScript: new UnlockingScript(),
			});
		}
		for (const output of args.outputs ?? []) {
			tx.addOutput({
				lockingScript: LockingScript.fromHex(output.lockingScript),
				satoshis: output.satoshis,
			});
		}
		this.pending.set(reference, { tx, args });
		return { signableTransaction: { tx: tx.toAtomicBEEF(), reference } };
	}

	async signAction(args: SignActionArgs): Promise<SignActionResult> {
		const pending = this.pending.get(args.reference);
		if (!pending) throw new Error("unknown reference");
		for (const [index, spend] of Object.entries(args.spends ?? {})) {
			pending.tx.inputs[Number(index)].unlockingScript =
				UnlockingScript.fromHex(spend.unlockingScript);
			if (!validInput(pending.tx, Number(index))) {
				throw new Error(`input ${index} does not unlock`);
			}
		}
		this.pending.delete(args.reference);
		for (const input of pending.args.inputs ?? []) {
			const stored = this.outputs.get(input.outpoint);
			if (stored) stored.spent = true;
		}
		pending.args.outputs?.forEach((output, vout) => {
			this.store(
				pending.tx,
				vout,
				output.basket,
				output.customInstructions,
				output.tags,
			);
		});
		return { txid: pending.tx.id("hex"), tx: pending.tx.toAtomicBEEF() };
	}
}

/** An overlay that admits the token outputs of each submission to its topic. */
class FakeProvider {
	readonly current = new Map<
		string,
		{ assetId: string; tx: Transaction; vout: number }
	>();
	readonly history = new Map<
		string,
		{ assetId: string; tx: Transaction; vout: number }
	>();
	readonly submissions: Array<{ topics: string[]; txid: string }> = [];

	admit(assetId: string, tx: Transaction, vout: number) {
		const entry = { assetId, tx, vout };
		this.current.set(`${tx.id("hex")}.${vout}`, entry);
		this.history.set(`${tx.id("hex")}.${vout}`, entry);
	}

	spendability = async (assetId: string, outpoints: string[]) =>
		this.#answer(this.current, assetId, outpoints);
	admission = async (assetId: string, outpoints: string[]) =>
		this.#answer(this.history, assetId, outpoints);

	submit = async (topics: string[], beef: number[]): Promise<STEAK> => {
		const tx = Transaction.fromAtomicBEEF(beef);
		const txid = tx.id("hex");
		this.submissions.push({ topics, txid });
		for (const input of tx.inputs) {
			this.current.delete(
				`${input.sourceTransaction?.id("hex")}.${input.sourceOutputIndex}`,
			);
		}
		const steak: STEAK = {};
		for (const topic of topics) {
			const assetId = topic.slice("tm_color_".length);
			const outputsToAdmit = tx.outputs.flatMap((output, vout) =>
				OneColor.decode(output.lockingScript)?.tokenId === assetId
					? [vout]
					: [],
			);
			for (const vout of outputsToAdmit) this.admit(assetId, tx, vout);
			steak[topic] = { outputsToAdmit, coinsToRetain: [] };
		}
		return steak;
	};

	#answer(
		entries: Map<string, { assetId: string; tx: Transaction; vout: number }>,
		assetId: string,
		outpoints: string[],
	): LookupAnswer {
		return {
			type: "output-list",
			outputs: outpoints.flatMap((outpoint) => {
				const entry = entries.get(outpoint);
				return entry?.assetId === assetId
					? [{ beef: entry.tx.toBEEF(), outputIndex: entry.vout }]
					: [];
			}),
		};
	}
}

const ADMIN = "localhost:3000";

/**
 * An authority deploy held by `wallet`, as `deployAsset(wallet, provider, 0n)`
 * in the module's fixtures: `ISSUE` custody in the authority basket, admitted.
 */
async function deployAuthority(wallet: FakeWallet, provider: FakeProvider) {
	const custody = {
		derivationPrefix: Utils.toBase64(
			Array.from(crypto.getRandomValues(new Uint8Array(16))),
		),
		derivationSuffix: Utils.toBase64(
			Array.from(crypto.getRandomValues(new Uint8Array(16))),
		),
		senderIdentityKey: IDENTITY,
	};
	const { publicKey } = await wallet.getPublicKey({
		protocolID: colorProtocolID(
			ISSUE,
			custody.derivationPrefix,
			custody.derivationSuffix,
		),
		keyID: COLOR_KEY_ID,
		counterparty: IDENTITY,
		forSelf: true,
	});
	const tx = new Transaction();
	tx.addOutput({
		lockingScript: OneColor.deployAuthority({
			lock: PublicKey.fromString(publicKey).toHash() as number[],
		}).lock(),
		satoshis: 1000,
	});
	const assetId = `${tx.id("hex")}_0`;
	provider.admit(assetId, tx, 0);
	wallet.store(
		tx,
		0,
		assetBasket(assetId, "authority"),
		JSON.stringify({ version: 1, assetId: ISSUE, ...custody }),
		[
			`p color ${Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(32))))}`,
		],
	);
	return assetId;
}

/**
 * `colorContext` over the module as the permissions manager runs it: the
 * createAction and signAction hooks around the fake wallet, behind the gate
 * the permissions manager registers (the wallet itself passes through it).
 */
function moduleContext(wallet: FakeWallet, provider: FakeProvider) {
	const prompts: Array<Record<string, unknown>> = [];
	const module = appGatedColorModule(
		createColorModule({
			wallet: wallet as unknown as WalletInterface,
			provider,
			requestTokenAccess: async (app, message) => {
				prompts.push(JSON.parse(message));
				return app === ADMIN;
			},
		}),
		ADMIN,
	);
	const manager = {
		getPublicKey: wallet.getPublicKey,
		createAction: async (args: CreateActionArgs) => {
			const request = await module.onRequest({
				method: "createAction",
				args,
				originator: ADMIN,
			});
			const funded = request.args as CreateActionArgs;
			const created = (await module.onResponse(
				await wallet.createAction(funded),
				{ method: "createAction", originator: ADMIN },
			)) as CreateActionResult;
			const signable = created.signableTransaction;
			assert.ok(signable);
			const action: PermissionsModuleAction = {
				reference: signable.reference,
				transaction: Transaction.fromAtomicBEEF(signable.tx),
				noSend: false,
				createArgs: funded,
			};
			const signArgs = (
				await module.onRequest({
					method: "signAction",
					args: { reference: signable.reference, spends: {} },
					originator: ADMIN,
					action,
				})
			).args as SignActionArgs;
			return (await module.onResponse(await wallet.signAction(signArgs), {
				method: "signAction",
				originator: ADMIN,
				action,
			})) as SignActionResult;
		},
	};
	const ctx = {
		wallet: manager as unknown as WalletInterface,
		chain: "test",
	} as unknown as OneSatContext;
	return { ctx, prompts };
}

describe("mintOneColor through the color module", () => {
	it("mints 2,500 with the deploy's authority and keeps a replacement authority", async () => {
		const wallet = new FakeWallet();
		const provider = new FakeProvider();
		const assetId = await deployAuthority(wallet, provider);
		const { ctx, prompts } = moduleContext(wallet, provider);

		const result = await mintOneColor(ctx, { assetId, amount: 2_500n });
		assert.equal(result.error, undefined);
		const tx = Transaction.fromAtomicBEEF(result.tx ?? []);
		assert.deepEqual(
			tx.inputs.map((input) => input.sourceTransaction?.id("hex")),
			[assetId.slice(0, 64)],
		);
		assert.equal(validInput(tx, 0), true);
		assert.deepEqual(
			tx.outputs.map((output) => OneColor.decode(output.lockingScript)?.amount),
			[2_500n, 0n],
		);
		const txid = tx.id("hex");
		assert.equal(
			wallet.outputs.get(`${txid}.0`)?.basket,
			assetBasket(assetId, "value"),
		);
		assert.equal(
			wallet.outputs.get(`${txid}.1`)?.basket,
			assetBasket(assetId, "authority"),
		);
		assert.equal(result.authorityOutpoint, `${txid}.1`);
		assert.deepEqual(provider.submissions, [
			{ topics: [colorTopic(assetId)], txid },
		]);
		assert.equal(prompts[0]?.type, "color_send");
		const assets = prompts[0]?.assets as
			| Array<Record<string, unknown>>
			| undefined;
		assert.deepEqual(assets?.[0]?.operations, ["mint", "authority-transfer"]);

		// The continuing authority mints again, then ends minting with no outputs.
		const again = await mintOneColor(ctx, { assetId, amount: 1n });
		assert.equal(again.error, undefined);
		const second = Transaction.fromAtomicBEEF(again.tx ?? []);
		assert.equal(
			`${second.inputs[0].sourceTransaction?.id("hex")}.${second.inputs[0].sourceOutputIndex}`,
			result.authorityOutpoint,
		);
		const ended = await mintOneColor(ctx, {
			assetId,
			amount: 0n,
			endMinting: true,
		});
		assert.equal(ended.error, undefined);
		const end = Transaction.fromAtomicBEEF(ended.tx ?? []);
		assert.equal(end.inputs.length, 1);
		assert.equal(end.outputs.length, 0);
		assert.deepEqual(provider.submissions.at(-1), {
			topics: [colorTopic(assetId)],
			txid: end.id("hex"),
		});

		// No authority is left: the module refuses before anything is signed.
		const none = await mintOneColor(ctx, { assetId, amount: 1n });
		assert.equal(
			none.error,
			`BRC-207: insufficient spendable authority of ${assetId}`,
		);
		assert.equal(
			describeOneColorMintFailure(new Error(none.error)).mayHaveBeenSent,
			false,
		);
	});

	it("a final mint spends the authority and keeps only the minted value", async () => {
		const wallet = new FakeWallet();
		const provider = new FakeProvider();
		const assetId = await deployAuthority(wallet, provider);
		const { ctx } = moduleContext(wallet, provider);

		const result = await mintOneColor(ctx, {
			assetId,
			amount: 2_500n,
			endMinting: true,
		});
		assert.equal(result.error, undefined);
		const tx = Transaction.fromAtomicBEEF(result.tx ?? []);
		assert.equal(tx.inputs.length, 1);
		assert.deepEqual(
			tx.outputs.map((output) => OneColor.decode(output.lockingScript)?.role),
			["value"],
		);
		assert.equal(result.authorityOutpoint, undefined);
		const authorities = [...wallet.outputs.values()].filter(
			(output) =>
				!output.spent && output.basket === assetBasket(assetId, "authority"),
		);
		assert.deepEqual(authorities, []);
	});

	it("ending minting alone spends the authority with no outputs: [authority-end]", async () => {
		const wallet = new FakeWallet();
		const provider = new FakeProvider();
		const assetId = await deployAuthority(wallet, provider);
		const { ctx, prompts } = moduleContext(wallet, provider);

		const result = await mintOneColorOrThrow(ctx, {
			assetId,
			amount: "0",
			endMinting: true,
		});
		const tx = Transaction.fromAtomicBEEF(result.tx ?? []);
		assert.equal(result.txid, tx.id("hex"));
		assert.equal(result.authorityOutpoint, undefined);
		assert.deepEqual(
			tx.inputs.map(
				(input) =>
					`${input.sourceTransaction?.id("hex")}.${input.sourceOutputIndex}`,
			),
			[`${assetId.slice(0, 64)}.0`],
		);
		assert.equal(validInput(tx, 0), true);
		assert.deepEqual(
			tx.outputs.filter((output) => OneColor.decode(output.lockingScript)),
			[],
		);
		assert.equal(prompts.length, 1);
		const assets = prompts[0]?.assets as
			| Array<Record<string, unknown>>
			| undefined;
		assert.deepEqual(assets?.[0]?.operations, ["authority-end"]);
		assert.deepEqual(provider.submissions, [
			{ topics: [colorTopic(assetId)], txid: tx.id("hex") },
		]);
		const kept = [...wallet.outputs.values()].filter(
			(output) =>
				!output.spent &&
				(output.basket === assetBasket(assetId, "authority") ||
					output.basket === assetBasket(assetId, "value")),
		);
		assert.deepEqual(kept, []);

		// Nothing is left to mint with.
		await assert.rejects(
			mintOneColorOrThrow(ctx, { assetId, amount: 1n }),
			new RegExp(`insufficient spendable authority of ${assetId}`),
		);
	});
});

describe("prepareOneColorMint", () => {
	const token = { assetId: ASSET_ID, dec: 8 };
	const phrase = `END ${ASSET_ID}`;
	const prepare = (
		form: Partial<Parameters<typeof prepareOneColorMint>[0]>,
		over: Partial<Parameters<typeof prepareOneColorMint>[1]> = {},
	) =>
		prepareOneColorMint(
			{ amount: "", endMinting: false, confirmation: "", ...form },
			{ ...token, ...over },
		);

	it("parses display units against the token's decimals", () => {
		assert.deepEqual(prepare({ amount: "1.5" }), {
			ok: true,
			input: { assetId: ASSET_ID, amount: 150_000_000n, endMinting: false },
		});
		assert.deepEqual(prepare({ amount: "100" }, { dec: 0 }), {
			ok: true,
			input: { assetId: ASSET_ID, amount: 100n, endMinting: false },
		});
	});

	it("refuses before parsing when the token's decimals couldn't be read", () => {
		for (const form of [
			{ amount: "100" },
			{ amount: "", endMinting: true, confirmation: phrase },
		]) {
			assert.deepEqual(prepare(form, { dec: 0, infoUnreadable: true }), {
				ok: false,
				error: "Couldn't read this token's decimals. Refresh and try again.",
			});
		}
	});

	it("empty or zero ends minting without minting when End minting is on", () => {
		for (const amount of ["", " ", "0", "0.00"]) {
			assert.deepEqual(
				prepare({ amount, endMinting: true, confirmation: phrase }),
				{
					ok: true,
					input: { assetId: ASSET_ID, amount: 0n, endMinting: true },
				},
				amount,
			);
		}
		assert.deepEqual(prepare({ amount: "0" }), {
			ok: false,
			error: "Enter an amount greater than zero.",
		});
	});

	it("says what to fix without asking for more than zero when ending", () => {
		assert.deepEqual(prepare({ amount: "1.123456789" }), {
			ok: false,
			error: "Enter an amount with at most 8 decimals.",
		});
		assert.deepEqual(prepare({ amount: "abc" }, { dec: 0 }), {
			ok: false,
			error: "Enter a whole amount.",
		});
		const ending = prepare({ amount: "abc", endMinting: true });
		assert.equal(ending.ok, false);
		assert.doesNotMatch(!ending.ok ? ending.error : "", /greater than zero/);
		assert.deepEqual(prepare({ amount: `${2n ** 64n}` }, { dec: 0 }), {
			ok: false,
			error: "That amount is too large.",
		});
		assert.equal(prepare({ amount: `${2n ** 64n - 1n}` }, { dec: 0 }).ok, true);
	});

	it("ending needs the exact END phrase", () => {
		assert.deepEqual(prepare({ amount: "1", endMinting: true }), {
			ok: false,
			error: `Type ${phrase} exactly to end minting.`,
		});
		assert.deepEqual(
			prepare({ amount: "1", endMinting: true, confirmation: phrase }),
			{
				ok: true,
				input: { assetId: ASSET_ID, amount: 100_000_000n, endMinting: true },
			},
		);
	});

	it("oneColorDecimalsError flags only an unread deploy", () => {
		assert.equal(oneColorDecimalsError({}), null);
		assert.equal(
			oneColorDecimalsError({ infoUnreadable: true }),
			ONE_COLOR_DECIMALS_UNREADABLE,
		);
	});
});

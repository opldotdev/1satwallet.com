import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BSV21 } from "@1sat/templates";
import { LockingScript, P2PKH, PrivateKey, Transaction } from "@bsv/sdk";
import {
	checkSwapCandidate,
	composeSwap,
	receiveScriptsFromContribution,
	type SwapReceiveScripts,
	type SwapSource,
} from "../lib/p2p-swap/candidate";
import {
	clearPendingSwap,
	listPendingSwaps,
	PENDING_SWAP_TTL_MS,
	type PendingSwap,
	savePendingSwap,
} from "../lib/p2p-swap/pending";
import {
	contributionMatchesTerms,
	parseSwapContribution,
	parseSwapStep,
	type SwapContribution,
	swapBuilder,
} from "../lib/p2p-swap/wire";
import type { P2PTradeItem } from "../lib/types/p2p";

const script = () =>
	new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex();

const TOKEN_ID = `${"b".repeat(64)}_0`;
const FEE_ADDRESS = PrivateKey.fromRandom().toAddress();

function ordinalItem(outpoint: string): P2PTradeItem {
	const [txid, vout] = outpoint.split("_");
	return {
		type: "ordinal",
		id: outpoint,
		name: "Ordinal",
		txid,
		vout: Number(vout),
	};
}

const tokenItem = (amount: string): P2PTradeItem => ({
	type: "bsv21",
	id: TOKEN_ID,
	name: "Token",
	amount,
});

const satsItem = (satoshis: number): P2PTradeItem => ({
	type: "satoshis",
	id: "bsv",
	name: "BSV",
	satoshis,
});

/**
 * Initiator offers ordinal A and 60 of a token held in a 100-token tip;
 * participant offers ordinal B and 5,000 sats, so the participant builds.
 */
function fixture() {
	const initiatorSource = new Transaction(
		1,
		[],
		[
			{
				satoshis: 1,
				lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
			},
			{
				satoshis: 1,
				lockingScript: BSV21.transfer(TOKEN_ID, 100n).lock(
					new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
				),
			},
		],
		0,
	);
	const participantSource = new Transaction(
		1,
		[],
		[
			{
				satoshis: 1,
				lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
			},
			{
				satoshis: 20_000,
				lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
			},
		],
		0,
	);
	const a = `${initiatorSource.id("hex")}_0`;
	const tip = `${initiatorSource.id("hex")}_1`;
	const b = `${participantSource.id("hex")}_0`;
	const funding = `${participantSource.id("hex")}_1`;
	const terms = {
		initiatorItems: [ordinalItem(a), tokenItem("60")],
		participantItems: [ordinalItem(b), satsItem(5_000)],
	};
	const contribution: SwapContribution = {
		initiatorRevision: 2,
		participantRevision: 2,
		inputs: [a, tip],
		receive: {
			nft: [{ id: b, script: script() }],
			token: [],
			change: [{ id: TOKEN_ID, script: script() }],
			satoshis: script(),
		},
	};
	const builderReceive: SwapReceiveScripts = {
		nft: new Map([[a, script()]]),
		token: new Map([[TOKEN_ID, script()]]),
		change: new Map(),
		satoshis: null,
	};
	const composed = composeSwap({
		terms,
		builder: "participant",
		contribution,
		builderReceive,
		builderTips: [],
		contributorTips: [{ outpoint: tip, tokenId: TOKEN_ID, amount: 100n }],
		overlayFees: [
			{ tokenId: TOKEN_ID, address: FEE_ADDRESS, satoshisPerOutput: 1_000 },
		],
		feeLockingScript: (address) => new P2PKH().lock(address).toHex(),
	});
	const sources = new Map<string, Transaction>([
		[initiatorSource.id("hex"), initiatorSource],
		[participantSource.id("hex"), participantSource],
	]);
	const build = (mutate?: (tx: Transaction) => void) => {
		const tx = new Transaction(
			1,
			[...composed.inputs, funding].map((outpoint) => {
				const [txid, vout] = outpoint.split("_");
				return {
					sourceTXID: txid,
					sourceOutputIndex: Number(vout),
					sequence: 0xffffffff,
				};
			}),
			[
				...composed.outputs.map((output) => ({
					satoshis: output.satoshis,
					lockingScript: LockingScript.fromHex(output.lockingScript),
				})),
				{
					satoshis: 12_000,
					lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
				},
			],
			0,
		);
		mutate?.(tx);
		return tx;
	};
	const source =
		(tx: Transaction) =>
		(vin: number): SwapSource | undefined => {
			const input = tx.inputs[vin];
			const output = sources.get(input?.sourceTXID ?? "")?.outputs[
				input?.sourceOutputIndex ?? -1
			];
			return output && output.satoshis !== undefined
				? {
						satoshis: output.satoshis,
						lockingScript: output.lockingScript.toHex(),
					}
				: undefined;
		};
	const overlayFees = [
		{
			tokenId: TOKEN_ID,
			script: new P2PKH().lock(FEE_ADDRESS).toHex(),
			satoshisPerOutput: 1_000,
		},
	];
	const asContributor = (tx: Transaction, myInputs = contribution.inputs) =>
		checkSwapCandidate({
			tx,
			source: source(tx),
			terms,
			me: "initiator",
			myInputs,
			myReceive: receiveScriptsFromContribution(contribution),
			overlayFees,
		});
	const asBuilder = (tx: Transaction) =>
		checkSwapCandidate({
			tx,
			source: source(tx),
			terms,
			me: "participant",
			myInputs: [b],
			myReceive: builderReceive,
			overlayFees,
		});
	return {
		a,
		b,
		tip,
		terms,
		contribution,
		builderReceive,
		composed,
		build,
		asContributor,
		asBuilder,
	};
}

describe("p2p swap terms", () => {
	const ordinal = ordinalItem(`${"c".repeat(64)}_1`);
	it("picks the side paying BSV, else the initiator, to build", () => {
		assert.deepEqual(
			swapBuilder({
				initiatorItems: [ordinal],
				participantItems: [satsItem(5)],
			}),
			{ ok: true, builder: "participant", gift: false },
		);
		assert.deepEqual(
			swapBuilder({
				initiatorItems: [ordinal],
				participantItems: [tokenItem("1")],
			}),
			{ ok: true, builder: "initiator", gift: false },
		);
	});

	it("allows a one-sided trade only when the giver allows gifts", () => {
		assert.deepEqual(
			swapBuilder({ initiatorItems: [], participantItems: [ordinal] }),
			{ ok: false, error: "gifts-off" },
		);
		assert.deepEqual(
			swapBuilder({
				initiatorItems: [],
				participantItems: [ordinal],
				initiatorAllowsGift: true,
			}),
			{ ok: false, error: "gifts-off" },
		);
		assert.deepEqual(
			swapBuilder({
				initiatorItems: [],
				participantItems: [ordinal],
				participantAllowsGift: true,
			}),
			{ ok: true, builder: "participant", gift: true },
		);
		assert.deepEqual(
			swapBuilder({ initiatorItems: [], participantItems: [] }),
			{
				ok: false,
				error: "empty-offer",
			},
		);
	});

	it("refuses BSV from both sides", () => {
		assert.deepEqual(
			swapBuilder({
				initiatorItems: [satsItem(1)],
				participantItems: [satsItem(2)],
			}),
			{ ok: false, error: "both-offer-bsv" },
		);
	});

	it("parses relay steps strictly", () => {
		const { contribution } = fixture();
		assert.deepEqual(parseSwapContribution(contribution), contribution);
		assert.throws(() =>
			parseSwapContribution({ ...contribution, extra: true }),
		);
		assert.throws(() =>
			parseSwapContribution({
				...contribution,
				inputs: [contribution.inputs[0], contribution.inputs[0]],
			}),
		);
		assert.throws(() =>
			parseSwapContribution({
				...contribution,
				receive: { ...contribution.receive, satoshis: "6a" },
			}),
		);
		assert.throws(() =>
			parseSwapStep({ step: "signatures", candidateHash: "x", signatures: [] }),
		);
		assert.throws(() =>
			parseSwapStep({
				step: "outcome",
				outcome: { kind: "failed", reason: "" },
			}),
		);
		assert.deepEqual(
			parseSwapStep({ step: "outcome", outcome: { kind: "unknown" } }),
			{
				step: "outcome",
				outcome: { kind: "unknown" },
			},
		);
	});

	it("checks a contribution covers the locked terms", () => {
		const { contribution, terms } = fixture();
		assert.equal(
			contributionMatchesTerms(
				contribution,
				terms.participantItems,
				terms.initiatorItems,
			),
			true,
		);
		assert.equal(
			contributionMatchesTerms(
				{ ...contribution, inputs: [contribution.inputs[1]] },
				terms.participantItems,
				terms.initiatorItems,
			),
			false,
		);
		assert.equal(
			contributionMatchesTerms(
				{
					...contribution,
					receive: { ...contribution.receive, satoshis: null },
				},
				terms.participantItems,
				terms.initiatorItems,
			),
			false,
		);
	});
});

describe("p2p swap candidate", () => {
	it("lays out ordinals index-aligned, then tokens, fees and payment", () => {
		const { a, b, tip, composed, contribution, builderReceive } = fixture();
		assert.deepEqual(composed.inputs, [a, b, tip]);
		assert.equal(composed.outputs[0].lockingScript, builderReceive.nft.get(a));
		assert.equal(
			composed.outputs[1].lockingScript,
			contribution.receive.nft[0].script,
		);
		assert.deepEqual(
			composed.outputs.map((output) => output.outputDescription),
			[
				"Swap ordinal",
				"Swap ordinal",
				"Swap tokens",
				"Swap token change",
				"Token overlay fee",
				"Swap payment",
			],
		);
		assert.equal(composed.outputs[4].satoshis, 2_000);
		assert.equal(composed.outputs[5].satoshis, 5_000);
	});

	it("passes from both sides when the transaction matches the terms", () => {
		const { build, asContributor, asBuilder } = fixture();
		const tx = build();
		assert.deepEqual(asContributor(tx), { ok: true, myInputIndexes: [0, 2] });
		assert.deepEqual(asBuilder(tx), { ok: true, myInputIndexes: [1] });
	});

	it("fails closed on every tampered candidate", () => {
		const { build, asContributor } = fixture();
		const reasons = [
			build((tx) => {
				tx.outputs[1].lockingScript = new P2PKH().lock(
					PrivateKey.fromRandom().toAddress(),
				);
			}),
			build((tx) => {
				tx.outputs[5].satoshis = 4_999;
			}),
			build((tx) => {
				tx.inputs.reverse();
			}),
			build((tx) => {
				tx.inputs[0].sequence = 0;
			}),
			build((tx) => {
				tx.outputs.splice(3, 1);
			}),
			build((tx) => {
				tx.lockTime = 1;
			}),
		].map((tx) => {
			const result = asContributor(tx);
			assert.equal(result.ok, false);
			return result.ok ? "" : result.reason;
		});
		assert.deepEqual(reasons, [
			"ordinal-receipt-script-1",
			"my-payment",
			"ordinal-input-0",
			"non-final-sequence",
			`token-conservation-${TOKEN_ID}`,
			"non-final-tx",
		]);
	});

	it("rejects token change paid to the wrong owner", () => {
		const { build, asContributor } = fixture();
		const tx = build((candidate) => {
			candidate.outputs[3].lockingScript = BSV21.transfer(TOKEN_ID, 40n).lock(
				new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
			);
		});
		const result = asContributor(tx);
		assert.equal(result.ok ? "" : result.reason, `my-token-change-${TOKEN_ID}`);
	});

	it("requires each token's overlay fee", () => {
		const { build, asContributor, asBuilder } = fixture();
		const tx = build((candidate) => {
			candidate.outputs[4].satoshis = 1_999;
		});
		for (const result of [asContributor(tx), asBuilder(tx)]) {
			assert.equal(result.ok ? "" : result.reason, `overlay-fee-${TOKEN_ID}`);
		}
	});

	it("signs nothing it didn't offer, even if the relay lists it", () => {
		const { build, asContributor, contribution } = fixture();
		const funding = build().inputs[3];
		const extra = `${funding.sourceTXID}_${funding.sourceOutputIndex}`;
		const result = asContributor(build(), [...contribution.inputs, extra]);
		assert.equal(result.ok ? "" : result.reason, "my-input-not-offered-3");
	});
});

describe("p2p pending swaps", () => {
	it("keeps records per wallet and drops stale ones", () => {
		const data = new Map<string, string>();
		const store = {
			get length() {
				return data.size;
			},
			key: (index: number) => [...data.keys()][index] ?? null,
			getItem: (name: string) => data.get(name) ?? null,
			setItem: (name: string, value: string) => void data.set(name, value),
			removeItem: (name: string) => void data.delete(name),
		};
		const { terms, contribution } = fixture();
		const pending = (
			identityKey: string,
			sessionId: string,
			savedAt: number,
		): PendingSwap => ({
			identityKey,
			me: "initiator",
			session: {
				...terms,
				sessionId,
				initiatorIdentity: "i",
				participantIdentity: "p",
				initiatorRevision: 2,
				participantRevision: 2,
			},
			settlement: {
				builder: "participant",
				contribution,
				candidate: { txHex: "00", hash: "h" },
			},
			savedAt,
		});
		const now = 10 * PENDING_SWAP_TTL_MS;
		savePendingSwap(pending("me", "s1", now), store);
		savePendingSwap(pending("me", "s2", now - PENDING_SWAP_TTL_MS - 1), store);
		savePendingSwap(pending("other", "s3", now), store);
		assert.deepEqual(
			listPendingSwaps("me", now, store).map(
				(entry) => entry.session.sessionId,
			),
			["s1"],
		);
		assert.equal(data.size, 2);
		clearPendingSwap("me", "s1", store);
		assert.deepEqual(listPendingSwaps("me", now, store), []);
	});
});

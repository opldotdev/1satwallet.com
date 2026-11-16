import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MerklePath, type WalletAction, type WalletInterface } from "@bsv/sdk";
import {
	actionAmountLabel,
	actionBlockTime,
	actionBlockTimes,
	actionDateLabel,
	actionExplorerUrl,
	actionHistoryForIdentity,
	actionReferenceLabel,
	actionStatusLabel,
	actionTimeLabel,
	isPendingAction,
	listActionHistoryPage,
	orderActionsNewestFirst,
	ordinaryActionLabels,
} from "../lib/wallet/action-history";

const action = {
	txid: "ab".repeat(32),
	satoshis: 42,
	status: "completed",
	isOutgoing: true,
	description: "Send forty-two satoshis",
	labels: ["payment", "reference 010203", "personal"],
	version: 1,
	lockTime: 0,
} satisfies WalletAction;

describe("action history", () => {
	test("formats signed wallet deltas once without scientific notation", () => {
		assert.equal(actionAmountLabel(-79), "−0.00000079 BSV");
		assert.equal(actionAmountLabel(8368156), "+0.08368156 BSV");
		assert.equal(actionAmountLabel(0), "0.00000000 BSV");
	});
	test("pages newest first by counting back from the end of storage order", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const stored = Array.from({ length: 60 }, (_, index) => ({
			...action,
			txid: index.toString(16).padStart(64, "0"),
		}));
		const wallet = {
			listActions: async (request: { limit: number; offset: number }) => {
				calls.push(request as unknown as Record<string, unknown>);
				return {
					totalActions: stored.length,
					actions: stored.slice(request.offset, request.offset + request.limit),
				};
			},
		} as unknown as Pick<WalletInterface, "listActions">;

		const first = await listActionHistoryPage(wallet, 0);
		assert.equal(first.totalActions, 60);
		assert.deepEqual(
			first.actions.map((row) => row.txid),
			stored
				.slice(35, 60)
				.reverse()
				.map((row) => row.txid),
		);
		assert.deepEqual(calls[1], {
			labels: [],
			labelQueryMode: "any",
			includeLabels: true,
			limit: 25,
			offset: 35,
		});

		const last = await listActionHistoryPage(wallet, 2);
		assert.deepEqual(
			last.actions.map((row) => row.txid),
			stored
				.slice(0, 10)
				.reverse()
				.map((row) => row.txid),
		);
		assert.deepEqual((await listActionHistoryPage(wallet, 3)).actions, []);
	});

	test("orders by block time with pending rows on top, like the iOS app", () => {
		const row = (id: string, status: WalletAction["status"]) => ({
			...action,
			txid: id,
			status,
		});
		const rows = [
			row("a", "completed"),
			row("b", "completed"),
			row("c", "unproven"),
			row("d", "completed"),
		];
		const times = new Map([
			["a", 1_000],
			["d", 5_000],
		]);
		assert.deepEqual(
			orderActionsNewestFirst(rows, times).map((entry) => entry.txid),
			["c", "d", "a", "b"],
		);
		assert.equal(isPendingAction(row("x", "sending")), true);
		assert.equal(isPendingAction(row("x", "completed")), false);
	});

	test("labels a row with its block time, or Pending before it is mined", () => {
		const options = {
			now: Date.UTC(2026, 10, 14, 18, 0),
			locale: "en-US",
			timeZone: "UTC",
		};
		const at = (month: number, day: number, year = 2026) =>
			Date.UTC(year, month, day, 11, 8);
		assert.equal(actionDateLabel(at(10, 14), options), "Today, 11:08 AM");
		assert.equal(actionDateLabel(at(10, 13), options), "Yesterday, 11:08 AM");
		assert.equal(actionDateLabel(at(10, 10), options), "Tuesday, 11:08 AM");
		assert.equal(actionDateLabel(at(2, 4), options), "Mar 4, 11:08 AM");
		assert.equal(
			actionDateLabel(at(2, 4, 2025), options),
			"Mar 4, 2025, 11:08 AM",
		);
		assert.equal(
			actionTimeLabel({ status: "unproven" }, undefined, options),
			"Pending",
		);
		assert.equal(
			actionTimeLabel({ status: "completed" }, undefined, options),
			undefined,
		);
		assert.equal(
			actionTimeLabel({ status: "completed" }, at(10, 14), options),
			"Today, 11:08 AM",
		);
	});

	test("reads block time only from a header that matches the proof", async () => {
		const txid = "11".repeat(32);
		const path = new MerklePath(800_000, [
			[
				{ offset: 0, hash: txid, txid: true },
				{ offset: 1, duplicate: true },
			],
		]);
		const root = path.computeRoot(txid);
		const services = (merkleRoot: string) => ({
			beef: { getProof: async () => Uint8Array.from(path.toBinary()) },
			chaintracks: {
				findHeaderForHeight: async (height: number) =>
					height === 800_000 ? { merkleRoot, time: 1_700_000_000 } : undefined,
			},
		});
		assert.equal(
			await actionBlockTime(services("00".repeat(32)), txid),
			undefined,
		);
		const times = await actionBlockTimes(services(root), [
			{ txid, status: "completed" },
			{ txid: "22".repeat(32), status: "failed" },
		]);
		assert.deepEqual([...times], [[txid, 1_700_000_000_000]]);
		const missing = {
			beef: {
				getProof: async () => {
					throw new Error("404");
				},
			},
			chaintracks: { findHeaderForHeight: async () => undefined },
		};
		assert.equal(await actionBlockTime(missing, "33".repeat(32)), undefined);
	});

	test("preserves empty results and wallet errors", async () => {
		const emptyWallet = {
			listActions: async () => ({ totalActions: 0, actions: [] }),
		} as Pick<WalletInterface, "listActions">;
		assert.deepEqual(await listActionHistoryPage(emptyWallet, 0), {
			totalActions: 0,
			actions: [],
		});

		const failure = new Error("Wallet history unavailable");
		const failingWallet = {
			listActions: async () => {
				throw failure;
			},
		} as Pick<WalletInterface, "listActions">;
		await assert.rejects(listActionHistoryPage(failingWallet, 0), failure);
	});

	test("returns loading state instead of stale data when identity changes", () => {
		const previous = {
			identityKey: "previous",
			actions: [action],
			totalActions: 101,
			error: "stale error",
		};
		assert.deepEqual(actionHistoryForIdentity(previous, "next"), {
			identityKey: "next",
			actions: null,
			totalActions: 0,
			error: null,
		});
		assert.equal(actionHistoryForIdentity(previous, "previous"), previous);
	});

	test("separates the valid BRC-153 reference from ordinary labels", () => {
		assert.equal(actionReferenceLabel(action), "reference 010203");
		assert.deepEqual(ordinaryActionLabels(action), ["payment", "personal"]);
		assert.equal(
			actionReferenceLabel({
				...action,
				labels: ["reference invalid"],
			}),
			undefined,
		);
		assert.deepEqual(
			ordinaryActionLabels({ ...action, labels: ["reference invalid"] }),
			[],
		);
	});

	test("only derives chain-correct explorer links for valid transaction IDs", () => {
		assert.equal(
			actionExplorerUrl(action.txid, "main"),
			`https://whatsonchain.com/tx/${action.txid}`,
		);
		assert.equal(
			actionExplorerUrl(action.txid, "test"),
			`https://test.whatsonchain.com/tx/${action.txid}`,
		);
		assert.equal(actionExplorerUrl("not-a-txid", "main"), undefined);
	});
	test("gives a row one plain status badge, and none once it is mined", () => {
		const label = (status: WalletAction["status"]) =>
			actionStatusLabel({ status });
		assert.equal(label("completed"), undefined);
		assert.equal(label("unproven"), "Unconfirmed");
		assert.equal(label("sending"), "Sending");
		assert.equal(label("unprocessed"), "Queued");
		assert.equal(label("unsigned"), "Unsigned");
		assert.equal(label("nosend"), "Not sent");
		assert.equal(label("nonfinal"), "Not final");
		assert.equal(label("failed"), "Failed");
	});
});

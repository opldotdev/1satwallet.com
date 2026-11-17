import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ScanResult } from "@1sat/actions";
import type { IndexedOutput } from "@1sat/types";
import {
	type AddressScanStatus,
	mergeScanResults,
	scanAddressList,
	scanResultOutputCount,
} from "@/lib/wallet/address-scan";

const output = (n: number): IndexedOutput => ({
	outpoint: `${n.toString(16).padStart(64, "0")}.0`,
	score: n,
	satoshis: 1000,
	events: [],
});

const empty = (): ScanResult => ({
	funding: [],
	ordinals: [],
	opnsNames: [],
	bsv21Tokens: [],
	bsv20Tokens: [],
	locked: [],
	run: [],
	listings: [],
	totalFundingSats: 0,
});

describe("per-address scan", () => {
	it("scans each address once, in order, and merges as scanAddresses does", async () => {
		const scanned: string[] = [];
		const updates: AddressScanStatus[][] = [];
		const result = await scanAddressList(
			async (address) => {
				scanned.push(address);
				const r = empty();
				r.funding = [output(scanned.length)];
				r.totalFundingSats = 1000;
				return r;
			},
			["a", "b", "a"],
			(s) => updates.push(s),
		);
		assert.deepEqual(scanned, ["a", "b"]);
		assert.equal(result.funding.length, 2);
		assert.equal(result.totalFundingSats, 2000);
		assert.deepEqual(updates.at(-1), [
			{ address: "a", state: "done", found: 1 },
			{ address: "b", state: "done", found: 1 },
		]);
		assert.deepEqual(
			updates[0].map((s) => s.state),
			["pending", "pending"],
		);
	});

	it("marks the failing address with its reason and fails the scan", async () => {
		const updates: AddressScanStatus[][] = [];
		await assert.rejects(
			scanAddressList(
				async (address) => {
					if (address === "b") throw new Error("indexer down");
					return empty();
				},
				["a", "b"],
				(s) => updates.push(s),
			),
			/indexer down/,
		);
		assert.deepEqual(updates.at(-1)?.[1], {
			address: "b",
			state: "error",
			error: "indexer down",
		});
	});

	it("does not count a listing twice", () => {
		const listed = output(1);
		const r = { ...empty(), ordinals: [listed], listings: [listed] };
		assert.equal(scanResultOutputCount(r), 1);
		assert.equal(mergeScanResults([r, r]).ordinals.length, 2);
	});
});

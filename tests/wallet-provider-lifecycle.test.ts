import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	diagnoseNoWalletResult,
	statusAfterDisconnect,
} from "@/lib/wallet-connection-status";

describe("wallet provider lifecycle", () => {
	it("distinguishes a locked wallet from transport and manual disconnects", () => {
		assert.equal(statusAfterDisconnect("unauthenticated"), "locked");
		assert.equal(statusAfterDisconnect("unavailable"), "disconnected");
		assert.equal(statusAfterDisconnect("manual"), "disconnected");
	});

	it("distinguishes missing authorization from no BRC-100 responder", async () => {
		const reachable = await diagnoseNoWalletResult(async () => undefined);
		assert.equal(reachable.status, "authorization-required");
		assert.match(reachable.message, /did not grant identity access/);

		const unavailable = await diagnoseNoWalletResult(async () => {
			throw new Error("unreachable");
		});
		assert.equal(unavailable.status, "no-wallet");
		assert.match(unavailable.message, /No BRC-100 wallet responded/);
	});
});

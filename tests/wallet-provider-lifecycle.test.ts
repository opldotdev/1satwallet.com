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
		const reachable = await diagnoseNoWalletResult(async () => ({
			state: "authorization-required",
		}));
		assert.equal(reachable.status, "authorization-required");
		assert.match(reachable.message, /did not grant identity access/);

		const unavailable = await diagnoseNoWalletResult(async () => ({
			state: "unreachable",
		}));
		assert.equal(unavailable.status, "no-wallet");
		assert.match(unavailable.message, /No BRC-100 wallet responded/);
	});

	it("reports an authenticated provider identity failure truthfully", async () => {
		const failed = await diagnoseNoWalletResult(async () => ({
			state: "provider-error",
			code: "WERR_UNKNOWN",
		}));

		assert.equal(failed.status, "provider-error");
		assert.match(failed.message, /wallet\/provider error/);
		assert.match(failed.message, /WERR_UNKNOWN/);
		assert.doesNotMatch(failed.message, /did not grant/);
	});

	it("treats a successful second identity probe as a transient provider failure", async () => {
		const transient = await diagnoseNoWalletResult(async () => ({
			state: "identity-ready",
		}));

		assert.equal(transient.status, "provider-error");
		assert.match(transient.message, /wallet\/provider error/);
	});
});

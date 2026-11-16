import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { endpointsOf, isOneColorAvailable } from "../lib/chain-endpoints";

// Values from Yours (1color) src/utils/constants.ts endpointsOf /
// colorOverlayDefaultOf / handleRegistrationUrlOf / TESTNET_FAUCET_URL and
// iOS OneSatWallet/Services/ChainEndpoints.swift.
describe("chain endpoints", () => {
	it("matches the mainnet hosts", () => {
		assert.deepEqual(endpointsOf("main"), {
			services: "https://api.1sat.app",
			storage: "https://wallet.1sat.app",
			messagebox: "https://messagebox.1sat.app",
			extraMessageboxes: ["https://messagebox.bsvblockchain.tech"],
			handleRegistration: "https://accounts.1sat.app",
		});
	});

	it("matches the testnet hosts", () => {
		assert.deepEqual(endpointsOf("test"), {
			services: "https://testnet.api.1sat.app",
			storage: "https://testnet.wallet.1sat.app",
			messagebox: "https://testnet.messagebox.1sat.app",
			extraMessageboxes: [],
			handleRegistration: "https://accounts.testnet.1sat.app/",
			colorOverlay: "https://testnet.openex.dev",
			faucet: "https://faucet.bananablocks.com",
		});
	});

	it("offers 1Color only where a color overlay runs", () => {
		assert.equal(isOneColorAvailable("main"), false);
		assert.equal(isOneColorAvailable("test"), true);
	});
});

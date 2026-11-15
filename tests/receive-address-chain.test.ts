import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PrivateKey, ProtoWallet, type WalletInterface } from "@bsv/sdk";
import {
	buildReceiveAddressManager,
	deriveReceiveAddress,
} from "../lib/receive-address-manager";
import { createDefaultReceiveAddressState } from "../lib/receive-address-state";

const rootKey = PrivateKey.fromHex("1".repeat(64));
// Derivation needs only getPublicKey, which ProtoWallet implements.
const wallet = new ProtoWallet(rootKey) as unknown as WalletInterface;
const identityKey = rootKey.toPublicKey().toString();

describe("receive addresses per chain", () => {
	it("gives one key a 1 address on main and an m/n address on test", async () => {
		const main = await deriveReceiveAddress({
			wallet,
			chain: "main",
			identityKey,
			index: 0,
		});
		const test = await deriveReceiveAddress({
			wallet,
			chain: "test",
			identityKey,
			index: 0,
		});
		assert.equal(main.publicKey, test.publicKey);
		assert.match(main.address, /^1/);
		assert.match(test.address, /^[mn]/);
		assert.notEqual(main.address, test.address);
	});

	it("builds the whole testnet window in testnet format", async () => {
		const { addressManager, depositAddress } = await buildReceiveAddressManager(
			{
				wallet,
				chain: "test",
				identityKey,
				state: createDefaultReceiveAddressState(3),
			},
		);
		assert.match(depositAddress, /^[mn]/);
		const addresses = addressManager.getAddresses();
		assert.equal(addresses.length, 3);
		for (const address of addresses) assert.match(address, /^[mn]/);
	});
});

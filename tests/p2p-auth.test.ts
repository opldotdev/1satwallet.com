import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PrivateKey, ProtoWallet, Utils, type WalletInterface } from "@bsv/sdk";
import {
	parseP2PCommand,
	signP2PCommand,
	verifyP2PCommand,
} from "../lib/p2p-auth";

describe("BRC-100 P2P command authentication", () => {
	it("creates a public BRC-77 envelope bound to the wallet identity", async () => {
		const wallet = new ProtoWallet(PrivateKey.fromRandom()) as WalletInterface;
		const signed = await signP2PCommand(wallet, "request.create", {
			requestId: crypto.randomUUID(),
			toIdentity: PrivateKey.fromRandom().toPublicKey().toString(),
		});
		const verified = verifyP2PCommand(signed, "request.create");
		const { publicKey } = await wallet.getPublicKey({ identityKey: true });
		assert.equal(verified.identityKey, publicKey);
		assert.equal(verified.action, "request.create");
		const envelope = signed.signature.split("|")[4] ?? "";
		assert.equal(
			Utils.toHex(Utils.toArray(envelope, "base64").slice(0, 4)),
			"42423301",
		);
	});

	it("rejects action substitution, body tampering, and signer substitution", async () => {
		const wallet = new ProtoWallet(PrivateKey.fromRandom()) as WalletInterface;
		const signed = await signP2PCommand(wallet, "request.cancel", {
			requestId: crypto.randomUUID(),
		});
		assert.throws(() => verifyP2PCommand(signed, "request.accept"));
		assert.throws(() =>
			verifyP2PCommand(
				{
					...signed,
					body: signed.body.replace("request.cancel", "request.accept"),
				},
				"request.accept",
			),
		);
		const command = JSON.parse(signed.body) as { identityKey: string };
		command.identityKey = PrivateKey.fromRandom().toPublicKey().toString();
		assert.throws(() =>
			verifyP2PCommand(
				{ ...signed, body: JSON.stringify(command) },
				"request.cancel",
			),
		);
	});

	it("rejects expired commands and excessive validity windows", async () => {
		const now = Date.now();
		const base = {
			v: 1,
			domain: "1satwallet.com",
			action: "request.cancel",
			identityKey: PrivateKey.fromRandom().toPublicKey().toString(),
			nonce: crypto.randomUUID(),
			payload: { requestId: crypto.randomUUID() },
		};
		assert.throws(() =>
			parseP2PCommand(
				JSON.stringify({ ...base, issuedAt: now - 10_000, expiresAt: now - 1 }),
				"request.cancel",
				now,
			),
		);
		assert.throws(() =>
			parseP2PCommand(
				JSON.stringify({ ...base, issuedAt: now, expiresAt: now + 180_000 }),
				"request.cancel",
				now,
			),
		);
	});
});

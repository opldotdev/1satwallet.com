import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PrivateKey, ProtoWallet, type WalletInterface } from "@bsv/sdk";
import { P2P_COMMAND_TTL_MS, signP2PCommand } from "../lib/p2p-auth";
import {
	authenticatePresenceAnnouncement,
	getWalletPresenceUserId,
	isActiveWalletPresence,
	parsePresenceAnnouncementPayload,
	publicPresenceIdentity,
} from "../lib/p2p-presence";

async function walletIdentity(wallet: WalletInterface) {
	return (await wallet.getPublicKey({ identityKey: true })).publicKey;
}

describe("authenticated public P2P presence", () => {
	it("accepts one short-lived announcement bound to signer, chain, and session", async () => {
		const wallet = new ProtoWallet(PrivateKey.fromRandom()) as WalletInterface;
		const identityKey = await walletIdentity(wallet);
		const sessionId = crypto.randomUUID();
		const userId = getWalletPresenceUserId(identityKey, "main", sessionId);
		const signed = await signP2PCommand(wallet, "presence.announce", {
			chain: "main",
			sessionId,
			userId,
		});
		const consumed = new Set<string>();
		const consume = async ({ nonce }: { nonce: string }) => {
			if (consumed.has(nonce)) return false;
			consumed.add(nonce);
			return true;
		};
		const announcement = await authenticatePresenceAnnouncement(
			signed,
			consume,
		);
		assert.equal(announcement.identityKey, identityKey);
		assert.equal(announcement.payload.userId, userId);
		await assert.rejects(
			authenticatePresenceAnnouncement(signed, consume),
			/was already used/,
		);
	});

	it("rejects expiry and signer, wallet-switch, or user-ID substitution", async () => {
		const firstWallet = new ProtoWallet(
			PrivateKey.fromRandom(),
		) as WalletInterface;
		const secondWallet = new ProtoWallet(
			PrivateKey.fromRandom(),
		) as WalletInterface;
		const firstIdentity = await walletIdentity(firstWallet);
		const secondIdentity = await walletIdentity(secondWallet);
		const sessionId = crypto.randomUUID();
		const secondUserId = getWalletPresenceUserId(
			secondIdentity,
			"main",
			sessionId,
		);
		const activeRecord = {
			identityKey: firstIdentity,
			chain: "main" as const,
			sessionId,
			expiresAt: Date.now() + 1_000,
		};
		assert.equal(
			isActiveWalletPresence(
				getWalletPresenceUserId(firstIdentity, "main", sessionId),
				activeRecord,
			),
			true,
		);
		assert.equal(isActiveWalletPresence(secondUserId, activeRecord), false);
		assert.equal(
			isActiveWalletPresence(
				getWalletPresenceUserId(firstIdentity, "main", crypto.randomUUID()),
				activeRecord,
			),
			false,
		);
		assert.equal(
			isActiveWalletPresence(
				getWalletPresenceUserId(firstIdentity, "main", sessionId),
				{ ...activeRecord, expiresAt: Date.now() - 1 },
			),
			false,
		);
		const walletSwitchSpoof = await signP2PCommand(
			firstWallet,
			"presence.announce",
			{ chain: "main", sessionId, userId: secondUserId },
		);
		await assert.rejects(
			authenticatePresenceAnnouncement(walletSwitchSpoof, async () => true),
			/does not match the command signer/,
		);

		const validUserId = getWalletPresenceUserId(
			firstIdentity,
			"test",
			sessionId,
		);
		assert.throws(
			() =>
				parsePresenceAnnouncementPayload(
					{ chain: "main", sessionId, userId: validUserId },
					firstIdentity,
				),
			/does not match the command signer/,
		);

		const signed = await signP2PCommand(firstWallet, "presence.announce", {
			chain: "main",
			sessionId,
			userId: getWalletPresenceUserId(firstIdentity, "main", sessionId),
		});
		const command = JSON.parse(signed.body) as { issuedAt: number };
		await assert.rejects(
			authenticatePresenceAnnouncement(
				signed,
				async () => true,
				command.issuedAt + P2P_COMMAND_TTL_MS + 1,
			),
			/expired/,
		);

		const substituted = JSON.parse(signed.body) as { identityKey: string };
		substituted.identityKey = secondIdentity;
		await assert.rejects(
			authenticatePresenceAnnouncement(
				{ ...signed, body: JSON.stringify(substituted) },
				async () => true,
			),
			/authentication|signer|signature/,
		);
	});

	it("whitelists public profile data and never promotes self-claims to a name", async () => {
		const wallet = new ProtoWallet(PrivateKey.fromRandom()) as WalletInterface;
		const identityKey = await walletIdentity(wallet);
		const sessionId = crypto.randomUUID();
		const userId = getWalletPresenceUserId(identityKey, "main", sessionId);
		const signed = await signP2PCommand(wallet, "presence.announce", {
			chain: "main",
			sessionId,
			userId,
			publicProfile: {
				displayName: "Alice",
				avatarUrl: "https://example.com/alice.png?token=private#secret",
				source: "bap",
				sourceReference: `${"a".repeat(64)}_0`,
			},
		});
		const announcement = await authenticatePresenceAnnouncement(
			signed,
			async () => true,
		);
		const publicIdentity = publicPresenceIdentity(announcement);
		assert.equal(publicIdentity.verification, "wallet-signature");
		assert.equal(publicIdentity.profile?.verification, "unverified");
		assert.equal(
			publicIdentity.profile?.avatarUrl,
			"https://example.com/alice.png",
		);
		assert.notEqual(publicIdentity.label, "Alice");
		assert.match(publicIdentity.label, /^(02|03)[0-9a-f]{4}…[0-9a-f]{4}$/);

		for (const publicProfile of [
			{ source: "bap", email: "private@example.com" },
			{ source: "profile", avatarUrl: "javascript:alert(1)" },
			{ source: "certificate", displayName: "Alice\nAdmin" },
		]) {
			assert.throws(() =>
				parsePresenceAnnouncementPayload(
					{ chain: "main", sessionId, userId, publicProfile },
					identityKey,
				),
			);
		}
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FLOOR_LEFT_KEY,
	floorCountLabel,
	floorPeers,
	landingFloorState,
	presenceChain,
	readFloorLeft,
	writeFloorLeft,
} from "../lib/p2p-floor";

const base = {
	convexConfigured: true,
	resolving: false,
	connectionStatus: "ready" as const,
	hasIdentity: true,
	hasBuiltInWallet: false,
	isBuiltInWalletLocked: false,
	left: false,
	announce: "ok" as const,
};

const keyA = `02${"a".repeat(64)}`;
const keyB = `03${"b".repeat(64)}`;
const keyC = `02${"c".repeat(64)}`;
const session = (n: number) => `${n}1111111-1111-4111-8111-111111111111`;
const uid = (chain: string, key: string, n: number) =>
	`wallet:${chain}:${key}:${session(n)}`;
const identity = (key: string) => ({
	identityKey: key,
	label: key.slice(0, 6),
});

describe("landing floor state", () => {
	it("keeps a visitor without a wallet off the floor", () => {
		for (const connectionStatus of [
			"no-wallet",
			"disconnected",
			"provider-error",
		] as const) {
			assert.deepEqual(
				landingFloorState({ ...base, connectionStatus, hasIdentity: false }),
				{ kind: "signed-out", hasBuiltInWallet: false },
			);
		}
	});

	it("asks a locked or unapproved wallet to unlock", () => {
		assert.equal(
			landingFloorState({ ...base, connectionStatus: "locked" }).kind,
			"locked",
		);
		assert.equal(
			landingFloorState({
				...base,
				connectionStatus: "authorization-required",
			}).kind,
			"locked",
		);
		assert.equal(
			landingFloorState({
				...base,
				connectionStatus: "no-wallet",
				hasBuiltInWallet: true,
				isBuiltInWalletLocked: true,
			}).kind,
			"locked",
		);
	});

	it("joins, goes live, leaves and reports a failed signature", () => {
		assert.equal(
			landingFloorState({ ...base, connectionStatus: "authenticating" }).kind,
			"joining",
		);
		assert.equal(
			landingFloorState({ ...base, announce: "pending" }).kind,
			"joining",
		);
		assert.equal(landingFloorState(base).kind, "live");
		assert.equal(landingFloorState({ ...base, left: true }).kind, "left");
		assert.deepEqual(
			landingFloorState({ ...base, announce: { error: "Declined" } }),
			{ kind: "error", message: "Declined" },
		);
	});

	it("says nothing about connecting while a wallet may still load", () => {
		assert.equal(
			landingFloorState({
				...base,
				connectionStatus: "no-wallet",
				hasIdentity: false,
				resolving: true,
			}).kind,
			"checking",
		);
	});

	it("stays left while a saved wallet reconnects", () => {
		assert.equal(
			landingFloorState({
				...base,
				connectionStatus: "authenticating",
				left: true,
			}).kind,
			"left",
		);
	});

	it("is unavailable without a relay", () => {
		assert.equal(
			landingFloorState({ ...base, convexConfigured: false }).kind,
			"unavailable",
		);
	});
});

describe("floor peers", () => {
	const self = {
		userId: uid("main", keyA, 1),
		identityKey: keyA,
		chain: "main" as const,
	};

	it("lists online, signed peers on the same network, once per wallet", () => {
		const peers = floorPeers(
			[
				{ userId: self.userId, online: true, identity: identity(keyA) },
				{
					userId: uid("main", keyA, 2),
					online: true,
					identity: identity(keyA),
				},
				{
					userId: uid("main", keyB, 3),
					online: true,
					identity: identity(keyB),
				},
				{
					userId: uid("main", keyB, 4),
					online: true,
					identity: identity(keyB),
				},
				{
					userId: uid("main", keyC, 5),
					online: false,
					identity: identity(keyC),
				},
				{
					userId: uid("test", keyC, 6),
					online: true,
					identity: identity(keyC),
				},
				{ userId: uid("main", keyC, 7), online: true, identity: null },
				{ userId: `anon:${session(8)}`, online: true },
			],
			self,
		);
		assert.deepEqual(
			peers.map((peer) => peer.userId),
			[uid("main", keyB, 3)],
		);
	});

	it("handles no list yet", () => {
		assert.deepEqual(floorPeers(undefined, self), []);
	});

	it("reads the network from a floor id", () => {
		assert.equal(presenceChain(uid("test", keyA, 1)), "test");
		assert.equal(presenceChain(`anon:${session(1)}`), null);
	});

	it("counts peers in words", () => {
		assert.equal(floorCountLabel(0), "No one else here yet");
		assert.equal(floorCountLabel(1), "1 peer here");
		assert.equal(floorCountLabel(3), "3 peers here");
	});
});

describe("leaving the floor", () => {
	it("remembers Leave for this tab and clears it on Rejoin", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => void values.set(key, value),
			removeItem: (key: string) => void values.delete(key),
		};
		assert.equal(readFloorLeft(storage), false);
		writeFloorLeft(true, storage);
		assert.equal(values.get(FLOOR_LEFT_KEY), "1");
		assert.equal(readFloorLeft(storage), true);
		writeFloorLeft(false, storage);
		assert.equal(readFloorLeft(storage), false);
	});

	it("treats unreadable storage as not left", () => {
		const broken = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		const warn = console.warn;
		console.warn = () => {};
		try {
			assert.equal(readFloorLeft(broken), false);
			writeFloorLeft(true, broken);
		} finally {
			console.warn = warn;
		}
	});
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { OneSatContext, SyncTransactionInboxResult } from "@1sat/actions";
import type { HandleResolution } from "@1sat/client";
import { HANDLE_CERT_TYPE } from "@1sat/types";
import {
	MasterCertificate,
	PrivateKey,
	ProtoWallet,
	type WalletInterface,
} from "@bsv/sdk";
import {
	createHandleInboxSync,
	formatHandle,
	type HeldHandle,
	listHandles,
} from "@/lib/wallet/handles";

const ctx = { wallet: {} } as unknown as OneSatContext;
const held = (handle: string, domain: string): HeldHandle => ({
	handle,
	domain,
	certifier: "c",
	serialNumber: handle,
});
const resolution = (messagebox: string, ttl = 60) =>
	({ messagebox, ttl }) as unknown as HandleResolution;
const empty = (): SyncTransactionInboxResult => ({ received: [], skipped: [] });

// Failures are logged; keep the test output to the assertions.
const quiet = { error: console.error, warn: console.warn };
const logged: unknown[][] = [];
beforeEach(() => {
	logged.length = 0;
	console.error = (...args: unknown[]) => {
		logged.push(args);
	};
	console.warn = (...args: unknown[]) => {
		logged.push(args);
	};
});
/** What this module logged, without the diagnostics feed's own lines. */
const handleLogs = () =>
	logged.filter((args) => String(args[0]).startsWith("[handles]"));
afterEach(() => {
	console.error = quiet.error;
	console.warn = quiet.warn;
});

describe("listHandles", () => {
	it("decrypts held handle certificates and skips one that can't be decrypted", async () => {
		const certifier = new ProtoWallet(PrivateKey.fromRandom());
		const subject = new ProtoWallet(PrivateKey.fromRandom());
		const { publicKey: certifierKey } = await certifier.getPublicKey({
			identityKey: true,
		});
		const { publicKey: subjectKey } = await subject.getPublicKey({
			identityKey: true,
		});
		const issued = await MasterCertificate.issueCertificateForSubject(
			certifier,
			subjectKey,
			{ handle: "alice", domain: "testnet.1sat.app" },
			HANDLE_CERT_TYPE,
		);
		const other = new ProtoWallet(PrivateKey.fromRandom());
		const foreign = await MasterCertificate.issueCertificateForSubject(
			certifier,
			(await other.getPublicKey({ identityKey: true })).publicKey,
			{ handle: "mallory", domain: "testnet.1sat.app" },
			HANDLE_CERT_TYPE,
		);
		let listArgs: unknown;
		const wallet = {
			listCertificates: async (args: unknown) => {
				listArgs = args;
				return {
					totalCertificates: 2,
					certificates: [
						{ ...issued, keyring: issued.masterKeyring },
						{ ...foreign, keyring: foreign.masterKeyring },
					],
				};
			},
			decrypt: subject.decrypt.bind(subject),
		} as unknown as WalletInterface;

		const handles = await listHandles(wallet);
		assert.deepEqual(listArgs, { types: [HANDLE_CERT_TYPE], certifiers: [] });
		assert.deepEqual(handles, [
			{
				handle: "alice",
				domain: "testnet.1sat.app",
				certifier: certifierKey,
				serialNumber: issued.serialNumber,
			},
		]);
		assert.equal(formatHandle(handles[0]), "@alice@testnet.1sat.app");
		assert.equal(handleLogs().length, 1);
		assert.match(String(handleLogs()[0][0]), /decrypt-certificate failed/);
	});
});

describe("createHandleInboxSync", () => {
	it("syncs once per distinct messagebox, passing the overlay resolver through", async () => {
		const boxes: Record<string, string> = {
			"@alice@testnet.1sat.app": "https://alice.testnet.1sat.app",
			"@bob@testnet.1sat.app": "https://bob.testnet.1sat.app",
			"@carol@other.example": "https://alice.testnet.1sat.app",
		};
		const calls: { messageboxUrl: string; overlayFor?: unknown }[] = [];
		const overlayFor = async (_assetId: string) => "https://testnet.openex.dev";
		const sync = createHandleInboxSync(ctx, {
			overlayFor,
			listHandles: async () => [
				held("alice", "testnet.1sat.app"),
				held("bob", "testnet.1sat.app"),
				held("carol", "other.example"),
				held("alice", "testnet.1sat.app"),
			],
			resolveHandle: async (h) => resolution(boxes[h]),
			syncInbox: async (_c, input) => {
				calls.push(input);
				return empty();
			},
		});
		assert.deepEqual(await sync(), {
			processed: 0,
			failed: 0,
			waiting: 0,
			assetIds: [],
		});
		assert.deepEqual(calls, [
			{ messageboxUrl: "https://alice.testnet.1sat.app", overlayFor },
			{ messageboxUrl: "https://bob.testnet.1sat.app", overlayFor },
		]);
		assert.equal(calls[0].overlayFor, overlayFor);
	});

	it("passes no resolver without one, and caches a resolution until its ttl", async () => {
		const calls: unknown[] = [];
		let resolves = 0;
		let clock = 1_000;
		const sync = createHandleInboxSync(ctx, {
			now: () => clock,
			listHandles: async () => [held("alice", "a.example")],
			resolveHandle: async () => {
				resolves += 1;
				return resolution("https://alice.a.example", 60);
			},
			syncInbox: async (_c, input) => {
				calls.push(input);
				return empty();
			},
		});
		await sync();
		clock += 59_999;
		await sync();
		assert.equal(resolves, 1);
		clock += 1;
		await sync();
		assert.equal(resolves, 2);
		assert.deepEqual(calls[0], { messageboxUrl: "https://alice.a.example" });
		assert.equal(calls.length, 3);
	});

	it("never caches a resolution with ttl 0", async () => {
		let resolves = 0;
		const sync = createHandleInboxSync(ctx, {
			listHandles: async () => [held("alice", "a.example")],
			resolveHandle: async () => {
				resolves += 1;
				return resolution("https://alice.a.example", 0);
			},
			syncInbox: async () => empty(),
		});
		await sync();
		await sync();
		assert.equal(resolves, 2);
	});

	it("counts a handle that doesn't resolve and still syncs the others", async () => {
		const calls: unknown[] = [];
		const sync = createHandleInboxSync(ctx, {
			listHandles: async () => [
				held("gone", "a.example"),
				held("bob", "a.example"),
			],
			resolveHandle: async (h) => {
				if (h.startsWith("@gone")) throw new Error("404");
				return resolution("https://bob.a.example", 0);
			},
			syncInbox: async (_c, input) => {
				calls.push(input);
				return empty();
			},
		});
		assert.deepEqual(await sync(), {
			processed: 0,
			failed: 1,
			waiting: 0,
			assetIds: [],
		});
		assert.deepEqual(calls, [{ messageboxUrl: "https://bob.a.example" }]);
		assert.deepEqual(
			(handleLogs()[0][1] as { handle: string }).handle,
			"@gone@a.example",
		);
	});

	it("one failing messagebox does not stop the others", async () => {
		const boxes: Record<string, string> = {
			"@a@x.example": "https://throws.example",
			"@b@x.example": "https://errors.example",
			"@c@x.example": "https://works.example",
		};
		const visited: string[] = [];
		const sync = createHandleInboxSync(ctx, {
			listHandles: async () => [
				held("a", "x.example"),
				held("b", "x.example"),
				held("c", "x.example"),
			],
			resolveHandle: async (h) => resolution(boxes[h]),
			syncInbox: async (_c, { messageboxUrl }) => {
				visited.push(messageboxUrl);
				if (messageboxUrl === "https://throws.example") {
					throw new Error("network down");
				}
				if (messageboxUrl === "https://errors.example") {
					return { received: [], skipped: [], error: "HTTP 500" };
				}
				return {
					received: [
						{
							messageId: "m1",
							txid: "aa",
							sender: "02",
							assetIds: ["aa_0", "bb_1"],
						},
						{ messageId: "m2", txid: "cc", sender: "02", assetIds: ["aa_0"] },
					],
					skipped: [],
				};
			},
		});
		assert.deepEqual(await sync(), {
			processed: 2,
			failed: 2,
			waiting: 0,
			assetIds: ["aa_0", "bb_1"],
		});
		assert.deepEqual(visited, [
			"https://throws.example",
			"https://errors.example",
			"https://works.example",
		]);
		const detail = handleLogs().map((args) => args[1]);
		assert.deepEqual(
			detail.map((d) => (d as { messageboxUrl: string }).messageboxUrl),
			["https://throws.example", "https://errors.example"],
		);
	});

	it("counts messages left in a box as waiting, never as failed, and logs each once", async () => {
		const sync = createHandleInboxSync(ctx, {
			listHandles: async () => [held("a", "main.example")],
			resolveHandle: async () => resolution("https://main.example", 0),
			syncInbox: async () => ({
				received: [],
				skipped: [
					{ messageId: "token-1", reason: "overlay-required" },
					{ messageId: "bad-1", reason: "envelope signature does not verify" },
				],
			}),
		});
		assert.deepEqual(await sync(), {
			processed: 0,
			failed: 0,
			waiting: 2,
			assetIds: [],
		});
		const logs = handleLogs();
		assert.equal(logs.length, 2);
		assert.match(String(logs[0][0]), /no 1Color overlay/);
		assert.match(String(logs[1][0]), /message failed/);
		// A message waiting in its box is logged once, not every run.
		const before = logged.length;
		assert.equal((await sync()).waiting, 2);
		assert.equal(logged.length, before);
	});

	it("counts refused acknowledgements as failed but keeps what was received", async () => {
		const sync = createHandleInboxSync(ctx, {
			overlayFor: async () => "https://testnet.openex.dev",
			listHandles: async () => [held("a", "test.example")],
			resolveHandle: async () => resolution("https://test.example", 0),
			syncInbox: async () => ({
				received: [
					{ messageId: "m", txid: "dd", sender: "02", assetIds: ["dd_0"] },
				],
				skipped: [],
				error: "acknowledge-failed: HTTP 503",
			}),
		});
		assert.deepEqual(await sync(), {
			processed: 1,
			failed: 1,
			waiting: 0,
			assetIds: ["dd_0"],
		});
	});

	it("does not overlap runs: a call during a run gets that run", async () => {
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let lists = 0;
		const sync = createHandleInboxSync(ctx, {
			listHandles: async () => {
				lists += 1;
				await blocked;
				return [];
			},
			resolveHandle: async () => resolution("https://x.example"),
			syncInbox: async () => empty(),
		});
		const first = sync();
		const second = sync();
		assert.equal(first, second);
		release();
		await first;
		await sync();
		assert.equal(lists, 2);
	});

	it("throws, with the cause, when the certificates can't be listed", async () => {
		const cause = new Error("storage unreachable");
		const sync = createHandleInboxSync(ctx, {
			listHandles: async () => {
				throw cause;
			},
		});
		await assert.rejects(sync(), (error: Error) => {
			assert.match(error.message, /handle certificates failed/);
			assert.equal(error.cause, cause);
			return true;
		});
		// The next run starts afresh.
		await assert.rejects(sync());
	});
});

describe("1Color receive view", () => {
	const view = readFileSync(
		join(process.cwd(), "components/wallet/one-color-receive.tsx"),
		"utf8",
	);

	it("says tokens arrive at a handle", () => {
		assert.match(view, /sent to a handle, not to an address/);
		assert.match(view, /<QRCodeSVG size=\{160\} value=\{handle\} \/>/);
		assert.match(view, /export function OneColorReceiveDialog/);
	});

	it("opens from the 1Color page", () => {
		const grid = readFileSync(
			join(process.cwd(), "components/wallet/one-color-grid.tsx"),
			"utf8",
		);
		assert.match(grid, /<OneColorReceiveDialog \/>/);
	});
});

describe("handle surfaces stay calm", () => {
	it("shows the Handle inbox row only to a wallet holding a handle", () => {
		const status = readFileSync(
			join(process.cwd(), "components/wallet/wallet-home-status.tsx"),
			"utf8",
		);
		assert.match(
			status,
			/const holdsHandle = \(handles\.data\?\.length \?\? 0\) > 0;/,
		);
		assert.match(status, /\.\.\.\(holdsHandle/);
	});

	it("reads handles again on focus and whenever the receive view opens", () => {
		const hook = readFileSync(
			join(process.cwd(), "hooks/use-wallet-handles.ts"),
			"utf8",
		);
		assert.match(hook, /refetchOnWindowFocus: "always"/);
		const view = readFileSync(
			join(process.cwd(), "components/wallet/one-color-receive.tsx"),
			"utf8",
		);
		assert.match(view, /useWalletHandles\(\{ refetchOnMount: "always" \}\)/);
		// One QR, for the selected handle.
		assert.equal(view.match(/<QRCodeSVG/g)?.length, 1);
		assert.match(view, /<HandleQr handle=\{selected\} \/>/);
	});
});

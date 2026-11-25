import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	DISCOVERY_DEADLINE_MS,
	type DiscoveredOption,
	discoverWallets,
	elicitLoopback,
	ProbeCancelled,
	type VersionProbe,
	versionVendor,
} from "../lib/wallet/discovery/discovery";
import {
	isLoopbackHost,
	readLoopbackPermission,
} from "../lib/wallet/discovery/loopback-permission";
import {
	canReachLocalWallet,
	detectPlatform,
} from "../lib/wallet/discovery/platform";
import { walletSlides } from "../lib/wallet/discovery/slides";

// Discovery logs a wallet that does not answer; keep it out of test output.
const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;
beforeEach(() => {
	console.info = () => undefined;
	console.warn = () => undefined;
	console.error = () => undefined;
});
afterEach(() => {
	console.info = originalInfo;
	console.warn = originalWarn;
	console.error = originalError;
});

type Call = { option: DiscoveredOption; deadline: number | null };

function fakeProbe(
	answers: Partial<Record<DiscoveredOption, string | Error>>,
	calls: Call[] = [],
): VersionProbe {
	return async (option, deadline) => {
		calls.push({ option, deadline });
		const answer = answers[option];
		if (answer === undefined || answer instanceof Error) {
			throw answer ?? new TypeError("Failed to fetch");
		}
		return answer;
	};
}

describe("loopback permission", () => {
	it("treats a page on localhost as exempt without asking", async () => {
		const read = await readLoopbackPermission({
			hostname: "localhost",
			query: async () => {
				throw new Error("should not be asked");
			},
		});
		assert.equal(read.state, "exempt");
		assert.ok(isLoopbackHost("127.0.0.1"));
		assert.ok(isLoopbackHost("app.localhost"));
		assert.ok(!isLoopbackHost("1satwallet.com"));
	});

	it("reads the loopback permission first", async () => {
		const names: string[] = [];
		const read = await readLoopbackPermission({
			hostname: "1satwallet.com",
			query: async ({ name }) => {
				names.push(name);
				return { state: "prompt" };
			},
		});
		assert.equal(read.state, "prompt");
		assert.deepEqual(names, ["loopback-network"]);
	});

	it("falls back to the older combined permission name", async () => {
		const read = await readLoopbackPermission({
			hostname: "1satwallet.com",
			query: async ({ name }) => {
				if (name === "loopback-network") throw new TypeError("unknown name");
				return { state: "denied" };
			},
		});
		assert.equal(read.state, "denied");
	});

	it("asks first when the permission cannot be read", async () => {
		const failed = await readLoopbackPermission({
			hostname: "1satwallet.com",
			query: async () => {
				throw new Error("permissions service crashed");
			},
		});
		assert.equal(failed.state, "prompt");
		const odd = await readLoopbackPermission({
			hostname: "1satwallet.com",
			query: async () => ({ state: "something-new" as PermissionState }),
		});
		assert.equal(odd.state, "prompt");
	});

	it("reports unsupported where the browser has no such permission", async () => {
		const unknown = await readLoopbackPermission({
			hostname: "1satwallet.com",
			query: async () => {
				throw new TypeError("unknown name");
			},
		});
		assert.equal(unknown.state, "unsupported");
		const none = await readLoopbackPermission({
			hostname: "1satwallet.com",
			query: null,
		});
		assert.equal(none.state, "unsupported");
	});
});

describe("platform", () => {
	it("tells phones, iPads and computers apart", () => {
		assert.equal(
			detectPlatform({
				userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
			}),
			"ios",
		);
		assert.equal(
			detectPlatform({
				userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
				maxTouchPoints: 5,
			}),
			"ios",
		);
		assert.equal(
			detectPlatform({
				userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
				maxTouchPoints: 0,
			}),
			"mac",
		);
		assert.equal(
			detectPlatform({ userAgent: "Mozilla/5.0 (Linux; Android 15)" }),
			"android",
		);
		assert.equal(
			detectPlatform({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64)" }),
			"desktop",
		);
		assert.ok(canReachLocalWallet("mac"));
		assert.ok(!canReachLocalWallet("ios"));
		assert.ok(!canReachLocalWallet("android"));
	});
});

describe("BRC-263 version vendor", () => {
	it("reads the vendor only from a well-formed version", () => {
		assert.equal(versionVendor("1sat-1.0.0"), "1sat");
		assert.equal(versionVendor("metanet-2.3.1~beta"), "metanet");
		assert.equal(versionVendor("1.0.0"), null);
		assert.equal(versionVendor("1Sat-1.0.0"), null);
		assert.equal(versionVendor(`a-1.0.${"1".repeat(30)}`), null);
	});
});

describe("discovery", () => {
	it("never touches this computer before the user is asked", async () => {
		const calls: Call[] = [];
		const snapshot = await discoverWallets({
			platform: "mac",
			permission: "prompt",
			probe: fakeProbe({ desktop: "1sat-1.0.0" }, calls),
			hasWindowWallet: false,
			inWalletApp: false,
		});
		assert.deepEqual(calls, []);
		assert.deepEqual(snapshot.candidates, []);
		assert.deepEqual(
			snapshot.coverage.find(({ adapter }) => adapter === "loopback"),
			{ adapter: "loopback", state: "blocked", cause: "permission-required" },
		);
	});

	it("reports a denied permission as blocked, not as no wallet", async () => {
		const calls: Call[] = [];
		const snapshot = await discoverWallets({
			platform: "desktop",
			permission: "denied",
			probe: fakeProbe({}, calls),
			hasWindowWallet: false,
			inWalletApp: false,
		});
		assert.deepEqual(calls, []);
		assert.deepEqual(snapshot.coverage[1], {
			adapter: "loopback",
			state: "blocked",
			cause: "permission-denied",
		});
	});

	it("does not look for a desktop wallet on a phone", async () => {
		const calls: Call[] = [];
		const snapshot = await discoverWallets({
			platform: "ios",
			permission: "unsupported",
			probe: fakeProbe({ desktop: "1sat-1.0.0" }, calls),
			hasWindowWallet: false,
			inWalletApp: false,
		});
		assert.deepEqual(calls, []);
		assert.deepEqual(snapshot.coverage[1], {
			adapter: "loopback",
			state: "unsupported",
			cause: "not-this-device",
		});
	});

	it("checks the browser wallet first, then names what it finds", async () => {
		const calls: Call[] = [];
		const snapshot = await discoverWallets({
			platform: "mac",
			permission: "granted",
			probe: fakeProbe(
				{ injected: "1sat-0.9.0", desktop: "1sat-1.0.0" },
				calls,
			),
			hasWindowWallet: true,
			inWalletApp: false,
		});
		assert.deepEqual(calls, [
			{ option: "injected", deadline: DISCOVERY_DEADLINE_MS },
			{ option: "desktop", deadline: DISCOVERY_DEADLINE_MS },
		]);
		assert.deepEqual(
			snapshot.candidates.map(({ name, vendor }) => [name, vendor]),
			[
				["1Sat Wallet extension", "1sat"],
				["1Sat Wallet for Mac", "1sat"],
			],
		);
	});

	it("says no wallet only when the browser surely let the request out", async () => {
		const granted = await discoverWallets({
			platform: "mac",
			permission: "granted",
			probe: fakeProbe({}),
			hasWindowWallet: false,
			inWalletApp: false,
		});
		assert.deepEqual(granted.coverage[1], {
			adapter: "loopback",
			state: "complete",
		});
		const unknown = await discoverWallets({
			platform: "mac",
			permission: "unsupported",
			probe: fakeProbe({}),
			hasWindowWallet: false,
			inWalletApp: false,
		});
		assert.deepEqual(unknown.coverage[1], {
			adapter: "loopback",
			state: "partial",
			cause: "no-response",
		});
	});

	it("asks with no deadline once the user said yes", async () => {
		const calls: Call[] = [];
		await discoverWallets({
			platform: "mac",
			permission: "prompt",
			elicit: true,
			probe: fakeProbe({ desktop: "1sat-1.0.0" }, calls),
			hasWindowWallet: false,
			inWalletApp: false,
		});
		assert.deepEqual(calls, [{ option: "desktop", deadline: null }]);
	});
});

describe("asking the browser", () => {
	const base = {
		platform: "mac" as const,
		hasWindowWallet: false,
		inWalletApp: false,
	};

	it("runs an ordinary scan after a grant", async () => {
		const calls: Call[] = [];
		const result = await elicitLoopback({
			...base,
			probe: fakeProbe({ desktop: "1sat-1.0.0" }, calls),
			readPermission: async () => "granted",
		});
		assert.equal(result.outcome, "found-or-rescanned");
		assert.deepEqual(calls, [
			{ option: "desktop", deadline: null },
			{ option: "desktop", deadline: DISCOVERY_DEADLINE_MS },
		]);
		assert.equal(result.snapshot.candidates[0]?.name, "1Sat Wallet for Mac");
	});

	it("keeps the answer where there is no permission to read", async () => {
		const result = await elicitLoopback({
			...base,
			probe: fakeProbe({ desktop: "1sat-1.0.0" }),
			readPermission: async () => "unsupported",
		});
		assert.equal(result.outcome, "found-or-rescanned");
		assert.equal(result.snapshot.candidates.length, 1);
	});

	it("passes a cancel through instead of reporting no wallet", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			elicitLoopback({
				...base,
				signal: controller.signal,
				readPermission: async () => "granted",
			}),
			ProbeCancelled,
		);
	});

	it("tells a block from an unanswered question by the permission", async () => {
		const denied = await elicitLoopback({
			...base,
			probe: fakeProbe({}),
			readPermission: async () => "denied",
		});
		assert.equal(denied.outcome, "denied");
		assert.deepEqual(denied.snapshot.coverage[1], {
			adapter: "loopback",
			state: "blocked",
			cause: "permission-denied",
		});
		const dismissed = await elicitLoopback({
			...base,
			probe: fakeProbe({}),
			readPermission: async () => "prompt",
		});
		assert.equal(dismissed.outcome, "dismissed");
		assert.deepEqual(dismissed.snapshot.coverage[1], {
			adapter: "loopback",
			state: "blocked",
			cause: "permission-declined",
		});
	});
});

describe("first screen", () => {
	const mac = {
		option: "desktop" as const,
		adapter: "loopback" as const,
		name: "1Sat Wallet for Mac",
		version: "1sat-1.0.0",
		vendor: "1sat",
	};

	it("leads with what the scan found", () => {
		assert.deepEqual(
			walletSlides("mac", [mac]).map(({ kind }) => kind),
			["candidate", "browser"],
		);
		assert.deepEqual(
			walletSlides("mac", []).map(({ kind }) => kind),
			["local", "browser"],
		);
	});

	it("offers the iPhone app on iOS and no desktop search", () => {
		assert.deepEqual(
			walletSlides("ios", []).map(({ kind }) => kind),
			["phone-app", "browser"],
		);
		assert.deepEqual(
			walletSlides("android", []).map(({ kind }) => kind),
			["browser"],
		);
	});

	it("leads with this browser on a computer with no 1Sat app", () => {
		assert.deepEqual(
			walletSlides("desktop", []).map(({ kind }) => kind),
			["browser", "local"],
		);
	});
});

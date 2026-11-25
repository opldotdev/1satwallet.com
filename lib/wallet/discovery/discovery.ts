/**
 * Wallet discovery, shaped after BRC-185 (Wallet Substrate Discovery and
 * Selection) and BRC-325 (browser permission for localhost discovery).
 *
 * Each adapter reports coverage (complete, partial, blocked, unsupported), so
 * the screen never calls a blocked or timed-out search "no wallet". Discovery
 * only reads getVersion: no unlock, no identity, no permission request in the
 * wallet. Every candidate here is a legacy, unverified provider in BRC-185
 * terms (no wallet serves the signed /.well-known/brc-wallet descriptor yet);
 * a descriptor adapter slots in beside these when one does.
 */
import { createConnectionClient } from "@/lib/wallet/connection-options";
import { isWalletAppBrowser } from "@/lib/wallet/host-wallet";
import {
	hasWindowWallet,
	type LoopbackPermission,
} from "./loopback-permission";
import { canReachLocalWallet, type DevicePlatform } from "./platform";

export type DiscoveredOption = "injected" | "desktop";
export type AdapterId = "window.CWI" | "loopback";
export type CoverageState = "complete" | "partial" | "blocked" | "unsupported";
export type CoverageCause =
	| "permission-required"
	| "permission-denied"
	/** The browser's question closed with no answer (BRC-325 section 6.2). */
	| "permission-declined"
	| "timeout"
	| "no-response"
	| "not-this-device";

export type WalletCandidate = {
	option: DiscoveredOption;
	adapter: AdapterId;
	name: string;
	version: string;
	/** BRC-263 vendor, when the version string follows it. Not an identity. */
	vendor: string | null;
};

export type AdapterCoverage = {
	adapter: AdapterId;
	state: CoverageState;
	cause?: CoverageCause;
};

export type DiscoverySnapshot = {
	candidates: WalletCandidate[];
	coverage: AdapterCoverage[];
	permission: LoopbackPermission;
};

/** BRC-185 section 4.1: per-request discovery deadline. */
export const DISCOVERY_DEADLINE_MS = 1000;

const BRC263 =
	/^([a-z0-9]{1,12})-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:~[A-Za-z0-9_-]+)?$/;

/** The vendor of a BRC-263 version string (`1sat-1.0.0` gives `1sat`). */
export function versionVendor(version: string): string | null {
	if (version.length < 7 || version.length > 30) return null;
	return BRC263.exec(version)?.[1] ?? null;
}

export function candidateName(
	adapter: AdapterId,
	vendor: string | null,
	platform: DevicePlatform,
	inWalletApp: boolean,
): string {
	if (adapter === "window.CWI") {
		if (inWalletApp) return "Your wallet app";
		return vendor === "1sat" ? "1Sat Wallet extension" : "Browser wallet";
	}
	if (vendor === "1sat") {
		return platform === "mac" ? "1Sat Wallet for Mac" : "1Sat Wallet desktop";
	}
	return "Desktop wallet";
}

export class ProbeTimeout extends Error {
	constructor() {
		super("The wallet did not answer in time");
		this.name = "ProbeTimeout";
	}
}

export class ProbeCancelled extends Error {
	constructor() {
		super("Wallet discovery was cancelled");
		this.name = "ProbeCancelled";
	}
}

export type VersionProbe = (
	option: DiscoveredOption,
	deadlineMs: number | null,
	signal?: AbortSignal,
) => Promise<string>;

/**
 * Reads a wallet's version over one substrate. A null deadline is the one
 * request that raises the browser's dialog (BRC-325 section 6.1): a person
 * reading it takes longer than any discovery deadline, so only cancel ends it.
 */
export const probeVersion: VersionProbe = async (
	option,
	deadlineMs,
	signal,
) => {
	if (signal?.aborted) throw new ProbeCancelled();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const client = createConnectionClient(option);
		const result = await Promise.race([
			client.getVersion({}),
			new Promise<never>((_, reject) => {
				if (deadlineMs !== null) {
					timer = setTimeout(() => reject(new ProbeTimeout()), deadlineMs);
				}
				onAbort = () => reject(new ProbeCancelled());
				signal?.addEventListener("abort", onAbort, { once: true });
			}),
		]);
		if (typeof result?.version !== "string") {
			throw new Error("The wallet's getVersion answer has no version string");
		}
		return result.version;
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
};

type DiscoverInput = {
	platform: DevicePlatform;
	permission: LoopbackPermission;
	/**
	 * True only after the user said yes on our own explanation: this request
	 * may raise the browser's dialog, so it runs with no deadline.
	 */
	elicit?: boolean;
	signal?: AbortSignal;
	probe?: VersionProbe;
	hasWindowWallet?: boolean;
	inWalletApp?: boolean;
};

type AdapterResult = {
	coverage: AdapterCoverage;
	candidate?: WalletCandidate;
};

export async function discoverWallets(
	input: DiscoverInput,
): Promise<DiscoverySnapshot> {
	const probe = input.probe ?? probeVersion;
	const inWalletApp = input.inWalletApp ?? isWalletAppBrowser();
	const windowWallet = input.hasWindowWallet ?? hasWindowWallet();

	const windowAdapter = async (): Promise<AdapterResult> => {
		if (!windowWallet) {
			return { coverage: { adapter: "window.CWI", state: "unsupported" } };
		}
		return probeAdapter("window.CWI", "injected", DISCOVERY_DEADLINE_MS);
	};

	const loopbackAdapter = async (): Promise<AdapterResult> => {
		if (!canReachLocalWallet(input.platform)) {
			return {
				coverage: {
					adapter: "loopback",
					state: "unsupported",
					cause: "not-this-device",
				},
			};
		}
		if (input.permission === "denied") {
			return {
				coverage: {
					adapter: "loopback",
					state: "blocked",
					cause: "permission-denied",
				},
			};
		}
		if (input.permission === "prompt" && !input.elicit) {
			return {
				coverage: {
					adapter: "loopback",
					state: "blocked",
					cause: "permission-required",
				},
			};
		}
		return probeAdapter(
			"loopback",
			"desktop",
			input.elicit ? null : DISCOVERY_DEADLINE_MS,
		);
	};

	const probeAdapter = async (
		adapter: AdapterId,
		option: DiscoveredOption,
		deadlineMs: number | null,
	): Promise<AdapterResult> => {
		try {
			const version = await probe(option, deadlineMs, input.signal);
			const vendor = versionVendor(version);
			return {
				coverage: { adapter, state: "complete" },
				candidate: {
					option,
					adapter,
					version,
					vendor,
					name: candidateName(adapter, vendor, input.platform, inWalletApp),
				},
			};
		} catch (error) {
			if (error instanceof ProbeCancelled) throw error;
			if (error instanceof ProbeTimeout) {
				return { coverage: { adapter, state: "partial", cause: "timeout" } };
			}
			// Nothing listening and a browser block look the same from here.
			// With the permission granted (or this page on localhost) the browser
			// let the request out, so no answer means no wallet is running.
			const certain =
				adapter === "window.CWI" ||
				input.permission === "granted" ||
				input.permission === "exempt" ||
				input.elicit === true;
			console.info(
				`[wallet-discovery] no ${adapter} wallet answered`,
				error instanceof Error ? error.message : String(error),
			);
			return certain
				? { coverage: { adapter, state: "complete" } }
				: { coverage: { adapter, state: "partial", cause: "no-response" } };
		}
	};

	// BRC-325 section 4.1: adapters that cannot raise the browser dialog run
	// first; localhost runs after them.
	const windowResult = await windowAdapter();
	const loopbackResult = await loopbackAdapter();
	const results = [windowResult, loopbackResult];
	return {
		candidates: results.flatMap(({ candidate }) =>
			candidate ? [candidate] : [],
		),
		coverage: results.map(({ coverage }) => coverage),
		permission: input.permission,
	};
}

export function coverageFor(
	snapshot: DiscoverySnapshot | null,
	adapter: AdapterId,
): AdapterCoverage | undefined {
	return snapshot?.coverage.find((entry) => entry.adapter === adapter);
}

export type ElicitOutcome = "found-or-rescanned" | "denied" | "dismissed";

/**
 * The one request that may raise the browser's question, then the outcome read
 * from the permission itself (BRC-325 section 6.2): a refusal and an
 * unanswered question fail the request the same way, so only the state after
 * it tells them apart. A grant runs an ordinary discovery round.
 */
export async function elicitLoopback(input: {
	platform: DevicePlatform;
	signal?: AbortSignal;
	probe?: VersionProbe;
	readPermission: () => Promise<LoopbackPermission>;
	hasWindowWallet?: boolean;
	inWalletApp?: boolean;
}): Promise<{ snapshot: DiscoverySnapshot; outcome: ElicitOutcome }> {
	const base = {
		platform: input.platform,
		signal: input.signal,
		probe: input.probe,
		hasWindowWallet: input.hasWindowWallet,
		inWalletApp: input.inWalletApp,
	};
	const elicited = await discoverWallets({
		...base,
		permission: "prompt",
		elicit: true,
	});
	const after = await input.readPermission();
	if (after === "granted") {
		const snapshot = await discoverWallets({ ...base, permission: after });
		return { snapshot, outcome: "found-or-rescanned" };
	}
	if (after === "denied" || after === "prompt") {
		const cause: CoverageCause =
			after === "denied" ? "permission-denied" : "permission-declined";
		return {
			snapshot: {
				permission: after,
				candidates: elicited.candidates.filter(
					({ adapter }) => adapter !== "loopback",
				),
				coverage: elicited.coverage.map((entry) =>
					entry.adapter === "loopback"
						? { adapter: "loopback", state: "blocked", cause }
						: entry,
				),
			},
			outcome: after === "denied" ? "denied" : "dismissed",
		};
	}
	// No permission to read (another browser, or this page on localhost): the
	// request itself is the answer.
	return {
		snapshot: { ...elicited, permission: after },
		outcome: "found-or-rescanned",
	};
}

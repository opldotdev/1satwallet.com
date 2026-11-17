import { tokenOutputCount } from "@/lib/wallet/migration-listings";

/** Sweepable outputs found at legacy addresses. */
export interface SweepableLegacyAssets {
	funding: readonly unknown[];
	ordinals: readonly unknown[];
	opnsNames: readonly unknown[];
	bsv21Tokens: readonly { outputs: readonly unknown[] }[];
	bsv20Balances: readonly { outputs: readonly unknown[] }[];
}

/**
 * One count for the sidebar banner and the migration page, so the page can
 * never say nothing remains while the banner says items need sweeping.
 */
export function countSweepableLegacyAssets(a: SweepableLegacyAssets): number {
	return (
		a.funding.length +
		a.ordinals.length +
		a.opnsNames.length +
		tokenOutputCount(a.bsv21Tokens) +
		tokenOutputCount(a.bsv20Balances)
	);
}

/** Stable key for the set of addresses a scan result belongs to. */
export function legacyAddressKey(
	addresses: readonly (string | null | undefined)[],
): string | null {
	const unique = [...new Set(addresses.filter((a): a is string => !!a))].sort();
	return unique.length > 0 ? unique.join(",") : null;
}

export type ScanPhaseDecision =
	| "wait"
	| "preview"
	| "nothing-to-sweep"
	| "missing-keys";

/**
 * What the migration page shows once its scan settles.
 *
 * Being migrated never decides it: only a finished scan of the current legacy
 * addresses that found no sweepable output and no listing does. Until that
 * scan has finished (or while it is still running) the answer is "wait".
 */
export function decideScanPhase(input: {
	/** Legacy keys are available to sweep with */
	hasLegacyKeys: boolean;
	/** Wallet already uses the identity root */
	migrated: boolean;
	/** A scan of the current legacy addresses has finished */
	scanned: boolean;
	loading: boolean;
	balanceLoading: boolean;
	sweepable: number;
	listings: number;
}): ScanPhaseDecision {
	if (!input.hasLegacyKeys) {
		if (!input.migrated) return "missing-keys";
		return input.listings > 0 ? "preview" : "nothing-to-sweep";
	}
	if (!input.scanned || input.loading || input.balanceLoading) return "wait";
	if (input.sweepable > 0 || input.listings > 0) return "preview";
	return "nothing-to-sweep";
}

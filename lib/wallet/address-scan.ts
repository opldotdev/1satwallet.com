import type { ScanProgress, ScanResult } from "@1sat/actions";

export type AddressScanState = "pending" | "scanning" | "done" | "error";

/** Where one scanned address stands, for a per-address status list. */
export interface AddressScanStatus {
	address: string;
	state: AddressScanState;
	/** Outputs found at this address once its scan is done */
	found?: number;
	/** Why this address's scan failed */
	error?: string;
}

type ScanOne = (
	address: string,
	onProgress?: (p: ScanProgress) => void,
) => Promise<ScanResult>;

/**
 * Outputs a scan result holds across every class. Listings are not added on
 * top: each one is also in the class it belongs to.
 */
export function scanResultOutputCount(result: ScanResult): number {
	return (
		result.funding.length +
		result.ordinals.length +
		result.opnsNames.length +
		result.bsv21Tokens.reduce((sum, t) => sum + t.outputs.length, 0) +
		result.bsv20Tokens.length +
		result.locked.length +
		result.run.length
	);
}

/** Merged the way @1sat/actions scanAddresses merges its per-address results. */
export function mergeScanResults(results: readonly ScanResult[]): ScanResult {
	return {
		funding: results.flatMap((r) => r.funding),
		ordinals: results.flatMap((r) => r.ordinals),
		opnsNames: results.flatMap((r) => r.opnsNames),
		bsv21Tokens: results.flatMap((r) => r.bsv21Tokens),
		bsv20Tokens: results.flatMap((r) => r.bsv20Tokens),
		locked: results.flatMap((r) => r.locked),
		run: results.flatMap((r) => r.run),
		listings: results.flatMap((r) => r.listings),
		totalFundingSats: results.reduce((sum, r) => sum + r.totalFundingSats, 0),
	};
}

/**
 * scanAddresses, one address at a time, reporting each address's state. The
 * same per-address scan and merge; the first failure still fails the scan,
 * after its address is marked with the reason.
 */
export async function scanAddressList(
	scanOne: ScanOne,
	addresses: readonly string[],
	onStatus: (status: AddressScanStatus[]) => void,
	onProgress?: (p: ScanProgress) => void,
): Promise<ScanResult> {
	const unique = [...new Set(addresses)];
	const status: AddressScanStatus[] = unique.map((address) => ({
		address,
		state: "pending",
	}));
	const emit = () => onStatus(status.map((s) => ({ ...s })));
	emit();
	const results: ScanResult[] = [];
	for (const [index, address] of unique.entries()) {
		status[index] = { address, state: "scanning" };
		emit();
		onProgress?.({
			phase: "sync",
			detail: `Scanning ${address.slice(0, 8)}...`,
		});
		try {
			const result = await scanOne(address, onProgress);
			results.push(result);
			status[index] = {
				address,
				state: "done",
				found: scanResultOutputCount(result),
			};
			emit();
		} catch (error) {
			status[index] = {
				address,
				state: "error",
				error: error instanceof Error ? error.message : String(error),
			};
			emit();
			throw error;
		}
	}
	return mergeScanResults(results);
}

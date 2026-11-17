/**
 * Wallet path state for importing by recovery phrase. Pure, so the rules
 * that decide which derivation paths an import uses can be tested without a
 * browser.
 */

export interface WalletPaths {
	changeAddressPath: string;
	ordAddressPath: string;
	identityAddressPath?: string;
}

/**
 * One automatic path search: its run number and the words it searched.
 * Each new search, Start over and switching custom paths on take the next
 * run number, so a search still in flight can tell it was superseded.
 */
export interface PathSearchRun {
	id: number;
	phrase: string;
}

/** The grid as it is when a search returns. */
export interface PathSearchNow {
	latestRunId: number;
	phrase: string;
	useCustomPaths: boolean;
}

/**
 * The run number after `latestRunId`. Start over and switching custom
 * paths on take it to drop the search in flight: its finish then neither
 * clears the spinner nor applies its result.
 */
export function supersedeSearch(latestRunId: number): number {
	return latestRunId + 1;
}

/** A new search for `phrase`, superseding every earlier run. */
export function nextSearchRun(
	latestRunId: number,
	phrase: string,
): PathSearchRun {
	return { id: supersedeSearch(latestRunId), phrase };
}

/**
 * Whether a returning search may clear `processing`. Only the latest run
 * may: once Start over or custom paths dropped it, `processing` belongs to
 * whatever came after, and clearing it would let the search start twice.
 * Words edited mid-search don't supersede the run, so it still clears the
 * spinner when it returns, and the search then runs for the new words.
 */
export function searchOwnsProcessing(
	run: PathSearchRun,
	now: Pick<PathSearchNow, "latestRunId">,
): boolean {
	return run.id === now.latestRunId;
}

/**
 * Whether a finished search's result applies: it is the latest run, the
 * words are still the ones it searched and custom paths are off.
 */
export function detectionResultApplies(
	run: PathSearchRun,
	now: PathSearchNow,
): boolean {
	return (
		searchOwnsProcessing(run, now) &&
		!now.useCustomPaths &&
		now.phrase === run.phrase
	);
}

/** Next imports only with a valid phrase and both paths filled in. */
export function canSubmitPaths({
	isValid,
	processing,
	paths,
}: {
	isValid: boolean;
	processing: boolean;
	paths: WalletPaths | undefined;
}): boolean {
	return (
		isValid &&
		!processing &&
		paths !== undefined &&
		paths.changeAddressPath.trim() !== "" &&
		paths.ordAddressPath.trim() !== ""
	);
}

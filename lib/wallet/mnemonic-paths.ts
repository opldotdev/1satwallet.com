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
 * Whether a finished path search still applies. It ran for `searchedPhrase`;
 * by the time it returns the person may have changed the words, cleared
 * them or switched to custom paths, and then its result must be dropped.
 */
export function detectionResultApplies(
	searchedPhrase: string,
	now: { phrase: string; useCustomPaths: boolean },
): boolean {
	return !now.useCustomPaths && now.phrase === searchedPhrase;
}

/**
 * The paths after the custom-paths switch flips. Either way it starts
 * empty: found paths belong to the words they were found for, and would
 * otherwise stay put if the words then changed in custom mode; turning
 * custom off drops whatever was picked or typed, so the automatic search
 * runs again for these words.
 */
export function pathsAfterCustomToggle(
	_turningOn: boolean,
	_paths: WalletPaths | undefined,
): WalletPaths | undefined {
	return undefined;
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

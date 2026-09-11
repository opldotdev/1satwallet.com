/** OPL-4693 / OPL-4694 — OrdLock listing create is off. Buy/cancel stay on. */
export const ORDLOCK_LISTING_DISABLED = true;
export const ORDLOCK_BUY_ENABLED = true;
export const ORDLOCK_CANCEL_ENABLED = true;

/**
 * This host is the live omega/wallet web surface.
 * Cancel-on-load / BSV sweep is a follow-up (OPL-4696), not this change.
 */
export const ORDLOCK_WALLET_RUNTIME = true;

export const LISTING_CREATE_OFF_MESSAGE =
	"OrdLock listing create is disabled pending a replacement contract. Existing listings can still be bought or cancelled.";

export function listingCreateDisabledBody() {
	return {
		error: LISTING_CREATE_OFF_MESSAGE,
		create: false,
		buy: ORDLOCK_BUY_ENABLED,
		cancel: ORDLOCK_CANCEL_ENABLED,
		ticket: "OPL-4693",
	};
}

export function assertListingCreateAllowed(): void {
	if (ORDLOCK_LISTING_DISABLED) {
		throw new Error(LISTING_CREATE_OFF_MESSAGE);
	}
}

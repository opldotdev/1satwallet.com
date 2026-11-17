import { type Chain, isOneColorAvailable } from "@/lib/chain-endpoints";

/** The fungible token standards the Create token sheet can deploy. */
export type TokenStandard = "bsv21" | "1color";

export const TOKEN_STANDARD_LABEL: Record<TokenStandard, string> = {
	bsv21: "BSV-21",
	"1color": "1Color",
};

/** One line under the picker on how the standard differs for its holder. */
export const TOKEN_STANDARD_HINT: Record<TokenStandard, string> = {
	bsv21: "Sent to an address or identity key.",
	"1color": "Testnet only. Sent to a handle; the icon is stored in the token.",
};

/**
 * The standards `chain` can deploy, BSV-21 first. 1Color needs a color
 * overlay (testnet today), so mainnet offers BSV-21 alone and the sheet shows
 * no picker.
 */
export function tokenStandardsFor(chain: Chain): readonly TokenStandard[] {
	return isOneColorAvailable(chain) ? ["bsv21", "1color"] : ["bsv21"];
}

/** The standard to show: the one picked, unless `chain` cannot deploy it. */
export function activeTokenStandard(
	chain: Chain,
	picked: TokenStandard,
): TokenStandard {
	return tokenStandardsFor(chain).includes(picked) ? picked : "bsv21";
}

/**
 * The fields both standards share, as typed, in the sheet's order. The sheet
 * owns them, so switching the standard keeps what was typed.
 */
export interface TokenDraft {
	symbol: string;
	decimals: string;
	supply: "fixed" | "mintable";
	/** The whole supply, used when `supply` is "fixed". */
	amount: string;
}

export const EMPTY_TOKEN_DRAFT: TokenDraft = {
	symbol: "",
	decimals: "0",
	supply: "fixed",
	amount: "",
};

/** The decimals field as a whole number, or NaN when it is not one. */
export function parseDraftDecimals(text: string): number {
	const trimmed = text.trim();
	return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
}

/** Where a token's own wallet page is, by standard. */
export function tokenDetailHref(standard: TokenStandard, id: string): string {
	return standard === "bsv21" ? `/wallet/bsv21/${id}` : `/wallet/1color/${id}`;
}

/** A token the sheet just created, for the Tokens section to announce. */
export interface CreatedToken {
	standard: TokenStandard;
	/** Its id, when the wallet returned one. */
	id: string | null;
	/** What happened and what comes next, in one or two sentences. */
	message: string;
}

/** What the sheet hands each standard's form body. */
export interface CreateTokenFormProps {
	draft: TokenDraft;
	onDraftChange: (draft: TokenDraft) => void;
	/** The form is signing (busy) or showing its review: the picker waits. */
	onStatusChange: (status: { busy: boolean; reviewing: boolean }) => void;
	onCreated: (created: CreatedToken) => void;
	onCancel: () => void;
}

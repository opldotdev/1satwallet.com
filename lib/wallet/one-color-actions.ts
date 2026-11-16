/**
 * 1Color (BRC-162) writes. Every call runs on `colorContext` (the permissions
 * manager bound to the admin originator), never on the raw wallet: only the
 * manager hands `p color` labels to the color module.
 *
 * Deploy follows `@1sat/actions` `deploy1Color`: amount > 0 is a fixed supply,
 * amount 0 an authority deploy, and the asset id is `<txid>_0`. Limits follow
 * the iOS app's `TokenCreation` (symbol, icon cap) and `@1sat/templates`
 * (decimals 0-18, amounts up to 2^64-1).
 */
import {
	type Deploy1ColorInput,
	type Deploy1ColorResponse,
	deploy1Color,
	type OneSatContext,
} from "@1sat/actions";
import { ONE_COLOR_MAX_AMOUNT } from "@1sat/templates";
import {
	formatBsv21Amount,
	parseBsv21Amount,
} from "@/lib/wallet/bsv21-actions";

export { ONE_COLOR_MAX_AMOUNT };

/** `dec` is 0-18 in `@1sat/templates`. */
export const ONE_COLOR_MAX_DECIMALS = 18;
/** UTF-16 code units, as the iOS app and `BSV21.deployMint` count them. */
export const ONE_COLOR_MAX_SYMBOL_LENGTH = 32;
/** The icon is bytes inside the deploy output; iOS caps it at 100 KB. */
export const ONE_COLOR_MAX_ICON_BYTES = 100_000;

export interface OneColorActionSet {
	deploy: typeof deploy1Color.execute;
}

export const canonicalOneColorActions: OneColorActionSet = {
	deploy: deploy1Color.execute,
};

/** A positive amount in display units as atomic units, or null. */
export function parseOneColorAmount(
	value: string,
	decimals: number,
): bigint | null {
	const atomic = parseBsv21Amount(value, decimals);
	return atomic !== null && atomic <= ONE_COLOR_MAX_AMOUNT ? atomic : null;
}

export const formatOneColorAmount = formatBsv21Amount;

export interface OneColorIcon {
	mediaType: string;
	bytes: Uint8Array | number[];
}

export interface OneColorDeployInput {
	/** Atomic supply: > 0 fixed, 0 an authority deploy. */
	amount: bigint;
	decimals: number;
	symbol?: string;
	icon?: OneColorIcon;
}

export type OneColorDeployInputError =
	| "amount-out-of-range"
	| "decimals-out-of-range"
	| "symbol-invalid"
	| "icon-not-image"
	| "icon-too-large";

/**
 * Characters a symbol or icon media type refuses (iOS `isRefusedScalar`):
 * C0 and C1 controls and DEL, zero-width characters, bidi embeddings,
 * overrides and isolates.
 */
function isRefusedCodePoint(code: number): boolean {
	return (
		code <= 0x1f ||
		(code >= 0x7f && code <= 0x9f) ||
		(code >= 0x200b && code <= 0x200d) ||
		code === 0x2060 ||
		code === 0xfeff ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2066 && code <= 0x2069)
	);
}

function hasRefusedCharacters(text: string): boolean {
	for (const char of text) {
		if (isRefusedCodePoint(char.codePointAt(0) ?? 0)) return true;
	}
	return false;
}

/** Why a deploy cannot be sent, checked before the wallet is asked. */
export function oneColorDeployInputError(
	input: OneColorDeployInput,
): OneColorDeployInputError | null {
	if (input.amount < 0n || input.amount > ONE_COLOR_MAX_AMOUNT) {
		return "amount-out-of-range";
	}
	if (
		!Number.isInteger(input.decimals) ||
		input.decimals < 0 ||
		input.decimals > ONE_COLOR_MAX_DECIMALS
	) {
		return "decimals-out-of-range";
	}
	if (
		input.symbol !== undefined &&
		(input.symbol.length === 0 ||
			input.symbol.length > ONE_COLOR_MAX_SYMBOL_LENGTH ||
			hasRefusedCharacters(input.symbol))
	) {
		return "symbol-invalid";
	}
	if (input.icon) {
		const mediaType = input.icon.mediaType.toLowerCase();
		if (
			!mediaType.startsWith("image/") ||
			hasRefusedCharacters(mediaType) ||
			input.icon.bytes.length === 0
		) {
			return "icon-not-image";
		}
		if (input.icon.bytes.length > ONE_COLOR_MAX_ICON_BYTES) {
			return "icon-too-large";
		}
	}
	return null;
}

/**
 * Deploys a 1Color token through `colorContext`. Input errors and a result
 * with no transaction come back as `error`, as the SDK action reports its own.
 */
export async function executeOneColorDeploy(
	ctx: OneSatContext,
	input: OneColorDeployInput,
	actions: OneColorActionSet = canonicalOneColorActions,
): Promise<Deploy1ColorResponse> {
	const invalid = oneColorDeployInputError(input);
	if (invalid) return { error: invalid };
	const request: Deploy1ColorInput = {
		amount: input.amount.toString(),
		decimals: input.decimals,
	};
	if (input.symbol !== undefined) request.symbol = input.symbol;
	if (input.icon) {
		request.icon = {
			mediaType: input.icon.mediaType,
			bytes: Array.from(input.icon.bytes),
		};
	}
	const result = await actions.deploy(ctx, request);
	if (result.error) return result;
	if (!result.txid || !result.assetId) return { error: "no-transaction" };
	return result;
}

const DEPLOY_INPUT_MESSAGES: Record<OneColorDeployInputError, string> = {
	"amount-out-of-range": "The supply must be at most 2^64-1 atomic units.",
	"decimals-out-of-range": "Decimals must be a whole number from 0 through 18.",
	"symbol-invalid": `Use a symbol of at most ${ONE_COLOR_MAX_SYMBOL_LENGTH} characters, with no control or invisible characters.`,
	"icon-not-image": "The icon must be an image file.",
	"icon-too-large": `The icon must be at most ${ONE_COLOR_MAX_ICON_BYTES / 1_000} KB.`,
};

/** A short message for a failed deploy; the full error goes to the log. */
export function oneColorDeployFailureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const known = DEPLOY_INPUT_MESSAGES[message as OneColorDeployInputError];
	if (known) return known;
	const normalized = message.toLowerCase();
	if (normalized === "no-transaction") {
		return "The wallet returned no transaction. Check your 1Color tokens before trying again.";
	}
	if (normalized.includes("dec must be")) {
		return DEPLOY_INPUT_MESSAGES["decimals-out-of-range"];
	}
	if (normalized.includes("amount must be")) {
		return DEPLOY_INPUT_MESSAGES["amount-out-of-range"];
	}
	if (
		normalized.includes("denied") ||
		normalized.includes("declined") ||
		normalized.includes("reject") ||
		normalized.includes("cancel")
	) {
		return "The wallet declined the deploy. Nothing was sent.";
	}
	if (
		normalized.includes("insufficient") ||
		normalized.includes("not enough")
	) {
		return "Not enough BSV to pay for the deploy. Add funds and try again.";
	}
	if (normalized.includes("overlay")) {
		return "The 1Color overlay did not accept the deploy. It may still have been sent; check your 1Color tokens before trying again.";
	}
	return "The 1Color deploy failed. Check your 1Color tokens before trying again.";
}

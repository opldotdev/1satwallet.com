/**
 * 1Color (BRC-162) writes. Every call runs on `colorContext` (the permissions
 * manager bound to the admin originator), never on the raw wallet: only the
 * manager hands `p color` labels to the color module.
 *
 * Deploy follows `@1sat/actions` `deploy1Color`: amount > 0 is a fixed supply,
 * amount 0 an authority deploy, and the asset id is `<txid>_0`. Limits follow
 * the iOS app's `TokenCreation` (symbol, icon cap) and `@1sat/templates`
 * (decimals 0-18, amounts up to 2^64-1).
 *
 * Send follows `send1Color`: a `noSend` BRC-177 handoff to a BRC-169 handle,
 * delivered to the handle's messagebox and submitted by the recipient. Until
 * then it waits in the wallet as a `nosend` action labelled `1color send …`,
 * which Cancel aborts by txid (iOS `OneColorSendService.cancel`).
 */
import {
	COLOR_SEND_LABEL_PREFIX,
	type Deploy1ColorInput,
	type Deploy1ColorResponse,
	deploy1Color,
	type OneSatContext,
	type Send1ColorInput,
	type Send1ColorResult,
	send1Color,
} from "@1sat/actions";
import { ONE_COLOR_MAX_AMOUNT } from "@1sat/templates";
import { ColorPlan } from "@bsv/color-permission-module";
import type { WalletAction, WalletInterface } from "@bsv/sdk";
import {
	formatBsv21Amount,
	parseBsv21Amount,
} from "@/lib/wallet/bsv21-actions";
import { actionsNewestFirst } from "@/lib/wallet/one-color";

export { ONE_COLOR_MAX_AMOUNT };

/** `dec` is 0-18 in `@1sat/templates`. */
export const ONE_COLOR_MAX_DECIMALS = 18;
/** UTF-16 code units, as the iOS app and `BSV21.deployMint` count them. */
export const ONE_COLOR_MAX_SYMBOL_LENGTH = 32;
/** The icon is bytes inside the deploy output; iOS caps it at 100 KB. */
export const ONE_COLOR_MAX_ICON_BYTES = 100_000;

export interface OneColorActionSet {
	deploy: typeof deploy1Color.execute;
	send: typeof send1Color.execute;
}

export const canonicalOneColorActions: OneColorActionSet = {
	deploy: deploy1Color.execute,
	send: send1Color.execute,
};

/** Full detail of a failure, for the log; never shown to the user. */
export type OneColorLog = (
	operation: string,
	error: unknown,
	details?: { txid?: string },
) => void;

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
	actions: Pick<OneColorActionSet, "deploy"> = canonicalOneColorActions,
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

/** Why a fixed supply did not parse, in the user's own units. */
export function oneColorSupplyError(value: string, decimals: number): string {
	if (
		!Number.isInteger(decimals) ||
		decimals < 0 ||
		decimals > ONE_COLOR_MAX_DECIMALS
	) {
		return DEPLOY_INPUT_MESSAGES["decimals-out-of-range"];
	}
	const atomic = parseBsv21Amount(value, decimals);
	if (atomic !== null && atomic > ONE_COLOR_MAX_AMOUNT) {
		return `The supply can be at most ${formatOneColorAmount(ONE_COLOR_MAX_AMOUNT, decimals)} with ${decimals} decimals.`;
	}
	return `Enter a positive fixed supply with at most ${decimals} decimals.`;
}

export interface OneColorDeployFailure {
	/** Short and specific; the full error goes to the log. */
	message: string;
	/**
	 * False only when the deploy is known to have stopped before signing. Any
	 * later failure (the module files and submits after the wallet signs and
	 * broadcasts) may have left a deploy on chain.
	 */
	mayHaveBeenSent: boolean;
}

const CONSENT_DECLINED =
	/\[ColorConsentDeclinedError\]|BRC-207: the user declined/;

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** The color module's own consent refusal, the one failure known to send nothing. */
function isConsentDeclined(error: unknown): boolean {
	return (
		(error instanceof Error && error.name === "ColorConsentDeclinedError") ||
		CONSENT_DECLINED.test(errorText(error))
	);
}

/** The toolbox refuses to fund the action before anything is signed. */
const INSUFFICIENT_FUNDS = /WERR_INSUFFICIENT_FUNDS|insufficient funds/i;

/** Classifies a failed deploy for the user. */
export function describeOneColorDeployFailure(
	error: unknown,
): OneColorDeployFailure {
	const message = errorText(error);
	const known = DEPLOY_INPUT_MESSAGES[message as OneColorDeployInputError];
	if (known) return { message: known, mayHaveBeenSent: false };
	// `@1sat/templates` checks these while building the script, before createAction.
	if (message.startsWith("dec must be")) {
		return {
			message: DEPLOY_INPUT_MESSAGES["decimals-out-of-range"],
			mayHaveBeenSent: false,
		};
	}
	if (message.startsWith("amount must be")) {
		return {
			message: DEPLOY_INPUT_MESSAGES["amount-out-of-range"],
			mayHaveBeenSent: false,
		};
	}
	if (isConsentDeclined(error)) {
		return {
			message: "The wallet declined the deploy. Nothing was sent.",
			mayHaveBeenSent: false,
		};
	}
	if (INSUFFICIENT_FUNDS.test(message)) {
		return {
			message: "Not enough BSV to pay for the deploy. Add funds and try again.",
			mayHaveBeenSent: false,
		};
	}
	return {
		message:
			"The token may have been deployed; the overlay will be retried. Check your 1Color tokens before deploying again.",
		mayHaveBeenSent: true,
	};
}

/** A short message for a failed deploy; the full error goes to the log. */
export function oneColorDeployFailureMessage(error: unknown): string {
	return describeOneColorDeployFailure(error).message;
}

export type OneColorDeployOutcome =
	| { ok: true; assetId: string }
	| ({ ok: false } & OneColorDeployFailure);

/**
 * Deploys, then re-reads holdings whether or not it worked: a failure after
 * signing can still leave a deploy on chain. Every failure, including a
 * failed re-read, goes to `log` in full.
 */
export async function runOneColorDeploy(
	ctx: OneSatContext,
	input: OneColorDeployInput,
	options: {
		refresh: () => Promise<void>;
		log: OneColorLog;
		actions?: Pick<OneColorActionSet, "deploy">;
	},
): Promise<OneColorDeployOutcome> {
	const refresh = async () => {
		try {
			await options.refresh();
		} catch (error) {
			options.log("holdings-refresh", error);
		}
	};
	try {
		const result = await executeOneColorDeploy(ctx, input, options.actions);
		if (result.error || !result.assetId) {
			throw new Error(result.error ?? "no-transaction");
		}
		await refresh();
		return { ok: true, assetId: result.assetId };
	} catch (error) {
		options.log(
			input.amount === 0n ? "deploy-authority" : "deploy-fixed",
			error,
		);
		await refresh();
		return { ok: false, ...describeOneColorDeployFailure(error) };
	}
}

// Send

/** Yours `normalizeHandle`: `@name@domain` from what was typed, or null. */
export function normalizeHandle(input: string): string | null {
	const match = /^@?([^@\s]+)@([^@\s]+)$/.exec(input.trim());
	return match ? `@${match[1]}@${match[2]}` : null;
}

export const ONE_COLOR_HANDLE_PROMPT = "Enter a handle like @name@domain.";

/** Why an amount typed for a send cannot be sent (Yours' messages), or null. */
export function oneColorSendAmountError(
	value: string,
	decimals: number,
	available: bigint,
): string | null {
	const atomic = parseOneColorAmount(value, decimals);
	if (atomic === null) return "Enter a valid amount.";
	if (atomic > available) return "Amount exceeds available balance.";
	return null;
}

export interface OneColorSendInput {
	assetId: string;
	/** Atomic units. */
	amount: bigint;
	/** As typed; normalized to `@name@domain`. */
	handle: string;
	memo?: string;
}

export type OneColorSendInputError = "handle-invalid" | "amount-out-of-range";

/**
 * Sends through `colorContext`. Input errors and a result with no
 * transaction come back as `error`, as the SDK action reports its own; a
 * failed delivery keeps its `txid`.
 */
export async function executeOneColorSend(
	ctx: OneSatContext,
	input: OneColorSendInput,
	actions: Pick<OneColorActionSet, "send"> = canonicalOneColorActions,
): Promise<Send1ColorResult> {
	const handle = normalizeHandle(input.handle);
	if (!handle) return { error: "handle-invalid" };
	if (input.amount <= 0n) return { error: "amount-must-be-positive" };
	if (input.amount > ONE_COLOR_MAX_AMOUNT) {
		return { error: "amount-out-of-range" };
	}
	const request: Send1ColorInput = {
		assetId: input.assetId,
		amount: input.amount.toString(),
		destination: { handle },
	};
	const memo = input.memo?.trim();
	if (memo) request.memo = memo;
	const result = await actions.send(ctx, request);
	if (result.error) return result;
	if (!result.txid) return { error: "no-transaction" };
	return result;
}

export const DELIVERY_FAILED_PREFIX = "delivery-failed:";

export interface OneColorSendFailure {
	/** Short and specific; the full error goes to the log. */
	message: string;
	/**
	 * False only when the send is known to have stopped before the wallet
	 * built it. Otherwise a `nosend` handoff may exist and is listed under
	 * Waiting to be claimed.
	 */
	mayHaveBeenBuilt: boolean;
}

const notBuilt = (message: string): OneColorSendFailure => ({
	message,
	mayHaveBeenBuilt: false,
});

/** Classifies a failed send that has no txid for the user. */
export function describeOneColorSendFailure(
	error: unknown,
): OneColorSendFailure {
	const message = errorText(error);
	if (isConsentDeclined(error)) {
		return notBuilt("The wallet declined the send. Nothing was sent.");
	}
	if (
		message === "handle-invalid" ||
		message.startsWith("handle has no domain")
	) {
		return notBuilt(ONE_COLOR_HANDLE_PROMPT);
	}
	if (message.startsWith("ecosystem aliases are not supported")) {
		return notBuilt("Use a handle with a full domain, like @name@example.com.");
	}
	if (message === "amount-must-be-positive") {
		return notBuilt("Enter an amount greater than zero.");
	}
	if (message === "amount-out-of-range") {
		return notBuilt("Amount exceeds available balance.");
	}
	if (message.startsWith("invalid-asset-id")) {
		return notBuilt("This token's id isn't valid, so it can't be sent.");
	}
	if (message.startsWith("BRC-232: memo exceeds")) {
		return notBuilt("The memo is too long. Keep it under 2,000 bytes.");
	}
	// `resolveHandle` (@1sat/client): the handle is checked before any key is derived.
	const resolve = /^resolve (\S+) failed: (\d+)/.exec(message);
	if (resolve) {
		return notBuilt(
			resolve[2] === "404"
				? `No handle @${resolve[1]} was found.`
				: "The handle's host didn't answer. Try again later.",
		);
	}
	const manifest = /^manifest fetch failed for \S+: (\d+)/.exec(message);
	if (manifest && Number(manifest[1]) >= 500) {
		return notBuilt("The handle's host didn't answer. Try again later.");
	}
	if (
		manifest ||
		/does not offer handle resolution|metanet\.handles version/.test(message)
	) {
		return notBuilt("That domain doesn't offer handles. Check the handle.");
	}
	if (message.startsWith("certificate subject does not match")) {
		return notBuilt(
			"That handle's certificate doesn't match its key. Don't send to it.",
		);
	}
	// The color module checks these while selecting inputs, before signing.
	if (message.startsWith("insufficient spendable balance")) {
		return notBuilt(
			"Not enough spendable tokens. Some may be held by sends waiting to be claimed.",
		);
	}
	if (message.startsWith("the overlay has no admitted deploy")) {
		return notBuilt(
			"The 1Color overlay hasn't admitted this token yet. Try again later.",
		);
	}
	if (message.startsWith("No 1Color overlay is configured")) {
		return notBuilt("No 1Color overlay is configured for this token.");
	}
	if (INSUFFICIENT_FUNDS.test(message)) {
		return notBuilt(
			"Not enough BSV to pay for the send. Add funds and try again.",
		);
	}
	return {
		message:
			"The send may have been built. Check Waiting to be claimed before sending again.",
		mayHaveBeenBuilt: true,
	};
}

/** What a send built but not delivered tells the user. */
export const oneColorUndeliveredMessage = (handle: string): string =>
	`Built, but not delivered to ${handle}. It's listed under Waiting to be claimed; cancel it there to get the tokens back.`;

export const oneColorSentMessage = (handle: string): string =>
	`Sent to ${handle}. They receive it when their wallet next syncs.`;

export type OneColorSendOutcome =
	| { kind: "sent"; txid: string; message: string }
	| { kind: "undelivered"; txid: string; message: string }
	| ({ kind: "failed" } & OneColorSendFailure);

/**
 * Sends, then re-reads holdings, history and balance whether or not it
 * worked: a failed delivery leaves a pending send. Every failure, including
 * a failed re-read, goes to `log` in full, with the txid when there is one.
 */
export async function runOneColorSend(
	ctx: OneSatContext,
	input: OneColorSendInput,
	options: {
		refresh: () => Promise<void>;
		log: OneColorLog;
		actions?: Pick<OneColorActionSet, "send">;
	},
): Promise<OneColorSendOutcome> {
	const handle = normalizeHandle(input.handle) ?? input.handle.trim();
	let outcome: OneColorSendOutcome;
	try {
		const result = await executeOneColorSend(ctx, input, options.actions);
		if (!result.error && result.txid) {
			outcome = {
				kind: "sent",
				txid: result.txid,
				message: oneColorSentMessage(handle),
			};
		} else if (result.txid) {
			// Built, not delivered (`delivery-failed: …`): the handoff exists.
			options.log("send-delivery", new Error(result.error), {
				txid: result.txid,
			});
			outcome = {
				kind: "undelivered",
				txid: result.txid,
				message: oneColorUndeliveredMessage(handle),
			};
		} else {
			throw new Error(result.error ?? "no-transaction");
		}
	} catch (error) {
		options.log("send", error);
		outcome = { kind: "failed", ...describeOneColorSendFailure(error) };
	}
	try {
		await options.refresh();
	} catch (error) {
		options.log("holdings-refresh", error);
	}
	return outcome;
}

// Pending sends

export interface OneColorPendingSend {
	txid: string;
	/** From the description `send1Color` writes; null when it can't be read. */
	amount: bigint | null;
	handle: string | null;
}

/** The labels `send1Color` gives a transfer of `assetId` (its BRC-207 plan). */
export const oneColorSendPlanLabels = (assetId: string): string[] =>
	ColorPlan.toLabels({
		version: 1,
		assets: [assetId],
		ownedOutputs: [],
		operations: [{ assetId, operation: "transfer" }],
		inputPositions: [],
		changePositions: [],
		sighashTypes: [],
	});

/**
 * Amount and handle of `Send <amount> 1Color tokens to @handle[+tag]@domain`
 * (iOS `parseSendDescription`), or null for any other text.
 */
export function parseOneColorSendDescription(
	description: string,
): { amount: bigint; handle: string } | null {
	const match = /^Send (\d+) 1Color tokens to (@\S+)$/.exec(description);
	if (!match) return null;
	const amount = BigInt(match[1]);
	const handle = normalizeHandle(match[2]);
	return amount > 0n && handle === match[2] ? { amount, handle } : null;
}

/** A `nosend` handoff of `assetId` that `send1Color` built, still unclaimed. */
export function isPendingOneColorSend(
	action: Pick<WalletAction, "status" | "labels">,
	planLabels: readonly string[],
): boolean {
	if (action.status !== "nosend") return false;
	const labels = action.labels ?? [];
	return (
		labels.some((label) => label.startsWith(COLOR_SEND_LABEL_PREFIX)) &&
		planLabels.every((label) => labels.includes(label))
	);
}

/**
 * The asset's sends waiting to be claimed, newest first. Label queries are
 * exact-match and go through the module for `p color` labels, so every
 * action is read with its labels and filtered here. Read it through the
 * permissions manager, which decrypts the descriptions it wrote.
 */
export async function listPendingOneColorSends(
	wallet: Pick<WalletInterface, "listActions">,
	assetId: string,
): Promise<{ sends: OneColorPendingSend[]; truncated: boolean }> {
	const planLabels = oneColorSendPlanLabels(assetId);
	const scan = { cut: false };
	const sends: OneColorPendingSend[] = [];
	for await (const action of actionsNewestFirst(
		wallet,
		{ includeLabels: true },
		scan,
	)) {
		if (!isPendingOneColorSend(action, planLabels)) continue;
		const parsed = parseOneColorSendDescription(action.description);
		sends.push({
			txid: action.txid,
			amount: parsed?.amount ?? null,
			handle: parsed?.handle ?? null,
		});
	}
	return { sends, truncated: scan.cut };
}

export type OneColorCancelOutcome =
	| { kind: "requested"; message: string }
	| { kind: "refused"; message: string }
	| { kind: "failed"; message: string };

/**
 * Cancel send: `abortAction` by txid through `colorContext` (storage finds an
 * action by reference or txid). For a BRC-177 handoff storage asks the
 * network for the tokens back, so the network decides between the cancel and
 * the recipient; `aborted: false` means the handoff is already on the
 * network. Re-reads holdings and history either way.
 */
export async function runOneColorCancel(
	ctx: Pick<OneSatContext, "wallet">,
	send: { txid: string; handle: string | null },
	options: { refresh: () => Promise<void>; log: OneColorLog },
): Promise<OneColorCancelOutcome> {
	const who = send.handle ?? "the recipient";
	let outcome: OneColorCancelOutcome;
	try {
		const { aborted } = await ctx.wallet.abortAction({ reference: send.txid });
		outcome = aborted
			? {
					kind: "requested",
					message: `Cancel requested. The tokens come back unless ${who} claimed them first.`,
				}
			: {
					kind: "refused",
					message:
						"This send is already on the network, so it can't be cancelled.",
				};
	} catch (error) {
		options.log("send-cancel", error, { txid: send.txid });
		outcome = {
			kind: "failed",
			message: "The send couldn't be cancelled. Try again.",
		};
	}
	try {
		await options.refresh();
	} catch (error) {
		options.log("holdings-refresh", error);
	}
	return outcome;
}

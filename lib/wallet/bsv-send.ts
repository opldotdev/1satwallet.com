/**
 * BSV Send beyond a plain address: to a BRC-169 handle (`@1sat/actions`
 * `sendBsv` with `handle` and `memo`) and the handle payments still waiting to
 * be claimed. A handle payment is a BRC-29 output in a protected `noSend`
 * action (BRC-177), delivered in a signed envelope to the handle's
 * `transaction-delivery` box; the recipient broadcasts it. Paymail is not
 * offered: a bare `name@domain` whose domain offers no handles is refused.
 */

import {
	COLOR_SEND_LABEL_PREFIX,
	resolvePaymentHandle,
	type SendBsvInput,
	type SendBsvResponse,
	sendBsv,
} from "@1sat/actions";
import { type HandleResolution, parseHandle } from "@1sat/client";
import { METANET_SEND_EXPIRY_SECONDS } from "@1sat/types";
import { PublicKey, type WalletAction, type WalletInterface } from "@bsv/sdk";
import { isP2pkhAddressForChain } from "@/components/wallet/wallet-home-utils";
import { type Chain, endpointsOf } from "@/lib/chain-endpoints";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import { actionsNewestFirst } from "@/lib/wallet/one-color";

export type BsvRecipient =
	| { kind: "address"; address: string }
	| { kind: "handle"; handle: string; resolution: HandleResolution }
	| { kind: "identity"; identityKey: string };

export type RecipientCheck =
	| { ok: true; recipient: BsvRecipient }
	| { ok: false; message: string };

export const PAYMAIL_REFUSED =
	"That domain doesn't offer handles, and paymail isn't supported. Ask for a handle like @name@domain or a BSV address.";

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

function logFailure(
	operation: string,
	detail: Record<string, unknown>,
	error: unknown,
): void {
	reportDiagnostic({
		category: "action",
		code: "action.failed",
		operation: `wallet.bsv.${operation}`,
		recoverable: true,
		context: { retryable: true },
	});
	console.error(`[wallet.bsv.${operation}]`, { ...detail, error });
}

/**
 * A 66-character compressed identity key, as typed or as a `peerpay:` link
 * (BRC-125, iOS Receive's PeerPay code), lowercased; null for anything else.
 */
export function parseIdentityKeyRecipient(input: string): string | null {
	const key = input.trim().replace(/^peerpay:/i, "");
	if (!/^0[23][0-9a-fA-F]{64}$/.test(key)) return null;
	try {
		return PublicKey.fromString(key).toString().toLowerCase();
	} catch {
		return null;
	}
}

/** `@handle[+tag]@domain`, the form `sendBsv` takes as a handle only. */
export const formatResolvedHandle = (
	r: Pick<HandleResolution, "handle" | "tag" | "domain">,
): string => `@${r.handle}${r.tag ? `+${r.tag}` : ""}@${r.domain}`;

const NETWORK_NAME: Record<Chain, string> = {
	main: "Mainnet",
	test: "Testnet",
};

/**
 * Why nothing may be sent to a resolved handle, or null. A revoked handle or
 * a messagebox that isn't https is refused (iOS `sendRefusal`), and so is a
 * handle at the other chain's handle domain: its owner's wallet there could
 * not take a payment made on this chain.
 */
export function handleRefusal(
	resolution: Pick<HandleResolution, "revoked" | "messagebox" | "domain">,
	chain: Chain,
): string | null {
	if (resolution.revoked) {
		return "Its host marks this handle as revoked, so nothing can be sent to it.";
	}
	let secure = false;
	try {
		secure = new URL(resolution.messagebox).protocol === "https:";
	} catch {
		secure = false;
	}
	if (!secure) {
		return "This handle's mailbox address isn't https, so nothing is sent to it.";
	}
	const other: Chain = chain === "main" ? "test" : "main";
	if (resolution.domain.toLowerCase() === endpointsOf(other).handleDomain) {
		return `This handle is on ${NETWORK_NAME[other]} and this account is on ${NETWORK_NAME[chain]}, so nothing can be sent to it.`;
	}
	return null;
}

/**
 * A short message for a failed handle lookup (`@1sat/client` `resolveHandle`
 * and `domainOffersHandles`), or null when the error isn't a lookup's.
 */
export function handleLookupMessage(error: unknown): string | null {
	const message = errorText(error);
	if (message.startsWith("handle has no domain")) {
		return "Enter a handle like @name@domain.";
	}
	if (message.startsWith("ecosystem aliases are not supported")) {
		return "Use a handle with a full domain, like @name@example.com.";
	}
	const resolve = /^resolve (\S+) failed: (\d+)/.exec(message);
	if (resolve) {
		return resolve[2] === "404"
			? `No handle @${resolve[1]} was found.`
			: "The handle's host didn't answer. Try again later.";
	}
	const manifest = /^manifest fetch failed for \S+: (\d+)/.exec(message);
	if (manifest && Number(manifest[1]) >= 500) {
		return "The handle's host didn't answer. Try again later.";
	}
	if (
		manifest ||
		/does not offer handle resolution|metanet\.handles version/.test(message)
	) {
		return "That domain doesn't offer handles. Check the handle.";
	}
	if (message.startsWith("certificate subject does not match")) {
		return "That handle's certificate doesn't match its key. Don't send to it.";
	}
	return null;
}

const domainOf = (input: string): string => {
	try {
		return parseHandle(input).domain;
	} catch {
		return input.slice(input.lastIndexOf("@") + 1).toLowerCase();
	}
};

export interface RecipientDeps {
	resolvePaymentHandle?: (
		recipient: string,
	) => Promise<HandleResolution | undefined>;
}

/**
 * What a typed recipient is, checked before review: an address on this
 * chain, an identity key (PeerPay), or a handle resolved now so review can
 * show its identity key. Every failure comes back as a short message.
 */
export async function checkBsvRecipient(
	input: string,
	chain: Chain,
	deps: RecipientDeps = {},
): Promise<RecipientCheck> {
	const target = input.trim();
	if (!target) return { ok: false, message: "Enter a recipient." };

	const identityKey = parseIdentityKeyRecipient(target);
	if (identityKey) {
		return { ok: true, recipient: { kind: "identity", identityKey } };
	}

	if (target.includes("@")) {
		const resolve = deps.resolvePaymentHandle ?? resolvePaymentHandle;
		let resolution: HandleResolution | undefined;
		try {
			resolution = await resolve(target);
		} catch (error) {
			const domain = domainOf(target);
			logFailure("handle-lookup", { domain }, error);
			return {
				ok: false,
				message:
					handleLookupMessage(error) ??
					`Couldn't reach ${domain} to look up that handle.`,
			};
		}
		if (!resolution) return { ok: false, message: PAYMAIL_REFUSED };
		const refusal = handleRefusal(resolution, chain);
		if (refusal) return { ok: false, message: refusal };
		return {
			ok: true,
			recipient: {
				kind: "handle",
				handle: formatResolvedHandle(resolution),
				resolution,
			},
		};
	}

	if (isP2pkhAddressForChain(target, chain)) {
		return { ok: true, recipient: { kind: "address", address: target } };
	}
	return {
		ok: false,
		message: `Enter a ${chain === "main" ? "mainnet" : "testnet"} BSV address, a handle like @name@domain, or an identity key.`,
	};
}

// Send to a handle

export type HandleSendOutcome =
	| { kind: "sent"; txid: string; message: string }
	| { kind: "undelivered"; txid: string; message: string }
	| { kind: "failed"; message: string };

export const handleSentMessage = (handle: string): string =>
	`Delivered to ${handle}'s mailbox. They receive it when their wallet next syncs.`;

export const handleUndeliveredMessage = (handle: string): string =>
	`Built, but not delivered to ${handle}. It's listed under Waiting to be claimed; cancel it there to get the coins back.`;

/** Errors the toolbox or the user raise before anything is built. */
function notBuiltMessage(error: string): string | null {
	const lookup = handleLookupMessage(error);
	if (lookup) return lookup;
	const normalized = error.toLowerCase();
	if (/denied|reject|declined|cancel/.test(normalized)) {
		return "The wallet declined this payment. Nothing was sent.";
	}
	if (/insufficient|not enough/.test(normalized)) {
		return "The wallet does not have enough spendable BSV for this amount and its fee.";
	}
	return null;
}

type SendAction = (
	ctx: Parameters<typeof sendBsv.execute>[0],
	input: SendBsvInput,
) => Promise<SendBsvResponse>;

/**
 * Pays a handle through `sendBsv` (`handle` is the `@` form, so it is a
 * handle only, never paymail). A delivery that failed keeps its txid: the
 * payment exists as a `noSend` action and is listed as waiting. Every failure
 * is logged in full.
 */
export async function runHandleSend(
	ctx: Parameters<typeof sendBsv.execute>[0],
	input: { handle: string; satoshis: number; memo?: string },
	deps: { send?: SendAction } = {},
): Promise<HandleSendOutcome> {
	const send: SendAction =
		deps.send ?? ((c, i) => sendBsv.execute(c, i) as Promise<SendBsvResponse>);
	const memo = input.memo?.trim();
	let result: SendBsvResponse;
	try {
		result = await send(ctx, {
			requests: [
				{
					handle: input.handle,
					satoshis: input.satoshis,
					...(memo ? { memo } : {}),
				},
			],
		});
	} catch (error) {
		result = { error: errorText(error) };
	}
	if (!result.error && result.txid) {
		return {
			kind: "sent",
			txid: result.txid,
			message: handleSentMessage(input.handle),
		};
	}
	if (result.txid) {
		logFailure(
			"handle-delivery",
			{ txid: result.txid },
			new Error(result.error),
		);
		return {
			kind: "undelivered",
			txid: result.txid,
			message: handleUndeliveredMessage(input.handle),
		};
	}
	const error = result.error ?? "no-transaction";
	logFailure("handle-send", {}, new Error(error));
	return {
		kind: "failed",
		message:
			notBuiltMessage(error) ??
			"The payment may have been built. Check Waiting to be claimed before sending again.",
	};
}

// Handle payments waiting to be claimed

/** The BRC-177 label `sendBsv` gives a handle payment. */
export const HANDLE_SEND_EXPIRY_LABEL = `p nosend expiry seconds ${METANET_SEND_EXPIRY_SECONDS}`;

/** `sendBsv` cuts the description to this many characters. */
const DESCRIPTION_MAX = 50;

/**
 * `@name@domain` from `Payment to name@domain`, as `sendBsv` describes a
 * handle payment; null when the text is another, or was cut at 50
 * characters (the handle in it may be cut too).
 */
export function parseHandlePaymentDescription(
	description: string,
): string | null {
	if (description.length >= DESCRIPTION_MAX) return null;
	const match = /^Payment to ([^\s@]+@[^\s@]+\.[^\s@]+)$/.exec(description);
	return match ? `@${match[1]}` : null;
}

export interface PendingHandleSend {
	txid: string;
	/** The payment output's amount; null when the action lists no outputs. */
	satoshis: number | null;
	/** Null when the description can't be read whole. */
	handle: string | null;
}

/** A handle payment `sendBsv` built, still `nosend` (not claimed). */
export function isPendingHandleSend(
	action: Pick<WalletAction, "status" | "labels" | "description">,
): boolean {
	if (action.status !== "nosend") return false;
	const labels = action.labels ?? [];
	return (
		labels.includes(HANDLE_SEND_EXPIRY_LABEL) &&
		!labels.some((label) => label.startsWith(COLOR_SEND_LABEL_PREFIX)) &&
		action.description.startsWith("Payment to ")
	);
}

/** The wallet's handle payments waiting to be claimed, newest first. */
export async function listPendingHandleSends(
	wallet: Pick<WalletInterface, "listActions">,
): Promise<{ sends: PendingHandleSend[]; truncated: boolean }> {
	const scan = { cut: false };
	const sends: PendingHandleSend[] = [];
	for await (const action of actionsNewestFirst(
		wallet,
		{ includeLabels: true, includeOutputs: true },
		scan,
	)) {
		if (!isPendingHandleSend(action)) continue;
		const payment = action.outputs?.find((o) => o.outputIndex === 0);
		sends.push({
			txid: action.txid,
			satoshis: payment?.satoshis ?? null,
			handle: parseHandlePaymentDescription(action.description),
		});
	}
	return { sends, truncated: scan.cut };
}

export type HandleSendCancelOutcome =
	| { kind: "requested"; message: string }
	| { kind: "refused"; message: string }
	| { kind: "failed"; message: string };

/**
 * Cancel a waiting handle payment: `abortAction` by txid. For a BRC-177
 * handoff storage asks the network for the coins back, so the network
 * decides between the cancel and the recipient (the 1Color Cancel send).
 */
export async function runHandleSendCancel(
	wallet: Pick<WalletInterface, "abortAction">,
	send: Pick<PendingHandleSend, "txid" | "handle">,
): Promise<HandleSendCancelOutcome> {
	const who = send.handle ?? "the recipient";
	try {
		const { aborted } = await wallet.abortAction({ reference: send.txid });
		return aborted
			? {
					kind: "requested",
					message: `Cancel requested. The coins come back unless ${who} claimed them first.`,
				}
			: {
					kind: "refused",
					message:
						"This payment is already on the network, so it can't be cancelled.",
				};
	} catch (error) {
		logFailure("handle-cancel", { txid: send.txid }, error);
		return /an inprocess, outgoing action/.test(errorText(error))
			? {
					kind: "refused",
					message:
						"This payment has already settled, so it can't be cancelled.",
				}
			: {
					kind: "failed",
					message: "The payment couldn't be cancelled. Try again.",
				};
	}
}

/**
 * PeerPay send to an identity key (TS `PeerPayClient`, the iOS app's Send):
 * a BRC-29 payment token is built (`createPaymentToken`, which broadcasts the
 * transaction) and delivered to the recipient's `payment_inbox` at the
 * MessageBox they advertise on this chain.
 *
 * The token is saved in an outbox before it is delivered, as iOS's
 * `MessageBoxOutbox` does: the coins have already left, and the recipient
 * can only take them with the token, so a delivery that fails stays listed
 * for Retry delivery until it goes through or the user discards it.
 */

import {
	PeerPayClient,
	STANDARD_PAYMENT_MESSAGEBOX,
} from "@bsv/message-box-client";
import { Transaction, type WalletInterface } from "@bsv/sdk";
import { stringifyBRC100 } from "@bsv/sdk/wallet/BRC100ByteEncoding";
import { type Chain, endpointsOf } from "@/lib/chain-endpoints";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import { messageBoxClientFor } from "@/lib/wallet/peerpay-inbox";

export interface PeerPayPaymentToken {
	customInstructions: { derivationPrefix: string; derivationSuffix: string };
	/** Atomic BEEF. */
	transaction: number[];
	amount: number;
}

/** A built PeerPay payment whose delivery hasn't been confirmed. */
export interface PeerPayOutboxEntry {
	txid: string;
	/** The recipient's identity key. */
	recipient: string;
	satoshis: number;
	token: PeerPayPaymentToken;
	createdAt: string;
}

export interface PeerPayOutbox {
	/** Throws `PeerPayOutboxReadError` when the stored value can't be read. */
	list(): PeerPayOutboxEntry[];
	put(entry: PeerPayOutboxEntry): void;
	remove(txid: string): void;
	/** Throws when this storage won't take a write. */
	probe(): void;
}

const KEY_PREFIX = "1sat:peerpay-outbox:";

export const peerPayOutboxKey = (chain: Chain, identityKey: string): string =>
	`${KEY_PREFIX}${chain}:${identityKey}`;

/** Where an outbox value that couldn't be read is kept before it is overwritten. */
export const peerPayOutboxBackupKey = (
	chain: Chain,
	identityKey: string,
	at: Date,
): string =>
	`${peerPayOutboxKey(chain, identityKey)}:backup:${at.toISOString()}`;

export class PeerPayOutboxReadError extends Error {
	constructor(cause: unknown) {
		super("The saved PeerPay payments can't be read.", { cause });
		this.name = "PeerPayOutboxReadError";
	}
}

const isEntry = (value: unknown): value is PeerPayOutboxEntry => {
	if (!value || typeof value !== "object") return false;
	const e = value as Record<string, unknown>;
	const token = e.token as Record<string, unknown> | undefined;
	const ci = token?.customInstructions as Record<string, unknown> | undefined;
	return (
		typeof e.txid === "string" &&
		typeof e.recipient === "string" &&
		typeof e.satoshis === "number" &&
		typeof e.createdAt === "string" &&
		typeof ci?.derivationPrefix === "string" &&
		typeof ci?.derivationSuffix === "string" &&
		Array.isArray(token?.transaction) &&
		typeof token?.amount === "number"
	);
};

/**
 * The account's outbox in `storage` (localStorage in the browser). A value
 * that can't be read, wholly or in part, is copied to a backup key before
 * anything overwrites it, and `list` throws for a value it can't read at
 * all. A write that fails throws, so a payment is never reported as kept
 * when it wasn't.
 */
export function peerPayOutbox(
	storage: Pick<Storage, "getItem" | "setItem">,
	chain: Chain,
	identityKey: string,
	now: () => Date = () => new Date(),
): PeerPayOutbox {
	const key = peerPayOutboxKey(chain, identityKey);
	const read = (): {
		entries: PeerPayOutboxEntry[];
		raw: string | null;
		error: unknown;
		damaged: boolean;
	} => {
		const raw = storage.getItem(key);
		if (!raw) return { entries: [], raw, error: null, damaged: false };
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) throw new Error("not a list");
			const entries = parsed.filter(isEntry);
			if (entries.length !== parsed.length) {
				console.error("[peerpay-send] Unknown outbox entries", {
					chain,
					unknown: parsed.length - entries.length,
				});
			}
			return {
				entries,
				raw,
				error: null,
				damaged: entries.length !== parsed.length,
			};
		} catch (error) {
			console.error("[peerpay-send] Unreadable outbox", { chain, error });
			return { entries: [], raw, error, damaged: true };
		}
	};
	const write = (entries: PeerPayOutboxEntry[]) => {
		const current = read();
		if (current.damaged && current.raw !== null) {
			storage.setItem(
				peerPayOutboxBackupKey(chain, identityKey, now()),
				current.raw,
			);
		}
		storage.setItem(key, JSON.stringify(entries));
	};
	return {
		list: () => {
			const { entries, error } = read();
			if (error) throw new PeerPayOutboxReadError(error);
			return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		},
		put: (entry) =>
			write([...read().entries.filter((e) => e.txid !== entry.txid), entry]),
		remove: (txid) => write(read().entries.filter((e) => e.txid !== txid)),
		probe: () => {
			// Writing the stored value back unchanged tests the write and loses nothing.
			storage.setItem(key, storage.getItem(key) ?? "[]");
		},
	};
}

export interface PeerPaySendDeps {
	createToken(
		recipient: string,
		satoshis: number,
	): Promise<PeerPayPaymentToken>;
	deliver(recipient: string, token: PeerPayPaymentToken): Promise<void>;
	outbox: PeerPayOutbox;
	now?: () => Date;
	/** Waits between in-process delivery tries when the outbox couldn't save. */
	sleep?: (ms: number) => Promise<void>;
}

export type PeerPaySendOutcome =
	| { kind: "sent"; txid: string; message: string }
	| { kind: "undelivered"; txid: string; message: string }
	/** Paid and not delivered, and not saved, so nothing can retry it later. */
	| { kind: "unsaved"; txid: string; message: string }
	| { kind: "failed"; message: string };

export const PEERPAY_SENT_MESSAGE =
	"Delivered to their MessageBox. They receive it when their wallet next syncs.";
export const PEERPAY_UNDELIVERED_MESSAGE =
	"Paid, but not delivered to their MessageBox. Retry delivery below so they can receive it.";

export const PEERPAY_STORAGE_UNAVAILABLE =
	"This browser won't save the payment for a retry, so nothing was sent. Allow this site to store data and try again.";
export const peerPayUnsavedMessage = (txid: string): string =>
	`Paid, but not delivered to their MessageBox, and this browser couldn't save it for a retry. Keep this transaction id: ${txid}.`;

/** Delivery tries in this page when the outbox couldn't save the payment. */
const UNSAVED_TRIES = 3;

/**
 * The server's documented code for a message it already holds. The message
 * id is an HMAC of the body, so a resend of the same token reuses it: the
 * first send went through.
 */
const isDuplicate = (error: unknown): boolean =>
	/\(ERR_DUPLICATE_MESSAGE\)/.test(errorText(error));

/** Delivers, counting the server's "already have it" as delivered. */
async function deliverOnce(
	deliver: PeerPaySendDeps["deliver"],
	recipient: string,
	token: PeerPayPaymentToken,
): Promise<void> {
	try {
		await deliver(recipient, token);
	} catch (error) {
		if (!isDuplicate(error)) throw error;
	}
}

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
		operation: `wallet.peerpay.${operation}`,
		recoverable: true,
		context: { retryable: true },
	});
	// The reason leads the line, so a log reader that keeps only the text
	// (the e2e harness, a browser's copied console) still has it.
	console.error(`[wallet.peerpay.${operation}] ${errorText(error)}`, {
		...detail,
		error,
	});
}

/** Builds the token and delivers it, keeping it in the outbox until delivered. */
export async function runPeerPaySend(
	input: { recipient: string; satoshis: number },
	deps: PeerPaySendDeps,
): Promise<PeerPaySendOutcome> {
	// The coins leave once the token is built; build only where it can be kept.
	try {
		deps.outbox.probe();
	} catch (error) {
		logFailure("outbox-probe", {}, error);
		return { kind: "failed", message: PEERPAY_STORAGE_UNAVAILABLE };
	}
	let token: PeerPayPaymentToken;
	try {
		token = await deps.createToken(input.recipient, input.satoshis);
	} catch (error) {
		logFailure("build", {}, error);
		const text = errorText(error).toLowerCase();
		return {
			kind: "failed",
			message: /insufficient|not enough/.test(text)
				? "The wallet does not have enough spendable BSV for this amount and its fee."
				: /denied|reject|declined|cancel/.test(text)
					? "The wallet declined this payment. Nothing was sent."
					: "The payment couldn't be built. Check your recent activity before trying again.",
		};
	}

	let txid: string;
	try {
		txid = Transaction.fromAtomicBEEF(token.transaction).id("hex");
	} catch (error) {
		logFailure("token", {}, error);
		return {
			kind: "failed",
			message:
				"The wallet built a payment this page can't read. Check your recent activity before trying again.",
		};
	}

	const entry: PeerPayOutboxEntry = {
		txid,
		recipient: input.recipient,
		satoshis: input.satoshis,
		token,
		createdAt: (deps.now?.() ?? new Date()).toISOString(),
	};
	let saved = true;
	try {
		deps.outbox.put(entry);
	} catch (error) {
		saved = false;
		logFailure("outbox-save", { txid }, error);
	}

	if (!saved) {
		// Not kept, so this page is the only chance: try a few times now.
		const sleep =
			deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
		for (let attempt = 1; attempt <= UNSAVED_TRIES; attempt++) {
			try {
				await deliverOnce(deps.deliver, input.recipient, token);
				return { kind: "sent", txid, message: PEERPAY_SENT_MESSAGE };
			} catch (error) {
				logFailure("deliver-unsaved", { txid, attempt }, error);
				if (attempt < UNSAVED_TRIES) await sleep(1000 * attempt);
			}
		}
		return { kind: "unsaved", txid, message: peerPayUnsavedMessage(txid) };
	}

	try {
		await deliverOnce(deps.deliver, input.recipient, token);
	} catch (error) {
		logFailure("deliver", { txid }, error);
		return { kind: "undelivered", txid, message: PEERPAY_UNDELIVERED_MESSAGE };
	}
	try {
		deps.outbox.remove(txid);
	} catch (error) {
		logFailure("outbox-remove", { txid }, error);
	}
	return { kind: "sent", txid, message: PEERPAY_SENT_MESSAGE };
}

/**
 * Delivers a kept payment's same token again: no new transaction is made, so
 * a retry can't pay twice.
 */
export async function retryPeerPayDelivery(
	entry: PeerPayOutboxEntry,
	deps: Pick<PeerPaySendDeps, "deliver" | "outbox">,
): Promise<{ ok: true } | { ok: false; message: string }> {
	try {
		await deliverOnce(deps.deliver, entry.recipient, entry.token);
	} catch (error) {
		logFailure("redeliver", { txid: entry.txid }, error);
		return {
			ok: false,
			message: "Their MessageBox still didn't take it. Try again later.",
		};
	}
	try {
		deps.outbox.remove(entry.txid);
	} catch (error) {
		logFailure("outbox-remove", { txid: entry.txid }, error);
	}
	return { ok: true };
}

/**
 * The live token builder and delivery for one account. Delivery goes to the
 * host the recipient advertises on this chain's overlay, else this chain's
 * own MessageBox (`MessageBoxClient.resolveHostForRecipient`).
 */
export function livePeerPayDeps(
	wallet: WalletInterface,
	chain: Chain,
): Pick<PeerPaySendDeps, "createToken" | "deliver"> {
	const host = endpointsOf(chain).messagebox;
	return {
		createToken: async (recipient, amount) => {
			const token = await new PeerPayClient({
				walletClient: wallet,
				messageBoxHost: host,
			}).createPaymentToken({ recipient, amount });
			// Plain numbers, so the outbox can keep it as JSON.
			return {
				customInstructions: {
					derivationPrefix: token.customInstructions.derivationPrefix,
					derivationSuffix: token.customInstructions.derivationSuffix,
				},
				transaction: Array.from(token.transaction),
				amount: token.amount,
			};
		},
		deliver: async (recipient, token) => {
			await messageBoxClientFor(wallet, chain, host).sendMessage({
				recipient,
				messageBox: STANDARD_PAYMENT_MESSAGEBOX,
				body: stringifyBRC100(token),
			});
		},
	};
}

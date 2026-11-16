import {
	MessageBoxClient,
	type PeerMessage,
	STANDARD_PAYMENT_MESSAGEBOX,
} from "@bsv/message-box-client";
import {
	Beef,
	P2PKH,
	PublicKey,
	Transaction,
	toBRC100PortableByteArray,
	Validation,
	type WalletInterface,
} from "@bsv/sdk";
import {
	type Chain,
	endpointsOf,
	messageboxReadHostsOf,
} from "@/lib/chain-endpoints";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	type InboxSyncOutcome,
	type IncomingPaymentUpdate,
	saveInboxSync,
} from "@/lib/wallet/incoming-payments";

/**
 * PeerPay receiving. A PeerPay sender (`PeerPayClient.sendPayment`, the iOS
 * app's Send) leaves a BRC-29 payment token in the recipient's
 * `payment_inbox`. The same box also carries paymail messages, which
 * `@1sat/actions` `syncMessages` takes on the own box; this takes only the
 * PeerPay tokens, on the own box and the chain's further read boxes, as iOS
 * `IncomingPaymentsService` lists them.
 */

/**
 * One listing window: TS `PeerPayClient` bounds (pages of 100, at most 1000
 * messages), asking for one more so a fuller box is noticed. `maxPages` only
 * guards against a server that never ends: in message-box-client the limit
 * stops the read at the top of the next page, so `maxPages` must exceed the
 * pages the limit needs (11) or a full box throws instead.
 */
const WINDOW = 1000;
export const PEERPAY_LISTING = {
	limit: WINDOW + 1,
	pageSize: 100,
	maxPages: 100,
} as const;

/** `Brc29RemittanceModule` `boundedDerivation`: a key ID must fit the wallet. */
const MAX_DERIVATION_LENGTH = 399;

/** What `PeerPayClient` derives the payment key under. */
const PEERPAY_PROTOCOL: [2, string] = [2, "3241645161d8"];

/** Short reasons the list shows. Full detail goes to the logs. */
export const UNREADABLE_REASON = {
	instructions: "The payment's key instructions are malformed.",
	transaction: "The payment's transaction can't be read.",
	amount: "The amount doesn't match the transaction.",
	recipient: "The payment isn't addressed to this wallet.",
	refused: "The wallet refused this payment's transaction.",
} as const;
export const RETRY_REASON = {
	key: "The wallet couldn't derive this payment's key. It will be retried.",
	wallet: "The wallet couldn't take this payment. It will be retried.",
} as const;

export interface PeerPayToken {
	derivationPrefix: string;
	derivationSuffix: string;
	transaction: number[];
	amount: number;
	outputIndex: number;
}

export interface InboxPayment {
	messageId: string;
	host: string;
	sender: string;
	/** Null when the server gave no time: the record keeps its first-seen time. */
	createdAt: string | null;
	/** The delivery fee the message carried failed to internalize. */
	deliveryFeeFailed: boolean;
	token: PeerPayToken;
}

export interface InboxClient {
	listMessages(args: {
		messageBox: string;
		host: string;
		limit: number;
		pageSize: number;
		maxPages: number;
	}): Promise<PeerMessage[]>;
	acknowledgeMessage(args: {
		messageIds: string[];
		host: string;
	}): Promise<unknown>;
}

export type InboxWallet = Pick<
	WalletInterface,
	"getPublicKey" | "internalizeAction"
>;

export interface PeerPayInboxDeps {
	/** The own box first, then the further read boxes. */
	hosts: string[];
	clientFor: (host: string) => InboxClient;
	wallet: InboxWallet;
	record: (outcome: InboxSyncOutcome) => void;
	now?: () => number;
}

export interface PeerPayInboxResult {
	processed: number;
	/** Payments the wallet could not take, boxes not read, acknowledgements refused. */
	failed: number;
	/**
	 * PeerPay messages still in the own box, which `syncMessages` also counts
	 * as failed. Exact while the own box holds at most 1000 messages; past
	 * that `syncMessages` reads the whole box and this only the first window,
	 * so PeerPay messages beyond it read as paymail failures until it drains.
	 */
	leftOnOwnHost: number;
	/** Boxes that could not be read this time. */
	unreachableHosts: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const isIdentityKey = (value: unknown): value is string => {
	if (typeof value !== "string" || !/^0[23][0-9a-f]{64}$/.test(value)) {
		return false;
	}
	try {
		return PublicKey.fromString(value).toString() === value;
	} catch {
		return false;
	}
};

/**
 * Reads a listed message as a PeerPay token, as TS `paymentFromMessage` does.
 * Anything else (a paymail message, a malformed body) is null and is left in
 * the box untouched.
 */
export function peerPayPaymentOf(
	message: PeerMessage,
	host: string,
): InboxPayment | null {
	let body: unknown = message.body;
	if (typeof body === "string") {
		try {
			body = JSON.parse(body);
		} catch {
			return null;
		}
	}
	if (!isRecord(body)) return null;
	if (body.sender != null && body.sender !== message.sender) return null;
	const instructions = body.customInstructions;
	if (
		!isRecord(instructions) ||
		typeof instructions.derivationPrefix !== "string" ||
		typeof instructions.derivationSuffix !== "string"
	) {
		return null;
	}
	const transaction = toBRC100PortableByteArray(body.transaction as number[]);
	const amount = body.amount;
	const outputIndex = body.outputIndex ?? 0;
	if (
		!transaction?.length ||
		typeof amount !== "number" ||
		!Number.isSafeInteger(amount) ||
		amount <= 0 ||
		typeof outputIndex !== "number" ||
		!Number.isSafeInteger(outputIndex) ||
		outputIndex < 0 ||
		typeof message.messageId !== "string" ||
		message.messageId.length === 0 ||
		!isIdentityKey(message.sender)
	) {
		return null;
	}
	return {
		messageId: message.messageId,
		host,
		sender: message.sender,
		createdAt:
			typeof message.created_at === "string" && message.created_at
				? message.created_at
				: null,
		deliveryFeeFailed: message.paymentOutcome === "failed",
		token: {
			derivationPrefix: instructions.derivationPrefix,
			derivationSuffix: instructions.derivationSuffix,
			transaction,
			amount,
			outputIndex,
		},
	};
}

/** The token's transaction: the Atomic BEEF subject, else the last BEEF transaction. */
function subjectTxid(bytes: number[]): string | null {
	try {
		const beef = Beef.fromBinary(bytes);
		if (beef.atomicTxid) return beef.atomicTxid;
		const last = beef.txs.at(-1);
		return last?.tx ? last.tx.id("hex") : (last?.txid ?? null);
	} catch {
		return null;
	}
}

/**
 * What makes two listed messages the same payment (iOS `paymentKey`): the paid
 * output from the same sender, else the message itself. Another sender's
 * message naming the same output never hides it.
 */
export function paymentKeyOf(payment: InboxPayment): string {
	const txid = subjectTxid(payment.token.transaction);
	return txid
		? `tx:${txid}:${payment.token.outputIndex}:${payment.sender}`
		: `msg:${payment.messageId}:${payment.host}:${payment.sender}`;
}

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
	});
	console.error(`[peerpay] ${operation} failed`, { ...detail, error });
}

const paymentDetail = (payment: InboxPayment) => ({
	host: payment.host,
	messageId: payment.messageId,
	sender: payment.sender,
	satoshis: payment.token.amount,
});

type Inspection =
	| { ok: true; prefix: string; suffix: string; script: string }
	| { ok: false; reason: string; error: unknown };

/**
 * The checks that need no wallet, as `Brc29RemittanceModule` makes them:
 * base64 derivation fields (`validateBase64String`), an Atomic BEEF that
 * parses, and an output at the index paying the claimed amount.
 */
function inspectToken(payment: InboxPayment): Inspection {
	const { token } = payment;
	let prefix: string;
	let suffix: string;
	try {
		prefix = Validation.validateBase64String(
			token.derivationPrefix,
			"derivationPrefix",
		);
		suffix = Validation.validateBase64String(
			token.derivationSuffix,
			"derivationSuffix",
		);
	} catch (error) {
		return { ok: false, reason: UNREADABLE_REASON.instructions, error };
	}
	for (const value of [prefix, suffix]) {
		if (value.length > MAX_DERIVATION_LENGTH || /\s/.test(value)) {
			return {
				ok: false,
				reason: UNREADABLE_REASON.instructions,
				error: new Error(
					`Derivation value of ${value.length} characters is over ${MAX_DERIVATION_LENGTH} or has whitespace`,
				),
			};
		}
	}
	let tx: Transaction;
	try {
		tx = Transaction.fromAtomicBEEF(token.transaction);
	} catch (error) {
		return { ok: false, reason: UNREADABLE_REASON.transaction, error };
	}
	const output = tx.outputs[token.outputIndex];
	if (!output) {
		return {
			ok: false,
			reason: UNREADABLE_REASON.transaction,
			error: new Error(`No output ${token.outputIndex} in ${tx.id("hex")}`),
		};
	}
	if (output.satoshis !== token.amount) {
		return {
			ok: false,
			reason: UNREADABLE_REASON.amount,
			error: new Error(
				`Output pays ${output.satoshis}, token claims ${token.amount}`,
			),
		};
	}
	return { ok: true, prefix, suffix, script: output.lockingScript.toHex() };
}

type Settlement =
	| { status: "received"; payment: InboxPayment }
	| {
			status: "failed" | "unreadable";
			payment: InboxPayment;
			reason: string;
	  };

/**
 * Payments that can't be accepted, already logged, so each is logged once
 * while it waits in its box. Capped: past the cap it starts over.
 */
const loggedUnreadable = new Set<string>();
const LOGGED_UNREADABLE_CAP = 500;

function logUnreadableOnce(key: string, detail: Record<string, unknown>) {
	if (loggedUnreadable.has(key)) return;
	if (loggedUnreadable.size >= LOGGED_UNREADABLE_CAP) loggedUnreadable.clear();
	loggedUnreadable.add(key);
	console.warn("[peerpay] payment can't be accepted; left in the box", {
		key,
		...detail,
	});
}

const REFUSED_PARAMETERS = new Set(["tx", "paymentRemittance"]);

/**
 * Whether `internalizeAction` refused the payment for good, judged by the
 * error's shape so the SDK's and wallet-toolbox's classes (local or
 * rehydrated from remote storage) both match:
 * - `WERR_INVALID_PARAMETER` on `tx` (not valid Atomic BEEF; an existing
 *   transaction in a status such as failed, "has invalid status") or on
 *   `paymentRemittance` (not the BRC-29 script). "Undergoing active changes"
 *   is the one `tx` refusal that passes, so it stays retryable.
 * - `WERR_REVIEW_ACTIONS` whose results include `doubleSpend` or `invalidTx`.
 */
export function isPermanentRefusal(error: unknown): boolean {
	if (error === null || typeof error !== "object") return false;
	const e = error as {
		name?: unknown;
		code?: unknown;
		parameter?: unknown;
		message?: unknown;
		reviewActionResults?: unknown;
	};
	if (
		(e.name === "WERR_INVALID_PARAMETER" || e.code === 6) &&
		typeof e.parameter === "string" &&
		REFUSED_PARAMETERS.has(e.parameter)
	) {
		return !(
			typeof e.message === "string" &&
			/undergoing active changes/.test(e.message)
		);
	}
	if (
		(e.name === "WERR_REVIEW_ACTIONS" || e.code === 5) &&
		Array.isArray(e.reviewActionResults)
	) {
		return e.reviewActionResults.some(
			(r: { status?: unknown } | null) =>
				r?.status === "doubleSpend" || r?.status === "invalidTx",
		);
	}
	return false;
}

/**
 * Takes one payment from the copies of it that were listed: the first copy
 * that passes the local checks and pays this wallet's derived key is
 * internalized. Only the key lookup or `internalizeAction` failing is a
 * retryable failure; a payment no copy of which passes is unreadable.
 */
async function settle(
	key: string,
	copies: InboxPayment[],
	wallet: InboxWallet,
): Promise<Settlement> {
	let unreadable: { payment: InboxPayment; reason: string } | null = null;
	const problems: { messageId: string; host: string; error: unknown }[] = [];
	for (const payment of copies) {
		const inspected = inspectToken(payment);
		if (!inspected.ok) {
			unreadable ??= { payment, reason: inspected.reason };
			problems.push({ ...paymentDetail(payment), error: inspected.error });
			continue;
		}
		let expected: string;
		try {
			const { publicKey } = await wallet.getPublicKey({
				protocolID: PEERPAY_PROTOCOL,
				keyID: `${inspected.prefix} ${inspected.suffix}`,
				counterparty: payment.sender,
				forSelf: true,
			});
			expected = new P2PKH()
				.lock(PublicKey.fromString(publicKey).toHash())
				.toHex();
		} catch (error) {
			logFailure("derive-key", paymentDetail(payment), error);
			return { status: "failed", payment, reason: RETRY_REASON.key };
		}
		if (expected !== inspected.script) {
			unreadable ??= { payment, reason: UNREADABLE_REASON.recipient };
			problems.push({
				...paymentDetail(payment),
				error: new Error("Output script is not this wallet's derived P2PKH"),
			});
			continue;
		}
		try {
			// The request `PeerPayClient.acceptPayment` sends through its
			// BRC-29 settlement module.
			const result = await wallet.internalizeAction({
				tx: payment.token.transaction,
				outputs: [
					{
						outputIndex: payment.token.outputIndex,
						protocol: "wallet payment",
						paymentRemittance: {
							derivationPrefix: inspected.prefix,
							derivationSuffix: inspected.suffix,
							senderIdentityKey: payment.sender,
						},
					},
				],
				labels: ["peerpay"],
				description: "BRC-29 payment received",
			});
			if (result?.accepted !== true) {
				throw new Error("internalizeAction did not accept the payment");
			}
		} catch (error) {
			if (isPermanentRefusal(error)) {
				logUnreadableOnce(key, { ...paymentDetail(payment), error });
				return {
					status: "unreadable",
					payment,
					reason: UNREADABLE_REASON.refused,
				};
			}
			logFailure("internalize", paymentDetail(payment), error);
			return { status: "failed", payment, reason: RETRY_REASON.wallet };
		}
		return { status: "received", payment };
	}
	const first = unreadable ?? { payment: copies[0], reason: "" };
	logUnreadableOnce(key, { reason: first.reason, copies: problems });
	return { status: "unreadable", ...first };
}

/**
 * Lists every box, takes each PeerPay payment into the wallet, and
 * acknowledges it on the box it came from, with its copies on the other boxes.
 * A payment not taken is acknowledged nowhere: a failed one is retried next
 * sync, an unreadable one stays in the box. Wallet storage is the source of
 * truth, so every listed payment is internalized; one the wallet already
 * holds merges. Never throws: every failure is logged and counted.
 */
export async function syncPeerPayInbox(
	deps: PeerPayInboxDeps,
): Promise<PeerPayInboxResult> {
	const now = deps.now ?? Date.now;
	const [ownHost] = deps.hosts;
	const clients = new Map<string, InboxClient>();
	let processed = 0;
	let failed = 0;

	const listings = await Promise.allSettled(
		deps.hosts.map(async (host) => {
			// Inside the try: a client that can't be built is an unreadable box.
			const client = deps.clientFor(host);
			clients.set(host, client);
			const messages = await client.listMessages({
				messageBox: STANDARD_PAYMENT_MESSAGEBOX,
				host,
				...PEERPAY_LISTING,
			});
			if (messages.length > WINDOW) {
				console.warn(
					`[peerpay] ${host} holds more than ${WINDOW} messages; the rest are read on a later sync`,
				);
			}
			const payments = messages.flatMap((m) => peerPayPaymentOf(m, host) ?? []);
			return { payments: payments.slice(0, WINDOW), total: payments.length };
		}),
	);

	// Group copies of one payment in host order, own box first.
	const groups = new Map<string, InboxPayment[]>();
	const listedHosts: string[] = [];
	const unreachableHosts: string[] = [];
	let ownPeerPay = 0;
	listings.forEach((listing, index) => {
		const host = deps.hosts[index];
		if (listing.status === "rejected") {
			logFailure("list", { host }, listing.reason);
			unreachableHosts.push(host);
			failed += 1;
			return;
		}
		listedHosts.push(host);
		if (host === ownHost) ownPeerPay = listing.value.total;
		for (const payment of listing.value.payments) {
			const key = paymentKeyOf(payment);
			groups.set(key, [...(groups.get(key) ?? []), payment]);
		}
	});

	const acks = new Map<string, string[]>();
	const updates: IncomingPaymentUpdate[] = [];
	for (const [key, copies] of groups) {
		const settled = await settle(key, copies, deps.wallet);
		const { payment } = settled;
		updates.push({
			key,
			messageId: payment.messageId,
			host: payment.host,
			sender: payment.sender,
			satoshis: payment.token.amount,
			createdAt: payment.createdAt,
			status: settled.status,
			reason: settled.status === "received" ? null : settled.reason,
			updatedAt: now(),
		});
		if (settled.status === "failed") failed += 1;
		if (settled.status !== "received") continue;
		processed += 1;
		for (const copy of copies) {
			if (copy.deliveryFeeFailed) {
				// The fee attached to the message is still owed: listing it again
				// retries the fee; the payment itself merges.
				logFailure("delivery-fee", paymentDetail(copy), null);
				continue;
			}
			acks.set(copy.host, [...(acks.get(copy.host) ?? []), copy.messageId]);
		}
	}

	let ownAcknowledged = 0;
	for (const [host, messageIds] of acks) {
		try {
			await clients.get(host)?.acknowledgeMessage({ messageIds, host });
			if (host === ownHost) ownAcknowledged = messageIds.length;
		} catch (error) {
			// In the wallet already: the next sync merges it and acknowledges again.
			logFailure("acknowledge", { host, messageIds }, error);
			failed += 1;
		}
	}

	try {
		deps.record({
			updates,
			listedHosts,
			listedKeys: new Set(groups.keys()),
			unreachableHosts,
		});
	} catch (error) {
		logFailure("record", { count: updates.length }, error);
	}

	return {
		processed,
		failed,
		leftOnOwnHost: Math.max(0, ownPeerPay - ownAcknowledged),
		unreachableHosts,
	};
}

const networkPresetOf = (chain: Chain) =>
	chain === "test" ? ("testnet" as const) : ("mainnet" as const);

export function messageBoxClientFor(
	wallet: WalletInterface,
	chain: Chain,
	host: string,
): MessageBoxClient {
	return new MessageBoxClient({
		walletClient: wallet,
		host,
		networkPreset: networkPresetOf(chain),
	});
}

/** The PeerPay inbox sync for one account, on the chain's boxes. */
export function syncAccountPeerPayInbox(
	wallet: WalletInterface,
	chain: Chain,
	identityKey: string,
): Promise<PeerPayInboxResult> {
	return syncPeerPayInbox({
		hosts: messageboxReadHostsOf(chain),
		clientFor: (host) => messageBoxClientFor(wallet, chain, host),
		wallet,
		record: (outcome) => saveInboxSync({ chain, identityKey }, outcome),
	});
}

/** Logs a paymail sync that threw; the PeerPay result is kept. */
export function paymailSyncFailed(error: unknown): null {
	logFailure("paymail-sync", {}, error);
	return null;
}

/**
 * The payments task's result: PeerPay plus paymail, each logged on its own.
 * A PeerPay message left in the own box is counted once, though
 * `syncMessages` also fails to read it. A paymail sync that threw is one
 * failure.
 */
export function combineInboxResults(
	peerPay: PeerPayInboxResult,
	paymail: { processed: number; failed: number } | null,
): { processed: number; failed: number } {
	if (!paymail) {
		return { processed: peerPay.processed, failed: peerPay.failed + 1 };
	}
	return {
		processed: peerPay.processed + paymail.processed,
		failed:
			peerPay.failed + Math.max(0, paymail.failed - peerPay.leftOnOwnHost),
	};
}

/** A MessageBox URL's host name, as settings show it. */
export function messageboxHostName(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/**
 * The host names the overlay lists as this account's MessageBox
 * advertisements (`ls_messagebox`). The SDK lookup returns an empty list when
 * the overlay could not be asked, so an empty list means "none found", not
 * "none".
 */
export async function advertisedMessageboxHosts(
	wallet: WalletInterface,
	chain: Chain,
	identityKey: string,
): Promise<string[]> {
	const client = messageBoxClientFor(
		wallet,
		chain,
		endpointsOf(chain).messagebox,
	);
	const ads = await client.queryAdvertisements(identityKey);
	return [...new Set(ads.map((ad) => messageboxHostName(ad.host)))];
}

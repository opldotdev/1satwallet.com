import {
	MessageBoxClient,
	type PeerMessage,
	STANDARD_PAYMENT_MESSAGEBOX,
} from "@bsv/message-box-client";
import {
	Beef,
	Brc29RemittanceModule,
	PublicKey,
	toBRC100PortableByteArray,
	type WalletInterface,
} from "@bsv/sdk";
import {
	type Chain,
	endpointsOf,
	messageboxReadHostsOf,
} from "@/lib/chain-endpoints";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	type IncomingPaymentRecord,
	loadIncomingPayments,
	saveIncomingPayments,
} from "@/lib/wallet/incoming-payments";

/**
 * PeerPay receiving. A PeerPay sender (`PeerPayClient.sendPayment`, the iOS
 * app's Send) leaves a BRC-29 payment token in the recipient's
 * `payment_inbox`. The same box also carries paymail messages, which
 * `@1sat/actions` `syncMessages` takes on the own box; this takes only the
 * PeerPay tokens, on the own box and the chain's further read boxes, as iOS
 * `IncomingPaymentsService` lists them.
 */

/** TS `PeerPayClient` listing bounds: pages of 100, at most 10 of them. */
const LISTING = { limit: 1000, pageSize: 100, maxPages: 10 } as const;

/** The settlement `PeerPayClient.acceptPayment` runs, with its own config. */
const PEERPAY_SETTLEMENT = new Brc29RemittanceModule({
	protocolID: [2, "3241645161d8"],
	labels: ["peerpay"],
	description: "PeerPay payment",
});

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
	createdAt: string;
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

export interface PeerPayInboxDeps {
	/** The own box first, then the further read boxes. */
	hosts: string[];
	clientFor: (host: string) => InboxClient;
	/** Throws when the wallet did not take the payment. */
	internalize: (payment: InboxPayment) => Promise<void>;
	/** Payment keys already received: these are only acknowledged again. */
	received: ReadonlySet<string>;
	record: (records: IncomingPaymentRecord[]) => void;
	now?: () => number;
}

export interface PeerPayInboxResult {
	processed: number;
	failed: number;
	/** PeerPay messages still in the own box, which `syncMessages` also counts as failed. */
	leftOnOwnHost: number;
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
				: new Date().toISOString(),
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

function errorText(error: unknown): string {
	const cause =
		error instanceof Error && error.cause instanceof Error ? error.cause : null;
	const text =
		cause?.message ||
		(error instanceof Error ? error.message : String(error)) ||
		"Unknown error";
	return text.length > 160 ? `${text.slice(0, 157)}…` : text;
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

/**
 * Lists every box, internalizes each PeerPay payment once, and acknowledges it
 * on the box it came from, with its copies on the other boxes. A payment the
 * wallet did not take is not acknowledged anywhere, so the next sync retries
 * it. Never throws: every failure is logged and counted.
 */
export async function syncPeerPayInbox(
	deps: PeerPayInboxDeps,
): Promise<PeerPayInboxResult> {
	const now = deps.now ?? Date.now;
	const [ownHost] = deps.hosts;
	const clients = new Map(deps.hosts.map((h) => [h, deps.clientFor(h)]));
	let processed = 0;
	let failed = 0;

	const listings = await Promise.allSettled(
		deps.hosts.map(async (host) => {
			const client = clients.get(host) as InboxClient;
			const messages = await client.listMessages({
				messageBox: STANDARD_PAYMENT_MESSAGEBOX,
				host,
				...LISTING,
			});
			return messages.flatMap((m) => peerPayPaymentOf(m, host) ?? []);
		}),
	);

	// Merge in host order, own box first: the first copy of a payment is the
	// one taken; later copies are only acknowledged with it.
	const originals: { key: string; payment: InboxPayment }[] = [];
	const copiesOf = new Map<string, InboxPayment[]>();
	let ownPeerPay = 0;
	listings.forEach((listing, index) => {
		const host = deps.hosts[index];
		if (listing.status === "rejected") {
			logFailure("list", { host }, listing.reason);
			// An unreadable own box fails the task; a further box is noted only.
			if (host === ownHost) failed += 1;
			return;
		}
		if (host === ownHost) ownPeerPay = listing.value.length;
		for (const payment of listing.value) {
			const key = paymentKeyOf(payment);
			const copies = copiesOf.get(key);
			if (copies) {
				copies.push(payment);
				continue;
			}
			copiesOf.set(key, []);
			originals.push({ key, payment });
		}
	});

	const acks = new Map<string, string[]>();
	const queueAck = (payment: InboxPayment) =>
		acks.set(payment.host, [
			...(acks.get(payment.host) ?? []),
			payment.messageId,
		]);
	const records: IncomingPaymentRecord[] = [];

	for (const { key, payment } of originals) {
		const copies = copiesOf.get(key) ?? [];
		const record = {
			key,
			messageId: payment.messageId,
			host: payment.host,
			sender: payment.sender,
			satoshis: payment.token.amount,
			createdAt: payment.createdAt,
			updatedAt: now(),
		};
		if (!deps.received.has(key)) {
			try {
				await deps.internalize(payment);
			} catch (error) {
				logFailure(
					"internalize",
					{
						host: payment.host,
						messageId: payment.messageId,
						sender: payment.sender,
						satoshis: payment.token.amount,
					},
					error,
				);
				records.push({ ...record, status: "failed", reason: errorText(error) });
				failed += 1;
				continue;
			}
			records.push({ ...record, status: "received", reason: null });
			processed += 1;
		}
		queueAck(payment);
		for (const copy of copies) queueAck(copy);
	}

	let ownAcknowledged = 0;
	for (const [host, messageIds] of acks) {
		try {
			await clients.get(host)?.acknowledgeMessage({ messageIds, host });
			if (host === ownHost) ownAcknowledged = messageIds.length;
		} catch (error) {
			// Received already: the next sync only acknowledges it again.
			logFailure("acknowledge", { host, messageIds }, error);
		}
	}

	try {
		deps.record(records);
	} catch (error) {
		logFailure("record", { count: records.length }, error);
	}

	return {
		processed,
		failed,
		leftOnOwnHost: Math.max(0, ownPeerPay - ownAcknowledged),
	};
}

/** Internalizes a token exactly as TS `PeerPayClient.acceptPayment` does. */
export function peerPayInternalizer(wallet: WalletInterface) {
	return async (payment: InboxPayment): Promise<void> => {
		let cause: unknown;
		const capture = (_message: unknown, error?: unknown) => {
			cause = error;
		};
		const result = await PEERPAY_SETTLEMENT.acceptSettlement(
			{
				threadId: "peerpay",
				sender: payment.sender,
				settlement: {
					customInstructions: {
						derivationPrefix: payment.token.derivationPrefix,
						derivationSuffix: payment.token.derivationSuffix,
					},
					transaction: payment.token.transaction,
					amountSatoshis: payment.token.amount,
					outputIndex: payment.token.outputIndex,
				},
			},
			{
				wallet,
				now: Date.now,
				logger: { log: () => undefined, warn: capture, error: capture },
			},
		);
		if (result.action !== "accept") {
			throw new Error(result.termination.message, { cause });
		}
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
	const scope = { chain, identityKey };
	return syncPeerPayInbox({
		hosts: messageboxReadHostsOf(chain),
		clientFor: (host) => messageBoxClientFor(wallet, chain, host),
		internalize: peerPayInternalizer(wallet),
		received: new Set(
			loadIncomingPayments(scope)
				.filter((r) => r.status === "received")
				.map((r) => r.key),
		),
		record: (records) => saveIncomingPayments(scope, records),
	});
}

/**
 * The payments task's result: PeerPay plus paymail. A PeerPay message left in
 * the own box is one failure, though `syncMessages` also fails to read it.
 */
export function combineInboxResults(
	peerPay: PeerPayInboxResult,
	paymail: { processed: number; failed: number },
): { processed: number; failed: number } {
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

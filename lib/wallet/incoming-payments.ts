import type { Chain } from "@/lib/chain-endpoints";

/**
 * What the PeerPay inbox sync did with one incoming payment. Kept in this
 * browser only, as a record for the Incoming payments list: the payment
 * itself lives in wallet storage once received, and a failed one stays in
 * its MessageBox for the next sync to retry.
 */
export interface IncomingPaymentRecord {
	/** Same paid output from the same sender (see `paymentKeyOf`). */
	key: string;
	messageId: string;
	/** The MessageBox the payment was listed on and acknowledged on. */
	host: string;
	sender: string;
	satoshis: number;
	/** When the sender left the message, as the MessageBox reports it. */
	createdAt: string;
	status: "received" | "failed";
	reason: string | null;
	updatedAt: number;
}

interface Scope {
	chain: Chain;
	identityKey: string;
}

const RECORD_LIMIT = 100;
const EMPTY: IncomingPaymentRecord[] = [];
const listeners = new Set<() => void>();
const cache = new Map<
	string,
	{ raw: string; records: IncomingPaymentRecord[] }
>();

const storageKey = ({ chain, identityKey }: Scope) =>
	`1sat:incoming-payments:${chain}:${identityKey}`;

export function loadIncomingPayments(scope: Scope): IncomingPaymentRecord[] {
	if (typeof window === "undefined") return EMPTY;
	const key = storageKey(scope);
	const raw = window.localStorage.getItem(key);
	if (!raw) return EMPTY;
	const cached = cache.get(key);
	if (cached?.raw === raw) return cached.records;
	try {
		const parsed: unknown = JSON.parse(raw);
		const records = Array.isArray(parsed)
			? (parsed as IncomingPaymentRecord[])
			: EMPTY;
		cache.set(key, { raw, records });
		return records;
	} catch (error) {
		console.error("[incoming-payments] Unreadable record list", {
			key,
			error,
		});
		return EMPTY;
	}
}

/**
 * Adds or updates records by payment key, newest first. A payment once
 * received stays received: a later run only acknowledges it again.
 */
export function saveIncomingPayments(
	scope: Scope,
	updates: IncomingPaymentRecord[],
): void {
	if (typeof window === "undefined" || updates.length === 0) return;
	const byKey = new Map(loadIncomingPayments(scope).map((r) => [r.key, r]));
	for (const update of updates) {
		if (byKey.get(update.key)?.status === "received") continue;
		byKey.set(update.key, update);
	}
	const records = [...byKey.values()]
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.slice(0, RECORD_LIMIT);
	window.localStorage.setItem(storageKey(scope), JSON.stringify(records));
	for (const listener of listeners) listener();
}

export function subscribeIncomingPayments(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

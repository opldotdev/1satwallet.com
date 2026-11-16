import type { Chain } from "@/lib/chain-endpoints";

/**
 * What the PeerPay inbox sync did with each incoming payment, kept in this
 * browser for the Incoming payments list only. Wallet storage decides what
 * the wallet holds; a payment not taken stays in its MessageBox.
 */
export interface IncomingPaymentRecord {
	/** Same paid output from the same sender (see `paymentKeyOf`). */
	key: string;
	messageId: string;
	/** The MessageBox the payment was listed on. */
	host: string;
	sender: string;
	satoshis: number;
	/** When the sender left the message, as the MessageBox reports it. */
	createdAt: string;
	/**
	 * received: in the wallet. failed: the wallet could not take it this time;
	 * retried next sync. unreadable: can never be accepted; left in the box.
	 */
	status: "received" | "failed" | "unreadable";
	reason: string | null;
	updatedAt: number;
}

export interface IncomingPaymentsState {
	records: IncomingPaymentRecord[];
	/** MessageBoxes the last sync could not read. */
	unreachableHosts: string[];
}

/** What one sync run saw, for `saveInboxSync`. */
export interface InboxSyncOutcome {
	updates: IncomingPaymentRecord[];
	/** Hosts listed successfully, and every payment key listed on them. */
	listedHosts: string[];
	listedKeys: ReadonlySet<string>;
	unreachableHosts: string[];
}

interface Scope {
	chain: Chain;
	identityKey: string;
}

const RECORD_LIMIT = 100;
const KEY_PREFIX = "1sat:incoming-payments:";
const STATUSES = new Set(["received", "failed", "unreadable"]);
const EMPTY: IncomingPaymentsState = { records: [], unreachableHosts: [] };
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string; state: IncomingPaymentsState }>();

const storageKey = ({ chain, identityKey }: Scope) =>
	`${KEY_PREFIX}${chain}:${identityKey}`;

const isRecord = (value: unknown): value is IncomingPaymentRecord => {
	if (value === null || typeof value !== "object") return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.key === "string" &&
		typeof r.messageId === "string" &&
		typeof r.host === "string" &&
		typeof r.sender === "string" &&
		typeof r.satoshis === "number" &&
		typeof r.createdAt === "string" &&
		typeof r.status === "string" &&
		STATUSES.has(r.status) &&
		(r.reason === null || typeof r.reason === "string") &&
		typeof r.updatedAt === "number"
	);
};

function parseState(raw: string, key: string): IncomingPaymentsState {
	try {
		const parsed: unknown = JSON.parse(raw);
		const source =
			parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		return {
			records: Array.isArray(source.records)
				? source.records.filter(isRecord)
				: [],
			unreachableHosts: Array.isArray(source.unreachableHosts)
				? source.unreachableHosts.filter(
						(host): host is string => typeof host === "string",
					)
				: [],
		};
	} catch (error) {
		console.error("[incoming-payments] Unreadable record list", {
			key,
			error,
		});
		return EMPTY;
	}
}

/**
 * The saved state, parsed once per stored value (a value that fails to parse
 * too, so it is logged once). Throws only when storage itself is blocked.
 */
export function loadIncomingPayments(scope: Scope): IncomingPaymentsState {
	if (typeof window === "undefined") return EMPTY;
	const key = storageKey(scope);
	const raw = window.localStorage.getItem(key);
	if (!raw) return EMPTY;
	const cached = cache.get(key);
	if (cached?.raw === raw) return cached.state;
	const state = parseState(raw, key);
	cache.set(key, { raw, state });
	return state;
}

/**
 * Applies one sync run: updates records by payment key (a received payment
 * stays received), drops the failed or unreadable records of a host that
 * listed this run without that payment, and notes the hosts not read.
 */
export function saveInboxSync(scope: Scope, outcome: InboxSyncOutcome): void {
	if (typeof window === "undefined") return;
	const listed = new Set(outcome.listedHosts);
	const byKey = new Map<string, IncomingPaymentRecord>();
	for (const record of loadIncomingPayments(scope).records) {
		const stale =
			record.status !== "received" &&
			listed.has(record.host) &&
			!outcome.listedKeys.has(record.key);
		if (!stale) byKey.set(record.key, record);
	}
	for (const update of outcome.updates) {
		if (byKey.get(update.key)?.status === "received") continue;
		byKey.set(update.key, update);
	}
	const state: IncomingPaymentsState = {
		records: [...byKey.values()]
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, RECORD_LIMIT),
		unreachableHosts: outcome.unreachableHosts,
	};
	window.localStorage.setItem(storageKey(scope), JSON.stringify(state));
	for (const listener of listeners) listener();
}

/** Calls `listener` on this tab's saves and on other tabs' syncs. */
export function subscribeIncomingPayments(listener: () => void): () => void {
	listeners.add(listener);
	const onStorage = (event: StorageEvent) => {
		if (event.key === null || event.key.startsWith(KEY_PREFIX)) listener();
	};
	if (typeof window !== "undefined") {
		window.addEventListener("storage", onStorage);
	}
	return () => {
		listeners.delete(listener);
		if (typeof window !== "undefined") {
			window.removeEventListener("storage", onStorage);
		}
	};
}

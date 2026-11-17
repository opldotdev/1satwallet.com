import type { SweepAuditRecord } from "@/lib/sweep-audit/record";

/**
 * Where sweep audit records live: one IndexedDB database in this browser,
 * one record per run, listed per wallet identity key. Nothing here leaves the
 * browser; the user exports a record to share it.
 */
export interface SweepAuditStore {
	put(record: SweepAuditRecord): Promise<void>;
	/** The run, when it belongs to this wallet. */
	get(identityKey: string, id: string): Promise<SweepAuditRecord | null>;
	/** This wallet's runs, newest first. */
	list(identityKey: string): Promise<SweepAuditRecord[]>;
}

export const SWEEP_AUDIT_DATABASE = "1sat-sweep-audit";
const RUNS = "runs";
const BY_IDENTITY = "identityKey";

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () =>
			reject(req.error ?? new Error("IndexedDB request failed"));
	});
}

function done(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
	});
}

function open(factory: IDBFactory, name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = factory.open(name, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(RUNS)) {
				const store = db.createObjectStore(RUNS, { keyPath: "id" });
				store.createIndex(BY_IDENTITY, BY_IDENTITY, { unique: false });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () =>
			reject(req.error ?? new Error(`Could not open ${name}`));
		req.onblocked = () =>
			console.warn("[sweep-audit] database open blocked by another tab");
	});
}

const newestFirst = (a: SweepAuditRecord, b: SweepAuditRecord) =>
	b.startedAt.localeCompare(a.startedAt);

/** The browser's store. Each call opens the database and closes it after. */
export function indexedDbSweepAuditStore(
	factory?: IDBFactory,
	name = SWEEP_AUDIT_DATABASE,
): SweepAuditStore {
	const withDb = async <T>(fn: (db: IDBDatabase) => Promise<T>) => {
		const idb =
			factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
		if (!idb) throw new Error("This browser has no IndexedDB");
		const db = await open(idb, name);
		try {
			return await fn(db);
		} finally {
			db.close();
		}
	};
	return {
		put: (record) =>
			withDb(async (db) => {
				const tx = db.transaction(RUNS, "readwrite");
				const complete = done(tx);
				tx.objectStore(RUNS).put(record);
				await complete;
			}),
		get: (identityKey, id) =>
			withDb(async (db) => {
				const tx = db.transaction(RUNS, "readonly");
				const record = await request<SweepAuditRecord | undefined>(
					tx.objectStore(RUNS).get(id),
				);
				return record && record.identityKey === identityKey ? record : null;
			}),
		list: (identityKey) =>
			withDb(async (db) => {
				const tx = db.transaction(RUNS, "readonly");
				const records = await request<SweepAuditRecord[]>(
					tx.objectStore(RUNS).index(BY_IDENTITY).getAll(identityKey),
				);
				return records.sort(newestFirst);
			}),
	};
}

/** A store held in memory, for tests. */
export function memorySweepAuditStore(): SweepAuditStore {
	const records = new Map<string, string>();
	const read = (json: string) => JSON.parse(json) as SweepAuditRecord;
	return {
		put: async (record) => {
			records.set(record.id, JSON.stringify(record));
		},
		get: async (identityKey, id) => {
			const json = records.get(id);
			const record = json ? read(json) : null;
			return record && record.identityKey === identityKey ? record : null;
		},
		list: async (identityKey) =>
			[...records.values()]
				.map(read)
				.filter((record) => record.identityKey === identityKey)
				.sort(newestFirst),
	};
}

let browserStore: SweepAuditStore | null = null;

/** The store this browser's pages share. */
export function sweepAuditStore(): SweepAuditStore {
	browserStore ??= indexedDbSweepAuditStore();
	return browserStore;
}

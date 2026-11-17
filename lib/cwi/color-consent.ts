/**
 * Consent for apps that reach the 1Color (BRC-207) color module. Port of
 * Yours (1color branch) `src/services/colorConsent.ts`.
 *
 * The module asks the host on every token operation with a JSON message whose
 * `type` is `color_send`, `color_signature`, `color_access` (a read) or
 * `color_relinquish`, and keeps no grants of its own. This file turns each
 * message into a `PromptRequest` the CWI relay already renders
 * (`requestAssetPermission`, `transaction` and `basketAccess` kinds), and
 * decides when a saved grant answers without a prompt:
 *
 * - `color_access` for a basket: a basket grant for that app and that
 *   `p color` basket, kept in this wallet's color grant store for the chain, approves; an
 *   approved prompt saves one. Label reads have no grant and prompt every time.
 * - every send, signature and relinquish prompts every time.
 * - the wallet itself (the admin originator, exact match) is approved without
 *   a prompt, whatever the message: its own views confirm before they call.
 * - an app's unreadable message or unknown type is declined without a prompt.
 */

import type {
	PromptDetailRow,
	PromptHandler,
	PromptPanel,
	PromptRequest,
	TransactionPrompt,
} from "@1sat/permission-module";
import {
	IndexedDbPermissionStore,
	type IPermissionStore,
	isExpired,
	type ListGrantsFilter,
	normalizeOriginator,
	type PermissionKey,
	type StoredGrant,
} from "@1sat/wallet-browser";
import {
	type ColorTokenAccessHandler,
	parseAssetBasket,
	parseBalanceSelector,
} from "@bsv/color-permission-module";
import { PrivateKey } from "@bsv/sdk";
import type { Chain } from "@/lib/chain-endpoints";
import { clipForLog, reportDiagnostic } from "@/lib/runtime-diagnostics";

/* -------------------------------------------------------------------------
 * Message shapes (ColorPermissionModule actionConsent / transactionConsent)
 * ---------------------------------------------------------------------- */

interface AssetLeg {
	assetId: string;
	operations: string[];
	inputAmount: string;
	foreignAmount: string;
	authorityInputs: number;
	foreignAuthorityInputs: number;
	keptAmount: string;
	keptAuthorities: number;
	outgoingAmount: string;
	outgoingAuthorities: number;
	transferred: string;
	burned: string;
	minted: string;
}

interface Destination {
	outputIndex: number;
	satoshis: number;
	lockingScript: string;
	assetId?: string;
	role?: string;
	amount?: string;
}

interface ReleasedSignature {
	outpoint: string;
	inputIndex: number;
	sighashType: number;
}

interface TransactionFacts {
	deploy?: { operation: string; amount: string; owned: boolean };
	assets: AssetLeg[];
	destinations: Destination[];
	satoshis: { inputs: number; outputs: number; fee: number };
	signatures: ReleasedSignature[];
	lockTime: number;
}

export type ColorSendMessage = TransactionFacts & {
	type: "color_send";
	handoff: boolean;
	seekPermission?: boolean;
};
export type ColorSignatureMessage = TransactionFacts & {
	type: "color_signature";
	inputIndex: number;
	seekPermission?: boolean;
};
export interface ColorAccessMessage {
	type: "color_access";
	basket?: string;
	assetId?: string;
	role?: string;
	labels?: string[];
	seekPermission?: boolean;
}
export interface ColorRelinquishMessage {
	type: "color_relinquish";
	assetId: string;
	role: string;
	outpoint: string;
	seekPermission?: boolean;
}
export type ColorMessage =
	| ColorSendMessage
	| ColorSignatureMessage
	| ColorAccessMessage
	| ColorRelinquishMessage;

/* -------------------------------------------------------------------------
 * Display helpers
 * ---------------------------------------------------------------------- */

const short = (value: string, head = 8, tail = 6): string =>
	value.length > head + tail + 1
		? `${value.slice(0, head)}…${value.slice(-tail)}`
		: value;

const sats = (n: number): string => `${n.toLocaleString("en-US")} sats`;

const SIGHASH_BASE: Record<number, string> = {
	1: "ALL",
	2: "NONE",
	3: "SINGLE",
};

/** `0x41 ALL|FORKID` style name for a sighash type byte. */
export const sighashName = (type: number): string => {
	const base = SIGHASH_BASE[type & 0x1f] ?? "UNKNOWN";
	const flags = [
		base,
		...(type & 0x40 ? ["FORKID"] : []),
		...(type & 0x80 ? ["ANYONECANPAY"] : []),
	];
	return `0x${type.toString(16).padStart(2, "0")} ${flags.join("|")}`;
};

const authorities = (n: number): string =>
	n === 0 ? "" : ` + ${n} authorit${n === 1 ? "y" : "ies"}`;

const assetPanel = (leg: AssetLeg): PromptPanel => ({
	title: `Token ${short(leg.assetId)}`,
	subtitle: leg.operations.join(", "),
	variant: "token",
	tone: leg.burned !== "0" ? "danger" : "default",
	meta: [
		{ key: "Asset", value: short(leg.assetId), copyValue: leg.assetId },
		{
			key: "Your inputs",
			value: `${leg.inputAmount}${authorities(leg.authorityInputs)}`,
		},
		{
			key: "Other inputs",
			value: `${leg.foreignAmount}${authorities(leg.foreignAuthorityInputs)}`,
		},
		{
			key: "Kept",
			value: `${leg.keptAmount}${authorities(leg.keptAuthorities)}`,
		},
		{
			key: "Outgoing",
			value: `${leg.outgoingAmount}${authorities(leg.outgoingAuthorities)}`,
		},
		{ key: "Transferred", value: leg.transferred },
		{ key: "Minted", value: leg.minted },
		{ key: "Burned", value: leg.burned },
	],
});

const deployPanel = (
	deploy: NonNullable<TransactionFacts["deploy"]>,
): PromptPanel => ({
	title: "New token deploy",
	subtitle: deploy.operation,
	variant: "token",
	meta: [
		{ key: "Amount", value: deploy.amount },
		{ key: "Kept by this wallet", value: deploy.owned ? "Yes" : "No" },
	],
});

const destinationPanel = (out: Destination): PromptPanel => {
	const script: PromptDetailRow = {
		key: "Script",
		value: short(out.lockingScript, 12, 8),
		copyValue: out.lockingScript,
	};
	if (out.assetId === undefined) {
		return {
			title: `Output #${out.outputIndex}`,
			subtitle: sats(out.satoshis),
			variant: "value",
			valueIcon: "pay",
			amountSats: out.satoshis,
			meta: [script],
		};
	}
	return {
		title: `Output #${out.outputIndex}`,
		subtitle:
			out.role === "authority" ? "Authority" : `${out.amount ?? "0"} tokens`,
		variant: "token",
		meta: [
			{ key: "Asset", value: short(out.assetId), copyValue: out.assetId },
			...(out.role ? [{ key: "Role", value: out.role }] : []),
			{ key: "Satoshis", value: sats(out.satoshis) },
			script,
		],
	};
};

const transactionPrompt = (
	title: string,
	originator: string,
	facts: TransactionFacts,
	extraRows: PromptDetailRow[],
): TransactionPrompt => ({
	title,
	subtitle: originator,
	panels: [
		...(facts.deploy ? [deployPanel(facts.deploy)] : []),
		...facts.assets.map(assetPanel),
		...facts.destinations.map(destinationPanel),
	],
	rows: [
		...extraRows,
		{ key: "Inputs", value: sats(facts.satoshis.inputs) },
		{ key: "Outputs", value: sats(facts.satoshis.outputs) },
		{ key: "Fee", value: sats(facts.satoshis.fee) },
		...facts.signatures.map((sig) => ({
			key: `Signs input #${sig.inputIndex}`,
			value: `${short(sig.outpoint, 8, 4)} · ${sighashName(sig.sighashType)}`,
			copyValue: sig.outpoint,
		})),
		{ key: "Lock time", value: String(facts.lockTime) },
	],
});

const accessDescription = (
	msg: ColorAccessMessage,
): { scope: string; description: string } => {
	if (msg.basket === undefined)
		return { scope: "token history", description: "View token action history" };
	if (msg.assetId === undefined)
		return {
			scope: "all tokens",
			description: "List every token this wallet holds",
		};
	const role = msg.role === "authority" ? "authority" : "value";
	return /^p color balance /.test(msg.basket)
		? {
				scope: "token balance",
				description: `View the ${role} balance of this token`,
			}
		: {
				scope: "token outputs",
				description: `View the ${role} outputs of this token`,
			};
};

/**
 * A saved color basket grant as the permissions page lists it, e.g.
 * "All tokens" or "Balance of 0123abcd…ef_0".
 */
export const colorGrantLabel = (basket: string): string => {
	if (basket === "p color assets") return "All tokens";
	try {
		const balance = parseBalanceSelector(basket);
		if (balance)
			return `${balance.role === "authority" ? "Authorities" : "Balance"} of ${short(balance.assetId)}`;
		const held = parseAssetBasket(basket);
		if (held)
			return `${held.role === "authority" ? "Authorities" : "Outputs"} of ${short(held.assetId)}`;
	} catch {
		// Not a basket the module names; show it as stored.
	}
	return basket;
};

/* -------------------------------------------------------------------------
 * Message → PromptRequest
 * ---------------------------------------------------------------------- */

/**
 * The prompt for one color module message. Send and signature consents use
 * the transaction layout (`kind: "transaction"`), the only kind the prompt
 * renders panels for; a read uses `basketAccess`; a relinquish uses the
 * transaction layout for its own title.
 */
export const colorPromptRequest = (
	app: string,
	msg: ColorMessage,
): PromptRequest => {
	switch (msg.type) {
		case "color_send": {
			const payload = transactionPrompt(
				msg.handoff ? "Token Handoff" : "Token Transaction",
				app,
				msg,
				msg.handoff
					? [{ key: "Handoff", value: "Signed now, sent by the receiver" }]
					: [],
			);
			return {
				kind: "transaction",
				originator: app,
				summary: `${msg.handoff ? "Hand off" : "Send"} ${msg.assets.length} token leg${msg.assets.length === 1 ? "" : "s"}`,
				payload: payload as unknown as Record<string, unknown>,
			};
		}
		case "color_signature": {
			const payload = transactionPrompt("Token Signature", app, msg, [
				{ key: "Signs input", value: `#${msg.inputIndex}` },
			]);
			return {
				kind: "transaction",
				originator: app,
				summary: `Sign token input #${msg.inputIndex} of an app-built transaction`,
				payload: payload as unknown as Record<string, unknown>,
			};
		}
		case "color_access": {
			const { scope, description } = accessDescription(msg);
			const keys = msg.basket !== undefined ? [msg.basket] : (msg.labels ?? []);
			return {
				kind: "basketAccess",
				originator: app,
				summary:
					keys.length === 1
						? `Grant view to ${keys[0]}`
						: `Grant view to ${keys.length} token labels`,
				payload: {
					baskets: keys.map((basket) => ({
						basket,
						scope,
						description,
						...(msg.assetId ? { value: msg.assetId } : {}),
					})),
				},
			};
		}
		case "color_relinquish": {
			const payload: TransactionPrompt = {
				title: "Remove Token Output",
				subtitle: app,
				panels: [
					{
						title: `Token ${short(msg.assetId)}`,
						subtitle: `${msg.role} output`,
						variant: "token",
						tone: "danger",
						meta: [
							{
								key: "Asset",
								value: short(msg.assetId),
								copyValue: msg.assetId,
							},
							{
								key: "Output",
								value: short(msg.outpoint, 8, 4),
								copyValue: msg.outpoint,
							},
						],
					},
				],
				rows: [
					{
						key: "Effect",
						value:
							"The wallet stops tracking this output; the coins are not spent",
					},
				],
			};
			return {
				kind: "transaction",
				originator: app,
				summary: `Remove token output ${msg.outpoint} from the wallet`,
				payload: payload as unknown as Record<string, unknown>,
			};
		}
	}
};

/* -------------------------------------------------------------------------
 * Grant store and requestTokenAccess
 * ---------------------------------------------------------------------- */

/** The IndexedDB database name prefix `IndexedDbPermissionStore` uses. */
const PERMISSION_DATABASE = "1sat-wallet-permissions";
/** Every color grant store's scope starts with this. */
const COLOR_SCOPE_PREFIX = "1satwallet-color-";

const colorScope = (chain: Chain, identityKey: string): string =>
	`${COLOR_SCOPE_PREFIX}${chain}-${identityKey}`;

const logStoreFailure = (
	operation: string,
	detail: Record<string, unknown>,
	error: unknown,
) => {
	const event = reportDiagnostic({
		category: "action",
		code: "action.failed",
		operation: `wallet.color-consent.store.${operation}`,
		recoverable: true,
		context: { provider: "permissions-manager", retryable: true },
	});
	console.error(`[wallet] 1Color grant store: ${operation} failed`, {
		correlationId: event.correlationId,
		...detail,
		error,
	});
};

/**
 * An `IndexedDbPermissionStore` that recovers from a failed call.
 * `IndexedDbPermissionStore` (`@1sat/wallet-browser` 0.1.2) keeps its open
 * promise even when the open is rejected, so one transient failure (a blocked
 * upgrade, storage pressure) would fail every later call. After any failed
 * call this drops that store, logs the failure, and opens a fresh one on the
 * next call; the error still reaches the caller.
 */
export class RecoveringPermissionStore implements IPermissionStore {
	readonly scope: string;
	private store: IndexedDbPermissionStore;

	constructor(scope: string) {
		this.scope = scope;
		this.store = new IndexedDbPermissionStore({ scope });
	}

	private async run<T>(
		operation: string,
		call: (store: IndexedDbPermissionStore) => Promise<T>,
	): Promise<T> {
		const store = this.store;
		try {
			return await call(store);
		} catch (error) {
			if (this.store === store) {
				this.store = new IndexedDbPermissionStore({ scope: this.scope });
				logStoreFailure(operation, { scope: this.scope }, error);
				// Release the failed store's connection, if it ever opened. A
				// rejected open rejects close() with the error logged above.
				store.close().catch((closeError: unknown) => {
					if (closeError !== error)
						logStoreFailure("close", { scope: this.scope }, closeError);
				});
			}
			throw error;
		}
	}

	findGrant(key: PermissionKey) {
		return this.run("findGrant", (store) => store.findGrant(key));
	}
	putGrant(grant: StoredGrant) {
		return this.run("putGrant", (store) => store.putGrant(grant));
	}
	deleteGrant(key: PermissionKey) {
		return this.run("deleteGrant", (store) => store.deleteGrant(key));
	}
	deleteAllForOriginator(originator: string) {
		return this.run("deleteAllForOriginator", (store) =>
			store.deleteAllForOriginator(originator),
		);
	}
	listGrants(filter?: ListGrantsFilter) {
		return this.run("listGrants", (store) => store.listGrants(filter));
	}
	/** Release the open database handle; the next call reopens it. */
	close() {
		return this.store.close();
	}
}

const stores = new Map<string, RecoveringPermissionStore>();

/**
 * One wallet's store of color basket grants on one chain (IndexedDB database
 * `1sat-wallet-permissions:1satwallet-color-<chain>-<identityKey>`), so a
 * grant given to an app by one wallet never answers for another. It holds
 * nothing but the grants `createColorTokenAccessHandler` saves; every other
 * permission is an on-chain token of the permissions manager.
 */
export function colorPermissionStore(
	chain: Chain,
	identityKey: string,
): RecoveringPermissionStore {
	const scope = colorScope(chain, identityKey);
	let store = stores.get(scope);
	if (!store) {
		store = new RecoveringPermissionStore(scope);
		stores.set(scope, store);
	}
	return store;
}

/** How long one store's delete is waited for before it is reported stalled. */
export const COLOR_STORE_DELETE_TIMEOUT_MS = 5000;

/**
 * Delete one database. A delete that another connection blocks is logged and
 * still finishes once that connection closes; it is waited for at most
 * `timeoutMs`, so one blocked store never holds up the others. An outcome
 * that arrives after the timeout is logged: a late success as info, a late
 * failure in full.
 */
const deleteDatabase = (name: string, timeoutMs: number): Promise<void> =>
	new Promise((resolve, reject) => {
		const scope = name.slice(PERMISSION_DATABASE.length + 1);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			reject(
				new Error(
					`Deleting ${name} did not finish within ${timeoutMs} ms; it completes once the connection holding it closes.`,
				),
			);
		}, timeoutMs);
		const request = indexedDB.deleteDatabase(name);
		request.onsuccess = () => {
			clearTimeout(timer);
			if (timedOut)
				console.info(
					"[wallet] 1Color grant store: delete finished after the timeout",
					{ scope, timeoutMs },
				);
			resolve();
		};
		request.onerror = () => {
			clearTimeout(timer);
			const error = request.error ?? new Error(`Could not delete ${name}`);
			if (timedOut)
				logStoreFailure("delete-after-timeout", { scope, timeoutMs }, error);
			reject(error);
		};
		request.onblocked = () => {
			const event = reportDiagnostic({
				category: "action",
				code: "action.failed",
				operation: "wallet.color-consent.store.delete-blocked",
				recoverable: true,
				context: { provider: "permissions-manager" },
			});
			console.warn(
				"[wallet] 1Color grant store: delete blocked by an open connection",
				{ correlationId: event.correlationId, scope },
			);
		};
	});

/** Close the cached store for `name`, if any, then delete its database. */
const deleteStore = async (name: string, timeoutMs: number): Promise<void> => {
	const scope = name.slice(PERMISSION_DATABASE.length + 1);
	const store = stores.get(scope);
	stores.delete(scope);
	try {
		// An open connection would hold the delete until it closes.
		await store?.close();
		await deleteDatabase(name, timeoutMs);
	} catch (error) {
		logStoreFailure("delete", { scope }, error);
		throw error;
	}
	console.info("[wallet] 1Color grant store: deleted", { scope });
};

/** The color grant databases the browser lists; [] where it lists none. */
const listedColorDatabases = async (): Promise<string[]> => {
	if (typeof indexedDB.databases !== "function") return [];
	try {
		return (await indexedDB.databases()).flatMap(({ name }) =>
			name?.startsWith(`${PERMISSION_DATABASE}:${COLOR_SCOPE_PREFIX}`)
				? [name]
				: [],
		);
	} catch (error) {
		logStoreFailure("list databases", {}, error);
		return [];
	}
};

/** Whether the browser can list its databases, so every store can be swept. */
export const canListColorStores = (): boolean =>
	typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function";

/**
 * Delete the color grant stores when the wallet is removed: first `current`
 * (the removed wallet's store, when its identity key is known), then, where
 * the browser lists its databases, every other color grant store, in
 * parallel, since a browser holds one built-in wallet at a time. A listing
 * that fails is logged and skipped. Every delete is logged; failed or stalled
 * ones are thrown together once all were tried.
 */
export async function deleteColorPermissionStores(
	current: { chain: Chain; identityKey: string } | null,
	timeoutMs = COLOR_STORE_DELETE_TIMEOUT_MS,
): Promise<void> {
	const failures: unknown[] = [];
	const own = current
		? `${PERMISSION_DATABASE}:${colorScope(current.chain, current.identityKey)}`
		: null;
	if (own) {
		try {
			await deleteStore(own, timeoutMs);
		} catch (error) {
			failures.push(error);
		}
	}
	const others = (await listedColorDatabases()).filter((name) => name !== own);
	const results = await Promise.allSettled(
		others.map((name) => deleteStore(name, timeoutMs)),
	);
	for (const result of results)
		if (result.status === "rejected") failures.push(result.reason);
	if (failures.length > 0)
		throw new AggregateError(
			failures,
			"Could not delete saved 1Color permissions.",
		);
}

const reportColorGrantFailure = (operation: string, error: unknown) => {
	const event = reportDiagnostic({
		category: "action",
		code: "action.failed",
		operation: `wallet.delete.color-grants.${operation}`,
		recoverable: true,
	});
	console.error(`[wallet] removing 1Color grants: ${operation} failed`, {
		correlationId: event.correlationId,
		error,
	});
};

/**
 * Delete the removed wallet's 1Color grant stores (see
 * `deleteColorPermissionStores`). The built-in wallet's identity key is the
 * identity key's public key, or the pay key's for a legacy wallet without
 * one. Runs in the background: the wallet is removed either way, and a
 * failure is logged.
 */
export const removeWalletColorGrants = (
	chain: Chain | null,
	keys: { identityPk?: string; payPk?: string } | null,
): void => {
	let identityKey: string | null = null;
	const rootWif = keys?.identityPk || keys?.payPk;
	if (rootWif) {
		try {
			identityKey = PrivateKey.fromWif(rootWif).toPublicKey().toString();
		} catch (error) {
			reportColorGrantFailure("identity", error);
		}
	}
	const current = chain && identityKey ? { chain, identityKey } : null;
	if (!current && !canListColorStores()) {
		// Locked (or unreadable) and the browser cannot list its databases:
		// no store can be named, so the grants stay until cleared by hand.
		const event = reportDiagnostic({
			category: "action",
			code: "action.failed",
			operation: "wallet.delete.color-grants.skipped",
			recoverable: true,
		});
		console.warn(
			"[wallet] removing 1Color grants: skipped. The wallet's identity key is unknown (locked or unreadable) and this browser cannot list its IndexedDB databases, so its 1Color grant store was not deleted.",
			{ correlationId: event.correlationId },
		);
		return;
	}
	deleteColorPermissionStores(current).catch((error: unknown) =>
		reportColorGrantFailure("delete", error),
	);
};

export interface ColorTokenAccessOptions {
	promptHandler: PromptHandler;
	permissionStore: IPermissionStore;
	adminOriginator: string;
}

const KNOWN_TYPES = new Set([
	"color_send",
	"color_signature",
	"color_access",
	"color_relinquish",
]);

/** Reading the saved color grants failed; nothing was approved. */
export class ColorGrantStoreError extends Error {
	readonly name = "ColorGrantStoreError";
}

const logFailure = (
	operation: string,
	detail: Record<string, unknown>,
	error?: unknown,
) => {
	const event = reportDiagnostic({
		category: "action",
		code: "action.failed",
		operation: `wallet.color-consent.${operation}`,
		recoverable: false,
		context: { provider: "permissions-manager" },
	});
	console.error(`[wallet] 1Color consent: ${operation}`, {
		correlationId: event.correlationId,
		...detail,
		...(error === undefined ? {} : { error }),
	});
};

const typeOf = (value: unknown): string =>
	typeof value === "string" ? clipForLog(value) : typeof value;

/**
 * The color module's `requestTokenAccess`: true approves, false declines (the
 * module then throws `ColorConsentDeclinedError` to the caller).
 */
export const createColorTokenAccessHandler = (
	options: ColorTokenAccessOptions,
): ColorTokenAccessHandler => {
	const { promptHandler, permissionStore, adminOriginator } = options;

	return async (app: string, message: string): Promise<boolean> => {
		// The wallet's own views confirm before they call. Exact match only:
		// apps arrive as a hostname without a port, and the relay, bridge and
		// redirect flows refuse an app on the wallet's own hostname.
		if (app === adminOriginator) return true;

		let msg: ColorMessage;
		try {
			msg = JSON.parse(message) as ColorMessage;
		} catch (error) {
			logFailure(
				"declined an unreadable request",
				{ originator: typeOf(app) },
				error,
			);
			return false;
		}
		if (
			!msg ||
			typeof msg !== "object" ||
			typeof msg.type !== "string" ||
			!KNOWN_TYPES.has(msg.type)
		) {
			logFailure("declined an unknown request type", {
				originator: typeOf(app),
				type: typeOf((msg as { type?: unknown } | null)?.type),
			});
			return false;
		}

		if (msg.type !== "color_access")
			return await promptHandler(colorPromptRequest(app, msg));

		// A basket read is covered by a saved basket grant; label reads
		// (listActions) have no grant shape and prompt every time.
		const originator = normalizeOriginator(app);
		const basket = msg.basket?.trim().toLowerCase();
		if (basket) {
			let grant: Awaited<ReturnType<IPermissionStore["findGrant"]>>;
			try {
				grant = await permissionStore.findGrant({
					type: "basket",
					originator,
					basket,
				});
			} catch (error) {
				logFailure(
					"could not read saved grants",
					{ originator: typeOf(app), basket: clipForLog(basket) },
					error,
				);
				throw new ColorGrantStoreError(
					"Could not read saved 1Color permissions.",
					{ cause: error },
				);
			}
			if (grant && !isExpired(grant.expiry)) return true;
		}
		if (msg.seekPermission === false) return false;

		const approved = await promptHandler(colorPromptRequest(app, msg));
		if (approved && basket) {
			try {
				await permissionStore.putGrant({
					key: { type: "basket", originator, basket },
					expiry: 0,
					grantedAt: Date.now(),
				});
			} catch (error) {
				// The user approved this read; it goes ahead, and the next read
				// asks again because nothing was saved.
				logFailure(
					"could not save a grant",
					{ originator: typeOf(app), basket: clipForLog(basket) },
					error,
				);
			}
		}
		return approved;
	};
};

import { type ListActionsArgs, Validation } from "@bsv/sdk";
import { isCWIStandardMethod } from "@/lib/cwi/types";
import { clipForLog, reportDiagnostic } from "@/lib/runtime-diagnostics";

/**
 * The permissions manager (wallet-toolbox-client 2.16.0) checks reserved
 * names on the raw string: a basket, label or protocol goes to a permission
 * module only when it starts with lowercase `p `, counts as the wallet's own
 * (`admin`) only when it starts with lowercase `admin`, and the baskets
 * `default` and the change spec-op id are admin-only only when spelled
 * exactly. The wallet underneath trims and lowercases the same string. So
 * `P color …`, ` default` or the spec-op id in uppercase skip the manager's
 * checks yet land in the reserved namespace in the wallet. This guard refuses
 * such strings before the manager sees them.
 */
const RESERVED_PREFIXES = ["p ", "admin"] as const;

export type RefusalReason =
	/** Becomes a reserved `p ` or `admin` name only once normalized. */
	| "misrouted"
	/** Changes when the wallet trims and lowercases it (apps only). */
	| "not-canonical"
	/** A name that is not a primitive string, e.g. `new String(…)`. */
	| "not-a-string"
	/** Labels, tags, outputs or protocolID that is not a plain array. */
	| "not-an-array"
	/** Args, an output or a remittance that is not a plain object. */
	| "not-an-object"
	/** Key linkage for a reserved `p ` or `admin` protocol (apps only). */
	| "reserved-linkage"
	/** `getPublicKey` asking for the identity key with a protocolID (apps only). */
	| "identity-key-with-protocol";

export interface MisroutedModuleIdentifier {
	/** Where the value was found, e.g. `outputs[0].insertionRemittance.basket`. */
	field: string;
	/** The value cut to 64 characters, or its type when it is not a string. */
	value: string;
	reason: RefusalReason;
	/** The reserved prefix involved, for `misrouted` and `reserved-linkage`. */
	prefix?: string;
}

const describeRefusal = ({
	field,
	value,
	reason,
	prefix,
}: MisroutedModuleIdentifier): string => {
	const quoted = JSON.stringify(value);
	switch (reason) {
		case "misrouted":
			return `Refused: ${field} ${quoted} uses the reserved "${prefix}" prefix with uppercase letters or leading spaces. Write it starting with lowercase "${prefix}".`;
		case "not-canonical":
			return `Refused: ${field} ${quoted} must be lowercase with no leading or trailing spaces.`;
		case "not-a-string":
			return `Refused: ${field} must be a string, not ${value}.`;
		case "not-an-array":
			return `Refused: ${field} must be an array, not ${value}.`;
		case "not-an-object":
			return `Refused: ${field} must be a plain object, not ${value}.`;
		case "reserved-linkage":
			return `Refused: key linkage for the reserved "${prefix}" protocol ${quoted} is not available to apps.`;
		case "identity-key-with-protocol":
			return "Refused: getPublicKey cannot ask for the identity key together with a protocolID. Ask for the identity key on its own.";
	}
};

export class MisroutedModuleIdentifierError extends Error {
	readonly name = "MisroutedModuleIdentifierError";
	readonly field: string;
	readonly value: string;
	readonly reason: RefusalReason;
	readonly prefix?: string;

	constructor(refusal: MisroutedModuleIdentifier) {
		super(describeRefusal(refusal));
		this.field = refusal.field;
		this.value = refusal.value;
		this.reason = refusal.reason;
		this.prefix = refusal.prefix;
	}
}

const shown = (value: string): string => clipForLog(value);

const typeOf = (value: unknown): string => {
	if (value === null) return "null";
	if (typeof value !== "object") return typeof value;
	if (Array.isArray(value)) return "an array";
	const proto = Object.getPrototypeOf(value);
	if (proto === Object.prototype || proto === null) return "a plain object";
	const tag = Object.prototype.toString.call(value).slice(8, -1);
	const name = tag !== "Object" ? tag : proto?.constructor?.name;
	return `an instance of ${name || "an unnamed class"}`;
};

const normalize = (value: string): string => value.trim().toLowerCase();

const reservedPrefix = (value: string): string | null =>
	RESERVED_PREFIXES.find((prefix) => normalize(value).startsWith(prefix)) ??
	null;

/** The reserved prefix `value` only becomes once trimmed and lowercased. */
const misrouted = (
	field: string,
	value: string,
): MisroutedModuleIdentifier | null => {
	const prefix = reservedPrefix(value);
	return prefix && !value.startsWith(prefix)
		? { field, value: shown(value), reason: "misrouted", prefix }
		: null;
};

/** Apps also may not send any name the wallet would change. */
const notCanonical = (
	field: string,
	value: string,
): MisroutedModuleIdentifier | null =>
	misrouted(field, value) ??
	(value !== normalize(value)
		? { field, value: shown(value), reason: "not-canonical" }
		: null);

type CheckName = (
	field: string,
	value: string,
) => MisroutedModuleIdentifier | null;

const record = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const wrongShape = (
	field: string,
	value: unknown,
	reason: "not-a-string" | "not-an-array" | "not-an-object",
): MisroutedModuleIdentifier => ({ field, value: typeOf(value), reason });

/**
 * Plain call args: an object whose prototype is `Object.prototype` or null.
 * Structured clone keeps own properties on an array (`Object.assign([], …)`),
 * and the manager reads them as args, so arrays and other objects are refused.
 */
const plainArgs = (value: unknown): Record<string, unknown> | null => {
	const args = record(value);
	if (!args) return null;
	const proto = Object.getPrototypeOf(args);
	return proto === Object.prototype || proto === null ? args : null;
};

/**
 * Walk every basket, tag, label, output basket, `insertionRemittance` basket
 * and tag, and `protocolID[1]` in BRC-100 call args. Args that are present
 * but not a plain object, and any slot that is present but has the wrong
 * shape, are refused; each string is passed to `check`.
 */
function walkNames(
	args: unknown,
	check: CheckName,
): MisroutedModuleIdentifier | null {
	if (args === undefined) return null;
	const top = plainArgs(args);
	if (!top) return wrongShape("args", args, "not-an-object");

	const name = (field: string, value: unknown) =>
		typeof value === "string"
			? check(field, value)
			: wrongShape(field, value, "not-a-string");
	const optionalName = (field: string, value: unknown) =>
		value === undefined ? null : name(field, value);
	const list = (field: string, value: unknown) => {
		if (value === undefined) return null;
		if (!Array.isArray(value)) return wrongShape(field, value, "not-an-array");
		for (const [index, item] of value.entries()) {
			const hit = name(`${field}[${index}]`, item);
			if (hit) return hit;
		}
		return null;
	};
	const basketAndTags = (value: Record<string, unknown>, path: string) =>
		optionalName(`${path}basket`, value.basket) ??
		list(`${path}tags`, value.tags);
	const protocol = (value: unknown) => {
		if (value === undefined) return null;
		if (!Array.isArray(value))
			return wrongShape("protocolID", value, "not-an-array");
		return optionalName("protocolID[1]", value[1]);
	};

	const atTop =
		basketAndTags(top, "") ??
		list("labels", top.labels) ??
		protocol(top.protocolID);
	if (atTop) return atTop;
	if (top.outputs === undefined) return null;
	if (!Array.isArray(top.outputs))
		return wrongShape("outputs", top.outputs, "not-an-array");
	for (const [index, item] of top.outputs.entries()) {
		const path = `outputs[${index}]`;
		const output = record(item);
		if (!output) return wrongShape(path, item, "not-an-object");
		const inOutput = basketAndTags(output, `${path}.`);
		if (inOutput) return inOutput;
		if (output.insertionRemittance === undefined) continue;
		const remittance = record(output.insertionRemittance);
		if (!remittance)
			return wrongShape(
				`${path}.insertionRemittance`,
				output.insertionRemittance,
				"not-an-object",
			);
		const inRemittance = basketAndTags(
			remittance,
			`${path}.insertionRemittance.`,
		);
		if (inRemittance) return inRemittance;
	}
	return null;
}

/**
 * The first name in BRC-100 call args that becomes a reserved `p ` or `admin`
 * name only after the wallet trims and lowercases it, or that has the wrong
 * shape. Null when there is none. The wallet's own calls are held to this.
 */
export function findMisroutedModuleIdentifier(
	args: unknown,
): MisroutedModuleIdentifier | null {
	return walkNames(args, misrouted);
}

/**
 * What an app is held to on top of `findMisroutedModuleIdentifier`: every
 * name already canonical (trimmed, lowercase), so no name means one thing to
 * the manager and another to the wallet; no `revealSpecificKeyLinkage` for a
 * reserved `p ` or `admin` protocol; and no `getPublicKey` that asks for the
 * identity key together with a protocolID. The manager (wallet-toolbox-client
 * 2.16.0) hands a `p ` protocol's `getPublicKey` to its module before its own
 * identity-key prompt, and the wallet underneath returns the identity key
 * whenever `identityKey` is set, ignoring the protocol. So `p color …` (or a
 * 1Sat module's `p ` scheme) would give an app the identity key unasked. An
 * app asks for the identity key on its own, which the manager prompts for.
 */
export function findRefusedAppName(
	method: string,
	args: unknown,
): MisroutedModuleIdentifier | null {
	const hit = walkNames(args, notCanonical);
	if (hit) return hit;
	if (method === "getPublicKey") {
		const call = record(args);
		// Truthy, as both the manager and the wallet read it.
		if (call?.identityKey && call.protocolID != null)
			return {
				field: "identityKey",
				value: typeOf(call.identityKey),
				reason: "identity-key-with-protocol",
			};
		return null;
	}
	if (method !== "revealSpecificKeyLinkage") return null;
	const protocolID = record(args)?.protocolID;
	if (!Array.isArray(protocolID) || typeof protocolID[1] !== "string")
		return null;
	const prefix = reservedPrefix(protocolID[1]);
	return prefix
		? {
				field: "protocolID[1]",
				value: shown(protocolID[1]),
				reason: "reserved-linkage",
				prefix,
			}
		: null;
}

/**
 * Module schemes an app reaches only through the module's own consent. An
 * app's general listing never shows their actions or outputs: a `p color`
 * action shows only to a listActions that names one of its `p color` labels,
 * which the color module asks the user about first. Other `p ` schemes
 * (`p nosend`, `p 1sat …`) stay visible.
 */
export const CONSENT_ONLY_SCHEMES = ["color"] as const;

const isConsentOnlyName = (value: unknown): boolean => {
	if (typeof value !== "string") return false;
	const name = normalize(value);
	return CONSENT_ONLY_SCHEMES.some(
		(scheme) => name === `p ${scheme}` || name.startsWith(`p ${scheme} `),
	);
};

type ListedAction = Record<string, unknown>;
type ListedActions = { totalActions: number; actions: ListedAction[] };
type ListActions = (
	args: Record<string, unknown>,
	originator: unknown,
) => Promise<ListedActions>;

/**
 * Hidden from an app: an action with a consent-only label, unless it carries
 * one the app named (and the module asked the user about).
 */
const isHiddenAction = (
	action: ListedAction,
	named: ReadonlySet<string>,
): boolean => {
	const labels = Array.isArray(action.labels) ? action.labels : [];
	return (
		labels.some(isConsentOnlyName) &&
		!labels.some((label) => typeof label === "string" && named.has(label))
	);
};

/** An action as the app sees it: consent-only outputs and unasked labels gone. */
const forApp = (
	action: ListedAction,
	args: Record<string, unknown>,
): ListedAction => {
	const next = { ...action };
	if (Array.isArray(action.outputs))
		next.outputs = action.outputs.filter(
			(output) => !isConsentOnlyName(record(output)?.basket),
		);
	if (args.includeLabels !== true) delete next.labels;
	return next;
};

/**
 * Spec-op labels are 64-hex ids the wallet acts on while listing (the noSend
 * one aborts actions), so a request carrying one is never scanned ahead.
 */
const isSpecOpLabel = (label: unknown): boolean =>
	typeof label === "string" && /^[0-9a-f]{64}$/.test(label);

/** Most actions one label-only scan page reads, and the most a scan reads. */
export const LIST_SCAN_PAGE = 1000;
export const LIST_SCAN_MAX = 10_000;

/**
 * How far a label-only scan of one query got: underlying positions of the
 * visible actions found in the first `scanned` actions of `sourceTotal`.
 */
interface ListScan {
	sourceTotal: number;
	scanned: number;
	visible: number[];
}

/** The last few scans, per originator and label query; see listActionsForApp. */
export type ListScanCache = Map<string, ListScan>;
const SCAN_CACHE_SIZE = 8;

export const createListScanCache = (): ListScanCache => new Map();

/**
 * An app's `listActions` result without consent-only module data: actions
 * with a consent-only label (e.g. `p color …`) are left out unless the app
 * named one of their labels, and outputs in a consent-only basket (read only
 * through the module's own basket consent) are stripped from the rest.
 *
 * `offset` and `limit` count visible actions. A label-only scan reads forward
 * only until `offset + limit` visible actions are found or the wallet's list
 * ends (pages sized to what is still needed, at most 1000; at most 10,000
 * actions in all), then the requested window is read once in full. The scan
 * is kept in `cache` per originator and label query, so the next page
 * continues it instead of starting at 0; it is dropped when the wallet's
 * total for the query changes.
 *
 * `totalActions` is the visible actions found so far plus the actions not
 * yet scanned: an upper bound, exact once a scan has reached the end. Once a
 * scan reaches the 10,000-action cap it is the visible actions found, since
 * nothing past the cap can be read.
 *
 * A request carrying a spec-op label, or naming a consent-only label, goes
 * to the wallet once, as asked, and only its result is filtered; its
 * `totalActions` is the wallet's total less the actions dropped from that page
 * (an upper bound). A consent-only label read is passed once because the
 * module asks the user on every call.
 */
export async function listActionsForApp(
	listActions: ListActions,
	args: Record<string, unknown>,
	originator: unknown,
	cache: ListScanCache = createListScanCache(),
): Promise<ListedActions> {
	// The wallet's own checks and defaults (limit 10, offset 0); throws the
	// wallet's WERR_INVALID_PARAMETER for a bad window.
	const { limit, offset } = Validation.validateListActionsArgs(
		args as unknown as ListActionsArgs,
	);
	const labels = Array.isArray(args.labels) ? args.labels : [];
	const named = new Set(
		labels.filter(
			(label): label is string =>
				typeof label === "string" && isConsentOnlyName(label),
		),
	);

	if (labels.some(isSpecOpLabel) || named.size > 0) {
		const result = await listActions(
			{ ...args, includeLabels: true },
			originator,
		);
		const kept = result.actions.filter(
			(action) => !isHiddenAction(action, named),
		);
		return {
			totalActions: Math.max(
				0,
				result.totalActions - (result.actions.length - kept.length),
			),
			actions: kept.map((action) => forApp(action, args)),
		};
	}

	const query = Object.fromEntries(
		Object.entries({
			labels: args.labels,
			labelQueryMode: args.labelQueryMode,
			seekPermission: args.seekPermission,
		}).filter(([, value]) => value !== undefined),
	);
	const key = JSON.stringify([
		typeof originator === "string" ? originator : null,
		labels,
		args.labelQueryMode ?? "any",
	]);
	const wanted = offset + limit;

	const scanTo = async (from: ListScan | undefined): Promise<ListScan> => {
		const scan: ListScan = from
			? { ...from, visible: [...from.visible] }
			: { sourceTotal: Number.POSITIVE_INFINITY, scanned: 0, visible: [] };
		while (
			scan.visible.length < wanted &&
			scan.scanned < scan.sourceTotal &&
			scan.scanned < LIST_SCAN_MAX
		) {
			const pageSize = Math.min(
				LIST_SCAN_PAGE,
				LIST_SCAN_MAX - scan.scanned,
				Math.max(32, 2 * (wanted - scan.visible.length)),
			);
			const page = await listActions(
				{
					...query,
					includeLabels: true,
					limit: pageSize,
					offset: scan.scanned,
				},
				originator,
			);
			if (from && page.totalActions !== scan.sourceTotal)
				return await scanTo(undefined);
			scan.sourceTotal = page.totalActions;
			for (const [index, action] of page.actions.entries())
				if (!isHiddenAction(action, named))
					scan.visible.push(scan.scanned + index);
			scan.scanned += page.actions.length;
			if (page.actions.length < pageSize) {
				scan.sourceTotal = scan.scanned;
				break;
			}
		}
		if (!Number.isFinite(scan.sourceTotal)) scan.sourceTotal = scan.scanned;
		cache.delete(key);
		cache.set(key, scan);
		if (cache.size > SCAN_CACHE_SIZE)
			cache.delete(cache.keys().next().value as string);
		return scan;
	};

	const read = async (
		scan: ListScan,
		retry: boolean,
	): Promise<ListedActions> => {
		// Past the scan cap nothing more can be read, so the total stops at
		// what was found and a `while (offset < total)` pager ends.
		const totalActions =
			scan.scanned >= LIST_SCAN_MAX
				? scan.visible.length
				: scan.visible.length + Math.max(0, scan.sourceTotal - scan.scanned);
		const window = scan.visible.slice(offset, wanted);
		if (window.length === 0) return { totalActions, actions: [] };
		const first = window[0];
		const full = await listActions(
			{
				...args,
				includeLabels: true,
				offset: first,
				limit: window[window.length - 1] - first + 1,
			},
			originator,
		);
		// The wallet changed since the scan: scan again from 0, once.
		if (full.totalActions !== scan.sourceTotal && retry) {
			cache.delete(key);
			return await read(await scanTo(undefined), false);
		}
		const kept = window
			.map((position) => full.actions[position - first])
			.filter(
				(action) => action !== undefined && !isHiddenAction(action, named),
			);
		// An action in the window was relabelled or removed with the total
		// unchanged: the scan is stale, so scan again from 0, once.
		if (kept.length < window.length && retry) {
			cache.delete(key);
			return await read(await scanTo(undefined), false);
		}
		return {
			totalActions,
			actions: kept.map((action) => forApp(action, args)),
		};
	};

	return await read(await scanTo(cache.get(key)), true);
}

/**
 * Wrap the permissions manager so no BRC-100 call can carry a misrouted
 * reserved name. Every BRC-100 call is checked before it reaches the manager;
 * calls from any originator but `adminOriginator` (exact match, the same test
 * the 1Color consent uses) are held to the app rules too, and an app's
 * `listActions` result is filtered. A refusal is reported in full and the
 * caller gets `MisroutedModuleIdentifierError`. The manager's own methods
 * (callbacks, grants, token listings) pass through, bound to the manager.
 */
export function guardModuleIdentifiers<T extends object>(
	wallet: T,
	adminOriginator: string,
): T {
	const scans = createListScanCache();
	return new Proxy(wallet, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			const method = String(prop);
			if (!isCWIStandardMethod(method)) return value.bind(target);
			return (...args: unknown[]) => {
				const isApp = args[1] !== adminOriginator;
				const refused = isApp
					? findRefusedAppName(method, args[0])
					: findMisroutedModuleIdentifier(args[0]);
				if (!refused) {
					const listArgs = plainArgs(args[0]);
					if (isApp && method === "listActions")
						return listActionsForApp(
							(next, originator) => value.call(target, next, originator),
							listArgs ?? {},
							args[1],
							scans,
						);
					return value.apply(target, args);
				}
				const event = reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: `wallet.module-identifier.${method}`,
					recoverable: false,
					context: { provider: "permissions-manager" },
				});
				console.error("[wallet] refused a reserved or malformed name", {
					correlationId: event.correlationId,
					method,
					originator:
						typeof args[1] === "string" ? shown(args[1]) : typeOf(args[1]),
					...refused,
				});
				return Promise.reject(new MisroutedModuleIdentifierError(refused));
			};
		},
	});
}

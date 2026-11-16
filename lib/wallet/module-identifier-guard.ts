import { isCWIStandardMethod } from "@/lib/cwi/types";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";

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

/** How much of an offending value goes into errors and logs. */
const SHOWN_LENGTH = 64;

export type RefusalReason =
	/** Becomes a reserved `p ` or `admin` name only once normalized. */
	| "misrouted"
	/** Changes when the wallet trims and lowercases it (apps only). */
	| "not-canonical"
	/** A name that is not a primitive string, e.g. `new String(…)`. */
	| "not-a-string"
	/** Labels, tags, outputs or protocolID that is not a plain array. */
	| "not-an-array"
	/** An output or remittance that is not an object. */
	| "not-an-object"
	/** Key linkage for a reserved `p ` or `admin` protocol (apps only). */
	| "reserved-linkage";

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
			return `Refused: ${field} must be an object, not ${value}.`;
		case "reserved-linkage":
			return `Refused: key linkage for the reserved "${prefix}" protocol ${quoted} is not available to apps.`;
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

const shown = (value: string): string =>
	value.length > SHOWN_LENGTH ? `${value.slice(0, SHOWN_LENGTH)}…` : value;

const typeOf = (value: unknown): string => {
	if (value === null) return "null";
	if (typeof value !== "object") return typeof value;
	return Array.isArray(value)
		? "an array"
		: `an object (${Object.prototype.toString.call(value).slice(8, -1)})`;
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
 * Walk every basket, tag, label, output basket, `insertionRemittance` basket
 * and tag, and `protocolID[1]` in BRC-100 call args. A slot that is present
 * but has the wrong shape is refused; each string is passed to `check`.
 */
function walkNames(
	args: unknown,
	check: CheckName,
): MisroutedModuleIdentifier | null {
	const top = record(args);
	if (!top) return null;

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
 * the manager and another to the wallet; and no `revealSpecificKeyLinkage`
 * for a reserved `p ` or `admin` protocol.
 */
export function findRefusedAppName(
	method: string,
	args: unknown,
): MisroutedModuleIdentifier | null {
	const hit = walkNames(args, notCanonical);
	if (hit || method !== "revealSpecificKeyLinkage") return hit;
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

const isPName = (value: unknown): boolean =>
	typeof value === "string" && normalize(value).startsWith("p ");

type ListedActions = {
	totalActions: number;
	actions: Record<string, unknown>[];
};

/**
 * An app's `listActions` result without 1Sat module data: actions that carry
 * any `p ` label are dropped, and outputs in a `p ` basket are stripped from
 * the rest. Labels are only in the result when asked for, so the call is made
 * with `includeLabels: true` and they are removed again when the app did not
 * ask. `totalActions` is reduced by the actions dropped from this page;
 * hidden actions on other pages still count, so it is an upper bound.
 */
export async function listActionsForApp(
	listActions: (
		args: Record<string, unknown>,
		originator: unknown,
	) => Promise<ListedActions>,
	args: Record<string, unknown>,
	originator: unknown,
): Promise<ListedActions> {
	const result = await listActions(
		{ ...args, includeLabels: true },
		originator,
	);
	const kept = result.actions.filter(
		(action) =>
			!(Array.isArray(action.labels) ? action.labels : []).some(isPName),
	);
	const actions = kept.map((action) => {
		const next = { ...action };
		if (Array.isArray(action.outputs))
			next.outputs = action.outputs.filter(
				(output) => !isPName(record(output)?.basket),
			);
		if (args.includeLabels !== true) delete next.labels;
		return next;
	});
	return {
		...result,
		totalActions: Math.max(
			0,
			result.totalActions - (result.actions.length - kept.length),
		),
		actions,
	};
}

/**
 * Wrap the permissions manager so no BRC-100 call can carry a misrouted
 * reserved name. Every BRC-100 call is checked before it reaches the manager;
 * calls from any originator but `adminOriginator` (exact match, the same test
 * the 1Color gate uses) are held to the app rules too, and an app's
 * `listActions` result is filtered. A refusal is reported in full and the
 * caller gets `MisroutedModuleIdentifierError`. The manager's own methods
 * (callbacks, grants, token listings) pass through, bound to the manager.
 */
export function guardModuleIdentifiers<T extends object>(
	wallet: T,
	adminOriginator: string,
): T {
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
					const listArgs = record(args[0]);
					if (isApp && method === "listActions" && listArgs)
						return listActionsForApp(
							(next, originator) => value.call(target, next, originator),
							listArgs,
							args[1],
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

import { reportDiagnostic } from "@/lib/runtime-diagnostics";

/**
 * The permissions manager (wallet-toolbox-client 2.16.0) checks reserved
 * names on the raw string: a basket, label or protocol goes to a permission
 * module only when it starts with lowercase `p `, and counts as the wallet's
 * own (`admin`) only when it starts with lowercase `admin`. The wallet
 * underneath trims and lowercases the same string. So `P color …` or
 * ` p color …` skips the module (and its consent), and ` Admin …` is treated
 * as an ordinary name, yet both land in the reserved namespace in the wallet.
 * This guard refuses such strings before the manager sees them.
 */
const RESERVED_PREFIXES = ["p ", "admin"] as const;

export interface MisroutedModuleIdentifier {
	/** Where the string was found, e.g. `outputs[0].insertionRemittance.basket`. */
	field: string;
	value: string;
	/** The reserved prefix the wallet would read it as: `p ` or `admin`. */
	prefix: string;
}

export class MisroutedModuleIdentifierError extends Error {
	readonly name = "MisroutedModuleIdentifierError";
	readonly field: string;
	readonly value: string;
	readonly prefix: string;

	constructor({ field, value, prefix }: MisroutedModuleIdentifier) {
		super(
			`Refused: ${field} "${value}" uses the reserved "${prefix}" prefix with uppercase letters or leading spaces. Write it starting with lowercase "${prefix}".`,
		);
		this.field = field;
		this.value = value;
		this.prefix = prefix;
	}
}

/** The reserved prefix `value` only becomes once trimmed and lowercased. */
const misroutedPrefix = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	for (const prefix of RESERVED_PREFIXES) {
		if (normalized.startsWith(prefix) && !value.startsWith(prefix))
			return prefix;
	}
	return null;
};

const found = (
	field: string,
	value: unknown,
): MisroutedModuleIdentifier | null => {
	const prefix = misroutedPrefix(value);
	return prefix ? { field, value: value as string, prefix } : null;
};

const record = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;

function checkList(
	value: unknown,
	field: string,
): MisroutedModuleIdentifier | null {
	if (!Array.isArray(value)) return null;
	for (const [index, item] of value.entries()) {
		const hit = found(`${field}[${index}]`, item);
		if (hit) return hit;
	}
	return null;
}

/** Basket and tags of one object: the args, an output or a remittance. */
function checkBasketAndTags(
	value: Record<string, unknown>,
	path: string,
): MisroutedModuleIdentifier | null {
	return (
		found(`${path}basket`, value.basket) ?? checkList(value.tags, `${path}tags`)
	);
}

/**
 * The first basket, output basket, `insertionRemittance.basket`, label, tag or
 * `protocolID[1]` in BRC-100 call args that becomes a reserved `p ` or `admin`
 * name only after the wallet trims and lowercases it. Null when there is none.
 */
export function findMisroutedModuleIdentifier(
	args: unknown,
): MisroutedModuleIdentifier | null {
	const top = record(args);
	if (!top) return null;
	const atTop =
		checkBasketAndTags(top, "") ??
		checkList(top.labels, "labels") ??
		(Array.isArray(top.protocolID)
			? found("protocolID[1]", top.protocolID[1])
			: null);
	if (atTop) return atTop;
	if (!Array.isArray(top.outputs)) return null;
	for (const [index, item] of top.outputs.entries()) {
		const output = record(item);
		if (!output) continue;
		const path = `outputs[${index}].`;
		const inOutput = checkBasketAndTags(output, path);
		if (inOutput) return inOutput;
		const remittance = record(output.insertionRemittance);
		if (!remittance) continue;
		const inRemittance = checkBasketAndTags(
			remittance,
			`${path}insertionRemittance.`,
		);
		if (inRemittance) return inRemittance;
	}
	return null;
}

/**
 * Wrap the permissions manager so no call can carry a misrouted reserved name.
 * Every method call is checked before it reaches the manager; the refusal is
 * reported in full and the caller gets `MisroutedModuleIdentifierError`.
 * Everything else passes through unchanged, bound to the manager itself.
 */
export function guardModuleIdentifiers<T extends object>(wallet: T): T {
	return new Proxy(wallet, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const misrouted = findMisroutedModuleIdentifier(args[0]);
				if (!misrouted) return value.apply(target, args);
				const method = String(prop);
				const event = reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: `wallet.module-identifier.${method}`,
					recoverable: false,
					context: { provider: "permissions-manager" },
				});
				console.error("[wallet] refused a misrouted reserved name", {
					correlationId: event.correlationId,
					method,
					originator: args[1],
					field: misrouted.field,
					value: misrouted.value,
					prefix: misrouted.prefix,
				});
				return Promise.reject(new MisroutedModuleIdentifierError(misrouted));
			};
		},
	});
}

import { reportDiagnostic } from "@/lib/runtime-diagnostics";

/**
 * The permissions manager (wallet-toolbox-client 2.16.0) hands a basket,
 * label or protocol to a permission module only when the raw string starts
 * with lowercase `p `. The wallet underneath trims and lowercases the same
 * string. So `P color …` or ` p color …` skips the module (and its consent)
 * in the manager, then lands in the module's namespace in the wallet. This
 * guard refuses such strings before the manager sees them.
 */
const MODULE_PREFIX = "p ";

export interface MisroutedModuleIdentifier {
	/** Where the string was found, e.g. `outputs[0].insertionRemittance.basket`. */
	field: string;
	value: string;
}

export class MisroutedModuleIdentifierError extends Error {
	readonly name = "MisroutedModuleIdentifierError";
	readonly field: string;
	readonly value: string;

	constructor({ field, value }: MisroutedModuleIdentifier) {
		super(
			`Refused: ${field} "${value}" names a permission module with uppercase letters or leading spaces. Write it starting with lowercase "p ".`,
		);
		this.field = field;
		this.value = value;
	}
}

const isMisrouted = (value: unknown): value is string =>
	typeof value === "string" &&
	!value.startsWith(MODULE_PREFIX) &&
	value.trim().toLowerCase().startsWith(MODULE_PREFIX);

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
		if (isMisrouted(item)) return { field: `${field}[${index}]`, value: item };
	}
	return null;
}

/** Basket and tags of one object: the args, an output or a remittance. */
function checkBasketAndTags(
	value: Record<string, unknown>,
	prefix: string,
): MisroutedModuleIdentifier | null {
	if (isMisrouted(value.basket))
		return { field: `${prefix}basket`, value: value.basket };
	return checkList(value.tags, `${prefix}tags`);
}

/**
 * The first basket, output basket, `insertionRemittance.basket`, label, tag or
 * `protocolID[1]` in BRC-100 call args that becomes a `p ` name only after the
 * wallet trims and lowercases it. Null when there is none.
 */
export function findMisroutedModuleIdentifier(
	args: unknown,
): MisroutedModuleIdentifier | null {
	const top = record(args);
	if (!top) return null;
	const found = checkBasketAndTags(top, "") ?? checkList(top.labels, "labels");
	if (found) return found;
	if (Array.isArray(top.protocolID) && isMisrouted(top.protocolID[1])) {
		return { field: "protocolID[1]", value: top.protocolID[1] };
	}
	if (!Array.isArray(top.outputs)) return null;
	for (const [index, item] of top.outputs.entries()) {
		const output = record(item);
		if (!output) continue;
		const prefix = `outputs[${index}].`;
		const inOutput = checkBasketAndTags(output, prefix);
		if (inOutput) return inOutput;
		const remittance = record(output.insertionRemittance);
		if (!remittance) continue;
		const inRemittance = checkBasketAndTags(
			remittance,
			`${prefix}insertionRemittance.`,
		);
		if (inRemittance) return inRemittance;
	}
	return null;
}

/**
 * Wrap the permissions manager so no call can carry a misrouted `p ` name.
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
				console.error("[wallet] refused a misrouted permission-module name", {
					correlationId: event.correlationId,
					method,
					originator: args[1],
					field: misrouted.field,
					value: misrouted.value,
				});
				return Promise.reject(new MisroutedModuleIdentifierError(misrouted));
			};
		},
	});
}

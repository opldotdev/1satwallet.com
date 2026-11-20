/**
 * In-app BRC-169 handle registration for the built-in wallet: a port of iOS
 * `HandleRegistration` (itself TS `AccountClient.register` from 1sat-sdk
 * `packages/wallet-server/src/accounts/client.ts`), followed by what the
 * registration page has a connected wallet do with the answer, a direct
 * `acquireCertificate`.
 *
 * Check a name with the handle host's resolver, `POST /account/register`
 * over BRC-103 authentication to the chain's account host, check the
 * certificate in the answer against the handle domain's published certifier,
 * and file it in the wallet. Registration is permanent and one per identity.
 */

import { resolveHandle } from "@1sat/client";
import { HANDLE_CERT_TYPE } from "@1sat/types";
import {
	AuthFetch,
	Certificate,
	MasterCertificate,
	PublicKey,
	type WalletInterface,
} from "@bsv/sdk";
import { type Chain, endpointsOf } from "@/lib/chain-endpoints";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import { formatHandle, listHandles } from "@/lib/wallet/handles";

export const HANDLE_USERNAME_RULES =
	"A handle is 3 to 63 lowercase letters, digits and hyphens, and does not start or end with a hyphen.";

/** `normalizeUsername` in the host's `store.ts`: trimmed, lowercased, checked. */
export function normalizeHandleUsername(input: string): string | null {
	const name = input.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name) ? name : null;
}

export type HandleAvailability =
	| { kind: "invalid" }
	| { kind: "available"; handle: string }
	| { kind: "yours"; handle: string }
	| { kind: "taken"; handle: string }
	| { kind: "unknown"; handle: string };

export function availabilityMessage(availability: HandleAvailability): string {
	switch (availability.kind) {
		case "invalid":
			return HANDLE_USERNAME_RULES;
		case "available":
			return `${availability.handle} is available.`;
		case "yours":
			return `${availability.handle} is already this account's. Registering again fetches its certificate.`;
		case "taken":
			return `${availability.handle} is taken.`;
		case "unknown":
			return `${availability.handle} couldn't be checked here. You can still register it: the host refuses a name that is taken.`;
	}
}

/** A name can be registered unless it is invalid or someone else holds it. */
export const allowsRegistration = (a: HandleAvailability | null): boolean =>
	a !== null && a.kind !== "invalid" && a.kind !== "taken";

type Fetch = typeof fetch;

/**
 * Asks the handle host's BRC-169 resolver for `@name@<domain>`. The host
 * doesn't resolve a name nobody holds, so a 404 from its resolve endpoint
 * (not from the manifest) means available.
 */
export async function checkHandleAvailability(
	input: string,
	chain: Chain,
	identityKey: string,
	deps: { fetch?: Fetch } = {},
): Promise<HandleAvailability> {
	const username = normalizeHandleUsername(input);
	if (!username) return { kind: "invalid" };
	const handle = formatHandle({
		handle: username,
		domain: endpointsOf(chain).handleDomain,
	});
	const base = deps.fetch ?? fetch;
	let last: { url: string; status: number } | null = null;
	const recording: Fetch = (async (url, init) => {
		const response = await base(url, init);
		last = { url: String(url), status: response.status };
		return response;
	}) as Fetch;
	try {
		const resolution = await resolveHandle(handle, { fetch: recording });
		return resolution.identityKey.toLowerCase() === identityKey.toLowerCase()
			? { kind: "yours", handle }
			: { kind: "taken", handle };
	} catch (error) {
		const final = last as { url: string; status: number } | null;
		if (
			final?.status === 404 &&
			!new URL(final.url).pathname.endsWith("/manifest.json")
		) {
			return { kind: "available", handle };
		}
		console.error("[handles] availability check failed", { chain, error });
		return { kind: "unknown", handle };
	}
}

export class HandleRegistrationError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "HandleRegistrationError";
	}
}

/**
 * The key that certifies handles at `domain`: its `manifest.json`
 * `metanet.trust.publicKey`.
 */
export async function certifierKeyOf(
	domain: string,
	deps: { fetch?: Fetch } = {},
): Promise<string> {
	const unknown = () =>
		new HandleRegistrationError(
			`${domain} doesn't say which key certifies its handles, so the certificate couldn't be checked. Try again later.`,
		);
	let body: unknown;
	try {
		const response = await (deps.fetch ?? fetch)(
			`https://${domain}/manifest.json`,
		);
		if (!response.ok) throw new Error(`manifest ${response.status}`);
		body = await response.json();
	} catch (error) {
		throw new HandleRegistrationError(unknown().message, { cause: error });
	}
	const hex = (
		(body as { metanet?: { trust?: { publicKey?: unknown } } })?.metanet
			?.trust as { publicKey?: unknown } | undefined
	)?.publicKey;
	if (typeof hex !== "string") throw unknown();
	try {
		return PublicKey.fromString(hex).toString();
	} catch (error) {
		throw new HandleRegistrationError(unknown().message, { cause: error });
	}
}

/** The host's `DirectCertificate`: the arguments of a direct `acquireCertificate`. */
export interface DirectCertificate {
	type: string;
	certifier: string;
	acquisitionProtocol: "direct";
	fields: Record<string, string>;
	serialNumber: string;
	revocationOutpoint: string;
	signature: string;
	keyringRevealer: "certifier";
	keyringForSubject: Record<string, string>;
	subject: string;
}

type RegistrationWallet = Pick<
	WalletInterface,
	"acquireCertificate" | "listCertificates" | "decrypt"
>;

export interface HandleRegistrationDeps {
	fetch?: Fetch;
	/** `POST /account/register` over BRC-103; answers the raw Response. */
	post?: (url: string, body: string) => Promise<Response>;
	listHandles?: typeof listHandles;
}

const BAD_CERTIFICATE =
	"The handle certificate from the host didn't check out, so it wasn't kept.";

function isDirectCertificate(value: unknown): value is DirectCertificate {
	if (!value || typeof value !== "object") return false;
	const c = value as Record<string, unknown>;
	const record = (v: unknown) =>
		!!v &&
		typeof v === "object" &&
		Object.values(v).every((x) => typeof x === "string");
	return (
		typeof c.type === "string" &&
		typeof c.certifier === "string" &&
		c.acquisitionProtocol === "direct" &&
		record(c.fields) &&
		typeof c.serialNumber === "string" &&
		typeof c.revocationOutpoint === "string" &&
		typeof c.signature === "string" &&
		c.keyringRevealer === "certifier" &&
		record(c.keyringForSubject) &&
		typeof c.subject === "string"
	);
}

export const REGISTRATION_TAKEN =
	"That handle is taken, or this account already has one. Nothing was registered.";
export const REGISTRATION_REFUSED_NAME = `The host refused that name. ${HANDLE_USERNAME_RULES}`;
/** The most of a host's own text shown to the user. */
export const HOST_TEXT_MAX = 120;

/**
 * A short message for a refused registration. Known statuses get fixed text;
 * any other host text (`AccountClient.send`'s `error`, else the body) is
 * shown cut to `HOST_TEXT_MAX` characters. The full body is logged.
 */
async function hostError(response: Response, chain: Chain): Promise<string> {
	const text = await response.text().catch(() => "");
	console.error("[handles] registration refused", {
		chain,
		status: response.status,
		body: text,
	});
	if (response.status === 409) return REGISTRATION_TAKEN;
	if (response.status === 400) return REGISTRATION_REFUSED_NAME;
	let message = text;
	try {
		const parsed = JSON.parse(text) as { error?: unknown };
		if (typeof parsed.error === "string") message = parsed.error;
	} catch {}
	message = message.replace(/\s+/g, " ").trim();
	if (!message)
		return `The handle host refused the registration (${response.status}). Nothing was registered.`;
	return message.length > HOST_TEXT_MAX
		? `${message.slice(0, HOST_TEXT_MAX - 1)}…`
		: message;
}

/**
 * Registers `input` at the chain's handle domain and files its certificate.
 * The domain's certifier key is read before anything is posted, so nothing
 * is registered whose certificate couldn't then be checked. A certificate
 * the wallet already holds is not filed again.
 */
export async function registerHandle(
	input: string,
	account: { wallet: RegistrationWallet; chain: Chain; identityKey: string },
	deps: HandleRegistrationDeps = {},
): Promise<string> {
	const username = normalizeHandleUsername(input);
	if (!username) throw new HandleRegistrationError(HANDLE_USERNAME_RULES);
	const { chain, identityKey, wallet } = account;
	const domain = endpointsOf(chain).handleDomain;
	const handle = formatHandle({ handle: username, domain });
	const certifier = await certifierKeyOf(domain, deps);

	const url = `${endpointsOf(chain).account.replace(/\/$/, "")}/account/register`;
	const post =
		deps.post ??
		((target: string, body: string) =>
			new AuthFetch(wallet as unknown as WalletInterface).fetch(target, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			}));
	let response: Response;
	try {
		response = await post(url, JSON.stringify({ username }));
	} catch (error) {
		throw new HandleRegistrationError(
			"The handle host couldn't be reached. Nothing was registered. Try again.",
			{ cause: error },
		);
	}
	if (!response.ok) {
		throw new HandleRegistrationError(await hostError(response, chain));
	}
	let answer: Record<string, unknown>;
	try {
		answer = (await response.json()) as Record<string, unknown>;
	} catch (error) {
		throw new HandleRegistrationError(
			"The handle host sent an answer this wallet can't read.",
			{ cause: error },
		);
	}
	if (typeof answer.username === "string" && answer.username !== username) {
		throw new HandleRegistrationError(
			`The host answered for ${answer.username} instead of ${username}, so nothing was kept.`,
		);
	}
	const cert = answer.certificate;
	if (cert === undefined) {
		throw new HandleRegistrationError(
			`The host registered ${username} but issued no handle certificate for it.`,
		);
	}
	if (!isDirectCertificate(cert)) {
		throw new HandleRegistrationError(
			"The handle host sent an answer this wallet can't read.",
		);
	}

	// What the toolbox's direct acquire checks, plus: from the domain's
	// published certifier, naming the handle just asked for.
	try {
		if (
			cert.type !== HANDLE_CERT_TYPE ||
			cert.certifier !== certifier ||
			cert.subject.toLowerCase() !== identityKey.toLowerCase()
		) {
			throw new Error("type, certifier or subject differs");
		}
		const verified = await new Certificate(
			cert.type,
			cert.serialNumber,
			cert.subject,
			cert.certifier,
			cert.revocationOutpoint,
			cert.fields,
			cert.signature,
		).verify();
		if (!verified) throw new Error("signature does not verify");
		const fields = await MasterCertificate.decryptFields(
			wallet as unknown as WalletInterface,
			cert.keyringForSubject,
			cert.fields,
			cert.certifier,
		);
		if (fields.handle !== username || fields.domain !== domain) {
			throw new Error("the certificate names another handle");
		}
	} catch (error) {
		reportDiagnostic({
			category: "action",
			code: "action.failed",
			operation: "wallet.handles.register-verify",
			recoverable: true,
		});
		console.error("[handles] registration certificate refused", {
			chain,
			serialNumber: cert.serialNumber,
			error,
		});
		throw new HandleRegistrationError(BAD_CERTIFICATE, { cause: error });
	}

	const list = deps.listHandles ?? listHandles;
	const isHeld = async () => {
		try {
			return (await list(wallet)).some(
				(h) =>
					h.serialNumber === cert.serialNumber &&
					h.certifier === cert.certifier,
			);
		} catch {
			// A listing that fails reads as not held; storage has the last word.
			return false;
		}
	};
	if (await isHeld()) return handle;
	try {
		await wallet.acquireCertificate({
			type: cert.type,
			certifier: cert.certifier,
			acquisitionProtocol: "direct",
			fields: cert.fields,
			serialNumber: cert.serialNumber,
			revocationOutpoint: cert.revocationOutpoint,
			signature: cert.signature,
			keyringRevealer: "certifier",
			keyringForSubject: cert.keyringForSubject,
		});
	} catch (error) {
		if (await isHeld()) return handle;
		console.error("[handles] filing the registered certificate failed", {
			chain,
			serialNumber: cert.serialNumber,
			error,
		});
		throw new HandleRegistrationError(
			`${handle} is registered to this account, but this wallet couldn't keep its certificate. Try again; if it keeps failing, this handle may have been removed from this wallet before.`,
			{ cause: error },
		);
	}
	return handle;
}

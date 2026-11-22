/**
 * In-app BRC-169 handle registration for the built-in wallet: a port of iOS
 * `HandleRegistration` and `HandleHost`, on the chain's handle host
 * (`handleHostKindOf`):
 *
 * - Mainnet: TS `AccountClient.register` from 1sat-sdk
 *   `packages/wallet-server/src/accounts/client.ts`, `POST /account/register
 *   {username}` to the chain's account host, answered with a direct
 *   certificate.
 * - Testnet: a skein host (opldotdev/1sat-accounts `registerHandle` and
 *   `register`, with the signed text skein-onboard checks), found from the
 *   domain's `/.well-known/skein-host`: `POST <origin>/account/register
 *   {username, identityKey, signature}`, answered with `{handle, domain,
 *   certificate, keyringForSubject}`.
 *
 * Either way: check a name with the handle host's resolver, read the host's
 * certifier, post over BRC-103 authentication, check the certificate in the
 * answer against that certifier, and file it in the wallet with a direct
 * `acquireCertificate`. Registration is permanent and one per identity.
 */

import { resolveHandle } from "@1sat/client";
import { HANDLE_CERT_TYPE } from "@1sat/types";
import {
	AuthFetch,
	Certificate,
	MasterCertificate,
	PublicKey,
	Utils,
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
 * Which kind of host a chain's handles are registered on (iOS
 * `HandleHostKind`): mainnet `@…@1sat.app` handles come from the wallet-server
 * at the chain's account host; testnet `@…@testnet.1sat.app` handles come
 * from a skein host, found from the domain's `/.well-known/skein-host`.
 */
export type HandleHostKind =
	| { kind: "walletServer"; accounts: string; domain: string }
	| { kind: "skein"; domain: string };

export function handleHostKindOf(chain: Chain): HandleHostKind {
	const { account, handleDomain } = endpointsOf(chain);
	return chain === "main"
		? { kind: "walletServer", accounts: account, domain: handleDomain }
		: { kind: "skein", domain: handleDomain };
}

/**
 * `metanet.trust.publicKey` from a manifest, as a compressed key; with
 * `requiresHandles`, only from a manifest that also names
 * `metanet.handles.resolve`. Null when it names none that parses.
 */
function manifestCertifier(
	body: unknown,
	requiresHandles: boolean,
): string | null {
	const metanet = (body as { metanet?: unknown } | null)?.metanet as
		| { trust?: { publicKey?: unknown }; handles?: { resolve?: unknown } }
		| undefined;
	const hex = metanet?.trust?.publicKey;
	if (typeof hex !== "string") return null;
	if (requiresHandles && typeof metanet?.handles?.resolve !== "string") {
		return null;
	}
	try {
		return PublicKey.fromString(hex).toString();
	} catch (error) {
		console.error("[handles] the manifest's certifier key doesn't parse", {
			error,
		});
		return null;
	}
}

const unknownCertifier = (name: string) =>
	`${name} doesn't say which key certifies its handles, so the certificate couldn't be checked. Try again later.`;

/**
 * The key that certifies the wallet-server's handles: the `manifest.json`
 * `metanet.trust.publicKey` of its accounts host (iOS `HandleHost.discover`,
 * `.walletServer`). The handle domain itself (1sat.app) serves no manifest.
 */
export async function certifierKeyOf(
	accounts: string,
	deps: { fetch?: Fetch } = {},
): Promise<string> {
	const origin = accounts.replace(/\/$/, "");
	const name = new URL(origin).host;
	let body: unknown;
	try {
		const response = await (deps.fetch ?? fetch)(`${origin}/manifest.json`);
		if (!response.ok) throw new Error(`manifest ${response.status}`);
		body = await response.json();
	} catch (error) {
		throw new HandleRegistrationError(unknownCertifier(name), {
			cause: error,
		});
	}
	const key = manifestCertifier(body, false);
	if (!key) throw new HandleRegistrationError(unknownCertifier(name));
	return key;
}

/** What a skein router answers at every host name it serves (skein `src/host/router.ts`). */
export const SKEIN_HOST_PATH = "/.well-known/skein-host";

/**
 * The skein router's origin (scheme, host and port only) and the handle
 * domain it reports at `https://<domain>/.well-known/skein-host`, else
 * `https://<domain>` and the domain itself: a domain that answers no
 * skein-host is its own host (iOS `HandleHost.skeinHost`, 1sat-accounts
 * `hostInfo`). The certifier read that follows says if that host is down.
 */
export async function skeinHostOf(
	domain: string,
	deps: { fetch?: Fetch } = {},
): Promise<{ origin: string; domain: string }> {
	const own = { origin: `https://${domain}`, domain };
	const url = `https://${domain}${SKEIN_HOST_PATH}`;
	let response: Response;
	try {
		response = await (deps.fetch ?? fetch)(url);
	} catch (error) {
		console.error("[handles] reading the skein host failed; using the domain", {
			url,
			error,
		});
		return own;
	}
	// A domain that is its own host answers no 200 here: an expected miss.
	if (response.status !== 200) return own;
	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		console.error(
			"[handles] the skein host answer isn't JSON; using the domain",
			{
				url,
				error,
			},
		);
		return own;
	}
	const answer =
		body && typeof body === "object" && !Array.isArray(body)
			? (body as { origin?: unknown; domain?: unknown })
			: {};
	let origin: URL | null = null;
	try {
		origin = typeof answer.origin === "string" ? new URL(answer.origin) : null;
	} catch {
		origin = null;
	}
	if (origin?.protocol !== "https:" || !origin.hostname) {
		console.error(
			"[handles] the skein host names no https origin; using the domain",
			{
				url,
				body,
			},
		);
		return own;
	}
	const reported =
		typeof answer.domain === "string" ? answer.domain.toLowerCase() : "";
	return { origin: origin.origin, domain: reported || domain };
}

/**
 * The key that certifies a skein host's handles: `<origin>/manifest.json`
 * `metanet.trust.publicKey`, from a manifest that also names the BRC-169
 * resolver (1sat-accounts `hostInfo`). A manifest that can't be read says so
 * apart from one that names no certifier, as iOS `certifierKey` does.
 */
export async function skeinCertifierKeyOf(
	origin: string,
	deps: { fetch?: Fetch } = {},
): Promise<string> {
	const manifest = `${origin}/manifest.json`;
	const name = new URL(manifest).hostname;
	const unreachable = (reason: string) =>
		`Couldn't read which key certifies ${name}'s handles (${reason}), so nothing was registered. Try again later.`;
	let response: Response;
	try {
		response = await (deps.fetch ?? fetch)(manifest);
	} catch (error) {
		console.error("[handles] reading the handle certifier failed", {
			manifest,
			error,
		});
		throw new HandleRegistrationError(unreachable("the request failed"), {
			cause: error,
		});
	}
	if (!response.ok) {
		const text = await response.text().catch((error: unknown) => {
			console.error("[handles] reading a refused manifest failed", { error });
			return "";
		});
		console.error("[handles] the handle certifier manifest was refused", {
			manifest,
			status: response.status,
			body: text.slice(0, 2_000),
		});
		throw new HandleRegistrationError(
			unreachable(`it answered HTTP ${response.status}`),
		);
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		console.error("[handles] the handle certifier manifest isn't JSON", {
			manifest,
			error,
		});
		throw new HandleRegistrationError(unknownCertifier(name), {
			cause: error,
		});
	}
	const key = manifestCertifier(body, true);
	if (!key) {
		console.error("[handles] the manifest names no handle certifier", {
			manifest,
			body,
		});
		throw new HandleRegistrationError(unknownCertifier(name));
	}
	return key;
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
	"acquireCertificate" | "listCertificates" | "decrypt" | "createSignature"
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

const UNREADABLE = "The handle host sent an answer this wallet can't read.";
const UNREACHABLE =
	"The handle host couldn't be reached. Nothing was registered. Try again.";

const nameMismatch = (requested: string, answered: string) =>
	`The host answered for ${answered} instead of ${requested}, so nothing was kept.`;
const noCertificate = (username: string) =>
	`The host registered ${username} but issued no handle certificate for it.`;

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
 * A skein host's refusal in its own words (iOS `rejected`, from
 * `AccountClient.send`'s `error`, else the body, else `<path> <status>`),
 * cut to `HOST_TEXT_MAX` characters. The full body is logged.
 */
async function skeinHostError(
	response: Response,
	chain: Chain,
	origin: string,
): Promise<string> {
	const text = await response.text().catch((error: unknown) => {
		console.error("[handles] reading a refused registration failed", {
			error,
		});
		return "";
	});
	console.error("[handles] registration refused", {
		chain,
		host: origin,
		status: response.status,
		body: text.slice(0, 2_000),
	});
	let message = text;
	try {
		const parsed = JSON.parse(text) as { error?: unknown };
		if (typeof parsed.error === "string") message = parsed.error;
	} catch {}
	message = message.replace(/\s+/g, " ").trim();
	if (!message) message = `/account/register ${response.status}`;
	if (message.length > HOST_TEXT_MAX) {
		message = `${message.slice(0, HOST_TEXT_MAX - 1)}…`;
	}
	return `The handle host refused the registration: ${message}`;
}

const authPost =
	(wallet: RegistrationWallet) => (target: string, body: string) =>
		new AuthFetch(wallet as unknown as WalletInterface).fetch(target, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		});

/** The POST, with a host that can't be reached as a short message. */
async function postRegistration(
	url: string,
	body: string,
	wallet: RegistrationWallet,
	deps: HandleRegistrationDeps,
): Promise<Response> {
	try {
		return await (deps.post ?? authPost(wallet))(url, body);
	} catch (error) {
		console.error("[handles] posting the registration failed", { url, error });
		throw new HandleRegistrationError(UNREACHABLE, { cause: error });
	}
}

/**
 * Registers `input` at the chain's handle domain and files its certificate.
 * The host's certifier key is read before anything is posted, so nothing is
 * registered whose certificate couldn't then be checked. A certificate the
 * wallet already holds is not filed again.
 */
export async function registerHandle(
	input: string,
	account: { wallet: RegistrationWallet; chain: Chain; identityKey: string },
	deps: HandleRegistrationDeps = {},
): Promise<string> {
	const username = normalizeHandleUsername(input);
	if (!username) throw new HandleRegistrationError(HANDLE_USERNAME_RULES);
	const host = handleHostKindOf(account.chain);
	return host.kind === "skein"
		? registerAtSkeinHost(username, host.domain, account, deps)
		: registerAtWalletServer(username, host, account, deps);
}

/** Mainnet: `AccountClient.register({ username })` on the wallet-server. */
async function registerAtWalletServer(
	username: string,
	host: { accounts: string; domain: string },
	account: { wallet: RegistrationWallet; chain: Chain; identityKey: string },
	deps: HandleRegistrationDeps,
): Promise<string> {
	const { chain, wallet } = account;
	const { domain } = host;
	const certifier = await certifierKeyOf(host.accounts, deps);

	const url = `${host.accounts.replace(/\/$/, "")}/account/register`;
	const response = await postRegistration(
		url,
		JSON.stringify({ username }),
		wallet,
		deps,
	);
	if (!response.ok) {
		throw new HandleRegistrationError(await hostError(response, chain));
	}
	let answer: Record<string, unknown>;
	try {
		answer = (await response.json()) as Record<string, unknown>;
	} catch (error) {
		throw new HandleRegistrationError(UNREADABLE, { cause: error });
	}
	if (typeof answer.username === "string" && answer.username !== username) {
		throw new HandleRegistrationError(nameMismatch(username, answer.username));
	}
	const cert = answer.certificate;
	if (cert === undefined) {
		throw new HandleRegistrationError(noCertificate(username));
	}
	if (!isDirectCertificate(cert)) {
		throw new HandleRegistrationError(UNREADABLE);
	}
	return verifyAndFile(cert, { username, domain, certifier }, account, deps);
}

/**
 * skein-onboard's registration signature: `createSignature` under
 * `[2, "skein register"]`, key ID the username, counterparty anyone, over the
 * UTF-8 text `register <username>@<domain>` (skein-onboard `registerText`,
 * skein `docs/MESSAGES.md` "Registering a handle"), with the account's own
 * key. DER bytes as hex.
 */
export async function skeinRegistrationSignature(
	wallet: Pick<WalletInterface, "createSignature">,
	username: string,
	domain: string,
): Promise<string> {
	const { signature } = await wallet.createSignature({
		protocolID: [2, "skein register"],
		keyID: username,
		counterparty: "anyone",
		data: Utils.toArray(`register ${username}@${domain}`, "utf8"),
	});
	return Utils.toHex(signature);
}

/**
 * The skein host's answer, `certificate` (the BRC-52 certificate with its
 * encrypted fields) and `keyringForSubject` beside it, as the direct
 * `acquireCertificate` 1sat-accounts `registerHandle` makes from it (iOS
 * `acquireRequest(fromSkeinCertificate:)`). It must be a handle certificate
 * whose subject is this account; its certifier is checked in `verifyAndFile`.
 */
export function directFromSkeinCertificate(
	certificate: Record<string, unknown>,
	keyringForSubject: unknown,
	identityKey: string,
): DirectCertificate {
	const subject = certificate.subject;
	if (
		certificate.type !== HANDLE_CERT_TYPE ||
		typeof subject !== "string" ||
		subject.toLowerCase() !== identityKey.toLowerCase()
	) {
		console.error("[handles] the skein certificate's type or subject differs", {
			type: certificate.type,
			subject,
		});
		throw new HandleRegistrationError(BAD_CERTIFICATE);
	}
	const direct = {
		type: certificate.type,
		certifier: certificate.certifier,
		acquisitionProtocol: "direct",
		fields: certificate.fields,
		serialNumber: certificate.serialNumber,
		revocationOutpoint: certificate.revocationOutpoint,
		signature: certificate.signature,
		keyringRevealer: "certifier",
		keyringForSubject,
		subject,
	};
	if (!isDirectCertificate(direct)) {
		console.error("[handles] the skein certificate is missing parts", {
			certificate,
			hasKeyring: keyringForSubject !== undefined && keyringForSubject !== null,
		});
		throw new HandleRegistrationError(UNREADABLE);
	}
	return direct;
}

/**
 * Testnet: the signed registration at a skein host. A wallet that already
 * holds a certificate for this handle at the host's domain from the host's
 * certifier, whatever its serial, has it registered: nothing is posted. A
 * skein host issues a new serial on every registration of the same key and
 * name, so posting again would file a second certificate for one handle.
 */
async function registerAtSkeinHost(
	username: string,
	handleDomain: string,
	account: { wallet: RegistrationWallet; chain: Chain; identityKey: string },
	deps: HandleRegistrationDeps,
): Promise<string> {
	const { chain, identityKey, wallet } = account;
	const { origin, domain } = await skeinHostOf(handleDomain, deps);
	const certifier = await skeinCertifierKeyOf(origin, deps);
	const handle = formatHandle({ handle: username, domain });

	try {
		const held = await (deps.listHandles ?? listHandles)(wallet);
		if (
			held.some(
				(h) =>
					h.handle === username &&
					h.domain === domain &&
					h.certifier.toLowerCase() === certifier,
			)
		) {
			return handle;
		}
	} catch (error) {
		// A listing that fails reads as none, so the host is asked.
		console.error(
			"[handles] listing this account's handles before registering failed",
			{
				chain,
				error,
			},
		);
	}

	let signature: string;
	try {
		signature = await skeinRegistrationSignature(wallet, username, domain);
	} catch (error) {
		console.error("[handles] signing the registration failed", {
			chain,
			error,
		});
		throw new HandleRegistrationError(
			"This wallet couldn't sign the registration. Nothing was registered.",
			{ cause: error },
		);
	}
	const response = await postRegistration(
		`${origin}/account/register`,
		JSON.stringify({ username, identityKey, signature }),
		wallet,
		deps,
	);
	// 1sat-accounts `register` takes 200 only.
	if (response.status !== 200) {
		throw new HandleRegistrationError(
			await skeinHostError(response, chain, origin),
		);
	}
	const text = await response.text().catch((error: unknown) => {
		console.error("[handles] reading the registration answer failed", {
			error,
		});
		return "";
	});
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		console.error("[handles] the registration answer is not a JSON object", {
			chain,
			host: origin,
			body: text.slice(0, 2_000),
		});
		throw new HandleRegistrationError(UNREADABLE);
	}
	const answer = parsed as Record<string, unknown>;
	if (typeof answer.handle === "string" && answer.handle !== username) {
		throw new HandleRegistrationError(nameMismatch(username, answer.handle));
	}
	if (typeof answer.domain === "string" && answer.domain !== domain) {
		console.error("[handles] the registration answer names another domain", {
			chain,
			expected: domain,
			answered: answer.domain,
		});
		throw new HandleRegistrationError(BAD_CERTIFICATE);
	}
	const certificate = answer.certificate;
	if (
		!certificate ||
		typeof certificate !== "object" ||
		Array.isArray(certificate)
	) {
		throw new HandleRegistrationError(noCertificate(username));
	}
	const cert = directFromSkeinCertificate(
		certificate as Record<string, unknown>,
		answer.keyringForSubject,
		identityKey,
	);
	return verifyAndFile(cert, { username, domain, certifier }, account, deps);
}

/**
 * What the toolbox's direct acquire checks, plus: from the host's published
 * certifier, naming the handle just asked for at the host's domain. Then the
 * certificate is filed, unless the wallet already holds it.
 */
async function verifyAndFile(
	cert: DirectCertificate,
	expected: { username: string; domain: string; certifier: string },
	account: { wallet: RegistrationWallet; chain: Chain; identityKey: string },
	deps: HandleRegistrationDeps,
): Promise<string> {
	const { chain, identityKey, wallet } = account;
	const { username, domain, certifier } = expected;
	const handle = formatHandle({ handle: username, domain });
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
		} catch (error) {
			// A listing that fails reads as not held; storage has the last word.
			console.error("[handles] listing this account's handles failed", {
				chain,
				error,
			});
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

import { signRequest } from "@1sat/connect";
import { Hash, SignedMessage, Utils, type WalletInterface } from "@bsv/sdk";

const { toArray, toHex } = Utils;

export const P2P_COMMAND_VERSION = 1;
export const P2P_COMMAND_DOMAIN = "1satwallet.com";
export const P2P_COMMAND_TTL_MS = 2 * 60 * 1000;

export type P2PAction =
	| "inbox.open"
	| "request.create"
	| "request.accept"
	| "request.decline"
	| "request.cancel"
	| "session.offer"
	| "session.cancel";

export interface P2PCommand<T = unknown> {
	v: typeof P2P_COMMAND_VERSION;
	domain: typeof P2P_COMMAND_DOMAIN;
	action: P2PAction;
	identityKey: string;
	nonce: string;
	issuedAt: number;
	expiresAt: number;
	payload: T;
}

export interface SignedP2PCommand {
	body: string;
	signature: string;
}

const IDENTITY_KEY = /^(02|03)[0-9a-f]{64}$/;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isIdentityKey(value: unknown): value is string {
	return typeof value === "string" && IDENTITY_KEY.test(value.toLowerCase());
}

export function parseP2PCommand(
	body: string,
	expectedAction: P2PAction,
	now = Date.now(),
): P2PCommand {
	if (body.length === 0 || body.length > 24_000) {
		throw new Error("Invalid signed command size");
	}
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		throw new Error("Invalid signed command");
	}
	if (!value || typeof value !== "object") {
		throw new Error("Invalid signed command");
	}
	const command = value as Partial<P2PCommand>;
	if (
		command.v !== P2P_COMMAND_VERSION ||
		command.domain !== P2P_COMMAND_DOMAIN ||
		command.action !== expectedAction ||
		!isIdentityKey(command.identityKey) ||
		typeof command.nonce !== "string" ||
		!UUID.test(command.nonce) ||
		typeof command.issuedAt !== "number" ||
		!Number.isSafeInteger(command.issuedAt) ||
		typeof command.expiresAt !== "number" ||
		!Number.isSafeInteger(command.expiresAt) ||
		command.issuedAt > now + 30_000 ||
		command.expiresAt <= now ||
		command.expiresAt - command.issuedAt > P2P_COMMAND_TTL_MS ||
		!("payload" in command)
	) {
		throw new Error("Invalid or expired signed command");
	}
	return {
		...(command as P2PCommand),
		identityKey: command.identityKey.toLowerCase(),
	};
}

export function verifyP2PCommand(
	signed: SignedP2PCommand,
	expectedAction: P2PAction,
	now = Date.now(),
): P2PCommand {
	const command = parseP2PCommand(signed.body, expectedAction, now);
	const [claimedIdentity, scheme, timestamp, requestPath, signatureBase64] =
		signed.signature.split("|");
	const expectedPath = `/p2p/${expectedAction}`;
	const signedAt = Date.parse(timestamp ?? "");
	if (
		claimedIdentity?.toLowerCase() !== command.identityKey ||
		scheme !== "brc77" ||
		requestPath !== expectedPath ||
		!Number.isFinite(signedAt) ||
		signedAt < command.issuedAt - 30_000 ||
		signedAt > command.expiresAt ||
		!signatureBase64
	) {
		throw new Error("Invalid command authentication");
	}
	let envelope: number[];
	try {
		envelope = toArray(signatureBase64, "base64");
	} catch {
		throw new Error("Invalid command signature");
	}
	if (
		envelope.length < 4 + 33 + 1 + 32 + 8 ||
		toHex(envelope.slice(0, 4)) !== "42423301" ||
		toHex(envelope.slice(4, 37)).toLowerCase() !== command.identityKey ||
		envelope[37] !== 0
	) {
		throw new Error("Invalid command signer");
	}
	let valid = false;
	try {
		const bodyHash = toHex(Hash.sha256(toArray(signed.body, "utf8")));
		const message = `${expectedPath}|${timestamp}|${bodyHash}`;
		valid = SignedMessage.verify(toArray(message, "utf8"), envelope);
	} catch {
		valid = false;
	}
	if (!valid) throw new Error("Invalid command signature");
	return command;
}

export async function signP2PCommand<T>(
	wallet: WalletInterface,
	action: P2PAction,
	payload: T,
): Promise<SignedP2PCommand> {
	const { publicKey } = await wallet.getPublicKey({ identityKey: true });
	if (!isIdentityKey(publicKey)) {
		throw new Error("The wallet did not provide a valid identity key");
	}
	const issuedAt = Date.now();
	const command: P2PCommand<T> = {
		v: P2P_COMMAND_VERSION,
		domain: P2P_COMMAND_DOMAIN,
		action,
		identityKey: publicKey.toLowerCase(),
		nonce: crypto.randomUUID(),
		issuedAt,
		expiresAt: issuedAt + P2P_COMMAND_TTL_MS,
		payload,
	};
	const body = JSON.stringify(command);
	return {
		body,
		signature: await signRequest(wallet, `/p2p/${action}`, body),
	};
}

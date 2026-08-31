import type { SignedP2PCommand } from "./p2p-auth";
import { isIdentityKey, verifyP2PCommand } from "./p2p-auth";

export const PRESENCE_ROOM_ID = "landing";
export const PRESENCE_ANNOUNCEMENT_REFRESH_MS = 60_000;

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_PROFILE_SOURCES: readonly unknown[] = [
	"bap",
	"certificate",
	"profile",
];
const PUBLIC_OUTPOINT = /^[0-9a-f]{64}_[0-9]+$/;

export type PresenceChain = "main" | "test";
export type PublicProfileSource = "bap" | "certificate" | "profile";

export interface PublicProfileClaim {
	displayName?: string;
	avatarUrl?: string;
	source: PublicProfileSource;
	sourceReference?: string;
}

export interface PresenceAnnouncementPayload {
	chain: PresenceChain;
	sessionId: string;
	userId: string;
	publicProfile?: PublicProfileClaim;
}

export interface AuthenticatedPresenceAnnouncement {
	identityKey: string;
	nonce: string;
	issuedAt: number;
	expiresAt: number;
	payload: PresenceAnnouncementPayload;
}

export interface PublicPresenceIdentity {
	userId: string;
	identityKey: string;
	chain: PresenceChain;
	label: string;
	verification: "wallet-signature";
	expiresAt: number;
	profile?: PublicProfileClaim & { verification: "unverified" };
}

export interface StoredPresenceAnnouncement {
	identityKey: string;
	chain: PresenceChain;
	sessionId: string;
	expiresAt: number;
}

function object(value: unknown, message: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(message);
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	message: string,
) {
	if (Object.keys(value).some((key) => !allowed.includes(key))) {
		throw new Error(message);
	}
}

function boundedText(value: unknown, limit: number, field: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > limit ||
		value.trim() !== value ||
		Array.from(value).some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 32 || codePoint === 127;
		})
	) {
		throw new Error(`Invalid ${field}`);
	}
	return value;
}

function safeHttpsUrl(value: unknown, field: string): string {
	const text = boundedText(value, 512, field);
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new Error(`Invalid ${field}`);
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error(`Invalid ${field}`);
	}
	// Presence is public. Remove query/fragment material that can carry bearer
	// tokens, tracking IDs, or other data that should not enter Convex.
	url.search = "";
	url.hash = "";
	return url.toString();
}

function safeSourceReference(value: unknown): string {
	const text = boundedText(value, 256, "sourceReference");
	if (PUBLIC_OUTPOINT.test(text.toLowerCase())) return text.toLowerCase();
	return safeHttpsUrl(text, "sourceReference");
}

function parsePublicProfile(value: unknown): PublicProfileClaim {
	const profile = object(value, "Invalid public profile claim");
	exactKeys(
		profile,
		["displayName", "avatarUrl", "source", "sourceReference"],
		"Invalid public profile claim",
	);
	if (!PUBLIC_PROFILE_SOURCES.includes(profile.source)) {
		throw new Error("Invalid public profile source");
	}
	const result: PublicProfileClaim = {
		source: profile.source as PublicProfileSource,
	};
	if (profile.displayName !== undefined) {
		result.displayName = boundedText(profile.displayName, 64, "displayName");
	}
	if (profile.avatarUrl !== undefined) {
		result.avatarUrl = safeHttpsUrl(profile.avatarUrl, "avatarUrl");
	}
	if (profile.sourceReference !== undefined) {
		result.sourceReference = safeSourceReference(profile.sourceReference);
	}
	return result;
}

export function truncatePresenceIdentity(identityKey: string): string {
	return `${identityKey.slice(0, 6)}…${identityKey.slice(-4)}`;
}

export function getWalletPresenceUserId(
	identityKey: string,
	chain: PresenceChain,
	sessionId: string,
): string {
	const canonicalIdentity = identityKey.toLowerCase();
	const canonicalSession = sessionId.toLowerCase();
	if (!isIdentityKey(canonicalIdentity) || !UUID.test(canonicalSession)) {
		throw new Error("Invalid wallet presence identity");
	}
	return `wallet:${chain}:${canonicalIdentity}:${canonicalSession}`;
}

export function parseWalletPresenceUserId(userId: string): {
	chain: PresenceChain;
	identityKey: string;
	sessionId: string;
} | null {
	const [kind, chain, identityKey, sessionId, extra] = userId.split(":");
	if (
		kind !== "wallet" ||
		extra !== undefined ||
		(chain !== "main" && chain !== "test") ||
		!isIdentityKey(identityKey) ||
		!sessionId ||
		!UUID.test(sessionId)
	) {
		return null;
	}
	return { chain, identityKey, sessionId };
}

export function isActiveWalletPresence(
	userId: string,
	announcement: StoredPresenceAnnouncement | null,
	now = Date.now(),
): boolean {
	const parsed = parseWalletPresenceUserId(userId);
	return Boolean(
		announcement &&
			parsed &&
			announcement.expiresAt > now &&
			announcement.identityKey === parsed.identityKey &&
			announcement.chain === parsed.chain &&
			announcement.sessionId === parsed.sessionId,
	);
}

export function parsePresenceAnnouncementPayload(
	value: unknown,
	identityKey: string,
): PresenceAnnouncementPayload {
	const payload = object(value, "Invalid presence announcement");
	exactKeys(
		payload,
		["chain", "sessionId", "userId", "publicProfile"],
		"Invalid presence announcement",
	);
	if (payload.chain !== "main" && payload.chain !== "test") {
		throw new Error("Invalid presence chain");
	}
	const sessionId = boundedText(
		payload.sessionId,
		64,
		"presence session",
	).toLowerCase();
	if (!UUID.test(sessionId)) throw new Error("Invalid presence session");
	const userId = boundedText(payload.userId, 256, "presence user ID");
	const expectedUserId = getWalletPresenceUserId(
		identityKey,
		payload.chain,
		sessionId,
	);
	if (userId !== expectedUserId) {
		throw new Error("Presence identity does not match the command signer");
	}
	return {
		chain: payload.chain,
		sessionId,
		userId,
		...(payload.publicProfile === undefined
			? {}
			: { publicProfile: parsePublicProfile(payload.publicProfile) }),
	};
}

export async function authenticatePresenceAnnouncement(
	signed: SignedP2PCommand,
	consumeNonce: (
		announcement: AuthenticatedPresenceAnnouncement,
	) => Promise<boolean>,
	now = Date.now(),
): Promise<AuthenticatedPresenceAnnouncement> {
	const command = verifyP2PCommand(signed, "presence.announce", now);
	const announcement: AuthenticatedPresenceAnnouncement = {
		identityKey: command.identityKey,
		nonce: command.nonce,
		issuedAt: command.issuedAt,
		expiresAt: command.expiresAt,
		payload: parsePresenceAnnouncementPayload(
			command.payload,
			command.identityKey,
		),
	};
	if (!(await consumeNonce(announcement))) {
		throw new Error("Presence announcement was already used");
	}
	return announcement;
}

export function publicPresenceIdentity(
	announcement: AuthenticatedPresenceAnnouncement,
): PublicPresenceIdentity {
	return {
		userId: announcement.payload.userId,
		identityKey: announcement.identityKey,
		chain: announcement.payload.chain,
		label: truncatePresenceIdentity(announcement.identityKey),
		verification: "wallet-signature",
		expiresAt: announcement.expiresAt,
		...(announcement.payload.publicProfile
			? {
					profile: {
						...announcement.payload.publicProfile,
						verification: "unverified" as const,
					},
				}
			: {}),
	};
}

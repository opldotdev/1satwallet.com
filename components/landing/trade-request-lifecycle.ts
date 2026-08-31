export const INBOX_RENEWAL_LEAD_MS = 5 * 60 * 1000;

export function inboxRenewalDelay(expiresAt: number, now = Date.now()): number {
	return Math.max(1_000, expiresAt - now - INBOX_RENEWAL_LEAD_MS);
}

interface RecoverableSession {
	sessionId: string;
	initiatorIdentity: string;
	participantIdentity: string;
}

export function recoverActiveSession(
	session: RecoverableSession | null | undefined,
	identityKey: string,
): { sessionId: string; peerIdentity: string } | null {
	if (!session) return null;
	if (session.initiatorIdentity === identityKey) {
		return {
			sessionId: session.sessionId,
			peerIdentity: session.participantIdentity,
		};
	}
	if (session.participantIdentity === identityKey) {
		return {
			sessionId: session.sessionId,
			peerIdentity: session.initiatorIdentity,
		};
	}
	return null;
}

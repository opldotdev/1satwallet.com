import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("landing presence restoration", () => {
	it("adds presence without replacing the current CWI schema", () => {
		const schema = read("convex/schema.ts");
		const config = read("convex/convex.config.ts");

		for (const currentCwiContract of [
			"cwiAuthRequests: defineTable",
			"cwiAuthCodes: defineTable",
			'.index("by_requestId", ["requestId"])',
			'.index("by_expiresAt", ["expiresAt"])',
		]) {
			assert.ok(
				schema.includes(currentCwiContract),
				`missing current CWI schema contract: ${currentCwiContract}`,
			);
		}

		assert.match(config, /@convex-dev\/presence\/convex\.config\.js/);
		assert.match(config, /\.use\(presence\)/);
		assert.match(schema, /p2pRequests:\s*defineTable/);
		assert.match(schema, /p2pSessions:\s*defineTable/);
	});

	it("derives a floor identity only for a valid wallet key", async () => {
		const { getPresenceUserId } = await import(
			"../components/landing/shared-presence"
		);
		const identityKey = `02${"AB".repeat(32)}`;
		const canonicalIdentityKey = identityKey.toLowerCase();
		const firstDocumentId = "11111111-1111-4111-8111-111111111111";
		const secondDocumentId = "22222222-2222-4222-8222-222222222222";

		assert.equal(
			getPresenceUserId(identityKey, firstDocumentId),
			`wallet:main:${canonicalIdentityKey}:${firstDocumentId}`,
		);
		assert.equal(
			getPresenceUserId(identityKey, firstDocumentId, "test"),
			`wallet:test:${canonicalIdentityKey}:${firstDocumentId}`,
		);
		assert.equal(getPresenceUserId(null, firstDocumentId), null);
		assert.equal(getPresenceUserId("not-a-key", firstDocumentId), null);
		assert.notEqual(
			getPresenceUserId(identityKey, firstDocumentId),
			getPresenceUserId(identityKey, secondDocumentId),
		);
	});

	it("uses the provider-neutral identity key and does not recover raw-key or Sigma auth", () => {
		const presence = read("components/landing/shared-presence.tsx");
		const provider = read("providers/wallet-toolbox-provider.tsx");
		const packageManifest = read("package.json");

		assert.match(presence, /useWalletToolbox/);
		assert.match(presence, /\bidentityKey\b/);
		assert.match(
			presence,
			/getPresenceUserId\(identityKey,\s*sessionId,\s*chain\)/,
		);
		assert.match(provider, /identityKey:\s*string\s*\|\s*null/);
		assert.doesNotMatch(presence, /sessionStorage|localStorage/);
		assert.match(presence, /crypto\.randomUUID\(\)/);
		assert.match(presence, /connectionStatus\s*===\s*"ready"/);
		assert.match(presence, /<LiveFloor/);
		assert.match(presence, /userId=\{floor\.userId\}/);

		for (const forbidden of [
			"useAuth",
			"walletKeys",
			"ordPk",
			"wifToAddress",
			"accessToken",
			"Sigma",
			"sigma",
		]) {
			assert.equal(
				presence.includes(forbidden),
				false,
				`presence reintroduced forbidden legacy path: ${forbidden}`,
			);
		}
		assert.doesNotMatch(
			packageManifest,
			/@sigma-auth\/|"better-auth"|"sigma-avatars"/,
		);
		assert.equal(existsSync(join(root, "providers/auth-provider.tsx")), false);
		assert.equal(existsSync(join(root, "app/auth/sigma")), false);
	});

	it("mounts one Convex provider, presence, and the restored trade listener", () => {
		const layout = read("app/layout.tsx");
		const convexProvider = read("app/ConvexClientProvider.tsx");
		const hero = read("components/landing/hero.tsx");

		assert.match(layout, /import\s*\{\s*ConvexClientProvider\s*\}/);
		assert.equal(layout.match(/<ConvexClientProvider>/g)?.length, 1);
		assert.equal(layout.match(/<\/ConvexClientProvider>/g)?.length, 1);
		assert.match(convexProvider, /NEXT_PUBLIC_CONVEX_URL/);
		assert.match(convexProvider, /<ConvexProvider\s+client=\{convex\}>/);
		assert.match(hero, /import\s*\{\s*SharedPresence,\s*useLandingFloor\s*\}/);
		assert.equal(hero.match(/<SharedPresence floor=\{floor\} \/>/g)?.length, 1);

		for (const restoredTradeUi of [
			"components/landing/trade-request-listener.tsx",
			"components/landing/trade-dialog.tsx",
			"components/landing/inventory-selector.tsx",
			"convex/p2p.ts",
		]) {
			assert.equal(existsSync(join(root, restoredTradeUi)), true);
		}
		assert.match(hero, /TradeRequestListener/);
	});

	it("pins the package protocol and validates visual-only presence input", () => {
		const manifest = read("package.json");
		const server = read("convex/presence.ts");
		const generatedApi = read("convex/_generated/api.d.ts");

		assert.equal(
			JSON.parse(manifest).dependencies["@convex-dev/presence"],
			"0.4.0",
		);
		assert.match(server, /const ROOM_ID = PRESENCE_ROOM_ID/);
		assert.match(server, /const HEARTBEAT_INTERVAL = 10_000/);
		assert.match(server, /const WALLET_USER_ID/);
		assert.doesNotMatch(server, /anon:/);
		assert.match(server, /Connect a wallet to join the trading floor/);
		assert.match(
			server,
			/export const listPublicIdentities = query[\s\S]*handler: async \(\) => \[\]/,
		);
		assert.match(
			server,
			/handler: async \(ctx, \{ roomId, userId, sessionId \}\) =>/,
		);
		assert.match(
			server,
			/presence\.heartbeat\([\s\S]*HEARTBEAT_INTERVAL,[\s\S]*\)/,
		);
		assert.match(server, /export const disconnect = mutation/);
		assert.match(server, /Presence is deliberately visual-only/);
		assert.match(server, /requireActiveWalletAnnouncement/);
		assert.match(server, /authenticatePresenceAnnouncement/);
		assert.doesNotMatch(server, /api\.(?:trades|authenticatedTrades)/);
		assert.match(generatedApi, /presence:\s*typeof presence/);
		assert.match(generatedApi, /ComponentApi<"presence">/);
	});

	it("shows the floor only to a signed-in wallet, with cursors on desktop and a peer sheet on touch", () => {
		const presence = read("components/landing/shared-presence.tsx");

		// Same-network, online, signed peers only (lib/p2p-floor floorPeers).
		assert.match(presence, /floorPeers\(/);
		assert.match(presence, /hidden[^"]*md:block/);
		assert.match(presence, /\[@media\(pointer:coarse\)\]:hidden/);
		assert.match(presence, /motion-safe:transition-/);
		assert.doesNotMatch(presence, /(?<!motion-safe:)animate-(pulse|ping|spin)/);
		// The floor bar and peer sheet work on every screen with 44px targets.
		assert.match(presence, /data-testid="floor-bar"/);
		assert.match(
			presence,
			/pb-\[max\(--spacing\(3\),env\(safe-area-inset-bottom\)\)\]/,
		);
		assert.match(presence, /min-h-11/);
		assert.match(presence, /side="bottom"/);
		assert.match(presence, /You're visible as/);
		assert.match(presence, /Leave the floor/);
		assert.match(presence, /Rejoin/);
		// A trade request is confirmed before the wallet signs it.
		assert.match(
			presence,
			/Ask \{confirming \? peerName\(confirming\) : ""\} to trade\?/,
		);
		assert.match(presence, /Send request/);
		assert.match(presence, /publicProfileClaimFromWallet/);
		assert.match(presence, /profileLoaded/);
		assert.match(presence, /profile\?\.displayName/);
		assert.match(presence, /PeerContextMenu/);
		assert.match(presence, /Request trade/);
		assert.match(presence, /Copy identity key/);
		// Failures are reported, not swallowed.
		assert.match(presence, /reportFailure\(/);
		assert.doesNotMatch(presence, /catch\(\(\) => undefined\)/);
		assert.doesNotMatch(presence, /listPublicIdentities/);
	});

	it("stacks trade offers on narrow screens and restores two columns at a breakpoint", () => {
		const dialog = read("components/landing/trade-dialog.tsx");

		assert.match(dialog, /grid-cols-1/);
		assert.match(dialog, /sm:grid-cols-2/);
		assert.match(dialog, /overflow-y-auto/);
		assert.match(dialog, /max-h-\[90dvh\]/);
		assert.match(dialog, /w-\[calc\(100vw-2rem\)\]/);
		assert.match(dialog, /flex-col[\s\S]*sm:flex-row/);
	});

	it("owns recurring timers and binds authentication to the wallet that signed it", () => {
		const presence = read("components/landing/shared-presence.tsx");
		const listener = read("components/landing/trade-request-listener.tsx");

		assert.match(
			presence,
			/cancelled = true;\s*if \(refreshTimer\) clearTimeout\(refreshTimer\)/,
		);
		assert.match(
			listener,
			/cancelled = true;\s*if \(timer\) clearTimeout\(timer\)/,
		);
		assert.match(presence, /export function useLandingFloor/);
		assert.match(presence, /setAnnounced\(\{\s*userId,\s*wallet,/);
		assert.match(presence, /announced\?\.wallet === wallet/);
	});
});

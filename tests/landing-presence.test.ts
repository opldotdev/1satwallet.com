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

	it("derives stable, distinct anonymous and connected session identities", async () => {
		const { getPresenceLabel, getPresenceUserId } = await import(
			"../components/landing/shared-presence"
		);
		const identityKey = `02${"AB".repeat(32)}`;
		const canonicalIdentityKey = identityKey.toLowerCase();
		const firstDocumentId = "11111111-1111-4111-8111-111111111111";
		const secondDocumentId = "22222222-2222-4222-8222-222222222222";

		assert.equal(
			getPresenceUserId(identityKey, firstDocumentId),
			`wallet:main:${canonicalIdentityKey}`,
		);
		assert.equal(
			getPresenceUserId(identityKey, firstDocumentId, "test"),
			`wallet:test:${canonicalIdentityKey}`,
		);
		assert.equal(
			getPresenceUserId(null, firstDocumentId),
			`anon:${firstDocumentId}`,
		);
		assert.equal(
			getPresenceUserId("not-a-key", firstDocumentId),
			`anon:${firstDocumentId}`,
		);
		assert.notEqual(
			getPresenceUserId(null, firstDocumentId),
			getPresenceUserId(null, secondDocumentId),
		);
		assert.equal(
			getPresenceUserId(identityKey, firstDocumentId),
			getPresenceUserId(identityKey, secondDocumentId),
		);
		assert.equal(getPresenceLabel(null, firstDocumentId), "Guest 1111");
		assert.match(
			getPresenceLabel(identityKey, firstDocumentId),
			/^02abab…abab$/i,
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
			/getPresenceUserId\(identityKey,\s*anonymousId,\s*chain\)/,
		);
		assert.match(provider, /identityKey:\s*string\s*\|\s*null/);
		assert.doesNotMatch(presence, /sessionStorage|localStorage/);
		assert.match(presence, /crypto\.randomUUID\(\)/);
		assert.match(presence, /connectionStatus\s*===\s*"authenticating"/);
		assert.match(
			presence,
			/<PresenceLayer\s+key=\{userId\}\s+userId=\{userId\}/,
		);

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
		assert.match(hero, /import\s*\{\s*SharedPresence\s*\}/);
		assert.equal(hero.match(/<SharedPresence\s*\/>/g)?.length, 1);

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
		assert.match(server, /const ROOM_ID = "landing"/);
		assert.match(server, /const HEARTBEAT_INTERVAL = 10_000/);
		assert.match(
			server,
			/\^wallet:\(main\|test\):\(02\|03\)\[0-9a-f\]\{64\}\$/,
		);
		assert.match(server, /\^anon:\[0-9a-f\]\{8\}/);
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
		assert.doesNotMatch(server, /api\.(?:trades|authenticatedTrades)/);
		assert.match(generatedApi, /presence:\s*typeof presence/);
		assert.match(generatedApi, /ComponentApi<"presence">/);
	});

	it("counts only live peers and keeps cursors mobile- and motion-safe", () => {
		const presence = read("components/landing/shared-presence.tsx");

		assert.match(
			presence,
			/presenceState\?\.filter\(\(entry\) => entry\.online\)/,
		);
		assert.match(presence, /hidden[^"]*md:block/);
		assert.match(presence, /motion-safe:transition-/);
		assert.match(presence, /startTrade/);
		assert.match(presence, /BRC-100/);
		assert.doesNotMatch(presence, /(?<!motion-safe:)animate-pulse/);
	});
});

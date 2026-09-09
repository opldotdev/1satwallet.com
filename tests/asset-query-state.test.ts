import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assetSurfaceFromCount,
	describeAssetSurface,
	shouldQueryAssetSurface,
} from "@/lib/wallet/asset-query-state";

describe("asset query states", () => {
	it("does not treat contract-only providers as an empty wallet", () => {
		assert.equal(shouldQueryAssetSurface("contract-only"), false);
		assert.equal(shouldQueryAssetSurface("provider-managed"), false);
		assert.equal(shouldQueryAssetSurface("unsupported"), false);
		assert.equal(shouldQueryAssetSurface("supported"), true);
		assert.equal(
			describeAssetSurface(
				{ kind: "unsupported", capability: "contract-only" },
				"inscription",
			),
			"Not exposed by this wallet",
		);
		assert.equal(
			describeAssetSurface(
				{ kind: "unsupported", capability: "provider-managed" },
				"token",
			),
			"Managed by connected wallet",
		);
	});

	it("keeps empty, ready, and transport-failed copy distinct", () => {
		assert.equal(assetSurfaceFromCount(0).kind, "empty");
		assert.deepEqual(assetSurfaceFromCount(2), { kind: "ready", count: 2 });
		assert.equal(
			describeAssetSurface({ kind: "empty" }, "inscription"),
			"No inscriptions",
		);
		assert.equal(
			describeAssetSurface({ kind: "ready", count: 1 }, "inscription"),
			"1 inscription",
		);
		assert.equal(
			describeAssetSurface({ kind: "error", message: "auth" }, "token"),
			"Couldn't load. Try again.",
		);
	});
});

import type { CapabilityState } from "@/lib/wallet/provider-capabilities";

export type AssetSurfaceState =
	| { kind: "unsupported"; capability: CapabilityState }
	| { kind: "empty" }
	| { kind: "ready"; count: number }
	| { kind: "error"; message: string };

export function shouldQueryAssetSurface(capability: CapabilityState): boolean {
	return capability === "supported";
}

export function describeAssetSurface(
	state: AssetSurfaceState,
	noun: string,
): string {
	switch (state.kind) {
		case "unsupported":
			if (state.capability === "provider-managed") {
				return "Managed by connected wallet";
			}
			if (state.capability === "contract-only") {
				return "Not exposed by this wallet";
			}
			return "Not available from this wallet";
		case "empty":
			return `No ${noun}s`;
		case "ready":
			return `${state.count} ${noun}${state.count === 1 ? "" : "s"}`;
		case "error":
			return "Couldn't load. Try again.";
	}
}

export function assetSurfaceFromCount(count: number): AssetSurfaceState {
	return count === 0 ? { kind: "empty" } : { kind: "ready", count };
}

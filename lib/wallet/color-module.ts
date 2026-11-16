/**
 * The 1Color (BRC-207) permission module, registered under `p color` on chains
 * that have a color overlay (testnet). Mirrors Yours (1color branch)
 * `src/initWallet.ts` step 4b.
 */

import { createContext, type OneSatContext } from "@1sat/actions";
import type { OneSatServices } from "@1sat/client";
import type { PromptHandler } from "@1sat/permission-module";
import type { IPermissionStore } from "@1sat/wallet-browser";
import {
	type ColorPermissionModule,
	createColorModule,
} from "@bsv/color-permission-module";
import type { WalletInterface } from "@bsv/sdk";
import {
	type Chain,
	endpointsOf,
	isOneColorAvailable,
} from "@/lib/chain-endpoints";
import {
	colorPermissionStore,
	createColorTokenAccessHandler,
} from "@/lib/cwi/color-consent";
import { type ColorOverlay, createColorOverlayProvider } from "./color-overlay";
import { withOriginator } from "./with-originator";

export interface WalletColorModule {
	/**
	 * The module the permissions manager registers under `color`, also used
	 * for host-only calls such as `markSettled`.
	 */
	module: ColorPermissionModule;
	overlay: ColorOverlay;
}

/**
 * The color module and its overlay, or null when the chain has no color
 * overlay (mainnet). `wallet` is the raw wallet the permissions manager wraps,
 * never the manager itself. The wallet itself (`adminOriginator`, exact
 * match) is approved without a prompt; apps get the color consent in
 * `lib/cwi/color-consent.ts`, asked through `promptHandler`, with basket
 * grants kept in `permissionStore` (this chain's color grant store unless a
 * caller passes another).
 */
export function createWalletColorModule(options: {
	wallet: WalletInterface;
	chain: Chain;
	adminOriginator: string;
	promptHandler: PromptHandler;
	permissionStore?: IPermissionStore;
}): WalletColorModule | null {
	if (!isOneColorAvailable(options.chain)) return null;
	const overlay = createColorOverlayProvider({
		defaultOrigin: endpointsOf(options.chain).colorOverlay,
		getOverrides: async () => [],
	});
	const module = createColorModule({
		wallet: options.wallet,
		provider: overlay,
		requestTokenAccess: createColorTokenAccessHandler({
			promptHandler: options.promptHandler,
			permissionStore:
				options.permissionStore ?? colorPermissionStore(options.chain),
			adminOriginator: options.adminOriginator,
		}),
	});
	return { module, overlay };
}

/**
 * The action context for every 1Color write and the inbox: the permissions
 * manager bound to the admin originator, so `p color` labels and baskets reach
 * the module and metadata is encrypted like every other manager write.
 */
export function createColorContext(
	permissionsManager: WalletInterface,
	options: {
		adminOriginator: string;
		chain: Chain;
		services?: OneSatServices;
	},
): OneSatContext {
	return createContext(
		withOriginator(permissionsManager, options.adminOriginator),
		{ chain: options.chain, services: options.services },
	);
}

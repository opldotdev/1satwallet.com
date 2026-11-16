/**
 * The 1Color (BRC-207) permission module, registered under `p color` on chains
 * that have a color overlay (testnet). Mirrors Yours (1color branch)
 * `src/initWallet.ts` step 4b.
 */

import { createContext, type OneSatContext } from "@1sat/actions";
import type { OneSatServices } from "@1sat/client";
import {
	type ColorPermissionModule,
	type ColorTokenAccessHandler,
	createColorModule,
} from "@bsv/color-permission-module";
import type { WalletInterface } from "@bsv/sdk";
import {
	type Chain,
	endpointsOf,
	isOneColorAvailable,
} from "@/lib/chain-endpoints";
import { type ColorOverlay, createColorOverlayProvider } from "./color-overlay";
import { withOriginator } from "./with-originator";

export interface WalletColorModule {
	module: ColorPermissionModule;
	overlay: ColorOverlay;
}

/**
 * Consent for `p color` requests until app consent ships: the wallet itself
 * is approved, every other originator is declined (fail closed). The module
 * then throws `ColorConsentDeclinedError` to the caller.
 */
export const adminOnlyTokenAccess =
	(adminOriginator: string): ColorTokenAccessHandler =>
	async (app) =>
		app === adminOriginator;

/**
 * The color module and its overlay, or null when the chain has no color
 * overlay (mainnet). `wallet` is the raw wallet the permissions manager wraps,
 * never the manager itself.
 */
export function createWalletColorModule(options: {
	wallet: WalletInterface;
	chain: Chain;
	requestTokenAccess: ColorTokenAccessHandler;
}): WalletColorModule | null {
	if (!isOneColorAvailable(options.chain)) return null;
	const overlay = createColorOverlayProvider({
		defaultOrigin: endpointsOf(options.chain).colorOverlay,
		getOverrides: async () => [],
	});
	const module = createColorModule({
		wallet: options.wallet,
		provider: overlay,
		requestTokenAccess: options.requestTokenAccess,
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

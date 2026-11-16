/**
 * The 1Color (BRC-207) permission module, registered under `p color` on chains
 * that have a color overlay (testnet). Mirrors Yours (1color branch)
 * `src/initWallet.ts` step 4b.
 */

import { createContext, type OneSatContext } from "@1sat/actions";
import type { OneSatServices } from "@1sat/client";
import {
	ColorConsentDeclinedError,
	type ColorPermissionModule,
	type ColorTokenAccessHandler,
	createColorModule,
} from "@bsv/color-permission-module";
import type { WalletInterface } from "@bsv/sdk";
import type {
	PermissionsModule,
	PermissionsModuleNext,
	PermissionsModuleRequest,
} from "@bsv/wallet-toolbox-client";
import {
	type Chain,
	endpointsOf,
	isOneColorAvailable,
} from "@/lib/chain-endpoints";
import { type ColorOverlay, createColorOverlayProvider } from "./color-overlay";
import { withOriginator } from "./with-originator";

export interface WalletColorModule {
	/** The module itself, for host-only calls such as `markSettled`. */
	module: ColorPermissionModule;
	/** What the permissions manager registers under `color`: admin only. */
	permissionModule: AdminOnlyColorModule;
	overlay: ColorOverlay;
}

export type AdminOnlyColorModule = PermissionsModule & { dispose: () => void };

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
 * The color module as the permissions manager sees it, refusing every
 * originator but the wallet itself before the module runs. The module's own
 * consent only covers some requests (reads, signatures, relinquish, sign):
 * `getPublicKey` and `verifySignature` under a `p color` protocol pass
 * straight through, `internalizeAction` into a `p color` basket asks nothing,
 * and `createAction` with a `p color plan` label funds before it asks. This
 * gate covers every routed method, so no app reaches 1Color until app consent
 * ships.
 */
export function adminOnlyColorModule(
	module: ColorPermissionModule,
	adminOriginator: string,
): AdminOnlyColorModule {
	const allow = (req: PermissionsModuleRequest) => {
		if (req.originator !== adminOriginator)
			throw new ColorConsentDeclinedError(req.method);
	};
	return {
		capabilities: module.capabilities,
		handleRequest: async (
			req: PermissionsModuleRequest,
			next: PermissionsModuleNext,
		) => {
			allow(req);
			return await module.handleRequest(req, next);
		},
		onRequest: async (req: PermissionsModuleRequest) => {
			allow(req);
			return await module.onRequest(req);
		},
		onResponse: (res, context) => module.onResponse(res, context),
		dispose: () => module.dispose(),
	};
}

/**
 * The color module and its overlay, or null when the chain has no color
 * overlay (mainnet). `wallet` is the raw wallet the permissions manager wraps,
 * never the manager itself. Only `adminOriginator` may use it.
 */
export function createWalletColorModule(options: {
	wallet: WalletInterface;
	chain: Chain;
	adminOriginator: string;
}): WalletColorModule | null {
	if (!isOneColorAvailable(options.chain)) return null;
	const overlay = createColorOverlayProvider({
		defaultOrigin: endpointsOf(options.chain).colorOverlay,
		getOverrides: async () => [],
	});
	const module = createColorModule({
		wallet: options.wallet,
		provider: overlay,
		requestTokenAccess: adminOnlyTokenAccess(options.adminOriginator),
	});
	return {
		module,
		permissionModule: adminOnlyColorModule(module, options.adminOriginator),
		overlay,
	};
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

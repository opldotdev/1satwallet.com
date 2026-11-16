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
import type {
	PermissionsModule,
	PermissionsModuleRequest,
} from "@bsv/wallet-toolbox-client";
import {
	type Chain,
	endpointsOf,
	isOneColorAvailable,
} from "@/lib/chain-endpoints";
import {
	colorPermissionStore,
	createColorTokenAccessHandler,
} from "@/lib/cwi/color-consent";
import { clipForLog, reportDiagnostic } from "@/lib/runtime-diagnostics";
import { type ColorOverlay, createColorOverlayProvider } from "./color-overlay";
import { withOriginator } from "./with-originator";

export interface WalletColorModule {
	/** The module itself, for host-only calls such as `markSettled`. */
	module: ColorPermissionModule;
	/**
	 * What the permissions manager registers under `color`: the module, with
	 * token handoffs refused to apps (see `appGatedColorModule`).
	 */
	permissionModule: AppGatedColorModule;
	overlay: ColorOverlay;
}

export type AppGatedColorModule = PermissionsModule & { dispose: () => void };

/** BRC-177: a noSend action that expires; the color module reads it as a handoff. */
const NOSEND_EXPIRY_LABEL_PREFIX = "p nosend expiry ";

/** An app asked for a token handoff: refused before the module funds it. */
export class ColorHandoffUnavailableError extends Error {
	readonly name = "ColorHandoffUnavailableError";

	constructor() {
		super("Token handoffs are not available to apps yet.");
	}
}

const isHandoffLabel = (label: unknown): boolean =>
	typeof label === "string" &&
	label.trim().toLowerCase().startsWith(NOSEND_EXPIRY_LABEL_PREFIX);

/**
 * True for an app's `createAction` that the module would fund as a handoff.
 * A handoff that asks for less than a held output makes the module split that
 * output first (`fund` → `settleFunding` → `splitExact` → `split`), signed and
 * broadcast through the raw wallet before anyone is asked and outside the
 * manager's spending authorization and limits.
 */
const isAppHandoff = (
	req: PermissionsModuleRequest,
	adminOriginator: string,
): boolean => {
	if (req.method !== "createAction" || req.originator === adminOriginator)
		return false;
	const labels = (req.args as { labels?: unknown } | null)?.labels;
	return Array.isArray(labels) && labels.some(isHandoffLabel);
};

/**
 * The color module as the permissions manager sees it. Everything goes to the
 * module, except an app's `createAction` carrying a BRC-177 `p nosend expiry`
 * label (a token handoff), which is refused, logged, and never reaches the
 * module. The wallet itself (`adminOriginator`, exact match) keeps handoffs.
 *
 * Constraint: the manager's spending prompt is not the gate for token inputs
 * the module funds. From wallet-toolbox-client 2.17.0 the manager computes an
 * app's spend from the args after this module changed them, so inputs the
 * module adds from the wallet are subtracted from the app's spend and show as
 * "No input description provided"; the spending prompt can under-report a
 * token move. The gate is the module's `color_send` consent, asked in
 * `signAction` (`signBound`) before it signs any input it funded. The module
 * signs its funded inputs in exactly two places: `signBound`, behind that
 * consent, and the handoff `split`, which signs and broadcasts with no consent
 * at all and is therefore refused to apps here. Any new app path that funds or
 * signs module inputs must reach a `color_send` (or `color_signature`) prompt
 * before signing; `tests/color-app-funded-send.test.ts` checks the send path.
 */
export function appGatedColorModule(
	module: ColorPermissionModule,
	adminOriginator: string,
): AppGatedColorModule {
	return {
		capabilities: module.capabilities,
		handleRequest: (req, next) => module.handleRequest(req, next),
		onRequest: async (req) => {
			if (isAppHandoff(req, adminOriginator)) {
				const event = reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: "wallet.color.createAction.handoff",
					recoverable: false,
					context: { provider: "permissions-manager" },
				});
				console.error("[wallet] refused a 1Color handoff from an app", {
					correlationId: event.correlationId,
					method: req.method,
					originator:
						typeof req.originator === "string"
							? clipForLog(req.originator)
							: typeof req.originator,
				});
				throw new ColorHandoffUnavailableError();
			}
			return await module.onRequest(req);
		},
		onResponse: (res, context) => module.onResponse(res, context),
		dispose: () => module.dispose(),
	};
}

/**
 * The color module and its overlay, or null when the chain has no color
 * overlay (mainnet). `wallet` is the raw wallet the permissions manager wraps,
 * never the manager itself. The wallet itself (`adminOriginator`, exact
 * match) is approved without a prompt; apps get the color consent in
 * `lib/cwi/color-consent.ts`, asked through `promptHandler`, with basket
 * grants kept in `permissionStore` (this wallet's color grant store on this
 * chain, keyed by `identityKey`, unless a caller passes another).
 */
export function createWalletColorModule(options: {
	wallet: WalletInterface;
	chain: Chain;
	identityKey: string;
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
				options.permissionStore ??
				colorPermissionStore(options.chain, options.identityKey),
			adminOriginator: options.adminOriginator,
		}),
	});
	return {
		module,
		permissionModule: appGatedColorModule(module, options.adminOriginator),
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

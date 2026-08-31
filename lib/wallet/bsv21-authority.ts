import {
	deployBsv21Auth,
	mintBsv21,
	type OneSatContext,
	type TokenOperationResponse,
} from "@1sat/actions";
import {
	type Bsv21Destination,
	bsv21ActionFailureMessage,
	normalizeBsv21TokenId,
} from "./bsv21-actions";

export const BSV21_CAPABILITY_UNAVAILABLE = "bsv21-capability-unavailable";
export const BSV21_ACTION_CONFIRMATION_MISSING =
	"bsv21-action-confirmation-missing";

export function permanentMintTerminationConfirmation(tokenId: string): string {
	return `END ${normalizeBsv21TokenId(tokenId)}`;
}

export function confirmsPermanentMintTermination(
	value: string,
	tokenId: string,
): boolean {
	return value === permanentMintTerminationConfirmation(tokenId);
}

export function bsv21AuthorityFailureMessage(cause: unknown): string {
	if (cause instanceof Error) {
		if (cause.message === BSV21_CAPABILITY_UNAVAILABLE) {
			return "The configured stack is no longer advertising BSV21. Nothing was submitted.";
		}
		if (cause.message === BSV21_ACTION_CONFIRMATION_MISSING) {
			return "The wallet did not return a transaction ID. Refresh wallet history and authority state before retrying.";
		}
	}
	return bsv21ActionFailureMessage(cause);
}

export type Bsv21AuthorityIntent =
	| { kind: "deploy"; symbol: string; decimals: number }
	| { kind: "mint"; tokenId: string; amount: bigint }
	| {
			kind: "transfer";
			tokenId: string;
			destination: Bsv21Destination;
	  }
	| { kind: "terminate-authority"; tokenId: string }
	| { kind: "terminate"; tokenId: string; finalAmount: bigint };

export interface Bsv21AuthorityActions {
	deploy: typeof deployBsv21Auth.execute;
	mint: typeof mintBsv21.execute;
}

export const canonicalBsv21AuthorityActions: Bsv21AuthorityActions = {
	deploy: deployBsv21Auth.execute,
	mint: mintBsv21.execute,
};

export async function requireLiveBsv21Capability(
	ctx: Pick<OneSatContext, "services">,
): Promise<void> {
	const capabilities = await ctx.services?.getCapabilities();
	if (!capabilities?.includes("bsv21")) {
		throw new Error(BSV21_CAPABILITY_UNAVAILABLE);
	}
}

export async function prepareLiveBsv21AuthorityExecution(
	ctx: Pick<OneSatContext, "services">,
): Promise<void> {
	await requireLiveBsv21Capability(ctx);
	ctx.services?.bsv21.clearCache();
}

export async function executeBsv21AuthorityIntent(
	ctx: OneSatContext,
	intent: Bsv21AuthorityIntent,
	actions: Bsv21AuthorityActions = canonicalBsv21AuthorityActions,
): Promise<
	TokenOperationResponse & { tokenId?: string; authOutpoint?: string }
> {
	switch (intent.kind) {
		case "deploy":
			return actions.deploy(ctx, {
				symbol: intent.symbol,
				decimals: intent.decimals,
				destination: { counterparty: "self" },
			});
		case "mint":
			return actions.mint(ctx, {
				tokenId: intent.tokenId,
				mint: {
					amount: intent.amount,
					destination: { counterparty: "self" },
				},
			});
		case "transfer":
			return actions.mint(ctx, {
				tokenId: intent.tokenId,
				auth: { destination: intent.destination },
			});
		case "terminate-authority":
			return actions.mint(ctx, {
				tokenId: intent.tokenId,
				endMinting: true,
			});
		case "terminate":
			return actions.mint(ctx, {
				tokenId: intent.tokenId,
				mint: {
					amount: intent.finalAmount,
					destination: { counterparty: "self" },
				},
				endMinting: true,
			});
	}
}

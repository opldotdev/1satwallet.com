import { getProfile, type OneSatContext } from "@1sat/actions";
import { createStackServices } from "@/lib/stack";
import {
	hasControlCharacter,
	isSafePublicImageUrl,
	profileDraftFromRecord,
} from "@/lib/wallet/bap-identity";
import { type PublicProfileClaim, safeHttpsUrl } from "./p2p-presence";

const DISPLAY_NAME_LIMIT = 64;

export function publicDisplayName(value: string): string | undefined {
	const name = value.trim().slice(0, DISPLAY_NAME_LIMIT).trim();
	if (!name || hasControlCharacter(name)) return undefined;
	return name;
}

export function publicAvatarUrl(
	image: string,
	chain: "main" | "test",
): string | undefined {
	const match = /^(?:ord|1sat):\/\/([0-9a-fA-F]{64})(?:[._](\d+))?$/.exec(
		image,
	);
	if (match) {
		return createStackServices(chain).ordfs.getContentUrl(
			`${match[1].toLowerCase()}_${match[2] ?? "0"}`,
		);
	}
	if (!isSafePublicImageUrl(image)) return undefined;
	try {
		return safeHttpsUrl(image, "avatarUrl");
	} catch {
		return undefined;
	}
}

export async function publicProfileClaimFromWallet(
	ctx: OneSatContext,
): Promise<PublicProfileClaim | undefined> {
	const result = await getProfile.execute(ctx, {});
	if (result.error) return undefined;
	const draft = profileDraftFromRecord(result.profile);
	const displayName = publicDisplayName(draft.name || draft.alternateName);
	const avatarUrl = publicAvatarUrl(draft.image, ctx.chain ?? "main");
	if (!displayName && !avatarUrl) return undefined;
	return {
		...(displayName ? { displayName } : {}),
		...(avatarUrl ? { avatarUrl } : {}),
		source: "bap",
	};
}

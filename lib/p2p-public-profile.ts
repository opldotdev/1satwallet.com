import { getProfile, type OneSatContext } from "@1sat/actions";
import { createStackServices } from "@/lib/stack";
import {
	bapDisplayName,
	hasControlCharacter,
	imageReferenceOrigin,
	isSafePublicImageUrl,
	profileDraftFromRecord,
	storedImageReference,
} from "@/lib/wallet/bap-identity";
import { type PublicProfileClaim, safeHttpsUrl } from "./p2p-presence";

const DISPLAY_NAME_LIMIT = 64;

export function publicDisplayName(value: string): string | undefined {
	const name = value.trim().slice(0, DISPLAY_NAME_LIMIT).trim();
	if (!name || hasControlCharacter(name)) return undefined;
	return name;
}

/** An https URL a BAP `image` or `banner` value can be shown from, if any. */
export function publicImageUrl(
	image: string,
	chain: "main" | "test",
): string | undefined {
	const origin = imageReferenceOrigin(image);
	if (origin) return createStackServices(chain).ordfs.getContentUrl(origin);
	if (!isSafePublicImageUrl(image)) return undefined;
	try {
		return safeHttpsUrl(image, "imageUrl");
	} catch {
		return undefined;
	}
}

/**
 * The URL the profile editor previews a BAP `image` or `banner` from: an
 * ordinal reference shows its ordfs content, an https URL shows exactly what
 * `storedImageReference` would publish (query, fragment and length intact).
 */
export function profileEditorPreviewUrl(
	value: string,
	chain: "main" | "test",
): string | undefined {
	const origin = imageReferenceOrigin(value);
	if (origin) return createStackServices(chain).ordfs.getContentUrl(origin);
	return storedImageReference(value);
}

export async function publicProfileClaimFromWallet(
	ctx: OneSatContext,
): Promise<PublicProfileClaim | undefined> {
	const result = await getProfile.execute(ctx, {});
	if (result.error) return undefined;
	const draft = profileDraftFromRecord(result.profile);
	const displayName = publicDisplayName(bapDisplayName(draft) ?? "");
	const avatarUrl = publicImageUrl(draft.image, ctx.chain ?? "main");
	if (!displayName && !avatarUrl) return undefined;
	return {
		...(displayName ? { displayName } : {}),
		...(avatarUrl ? { avatarUrl } : {}),
		source: "bap",
	};
}

import { getProfile, type OneSatContext } from "@1sat/actions";
import {
	isSafePublicImageUrl,
	profileDraftFromRecord,
} from "@/lib/wallet/bap-identity";
import type { PublicProfileClaim } from "./p2p-presence";

const DISPLAY_NAME_LIMIT = 64;
const AVATAR_URL_LIMIT = 512;

export function publicDisplayName(value: string): string | undefined {
	const name = [...value.trim()]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code >= 32 && code !== 127;
		})
		.join("")
		.slice(0, DISPLAY_NAME_LIMIT)
		.trim();
	return name || undefined;
}

export function publicAvatarUrl(
	image: string,
	chain: "main" | "test",
): string | undefined {
	const match = /^(?:ord|1sat):\/\/([0-9a-fA-F]{64})(?:[._](\d+))?$/.exec(
		image,
	);
	if (match) {
		const host =
			chain === "test"
				? "https://testnet.api.1sat.app"
				: "https://api.1sat.app";
		const vout = match[2] ?? "0";
		const url = `${host}/content/${match[1].toLowerCase()}_${vout}`;
		return url.length <= AVATAR_URL_LIMIT ? url : undefined;
	}
	if (!isSafePublicImageUrl(image) || !image.startsWith("https:")) {
		return undefined;
	}
	try {
		const url = new URL(image);
		url.search = "";
		url.hash = "";
		const href = url.toString();
		return href.length <= AVATAR_URL_LIMIT ? href : undefined;
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

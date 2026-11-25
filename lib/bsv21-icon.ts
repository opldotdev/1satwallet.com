import type { Chain } from "./chain-endpoints";
import { getCoverImageUrl } from "./image-utils";
import { clipForLog } from "./runtime-diagnostics";
import { stackContentUrl } from "./stack";

const OUTPOINT = /^[0-9a-fA-F]{64}[._](0|[1-9][0-9]*)$/;
const RELATIVE_OUTPOINT = /^_(0|[1-9][0-9]*)$/;

/**
 * A BSV-21 `icon` field as a txid_vout outpoint. The field is an outpoint
 * (txid_vout or txid.vout), or `_N` for output N of the deploy transaction.
 */
export function bsv21IconOutpoint(
	tokenId: string,
	icon: string,
): string | null {
	const normalized = icon.trim();
	if (RELATIVE_OUTPOINT.test(normalized)) {
		return `${tokenId.slice(0, 64)}${normalized}`.toLowerCase();
	}
	if (!OUTPOINT.test(normalized)) return null;
	return normalized.replace(".", "_").toLowerCase();
}

/** An icon given as a full URL, kept only on OrdFS hosts we trust. */
export function trustedBsv21IconUrl(icon: string): string | null {
	try {
		const url = new URL(icon);
		if (url.protocol !== "https:" || url.port || url.username || url.password) {
			return null;
		}
		if (
			url.hostname === "api.1sat.app" &&
			url.pathname.startsWith("/content/")
		) {
			return url.toString();
		}
		if (url.hostname === "ordfs.network") return url.toString();
		if (url.hostname === "themetoken.dev" && url.pathname.startsWith("/og/")) {
			return url.toString();
		}
		return null;
	} catch {
		return null;
	}
}

const reportedBadIcons = new Set<string>();

/**
 * The image src for a BSV-21 token icon: its OrdFS content, resized by the
 * image API to `size` px square. `size` is the device-pixel size (twice the
 * CSS size for sharp icons). Undefined when the token has no usable icon, so
 * the caller shows its placeholder; an unusable value is logged once.
 */
export function bsv21IconSrc(
	tokenId: string,
	icon: string | undefined,
	size: number,
	chain: Chain = "main",
): string | undefined {
	if (!icon) return undefined;
	const outpoint = bsv21IconOutpoint(tokenId, icon);
	const source = outpoint
		? stackContentUrl(outpoint, chain)
		: trustedBsv21IconUrl(icon);
	if (source) return getCoverImageUrl(source, size);
	if (!reportedBadIcons.has(icon)) {
		reportedBadIcons.add(icon);
		console.error("[bsv21-icon] unusable icon value", {
			tokenId,
			icon: clipForLog(icon, 160),
		});
	}
	return undefined;
}

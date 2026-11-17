/**
 * What build is running, for support reports. Both are set at build time in
 * next.config.ts: the package version, and the deployed commit (Vercel's
 * VERCEL_GIT_COMMIT_SHA), which a local build does not have.
 */
export interface BuildInfo {
	version: string;
	commit: string | null;
}

export function buildInfo(): BuildInfo {
	return {
		version: process.env.NEXT_PUBLIC_APP_VERSION || "unknown",
		commit: process.env.NEXT_PUBLIC_BUILD_COMMIT || null,
	};
}

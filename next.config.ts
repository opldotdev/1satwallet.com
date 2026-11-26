import type { NextConfig } from "next";
import packageJson from "./package.json";

export const baseSecurityHeaders = [
	{
		key: "X-Content-Type-Options",
		value: "nosniff",
	},
	{
		key: "Referrer-Policy",
		value: "strict-origin-when-cross-origin",
	},
	{
		key: "Permissions-Policy",
		value: "camera=(), geolocation=(), microphone=()",
	},
];

export const sensitiveRouteHeaders = [
	{
		key: "Cache-Control",
		value: "private, no-store, max-age=0, must-revalidate",
	},
	{
		key: "Pragma",
		value: "no-cache",
	},
];

const nextConfig: NextConfig = {
	/* config options here */
	reactCompiler: true,
	// Build constants for support reports (lib/build-info.ts). Vercel sets
	// VERCEL_GIT_COMMIT_SHA on every deployment; a local build has none.
	env: {
		NEXT_PUBLIC_APP_VERSION: packageJson.version,
		NEXT_PUBLIC_BUILD_COMMIT: process.env.VERCEL_GIT_COMMIT_SHA ?? "",
	},
	turbopack: {
		resolveAlias: {
			// @1sat/actions pulls in xdelta3-wasm, whose wasm loader has a
			// Node-only `require("fs")` branch guarded by a runtime check.
			// Browser bundles get an empty module for it.
			fs: { browser: "./lib/empty-module.ts" },
		},
	},
	async headers() {
		return [
			{
				source: "/:path*",
				headers: baseSecurityHeaders,
			},
			{
				source: "/api/cwi/:path*",
				headers: [...sensitiveRouteHeaders, { key: "Vary", value: "Origin" }],
			},
		];
	},
	images: {
		localPatterns: [
			{ pathname: "/images/wallet/radar.png", search: "" },
			{ pathname: "/oneSatLogoDark.png", search: "" },
			{ pathname: "/download/*.png", search: "" },
			{ pathname: "/download/features/*.webp", search: "" },
			{
				pathname: "/api/image",
			},
		],
		remotePatterns: [
			{
				protocol: "https",
				hostname: "res.cloudinary.com",
				port: "",
				pathname: "/tonicpow/image/fetch/**",
			},
			{
				protocol: "https",
				hostname: "ordfs.network",
				port: "",
				pathname: "/**",
			},
			{
				protocol: "https",
				hostname: "api.1sat.app",
				port: "",
				pathname: "/content/**",
			},
			{
				protocol: "https",
				hostname: "themetoken.dev",
				port: "",
				pathname: "/og/**",
			},
		],
	},
};

export default nextConfig;

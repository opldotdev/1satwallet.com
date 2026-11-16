import path from "node:path";

// No app imports here: playwright.config.ts loads this file.

/** Local secrets written by `bun run e2e:wallets:create` (gitignored). */
export const ENV_FILE = path.join(__dirname, "..", "..", ".env.e2e.local");

/** Vercel bypass cookie saved by the global setup; every context loads it. */
export const VERCEL_AUTH_FILE = path.join(
	__dirname,
	"..",
	".auth",
	"vercel.json",
);

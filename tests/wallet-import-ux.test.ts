import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("wallet import ux", () => {
	it("blocks duplicate hosted unlock submissions and shows pending state", () => {
		const page = read("app/(main)/wallet/cwi/authorize/page.tsx");
		assert.match(
			page,
			/const \[isUnlocking, setIsUnlocking\] = useState\(false\)/,
		);
		assert.match(page, /if \(isUnlocking\) return;/);
		assert.match(page, /setIsUnlocking\(true\)/);
		assert.match(page, /setIsUnlocking\(false\)/);
		// Both the passphrase input and the submit button are disabled.
		const disabledCount = (page.match(/disabled=\{isUnlocking\}/g) ?? [])
			.length;
		assert.ok(
			disabledCount >= 2,
			`expected 2+ disabled controls, saw ${disabledCount}`,
		);
		assert.match(page, /Unlocking…/);
		assert.match(page, /Loader2[^;]*animate-spin/);
	});

	it("wires the unlock error accessibly and never leaks the passphrase", () => {
		const page = read("app/(main)/wallet/cwi/authorize/page.tsx");
		assert.match(page, /aria-invalid=\{unlockError \? true : undefined\}/);
		assert.match(
			page,
			/aria-describedby=\{unlockError \? "cwi-unlock-error" : undefined\}/,
		);
		assert.match(page, /id="cwi-unlock-error"/);
		assert.match(page, /role="alert"/);
		// Fixed useful errors, not provider error echo.
		assert.match(page, /Invalid passphrase/);
		assert.match(page, /Unable to unlock wallet\. Please try again\./);
		// Always clears passphrase and pending state.
		assert.match(
			page,
			/finally\s*\{[\s\S]*?setPassphrase\(""\)[\s\S]*?setIsUnlocking\(false\)/,
		);
		assert.doesNotMatch(
			page,
			/console\.(log|info|debug|warn|error)\(.*passphrase/i,
		);
		// The unlock handler keeps the passphrase local: no fetch/network send inside it.
		const unlockStart = page.indexOf("const handleUnlock");
		assert.ok(unlockStart !== -1, "expected handleUnlock");
		const unlockSlice = page.slice(unlockStart, unlockStart + 800);
		assert.doesNotMatch(unlockSlice, /fetch\(/);
		assert.doesNotMatch(unlockSlice, /console\./);
	});

	it("stops failed path auto-detection at the root instead of looping", () => {
		const grid = read("components/wallet/mnemonic-grid.tsx");
		assert.match(
			grid,
			/const \[detectionFailed, setDetectionFailed\] = useState\(false\)/,
		);
		// Guard stops the effect becoming eligible again once processing flips back.
		assert.match(grid, /!detectionFailed/);
		assert.match(
			grid,
			/!processing &&[\s\S]*?!pendingPaths &&[\s\S]*?!detectionFailed/,
		);
		// Failure is recorded both when no path is found and when lookup throws.
		assert.match(grid, /setDetectionFailed\(true\)/);
		// Mnemonic edits and custom-path toggles clear the failure for one new attempt.
		assert.match(grid, /handleWordChange[\s\S]*?setDetectionFailed\(false\)/);
		assert.match(grid, /handlePaste[\s\S]*?setDetectionFailed\(false\)/);
		assert.match(grid, /toggleCustomPaths[\s\S]*?setDetectionFailed\(false\)/);
		// Explicit retry only needs to clear the guard; that state change re-runs the effect once.
		assert.match(grid, /onClick=\{\(\) => setDetectionFailed\(false\)\}/);
		assert.doesNotMatch(grid, /detectionAttempt/);
	});

	it("surfaces failed detection with retry and announces the path search", () => {
		const grid = read("components/wallet/mnemonic-grid.tsx");
		assert.match(grid, /role="alert"/);
		assert.match(grid, /Automatic wallet-path detection failed\./);
		assert.match(grid, /Try again/);
		assert.match(grid, /onClick=\{\(\) => setDetectionFailed\(false\)\}/);
		assert.match(grid, /role="status"/);
		assert.match(grid, /Searching wallet paths…/);
		// Next stays disabled while the search runs or no path is resolved.
		assert.match(
			grid,
			/disabled=\{[\s\S]*?processing[\s\S]*?\(!pendingPaths && !useCustomPaths\)/,
		);
	});

	it("preserves seed derivation rules and wallet preset paths", () => {
		const grid = read("components/wallet/mnemonic-grid.tsx");
		assert.match(grid, /findKeysFromMnemonic/);
		assert.match(grid, /getKeysFromMnemonicAndPaths/);
		for (const preset of [
			"RELAYX_WALLET_PATH",
			"RELAYX_ORD_PATH",
			"YOURS_WALLET_PATH",
			"YOURS_ORD_PATH",
			"TWETCH_WALLET_PATH",
			"AYM_WALLET_PATH",
		]) {
			assert.ok(grid.includes(preset), `expected preset ${preset}`);
		}
	});
});

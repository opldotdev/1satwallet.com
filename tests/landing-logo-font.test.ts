import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const fontPath = join(root, "public/fonts/kanit-extrabold.typeface.json");

describe("landing logo font", () => {
	it("is the reproducible regular Kanit conversion", () => {
		const generatedPath = join(tmpdir(), `1sat-logo-font-${process.pid}.json`);
		try {
			execFileSync(
				process.execPath,
				[
					join(root, "scripts/convert-font.js"),
					join(root, "public/fonts/Kanit-ExtraBold.ttf"),
					generatedPath,
				],
				{ stdio: "pipe" },
			);
			assert.equal(
				readFileSync(generatedPath, "utf8"),
				readFileSync(fontPath, "utf8"),
			);
		} finally {
			rmSync(generatedPath, { force: true });
		}
	});

	it("loads the regular asset used by the logo with endpoint-first curves", () => {
		const source = readFileSync(
			join(root, "components/landing/logo-3d.tsx"),
			"utf8",
		);
		const font = JSON.parse(readFileSync(fontPath, "utf8"));

		assert.match(source, /\/fonts\/kanit-extrabold\.typeface\.json/);
		assert.equal(font.familyName, "Kanit ExtraBold");
		assert.match(font.glyphs.S.o, /^m 357 -14 l 357 -14 q 180 1 264 -14 /);
	});
});

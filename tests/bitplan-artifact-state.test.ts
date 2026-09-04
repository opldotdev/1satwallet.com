import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const viewerSource = readFileSync(
	join(process.cwd(), "components/artifact/bitplan.tsx"),
	"utf8",
);

describe("BitPlan empty-document state", () => {
	test("presents an explicit empty state while keeping the title, version, and iframe path", () => {
		assert.match(
			viewerSource,
			/const isEmpty = view\.plaintext\.html\.trim\(\)\.length === 0/,
		);
		assert.match(viewerSource, /FileWarning/);
		assert.match(viewerSource, /role="status"/);
		assert.match(viewerSource, /This BitPlan document is empty\./);
		assert.match(
			viewerSource,
			/view\.plaintext\.meta\?\.title \|\| "BitPlan Document"/,
		);
		assert.match(viewerSource, /BPLN v\{view\.version\}/);
		assert.match(viewerSource, /sandbox=""/);
		assert.match(viewerSource, /srcDoc=\{view\.plaintext\.html\}/);
	});
});

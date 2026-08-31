import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

describe("outpoint page responsive layout", () => {
	test("allows long timeline outpoints to shrink and wrap beside status text", () => {
		const page = readFileSync(
			join(process.cwd(), "app/(main)/outpoint/[outpoint]/page.tsx"),
			"utf8",
		);

		assert.match(
			page,
			/className="flex min-w-0 items-center gap-3 border-b border-border\/50 py-1\.5"/,
		);
		assert.match(
			page,
			/<span className="min-w-0 flex-1 break-all">\{h\.outpoint\}<\/span>/,
		);
	});
});

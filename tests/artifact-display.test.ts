import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const artifactSource = readFileSync(
	join(process.cwd(), "components/artifact/index.tsx"),
	"utf8",
);

describe("artifact image dimensions", () => {
	it("uses the established preview default when no explicit size is supplied", () => {
		assert.match(artifactSource, /width=\{size \|\| 300\}/);
		assert.match(artifactSource, /height=\{size \|\| 300\}/);
		assert.match(
			artifactSource,
			/getPaddedImageUrl\(src, size \|\| 300, size \|\| 300, "111111"\)/,
		);
		assert.doesNotMatch(artifactSource, /(?:width|height)=\{size \|\| 0\}/);
	});
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const artifactSource = readFileSync(
	join(process.cwd(), "components/artifact/index.tsx"),
	"utf8",
);

describe("artifact zoom containment", () => {
	it("uses inset containment instead of viewport sizing for the zoom overlay", () => {
		assert.match(artifactSource, /fixed inset-0/);
		assert.doesNotMatch(artifactSource, /w-screen/);
		// The only h-screen sizing left is the max-height image guard.
		assert.equal(artifactSource.match(/h-screen/g)?.length, 1);
		assert.match(artifactSource, /max-h-screen/);
		// Fixed full-screen appearance, close behavior, and content are kept.
		assert.match(artifactSource, /bg-background\/80/);
		assert.match(artifactSource, /onClick=\{\(\) => setShowZoom\(false\)\}/);
		assert.match(artifactSource, /\{content\}/);
	});
});

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

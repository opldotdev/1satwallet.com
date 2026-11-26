import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { ShowcaseChapters } from "../app/download/showcase-chapters";
import { chapters, coverShot } from "../app/download/showcase-data";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("download feature showcase", () => {
	it("has unique chapters with copy and a visual", () => {
		const ids = chapters.map((chapter) => chapter.id);
		assert.equal(new Set(ids).size, ids.length);
		for (const chapter of chapters) {
			assert.ok(chapter.title && chapter.body && chapter.eyebrow, chapter.id);
			assert.ok(
				chapter.points.length >= 3 && chapter.points.length <= 5,
				chapter.id,
			);
			const main = chapter.shots.some((shot) => shot.place === "main");
			assert.ok(main || chapter.vignette, `${chapter.id} has no visual`);
		}
	});

	it("ships every screenshot it uses, small and described", () => {
		const shots = [coverShot, ...chapters.flatMap((chapter) => chapter.shots)];
		for (const shot of shots) {
			const file = join(root, "public", shot.src);
			assert.ok(existsSync(file), shot.src);
			assert.ok(statSync(file).size <= 250_000, `${shot.src} too large`);
			assert.match(shot.src, /^\/download\/features\/[\w-]+\.webp$/);
			assert.ok(shot.alt.length > 10, `${shot.src} needs alt text`);
		}
		assert.match(read("next.config.ts"), /\/download\/features\/\*\.webp/);
	});

	it("claims only what the app ships", () => {
		const copy = chapters
			.flatMap((chapter) => [
				chapter.title,
				chapter.body,
				...chapter.points,
				chapter.note?.text ?? "",
			])
			.join("\n");
		// Creating listings is off in the app; buying and delisting work.
		assert.doesNotMatch(
			copy,
			/create (a )?listing|list (it|yours|an? \w+) for sale|MNEE/i,
		);
		for (const sentence of copy.split(/\n|(?<=\.)\s/)) {
			if (/swap|mint|token creation/i.test(sentence)) {
				assert.match(sentence, /testnet/i, sentence);
			}
		}
	});

	it("renders one heading per chapter and alt text on every image", () => {
		const html = renderToString(
			<ShowcaseChapters
				title={<h2>Title</h2>}
				description={<p>Line</p>}
				closing={<p>End</p>}
			/>,
		);
		assert.equal(html.match(/<h3 /g)?.length, chapters.length);
		for (const img of html.match(/<img [^>]*>/g) ?? []) {
			assert.match(img, /alt="[^"]+"/);
		}
	});

	it("opens as a dialog from the download page and follows #features", () => {
		const showcase = read("app/download/feature-showcase.tsx");
		assert.ok(showcase.includes("Dialog.Title"));
		assert.ok(showcase.includes("Dialog.Description"));
		assert.ok(showcase.includes('"#features"'));
		assert.ok(showcase.includes("popstate"));
		assert.ok(showcase.includes("TESTFLIGHT_URL"));
		assert.ok(
			read("app/download/download-page-client.tsx").includes(
				"<FeatureShowcase />",
			),
		);
	});
});

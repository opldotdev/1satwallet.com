import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const read = (file: string) =>
	readFileSync(join(process.cwd(), file), "utf8");

describe("Vercel build", () => {
	it("builds every deployment through the one script", () => {
		const config = JSON.parse(read("vercel.json")) as {
			buildCommand?: string;
		};
		assert.equal(config.buildCommand, "bash scripts/vercel-build.sh");
	});

	it("never gives a preview its own Convex deployment", () => {
		const script = read("scripts/vercel-build.sh");
		const commands = script
			.replace(/\\\n\s*/g, " ")
			.split("\n")
			.filter((line) => /convex deploy/.test(line));
		assert.equal(commands.length, 2);
		const [production, preview] = commands;
		// Production goes to the production deployment only.
		assert.match(script, /if \[ "\$\{VERCEL_ENV:-\}" = "production" \]; then/);
		assert.doesNotMatch(production ?? "", /--preview/);
		// Every preview reuses one fixed, shared preview deployment. A
		// per-branch name (the default) or --preview-create would add one.
		assert.match(preview ?? "", /--preview-name pr-preview /);
		assert.doesNotMatch(script, /--preview-create/);
		assert.doesNotMatch(script, /--preview-name \$/);
	});
});

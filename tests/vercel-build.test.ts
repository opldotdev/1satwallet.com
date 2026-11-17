import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const PRODUCTION = [
	"convex",
	"deploy",
	"--cmd",
	"bun run build",
	"--cmd-url-env-var-name",
	"NEXT_PUBLIC_CONVEX_URL",
];

/** The arguments the build script hands bunx, with bunx stubbed out. */
function bunxArgs(vercelEnv: string | undefined): string[] {
	const bin = mkdtempSync(join(tmpdir(), "vercel-build-"));
	const stub = join(bin, "bunx");
	writeFileSync(stub, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
	chmodSync(stub, 0o755);
	const env: Record<string, string> = {
		PATH: `${bin}:${process.env.PATH ?? ""}`,
	};
	if (vercelEnv !== undefined) env.VERCEL_ENV = vercelEnv;
	const run = spawnSync("bash", ["scripts/vercel-build.sh"], {
		cwd: process.cwd(),
		env,
		encoding: "utf8",
	});
	assert.equal(run.status, 0, run.stderr);
	return run.stdout.trimEnd().split("\n");
}

describe("Vercel build", () => {
	it("builds every deployment through the one script", () => {
		const config = JSON.parse(
			readFileSync(join(process.cwd(), "vercel.json"), "utf8"),
		) as { buildCommand?: string };
		assert.equal(config.buildCommand, "bash scripts/vercel-build.sh");
	});

	it("deploys production exactly as before", () => {
		assert.deepEqual(bunxArgs("production"), PRODUCTION);
	});

	for (const vercelEnv of ["preview", "development", undefined]) {
		it(`reuses the one shared preview deployment (VERCEL_ENV=${vercelEnv ?? "unset"})`, () => {
			const args = bunxArgs(vercelEnv);
			// A per-branch name (the default) or --preview-create would add a
			// Convex deployment for every pull request.
			const name = args.indexOf("--preview-name");
			assert.ok(name > 0, args.join(" "));
			assert.equal(args[name + 1], "pr-preview");
			assert.ok(!args.includes("--preview-create"));
			assert.ok(args.includes("--skip-large-indexes-check"));
			assert.deepEqual(
				args.filter(
					(arg, i) =>
						arg !== "--preview-name" &&
						i !== name + 1 &&
						arg !== "--skip-large-indexes-check",
				),
				PRODUCTION,
			);
		});
	}
});

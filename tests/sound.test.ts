import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("shared sound pool", () => {
	it("shares one module-level audio pool instead of a per-hook cache", () => {
		const hook = read("hooks/use-sound.ts");

		// Module-level shared pool created once for all consumers.
		assert.match(hook, /const sharedAudioPool = new Map<SoundName/);
		assert.match(hook, /let poolPreloadStarted = false/);
		assert.match(hook, /function ensureSharedPoolPreloaded/);
		assert.match(hook, /Object\.entries\(SOUNDS\)/);

		// Rejects the old per-hook contract: a ref-held map cleared on unmount
		// forces every mounted component to create/preload all six assets.
		assert.doesNotMatch(hook, /useRef.*Map/);
		assert.doesNotMatch(hook, /audioCache\.current/);
		assert.doesNotMatch(hook, /\.clear\(\)/);

		// Only one Audio construction site feeds the shared pool.
		assert.equal(hook.match(/new Audio\(/g)?.length, 1);
	});

	it("keeps playback non-fatal with mute and volume behavior intact", () => {
		const hook = read("hooks/use-sound.ts");

		assert.match(hook, /isSoundMuted/);
		assert.match(hook, /SOUND_VOLUMES\[sound\]/);
		assert.match(hook, /volumeOverride/);
		assert.match(hook, /audio\.play\(\)\.catch/);
		assert.match(hook, /audio\.currentTime = 0/);
		assert.doesNotMatch(hook, /howler|tonejs|audio-context/i);
	});

	it("initializes the pool on first play before the mount effect and keeps playing", () => {
		const hook = read("hooks/use-sound.ts");

		// First play() before the mount effect must initialize the pool and
		// continue in the same gesture instead of returning silently.
		assert.doesNotMatch(hook, /ensureSharedPoolPreloaded\(\);\s*return;/);
		assert.match(hook, /let audio = sharedAudioPool\.get\(sound\)/);
		assert.match(
			hook,
			/ensureSharedPoolPreloaded\(\);\s*audio = sharedAudioPool\.get\(sound\)/,
		);
		assert.match(
			hook,
			/audio = sharedAudioPool\.get\(sound\);\s*if \(!audio\) return;/,
		);
	});
});

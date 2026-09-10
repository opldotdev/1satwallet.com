import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

// Exercise deferred audio with browser stubs; never play through the test machine.
describe("payment chime", () => {
	it("bundles a dedicated chime while clipboard retains success", async () => {
		const { SOUNDS, SOUND_VOLUMES } = await import("@/lib/sounds");
		assert.equal(SOUNDS.payChime, "/sounds/pay-chime.mp3");
		assert.equal(SOUND_VOLUMES.payChime, 0.3);
		assert.ok(
			readFileSync(join(root, "public", SOUNDS.payChime)).length > 1000,
		);
		assert.match(
			read("hooks/use-copy-with-sound.ts"),
			/successSound = "success"/,
		);
	});

	it("unlocks on confirm without playback, then rechecks mute after decoding", async () => {
		const { mock } = require("bun:test");
		let muted = true;
		const originalSettings = {
			...(await import("@/hooks/use-sound-settings")),
		};
		mock.module("@/hooks/use-sound-settings", () => ({
			isSoundMuted: () => muted,
		}));
		const { preparePayChime, playPayChime, playSound } = await import(
			"@/hooks/use-sound"
		);
		let resumes = 0;
		let starts = 0;
		let volume = 0;
		let resolveBytes!: (bytes: ArrayBuffer) => void;
		const bytes = new Promise<ArrayBuffer>((resolve) => {
			resolveBytes = resolve;
		});
		const originals = ["window", "AudioContext", "fetch"].map(
			(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
		);
		class FakeContext {
			destination = {};
			resume() {
				resumes++;
				return Promise.resolve();
			}
			decodeAudioData() {
				return Promise.resolve({});
			}
			createBufferSource() {
				return {
					buffer: null,
					loop: true,
					onended: null,
					connect() {},
					disconnect() {},
					start() {
						assert.equal(this.loop, false);
						starts++;
					},
				};
			}
			createGain() {
				return {
					gain: {
						set value(value: number) {
							volume = value;
						},
					},
					connect() {},
					disconnect() {},
				};
			}
		}
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {},
		});
		Object.defineProperty(globalThis, "AudioContext", {
			configurable: true,
			value: FakeContext,
		});
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: async (url: string) => {
				assert.equal(url, "/sounds/pay-chime.mp3");
				return { ok: true, arrayBuffer: () => bytes };
			},
		});
		try {
			preparePayChime();
			assert.equal(resumes, 0, "muted confirm does not initialize audio");
			muted = false;
			preparePayChime();
			assert.equal(resumes, 1, "resume is synchronous in the confirm gesture");
			assert.equal(starts, 0, "confirm must not play the chime");
			const pending = playPayChime();
			muted = true;
			resolveBytes(new ArrayBuffer(1));
			await pending;
			assert.equal(starts, 0, "mute during loading suppresses playback");
			muted = false;
			await playPayChime();
			assert.equal(starts, 1);
			assert.equal(volume, 0.3);
			muted = true;
			playSound("payChime");
			await Promise.resolve();
			assert.equal(starts, 1, "global mute is honored by the public hook path");
		} finally {
			for (const [key, descriptor] of originals) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
			mock.module("@/hooks/use-sound-settings", () => originalSettings);
			mock.restore();
		}
	});
});

describe("sound accessibility preferences", () => {
	for (const muted of [false, true]) {
		it(`keeps reduced motion independent of explicit mute=${muted}`, () => {
			// A fresh process exercises the real module's initial preference read,
			// without the audio test's module mock or singleton state.
			const result = spawnSync(
				process.execPath,
				[
					"-e",
					`
				globalThis.window = {
					matchMedia: () => ({ matches: true }),
					localStorage: { getItem: () => ${muted ? '"1"' : '"0"'} }
				};
				const { isSoundMuted } = await import("./hooks/use-sound-settings.ts");
				if (isSoundMuted() !== ${muted}) process.exit(1);
			`,
				],
				{ cwd: root, encoding: "utf8" },
			);
			assert.equal(result.status, 0, result.stderr);
		});
	}
});

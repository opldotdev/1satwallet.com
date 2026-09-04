"use client";

import { useEffect } from "react";
import { isSoundMuted } from "@/hooks/use-sound-settings";
import { SOUND_VOLUMES, SOUNDS, type SoundName } from "@/lib/sounds";

/**
 * One module-level browser audio pool shared across all hook consumers,
 * so the six sound assets are created/preloaded once instead of once per
 * mounted component.
 */
const sharedAudioPool = new Map<SoundName, HTMLAudioElement>();
let poolPreloadStarted = false;

function ensureSharedPoolPreloaded(): void {
	if (poolPreloadStarted) return;
	if (typeof window === "undefined" || typeof Audio === "undefined") return;
	poolPreloadStarted = true;

	for (const [name, path] of Object.entries(SOUNDS)) {
		const audio = new Audio(path);
		audio.preload = "auto";
		audio.volume = SOUND_VOLUMES[name as SoundName];
		sharedAudioPool.set(name as SoundName, audio);
	}
}

/**
 * Hook for playing UI sounds.
 *
 * Uses Web Audio API with HTMLAudioElement for broad compatibility.
 * Sounds are preloaded once into a shared module-level pool for instant playback.
 * Respects the global mute toggle and prefers-reduced-motion.
 *
 * @example
 * const { play } = useSound();
 * <button onClick={() => play("click")}>Click me</button>
 */
export function useSound() {
	// Preload the shared pool on mount (once per page, not once per hook)
	useEffect(() => {
		ensureSharedPoolPreloaded();
	}, []);

	const play = (sound: SoundName, volumeOverride?: number) => {
		if (isSoundMuted()) return;

		let audio = sharedAudioPool.get(sound);
		if (!audio) {
			// Pool not preloaded yet (e.g. first play before the mount
			// effect runs); initialize now and keep playing in this same
			// user gesture instead of returning silently.
			ensureSharedPoolPreloaded();
			audio = sharedAudioPool.get(sound);
			if (!audio) return;
		}

		// Apply volume override if provided
		if (volumeOverride !== undefined) {
			audio.volume = Math.max(0, Math.min(1, volumeOverride));
		} else {
			audio.volume = SOUND_VOLUMES[sound];
		}

		// Reset and play
		audio.currentTime = 0;
		audio.play().catch(() => {
			// Silently fail if audio can't play (user hasn't interacted, etc.)
		});
	};

	return { play };
}

"use client";

import { useEffect } from "react";
import { isSoundMuted } from "@/hooks/use-sound-settings";
import { SOUND_VOLUMES, SOUNDS, type SoundName } from "@/lib/sounds";

/**
 * One module-level browser audio pool shared across all hook consumers,
 * so the UI sound assets are created/preloaded once instead of once per
 * mounted component.
 */
const sharedAudioPool = new Map<SoundName, HTMLAudioElement>();
let poolPreloadStarted = false;

function ensureSharedPoolPreloaded(): void {
	if (poolPreloadStarted) return;
	if (typeof window === "undefined" || typeof Audio === "undefined") return;
	poolPreloadStarted = true;

	for (const [name, path] of Object.entries(SOUNDS)) {
		if (name === "payChime") continue; // Decoded once for gesture-safe Web Audio playback.
		const audio = new Audio(path);
		audio.preload = "auto";
		audio.volume = SOUND_VOLUMES[name as SoundName];
		sharedAudioPool.set(name as SoundName, audio);
	}
}

// Keep the context alive across the asynchronous send. resume() must be called
// synchronously from Confirm, before the wallet request yields user activation.
let payContext: AudioContext | undefined;
let payReady: Promise<AudioBuffer | null> | undefined;

export function preparePayChime(): void {
	if (isSoundMuted() || typeof window === "undefined") return;
	try {
		payContext ??= new AudioContext();
		const context = payContext;
		const resumed = context.resume();
		const decoded =
			payReady ??
			fetch(SOUNDS.payChime)
				.then((response) => {
					if (!response.ok) throw new Error("Chime unavailable");
					return response.arrayBuffer();
				})
				.then((bytes) => context.decodeAudioData(bytes));
		payReady = Promise.all([resumed, decoded])
			.then(([, buffer]) => buffer)
			.catch(() => {
				payReady = undefined;
				return null;
			});
	} catch {
		// Audio failure must never prevent a send.
	}
}

export async function playPayChime(
	volume = SOUND_VOLUMES.payChime,
): Promise<void> {
	if (isSoundMuted()) return;
	try {
		const buffer = await payReady;
		// Mute can change while the send or audio decoding is pending.
		if (!buffer || !payContext || isSoundMuted()) return;
		const source = payContext.createBufferSource();
		const gain = payContext.createGain();
		source.buffer = buffer;
		source.loop = false;
		gain.gain.value = Math.max(0, Math.min(1, volume));
		source.connect(gain);
		gain.connect(payContext.destination);
		source.onended = () => {
			source.disconnect();
			gain.disconnect();
		};
		source.start();
	} catch {
		// Silent, non-fatal; no payment data belongs in audio diagnostics.
	}
}

/**
 * Hook for playing UI sounds.
 *
 * Uses HTMLAudioElement for UI taps and Web Audio for deferred payment audio.
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

	const play = playSound;

	return { play, preparePayChime };
}

export const playSound = (sound: SoundName, volumeOverride?: number) => {
	if (isSoundMuted()) return;
	if (sound === "payChime") {
		void playPayChime(volumeOverride);
		return;
	}

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

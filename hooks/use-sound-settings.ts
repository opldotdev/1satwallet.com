"use client";

import { useCallback, useEffect, useState } from "react";

const SOUND_MUTED_KEY = "1sat_sound_muted";

function getInitialMuted(): boolean {
	if (typeof window === "undefined") return false;
	// Motion and sound are independent accessibility preferences.
	return window.localStorage.getItem(SOUND_MUTED_KEY) === "1";
}

const listeners: Set<() => void> = new Set();
let globalMuted: boolean | null = null;

function getGlobalMuted(): boolean {
	if (globalMuted === null) {
		globalMuted = getInitialMuted();
	}
	return globalMuted;
}

function setGlobalMuted(value: boolean) {
	globalMuted = value;
	if (typeof window !== "undefined") {
		window.localStorage.setItem(SOUND_MUTED_KEY, value ? "1" : "0");
	}
	for (const listener of listeners) {
		listener();
	}
}

/**
 * Hook for managing global sound mute state.
 * Persists the explicit sound preference to localStorage.
 */
export function useSoundSettings() {
	// Keep the server and first client render identical; read browser preferences
	// after hydration.
	const [muted, setMuted] = useState(false);

	useEffect(() => {
		const listener = () => setMuted(getGlobalMuted());
		listeners.add(listener);
		listener();
		return () => {
			listeners.delete(listener);
		};
	}, []);

	const toggleMuted = useCallback(() => {
		setGlobalMuted(!getGlobalMuted());
	}, []);

	return { muted, toggleMuted };
}

/**
 * Check if sound is globally muted (non-hook version for use-sound).
 */
export function isSoundMuted(): boolean {
	return getGlobalMuted();
}

/**
 * Audio Theme Constants
 *
 * Subtle, minimal UI sounds for the 1Sat wallet.
 * All sounds should be non-intrusive and refined.
 *
 * Sound Design Philosophy:
 * - Soft, clean digital tones
 * - Short durations (< 0.5s feel)
 * - Low volume: taps stay quiet (about 0.06 - 0.15)
 * - Premium, subtle feedback
 */

export const SOUNDS = {
	// Navigation & Menu
	click: "/sounds/click.mp3", // Soft tap for menu items, sidebar navigation

	// Feedback
	success: "/sounds/success.mp3", // Copy success, sync done
	payChime: "/sounds/pay-chime.mp3", // Broadcast payment complete
	error: "/sounds/error.mp3", // Validation error, transaction failed

	// Existing sounds (trade system)
	alert: "/sounds/alert.mp3", // Trade request notification
	dialog: "/sounds/dialog.mp3", // Dialog open/close
	decline: "/sounds/decline.mp3", // Negative action
} as const;

export type SoundName = keyof typeof SOUNDS;

/**
 * Default volume levels for each sound category.
 * Keep these low for subtle, non-intrusive feedback.
 */
export const SOUND_VOLUMES: Record<SoundName, number> = {
	click: 0.06, // Very subtle
	success: 0.1, // Slightly more noticeable
	payChime: 0.15, // One-second coin chime
	error: 0.12, // Noticeable but not harsh
	alert: 0.3, // Needs attention
	dialog: 0.12, // Open/close and tab changes
	decline: 0.15, // Moderate
};

/**
 * Sound categories for toggling groups
 */
export const SOUND_CATEGORIES = {
	navigation: ["click"] as SoundName[],
	feedback: ["success", "payChime", "error"] as SoundName[],
	notifications: ["alert", "dialog", "decline"] as SoundName[],
} as const;

// Chapters of the feature showcase on /download. Copy claims only what the
// 1Sat Wallet app ships (opldotdev/1sat-wallet-mobile). To add a screenshot,
// crop it with scripts/make-feature-crops.mjs and add a Shot below; a chapter's
// first "main" shot replaces its vignette.

export type Shot = {
	src: string;
	width: number;
	height: number;
	alt: string;
	frame: "device" | "panel";
	place: "main" | "float";
};

export type Vignette = "pay" | "market" | "keys";

export type Chapter = {
	id: string;
	eyebrow: string;
	title: string;
	body: string;
	points: string[];
	accent: string;
	note?: { tag: "Testnet"; text: string };
	chips?: string[];
	shots: Shot[];
	vignette?: Vignette;
};

const shot = (
	name: string,
	width: number,
	height: number,
	alt: string,
	frame: Shot["frame"],
	place: Shot["place"],
): Shot => ({
	src: `/download/features/${name}.webp`,
	width,
	height,
	alt,
	frame,
	place,
});

export const coverShot = shot(
	"home-full",
	1179,
	2366,
	"1Sat Wallet home screen with a stack of account cards and passes",
	"device",
	"main",
);

export const chapters: Chapter[] = [
	{
		id: "passes",
		eyebrow: "Accounts and passes",
		title: "Everything you hold, in one stack.",
		body: "Accounts stack like cards. Everything an account holds sits below as passes.",
		points: [
			"Several accounts under one recovery phrase",
			"Name each account and choose its card art",
			"Collections fold into a single pass",
			"Filter by kind, content or words",
			"Search across accounts, passes and transactions",
		],
		accent: "#e0673a",
		shots: [
			shot(
				"passes-collections",
				1059,
				700,
				"Collection passes for FREE PEPE and Pixel Foxes, each holding three items, above single ordinal passes",
				"panel",
				"main",
			),
			shot(
				"mac-sidebar",
				304,
				812,
				"The same stack of an account card and passes in the Mac sidebar",
				"panel",
				"float",
			),
		],
	},
	{
		id: "pay",
		eyebrow: "Payments",
		title: "Pay anyone.",
		body: "Send to a handle, a paymail, an address or an identity key. The wallet looks up the recipient as you type.",
		points: [
			"PeerPay to an identity key or a PeerPay link",
			"Receive by handle, address or PeerPay QR code",
			"Incoming payments wait in an inbox until you accept",
			"Contacts and a QR scanner built in",
		],
		accent: "#0a84ff",
		shots: [],
		vignette: "pay",
	},
	{
		id: "identity",
		eyebrow: "Identity and handles",
		title: "A name people can pay.",
		body: "Register a free handle and publish a profile on chain. People pay the name, not a string of characters.",
		points: [
			"@name@1sat.app, free to register",
			"Profile with name, avatar, banner, website and paymail",
			"Use one of your ordinals as your avatar",
			"Bind an OpNS name, claimed at 1sat.name",
			"Send BSV and 1Color tokens to a handle",
		],
		accent: "#f0bb00",
		shots: [
			shot(
				"handle-field",
				1059,
				158,
				"Handle field reading @satchmo@1sat.app",
				"panel",
				"main",
			),
			shot(
				"handle-register",
				1059,
				145,
				"Gold Register button",
				"panel",
				"float",
			),
		],
	},
	{
		id: "ordinals",
		eyebrow: "Ordinals",
		title: "Inscribe it. Sign it.",
		body: "Inscribe text, a photo or any file, signed as yours if you choose.",
		points: [
			"Photo optimizer with quality and size controls",
			"Add metadata to any inscription",
			"Sign with your identity (SIGMA)",
			"Collections with traits, rank and rarity",
			"Zoom into images and read text full screen",
		],
		accent: "#7b4bd6",
		shots: [
			shot(
				"inscribe-sheet",
				1179,
				2185,
				"Inscribe sheet with a JPEG quality slider, longest edge choices and a Sign with identity switch",
				"device",
				"main",
			),
			shot(
				"inscribe-sign",
				1059,
				221,
				"Sign with identity switch, turned on",
				"panel",
				"float",
			),
		],
	},
	{
		id: "tokens",
		eyebrow: "Tokens",
		title: "Every token is a pass.",
		body: "Each token sits in the stack with its balance on the front.",
		points: [
			"BSV-21 tokens: hold and send",
			"1Color (BRC-162): hold, receive and send to a handle",
			"OpNS names as Name passes",
			"Theme Tokens with their own art",
		],
		accent: "#2f9e8f",
		chips: ["Ordinals", "Collections", "BSV-21", "1Color", "Names"],
		note: {
			tag: "Testnet",
			text: "Token creation, 1Color minting and Open Exchange swaps run on testnet accounts.",
		},
		shots: [
			shot(
				"passes-themes",
				1059,
				665,
				"Passes for an image ordinal and three Theme Tokens with striped art",
				"panel",
				"main",
			),
		],
	},
	{
		id: "market",
		eyebrow: "Market and locks",
		title: "Buy a listing. Lock for later.",
		body: "Buy any open-market listing by its outpoint. Lock bitcoin until a block height you choose.",
		points: [
			"Buy any OrdLock listing",
			"Manage and delist your own listings",
			"Lock sats to a block height",
			"See the total locked and the next unlock",
			"Unlock when a lock matures",
		],
		accent: "#fdb022",
		shots: [],
		vignette: "market",
	},
	{
		id: "apps",
		eyebrow: "BRC-100",
		title: "Works with apps.",
		body: "A BRC-100 wallet. Apps ask, you approve, and the result goes back to the app.",
		points: [
			"Payment sheet on iPhone that shows which site is asking",
			"Approve with Face ID",
			"Optional monthly allowance per app",
			"On Mac, web apps connect locally and each request gets a prompt",
			"Review and revoke connected apps any time",
		],
		accent: "#34c759",
		shots: [
			shot(
				"mac-activity",
				464,
				510,
				"Mac account page with identity, key backup and latest transactions",
				"panel",
				"main",
			),
		],
	},
	{
		id: "keys",
		eyebrow: "Your keys",
		title: "Your keys stay yours.",
		body: "Keys live in iCloud Keychain or on this iPhone only. You choose when you set up.",
		points: [
			"Face ID to unlock, pay and reveal the recovery phrase",
			"Import from Yours, RelayX, Twetch, BSV Desktop and 1satwallet.com",
			"Sweep a private key without storing it",
			"Export a password-sealed backup",
			"Mainnet or testnet, chosen per account",
		],
		accent: "#8e8e93",
		shots: [],
		vignette: "keys",
	},
];

import { endpointsOf } from "@/lib/chain-endpoints";
import type { Browser } from "./support/agent-browser";
import { testWalletA } from "./support/env";
import { containing, type Locator, pattern } from "./support/page-query";
import {
	CHAIN_TIMEOUT,
	readDepositAddress,
	sectionLink,
	walletTest,
} from "./support/wallet";

// Receive's Address, Handle and PeerPay tabs, the wallet's own testnet
// handle, and BSV sent to a handle and by PeerPay, as testnet wallet A.
// There is one wallet in CI, so both payments go to A itself: the handle
// payment to A's own handle, the PeerPay payment to A's own identity key.
// Each comes back to A once A's inbox takes it, so a run costs the fees.
//
// The tests run in order: Receive, then the handle (registered on the first
// run), then the two payments. Each payment test finds or registers the
// handle itself, so any of them also runs alone.

const { handleDomain, handleRegistration } = endpointsOf("test");

/** A per-run number, so this run's payments are told from earlier runs'. */
const runId = process.env.GITHUB_RUN_ID ?? String(Date.now());
const runNumber = Number.isSafeInteger(Number(runId))
	? Number(runId)
	: Date.now();

/** At most 1,000 sats each, and never the same amount for both payments. */
const HANDLE_SATS = 600 + (runNumber % 300);
const PEERPAY_SATS = 300 + (runNumber % 300);

/** The wallet's way of writing an amount: 8 decimals. */
const bsv = (sats: number) => (sats / 100_000_000).toFixed(8);

/** Wallet A's handle name: from its identity key, so every run asks for the same one. */
const handleNameOf = (identityKey: string) => `e2e-${identityKey.slice(2, 12)}`;

/** How review shows a handle's identity key (wallet-home-actions `shortKey`). */
const reviewKey = (key: string) => `${key.slice(0, 10)}…${key.slice(-8)}`;

const OPEN_DIALOG = '[data-slot="dialog-content"][data-state="open"]';

const escapeRegExp = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches text that is exactly `text` (whitespace collapsed). */
const exactly = (text: string) =>
	pattern(new RegExp(`^${escapeRegExp(text)}$`));

const balanceRegion: Locator = { role: "region", name: "Spendable balance" };
const receiveDialog: Locator = { role: "dialog", name: "Receive BSV" };
const sendDialog: Locator = { role: "dialog", name: "Send BSV" };
const paidDialog: Locator = { role: "dialog", name: "Payment sent" };
const inReceive = (locator: Locator): Locator => ({
	...locator,
	within: receiveDialog,
});
const inSend = (locator: Locator): Locator => ({
	...locator,
	within: sendDialog,
});
const receiveTab = (name: string) => inReceive({ role: "tab", name });

async function openReceive(browser: Browser) {
	await browser.click(
		{ role: "button", name: "Receive", within: balanceRegion },
		CHAIN_TIMEOUT,
	);
	await browser.waitUntil("the Receive dialog", receiveDialog);
}

async function closeDialog(browser: Browser, dialog: Locator, what: string) {
	await browser.press("Escape");
	await browser.waitUntil(
		`the ${what} dialog to close`,
		dialog,
		(result) => result.count === 0,
	);
}

async function selectReceiveTab(browser: Browser, name: string) {
	await browser.click(receiveTab(name));
	await browser.waitUntil(
		`the ${name} tab to be selected`,
		{ ...receiveTab(name), attributes: ["aria-selected"] },
		(result) => result.attributes["aria-selected"] === "true",
	);
}

/** The Receive tabs, in order, and which one is selected. */
function readReceiveTabs(browser: Browser) {
	return browser.evaluate(
		(css: string) =>
			Array.from(
				document.querySelector(css)?.querySelectorAll('[role="tab"]') ?? [],
			).map((el) => ({
				name: (el.textContent ?? "").trim(),
				selected: el.getAttribute("aria-selected") === "true",
			})),
		OPEN_DIALOG,
	);
}

type HandleState =
	| { kind: "handles"; handles: string[] }
	| { kind: "none" }
	| { kind: "error"; text: string };

/**
 * The Handle tab once it has loaded: the handles it lists (read from their
 * Copy buttons), "no handle yet", or the error it shows.
 */
async function readHandleTab(browser: Browser): Promise<HandleState> {
	await browser.waitFor(
		"the Handle tab to finish loading",
		(css: string) => {
			const dialog = document.querySelector(css);
			const text = dialog?.textContent ?? "";
			return (
				!text.includes("Loading your handles…") &&
				(dialog?.querySelector('button[aria-label^="Copy @"]') != null ||
					text.includes("This wallet has no handle yet.") ||
					dialog?.querySelector('[role="alert"]') != null)
			);
		},
		OPEN_DIALOG,
		CHAIN_TIMEOUT,
	);
	return browser.evaluate((css: string): HandleState => {
		const dialog = document.querySelector(css);
		const alert = dialog?.querySelector('[role="alert"]');
		if (alert) {
			return {
				kind: "error",
				text: (alert.textContent ?? "").replace(/\s+/g, " ").trim(),
			};
		}
		const handles = Array.from(
			dialog?.querySelectorAll('button[aria-label^="Copy @"]') ?? [],
		).map((el) => (el.getAttribute("aria-label") ?? "").slice("Copy ".length));
		return handles.length > 0 ? { kind: "handles", handles } : { kind: "none" };
	}, OPEN_DIALOG);
}

/**
 * Registers `name` from the Handle tab's form, after Check. A name that is
 * already this account's is registered again, which fetches its
 * certificate; a name someone else holds fails the test.
 */
async function registerFromHandleTab(
	browser: Browser,
	name: string,
	handle: string,
) {
	await browser.fill(
		inReceive({ role: "textbox", name: "Pick a handle" }),
		name,
	);
	await browser.click(inReceive({ role: "button", name: "Check" }));
	const status = inReceive({
		role: "any",
		text: pattern(
			new RegExp(
				`^${escapeRegExp(handle)} (is available\\.|is already this account's\\.|is taken\\.|couldn't be checked here\\.)`,
			),
		),
	});
	await browser.waitUntil(
		`the availability of ${handle}`,
		status,
		undefined,
		undefined,
		CHAIN_TIMEOUT,
	);
	const { text } = await browser.query(status);
	if (text?.startsWith(`${handle} is taken.`)) {
		throw new Error(
			`${handle} is held by another account, so wallet A can't register it. Status: "${text}"`,
		);
	}

	await browser.click(inReceive({ role: "button", name: "Register" }));
	await browser.waitFor(
		`${handle} to be registered`,
		(args: { css: string; label: string }) => {
			const dialog = document.querySelector(args.css);
			return (
				dialog?.querySelector(`button[aria-label="${args.label}"]`) != null ||
				dialog?.querySelector('[role="alert"]') != null
			);
		},
		{ css: OPEN_DIALOG, label: `Copy ${handle}` },
		CHAIN_TIMEOUT,
	);
	const state = await readHandleTab(browser);
	if (state.kind === "error") {
		throw new Error(`Registering ${handle} failed: "${state.text}"`);
	}
	if (state.kind !== "handles" || !state.handles.includes(handle)) {
		throw new Error(
			`After registering, the Handle tab lists ${JSON.stringify(state.kind === "handles" ? state.handles : [])}, not ${handle}.`,
		);
	}
}

/**
 * Wallet A's testnet handle, registered first if the wallet has none. An
 * account has one handle: if A already holds one at the testnet domain under
 * another name, that one is used.
 */
async function ensureHandle(browser: Browser): Promise<{
	handle: string;
	registered: boolean;
}> {
	const { identityKey } = await testWalletA();
	const name = handleNameOf(identityKey);
	const expected = `@${name}@${handleDomain}`;
	await openReceive(browser);
	await selectReceiveTab(browser, "Handle");
	const state = await readHandleTab(browser);
	if (state.kind === "error") {
		throw new Error(`The Handle tab shows an error: "${state.text}"`);
	}
	let registered = false;
	let handle = expected;
	if (state.kind === "none") {
		await registerFromHandleTab(browser, name, expected);
		registered = true;
	} else if (!state.handles.includes(expected)) {
		const onTestnet = state.handles.find((h) => h.endsWith(`@${handleDomain}`));
		if (!onTestnet) {
			throw new Error(
				`Wallet A holds ${JSON.stringify(state.handles)}, none at ${handleDomain}.`,
			);
		}
		handle = onTestnet;
	}
	await closeDialog(browser, receiveDialog, "Receive");
	return { handle, registered };
}

/** The open dialog's review rows, label to value. */
function readReview(browser: Browser) {
	return browser.evaluate((css: string) => {
		const clean = (text: string | null) =>
			(text ?? "").replace(/\s+/g, " ").trim();
		const rows: Record<string, string> = {};
		for (const row of document
			.querySelector(css)
			?.querySelectorAll('[data-slot="detail-row"]') ?? []) {
			rows[clean(row.querySelector("dt")?.textContent ?? null)] = clean(
				row.querySelector("dd")?.textContent ?? null,
			);
		}
		return rows;
	}, OPEN_DIALOG);
}

function expectReview(
	rows: Record<string, string>,
	expected: Record<string, string | RegExp | undefined>,
) {
	const wrong = Object.entries(expected).filter(([label, want]) => {
		const got = rows[label];
		if (want === undefined) return got !== undefined;
		return typeof want === "string" ? got !== want : !want.test(got ?? "");
	});
	if (wrong.length > 0) {
		throw new Error(
			`The payment review is wrong for ${wrong.map(([label]) => label).join(", ")}: ${JSON.stringify(rows)}`,
		);
	}
}

/** Opens Send, fills it in and goes to review. */
async function reviewPayment(
	browser: Browser,
	recipient: string,
	sats: number,
	memo?: string,
) {
	await browser.click(
		{ role: "button", name: "Send", within: balanceRegion },
		CHAIN_TIMEOUT,
	);
	await browser.waitUntil("the Send dialog", sendDialog);
	await browser.fill(inSend({ role: "textbox", name: "Recipient" }), recipient);
	await browser.fill(
		inSend({ role: "textbox", name: "Amount (BSV)" }),
		bsv(sats),
	);
	if (memo !== undefined) {
		await browser.fill(
			inSend({ role: "textbox", name: "Memo (optional)" }),
			memo,
		);
	}
	await browser.click(inSend({ role: "button", name: "Review payment" }));
	await browser.waitFor(
		"the payment review, or an error",
		(css: string) => {
			const dialog = document.querySelector(css);
			return (
				dialog?.querySelector('[data-slot="detail-list"]') != null ||
				dialog?.querySelector('[data-slot="notice"]') != null
			);
		},
		OPEN_DIALOG,
		CHAIN_TIMEOUT,
	);
	const notice = await browser.evaluate(
		(css: string) =>
			document
				.querySelector(css)
				?.querySelector('[data-slot="notice"]')
				?.textContent?.trim() ?? null,
		OPEN_DIALOG,
	);
	if (notice !== null) {
		throw new Error(`Review payment to ${recipient} was refused: "${notice}"`);
	}
	return readReview(browser);
}

/**
 * Confirms the reviewed payment and returns its txid from the success
 * dialog, which is left open. A payment built but not delivered, or refused,
 * fails with the message the dialog shows.
 */
async function confirmPayment(
	browser: Browser,
	sats: number,
	note: string,
): Promise<string> {
	await browser.click(inSend({ role: "button", name: "Confirm and send" }));
	await browser.waitFor(
		"the payment to be sent, or a message why not",
		(css: string) => {
			const dialog = document.querySelector(css);
			const title = dialog?.querySelector('[data-slot="dialog-title"]');
			return (
				(title?.textContent ?? "").trim() === "Payment sent" ||
				dialog?.querySelector('[data-slot="notice"]') != null
			);
		},
		OPEN_DIALOG,
		CHAIN_TIMEOUT,
	);
	const paid = await browser.query(paidDialog);
	if (paid.count === 0) {
		const shown = await browser.query(sendDialog);
		throw new Error(`The payment was not sent: "${shown.text ?? ""}"`);
	}
	for (const text of [note, `${bsv(sats)} BSV`]) {
		const found = await browser.query({
			role: "any",
			text: exactly(text),
			within: paidDialog,
		});
		if (found.count === 0) {
			throw new Error(
				`The success dialog does not show "${text}": "${paid.text ?? ""}"`,
			);
		}
	}
	await browser.click({
		role: "any",
		text: pattern(/^Transaction details$/),
		within: paidDialog,
	});
	const txid: Locator = {
		role: "any",
		text: pattern(/^[0-9a-f]{64}$/),
		within: paidDialog,
	};
	await browser.waitUntil("the transaction id", txid);
	const { text } = await browser.query(txid);
	if (!text) throw new Error("The success dialog lost its transaction id.");
	return text;
}

async function finishPayment(browser: Browser) {
	await browser.click({ role: "button", name: "Done", within: paidDialog });
	await browser.waitUntil(
		"the success dialog to close",
		paidDialog,
		(result) => result.count === 0,
	);
}

/** One try of a wait that a sync may satisfy. */
const SYNC_TRY = 30_000;

/**
 * Runs Sync now on wallet home and opens History, until `done(arg)` holds
 * there or two chain timeouts pass. History is opened afresh after each
 * sync, so its lists are read again. Tab taps keep the wallet unlocked.
 */
async function syncUntilOnHistory<A>(
	browser: Browser,
	description: string,
	done: (arg: A) => unknown,
	arg: A,
	explain: () => Promise<string>,
) {
	const deadline = Date.now() + 2 * CHAIN_TIMEOUT;
	for (;;) {
		await browser.click(sectionLink("Wallet"));
		await browser.waitFor(
			"wallet home",
			() => location.pathname === "/wallet",
			null,
		);
		await browser.click(
			{
				role: "button",
				text: pattern(/^(Sync now|Retry sync)$/),
				within: { role: "region", name: "Wallet connection" },
			},
			CHAIN_TIMEOUT,
		);
		await browser.click(sectionLink("History"));
		await browser.waitFor(
			"the History tab",
			() => location.pathname === "/wallet/history",
			null,
		);
		try {
			await browser.waitFor(description, done, arg, SYNC_TRY);
			return;
		} catch (error) {
			const notYet =
				error instanceof Error && error.message.startsWith("Timed out");
			if (!notYet) throw error;
			if (Date.now() >= deadline) {
				throw new Error(
					`Gave up after ${2 * CHAIN_TIMEOUT} ms of syncing: ${description}. ${await explain()}`,
					{ cause: error },
				);
			}
		}
	}
}

/** The History row of `txid`: its text, or null when it isn't listed. */
function readHistoryRow(browser: Browser, txid: string) {
	return browser.evaluate(
		(id: string) =>
			document
				.querySelector(`[data-slot="history-row"] [title="${id}"]`)
				?.closest('[data-slot="history-row"]')
				?.textContent?.replace(/\s+/g, " ")
				.trim() ?? null,
		txid,
	);
}

walletTest(
	"receive: the Address, Handle and PeerPay tabs show this wallet's address, handles and identity key",
	async (browser) => {
		const wallet = await testWalletA();
		const address = await readDepositAddress(browser);

		await openReceive(browser);
		const tabs = await readReceiveTabs(browser);
		const expectedTabs = [
			{ name: "Address", selected: true },
			{ name: "Handle", selected: false },
			{ name: "PeerPay", selected: false },
		];
		if (JSON.stringify(tabs) !== JSON.stringify(expectedTabs)) {
			throw new Error(
				`Receive tabs ${JSON.stringify(tabs)}, expected ${JSON.stringify(expectedTabs)}.`,
			);
		}
		const deposit = inReceive({ role: "textbox", name: "Deposit address" });
		await browser.waitUntil(
			"the deposit address",
			deposit,
			(result, expected) => result.value === expected,
			address,
			CHAIN_TIMEOUT,
		);
		await browser.waitUntil(
			"the deposit address QR code",
			inReceive({
				role: "img",
				name: "QR code for the wallet deposit address",
			}),
		);

		await selectReceiveTab(browser, "Handle");
		const hidden = await browser.query(deposit);
		if (hidden.count !== 0) {
			throw new Error("The deposit address still shows on the Handle tab.");
		}
		const state = await readHandleTab(browser);
		if (state.kind === "error") {
			throw new Error(`The Handle tab shows an error: "${state.text}"`);
		}
		if (state.kind === "handles") {
			const bad = state.handles.filter(
				(h) => !/^@[a-z0-9][a-z0-9-]*[a-z0-9]@[a-z0-9.-]+\.[a-z]+$/.test(h),
			);
			if (bad.length > 0) {
				throw new Error(`The Handle tab lists malformed handles: ${bad}`);
			}
			// The first handle is the one shown as a QR code.
			await browser.waitUntil(
				`the QR code for ${state.handles[0]}`,
				inReceive({ role: "img", name: `QR code for ${state.handles[0]}` }),
			);
		} else {
			// No handle yet: the tab offers registration at the testnet domain.
			await browser.waitUntil(
				"the handle name field",
				inReceive({ role: "textbox", name: "Pick a handle" }),
			);
			await browser.waitUntil(
				`the ${handleDomain} suffix`,
				inReceive({ role: "any", text: exactly(`@${handleDomain}`) }),
			);
			const register = await browser.query(
				inReceive({ role: "button", name: "Register" }),
			);
			if (register.disabled !== true) {
				throw new Error("Register is enabled with no handle name.");
			}
			const site = await browser.query(
				inReceive({ role: "link", name: "Register on the handle site" }),
				["href"],
			);
			if (site.attributes.href !== handleRegistration) {
				throw new Error(
					`The handle site link goes to ${site.attributes.href}, expected ${handleRegistration}.`,
				);
			}
		}

		await selectReceiveTab(browser, "PeerPay");
		const key = await browser.query(
			inReceive({ role: "textbox", name: "Identity key" }),
		);
		if (key.value !== wallet.identityKey) {
			throw new Error(
				`The PeerPay tab shows identity key ${key.value}, expected wallet A's ${wallet.identityKey}.`,
			);
		}
		await browser.waitUntil(
			"the PeerPay QR code",
			inReceive({
				role: "img",
				name: "QR code for this wallet's PeerPay link",
			}),
		);
		await browser.waitUntil(
			"the Copy PeerPay link button",
			inReceive({ role: "button", name: "Copy PeerPay link" }),
		);
		await closeDialog(browser, receiveDialog, "Receive");
	},
);

walletTest(
	"handles: wallet A holds its testnet handle, registered on the first run",
	async (browser, t) => {
		const { handle, registered } = await ensureHandle(browser);
		// Shown again on a fresh read of the wallet: open Receive once more.
		await openReceive(browser);
		await selectReceiveTab(browser, "Handle");
		const state = await readHandleTab(browser);
		if (state.kind !== "handles" || !state.handles.includes(handle)) {
			throw new Error(
				`Reopened, the Handle tab shows ${JSON.stringify(state)}, expected ${handle}.`,
			);
		}
		await browser.waitUntil(
			`the copy button of ${handle}`,
			inReceive({ role: "button", name: `Copy ${handle}` }),
		);
		await closeDialog(browser, receiveDialog, "Receive");
		t.diagnostic(
			registered
				? `Registered ${handle} for wallet A.`
				: `Wallet A already holds ${handle}.`,
		);
	},
);

walletTest(
	"send: pays wallet A's own handle with a memo, lists it as waiting, and the handle inbox claims it",
	async (browser, t) => {
		const wallet = await testWalletA();
		const { handle } = await ensureHandle(browser);
		const memo = `1satwallet.com e2e run ${runId}`;

		const review = await reviewPayment(browser, handle, HANDLE_SATS, memo);
		expectReview(review, {
			Recipient: handle,
			// The handle resolves to wallet A itself.
			"Identity key": reviewKey(wallet.identityKey),
			Memo: memo,
			Delivery:
				"To the handle's mailbox. They claim it when their wallet next syncs.",
			Amount: `${bsv(HANDLE_SATS)} BSV`,
		});
		const txid = await confirmPayment(
			browser,
			HANDLE_SATS,
			`Delivered to ${handle}'s mailbox. They receive it when their wallet next syncs.`,
		);
		await finishPayment(browser);

		// Until the handle inbox claims it, the payment is waiting to be
		// claimed. The inbox runs every minute, so it may already have.
		// `sendBsv` describes it as "Payment to name@domain", cut at 50.
		const shown =
			`Payment to ${handle.slice(1)}`.length < 50 ? handle : "a handle";
		await browser.click(
			{ role: "button", name: "Send", within: balanceRegion },
			CHAIN_TIMEOUT,
		);
		await browser.waitUntil("the Send dialog", sendDialog);
		const waiting: Locator = {
			role: "listitem",
			text: containing(`${bsv(HANDLE_SATS)} BSV to ${shown}`),
			has: { role: "button", name: "Cancel" },
			within: inSend({ role: "region", name: "Waiting to be claimed" }),
		};
		let listedAsWaiting = true;
		try {
			await browser.waitUntil(
				"the payment under Waiting to be claimed",
				waiting,
				undefined,
				undefined,
				SYNC_TRY,
			);
		} catch (error) {
			if (!(error instanceof Error && error.message.startsWith("Timed out"))) {
				throw error;
			}
			listedAsWaiting = false;
		}
		await closeDialog(browser, sendDialog, "Send");

		const claimed = (id: string) => {
			const row = document
				.querySelector(`[data-slot="history-row"] [title="${id}"]`)
				?.closest('[data-slot="history-row"]');
			return row != null && !/Not sent|Failed/.test(row.textContent ?? "");
		};
		if (!listedAsWaiting) {
			// Not listed is only right if the inbox has claimed it already.
			await browser.click(sectionLink("History"));
			await browser.waitFor(
				`transaction ${txid} in History`,
				(id: string) =>
					document.querySelector(
						`[data-slot="history-row"] [title="${id}"]`,
					) !== null,
				txid,
				CHAIN_TIMEOUT,
			);
			const row = await readHistoryRow(browser, txid);
			if (!(await browser.evaluate(claimed, txid))) {
				throw new Error(
					`The handle payment ${txid} is not under Waiting to be claimed, yet History shows it unclaimed: "${row}"`,
				);
			}
			t.diagnostic(
				"The handle inbox claimed the payment before the Send dialog listed it as waiting.",
			);
			return;
		}

		await syncUntilOnHistory(
			browser,
			`wallet A's handle inbox to claim ${txid}`,
			claimed,
			txid,
			async () =>
				`History row: "${(await readHistoryRow(browser, txid)) ?? "not listed"}"`,
		);
	},
);

walletTest(
	"send: PeerPay to wallet A's own identity key is delivered and arrives in Incoming payments",
	async (browser) => {
		const wallet = await testWalletA();

		const review = await reviewPayment(
			browser,
			wallet.identityKey,
			PEERPAY_SATS,
		);
		expectReview(review, {
			Recipient: wallet.identityKey,
			"Identity key": undefined,
			Memo: undefined,
			Delivery:
				"Through MessageBox (PeerPay). They need a PeerPay-compatible wallet.",
			Amount: `${bsv(PEERPAY_SATS)} BSV`,
		});
		const txid = await confirmPayment(
			browser,
			PEERPAY_SATS,
			"Delivered to their MessageBox. They receive it when their wallet next syncs.",
		);
		await finishPayment(browser);

		// Delivered, so nothing is left to retry.
		await browser.click(
			{ role: "button", name: "Send", within: balanceRegion },
			CHAIN_TIMEOUT,
		);
		await browser.waitUntil("the Send dialog", sendDialog);
		const undelivered = await browser.query(
			inSend({
				role: "listitem",
				text: containing("Paid, not yet delivered to their MessageBox."),
			}),
		);
		if (undelivered.count !== 0) {
			throw new Error(
				`A PeerPay payment is still waiting for delivery: "${undelivered.text}"`,
			);
		}
		await closeDialog(browser, sendDialog, "Send");

		// The payment inbox takes it on the next sync and lists it as received:
		// from wallet A, for this amount, with no Failed or Not accepted badge.
		const incoming = {
			key: wallet.identityKey,
			amount: `+${bsv(PEERPAY_SATS)} BSV`,
		};
		await syncUntilOnHistory(
			browser,
			`the PeerPay payment ${txid} in Incoming payments`,
			(args: { key: string; amount: string }) =>
				Array.from(
					document.querySelectorAll(
						'section[aria-label="Incoming payments"] [data-slot="incoming-payment-row"]',
					),
				).some(
					(row) =>
						row.querySelector(`[title="${args.key}"]`) !== null &&
						(row.textContent ?? "").includes(args.amount) &&
						!/Failed|Not accepted/.test(row.textContent ?? ""),
				),
			incoming,
			async () => {
				const rows = await browser.evaluate(
					() =>
						Array.from(
							document.querySelectorAll(
								'section[aria-label="Incoming payments"] [data-slot="incoming-payment-row"]',
							),
						).map((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim()),
					null,
				);
				return `Incoming payments: ${JSON.stringify(rows)}`;
			},
		);
	},
);

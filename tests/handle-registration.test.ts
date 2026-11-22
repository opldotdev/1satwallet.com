import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { HANDLE_CERT_TYPE } from "@1sat/types";
import {
	type AcquireCertificateArgs,
	type CreateSignatureArgs,
	MasterCertificate,
	PrivateKey,
	ProtoWallet,
	Utils,
} from "@bsv/sdk";
import {
	allowsRegistration,
	checkHandleAvailability,
	type DirectCertificate,
	HOST_TEXT_MAX,
	normalizeHandleUsername,
	REGISTRATION_REFUSED_NAME,
	REGISTRATION_TAKEN,
	registerHandle,
	skeinRegistrationSignature,
} from "@/lib/wallet/handle-registration";
import type { HeldHandle } from "@/lib/wallet/handles";

const quiet = { error: console.error };
beforeEach(() => {
	console.error = () => {};
});
afterEach(() => {
	console.error = quiet.error;
});

const certifierKey = PrivateKey.fromRandom();
const certifier = new ProtoWallet(certifierKey);
const certifierPub = certifierKey.toPublicKey().toString();
const subjectKey = PrivateKey.fromRandom();
const subject = subjectKey.toPublicKey().toString();

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/** The handle host for `domain` (testnet.1sat.app), as fetch answers it. */
function host(
	resolveStatus: number,
	identityKey = subject,
	domain = "testnet.1sat.app",
) {
	const urls: string[] = [];
	const answer = (async (input: string | URL | Request) => {
		const url = String(input);
		urls.push(url);
		if (url === `https://${domain}/manifest.json`) {
			return json({
				metanet: {
					handles: { version: "1.0" },
					trust: { publicKey: certifierPub },
				},
			});
		}
		if (resolveStatus !== 200) return json({}, resolveStatus);
		return json({
			metanetHandles: "1.0",
			handle: "alice",
			domain: "testnet.1sat.app",
			identityKey,
			certificate: { subject: identityKey },
			messagebox: "https://testnet.messagebox.1sat.app",
			ttl: 60,
			revoked: false,
		});
	}) as typeof fetch;
	return { fetch: answer, urls };
}

async function directCertificate(
	fields: Record<string, string>,
	over: Partial<DirectCertificate> = {},
	by: ProtoWallet = certifier,
	to: string = subject,
): Promise<DirectCertificate> {
	const cert = await MasterCertificate.issueCertificateForSubject(
		by,
		to,
		fields,
		HANDLE_CERT_TYPE,
	);
	return {
		type: cert.type,
		certifier: cert.certifier,
		acquisitionProtocol: "direct",
		fields: cert.fields,
		serialNumber: cert.serialNumber,
		revocationOutpoint: cert.revocationOutpoint,
		signature: cert.signature as string,
		keyringRevealer: "certifier",
		keyringForSubject: cert.masterKeyring,
		subject: to,
		...over,
	};
}

function subjectWallet(key: PrivateKey = subjectKey) {
	const proto = new ProtoWallet(key);
	const acquired: AcquireCertificateArgs[] = [];
	const signed: CreateSignatureArgs[] = [];
	return {
		acquired,
		signed,
		wallet: {
			decrypt: proto.decrypt.bind(proto),
			createSignature: async (args: CreateSignatureArgs) => {
				signed.push(args);
				return proto.createSignature(args);
			},
			listCertificates: async () => ({
				totalCertificates: 0,
				certificates: [],
			}),
			acquireCertificate: async (args: AcquireCertificateArgs) => {
				acquired.push(args);
				return {} as never;
			},
		},
	};
}

describe("handle usernames", () => {
	it("follows the host's rules", () => {
		assert.equal(normalizeHandleUsername("  Alice-1 "), "alice-1");
		for (const bad of ["ab", "-ab", "ab-", "a_b", "a".repeat(64)]) {
			assert.equal(normalizeHandleUsername(bad), null, bad);
		}
	});
});

describe("checkHandleAvailability", () => {
	it("reads a 404 from the resolver as available", async () => {
		const a = await checkHandleAvailability(
			"alice",
			"test",
			subject,
			host(404),
		);
		assert.deepEqual(a, {
			kind: "available",
			handle: "@alice@testnet.1sat.app",
		});
		assert.equal(allowsRegistration(a), true);
	});

	it("tells this account's handle from someone else's", async () => {
		assert.equal(
			(await checkHandleAvailability("alice", "test", subject, host(200))).kind,
			"yours",
		);
		const other = PrivateKey.fromRandom().toPublicKey().toString();
		const taken = await checkHandleAvailability(
			"alice",
			"test",
			subject,
			host(200, other),
		);
		assert.equal(taken.kind, "taken");
		assert.equal(allowsRegistration(taken), false);
	});

	it("leaves a host that failed as unknown, still registrable", async () => {
		const a = await checkHandleAvailability(
			"alice",
			"test",
			subject,
			host(500),
		);
		assert.equal(a.kind, "unknown");
		assert.equal(allowsRegistration(a), true);
		assert.equal(
			(await checkHandleAvailability("x", "test", subject, host(404))).kind,
			"invalid",
		);
	});
});

const mainHost = host(404, subject, "1sat.app").fetch;

describe("registerHandle on mainnet (wallet-server)", () => {
	it("posts to the chain's account host and files a certificate that checks out", async () => {
		const cert = await directCertificate({
			handle: "alice",
			domain: "1sat.app",
		});
		const posted: [string, string][] = [];
		const { wallet, acquired } = subjectWallet();
		const handle = await registerHandle(
			"Alice",
			{ wallet, chain: "main", identityKey: subject },
			{
				fetch: mainHost,
				post: async (url, body) => {
					posted.push([url, body]);
					return json({
						username: "alice",
						identityKey: subject,
						certificate: cert,
					});
				},
			},
		);
		assert.equal(handle, "@alice@1sat.app");
		assert.deepEqual(posted, [
			[
				"https://accounts.1sat.app/account/register",
				JSON.stringify({ username: "alice" }),
			],
		]);
		assert.equal(acquired.length, 1);
		assert.equal(acquired[0].acquisitionProtocol, "direct");
		assert.equal(acquired[0].serialNumber, cert.serialNumber);
		assert.deepEqual(
			{ ...acquired[0].keyringForSubject },
			{ ...cert.keyringForSubject },
		);
	});

	it("refuses a certificate from the published certifier that was tampered with, or is for another subject", async () => {
		const refused = async (cert: DirectCertificate) => {
			const { wallet, acquired } = subjectWallet();
			await assert.rejects(
				registerHandle(
					"alice",
					{ wallet, chain: "main", identityKey: subject },
					{
						fetch: mainHost,
						post: async () => json({ certificate: cert }),
					},
				),
				/didn't check out/,
			);
			assert.equal(acquired.length, 0);
		};
		const good = await directCertificate({
			handle: "alice",
			domain: "1sat.app",
		});
		// A flipped signature byte.
		const sig = good.signature;
		const flipped = (Number.parseInt(sig.slice(-2), 16) ^ 1)
			.toString(16)
			.padStart(2, "0");
		await refused({ ...good, signature: sig.slice(0, -2) + flipped });
		// A field swapped for another certificate's: the signature no longer covers it.
		const other = await directCertificate({
			handle: "mallory",
			domain: "1sat.app",
		});
		await refused({
			...good,
			fields: { ...good.fields, handle: other.fields.handle },
		});
		// A genuine certificate, for someone else.
		const stranger = PrivateKey.fromRandom().toPublicKey().toString();
		const theirs = await MasterCertificate.issueCertificateForSubject(
			certifier,
			stranger,
			{ handle: "alice", domain: "1sat.app" },
			HANDLE_CERT_TYPE,
		);
		await refused({
			...good,
			fields: theirs.fields,
			serialNumber: theirs.serialNumber,
			revocationOutpoint: theirs.revocationOutpoint,
			signature: theirs.signature as string,
			keyringForSubject: theirs.masterKeyring,
			subject: stranger,
		});
	});

	it("refuses a certificate for another handle, or from another certifier", async () => {
		const run = async (cert: DirectCertificate) => {
			const { wallet, acquired } = subjectWallet();
			await assert.rejects(
				registerHandle(
					"alice",
					{ wallet, chain: "main", identityKey: subject },
					{
						fetch: mainHost,
						post: async () => json({ certificate: cert }),
					},
				),
				/didn't check out/,
			);
			assert.equal(acquired.length, 0);
		};
		await run(
			await directCertificate({
				handle: "mallory",
				domain: "1sat.app",
			}),
		);
		await run(
			await directCertificate(
				{ handle: "alice", domain: "1sat.app" },
				{ certifier: PrivateKey.fromRandom().toPublicKey().toString() },
			),
		);
	});

	it("shows fixed text for a refusal, caps any other host text, and posts nothing without a certifier key", async () => {
		const { wallet } = subjectWallet();
		const refusal = (status: number, error: string) =>
			registerHandle(
				"alice",
				{ wallet, chain: "main", identityKey: subject },
				{ fetch: mainHost, post: async () => json({ error }, status) },
			).then(
				() => assert.fail("registered"),
				(e: Error) => e.message,
			);
		assert.equal(
			await refusal(409, "<b>username taken</b>"),
			REGISTRATION_TAKEN,
		);
		assert.equal(
			await refusal(400, "invalid username: lowercase letters..."),
			REGISTRATION_REFUSED_NAME,
		);
		const long = await refusal(503, "x".repeat(500));
		assert.equal(long.length, HOST_TEXT_MAX);
		assert.ok(long.endsWith("…"));
		let posted = false;
		await assert.rejects(
			registerHandle(
				"alice",
				{ wallet, chain: "main", identityKey: subject },
				{
					fetch: (async () => json({}, 404)) as typeof fetch,
					post: async () => {
						posted = true;
						return json({});
					},
				},
			),
			/doesn't say which key certifies its handles/,
		);
		assert.equal(posted, false);
	});
});

/** iOS `HandleRegistrationTests.key`: 31 zero bytes, then `byte`. */
const keyOf = (byte: number) =>
	new PrivateKey([...new Array(31).fill(0), byte]);

const SKEIN_HOST = JSON.stringify({
	origin: "https://testnet.1sat.app",
	domain: "testnet.1sat.app",
});

/** The manifest skein-onboard serves at a host's origin: the certifier and the BRC-169 endpoints. */
const skeinManifest = (key: string, origin = "https://testnet.1sat.app") => ({
	name: "testnet.1sat.app",
	metanet: {
		trust: { name: "testnet.1sat.app", publicKey: key },
		handles: {
			version: "1.0",
			resolve: `${origin}/.well-known/metanet-handles/resolve`,
			search: `${origin}/.well-known/metanet-handles/search`,
		},
	},
});

/**
 * A skein host: `skeinHost` answers `/.well-known/skein-host` at the domain
 * (null: 404, an Error: the read throws), and `<origin>/manifest.json` is
 * `manifest`.
 */
function skein(
	opts: {
		skeinHost?: string | null | Error;
		origin?: string;
		manifest?: unknown;
		manifestStatus?: number;
	} = {},
) {
	const origin = opts.origin ?? "https://testnet.1sat.app";
	const skeinHost = opts.skeinHost === undefined ? SKEIN_HOST : opts.skeinHost;
	const urls: string[] = [];
	const answer = (async (input: string | URL | Request) => {
		const url = String(input);
		urls.push(url);
		if (url === "https://testnet.1sat.app/.well-known/skein-host") {
			if (skeinHost instanceof Error) throw skeinHost;
			return skeinHost === null
				? json({}, 404)
				: new Response(skeinHost, { status: 200 });
		}
		if (url === `${origin}/manifest.json`) {
			return json(
				opts.manifest ?? skeinManifest(certifierPub, origin),
				opts.manifestStatus ?? 200,
			);
		}
		return json({}, 404);
	}) as typeof fetch;
	return { fetch: answer, urls };
}

/**
 * What skein-onboard's `/onboard/register` answers (1sat-accounts
 * `Registration`): the certificate with its BRC-52 encrypted fields, and the
 * keyring beside it.
 */
async function skeinAnswer(
	opts: {
		handle?: string;
		domain?: string;
		bodyDomain?: string;
		by?: ProtoWallet;
		to?: string;
	} = {},
) {
	const handle = opts.handle ?? "alice";
	const domain = opts.domain ?? "testnet.1sat.app";
	const to = opts.to ?? subject;
	const { keyringForSubject, ...direct } = await directCertificate(
		{ handle, domain },
		{},
		opts.by ?? certifier,
		to,
	);
	const {
		acquisitionProtocol: _a,
		keyringRevealer: _k,
		...certificate
	} = direct;
	return {
		handle,
		domain: opts.bodyDomain ?? domain,
		identityKey: to,
		messagebox: "https://accounts.testnet.1sat.app/messagebox",
		certificate,
		keyringForSubject,
	};
}

/** Registers `alice` on testnet against `host`, the post answering `answer`. */
async function skeinRegister(
	host: ReturnType<typeof skein>,
	answer: () => Response | Promise<Response>,
	opts: {
		key?: PrivateKey;
		input?: string;
		held?: HeldHandle[];
	} = {},
) {
	const key = opts.key ?? subjectKey;
	const identityKey = key.toPublicKey().toString();
	const { wallet, acquired, signed } = subjectWallet(key);
	const posted: [string, Record<string, string>][] = [];
	const result = registerHandle(
		opts.input ?? "alice",
		{ wallet, chain: "test", identityKey },
		{
			fetch: host.fetch,
			post: async (url, body) => {
				posted.push([url, JSON.parse(body)]);
				return answer();
			},
			listHandles: async () => opts.held ?? [],
		},
	);
	return { result, acquired, signed, posted, identityKey };
}

describe("registerHandle on testnet (skein)", () => {
	it("makes the signature @bsv/sdk makes (skein-onboard's and iOS's vectors)", async () => {
		const dave = new PrivateKey(new Array(32).fill(0x11));
		assert.equal(
			dave.toPublicKey().toString(),
			"034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
		);
		assert.equal(
			await skeinRegistrationSignature(
				new ProtoWallet(dave),
				"dave",
				"skein.nexus",
			),
			"304402200a82728a4f38ed26e2cf8bda5503ad0b4ca90bbae6dce612031f8929f7fc905402202ed3ba1742934ed23cb232ff907e667040ea77b171f0b8e0fe3eb814bf0622a5",
		);
		assert.equal(
			await skeinRegistrationSignature(
				new ProtoWallet(keyOf(7)),
				"alice",
				"testnet.1sat.app",
			),
			"3044022061e2f0d1b6b0214e591f3ef11ad0bb898799b993634661956e6fafd9046cfc3902207a643e929671642c30f4abd9acfbc06ad724f1dc0143d1f9f8ab592058508d85",
		);
	});

	it("signs the post with the account's key and files the certificate", async () => {
		const account = keyOf(7);
		const host = skein();
		const answer = await skeinAnswer({
			to: account.toPublicKey().toString(),
		});
		const { result, acquired, signed, posted } = await skeinRegister(
			host,
			() => json(answer),
			{ key: account, input: " Alice " },
		);
		assert.equal(await result, "@alice@testnet.1sat.app");
		assert.deepEqual(host.urls, [
			"https://testnet.1sat.app/.well-known/skein-host",
			"https://testnet.1sat.app/manifest.json",
		]);
		assert.deepEqual(posted, [
			[
				"https://testnet.1sat.app/account/register",
				{
					username: "alice",
					identityKey:
						"025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc",
					signature:
						"3044022061e2f0d1b6b0214e591f3ef11ad0bb898799b993634661956e6fafd9046cfc3902207a643e929671642c30f4abd9acfbc06ad724f1dc0143d1f9f8ab592058508d85",
				},
			],
		]);
		assert.equal(signed.length, 1);
		assert.deepEqual(signed[0].protocolID, [2, "skein register"]);
		assert.equal(signed[0].keyID, "alice");
		assert.equal(signed[0].counterparty, "anyone");
		assert.equal(
			Utils.toUTF8(signed[0].data ?? []),
			"register alice@testnet.1sat.app",
		);
		assert.equal(acquired.length, 1);
		assert.equal(acquired[0].acquisitionProtocol, "direct");
		assert.equal(acquired[0].keyringRevealer, "certifier");
		assert.equal(acquired[0].certifier, certifierPub);
		assert.equal(acquired[0].serialNumber, answer.certificate.serialNumber);
		assert.deepEqual(
			{ ...acquired[0].keyringForSubject },
			{ ...answer.keyringForSubject },
		);
	});

	it("posts to the origin and signs for the domain the skein host reports", async () => {
		const host = skein({
			skeinHost: JSON.stringify({
				origin: "https://router.example:8443/ignored",
				domain: "Example.Test",
			}),
			origin: "https://router.example:8443",
		});
		const { result, posted, signed } = await skeinRegister(host, async () =>
			json(await skeinAnswer({ domain: "example.test" })),
		);
		assert.equal(await result, "@alice@example.test");
		assert.deepEqual(host.urls, [
			"https://testnet.1sat.app/.well-known/skein-host",
			"https://router.example:8443/manifest.json",
		]);
		assert.equal(posted[0][0], "https://router.example:8443/account/register");
		assert.equal(
			Utils.toUTF8(signed[0].data ?? []),
			"register alice@example.test",
		);
	});

	it("takes a domain that answers no skein host, or whose read throws, as its own host", async () => {
		for (const skeinHost of [
			null,
			new Error("timed out"),
			"not json",
			JSON.stringify({ origin: "http://insecure.example" }),
		]) {
			const { result, posted } = await skeinRegister(
				skein({ skeinHost }),
				async () => json(await skeinAnswer()),
			);
			assert.equal(await result, "@alice@testnet.1sat.app");
			assert.equal(posted[0][0], "https://testnet.1sat.app/account/register");
		}
	});

	it("posts nothing when the host's manifest names no handle certifier or can't be read", async () => {
		const trustOnly = { metanet: { trust: { publicKey: certifierPub } } };
		const unknown = await skeinRegister(skein({ manifest: trustOnly }), () =>
			json({}),
		);
		await assert.rejects(
			unknown.result,
			/^HandleRegistrationError: testnet\.1sat\.app doesn't say which key certifies its handles/,
		);
		assert.equal(unknown.posted.length, 0);
		const down = await skeinRegister(skein({ manifestStatus: 503 }), () =>
			json({}),
		);
		await assert.rejects(down.result, {
			message:
				"Couldn't read which key certifies testnet.1sat.app's handles (it answered HTTP 503), so nothing was registered. Try again later.",
		});
		assert.equal(down.posted.length, 0);
	});

	it("refuses a certificate from another certifier, for another key, or for another domain", async () => {
		const impostor = new ProtoWallet(PrivateKey.fromRandom());
		const stranger = PrivateKey.fromRandom().toPublicKey().toString();
		for (const answer of [
			await skeinAnswer({ by: impostor }),
			await skeinAnswer({ to: stranger, bodyDomain: "testnet.1sat.app" }),
			await skeinAnswer({ domain: "other.example" }),
			// The certificate's own domain field must be the host's domain.
			await skeinAnswer({
				domain: "other.example",
				bodyDomain: "testnet.1sat.app",
			}),
		]) {
			const { result, acquired } = await skeinRegister(skein(), () =>
				json(answer),
			);
			await assert.rejects(result, /didn't check out/);
			assert.equal(acquired.length, 0);
		}
	});

	it("refuses an answer for another name, and one it can't read", async () => {
		const mallory = await skeinRegister(skein(), async () =>
			json(await skeinAnswer({ handle: "mallory" })),
		);
		await assert.rejects(mallory.result, {
			message:
				"The host answered for mallory instead of alice, so nothing was kept.",
		});
		const { keyringForSubject: _, ...noKeyring } = await skeinAnswer();
		const unread = await skeinRegister(skein(), () => json(noKeyring));
		await assert.rejects(unread.result, /can't read/);
		assert.equal(unread.acquired.length, 0);
		const notJson = await skeinRegister(
			skein(),
			() => new Response("<html>", { status: 200 }),
		);
		await assert.rejects(notJson.result, /can't read/);
		const { certificate: __, ...noCert } = await skeinAnswer();
		const none = await skeinRegister(skein(), () => json(noCert));
		await assert.rejects(none.result, {
			message:
				"The host registered alice but issued no handle certificate for it.",
		});
	});

	it("reads a refusal, or any answer but 200, in the host's words", async () => {
		const refused = await skeinRegister(skein(), () =>
			json({ error: "handle alice is another key's" }, 409),
		);
		await assert.rejects(refused.result, {
			message:
				"The handle host refused the registration: handle alice is another key's",
		});
		const created = await skeinRegister(skein(), async () =>
			json(await skeinAnswer(), 201),
		);
		await assert.rejects(created.result, /refused the registration/);
		assert.equal(created.acquired.length, 0);
		const empty = await skeinRegister(
			skein(),
			() => new Response("", { status: 502 }),
		);
		await assert.rejects(empty.result, {
			message:
				"The handle host refused the registration: /account/register 502",
		});
	});

	it("posts nothing for a handle the wallet holds from this host, under any serial", async () => {
		const held: HeldHandle = {
			handle: "alice",
			domain: "testnet.1sat.app",
			certifier: certifierPub,
			serialNumber: Utils.toBase64(new Array(32).fill(7)),
		};
		const { result, posted, acquired } = await skeinRegister(
			skein(),
			() => json({}),
			{ held: [held] },
		);
		assert.equal(await result, "@alice@testnet.1sat.app");
		assert.equal(posted.length, 0);
		assert.equal(acquired.length, 0);
		// One from another certifier or at another domain doesn't stop it.
		const elsewhere = await skeinRegister(
			skein(),
			async () => json(await skeinAnswer()),
			{
				held: [
					{
						...held,
						certifier: PrivateKey.fromRandom().toPublicKey().toString(),
					},
					{ ...held, domain: "other.example" },
				],
			},
		);
		assert.equal(await elsewhere.result, "@alice@testnet.1sat.app");
		assert.equal(elsewhere.posted.length, 1);
		assert.equal(elsewhere.acquired.length, 1);
	});
});

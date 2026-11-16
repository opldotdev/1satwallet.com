import assert from "node:assert/strict";
import test from "node:test";
import {
	bapDisplayName,
	buildBapAttestationReview,
	EMPTY_BAP_PROFILE,
	hasProfileErrors,
	identityActionMessage,
	imageReferenceOrigin,
	isSafePublicImageUrl,
	mergeBapProfile,
	normalizeBapDiscovery,
	ordinalImageReference,
	profileDraftFromRecord,
	storedImageReference,
	validateBapProfile,
} from "../lib/wallet/bap-identity";

test("accepts wallet 1sat image references but rejects non-content targets", () => {
	const image = `1sat://${"ab".repeat(32)}.0`;
	assert.equal(isSafePublicImageUrl(image), true);
	assert.equal(isSafePublicImageUrl("1sat://wallet/settings"), false);
	assert.equal(isSafePublicImageUrl(`${image}/../../settings`), false);
	const result = validateBapProfile(
		profileDraftFromRecord({ name: "Satchmo", image }),
	);
	assert.deepEqual(result.errors, {});
	assert.equal(result.profile.image, image);
});

test("validates and trims the fixed public BAP profile schema", () => {
	const result = validateBapProfile({
		name: " Alice ",
		alternateName: "alice",
		description: "Public builder",
		image: "https://example.com/alice.png",
		banner: "",
		email: "alice@example.com",
		paymail: "alice@1sat.app",
	});
	assert.deepEqual(result.errors, {});
	assert.deepEqual(result.profile, {
		"@type": "Person",
		name: "Alice",
		alternateName: "alice",
		description: "Public builder",
		image: "https://example.com/alice.png",
		email: "alice@example.com",
		paymail: "alice@1sat.app",
	});
});

test("rejects unsafe profile URLs and malformed contact fields", () => {
	const result = validateBapProfile({
		name: "Alice",
		alternateName: "",
		description: "",
		image: "javascript:alert(1)",
		banner: "http://example.com/banner.png",
		email: "not-an-email",
		paymail: "not-paymail",
	});
	assert.equal(
		result.errors.image,
		"Use an https://, ord://, or 1sat:// image URL.",
	);
	assert.equal(
		result.errors.banner,
		"Use an https://, ord://, or 1sat:// image URL.",
	);
	assert.equal(result.errors.email, "Enter a valid email address.");
	assert.equal(result.errors.paymail, "Enter a valid Paymail address.");
});

test("only reads known string fields from stored profile data", () => {
	assert.deepEqual(
		profileDraftFromRecord({
			name: "Alice",
			email: { secret: true },
			admin: true,
		}),
		{
			name: "Alice",
			alternateName: "",
			description: "",
			image: "",
			banner: "",
			email: "",
			paymail: "",
		},
	);
});

test("derives the protocol attestation claim deterministically", () => {
	const review = buildBapAttestationReview({
		subject: "3SyWUZXvhidNcEHbAC3HkBnKoD2Q",
		attributeUrn:
			"urn:bap:id:name:John Doe:e2c6fb4063cc04af58935737eaffc938011dff546d47b7fbb18ed346f8c4d4fa",
		counter: "0",
	});
	assert.equal(
		review.attributeHash,
		"b17c8e606afcf0d8dca65bdf8f33d275239438116557980203c82b0fae259838",
	);
	assert.equal(
		review.attestationUrn,
		"bap:attest:b17c8e606afcf0d8dca65bdf8f33d275239438116557980203c82b0fae259838:3SyWUZXvhidNcEHbAC3HkBnKoD2Q",
	);
	assert.equal(
		review.attestationHash,
		"b5b3f0e9deb8cadd91910e6570c252a71f599559798ae3295f72d3ffa30b7469",
	);
});

test("rejects partial claims and invalid sequences", () => {
	assert.throws(
		() =>
			buildBapAttestationReview({
				subject: "identity123",
				attributeUrn: "name:Alice",
			}),
		/full urn:bap:id/,
	);
	assert.throws(
		() =>
			buildBapAttestationReview({
				subject: "identity123",
				attributeUrn: "urn:bap:id:name:Alice:nonce",
				counter: "-1",
			}),
		/non-negative decimal/,
	);
});

test("discovery normalization exposes only approved public fields", () => {
	const result = normalizeBapDiscovery([
		{
			idKey: "identity123",
			currentAddress: "1PublicAddress",
			identity: {
				name: "Alice",
				description: "Public profile",
				email: "private@example.com",
				secret: "do-not-render",
				image: "javascript:alert(1)",
			},
		},
		{ idKey: "bad id" },
	]);
	assert.deepEqual(result, [
		{
			idKey: "identity123",
			currentAddress: "1PublicAddress",
			firstSeen: undefined,
			name: "Alice",
			alternateName: undefined,
			description: "Public profile",
			image: undefined,
		},
	]);
});

test("wallet rejection messages never echo provider payloads", () => {
	const message = identityActionMessage(
		"profile",
		new Error("User rejected seed=super-secret"),
	);
	assert.equal(
		message,
		"The wallet did not authorize this request. Nothing was changed.",
	);
	assert.doesNotMatch(message, /super-secret/);
});

test("profile save keeps published fields the editor does not edit", () => {
	const published = {
		"@context": "https://schema.org",
		"@type": "Person",
		name: "Alice",
		alternateName: "alice",
		image: { "@type": "ImageObject", url: "https://example.com/a.png" },
		banner: `1sat://${"ef".repeat(32)}_0`,
		logo: "https://example.com/logo.png",
		url: "https://alice.example",
		sameAs: ["https://x.com/alice"],
		email: "alice@example.com",
	};
	const baseline = profileDraftFromRecord(published);
	const draft = {
		...baseline,
		alternateName: "Alice B",
		description: "Builder",
		email: "",
	};
	assert.deepEqual(mergeBapProfile(published, baseline, draft), {
		"@context": "https://schema.org",
		"@type": "Person",
		name: "Alice",
		alternateName: "Alice B",
		description: "Builder",
		image: { "@type": "ImageObject", url: "https://example.com/a.png" },
		banner: `1sat://${"ef".repeat(32)}_0`,
		logo: "https://example.com/logo.png",
		url: "https://alice.example",
		sameAs: ["https://x.com/alice"],
	});
});

test("profile save keeps fields another client changed after the editor opened", () => {
	const opened = { "@type": "Person", name: "Alice", alternateName: "alice" };
	const baseline = profileDraftFromRecord(opened);
	const current = { ...opened, name: "Alice Cooper", banner: "https://b.png" };
	const draft = { ...baseline, description: "Hi" };
	assert.deepEqual(mergeBapProfile(current, baseline, draft), {
		"@type": "Person",
		name: "Alice Cooper",
		alternateName: "alice",
		banner: "https://b.png",
		description: "Hi",
	});
	assert.deepEqual(mergeBapProfile(undefined, baseline, draft), {
		"@type": "Person",
		description: "Hi",
	});
});

test("profile save ignores a non-object published alias", () => {
	const baseline = profileDraftFromRecord(undefined);
	const draft = { ...baseline, name: "Alice" };
	for (const legacy of ["hello", ["a", "b"], 42]) {
		assert.deepEqual(mergeBapProfile(legacy, baseline, draft), {
			"@type": "Person",
			name: "Alice",
		});
	}
});

test("display name prefers alternateName, then name", () => {
	assert.equal(bapDisplayName({ name: "Alice", alternateName: "ali" }), "ali");
	assert.equal(bapDisplayName({ name: "Alice", alternateName: " " }), "Alice");
	assert.equal(bapDisplayName({}), undefined);
});

const TXID = "0f".repeat(32);

test("image references round-trip with the 1sat:// form the iOS app writes", () => {
	// AvatarReference.ordinal("txid_vout") on iOS and the Yours AvatarPicker
	// both write `1sat://txid.vout` for an ordinal origin.
	const ios = `1sat://${TXID}.3`;
	assert.equal(ordinalImageReference(`${TXID}_3`), ios);
	assert.equal(imageReferenceOrigin(ios), `${TXID}_3`);
	assert.equal(ordinalImageReference(imageReferenceOrigin(ios) ?? ""), ios);
	// Older and pasted forms are read, then stored the way iOS stores them.
	for (const pasted of [
		ios,
		`ord://${TXID}_3`,
		`${TXID}_3`,
		`${TXID}.3`,
		` 1sat://${TXID.toUpperCase()}.3 `,
	]) {
		assert.equal(storedImageReference(pasted), ios, pasted);
	}
	assert.equal(storedImageReference(`1sat://${TXID}`), `1sat://${TXID}.0`);
	assert.equal(
		storedImageReference("https://example.com/b.png"),
		"https://example.com/b.png",
	);
	for (const rejected of [
		"",
		"http://example.com/b.png",
		"javascript:alert(1)",
		`1sat://${TXID}.3/../settings`,
		"1sat://wallet/settings",
	]) {
		assert.equal(storedImageReference(rejected), undefined, rejected);
	}
});

test("banner is validated like the avatar and stored as 1sat://txid.vout", () => {
	const draft = profileDraftFromRecord({
		image: `ord://${TXID}_0`,
		banner: `${TXID}_1`,
	});
	const result = validateBapProfile(draft);
	assert.deepEqual(result.errors, {});
	assert.equal(result.profile.image, `1sat://${TXID}.0`);
	assert.equal(result.profile.banner, `1sat://${TXID}.1`);
});

test("banner reads the published banner, falling back to a legacy coverImage", () => {
	assert.equal(
		profileDraftFromRecord({ banner: "https://b.png", coverImage: "x" }).banner,
		"https://b.png",
	);
	assert.equal(
		profileDraftFromRecord({ coverImage: "https://c.png" }).banner,
		"https://c.png",
	);
	assert.equal(profileDraftFromRecord({ banner: { url: "x" } }).banner, "");
});

test("profile save writes an edited banner and keeps everything else", () => {
	const published = {
		"@context": "https://schema.org",
		"@type": "Person",
		alternateName: "alice",
		image: `1sat://${TXID}.0`,
		logo: "https://example.com/logo.png",
		url: "https://alice.example",
	};
	const baseline = profileDraftFromRecord(published);
	const draft = { ...baseline, banner: `1sat://${TXID}.2` };
	assert.deepEqual(mergeBapProfile(published, baseline, draft), {
		...published,
		banner: `1sat://${TXID}.2`,
	});
});

test("profile save keeps an unedited banner and removes a cleared one", () => {
	const published = {
		"@type": "Person",
		name: "Alice",
		banner: `1sat://${TXID}.1`,
	};
	const baseline = profileDraftFromRecord(published);
	assert.deepEqual(
		mergeBapProfile(published, baseline, { ...baseline, name: "Al" }),
		{ "@type": "Person", name: "Al", banner: `1sat://${TXID}.1` },
	);
	assert.deepEqual(
		mergeBapProfile(published, baseline, { ...baseline, banner: " " }),
		{ "@type": "Person", name: "Alice" },
	);
});

test("an edited banner replaces a legacy coverImage; an unedited one keeps it", () => {
	const published = { "@type": "Person", coverImage: "https://c.png" };
	const baseline = profileDraftFromRecord(published);
	assert.deepEqual(
		mergeBapProfile(published, baseline, { ...baseline, name: "Alice" }),
		{ "@type": "Person", coverImage: "https://c.png", name: "Alice" },
	);
	assert.deepEqual(
		mergeBapProfile(published, baseline, {
			...baseline,
			banner: `1sat://${TXID}.4`,
		}),
		{ "@type": "Person", banner: `1sat://${TXID}.4` },
	);
});

test("an unedited published image or banner the editor would not write does not block saving", () => {
	const published = {
		"@type": "Person",
		name: "Alice",
		image: "ipfs://bafy/avatar.png",
		coverImage: "http://example.com/cover.png",
	};
	const baseline = profileDraftFromRecord(published);
	const draft = { ...baseline, name: "Alicia" };
	const result = validateBapProfile(draft, baseline);
	assert.deepEqual(result.errors, {});
	assert.equal(hasProfileErrors(result.errors), false);
	assert.deepEqual(mergeBapProfile(published, baseline, draft), {
		...published,
		name: "Alicia",
	});
	// Editing the field makes it the editor's to check again.
	const edited = validateBapProfile(
		{ ...draft, banner: "http://example.com/other.png" },
		baseline,
	);
	assert.equal(
		edited.errors.banner,
		"Use an https://, ord://, or 1sat:// image URL.",
	);
	assert.equal(edited.errors.image, undefined);
});

test("https image URLs carrying a username or password are not published", () => {
	for (const rejected of [
		"https://user@example.com/a.png",
		"https://user:secret@example.com/a.png",
		"https://:secret@example.com/a.png",
	]) {
		assert.equal(storedImageReference(rejected), undefined, rejected);
		assert.equal(
			validateBapProfile({ ...EMPTY_BAP_PROFILE, image: rejected }).errors
				.image,
			"Use an https://, ord://, or 1sat:// image URL.",
		);
	}
	const withQuery = "https://example.com/a.png?v=2#crop";
	assert.equal(storedImageReference(withQuery), withQuery);
});

test("output indexes are parsed as UInt32 and written in canonical decimal", () => {
	assert.equal(storedImageReference(`1sat://${TXID}.007`), `1sat://${TXID}.7`);
	assert.equal(imageReferenceOrigin(`ord://${TXID}_000`), `${TXID}_0`);
	assert.equal(
		storedImageReference(`${TXID}.4294967295`),
		`1sat://${TXID}.4294967295`,
	);
	for (const rejected of [
		`1sat://${TXID}.4294967296`,
		`1sat://${TXID}.12345678901`,
		`1sat://${TXID}.${"9".repeat(400)}`,
	]) {
		assert.equal(imageReferenceOrigin(rejected), undefined, rejected);
		assert.equal(storedImageReference(rejected), undefined, rejected);
		assert.equal(isSafePublicImageUrl(rejected), false, rejected);
	}
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	centredScrollLeft,
	type Glide,
	glideDuration,
	glideFrame,
	glidePosition,
	planCentre,
	type RowView,
	tabInView,
} from "../lib/wallet-tab-scroll";

// A 375px phone: the row is 343px wide from x=16 and 529px of tabs long.
const row = (scrollLeft: number) => ({
	left: 16,
	scrollLeft,
	clientWidth: 343,
	scrollWidth: 529,
});

describe("centredScrollLeft", () => {
	it("centres a middle tab", () => {
		// Certificates starts 287px into the row and is 104px wide.
		assert.equal(
			centredScrollLeft(row(0), { left: 16 + 287, width: 104 }),
			287 + 52 - 343 / 2,
		);
	});

	it("gives the same target wherever the row is scrolled", () => {
		const atZero = centredScrollLeft(row(0), { left: 16 + 287, width: 104 });
		const atEnd = centredScrollLeft(row(186), {
			left: 16 + 287 - 186,
			width: 104,
		});
		assert.equal(atEnd, atZero);
	});

	it("keeps the first tab at the start, even from the far end", () => {
		// The Wallet tab, scrolled past the left edge.
		assert.equal(centredScrollLeft(row(186), { left: 16 - 186, width: 66 }), 0);
	});

	it("keeps the last tab at the end", () => {
		assert.equal(
			centredScrollLeft(row(0), { left: 16 + 457, width: 72 }),
			529 - 343,
		);
	});

	it("does not scroll a row that fits", () => {
		assert.equal(
			centredScrollLeft(
				{ left: 0, scrollLeft: 0, clientWidth: 900, scrollWidth: 900 },
				{ left: 700, width: 80 },
			),
			0,
		);
	});
});

describe("tabInView", () => {
	const box = { left: 16, right: 359 };
	it("holds for a tab wholly inside the row", () => {
		assert.equal(tabInView({ left: 16, right: 82 }, box), true);
	});
	it("allows a pixel of rounding either side", () => {
		assert.equal(tabInView({ left: 15.2, right: 359.8 }, box), true);
	});
	it("fails for a tab cut by either edge", () => {
		assert.equal(tabInView({ left: -150, right: -84 }, box), false);
		assert.equal(tabInView({ left: 320, right: 392 }, box), false);
	});
});

describe("glide", () => {
	it("starts where it was and ends exactly on the target", () => {
		assert.equal(glidePosition(186, 0, 0, 300), 186);
		assert.equal(glidePosition(186, 0, 300, 300), 0);
		assert.equal(glidePosition(186, 0, 1000, 300), 0);
	});

	it("eases out: past halfway at the halfway mark, and only ever forward", () => {
		const mid = glidePosition(0, 100, 150, 300);
		assert.ok(mid > 50 && mid < 100, `halfway is at ${mid}`);
		let last = 0;
		for (let ms = 0; ms <= 300; ms += 16) {
			const at = glidePosition(0, 100, ms, 300);
			assert.ok(at >= last, `went back at ${ms}ms`);
			last = at;
		}
	});

	it("jumps straight there with no duration", () => {
		assert.equal(glidePosition(40, 10, 0, 0), 10);
	});

	it("takes 150 to 400 ms, longer for longer hops", () => {
		assert.equal(glideDuration(0), 150);
		assert.equal(glideDuration(-20), 170);
		assert.equal(glideDuration(186), 336);
		assert.equal(glideDuration(5000), 400);
	});
});

// The same phone row, seen whole: Certificates is current unless said
// otherwise, `start` px into the row and `width` px wide.
function view({
	scrollLeft = 0,
	scrollWidth = 529,
	start = 287,
	width = 104,
	boxWidth = 343,
	href = "/wallet/certificates" as string | null,
} = {}): RowView {
	const left = 16 + start - scrollLeft;
	return {
		row: { left: 16, scrollLeft, clientWidth: boxWidth, scrollWidth },
		box: { left: 16, right: 16 + boxWidth, width: boxWidth },
		tab: href === null ? null : { left, right: left + width, width },
		href,
	};
}

// The glide from the start of the row to Certificates.
const toCertificates: Glide = {
	href: "/wallet/certificates",
	from: 0,
	target: 287 + 52 - 343 / 2,
	duration: 300,
};

describe("planCentre", () => {
	it("glides to the current tab", () => {
		assert.deepEqual(planCentre(view(), false), {
			type: "glide",
			glide: { ...toCertificates, duration: glideDuration(167.5) },
		});
	});

	it("jumps under reduced motion, or when already there", () => {
		assert.deepEqual(planCentre(view(), true), { type: "jump", left: 167.5 });
		assert.deepEqual(planCentre(view({ scrollLeft: 167.5 }), false), {
			type: "jump",
			left: 167.5,
		});
	});

	it("does nothing when no tab is current", () => {
		assert.deepEqual(planCentre(view({ href: null }), false), {
			type: "none",
		});
	});

	it("defers a row or a tab with no width until it has one", () => {
		assert.deepEqual(planCentre(view({ boxWidth: 0 }), false), {
			type: "defer",
		});
		assert.deepEqual(planCentre(view({ width: 0 }), true), { type: "defer" });
	});
});

describe("glideFrame", () => {
	const quiet = { elapsed: 100, written: 80, userInput: false };

	it("steps along the glide while it runs", () => {
		assert.deepEqual(
			glideFrame(toCertificates, view({ scrollLeft: 80 }), quiet),
			{ type: "step", left: glidePosition(0, 167.5, 100, 300) },
		);
	});

	it("stops when another section becomes current, or none is", () => {
		assert.deepEqual(
			glideFrame(
				toCertificates,
				view({ scrollLeft: 80, start: 66, href: "/wallet/ordinals" }),
				quiet,
			),
			{ type: "stop" },
		);
		assert.deepEqual(
			glideFrame(toCertificates, view({ scrollLeft: 80, href: null }), quiet),
			{ type: "stop" },
		);
	});

	it("yields to a finger, pointer, wheel or key on the row", () => {
		// A resting finger has not moved the row yet; a drag has.
		for (const scrollLeft of [80, 30]) {
			assert.deepEqual(
				glideFrame(toCertificates, view({ scrollLeft }), {
					...quiet,
					userInput: true,
				}),
				{ type: "yield" },
			);
		}
	});

	it("aims again when the layout clamps the row with no one touching it", () => {
		// The tabs change mid-glide: the row shrinks to 400px of tabs, so the
		// browser clamps scrollLeft from 80 to 57.
		const clamped = view({
			scrollLeft: 57,
			scrollWidth: 400,
			start: 200,
			width: 90,
		});
		assert.deepEqual(glideFrame(toCertificates, clamped, quiet), {
			type: "reaim",
		});
		// Aiming again from there puts the tab in view rather than leaving it.
		const plan = planCentre(clamped, false);
		assert.deepEqual(plan, { type: "jump", left: 57 });
		const tab = clamped.tab;
		assert.ok(tab && tabInView(tab, clamped.box));
	});

	it("lands on its target when the tab is in view there", () => {
		assert.deepEqual(
			glideFrame(toCertificates, view({ scrollLeft: 160 }), {
				...quiet,
				elapsed: 300,
				written: 160,
			}),
			{ type: "land", left: 167.5 },
		);
	});

	it("lands centred on the tab when the layout moved it out of view", () => {
		// Tabs were added before Certificates without moving the row: at the
		// old target it would sit past the right edge.
		const moved = view({ scrollLeft: 160, scrollWidth: 800, start: 500 });
		assert.deepEqual(
			glideFrame(toCertificates, moved, {
				...quiet,
				elapsed: 300,
				written: 160,
			}),
			{ type: "land", left: 500 + 52 - 343 / 2 },
		);
	});

	it("defers when the row or the tab loses its width mid-glide", () => {
		assert.deepEqual(
			glideFrame(toCertificates, view({ scrollLeft: 80, boxWidth: 0 }), quiet),
			{ type: "defer" },
		);
		assert.deepEqual(
			glideFrame(toCertificates, view({ scrollLeft: 80, width: 0 }), quiet),
			{ type: "defer" },
		);
	});
});

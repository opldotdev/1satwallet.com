import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The landing logo's 3D boundary: when the WebGL tree throws (as it does in a
// browser without WebGL), the page keeps its fallback logo and the failure is
// recorded, not lost.

function NoWebGL(): never {
	throw new Error("Error creating WebGL context.");
}

describe("ThreeBoundary", () => {
	let React: typeof import("react");
	let act: typeof import("react").act;
	let createRoot: typeof import("react-dom/client").createRoot;
	let ThreeBoundary: typeof import("../components/landing/three-boundary").ThreeBoundary;
	let diagnostics: typeof import("../lib/runtime-diagnostics");

	before(async () => {
		GlobalRegistrator.register();
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		try {
			React = await import("react");
			act = React.act;
			({ createRoot } = await import("react-dom/client"));
			({ ThreeBoundary } = await import(
				"../components/landing/three-boundary"
			));
			diagnostics = await import("../lib/runtime-diagnostics");
		} catch (error) {
			await GlobalRegistrator.unregister();
			throw error;
		}
	});

	after(async () => {
		delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		await GlobalRegistrator.unregister();
	});

	it("shows the fallback and records the failure when the 3D tree throws", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container, {
			// React reports a caught error here; the boundary records its own.
			onCaughtError: () => {},
		});
		const before = diagnostics
			.getDiagnosticEvents()
			.filter((event) => event.operation === "landing.logo.3d").length;
		const originalError = console.error;
		console.error = () => {};
		try {
			await act(async () => {
				root.render(
					React.createElement(ThreeBoundary, {
						fallback: React.createElement("img", { alt: "1Sat Wallet" }),
						children: React.createElement(NoWebGL),
					}),
				);
			});
		} finally {
			console.error = originalError;
		}
		assert.equal(
			container.querySelector("img")?.getAttribute("alt"),
			"1Sat Wallet",
		);
		const recorded = diagnostics
			.getDiagnosticEvents()
			.filter((event) => event.operation === "landing.logo.3d");
		assert.equal(recorded.length, before + 1);
		assert.equal(recorded.at(-1)?.recoverable, true);
		await act(async () => root.unmount());
		container.remove();
	});
});

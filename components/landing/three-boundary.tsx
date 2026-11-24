"use client";

import { Component, type ReactNode } from "react";
import { reportFailure } from "@/lib/runtime-diagnostics";

// Decorative 3D must never take down the page. When the WebGL tree fails
// (for example, the browser has no WebGL), log it and show the fallback.
export class ThreeBoundary extends Component<
	{ children: ReactNode; fallback?: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch(error: unknown) {
		reportFailure(
			{
				category: "route",
				code: "route.unexpected",
				operation: "landing.logo.3d",
				recoverable: true,
			},
			error,
		);
	}

	render() {
		if (this.state.failed) {
			return this.props.fallback ?? null;
		}
		return this.props.children;
	}
}

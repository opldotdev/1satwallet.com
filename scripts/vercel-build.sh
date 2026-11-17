#!/usr/bin/env bash
# Vercel's build command for every deployment (set in vercel.json).
#
# Production deploys Convex functions to the production deployment, then
# builds. Every preview, whatever its branch, shares ONE Convex preview
# deployment named "pr-preview": --preview-name reuses it when it exists, so
# pull requests never add Convex deployments (the team's quota is 40, and a
# deployment per branch filled it). Previews pushed close together overwrite
# each other's functions there; that is the price of sharing.
set -euo pipefail

if [ "${VERCEL_ENV:-}" = "production" ]; then
	exec bunx convex deploy --cmd 'bun run build' \
		--cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL
fi

exec bunx convex deploy --preview-name pr-preview --cmd 'bun run build' \
	--cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL

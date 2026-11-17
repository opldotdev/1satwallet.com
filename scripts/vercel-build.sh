#!/usr/bin/env bash
# Vercel's build command for every deployment (set in vercel.json).
#
# Production deploys Convex functions to the production deployment, then
# builds. Every preview, whatever its branch, shares ONE Convex preview
# deployment named "pr-preview": --preview-name reuses it when it exists, so
# pull requests never add Convex deployments (the team's quota is 40, and a
# deployment per branch filled it).
#
# Sharing has a price. Previews pushed close together overwrite each other's
# functions, and data one preview writes stays for the next. A branch whose
# schema rejects that data fails its preview build; deleting "pr-preview" in
# the Convex dashboard clears it, and the next preview recreates it.
# --skip-large-indexes-check stops an index change from waiting on a prompt
# CI can't answer.
set -euo pipefail

if [ "${VERCEL_ENV:-}" = "production" ]; then
	exec bunx convex deploy --cmd 'bun run build' \
		--cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL
fi

exec bunx convex deploy --preview-name pr-preview --skip-large-indexes-check \
	--cmd 'bun run build' --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL

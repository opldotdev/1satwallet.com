# Deployment contract

<!-- markdownlint-disable MD013 -->

This is the operator contract for deploying 1Sat Wallet. It defines the target
repository and Vercel topology as of 2026-08-31. It does not certify that the
domain cutover or current preview/production runtime has passed release
acceptance.

## Project and domains

| Item | Authoritative contract |
| --- | --- |
| Git remote | `git@github.com:opldotdev/1satwallet.com.git` |
| Release branch | `main`; pull requests merge to `main` and CI verifies the merge candidate and resulting push |
| Vercel owner/project | `OPL` (`opldotdev`) / a dedicated `1satwallet.com` project connected only to this repository's `main` branch |
| Apex domain | `1satwallet.com` serves the approved Production deployment from `main` |
| `www` domain | Redirects to the apex hostname or serves the same approved Production deployment |

`opldotdev/1sat-website:omega` and its `1sat-website` Vercel project are the
historical source and deployment. They are not valid destinations for new
wallet pull requests. Until the dedicated project passes acceptance and both
domains are cut over, the last known-good historical deployment is the traffic
rollback anchor. Record its immutable deployment URL and ID in the release
issue; do not rely on an old branch name or a mutable alias.

Both canonical hostnames must resolve to the same approved `main` commit, or
`www` must explicitly redirect to the apex. Domain, alias, and DNS changes are
release-owner operations, not ordinary application changes.

Vercel's linked-project metadata lives in ignored `.vercel/project.json`. Never
commit that directory. Inspecting the link is read-only:

```bash
vercel whoami
vercel project inspect 1satwallet.com
vercel inspect https://1satwallet.com
vercel inspect https://www.1satwallet.com
```

The dedicated Vercel project's Production deployment must be publicly
accessible without Vercel Authentication or a protection-bypass cookie.
Preview protection is a separate, explicit choice: document whether previews
are public, protected by Vercel Authentication, or protected by another named
policy. Never infer either policy from the historical project or the team
default. Release acceptance must include one unauthenticated request to the
Production domain and one request proving the documented Preview behavior.

## Environment ownership

`NEXT_PUBLIC_` values are compiled into browser assets and are never secrets.
Values without that prefix remain server-only.

| Variable | Visibility | Owner and target contract |
| --- | --- | --- |
| `NEXT_PUBLIC_ONESAT_STACK_URL` | Public | 1Sat Stack; `https://api.1sat.app` in production |
| `NEXT_PUBLIC_ONESAT_TEST_STACK_URL` | Public, **unverified** | Testnet routing is unresolved under OPL-3992; do not treat the example host as release-certified |
| `NEXT_PUBLIC_WALLET_STORAGE_URL` | Public | Wallet storage; `https://wallet.1sat.app` in production |
| `NEXT_PUBLIC_APP_URL` | Public | Web app; `https://1satwallet.com` for the canonical release and `http://localhost:8255` locally |
| `NEXT_PUBLIC_CONVEX_URL` | Public endpoint | CWI redirect store; separate Preview and Production deployments |
| `CWI_REDIRECT_SECRET` | **Server secret** | CWI redirect encryption; unique long random values for Preview and Production |

`messagebox.1sat.app` is part of the wider 1Sat infrastructure, but this
checkout does not currently read a message-box environment variable. Add one
only when a shipped code path consumes it.

The historical Vercel inventory showed separate Preview and
Production/`omega` Convex configuration, but one `CWI_REDIRECT_SECRET` entry
spanned several targets. Do not copy that environment wholesale. Create the
dedicated project's variables from the table above, have the owner re-enter or
rotate server secrets, and give Preview and Production distinct values. Secret
values cannot be recovered through a normal Vercel inventory and must never be
printed into logs, issues, commits, or screenshots. Removed-feature variables
(`OPENAI_API_KEY`, Sigma variables, Blob, and legacy API/market endpoints) are
not part of the new project's contract unless a shipped code path and owner are
documented.

List names, targets, and age without downloading secret values:

```bash
vercel env ls --no-color
```

Do not use `vercel env pull` in an audit or paste environment values into logs,
issues, commits, or screenshots.

## Browser and transport policy

- `proxy.ts` marks every non-production host `noindex, nofollow` and serves a
  disallow-all `robots.txt`. Only `1satwallet.com` and `www.1satwallet.com` are
  treated as production hosts.
- Every route receives `nosniff`, a strict-origin referrer policy, and a
  camera/geolocation/microphone-denying permissions policy.
- Normal pages may only be framed by the same origin. `/wallet/cwi` is the
  intentional exception: production allows HTTPS parents; local development
  additionally allows loopback HTTP parents. The CWI session layer still owns
  origin authentication and user consent.
- `/wallet/cwi`, its authorization page, and every `/api/cwi/*` response are
  `private, no-store`. Proxy owns the page cache header because the Next page
  renderer otherwise replaces values from `next.config.ts`; CWI API responses
  vary on `Origin`.
- Redirect initialization and token exchange reflect only syntactically valid
  HTTPS origins (or loopback HTTP in development), do not allow credentials,
  and require the request origin to exactly match `redirect_uri`.
- The declared production 1Sat network endpoints use HTTPS: `api.1sat.app`,
  `wallet.1sat.app`, and `messagebox.1sat.app`. This checkout currently consumes
  the first two; message-box integration is not yet a website runtime path.
  Public testnet routing is still blocked under OPL-3992, so the example
  testnet URL is not certified. The chosen Convex URL must be an HTTPS
  `*.convex.cloud` deployment. Service reachability and service-owned browser
  CORS must be certified in the target environment, not inferred from this
  local application audit.

The application CSP intentionally does not yet add a restrictive `connect-src`
or script nonce. A nonce-based Next.js CSP forces dynamic rendering, so that
change requires a measured rendering and wallet-connectivity review rather
than a deployment-only edit.

## Local release checks

Run from a clean checkout with `.env.example` copied to `.env.local` and valid
non-production service configuration:

```bash
bun install --frozen-lockfile
bun audit
bunx biome check .
bunx tsc --noEmit
bun test
bun scripts/check-routes.mjs
bun run build
```

After starting `bun run dev`, verify response contracts locally:

```bash
curl -sS -D - -o /dev/null http://localhost:8255/wallet/cwi
curl -sS -D - -o /dev/null http://localhost:8255/wallet/cwi/authorize
curl -sS -D - -o /dev/null -X OPTIONS \
  -H 'Origin: http://localhost:3333' \
  -H 'Access-Control-Request-Method: POST' \
  http://localhost:8255/api/cwi/authorize/init
```

The response must show the CSP, `Cache-Control: private, no-store`, and the
origin-scoped CORS headers described above. These local checks do not replace a
preview or production smoke test.

## Promotion checklist

1. Confirm the candidate commit is on `main` and CI is green.
2. Confirm Preview uses its own Convex deployment and CWI redirect secret.
3. Exercise create/import/unlock, external provider connection, hosted CWI
   iframe, and redirect approval/denial on the candidate preview.
4. Review browser console/network output for CSP, CORS, cache, and mixed-content
   failures on mobile and desktop.
5. Confirm Production is public and Preview behaves according to the explicit
   protection policy.
6. Point both canonical hostnames at the same approved commit (or configure the
   documented canonical redirect).
7. Smoke health, wallet entry, hosted iframe, redirect exchange, and core asset
   routes on the actual production domains.
8. If a money-safety or wallet-access regression appears, restore the previous
   known-good deployment alias first; preserve logs and request IDs for the
   incident record.

No preview or production deployment, alias mutation, DNS change, or remote
smoke test is performed by the local validation in this document.

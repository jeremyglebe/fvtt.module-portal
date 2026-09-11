# The Module Library

A shared, email-authenticated distribution portal for private Foundry VTT modules.
The static site runs on **GitHub Pages**; Supabase provides Auth, Postgres,
private Storage, and an Edge Function. No ChatGPT Sites hosting is involved.

**Site:** https://jeremyglebe.com/fvtt.module-portal/ (GitHub Pages, using the account's existing domain)

**Setup status:** GitHub Pages is connected to the deployed Supabase backend.
Owner-account bootstrap, custom email delivery, and a real Foundry install remain
before inviting friends. See [DEPLOYMENT.md](DEPLOYMENT.md) for verified status and
[SETUP.md](SETUP.md) for remaining steps. No private keys or passwords are included.

## What it does

- One account across every module, with separate administrator approval per module.
- Verified-email magic-link sign-in; registration alone grants no downloads.
- One 30-minute installation grant per account/module/release.
- Contact forms for access and replacement requests, with an administrator review queue.
- Administrator-controlled unlimited-grant accounts, still subject to module approval.
- A permanent public notification manifest per module, without download links or content.
- Private ZIP streaming after atomic ticket redemption; no reusable Storage URL is exposed.

An unused installation link **can be shared**. Its holder gets the one download.
Once downloaded, module files can be copied. This is controlled distribution,
not DRM or a substitute for permission to distribute the content.

## Development

Node 22.18+ (or current Node 24+):

```sh
npm ci
npm run dev
npm run check
```

The development URL is `http://127.0.0.1:5173/fvtt.module-portal/`.
Copy `.env.example` to `.env.local` and fill in **only public** frontend settings
when the hosted backend exists. Never put a service-role key in any `VITE_` variable.

`npm run check` executes PostgreSQL-backed permission/quota tests using PGlite,
HTTP-handler and publisher tests, TypeScript checks, and the production build.
PGlite serializes statements: the tests exercise the actual SQL but do not replace
the live two-client concurrency and full Foundry acceptance checks in [SETUP.md](SETUP.md).

## Publish a module

In a module made from `fvtt.wfrp.template`, select `authenticated-site` and set:

```env
RELEASE_CHANNEL=authenticated-site
AUTHENTICATED_SITE_URL=https://jeremyglebe.com/fvtt.module-portal/
AUTHENTICATED_SITE_MANIFEST_URL=https://hxqobdtslujsptkehmkj.supabase.co/functions/v1/portal/public/YOUR_MODULE_ID/module.json
```

Prepare the release with the template's normal release command, then run this
repository's uploader locally with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
loaded securely in your shell environment:

```sh
npm run publish:release -- /absolute/path/to/.release-artifacts/authenticated-site/YOUR_MODULE_ID/v1.2.3
```

The uploader checks identity, SHA-256, size, and public-manifest fields, uploads the
ZIP into private Storage without overwrite, then registers the release. It refuses
duplicate versions. If registration fails, the private object remains for manual
inspection; it is never silently overwritten or deleted. Publishing updates the
public notification endpoint automatically; no separate Pages rebuild is necessary.

Only minimal notification metadata is public. The full manifest remains in the
private database and the ZIP in private Storage. **Never commit release ZIPs,
private manifests, service keys, tickets, or user records to this public repo.**

## Operating limits

- 50 MiB maximum ZIP; test real transfer times on the selected Supabase plan.
- A ZIP GET consumes the link before streaming. Failed transfers require replacement;
  range requests and resume are not supported. HEAD, OPTIONS and manifest GETs do not consume it.
- A 20-grants/minute account safety limit also applies to unlimited accounts.
- Contact requests are limited to 10/day/account, one pending request per target.
- The initial dashboard is intended for a small private group (under 1,000 rows per
  queried collection); add pagination before growing beyond that.
- Supabase infrastructure logs may retain request URLs containing tickets. Restrict
  dashboard/log access, never export those logs publicly, and keep ticket lifetimes short.
- Foundry's automatic updater sees new public versions but cannot install them. It
  may report an error; users must claim a link and use **Install Module** again.
- The matching module ID replaces the prior package in the inspected Foundry
  v14.365 implementation. Test your supported version/hosting environment before rollout.

See [SECURITY.md](SECURITY.md) for trust boundaries and [SETUP.md](SETUP.md) for deployment.

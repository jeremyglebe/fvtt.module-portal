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

### Module visibility

An administrator manages the catalog under **Administration → Module settings**:

| Level   | Listed after sign-in                             | Installation                                                                        |
| ------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Public  | Everyone                                         | Copy the existing public GitHub (or other HTTPS) manifest URL; no approval or grant |
| Private | Everyone sees the title and optional description | Approval required to generate a temporary installation link                         |
| Secret  | Only approved accounts and administrators        | Approval required; hidden accounts cannot request access by guessing its ID         |

For public entries, save the module ID, title, optional description, and stable public manifest URL.
The portal copies that URL unchanged; it does not mirror or upload the package. Releases and updates
continue through the original public repository, so changing its latest manifest needs no portal edit.

For private/secret entries, **Administration → Email access** accepts an email and module, even
before the person signs up. After they verify that email, they can see and download the module.
Grant/revoke controls are available for each email. Email access is checked against the current
verified Auth email on every claim/download; changing email or revoking access invalidates existing
links. Explicit account approval/revocation takes precedence over the email allowlist. These are
access grants, not invitation emails; signup/sign-in still uses Supabase email delivery.

The template initializer offers **private** or **secret** when choosing site distribution. With
the reusable publishing credential configured, it immediately inserts and confirms the module's
chosen visibility in Supabase, before any release. It saves `AUTHENTICATED_SITE_VISIBILITY` in the
module's `.env.repo`; releases verify that setting. Registration retries preserve existing metadata
and grants, and a visibility conflict stops rather than silently changing an existing entry.
The `registerModule` export in `scripts/publish-release.mjs` uses the existing table permissions;
no additional backend migration or Pages deployment is required.

Older publishers without explicit visibility still default new entries to **private**. For those,
register a **secret** module here with its exact module ID **before its first release**, or rerun
the updated template's publishing setup. Automated releases preserve visibility, description, and
email grants. Changing something previously listed or distributed to secret cannot recall
information people already received.

Secret titles, descriptions, release history, and old requests are filtered on the backend, not
just hidden in the page. Anonymous notification manifests return 404 for secret modules, even
with a guessed ID. Secret modules therefore have no anonymous Foundry update notices: approved
users check the portal for updates. Private modules retain the public notification endpoint.

Apply `supabase/migrations/202609110002_module_visibility.sql` after the initial migration and
deploy the updated `portal` function before publishing the updated frontend. The allowlist has
RLS enabled and no browser table/RPC privileges. Owner admin setup is still required (see SETUP.md).

### Release configuration

In a module made from `fvtt.wfrp.template`, select `authenticated-site` and set:

```env
RELEASE_CHANNEL=authenticated-site
SUPABASE_URL=https://hxqobdtslujsptkehmkj.supabase.co
AUTHENTICATED_SITE_URL=https://jeremyglebe.com/fvtt.module-portal/
AUTHENTICATED_SITE_MANIFEST_URL=https://hxqobdtslujsptkehmkj.supabase.co/functions/v1/portal/public/YOUR_MODULE_ID/module.json
```

Set `SUPABASE_SERVICE_ROLE_KEY` once in the module checkout's ignored `.env.local`
or your release environment. Never use a `VITE_` prefix or commit the key. Then run
the template's normal command from the module checkout:

```sh
npm run release
```

### Getting the publishing credential

1. Sign in to Supabase and select the project matching `SUPABASE_URL`.
2. Open **Settings > API Keys** ([shared portal project](https://supabase.com/dashboard/project/hxqobdtslujsptkehmkj/settings/api-keys)).
3. In **Legacy anon, service_role API keys**, reveal and copy **service_role**.
   Do not use `anon`, a public publishable key, or a database/account password.
4. Add `SUPABASE_SERVICE_ROLE_KEY=<copied value>` to the module project's ignored `.env.local`,
   beside `package.json`, preserving any existing settings. For the standalone uploader below,
   supply it through your shell environment instead; that CLI does not load `.env.local`.
5. Run `npm run release` from the module checkout.

"Once" means **one-time configuration, not a single-use credential**. Keep using the saved key for
every release and every module on this project until it is rotated, revoked, or expires. It is not
one of the single-use installation links issued to players. The key grants administrative access:
never share it with players, commit it, or include it in the public site.

These instructions match the current legacy-key uploader. Supabase now recommends `sb_secret_…`
keys and is deprecating legacy keys; migration requires a separate tooling update, not generating
a new key for each release. If legacy keys are disabled or unavailable, do not substitute a public
key or change project-wide key settings to bypass the error.
See [Supabase's API key documentation](https://supabase.com/docs/guides/getting-started/api-keys).

### Publication and retries

It builds, packages, uploads privately, and registers the release automatically,
including creating the module's first catalog entry. No separate upload or Pages
deployment is needed. The template reads local environment files; this repository's
standalone CLI is optional for recovery and reads only the process environment:

```sh
npm run publish:release -- /absolute/path/to/.release-artifacts/authenticated-site/YOUR_MODULE_ID/v1.2.3
```

The uploader checks identity, SHA-256, size, and public-manifest fields, uploads the
ZIP into private Storage without overwrite, then registers the release. It refuses
changes to existing versions. Unchanged retries verify and reuse an uploaded object;
an identical published catalog entry is treated as success. An unpublished entry is
never reactivated by a retry. Nothing is overwritten or deleted. In the template,
rerun the release command and choose `current` to resume the unchanged release.
Publishing updates the
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

## Module and system packages

The portal distributes both Foundry add-on modules and game systems. Its existing API/database names
and `module.json`/`module.zip` transport URLs remain compatible. For systems, the ZIP must contain
`system.json` at its root, and users install the supplied manifest URL from Game Systems → Install
System. The template automates this during initialization and release. Optional `packageType` in
release metadata is `module` or `system`; omitted metadata remains compatible with older module
publishers. Catalog IDs are unique across both types. No additional Supabase migration is required.

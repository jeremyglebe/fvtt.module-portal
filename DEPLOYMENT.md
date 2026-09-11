# Shared deployment

Verified on 2026-09-11.

- Frontend: https://jeremyglebe.com/fvtt.module-portal/ — GitHub Pages, HTTPS enforced.
- Supabase project: `fvtt-module-portal`, reference `hxqobdtslujsptkehmkj`.
- Organization: `jeremyglebe's Org`, free plan, West US (Oregon).
- PostgreSQL: 17.6 at deployment.
- API: https://hxqobdtslujsptkehmkj.supabase.co/functions/v1/portal
- Public manifest: append `/public/MODULE_ID/module.json` to that API URL.
- Private bucket: `module-releases`, 50 MiB ZIP limit.

## Applied configuration

The initial migration was applied transactionally through the SQL editor. The
`portal` function was deployed with the reviewed `index.ts` and `core.ts` from
commit `7c5836aa6c629e8fb2d0da9e158f7e5ff679666a`, without changes in the dashboard.
`PORTAL_ORIGIN` is `https://jeremyglebe.com`.

The legacy gateway JWT check is off for public notification/ticket endpoints.
The handler validates Supabase Auth sessions on account/admin routes and checks
approval, expiry and consumption on private delivery. The service-role key stays
inside Supabase's function environment; it was not copied into GitHub or local files.

GitHub Actions has the public project URL and publishable key as repository
variables. The rebuilt site displays email sign-in. Email signup is on and email
autoconfirm is off. The Site URL and sole redirect allowlist entry are
`https://jeremyglebe.com/fvtt.module-portal/`.

CLI migration history needs one-time repair before future CLI migrations because
this deployment used the dashboard. See SETUP.md; do not reapply the initial SQL.

## Module visibility update

On 2026-09-11, `202609110002_module_visibility.sql` was applied transactionally through
the SQL editor after confirming no existing module/account records. It adds public/private/secret
visibility, descriptions, public manifest references, and the administrator-managed email allowlist.
The updated function filters secret module metadata and related history on the server and disables
anonymous secret notification manifests. No module entries, real email grants, or owner account
permissions were created by this update.

The updated `portal` function was deployed successfully from the tested handler source (exact text
verified before deployment). Live checks confirmed allowlist RLS, no anonymous/authenticated table
reads, no browser execution of the catalog or email-grant RPC, and unchanged zero module/email-grant
counts. The updated API returns 401 for signed-out dashboards, 404 for unknown module manifests,
and 410 for invalid installation tickets. Real signed-in Administration flows still require the
owner bootstrap below.

Both dashboard-applied migrations need their versions marked applied before future CLI migration
pushes. The automated local suite covers catalog filtering, pre-signup verified-email access,
revocation, unchanged release visibility, permissions, URL validation, and hidden-history responses.

## Verified live

- Eight portal tables with RLS enabled, including the email allowlist.
- No table privileges for `anon`/`authenticated`; no portal RPC execution privileges
  for `PUBLIC`/`anon`/`authenticated`.
- Private Storage bucket; public Storage URL access denied.
- Public-key requests to account/grant tables return permission errors.
- Signed-out dashboard: 401; nonexistent public manifest: 404; bad/unknown tickets: 410.
- Rollback-only SQL test: unapproved issuance blocked; normal quota enforced;
  repeated manifest checks allowed; second redemption blocked; replacement
  self-approval blocked; admin replacement adds allowance; revoked/expired grants
  rejected; unlimited accounts can issue multiple grants.
- Confirmed no test Auth accounts, portal accounts, releases or grants remained
  after rollback. No module content was uploaded.

## Remaining before inviting friends

- Sign in as the owner and explicitly authorize admin/unlimited status for that account.
- Configure custom SMTP for non-team email addresses. No mail provider was purchased.
- Complete a real browser login/dashboard session and approve a test module.
- Test separate-client concurrent issuance/redemption; the SQL smoke test was sequential.
- Publish the first authorized module and test a full ZIP transfer, same-ID update
  in the supported Foundry version, and interrupted-transfer replacement.
- Review email/egress/storage limits and slow-connection behavior before broader use.

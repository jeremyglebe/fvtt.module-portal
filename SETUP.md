# Desktop setup checklist

You can leave this until you are back at a computer. The GitHub Pages frontend
does not require your Supabase sign-in to deploy. **The Supabase project has not
been created by the coding agent because account authentication was unavailable.**

## 1. Create the Supabase project

- Sign in at https://supabase.com/dashboard and choose your organization.
- Create a project named `fvtt-module-portal`, preferably in a region near your group.
- Use the free plan if it meets your quota and size needs. If your organization has
  no free project slots, choose how to proceed; this implementation does not require
  or authorize a paid upgrade.
- Generate and save the database password in your password manager, not the repo.
- Note the project reference and project URL from its settings.

## 2. Deploy the database and function

From this repository, install/use the official Supabase CLI and authenticate:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
npx supabase secrets set PORTAL_ORIGIN=https://jeremyglebe.github.io
npx supabase functions deploy portal --project-ref YOUR_PROJECT_REF
```

`PORTAL_ORIGIN` is an origin, **not** a path: omit `/fvtt.module-portal/`.
The CLI reads `verify_jwt = false` from `supabase/config.toml`. That is deliberate:
public notification and ticket endpoints do not have user JWTs. The function
independently validates `/dashboard`, `/claim`, `/request`, and `/admin/*` tokens
against Supabase Auth before accessing any data. Do not remove that validation.
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to deployed Edge Functions
by Supabase; do not add them to browser configuration.

The migration creates a **private** `module-releases` bucket, the application tables,
and service-only RPCs. Do not make that bucket public or add browser-access Storage policies.

## 3. Configure sign-in and real email delivery

In Supabase Authentication:

- Enable email sign-in and new sign-ups. **Keep email confirmation enabled.**
- Set Site URL to `https://jeremyglebe.github.io/fvtt.module-portal/`.
- Add that exact URL to the permitted redirect URLs. For local testing, add
  `http://127.0.0.1:5173/fvtt.module-portal/` only while needed.
- Configure custom SMTP with your chosen mail provider and a verified sending
  address/domain. Supabase's default sender only reaches organization team members
  and is not suitable for friends signing up. The provider choice and credentials
  are left to you; no subscription was purchased.
- Test the magic-link email with a non-team email address. Open the email in the
  same browser that requested it (the site uses PKCE).
- Consider enabling Supabase Auth CAPTCHA before wider exposure. If enabled, add
  its widget/token integration to the frontend too; it is not implemented here.

## 4. Connect the existing GitHub Pages site

In repository **Settings → Secrets and variables → Actions → Variables**, add:

| Repository variable             | Value                                            |
| ------------------------------- | ------------------------------------------------ |
| `VITE_SUPABASE_URL`             | `https://YOUR_PROJECT_REF.supabase.co`           |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Project publishable key (or legacy **anon** key) |

These values intentionally become public in the browser bundle. **Never use a
secret key or legacy service-role key here.** Database RLS and the Edge Function's
server-side authorization enforce access; hiding the public key is not security.

GitHub Pages publishing source must be **GitHub Actions**. Run the “Deploy portal
to GitHub Pages” workflow again after changing repository variables. The notice
disappears only when the frontend is configured, not as proof that backend testing passed.

## 5. Bootstrap your owner account

Visit the site and sign in with your own email. The first dashboard request registers
your account record even if no modules have been published. Registration does not
make anybody an administrator automatically.

In the Supabase SQL editor, first identify your verified account:

```sql
select a.user_id, a.email, u.email_confirmed_at
from public.portal_accounts a
join auth.users u on u.id = a.user_id;
```

Copy **your own** UUID, then run:

```sql
update public.portal_accounts
set is_admin = true, unlimited_grants = true
where user_id = 'YOUR_VERIFIED_USER_UUID';
```

Refresh the site. The Access Desk will appear. After publishing a module, approve
your own account for that module too. Unlimited issuance does not bypass approvals.
Other users register and request access; approve their requests in the Access Desk.
Use its account controls to revoke access or grant unlimited issuance to testers.

## 6. Publish and test one release before inviting friends

Follow [the publication instructions](README.md#publish-a-module). Use a small
test module first. Never place private artifacts in this repository or Pages' `dist`.

Acceptance checklist (not yet run against a live project):

- An unconfirmed, unapproved, signed-out, or banned user cannot generate a link.
- An ordinary user cannot read/write portal tables, approve themselves, change
  unlimited flags, or download directly from Storage with the public key.
- Two simultaneous claims from separate clients yield only one grant for a normal account.
- Repeated manifest GETs, HEAD and OPTIONS requests leave the grant unused.
- Two simultaneous ZIP GETs from separate clients yield only one transfer.
- Expired and consumed tickets fail. Revoking approval blocks unused tickets.
- A failed ZIP transfer consumes the link; an approved replacement provides one more.
- Unlimited accounts can claim multiple links but still require per-module approval.
- Publish a second module and confirm approvals/quotas remain independent.
- Install v1, then install v2 of the same module ID in **your actual Foundry version**.
  Confirm one installation remains and content updates correctly.
- Confirm Foundry follows the ticket download while the installed ZIP retains the
  permanent public notification manifest. Confirm the expected Update All error.
- Test your largest anticipated ZIP over a slow connection. The free plan's Edge
  Function worker has a limited lifetime; raise the size limit only after testing.

## Maintaining it

- Revoke a user's module access in the Access Desk. To ban the whole account, use Supabase Auth.
- For an urgent release takedown, set its `portal_releases.published` to `false`
  in the Supabase dashboard; this also invalidates outstanding tickets for it.
- Keep grants and approved replacement records: **deleting grant history resets quota**.
  Plan retention/archival deliberately before growing beyond a small private group.
- Back up the database and private Storage. Do not publish either backup.
- Review email/egress/function usage and authentication abuse before expanding access.
- Service-role credentials are only for trusted local publishing and backend execution.
  Rotate them if exposed. Never put credentials into issues, screenshots, or chat.

Official references:
[GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages),
[Supabase CLI](https://supabase.com/docs/reference/cli/introduction),
[SMTP setup](https://supabase.com/docs/guides/auth/auth-smtp),
[Edge Function limits](https://supabase.com/docs/guides/functions/limits),
[private Storage downloads](https://supabase.com/docs/guides/storage/serving/downloads).

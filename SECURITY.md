# Security model and known limits

The public GitHub Pages frontend is untrusted. Its URL, source, and Supabase public
key can be copied without granting module access. There are no application table
privileges or Storage policies for `anon`/`authenticated`; RLS is enabled on all
application tables. Only the backend service role executes database RPCs.

The Edge Function validates bearer tokens using Supabase Auth's `/user` endpoint,
requires a confirmed email, and derives the account ID from that result. Caller
IDs, email metadata, claimed roles, and browser flags are not trusted. New account
upserts only update email, preserving server-controlled admin/allowance fields.

Issuance locks the account row before counting all prior grants and approved
replacement requests. Redemption locks the grant row and checks current approval,
verified/unbanned account state, publication, expiry and consumption. It marks the
grant consumed in the same transaction. Module approval/release locks serialize
checks against concurrent revocation/unpublication. A revocation does not cancel a
transfer that was already authorized and started.

Tickets have 256 random bits, are stored only as SHA-256 hashes, expire in 30 minutes,
and are only displayed in memory. Ticket responses disable caching and referrers.
The handler does not log URLs or secrets. Supabase's gateway/infrastructure may
still log ticket URLs, so access to logs must be limited to trusted administrators.
Users can deliberately share unused tickets; someone who receives the ZIP can copy it.

ZIP GET consumes first, then streams from private Storage using the service role.
There is no public redirect or signed Storage URL. Failed transfers consume the
grant. HEAD/OPTIONS and repeated manifest reads do not consume it. Range requests
are rejected before consumption. The 50 MiB limit is a conservative starting limit,
not proof every connection will complete within the Edge Function worker lifetime.

The frontend uses DOM text nodes for user/module data, not HTML interpolation.
It uses a restrictive CSP (GitHub Pages cannot configure arbitrary HTTP headers),
no external fonts, no analytics, and no third-party scripts outside the bundled SDK.
Supabase persists the login session in browser storage; sign out on shared devices.
Private ticket URLs are never stored there by this app.

Application rate limits cap issuance and contact requests. Anonymous requests can
still consume Supabase function resources, and email abuse protection depends on
Supabase/Auth/mail-provider configuration. This is not a full WAF, billing-abuse
defense, or complete production security audit. Add CAPTCHA/rate protection as
appropriate before inviting a large or untrusted audience.

Local tests exercise SQL with PGlite and HTTP handling with injected transports.
They cannot verify hosted RLS configuration, SMTP, network/proxy behavior, real
multi-connection races or Foundry installation. Complete the live checklist in
SETUP.md before treating the service as ready for users.

Report a security issue privately to the repository owner. Do not attach live
tickets, service-role keys, user records, or private module content to public issues.

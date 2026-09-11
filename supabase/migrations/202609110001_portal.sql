-- All application access goes through the Edge Function. No browser table grants.
create table public.portal_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  is_admin boolean not null default false,
  unlimited_grants boolean not null default false
);
create table public.portal_modules (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]*$'),
  title text not null check (length(title) between 1 and 200)
);
create table public.portal_releases (
  id uuid primary key default gen_random_uuid(),
  module_id text not null references public.portal_modules(id),
  version text not null check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  manifest jsonb not null,
  public_manifest jsonb not null,
  storage_path text unique not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  bytes bigint not null check (bytes > 0 and bytes <= 52428800),
  published boolean not null default true,
  created_at timestamptz not null default now(),
  unique (module_id, version)
);
create table public.portal_approvals (
  user_id uuid not null references public.portal_accounts(user_id) on delete cascade,
  module_id text not null references public.portal_modules(id),
  active boolean not null default true,
  primary key (user_id, module_id)
);
create table public.portal_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.portal_accounts(user_id) on delete cascade,
  module_id text not null references public.portal_modules(id),
  release_id uuid references public.portal_releases(id),
  kind text not null check (kind in ('access', 'replacement')),
  reason text not null check (length(reason) between 10 and 2000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check ((kind = 'access' and release_id is null) or (kind = 'replacement' and release_id is not null))
);
create unique index portal_pending_request on public.portal_requests
  (user_id, module_id, kind, coalesce(release_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'pending';
create table public.portal_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.portal_accounts(user_id) on delete cascade,
  release_id uuid not null references public.portal_releases(id),
  token_hash text unique not null check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  consumed_at timestamptz
);
create index portal_grant_quota on public.portal_grants(user_id, release_id);
create table public.portal_audit (
  id bigint generated always as identity primary key,
  actor uuid,
  action text not null,
  subject text,
  created_at timestamptz not null default now()
);

alter table public.portal_accounts enable row level security;
alter table public.portal_modules enable row level security;
alter table public.portal_releases enable row level security;
alter table public.portal_approvals enable row level security;
alter table public.portal_requests enable row level security;
alter table public.portal_grants enable row level security;
alter table public.portal_audit enable row level security;
revoke all on public.portal_accounts, public.portal_modules, public.portal_releases,
  public.portal_approvals, public.portal_requests, public.portal_grants, public.portal_audit
  from anon, authenticated;
grant all on public.portal_accounts, public.portal_modules, public.portal_releases,
  public.portal_approvals, public.portal_requests, public.portal_grants, public.portal_audit
  to service_role;
grant usage on sequence public.portal_audit_id_seq to service_role;

create function public.portal_issue(p_user uuid, p_release uuid, p_hash text)
returns public.portal_grants language plpgsql security definer set search_path = '' as $$
declare r public.portal_releases; a public.portal_accounts; g public.portal_grants; allowed bigint; used bigint;
begin
  -- Account lock serializes quota checks across all simultaneous claims.
  select * into a from public.portal_accounts where user_id = p_user for update;
  if not found then raise exception 'Account not found'; end if;
  select * into r from public.portal_releases where id = p_release and published;
  if not found then raise exception 'Release unavailable'; end if;
  perform 1 from auth.users where id = p_user and email_confirmed_at is not null
    and (banned_until is null or banned_until < now());
  if not found then raise exception 'Verified account required'; end if;
  perform 1 from public.portal_approvals where user_id = p_user and module_id = r.module_id and active for share;
  if not found then raise exception 'Approval required'; end if;
  -- Also cap owner issuance to 20/minute; unlimited refers to release allowance.
  select count(*) into used from public.portal_grants where user_id = p_user and created_at > now() - interval '1 minute';
  if used >= 20 then raise exception 'Please wait a minute before claiming again'; end if;
  select 1 + count(*) into allowed from public.portal_requests
    where user_id = p_user and release_id = p_release and kind = 'replacement' and status = 'approved';
  select count(*) into used from public.portal_grants where user_id = p_user and release_id = p_release;
  if not a.unlimited_grants and used >= allowed then raise exception 'Allowance used; request a replacement'; end if;
  insert into public.portal_grants(user_id, release_id, token_hash) values(p_user, p_release, p_hash) returning * into g;
  insert into public.portal_audit(actor, action, subject) values(p_user, 'grant-issued', g.id::text);
  return g;
end $$;

create function public.portal_ticket(p_hash text, p_consume boolean default false)
returns public.portal_releases language plpgsql security definer set search_path = '' as $$
declare g public.portal_grants; r public.portal_releases;
begin
  select * into g from public.portal_grants where token_hash = p_hash for update;
  if not found or g.expires_at <= now() or g.consumed_at is not null then raise exception 'Link expired or already used'; end if;
  select * into r from public.portal_releases where id = g.release_id and published for share;
  if not found then raise exception 'Release unavailable'; end if;
  perform 1 from auth.users where id = g.user_id and email_confirmed_at is not null
    and (banned_until is null or banned_until < now());
  if not found then raise exception 'Account unavailable'; end if;
  perform 1 from public.portal_approvals where user_id = g.user_id and module_id = r.module_id and active for share;
  if not found then raise exception 'Approval revoked'; end if;
  if p_consume then
    update public.portal_grants set consumed_at = now() where id = g.id;
    insert into public.portal_audit(actor, action, subject) values(g.user_id, 'grant-redeemed', g.id::text);
  end if;
  return r;
end $$;

create function public.portal_request(p_user uuid, p_module text, p_release uuid, p_kind text, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result uuid; recent bigint;
begin
  perform 1 from public.portal_accounts where user_id = p_user for update;
  if not found then raise exception 'Account not found'; end if;
  select count(*) into recent from public.portal_requests where user_id = p_user and created_at > now() - interval '1 day';
  if recent >= 10 then raise exception 'Daily request limit reached'; end if;
  if p_kind = 'replacement' then
    perform 1 from public.portal_releases where id = p_release and module_id = p_module and published;
    if not found then raise exception 'Release unavailable'; end if;
    perform 1 from public.portal_approvals where user_id = p_user and module_id = p_module and active;
    if not found then raise exception 'Approval required'; end if;
    perform 1 from public.portal_grants where user_id = p_user and release_id = p_release;
    if not found then raise exception 'Claim the initial link first'; end if;
  end if;
  insert into public.portal_requests(user_id, module_id, release_id, kind, reason)
    values(p_user, p_module, p_release, p_kind, p_reason) returning id into result;
  return result;
end $$;

create function public.portal_decide(p_admin uuid, p_request uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.portal_requests;
begin
  perform 1 from public.portal_accounts where user_id = p_admin and is_admin;
  if not found then raise exception 'Administrator required'; end if;
  select * into r from public.portal_requests where id = p_request and status = 'pending' for update;
  if not found then raise exception 'Request already resolved'; end if;
  if p_approve and r.kind = 'access' then
    insert into public.portal_approvals(user_id, module_id) values(r.user_id, r.module_id)
      on conflict(user_id, module_id) do update set active = true;
  end if;
  update public.portal_requests set status = case when p_approve then 'approved' else 'denied' end, decided_at = now() where id = r.id;
  insert into public.portal_audit(actor, action, subject)
    values(p_admin, case when p_approve then 'request-approved' else 'request-denied' end, r.id::text);
end $$;

create function public.portal_set_policy(p_admin uuid, p_user uuid, p_module text, p_active boolean, p_unlimited boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.portal_accounts where user_id = p_admin and is_admin;
  if not found then raise exception 'Administrator required'; end if;
  if p_module is not null then
    insert into public.portal_approvals(user_id, module_id, active) values(p_user, p_module, p_active)
      on conflict(user_id, module_id) do update set active = excluded.active;
  elsif p_unlimited is not null then
    update public.portal_accounts set unlimited_grants = p_unlimited where user_id = p_user;
  else raise exception 'Policy required';
  end if;
  insert into public.portal_audit(actor, action, subject) values(p_admin, 'policy-changed', p_user::text);
end $$;

create function public.portal_publish(p_manifest jsonb, p_public jsonb, p_path text, p_sha text, p_bytes bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result uuid; module text := p_manifest->>'id'; version text := p_manifest->>'version';
begin
  if module is null or version is null or p_public->>'id' is distinct from module or p_public->>'version' is distinct from version
    or p_path <> module || '/' || version || '/module.zip' then raise exception 'Release identity mismatch'; end if;
  if p_manifest ? 'download' or p_public ? 'download' then raise exception 'Persistent manifests must not contain download links'; end if;
  insert into public.portal_modules(id, title) values(module, p_public->>'title')
    on conflict(id) do update set title = excluded.title;
  insert into public.portal_releases(module_id, version, manifest, public_manifest, storage_path, sha256, bytes)
    values(module, version, p_manifest, p_public, p_path, p_sha, p_bytes) returning id into result;
  return result;
end $$;

-- PostgreSQL grants PUBLIC execution by default: explicitly close every RPC.
revoke all on function public.portal_issue(uuid, uuid, text), public.portal_ticket(text, boolean),
  public.portal_request(uuid, text, uuid, text, text), public.portal_decide(uuid, uuid, boolean),
  public.portal_set_policy(uuid, uuid, text, boolean, boolean), public.portal_publish(jsonb, jsonb, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.portal_issue(uuid, uuid, text), public.portal_ticket(text, boolean),
  public.portal_request(uuid, text, uuid, text, text), public.portal_decide(uuid, uuid, boolean),
  public.portal_set_policy(uuid, uuid, text, boolean, boolean), public.portal_publish(jsonb, jsonb, text, text, bigint)
  to service_role;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('module-releases', 'module-releases', false, 52428800, array['application/zip']);
-- No storage.objects policies: only the service role can access the bucket.

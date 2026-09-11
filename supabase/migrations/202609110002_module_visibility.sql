-- Visibility is enforced server-side. Existing modules remain private.
alter table public.portal_modules
  add column visibility text not null default 'private' check (visibility in ('public','private','secret')),
  add column description text not null default '' check (length(description) <= 2000),
  add column manifest_url text,
  add constraint portal_public_manifest check (
    (visibility = 'public' and manifest_url is not null and manifest_url ~ '^https://[^/@?#[:space:]]+[^#[:space:]]*$')
    or (visibility <> 'public' and manifest_url is null)
  );

-- This allowlist can be populated before the recipient has an Auth account.
create table public.portal_email_access (
  module_id text not null references public.portal_modules(id),
  email text not null check (email = lower(btrim(email)) and length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  active boolean not null default true,
  primary key (module_id, email)
);
alter table public.portal_email_access enable row level security;
revoke all on public.portal_email_access from public, anon, authenticated;
grant all on public.portal_email_access to service_role;

create function public.portal_has_access(p_user uuid, p_module text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare address text; approved boolean;
begin
  select lower(btrim(email)) into address from auth.users where id = p_user
    and email_confirmed_at is not null and (banned_until is null or banned_until < now()) for share;
  if not found then return false; end if;
  -- An explicit account policy (including a revocation) takes precedence over email access.
  select active into approved from public.portal_approvals
    where user_id = p_user and module_id = p_module for share;
  if found then return approved; end if;
  select active into approved from public.portal_email_access
    where module_id = p_module and email = address for share;
  return coalesce(approved, false);
end $$;

create function public.portal_catalog(p_user uuid)
returns table(id text, title text, description text, visibility text, manifest_url text, approved boolean)
language sql security definer set search_path = '' as $$
  select m.id, m.title, m.description, m.visibility, m.manifest_url,
    public.portal_has_access(p_user, m.id) as approved
  from public.portal_modules m
  where m.visibility <> 'secret'
    or public.portal_has_access(p_user, m.id)
    or exists (select 1 from public.portal_accounts a where a.user_id=p_user and a.is_admin)
  order by m.title;
$$;

create function public.portal_set_module(p_admin uuid, p_id text, p_title text, p_description text, p_visibility text, p_manifest_url text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.portal_accounts where user_id=p_admin and is_admin)
    then raise exception 'Administrator required'; end if;
  insert into public.portal_modules(id,title,description,visibility,manifest_url)
    values(p_id,p_title,p_description,p_visibility,p_manifest_url)
    on conflict(id) do update set title=excluded.title, description=excluded.description,
      visibility=excluded.visibility, manifest_url=excluded.manifest_url;
  insert into public.portal_audit(actor,action,subject) values(p_admin,'module-configured',p_id);
end $$;

create function public.portal_set_email_access(p_admin uuid, p_module text, p_email text, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.portal_accounts where user_id=p_admin and is_admin)
    then raise exception 'Administrator required'; end if;
  if not exists(select 1 from public.portal_modules where id=p_module and visibility <> 'public')
    then raise exception 'Module unavailable'; end if;
  insert into public.portal_email_access(module_id,email,active)
    values(p_module,lower(btrim(p_email)),p_active)
    on conflict(module_id,email) do update set active=excluded.active;
  -- Do not write email addresses into audit subjects.
  insert into public.portal_audit(actor,action,subject) values(p_admin,'email-access-changed',p_module);
end $$;

create or replace function public.portal_issue(p_user uuid, p_release uuid, p_hash text)
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
  perform 1 from public.portal_modules where id=r.module_id and visibility <> 'public' for share;
  if not found then raise exception 'Release unavailable'; end if;
  if not public.portal_has_access(p_user,r.module_id) then
    if exists(select 1 from public.portal_modules where id=r.module_id and visibility='secret')
      then raise exception 'Release unavailable'; end if;
    raise exception 'Approval required';
  end if;
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

create or replace function public.portal_ticket(p_hash text, p_consume boolean default false)
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
  if not public.portal_has_access(g.user_id,r.module_id) then raise exception 'Approval revoked'; end if;
  if p_consume then
    update public.portal_grants set consumed_at = now() where id = g.id;
    insert into public.portal_audit(actor, action, subject) values(g.user_id, 'grant-redeemed', g.id::text);
  end if;
  return r;
end $$;

create or replace function public.portal_request(p_user uuid, p_module text, p_release uuid, p_kind text, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result uuid; recent bigint;
begin
  perform 1 from public.portal_accounts where user_id = p_user for update;
  if not found then raise exception 'Account not found'; end if;
  perform 1 from public.portal_modules where id=p_module and visibility <> 'public'
    and (visibility <> 'secret' or public.portal_has_access(p_user,p_module)) for share;
  if not found then raise exception 'Module unavailable'; end if;
  select count(*) into recent from public.portal_requests where user_id = p_user and created_at > now() - interval '1 day';
  if recent >= 10 then raise exception 'Daily request limit reached'; end if;
  if p_kind = 'replacement' then
    perform 1 from public.portal_releases where id = p_release and module_id = p_module and published;
    if not found then raise exception 'Release unavailable'; end if;
    if not public.portal_has_access(p_user,p_module) then raise exception 'Approval required'; end if;
    perform 1 from public.portal_grants where user_id = p_user and release_id = p_release;
    if not found then raise exception 'Claim the initial link first'; end if;
  end if;
  insert into public.portal_requests(user_id, module_id, release_id, kind, reason)
    values(p_user, p_module, p_release, p_kind, p_reason) returning id into result;
  return result;
end $$;

revoke all on function public.portal_has_access(uuid,text), public.portal_catalog(uuid),
  public.portal_set_module(uuid,text,text,text,text,text), public.portal_set_email_access(uuid,text,text,boolean)
  from public, anon, authenticated;
grant execute on function public.portal_has_access(uuid,text), public.portal_catalog(uuid),
  public.portal_set_module(uuid,text,text,text,text,text), public.portal_set_email_access(uuid,text,text,boolean)
  to service_role;

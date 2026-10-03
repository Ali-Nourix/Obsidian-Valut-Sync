-- ── Vault Sync: Supabase schema (version 2) ─────────────────────────────────
-- Install with `npm run deploy`, or paste this whole file into the Supabase
-- dashboard → SQL Editor → Run. It is safe to run again, and it upgrades a
-- version 1 install in place.
--
-- Supabase is a relay, not a store: file contents stay in the bucket only
-- until every other device has received them, then they are deleted. What
-- stays is a small index (path, content id, size, version) that lets devices
-- notice concurrent edits. In an encrypted vault the index holds encrypted
-- names and keyed ids instead of paths.
--
--   • public.vaults      one row per synced vault; head_seq numbers its commits
--   • public.files       the index: one row per path, deletions kept as tombstones
--   • public.devices     the devices syncing a vault (dropped after 30 days unseen)
--   • public.deliveries  "device D still needs blob H for path P"
--   • public.requests    "device D needs blob H, which is no longer on the server"
--   • RPCs               the only way to write any of the above
--   • storage bucket     "vault-sync" (private): blobs in transit, under <user>/<vault>/
--   • realtime           on public.vaults, so devices wake each other up
--
-- Every row and object belongs to the signed-in user (row level security);
-- the publishable / anon key alone can read or write nothing.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.vaults (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 100),
  -- Null for a plaintext vault. Set once, when the vault is created.
  encryption  jsonb,
  head_seq    bigint not null default 0,
  head_device text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, name)
);
-- The device behind the latest commit, request or fulfilment; Realtime
-- subscribers ignore their own signals.
alter table public.vaults add column if not exists signal_device text;

create table if not exists public.files (
  vault_id   uuid    not null references public.vaults (id) on delete cascade,
  path       text    not null,
  user_id    uuid    not null references auth.users (id) on delete cascade,
  hash       text    not null,
  size       bigint  not null check (size >= 0),
  mtime      bigint  not null,
  version    integer not null check (version >= 1),
  seq        bigint  not null,
  deleted    boolean not null default false,
  device_id  text,
  updated_at timestamptz not null default now(),
  primary key (vault_id, path),
  -- Every device agrees on one spelling of a name: NFC, relative, no "." or "..".
  constraint files_path_ok check (
    char_length(path) between 1 and 1024
    and path is nfc normalized
    and path !~ '(^/|/$|//)'
    and path !~ '(^|/)\.\.?(/|$)'
  ),
  constraint files_hash_ok check (hash ~ '^[0-9a-f]{64}$')
);
-- Encrypted vaults: the real path, sealed with the vault key (path holds a keyed id).
alter table public.files add column if not exists name_enc text;

create unique index if not exists files_vault_seq_key on public.files (vault_id, seq);
create index if not exists files_user_id_idx on public.files (user_id);

create table if not exists public.devices (
  vault_id  uuid not null references public.vaults (id) on delete cascade,
  device_id text not null check (char_length(device_id) between 1 and 64),
  user_id   uuid not null references auth.users (id) on delete cascade,
  last_seen timestamptz not null default now(),
  primary key (vault_id, device_id)
);

create table if not exists public.deliveries (
  vault_id   uuid not null,
  device_id  text not null,
  path       text not null,
  hash       text not null,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (vault_id, device_id, path),
  foreign key (vault_id, device_id) references public.devices (vault_id, device_id) on delete cascade
);
create index if not exists deliveries_hash_idx on public.deliveries (vault_id, hash);

create table if not exists public.requests (
  vault_id   uuid not null,
  device_id  text not null,
  path       text not null,
  hash       text not null,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (vault_id, device_id, path),
  foreign key (vault_id, device_id) references public.devices (vault_id, device_id) on delete cascade
);
create index if not exists requests_hash_idx on public.requests (vault_id, hash);

-- ── Row level security ──────────────────────────────────────────────────────

alter table public.vaults     enable row level security;
alter table public.files      enable row level security;
alter table public.devices    enable row level security;
alter table public.deliveries enable row level security;
alter table public.requests   enable row level security;

drop policy if exists vaults_select_own on public.vaults;
create policy vaults_select_own on public.vaults for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists vaults_insert_own on public.vaults;
create policy vaults_insert_own on public.vaults for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists vaults_delete_own on public.vaults;
create policy vaults_delete_own on public.vaults for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists files_select_own on public.files;
create policy files_select_own on public.files for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists devices_select_own on public.devices;
create policy devices_select_own on public.devices for select to authenticated
  using (user_id = (select auth.uid()));

-- Supabase grants everything on new tables by default; narrow it down.
revoke all on table public.vaults, public.files, public.devices, public.deliveries, public.requests from anon, authenticated;
grant select, delete on table public.vaults to authenticated;
grant insert (name, encryption) on table public.vaults to authenticated;
grant select on table public.files, public.devices to authenticated;

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- Checks that the caller owns the vault and locks its row, so everything that
-- changes a vault's index, devices or deliveries happens one call at a time.
create or replace function public.vault_sync_lock(p_vault uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_head bigint;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select v.head_seq into v_head
    from public.vaults v
   where v.id = p_vault and v.user_id = auth.uid()
     for update;
  if not found then
    raise exception 'vault not found' using errcode = 'P0002';
  end if;
  return v_head;
end;
$$;
revoke all on function public.vault_sync_lock(uuid) from public, anon, authenticated;

-- ── Commits ─────────────────────────────────────────────────────────────────

-- Applies a batch of file changes. Each change carries the version it was
-- based on (0: "I believe this path has no row"); a change whose path has
-- moved on since is refused and the current row is returned instead, so the
-- device can merge and try again. With the vault row locked, seq order is
-- commit order: a device pulling "seq > cursor" can never miss a late row.
-- An applied change also tells every other device of the vault that it now
-- needs the new blob for that path (and no longer the old one).
create or replace function public.commit_files(p_vault uuid, p_device text, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_device   text := left(p_device, 64);
  v_head     bigint;
  v_seq      bigint;
  v_item     jsonb;
  v_i        integer := 0;
  v_expected integer;
  v_current  integer;
  v_path     text;
  v_deleted  boolean;
  v_row      public.files%rowtype;
  v_out      jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'p_changes must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_changes) > 200 then
    raise exception 'at most 200 changes per call' using errcode = '22023';
  end if;
  v_head := public.vault_sync_lock(p_vault);
  v_seq := v_head;

  for v_item in select e.value from jsonb_array_elements(p_changes) as e loop
    v_expected := coalesce((v_item->>'expected_version')::integer, 0);
    v_path := v_item->>'path';
    v_deleted := coalesce((v_item->>'deleted')::boolean, false);

    select f.* into v_row
      from public.files f
     where f.vault_id = p_vault and f.path = v_path
       for update;
    v_current := case when found then v_row.version else 0 end;

    if v_current = v_expected then
      v_seq := v_seq + 1;
      insert into public.files as f
        (vault_id, path, user_id, hash, size, mtime, version, seq, deleted, device_id, name_enc, updated_at)
      values
        (p_vault, v_path, v_uid, v_item->>'hash', (v_item->>'size')::bigint,
         (v_item->>'mtime')::bigint, 1, v_seq, v_deleted, v_device, v_item->>'name_enc', now())
      on conflict (vault_id, path) do update set
        hash       = excluded.hash,
        size       = excluded.size,
        mtime      = excluded.mtime,
        version    = f.version + 1,
        seq        = excluded.seq,
        deleted    = excluded.deleted,
        device_id  = excluded.device_id,
        name_enc   = excluded.name_enc,
        updated_at = excluded.updated_at
      returning f.* into v_row;

      delete from public.deliveries d where d.vault_id = p_vault and d.path = v_path;
      if v_deleted then
        delete from public.requests r where r.vault_id = p_vault and r.path = v_path;
      else
        insert into public.deliveries (vault_id, device_id, path, hash, user_id)
        select p_vault, dv.device_id, v_path, v_item->>'hash', v_uid
          from public.devices dv
         where dv.vault_id = p_vault and dv.device_id <> v_device;
      end if;

      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'i', v_i, 'ok', true, 'row', to_jsonb(v_row) - 'user_id' - 'vault_id' - 'updated_at'));
    else
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'i', v_i, 'ok', false,
        'row', case when v_current = 0 then null else to_jsonb(v_row) - 'user_id' - 'vault_id' - 'updated_at' end));
    end if;
    v_i := v_i + 1;
  end loop;

  if v_seq > v_head then
    update public.vaults
       set head_seq = v_seq, head_device = v_device, signal_device = v_device, updated_at = now()
     where id = p_vault;
  end if;
  return v_out;
end;
$$;

-- ── Devices and deliveries ──────────────────────────────────────────────────

-- Called at the start of every sync. Records the device as active, forgets
-- devices unseen for 30 days (and what they were owed), and returns how many
-- other devices there are plus the blobs still owed to this one.
create or replace function public.register_device(p_vault uuid, p_device text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device text := left(p_device, 64);
  v_peers  integer;
  v_owed   jsonb;
begin
  perform public.vault_sync_lock(p_vault);
  insert into public.devices (vault_id, device_id, user_id, last_seen)
  values (p_vault, v_device, auth.uid(), now())
  on conflict (vault_id, device_id) do update set last_seen = now();
  delete from public.devices dv
   where dv.vault_id = p_vault and dv.last_seen < now() - interval '30 days';
  select count(*) into v_peers
    from public.devices dv
   where dv.vault_id = p_vault and dv.device_id <> v_device;
  select coalesce(jsonb_agg(jsonb_build_object('path', d.path, 'hash', d.hash, 'name_enc', f.name_enc)), '[]'::jsonb)
    into v_owed
    from public.deliveries d
    left join public.files f on f.vault_id = d.vault_id and f.path = d.path
   where d.vault_id = p_vault and d.device_id = v_device;
  return jsonb_build_object('peers', v_peers, 'deliveries', v_owed);
end;
$$;

-- The device has these blobs now (or no longer needs them).
create or replace function public.ack_received(p_vault uuid, p_device text, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device text := left(p_device, 64);
  v_count  integer;
begin
  perform public.vault_sync_lock(p_vault);
  delete from public.deliveries d
   using jsonb_to_recordset(p_items) as i(path text, hash text)
   where d.vault_id = p_vault and d.device_id = v_device and d.path = i.path and d.hash = i.hash;
  get diagnostics v_count = row_count;
  delete from public.requests r
   using jsonb_to_recordset(p_items) as i(path text, hash text)
   where r.vault_id = p_vault and r.device_id = v_device and r.path = i.path;
  return v_count;
end;
$$;

-- Asks the other devices to upload blobs this device needs.
create or replace function public.request_blobs(p_vault uuid, p_device text, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device text := left(p_device, 64);
  v_count  integer;
begin
  perform public.vault_sync_lock(p_vault);
  insert into public.requests (vault_id, device_id, path, hash, user_id)
  select p_vault, v_device, i.path, i.hash, auth.uid()
    from jsonb_to_recordset(p_items) as i(path text, hash text)
   where i.hash ~ '^[0-9a-f]{64}$'
  on conflict (vault_id, device_id, path) do update set hash = excluded.hash, created_at = now();
  get diagnostics v_count = row_count;
  if v_count > 0 then
    update public.vaults set signal_device = v_device, updated_at = now() where id = p_vault;
  end if;
  return v_count;
end;
$$;

-- Blobs other devices are asking for.
create or replace function public.open_requests(p_vault uuid, p_device text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out jsonb;
begin
  perform public.vault_sync_lock(p_vault);
  select coalesce(jsonb_agg(distinct r.hash), '[]'::jsonb) into v_out
    from public.requests r
   where r.vault_id = p_vault and r.device_id <> left(p_device, 64);
  return v_out;
end;
$$;

-- This device has just uploaded these blobs: requests for them become deliveries.
create or replace function public.fulfil_requests(p_vault uuid, p_device text, p_hashes jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device text := left(p_device, 64);
  v_count  integer;
begin
  perform public.vault_sync_lock(p_vault);
  with moved as (
    delete from public.requests r
     where r.vault_id = p_vault and r.device_id <> v_device
       and r.hash in (select jsonb_array_elements_text(p_hashes))
    returning r.vault_id, r.device_id, r.path, r.hash, r.user_id
  )
  insert into public.deliveries (vault_id, device_id, path, hash, user_id)
  select m.vault_id, m.device_id, m.path, m.hash, m.user_id from moved m
  on conflict (vault_id, device_id, path) do update set hash = excluded.hash, created_at = now();
  get diagnostics v_count = row_count;
  if v_count > 0 then
    update public.vaults set signal_device = v_device, updated_at = now() where id = p_vault;
  end if;
  return v_count;
end;
$$;

-- Blobs no device needs any more, older than the grace period (at least a
-- minute, so a blob uploaded just before its commit is never caught). The
-- caller deletes them through the Storage API.
create or replace function public.garbage_blobs(p_vault uuid, p_grace_seconds integer default 600)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out jsonb;
begin
  perform public.vault_sync_lock(p_vault);
  select coalesce(jsonb_agg(g.name), '[]'::jsonb) into v_out
    from (
      select o.name
        from storage.objects o
       where o.bucket_id = 'vault-sync'
         and o.name like auth.uid()::text || '/' || p_vault::text || '/%'
         and o.created_at < now() - make_interval(secs => greatest(p_grace_seconds, 60))
         and not exists (
           select 1 from public.deliveries d
            where d.vault_id = p_vault and d.hash = split_part(o.name, '/', 4)
         )
       limit 1000
    ) g;
  return v_out;
end;
$$;

revoke all on function public.commit_files(uuid, text, jsonb) from public, anon;
revoke all on function public.register_device(uuid, text) from public, anon;
revoke all on function public.ack_received(uuid, text, jsonb) from public, anon;
revoke all on function public.request_blobs(uuid, text, jsonb) from public, anon;
revoke all on function public.open_requests(uuid, text) from public, anon;
revoke all on function public.fulfil_requests(uuid, text, jsonb) from public, anon;
revoke all on function public.garbage_blobs(uuid, integer) from public, anon;
grant execute on function public.commit_files(uuid, text, jsonb) to authenticated;
grant execute on function public.register_device(uuid, text) to authenticated;
grant execute on function public.ack_received(uuid, text, jsonb) to authenticated;
grant execute on function public.request_blobs(uuid, text, jsonb) to authenticated;
grant execute on function public.open_requests(uuid, text) to authenticated;
grant execute on function public.fulfil_requests(uuid, text, jsonb) to authenticated;
grant execute on function public.garbage_blobs(uuid, integer) to authenticated;

-- Lets the plugin tell "schema not installed / outdated" from other errors.
create or replace function public.vault_sync_schema_version()
returns integer
language sql
stable
set search_path = ''
as $$ select 2 $$;

revoke all on function public.vault_sync_schema_version() from public;
grant execute on function public.vault_sync_schema_version() to anon, authenticated;

-- ── Storage ─────────────────────────────────────────────────────────────────
-- Blobs in transit. Object names: <user id>/<vault id>/<id[0:2]>/<id>.

insert into storage.buckets (id, name, public)
values ('vault-sync', 'vault-sync', false)
on conflict (id) do update set public = false;

drop policy if exists "vault-sync read own" on storage.objects;
create policy "vault-sync read own" on storage.objects for select to authenticated
  using (bucket_id = 'vault-sync' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists "vault-sync insert own" on storage.objects;
create policy "vault-sync insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'vault-sync' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists "vault-sync update own" on storage.objects;
create policy "vault-sync update own" on storage.objects for update to authenticated
  using (bucket_id = 'vault-sync' and (storage.foldername(name))[1] = (select auth.uid()::text))
  with check (bucket_id = 'vault-sync' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists "vault-sync delete own" on storage.objects;
create policy "vault-sync delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'vault-sync' and (storage.foldername(name))[1] = (select auth.uid()::text));

-- ── Realtime ────────────────────────────────────────────────────────────────
-- Any change to a vault row (commit, request, fulfilment) wakes the other devices.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'vaults'
  ) then
    alter publication supabase_realtime add table public.vaults;
  end if;
end
$$;

commit;

-- ── Vault Sync: Supabase schema (version 1) ─────────────────────────────────
-- Paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- It is safe to run again (for example after an update of the plugin).
--
-- What it creates:
--   • public.vaults   one row per synced vault (name, optional encryption header,
--                     and head_seq: the number of the vault's latest commit)
--   • public.files    one row per file path: content id, size, version, seq,
--                     and a "deleted" flag (deletions are kept as tombstones)
--   • commit_files()  the only way to write files: an atomic compare-and-set
--                     per path, so two devices can never silently overwrite
--                     each other's edits
--   • storage bucket  "vault-sync" (private), holding file contents named by
--                     their content id under <user id>/<vault id>/
--   • realtime        on public.vaults, so devices hear about each other's commits
--
-- Every row belongs to the signed-in user (row level security); the
-- publishable / anon key alone can read or write nothing.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

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

create unique index if not exists files_vault_seq_key on public.files (vault_id, seq);
create index if not exists files_user_id_idx on public.files (user_id);

alter table public.vaults enable row level security;
alter table public.files  enable row level security;

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

-- Supabase grants everything on new tables by default; narrow it down.
revoke all on table public.vaults, public.files from anon, authenticated;
grant select, delete on table public.vaults to authenticated;
grant insert (name, encryption) on table public.vaults to authenticated;
grant select on table public.files to authenticated;

-- Applies a batch of file changes. Each change carries the version it was
-- based on (0: "I believe this path has no row"); a change whose path has
-- moved on since is refused and the current row is returned instead, so the
-- device can merge and try again. The vault row is locked for the duration,
-- which makes seq order equal commit order: a device pulling "seq > cursor"
-- can never miss a row that committed late.
create or replace function public.commit_files(p_vault uuid, p_device text, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_head     bigint;
  v_seq      bigint;
  v_item     jsonb;
  v_i        integer := 0;
  v_expected integer;
  v_current  integer;
  v_row      public.files%rowtype;
  v_out      jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'p_changes must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_changes) > 200 then
    raise exception 'at most 200 changes per call' using errcode = '22023';
  end if;

  select v.head_seq into v_head
    from public.vaults v
   where v.id = p_vault and v.user_id = v_uid
     for update;
  if not found then
    raise exception 'vault not found' using errcode = 'P0002';
  end if;
  v_seq := v_head;

  for v_item in select e.value from jsonb_array_elements(p_changes) as e loop
    v_expected := coalesce((v_item->>'expected_version')::integer, 0);

    select f.* into v_row
      from public.files f
     where f.vault_id = p_vault and f.path = v_item->>'path'
       for update;
    v_current := case when found then v_row.version else 0 end;

    if v_current = v_expected then
      v_seq := v_seq + 1;
      insert into public.files as f
        (vault_id, path, user_id, hash, size, mtime, version, seq, deleted, device_id, updated_at)
      values
        (p_vault, v_item->>'path', v_uid, v_item->>'hash', (v_item->>'size')::bigint,
         (v_item->>'mtime')::bigint, 1, v_seq, coalesce((v_item->>'deleted')::boolean, false),
         left(p_device, 64), now())
      on conflict (vault_id, path) do update set
        hash       = excluded.hash,
        size       = excluded.size,
        mtime      = excluded.mtime,
        version    = f.version + 1,
        seq        = excluded.seq,
        deleted    = excluded.deleted,
        device_id  = excluded.device_id,
        updated_at = excluded.updated_at
      returning f.* into v_row;
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
       set head_seq = v_seq, head_device = left(p_device, 64), updated_at = now()
     where id = p_vault;
  end if;
  return v_out;
end;
$$;

revoke all on function public.commit_files(uuid, text, jsonb) from public, anon;
grant execute on function public.commit_files(uuid, text, jsonb) to authenticated;

-- Lets the plugin tell "schema not installed / outdated" from other errors.
create or replace function public.vault_sync_schema_version()
returns integer
language sql
stable
set search_path = ''
as $$ select 1 $$;

revoke all on function public.vault_sync_schema_version() from public;
grant execute on function public.vault_sync_schema_version() to anon, authenticated;

-- File contents. Object names: <user id>/<vault id>/<id[0:2]>/<id>.
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

-- Realtime: a change to vaults.head_seq wakes the other devices up.
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

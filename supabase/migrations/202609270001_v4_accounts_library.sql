-- SpokenFrame V4 / Batch 2
-- Account-owned library metadata, playback state, and screenplay preferences.
-- Raw screenplay files, normalized screenplay JSON, audio objects, payments,
-- and Premium entitlements are intentionally handled in later migrations.

create extension if not exists pgcrypto;

create table public.screenplays (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  client_fingerprint text not null check (char_length(client_fingerprint) between 16 and 128),
  title text not null check (char_length(title) between 1 and 300),
  source_format text not null check (source_format in ('fdx', 'pdf', 'fountain')),
  page_count integer check (page_count is null or page_count > 0),
  page_count_method text check (page_count_method is null or page_count_method in ('pdf-exact', 'screenplay-estimate-v1')),
  spoken_character_count integer not null default 0 check (spoken_character_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((page_count is null and page_count_method is null) or (page_count is not null and page_count_method is not null)),
  unique (owner_user_id, client_fingerprint),
  unique (id, owner_user_id)
);

create table public.playback_states (
  screenplay_id uuid not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  current_unit integer not null default 0 check (current_unit >= 0),
  current_chunk integer not null default 0 check (current_chunk >= 0),
  chunk_position_seconds double precision not null default 0 check (chunk_position_seconds >= 0),
  progress_percent integer not null default 0 check (progress_percent between 0 and 100),
  playback_speed numeric(4,2) not null default 1 check (playback_speed between 0.5 and 2),
  current_scene text,
  updated_at timestamptz not null default now(),
  primary key (screenplay_id, owner_user_id),
  foreign key (screenplay_id, owner_user_id)
    references public.screenplays(id, owner_user_id) on delete cascade
);

create table public.screenplay_settings (
  screenplay_id uuid not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  audio_quality text not null default 'standard' check (audio_quality in ('standard', 'premium')),
  read_character_names boolean not null default false,
  cast_assignments jsonb not null default '{}'::jsonb check (jsonb_typeof(cast_assignments) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (screenplay_id, owner_user_id),
  foreign key (screenplay_id, owner_user_id)
    references public.screenplays(id, owner_user_id) on delete cascade
);

create index screenplays_owner_updated_idx
  on public.screenplays(owner_user_id, updated_at desc);

create or replace function public.set_spokenframe_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger screenplays_set_updated_at
before update on public.screenplays
for each row execute function public.set_spokenframe_updated_at();

create trigger playback_states_set_updated_at
before update on public.playback_states
for each row execute function public.set_spokenframe_updated_at();

create trigger screenplay_settings_set_updated_at
before update on public.screenplay_settings
for each row execute function public.set_spokenframe_updated_at();

alter table public.screenplays enable row level security;
alter table public.playback_states enable row level security;
alter table public.screenplay_settings enable row level security;

create policy "owners can read their screenplays"
on public.screenplays for select
to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "owners can create their screenplays"
on public.screenplays for insert
to authenticated
with check ((select auth.uid()) = owner_user_id);

create policy "owners can update their screenplays"
on public.screenplays for update
to authenticated
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id);

create policy "owners can delete their screenplays"
on public.screenplays for delete
to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "owners can read their playback state"
on public.playback_states for select
to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "owners can create their playback state"
on public.playback_states for insert
to authenticated
with check ((select auth.uid()) = owner_user_id);

create policy "owners can update their playback state"
on public.playback_states for update
to authenticated
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id);

create policy "owners can delete their playback state"
on public.playback_states for delete
to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "owners can read their screenplay settings"
on public.screenplay_settings for select
to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "owners can create their screenplay settings"
on public.screenplay_settings for insert
to authenticated
with check ((select auth.uid()) = owner_user_id);

create policy "owners can update their screenplay settings"
on public.screenplay_settings for update
to authenticated
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id);

create policy "owners can delete their screenplay settings"
on public.screenplay_settings for delete
to authenticated
using ((select auth.uid()) = owner_user_id);

revoke all on public.screenplays from anon;
revoke all on public.playback_states from anon;
revoke all on public.screenplay_settings from anon;

grant select, insert, update, delete on public.screenplays to authenticated;
grant select, insert, update, delete on public.playback_states to authenticated;
grant select, insert, update, delete on public.screenplay_settings to authenticated;

-- audio_quality is a listening preference, not proof of purchase. A later
-- server-owned entitlement table will be authoritative for Premium access.

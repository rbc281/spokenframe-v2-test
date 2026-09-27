-- SpokenFrame V4 / Batch 4 preparation
-- Server-owned payments, per-screenplay Premium entitlements, and generation
-- accounting. Applying this migration does not enable checkout by itself.

create table public.premium_payments (
  id uuid primary key default gen_random_uuid(),
  screenplay_id uuid not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  stripe_checkout_session_id text not null unique check (char_length(stripe_checkout_session_id) between 8 and 255),
  stripe_payment_intent_id text unique check (stripe_payment_intent_id is null or char_length(stripe_payment_intent_id) between 8 and 255),
  amount_paid_cents integer not null check (amount_paid_cents > 0),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  status text not null check (status in ('paid', 'refunded', 'disputed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (screenplay_id, owner_user_id)
    references public.screenplays(id, owner_user_id) on delete cascade
);

create table public.premium_entitlements (
  screenplay_id uuid not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  payment_id uuid not null unique references public.premium_payments(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'refunded', 'revoked')),
  page_count_at_purchase integer not null check (page_count_at_purchase > 0),
  amount_paid_cents integer not null check (amount_paid_cents > 0),
  initial_spoken_character_count integer not null check (initial_spoken_character_count > 0),
  generation_allowance integer not null check (generation_allowance >= initial_spoken_character_count),
  generated_character_count integer not null default 0 check (generated_character_count >= 0),
  reserved_character_count integer not null default 0 check (reserved_character_count >= 0),
  generation_count integer not null default 0 check (generation_count >= 0),
  regeneration_count integer not null default 0 check (regeneration_count >= 0),
  estimated_provider_cost_micros bigint not null default 0 check (estimated_provider_cost_micros >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (screenplay_id, owner_user_id),
  foreign key (screenplay_id, owner_user_id)
    references public.screenplays(id, owner_user_id) on delete cascade
);

create table public.premium_generation_events (
  id uuid primary key default gen_random_uuid(),
  screenplay_id uuid not null,
  owner_user_id uuid not null,
  cache_key text not null check (cache_key ~ '^[a-f0-9]{64}$'),
  voice_id text not null check (char_length(voice_id) between 8 and 80),
  model_id text not null check (char_length(model_id) between 3 and 100),
  character_count integer not null check (character_count > 0),
  is_regeneration boolean not null default false,
  estimated_provider_cost_micros bigint not null default 0 check (estimated_provider_cost_micros >= 0),
  status text not null default 'reserved' check (status in ('reserved', 'generated', 'failed')),
  error_code text check (error_code is null or char_length(error_code) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (screenplay_id, cache_key),
  foreign key (screenplay_id, owner_user_id)
    references public.premium_entitlements(screenplay_id, owner_user_id) on delete cascade
);

create table public.stripe_webhook_events (
  event_id text primary key check (char_length(event_id) between 8 and 255),
  event_type text not null check (char_length(event_type) between 3 and 120),
  processed_at timestamptz not null default now()
);

create index premium_payments_owner_idx
  on public.premium_payments(owner_user_id, created_at desc);

create index premium_generation_events_screenplay_idx
  on public.premium_generation_events(screenplay_id, created_at desc);

create trigger premium_payments_set_updated_at
before update on public.premium_payments
for each row execute function public.set_spokenframe_updated_at();

create trigger premium_entitlements_set_updated_at
before update on public.premium_entitlements
for each row execute function public.set_spokenframe_updated_at();

create trigger premium_generation_events_set_updated_at
before update on public.premium_generation_events
for each row execute function public.set_spokenframe_updated_at();

alter table public.premium_payments enable row level security;
alter table public.premium_entitlements enable row level security;
alter table public.premium_generation_events enable row level security;
alter table public.stripe_webhook_events enable row level security;

create policy "owners can read their Premium payments"
on public.premium_payments for select
to authenticated
using ((select auth.uid()) = owner_user_id);

create policy "owners can read their Premium entitlements"
on public.premium_entitlements for select
to authenticated
using ((select auth.uid()) = owner_user_id);

revoke all on public.premium_payments from anon, authenticated;
revoke all on public.premium_entitlements from anon, authenticated;
revoke all on public.premium_generation_events from anon, authenticated;
revoke all on public.stripe_webhook_events from anon, authenticated;

grant select on public.premium_payments to authenticated;
grant select on public.premium_entitlements to authenticated;
grant all on public.premium_payments to service_role;
grant all on public.premium_entitlements to service_role;
grant all on public.premium_generation_events to service_role;
grant all on public.stripe_webhook_events to service_role;

create or replace function public.reserve_premium_generation(
  p_screenplay_id uuid,
  p_owner_user_id uuid,
  p_cache_key text,
  p_voice_id text,
  p_model_id text,
  p_character_count integer,
  p_is_regeneration boolean default false,
  p_estimated_provider_cost_micros bigint default 0
)
returns table (decision text, event_id uuid, remaining_characters bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  entitlement public.premium_entitlements%rowtype;
  generation public.premium_generation_events%rowtype;
  available bigint;
  new_event_id uuid;
begin
  if p_character_count < 1 or p_character_count > 1200
    or p_cache_key !~ '^[a-f0-9]{64}$'
    or char_length(p_voice_id) not between 8 and 80
    or char_length(p_model_id) not between 3 and 100
    or p_estimated_provider_cost_micros < 0 then
    return query select 'invalid_request'::text, null::uuid, 0::bigint;
    return;
  end if;

  select * into entitlement
  from public.premium_entitlements
  where screenplay_id = p_screenplay_id and owner_user_id = p_owner_user_id
  for update;

  if not found or entitlement.status <> 'active' then
    return query select 'premium_required'::text, null::uuid, 0::bigint;
    return;
  end if;

  available := entitlement.generation_allowance
    - entitlement.generated_character_count
    - entitlement.reserved_character_count;

  select * into generation
  from public.premium_generation_events
  where screenplay_id = p_screenplay_id and cache_key = p_cache_key
  for update;

  if found and generation.status = 'generated' then
    return query select 'already_generated'::text, generation.id, available;
    return;
  end if;
  if found and generation.status = 'reserved' then
    return query select 'generation_in_progress'::text, generation.id, available;
    return;
  end if;
  if available < p_character_count then
    return query select 'allowance_exhausted'::text, null::uuid, available;
    return;
  end if;

  if found then
    update public.premium_generation_events
    set voice_id = p_voice_id,
        model_id = p_model_id,
        character_count = p_character_count,
        is_regeneration = p_is_regeneration,
        estimated_provider_cost_micros = p_estimated_provider_cost_micros,
        status = 'reserved',
        error_code = null,
        updated_at = now()
    where id = generation.id
    returning id into new_event_id;
  else
    insert into public.premium_generation_events (
      screenplay_id, owner_user_id, cache_key, voice_id, model_id,
      character_count, is_regeneration, estimated_provider_cost_micros
    ) values (
      p_screenplay_id, p_owner_user_id, p_cache_key, p_voice_id, p_model_id,
      p_character_count, p_is_regeneration, p_estimated_provider_cost_micros
    ) returning id into new_event_id;
  end if;

  update public.premium_entitlements
  set reserved_character_count = reserved_character_count + p_character_count,
      updated_at = now()
  where screenplay_id = p_screenplay_id and owner_user_id = p_owner_user_id;

  return query select 'reserved'::text, new_event_id, (available - p_character_count)::bigint;
end;
$$;

create or replace function public.finalize_premium_generation(
  p_event_id uuid,
  p_succeeded boolean,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  generation public.premium_generation_events%rowtype;
begin
  select * into generation
  from public.premium_generation_events
  where id = p_event_id
  for update;

  if not found or generation.status <> 'reserved' then return false; end if;

  update public.premium_entitlements
  set reserved_character_count = greatest(0, reserved_character_count - generation.character_count),
      generated_character_count = generated_character_count + case when p_succeeded then generation.character_count else 0 end,
      generation_count = generation_count + case when p_succeeded then 1 else 0 end,
      regeneration_count = regeneration_count + case when p_succeeded and generation.is_regeneration then 1 else 0 end,
      estimated_provider_cost_micros = estimated_provider_cost_micros + case when p_succeeded then generation.estimated_provider_cost_micros else 0 end,
      updated_at = now()
  where screenplay_id = generation.screenplay_id and owner_user_id = generation.owner_user_id;

  update public.premium_generation_events
  set status = case when p_succeeded then 'generated' else 'failed' end,
      error_code = case when p_succeeded then null else left(coalesce(p_error_code, 'generation_failed'), 80) end,
      updated_at = now()
  where id = generation.id;
  return true;
end;
$$;

revoke all on function public.reserve_premium_generation(uuid, uuid, text, text, text, integer, boolean, bigint) from public, anon, authenticated;
revoke all on function public.finalize_premium_generation(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.reserve_premium_generation(uuid, uuid, text, text, text, integer, boolean, bigint) to service_role;
grant execute on function public.finalize_premium_generation(uuid, boolean, text) to service_role;

-- Checkout/webhook code will use the service role. Browser sessions can read
-- only their own payment and entitlement rows and can never create or modify
-- proof of payment, usage counters, or generation events.

-- SpokenFrame V4 database hardening.
--
-- The rls_auto_enable event-trigger helper is installed by the hosted database
-- platform. It must keep running for DDL events, but browser roles do not need
-- permission to invoke it through the public REST API.

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

-- Cover ownership foreign keys used by account cleanup and owner-scoped joins.
-- These indexes are additive and do not alter or remove existing user data.
create index if not exists playback_states_owner_idx
  on public.playback_states(owner_user_id);

create index if not exists screenplay_settings_owner_idx
  on public.screenplay_settings(owner_user_id);

create index if not exists premium_entitlements_owner_idx
  on public.premium_entitlements(owner_user_id);

create index if not exists premium_generation_events_screenplay_owner_idx
  on public.premium_generation_events(screenplay_id, owner_user_id);

create index if not exists premium_payments_screenplay_owner_idx
  on public.premium_payments(screenplay_id, owner_user_id);

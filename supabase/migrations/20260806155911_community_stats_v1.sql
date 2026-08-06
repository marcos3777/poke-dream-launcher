create schema if not exists extensions;
-- Version aligned with the migration recorded by the hosted project.
create extension if not exists pgcrypto with schema extensions;

create table public.community_clients (
  client_id             uuid primary key,
  token_hash            text not null,
  last_revision         bigint not null default 0,
  last_snapshot_hash    text,
  last_submitted_at     timestamptz,
  schema_version        integer not null default 1,
  last_app_version      text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint community_clients_token_hash_format
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint community_clients_revision_nonnegative
    check (last_revision between 0 and 9007199254740991),
  constraint community_clients_schema_version
    check (schema_version = 1),
  constraint community_clients_app_version_format
    check (
      last_app_version is null
      or last_app_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$'
    ),
  constraint community_clients_snapshot_hash_format
    check (
      last_snapshot_hash is null
      or last_snapshot_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint community_clients_snapshot_state
    check (
      (
        last_revision = 0
        and last_snapshot_hash is null
        and last_submitted_at is null
      )
      or (
        last_revision > 0
        and last_snapshot_hash is not null
        and last_submitted_at is not null
      )
    )
);

comment on table public.community_clients is
  'One anonymous installation identity and its latest accepted snapshot revision.';
comment on column public.community_clients.token_hash is
  'SHA-256 hash of the installation token. The raw token is never persisted.';

create table public.hunt_stats (
  client_id     uuid not null references public.community_clients (client_id) on delete cascade,
  species       text not null,
  kills         bigint not null,
  caught        bigint not null,
  shinies       bigint not null,
  thrown_a      bigint not null,
  thrown_b      bigint not null,
  caught_a      numeric not null,
  caught_b      numeric not null,
  ms            bigint not null,
  updated_at    timestamptz not null default now(),

  primary key (client_id, species),

  constraint hunt_stats_species_canonical
    check (species ~ '^[A-Z][A-Za-z0-9]{0,31}$'),
  constraint hunt_stats_kills_range
    check (kills between 1 and 1000000000000),
  constraint hunt_stats_caught_range
    check (caught between 0 and 1000000000000 and caught <= kills),
  constraint hunt_stats_shinies_range
    check (shinies between 0 and 1000000000000 and shinies <= kills),
  constraint hunt_stats_thrown_a_range
    check (thrown_a between 0 and 1000000000000),
  constraint hunt_stats_thrown_b_range
    check (thrown_b between 0 and 1000000000000),
  constraint hunt_stats_caught_a_range
    check (caught_a >= 0 and caught_a <= 1000000000000 and caught_a <= thrown_a),
  constraint hunt_stats_caught_b_range
    check (caught_b >= 0 and caught_b <= 1000000000000 and caught_b <= thrown_b),
  constraint hunt_stats_caught_has_throw
    check (caught <= thrown_a + thrown_b),
  constraint hunt_stats_attributed_catches
    check (caught_a + caught_b <= caught + 0.000001),
  constraint hunt_stats_ms_safe_integer
    check (ms between 0 and 9007199254740991)
);

comment on table public.hunt_stats is
  'Latest complete community snapshot, one row per installation and canonical species.';

create index hunt_stats_species_idx on public.hunt_stats (species);

alter table public.community_clients enable row level security;
alter table public.community_clients force row level security;
alter table public.hunt_stats enable row level security;
alter table public.hunt_stats force row level security;

revoke all privileges on table public.community_clients from public, anon, authenticated;
revoke all privileges on table public.hunt_stats from public, anon, authenticated;

grant select, insert, update on table public.community_clients to service_role;
grant select, insert, update, delete on table public.hunt_stats to service_role;

create or replace function public.replace_hunt_stats(
  p_client_id uuid,
  p_token_hash text,
  p_revision bigint,
  p_schema_version integer,
  p_app_version text,
  p_stats jsonb
)
returns table (
  status text,
  saved integer,
  revision bigint,
  retry_after_seconds integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_client public.community_clients%rowtype;
  v_species text;
  v_entry jsonb;
  v_count integer;
  v_snapshot_hash text;
  v_now timestamptz := statement_timestamp();
  v_retry_after integer;
  v_kills numeric;
  v_caught numeric;
  v_shinies numeric;
  v_thrown_a numeric;
  v_thrown_b numeric;
  v_caught_a numeric;
  v_caught_b numeric;
  v_ms numeric;
  v_required_keys constant text[] := array[
    'kills',
    'caught',
    'shinies',
    'thrown_a',
    'thrown_b',
    'caught_a',
    'caught_b',
    'ms'
  ];
begin
  if p_client_id is null then
    raise exception using errcode = '22023', message = 'invalid_client';
  end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_token_hash';
  end if;

  if p_revision is null or p_revision < 1 or p_revision > 9007199254740991 then
    raise exception using errcode = '22023', message = 'invalid_revision';
  end if;

  if p_schema_version is distinct from 1 then
    raise exception using errcode = '22023', message = 'invalid_schema_version';
  end if;

  if p_app_version is null
     or p_app_version !~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$' then
    raise exception using errcode = '22023', message = 'invalid_app_version';
  end if;

  if p_stats is null or jsonb_typeof(p_stats) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_stats';
  end if;

  select count(*)::integer
    into v_count
    from pg_catalog.jsonb_object_keys(p_stats);
  if v_count > 1000 then
    raise exception using errcode = '22023', message = 'too_many_species';
  end if;

  for v_species, v_entry in
    select entry.key, entry.value
    from jsonb_each(p_stats) as entry
  loop
    if v_species !~ '^[A-Z][A-Za-z0-9]{0,31}$' then
      raise exception using errcode = '22023', message = 'invalid_species';
    end if;

    if jsonb_typeof(v_entry) <> 'object'
       or not (v_entry ?& v_required_keys)
       or (v_entry - v_required_keys) <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'invalid_stat_shape';
    end if;

    if jsonb_typeof(v_entry -> 'kills') <> 'number'
       or jsonb_typeof(v_entry -> 'caught') <> 'number'
       or jsonb_typeof(v_entry -> 'shinies') <> 'number'
       or jsonb_typeof(v_entry -> 'thrown_a') <> 'number'
       or jsonb_typeof(v_entry -> 'thrown_b') <> 'number'
       or jsonb_typeof(v_entry -> 'caught_a') <> 'number'
       or jsonb_typeof(v_entry -> 'caught_b') <> 'number'
       or jsonb_typeof(v_entry -> 'ms') <> 'number' then
      raise exception using errcode = '22023', message = 'invalid_stat_type';
    end if;

    v_kills := (v_entry ->> 'kills')::numeric;
    v_caught := (v_entry ->> 'caught')::numeric;
    v_shinies := (v_entry ->> 'shinies')::numeric;
    v_thrown_a := (v_entry ->> 'thrown_a')::numeric;
    v_thrown_b := (v_entry ->> 'thrown_b')::numeric;
    v_caught_a := (v_entry ->> 'caught_a')::numeric;
    v_caught_b := (v_entry ->> 'caught_b')::numeric;
    v_ms := (v_entry ->> 'ms')::numeric;

    if v_kills <> trunc(v_kills)
       or v_caught <> trunc(v_caught)
       or v_shinies <> trunc(v_shinies)
       or v_thrown_a <> trunc(v_thrown_a)
       or v_thrown_b <> trunc(v_thrown_b)
       or v_ms <> trunc(v_ms) then
      raise exception using errcode = '22023', message = 'invalid_integer_stat';
    end if;

    if v_kills < 1 or v_kills > 1000000000000
       or v_caught < 0 or v_caught > 1000000000000
       or v_shinies < 0 or v_shinies > 1000000000000
       or v_thrown_a < 0 or v_thrown_a > 1000000000000
       or v_thrown_b < 0 or v_thrown_b > 1000000000000
       or v_caught_a < 0 or v_caught_a > 1000000000000
       or v_caught_b < 0 or v_caught_b > 1000000000000
       or v_ms < 0 or v_ms > 9007199254740991 then
      raise exception using errcode = '22023', message = 'stat_out_of_range';
    end if;

    if v_caught > v_kills
       or v_shinies > v_kills
       or v_caught > v_thrown_a + v_thrown_b
       or v_caught_a > v_thrown_a
       or v_caught_b > v_thrown_b
       or v_caught_a + v_caught_b > v_caught + 0.000001 then
      raise exception using errcode = '22023', message = 'inconsistent_stats';
    end if;
  end loop;

  v_snapshot_hash := encode(
    extensions.digest(convert_to(p_stats::text, 'UTF8'), 'sha256'),
    'hex'
  );

  insert into public.community_clients (
    client_id,
    token_hash,
    schema_version,
    last_app_version
  )
  values (p_client_id, p_token_hash, p_schema_version, p_app_version)
  on conflict (client_id) do nothing;

  select client.*
  into strict v_client
  from public.community_clients as client
  where client.client_id = p_client_id
  for update;

  if v_client.token_hash <> p_token_hash then
    raise exception using errcode = '28000', message = 'invalid_client_token';
  end if;

  if p_revision < v_client.last_revision then
    return query
    select 'stale'::text, 0, v_client.last_revision, 0;
    return;
  end if;

  if p_revision = v_client.last_revision then
    if v_snapshot_hash <> v_client.last_snapshot_hash then
      return query
      select 'conflict'::text, 0, v_client.last_revision, 0;
      return;
    end if;

    return query
    select
      'replayed'::text,
      (select count(*)::integer from public.hunt_stats where client_id = p_client_id),
      v_client.last_revision,
      0;
    return;
  end if;

  if v_client.last_submitted_at is not null
     and v_now < v_client.last_submitted_at + interval '5 minutes' then
    v_retry_after := greatest(
      1,
      ceil(
        extract(
          epoch from (v_client.last_submitted_at + interval '5 minutes' - v_now)
        )
      )::integer
    );

    return query
    select 'rate_limited'::text, 0, v_client.last_revision, v_retry_after;
    return;
  end if;

  delete from public.hunt_stats
  where client_id = p_client_id;

  insert into public.hunt_stats (
    client_id,
    species,
    kills,
    caught,
    shinies,
    thrown_a,
    thrown_b,
    caught_a,
    caught_b,
    ms,
    updated_at
  )
  select
    p_client_id,
    entry.key,
    (entry.value ->> 'kills')::bigint,
    (entry.value ->> 'caught')::bigint,
    (entry.value ->> 'shinies')::bigint,
    (entry.value ->> 'thrown_a')::bigint,
    (entry.value ->> 'thrown_b')::bigint,
    (entry.value ->> 'caught_a')::numeric,
    (entry.value ->> 'caught_b')::numeric,
    (entry.value ->> 'ms')::bigint,
    v_now
  from jsonb_each(p_stats) as entry;

  update public.community_clients
  set
    last_revision = p_revision,
    last_snapshot_hash = v_snapshot_hash,
    last_submitted_at = v_now,
    schema_version = p_schema_version,
    last_app_version = p_app_version,
    updated_at = v_now
  where client_id = p_client_id;

  return query
  select 'saved'::text, v_count, p_revision, 0;
end;
$$;

create or replace function public.get_species_stats(p_species text)
returns table (
  species text,
  contributors bigint,
  kills numeric,
  caught numeric,
  shinies numeric,
  thrown_a numeric,
  thrown_b numeric,
  caught_a numeric,
  caught_b numeric,
  ms numeric,
  catch_pct numeric,
  catch_pct_a numeric,
  catch_pct_b numeric,
  kills_per_shiny numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    stats.species,
    count(distinct stats.client_id) as contributors,
    sum(stats.kills) as kills,
    sum(stats.caught) as caught,
    sum(stats.shinies) as shinies,
    sum(stats.thrown_a) as thrown_a,
    sum(stats.thrown_b) as thrown_b,
    sum(stats.caught_a) as caught_a,
    sum(stats.caught_b) as caught_b,
    sum(stats.ms) as ms,
    round(sum(stats.caught)::numeric * 100 / nullif(sum(stats.kills), 0), 2) as catch_pct,
    round(sum(stats.caught_a) * 100 / nullif(sum(stats.thrown_a), 0), 2) as catch_pct_a,
    round(sum(stats.caught_b) * 100 / nullif(sum(stats.thrown_b), 0), 2) as catch_pct_b,
    round(sum(stats.kills)::numeric / nullif(sum(stats.shinies), 0), 0) as kills_per_shiny
  from public.hunt_stats as stats
  where stats.species = p_species
  group by stats.species
  having sum(stats.kills) >= 500;
$$;

revoke all privileges on function public.replace_hunt_stats(uuid, text, bigint, integer, text, jsonb)
  from public, anon, authenticated;
revoke all privileges on function public.get_species_stats(text)
  from public, anon, authenticated;

grant execute on function public.replace_hunt_stats(uuid, text, bigint, integer, text, jsonb)
  to service_role;
grant execute on function public.get_species_stats(text)
  to service_role;

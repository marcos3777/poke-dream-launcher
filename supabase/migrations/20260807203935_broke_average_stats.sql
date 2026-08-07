-- Community schema v3: store the sufficient statistics for a real broke average.
-- The average itself stays derived; an open streak may be a provisional maximum, but never
-- contributes to broke_sum/broke_count until a shiny capture closes the sample.
alter table public.community_clients
  drop constraint community_clients_schema_version,
  add constraint community_clients_schema_version
    check (schema_version in (1, 2, 3));

alter table public.hunt_stats
  add column broke_sum bigint not null default 0,
  add column broke_count bigint not null default 0,
  drop constraint hunt_stats_broke_state,
  add constraint hunt_stats_broke_state
    check (
      (broke_max is null or broke_max between 1 and shinies)
      and (broke_min is null or (broke_max is not null and broke_min between 1 and broke_max))
      and broke_count between 0 and shiny_caught
      and broke_sum between 0 and 9007199254740991
      and (
        (broke_count = 0 and broke_sum = 0)
        or (
          broke_count > 0
          and broke_min is not null
          and broke_max is not null
          and broke_sum::numeric between broke_min::numeric * broke_count
            and broke_max::numeric * broke_count
        )
      )
    );

comment on column public.hunt_stats.broke_sum is
  'Sum of closed broke samples; used with broke_count to derive an exact average.';
comment on column public.hunt_stats.broke_count is
  'Number of closed broke samples represented by broke_sum.';

create function public.replace_hunt_stats_v3(
  p_client_id uuid,
  p_token_hash text,
  p_revision bigint,
  p_schema_version integer,
  p_app_version text,
  p_stats jsonb,
  p_source_hash text
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
  v_source public.community_registration_limits%rowtype;
  v_account_id text;
  v_account_stats jsonb;
  v_species text;
  v_entry jsonb;
  v_count integer := 0;
  v_species_count integer;
  v_snapshot_hash text;
  v_now timestamptz := statement_timestamp();
  v_retry_after integer;
  v_kills numeric;
  v_caught numeric;
  v_shinies numeric;
  v_shiny_caught numeric;
  v_broke_max numeric;
  v_broke_min numeric;
  v_broke_sum numeric;
  v_broke_count numeric;
  v_thrown_a numeric;
  v_thrown_b numeric;
  v_caught_a numeric;
  v_caught_b numeric;
  v_ms numeric;
  v_required_keys constant text[] := array[
    'kills', 'caught', 'shinies', 'shiny_caught', 'broke_max', 'broke_min',
    'broke_sum', 'broke_count', 'thrown_a', 'thrown_b', 'caught_a', 'caught_b', 'ms'
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
  if p_schema_version <> 3 then
    raise exception using errcode = '22023', message = 'invalid_schema_version';
  end if;
  if p_app_version is null
     or p_app_version !~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$' then
    raise exception using errcode = '22023', message = 'invalid_app_version';
  end if;
  if p_stats is null or jsonb_typeof(p_stats) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_stats';
  end if;
  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_source_hash';
  end if;

  select count(*)::integer into v_species_count
  from pg_catalog.jsonb_object_keys(p_stats);
  if v_species_count > 32 then
    raise exception using errcode = '22023', message = 'too_many_accounts';
  end if;

  for v_account_id, v_account_stats in
    select account.key, account.value from jsonb_each(p_stats) as account
  loop
    if v_account_id !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid_account';
    end if;
    if jsonb_typeof(v_account_stats) <> 'object' then
      raise exception using errcode = '22023', message = 'invalid_account_stats';
    end if;

    select count(*)::integer into v_species_count
    from pg_catalog.jsonb_object_keys(v_account_stats);
    if v_species_count > 300 then
      raise exception using errcode = '22023', message = 'too_many_species';
    end if;

    for v_species, v_entry in
      select entry.key, entry.value from jsonb_each(v_account_stats) as entry
    loop
      v_count := v_count + 1;
      if v_species !~ '^[A-Z][A-Za-z0-9]{0,31}$' then
        raise exception using errcode = '22023', message = 'invalid_species';
      end if;
      if not exists (
        select 1 from public.community_species as allowed where allowed.species = v_species
      ) then
        raise exception using errcode = '22023', message = 'unknown_species';
      end if;
      if jsonb_typeof(v_entry) <> 'object'
         or not (v_entry ?& v_required_keys)
         or (v_entry - v_required_keys) <> '{}'::jsonb then
        raise exception using errcode = '22023', message = 'invalid_stat_shape';
      end if;
      if jsonb_typeof(v_entry -> 'kills') <> 'number'
         or jsonb_typeof(v_entry -> 'caught') <> 'number'
         or jsonb_typeof(v_entry -> 'shinies') <> 'number'
         or jsonb_typeof(v_entry -> 'shiny_caught') <> 'number'
         or ((v_entry -> 'broke_max') <> 'null'::jsonb and jsonb_typeof(v_entry -> 'broke_max') <> 'number')
         or ((v_entry -> 'broke_min') <> 'null'::jsonb and jsonb_typeof(v_entry -> 'broke_min') <> 'number')
         or jsonb_typeof(v_entry -> 'broke_sum') <> 'number'
         or jsonb_typeof(v_entry -> 'broke_count') <> 'number'
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
      v_shiny_caught := (v_entry ->> 'shiny_caught')::numeric;
      v_broke_max := (v_entry ->> 'broke_max')::numeric;
      v_broke_min := (v_entry ->> 'broke_min')::numeric;
      v_broke_sum := (v_entry ->> 'broke_sum')::numeric;
      v_broke_count := (v_entry ->> 'broke_count')::numeric;
      v_thrown_a := (v_entry ->> 'thrown_a')::numeric;
      v_thrown_b := (v_entry ->> 'thrown_b')::numeric;
      v_caught_a := (v_entry ->> 'caught_a')::numeric;
      v_caught_b := (v_entry ->> 'caught_b')::numeric;
      v_ms := (v_entry ->> 'ms')::numeric;

      if v_kills <> trunc(v_kills)
         or v_caught <> trunc(v_caught)
         or v_shinies <> trunc(v_shinies)
         or v_shiny_caught <> trunc(v_shiny_caught)
         or (v_broke_max is not null and v_broke_max <> trunc(v_broke_max))
         or (v_broke_min is not null and v_broke_min <> trunc(v_broke_min))
         or v_broke_sum <> trunc(v_broke_sum)
         or v_broke_count <> trunc(v_broke_count)
         or v_thrown_a <> trunc(v_thrown_a)
         or v_thrown_b <> trunc(v_thrown_b)
         or v_ms <> trunc(v_ms) then
        raise exception using errcode = '22023', message = 'invalid_integer_stat';
      end if;

      if v_kills < 1 or v_kills > 1000000000
         or v_caught < 0 or v_caught > 1000000000
         or v_shinies < 0 or v_shinies > 1000000000
         or v_shiny_caught < 0 or v_shiny_caught > 1000000000
         or v_broke_sum < 0 or v_broke_sum > 9007199254740991
         or v_broke_count < 0 or v_broke_count > 1000000000
         or v_thrown_a < 0 or v_thrown_a > 1000000000
         or v_thrown_b < 0 or v_thrown_b > 1000000000
         or v_caught_a < 0 or v_caught_a > 1000000000
         or v_caught_b < 0 or v_caught_b > 1000000000
         or v_ms < 0 or v_ms > 630720000000
         or (v_broke_max is not null and (v_broke_max < 1 or v_broke_max > 1000000000))
         or (v_broke_min is not null and (v_broke_min < 1 or v_broke_min > 1000000000)) then
        raise exception using errcode = '22023', message = 'stat_out_of_range';
      end if;

      if v_caught > v_kills
         or v_shinies > v_kills
         or v_shiny_caught > v_shinies
         or v_shiny_caught > v_caught
         or v_caught > v_thrown_a + v_thrown_b
         or v_caught_a > v_thrown_a
         or v_caught_b > v_thrown_b
         or v_caught_a + v_caught_b > v_caught + 0.000001
         or (v_broke_min is not null and v_broke_max is null)
         or (v_broke_max is not null and v_broke_max > v_shinies)
         or (v_broke_min is not null and v_broke_min > v_broke_max)
         or v_broke_count > v_shiny_caught
         or (v_broke_count = 0 and v_broke_sum <> 0)
         or (v_broke_count > 0 and (v_broke_min is null or v_broke_max is null))
         or (v_broke_count > 0 and (v_broke_sum < v_broke_min * v_broke_count
           or v_broke_sum > v_broke_max * v_broke_count)) then
        raise exception using errcode = '22023', message = 'inconsistent_stats';
      end if;
    end loop;
  end loop;

  v_snapshot_hash := encode(
    extensions.digest(convert_to(p_stats::text, 'UTF8'), 'sha256'),
    'hex'
  );

  select client.* into v_client
  from public.community_clients as client
  where client.client_id = p_client_id
  for update;

  if not found then
    perform pg_catalog.pg_advisory_xact_lock(176034519);
    select client.* into v_client
    from public.community_clients as client
    where client.client_id = p_client_id
    for update;

    if not found then
      delete from public.community_registration_limits where expires_at <= v_now;
      insert into public.community_registration_limits (source_hash, registrations, expires_at)
      values (p_source_hash, 0, pg_catalog.date_trunc('day', v_now, 'UTC') + interval '1 day')
      on conflict (source_hash) do nothing;

      select source.* into strict v_source
      from public.community_registration_limits as source
      where source.source_hash = p_source_hash
      for update;

      if v_source.registrations >= 1 then
        v_retry_after := greatest(1, ceil(extract(epoch from (v_source.expires_at - v_now)))::integer);
        return query select 'registration_limited'::text, 0, 0::bigint, v_retry_after;
        return;
      end if;
      if (select count(*) from public.community_clients) >= 20000 then
        return query select 'registration_limited'::text, 0, 0::bigint, 86400;
        return;
      end if;

      update public.community_registration_limits
      set registrations = registrations + 1
      where source_hash = p_source_hash;

      insert into public.community_clients (client_id, token_hash, schema_version, last_app_version)
      values (p_client_id, p_token_hash, p_schema_version, p_app_version)
      returning * into v_client;
    end if;
  end if;

  if v_client.token_hash <> p_token_hash then
    raise exception using errcode = '28000', message = 'invalid_client_token';
  end if;
  if p_schema_version < v_client.schema_version then
    raise exception using errcode = '22023', message = 'schema_downgrade';
  end if;
  if p_revision < v_client.last_revision then
    return query select 'stale'::text, 0, v_client.last_revision, 0;
    return;
  end if;
  if p_revision = v_client.last_revision then
    if v_snapshot_hash <> v_client.last_snapshot_hash then
      return query select 'conflict'::text, 0, v_client.last_revision, 0;
      return;
    end if;
    return query
    select 'replayed'::text,
      (select count(*)::integer from public.hunt_stats where client_id = p_client_id),
      v_client.last_revision,
      0;
    return;
  end if;

  if v_client.last_submitted_at is not null
     and v_now < v_client.last_submitted_at + interval '5 minutes' then
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_client.last_submitted_at + interval '5 minutes' - v_now)))::integer
    );
    return query select 'rate_limited'::text, 0, v_client.last_revision, v_retry_after;
    return;
  end if;

  delete from public.hunt_stats where client_id = p_client_id;
  insert into public.hunt_stats (
    client_id, account_id, species, kills, caught, shinies, shiny_caught,
    broke_max, broke_min, broke_sum, broke_count,
    thrown_a, thrown_b, caught_a, caught_b, ms, updated_at
  )
  select
    p_client_id,
    account.key,
    entry.key,
    (entry.value ->> 'kills')::bigint,
    (entry.value ->> 'caught')::bigint,
    (entry.value ->> 'shinies')::bigint,
    (entry.value ->> 'shiny_caught')::bigint,
    (entry.value ->> 'broke_max')::bigint,
    (entry.value ->> 'broke_min')::bigint,
    (entry.value ->> 'broke_sum')::bigint,
    (entry.value ->> 'broke_count')::bigint,
    (entry.value ->> 'thrown_a')::bigint,
    (entry.value ->> 'thrown_b')::bigint,
    (entry.value ->> 'caught_a')::numeric,
    (entry.value ->> 'caught_b')::numeric,
    (entry.value ->> 'ms')::bigint,
    v_now
  from jsonb_each(p_stats) as account
  cross join lateral jsonb_each(account.value) as entry;

  update public.community_clients
  set
    last_revision = p_revision,
    last_snapshot_hash = v_snapshot_hash,
    last_submitted_at = v_now,
    schema_version = p_schema_version,
    last_app_version = p_app_version,
    accepted_submissions = least(accepted_submissions + 1, 1000000),
    updated_at = v_now
  where client_id = p_client_id;

  return query select 'saved'::text, v_count, p_revision, 0;
end;
$$;

revoke all privileges on function public.replace_hunt_stats_v3(uuid, text, bigint, integer, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.replace_hunt_stats_v3(uuid, text, bigint, integer, text, jsonb, text)
  to service_role;

drop function public.get_species_stats(text);
drop function public.get_species_stats_precise(text);

create function public.get_species_stats_precise(p_species text)
returns table (
  species text,
  contributors bigint,
  kills numeric,
  caught numeric,
  shinies numeric,
  shiny_caught numeric,
  broke_avg numeric,
  broke_max numeric,
  broke_min numeric,
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
  with eligible as (
    select
      stats.*,
      least(1::numeric, 10000::numeric / nullif(stats.kills, 0)) as sample_weight
    from public.hunt_stats as stats
    join public.community_clients as client using (client_id)
    where stats.species = p_species
      and client.accepted_submissions >= 2
  ), totals as (
    select
      eligible.species,
      count(distinct (eligible.client_id, eligible.account_id)) as contributors,
      sum(eligible.kills * eligible.sample_weight) as kills,
      sum(eligible.caught * eligible.sample_weight) as caught,
      sum(eligible.shinies * eligible.sample_weight) as shinies,
      sum(eligible.shiny_caught * eligible.sample_weight) as shiny_caught,
      round(
        sum(eligible.broke_sum * eligible.sample_weight)
          / nullif(sum(eligible.broke_count * eligible.sample_weight), 0),
        2
      ) as broke_avg,
      max(eligible.broke_max)::numeric as broke_max,
      (min(eligible.broke_min) filter (where eligible.broke_min is not null))::numeric as broke_min,
      sum(eligible.thrown_a * eligible.sample_weight) as thrown_a,
      sum(eligible.thrown_b * eligible.sample_weight) as thrown_b,
      sum(eligible.caught_a * eligible.sample_weight) as caught_a,
      sum(eligible.caught_b * eligible.sample_weight) as caught_b,
      sum(eligible.ms * eligible.sample_weight) as ms
    from eligible
    group by eligible.species
  )
  select
    totals.species,
    totals.contributors,
    totals.kills,
    totals.caught,
    totals.shinies,
    totals.shiny_caught,
    totals.broke_avg,
    totals.broke_max,
    totals.broke_min,
    totals.thrown_a,
    totals.thrown_b,
    totals.caught_a,
    totals.caught_b,
    totals.ms,
    round(totals.caught * 100 / nullif(totals.kills, 0), 2) as catch_pct,
    round(totals.caught_a * 100 / nullif(totals.thrown_a, 0), 2) as catch_pct_a,
    round(totals.caught_b * 100 / nullif(totals.thrown_b, 0), 2) as catch_pct_b,
    round(totals.kills / nullif(totals.shinies, 0), 0) as kills_per_shiny
  from totals
  where totals.kills >= 500
    and totals.contributors >= 1;
$$;

create function public.get_species_stats(p_species text)
returns table (
  species text,
  contributors bigint,
  kills numeric,
  caught numeric,
  shinies numeric,
  shiny_caught numeric,
  broke_avg numeric,
  broke_max numeric,
  broke_min numeric,
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
    stats.contributors,
    round(stats.kills, 0),
    round(stats.caught, 0),
    round(stats.shinies, 0),
    round(stats.shiny_caught, 0),
    stats.broke_avg,
    stats.broke_max,
    stats.broke_min,
    round(stats.thrown_a, 0),
    round(stats.thrown_b, 0),
    round(stats.caught_a, 6),
    round(stats.caught_b, 6),
    round(stats.ms, 0),
    stats.catch_pct,
    stats.catch_pct_a,
    stats.catch_pct_b,
    stats.kills_per_shiny
  from public.get_species_stats_precise(p_species) as stats;
$$;

revoke all privileges on function public.get_species_stats_precise(text)
  from public, anon, authenticated;
revoke all privileges on function public.get_species_stats(text)
  from public, anon, authenticated;
grant execute on function public.get_species_stats_precise(text) to service_role;
grant execute on function public.get_species_stats(text) to service_role;

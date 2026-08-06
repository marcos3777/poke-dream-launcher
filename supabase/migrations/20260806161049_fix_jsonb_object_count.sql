-- Version aligned with the migration recorded by the hosted project.
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

revoke all privileges on function public.replace_hunt_stats(uuid, text, bigint, integer, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.replace_hunt_stats(uuid, text, bigint, integer, text, jsonb)
  to service_role;

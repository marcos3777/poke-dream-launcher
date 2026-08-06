-- Version aligned with the migration recorded by the hosted project.
create table public.community_species (
  species text primary key,
  dex_number smallint not null unique,
  constraint community_species_name_format
    check (species ~ '^[A-Z][A-Za-z0-9]{0,31}$'),
  constraint community_species_dex_range
    check (dex_number between 1 and 999)
);

alter table public.community_species enable row level security;
alter table public.community_species force row level security;
revoke all privileges on table public.community_species from public, anon, authenticated;
grant select on table public.community_species to service_role;

insert into public.community_species (species, dex_number)
values
('Bulbasaur', 1),
  ('Ivysaur', 2),
  ('Venusaur', 3),
  ('Charmander', 4),
  ('Charmeleon', 5),
  ('Charizard', 6),
  ('Squirtle', 7),
  ('Wartortle', 8),
  ('Blastoise', 9),
  ('Caterpie', 10),
  ('Metapod', 11),
  ('Butterfree', 12),
  ('Weedle', 13),
  ('Kakuna', 14),
  ('Beedrill', 15),
  ('Pidgey', 16),
  ('Pidgeotto', 17),
  ('Pidgeot', 18),
  ('Rattata', 19),
  ('Raticate', 20),
  ('Spearow', 21),
  ('Fearow', 22),
  ('Ekans', 23),
  ('Arbok', 24),
  ('Pikachu', 25),
  ('Raichu', 26),
  ('Sandshrew', 27),
  ('Sandslash', 28),
  ('NidoranF', 29),
  ('Nidorina', 30),
  ('Nidoqueen', 31),
  ('NidoranM', 32),
  ('Nidorino', 33),
  ('Nidoking', 34),
  ('Clefairy', 35),
  ('Clefable', 36),
  ('Vulpix', 37),
  ('Ninetales', 38),
  ('Jigglypuff', 39),
  ('Wigglytuff', 40),
  ('Zubat', 41),
  ('Golbat', 42),
  ('Oddish', 43),
  ('Gloom', 44),
  ('Vileplume', 45),
  ('Paras', 46),
  ('Parasect', 47),
  ('Venonat', 48),
  ('Venomoth', 49),
  ('Diglett', 50),
  ('Dugtrio', 51),
  ('Meowth', 52),
  ('Persian', 53),
  ('Psyduck', 54),
  ('Golduck', 55),
  ('Mankey', 56),
  ('Primeape', 57),
  ('Growlithe', 58),
  ('Arcanine', 59),
  ('Poliwag', 60),
  ('Poliwhirl', 61),
  ('Poliwrath', 62),
  ('Abra', 63),
  ('Kadabra', 64),
  ('Alakazam', 65),
  ('Machop', 66),
  ('Machoke', 67),
  ('Machamp', 68),
  ('Bellsprout', 69),
  ('Weepinbell', 70),
  ('Victreebel', 71),
  ('Tentacool', 72),
  ('Tentacruel', 73),
  ('Geodude', 74),
  ('Graveler', 75),
  ('Golem', 76),
  ('Ponyta', 77),
  ('Rapidash', 78),
  ('Slowpoke', 79),
  ('Slowbro', 80),
  ('Magnemite', 81),
  ('Magneton', 82),
  ('Farfetchd', 83),
  ('Doduo', 84),
  ('Dodrio', 85),
  ('Seel', 86),
  ('Dewgong', 87),
  ('Grimer', 88),
  ('Muk', 89),
  ('Shellder', 90),
  ('Cloyster', 91),
  ('Gastly', 92),
  ('Haunter', 93),
  ('Gengar', 94),
  ('Onix', 95),
  ('Drowzee', 96),
  ('Hypno', 97),
  ('Krabby', 98),
  ('Kingler', 99),
  ('Voltorb', 100),
  ('Electrode', 101),
  ('Exeggcute', 102),
  ('Exeggutor', 103),
  ('Cubone', 104),
  ('Marowak', 105),
  ('Hitmonlee', 106),
  ('Hitmonchan', 107),
  ('Lickitung', 108),
  ('Koffing', 109),
  ('Weezing', 110),
  ('Rhyhorn', 111),
  ('Rhydon', 112),
  ('Chansey', 113),
  ('Tangela', 114),
  ('Kangaskhan', 115),
  ('Horsea', 116),
  ('Seadra', 117),
  ('Goldeen', 118),
  ('Seaking', 119),
  ('Staryu', 120),
  ('Starmie', 121),
  ('MrMime', 122),
  ('Scyther', 123),
  ('Jynx', 124),
  ('Electabuzz', 125),
  ('Magmar', 126),
  ('Pinsir', 127),
  ('Tauros', 128),
  ('Magikarp', 129),
  ('Gyarados', 130),
  ('Lapras', 131),
  ('Ditto', 132),
  ('Eevee', 133),
  ('Vaporeon', 134),
  ('Jolteon', 135),
  ('Flareon', 136),
  ('Porygon', 137),
  ('Omanyte', 138),
  ('Omastar', 139),
  ('Kabuto', 140),
  ('Kabutops', 141),
  ('Aerodactyl', 142),
  ('Snorlax', 143),
  ('Dratini', 147),
  ('Dragonair', 148),
  ('Dragonite', 149),
  ('Chikorita', 152),
  ('Bayleef', 153),
  ('Meganium', 154),
  ('Cyndaquil', 155),
  ('Quilava', 156),
  ('Typhlosion', 157),
  ('Totodile', 158),
  ('Croconaw', 159),
  ('Feraligatr', 160),
  ('Sentret', 161),
  ('Furret', 162),
  ('Hoothoot', 163),
  ('Noctowl', 164),
  ('Ledyba', 165),
  ('Ledian', 166),
  ('Spinarak', 167),
  ('Ariados', 168),
  ('Crobat', 169),
  ('Chinchou', 170),
  ('Lanturn', 171),
  ('Pichu', 172),
  ('Cleffa', 173),
  ('Igglybuff', 174),
  ('Togepi', 175),
  ('Togetic', 176),
  ('Natu', 177),
  ('Xatu', 178),
  ('Mareep', 179),
  ('Flaaffy', 180),
  ('Ampharos', 181),
  ('Bellossom', 182),
  ('Marill', 183),
  ('Azumarill', 184),
  ('Sudowoodo', 185),
  ('Politoed', 186),
  ('Hoppip', 187),
  ('Skiploom', 188),
  ('Jumpluff', 189),
  ('Aipom', 190),
  ('Sunkern', 191),
  ('Sunflora', 192),
  ('Yanma', 193),
  ('Wooper', 194),
  ('Quagsire', 195),
  ('Espeon', 196),
  ('Umbreon', 197),
  ('Murkrow', 198),
  ('Slowking', 199),
  ('Misdreavus', 200),
  ('Unown', 201),
  ('Wobbuffet', 202),
  ('Girafarig', 203),
  ('Pineco', 204),
  ('Forretress', 205),
  ('Dunsparce', 206),
  ('Gligar', 207),
  ('Steelix', 208),
  ('Snubbull', 209),
  ('Granbull', 210),
  ('Qwilfish', 211),
  ('Scizor', 212),
  ('Shuckle', 213),
  ('Heracross', 214),
  ('Sneasel', 215),
  ('Teddiursa', 216),
  ('Ursaring', 217),
  ('Slugma', 218),
  ('Magcargo', 219),
  ('Swinub', 220),
  ('Piloswine', 221),
  ('Corsola', 222),
  ('Remoraid', 223),
  ('Octillery', 224),
  ('Delibird', 225),
  ('Mantine', 226),
  ('Skarmory', 227),
  ('Houndour', 228),
  ('Houndoom', 229),
  ('Kingdra', 230),
  ('Phanpy', 231),
  ('Donphan', 232),
  ('Porygon2', 233),
  ('Stantler', 234),
  ('Smeargle', 235),
  ('Tyrogue', 236),
  ('Hitmontop', 237),
  ('Smoochum', 238),
  ('Elekid', 239),
  ('Magby', 240),
  ('Miltank', 241),
  ('Blissey', 242),
  ('Larvitar', 246),
  ('Pupitar', 247),
  ('Tyranitar', 248);

alter table public.community_clients
  add column accepted_submissions integer not null default 0,
  add constraint community_clients_accepted_submissions_range
    check (accepted_submissions between 0 and 1000000);

create index community_clients_created_at_idx
  on public.community_clients (created_at);

alter table public.hunt_stats
  add constraint hunt_stats_species_fk
  foreign key (species) references public.community_species (species);


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
  if v_count > 300 then
    raise exception using errcode = '22023', message = 'too_many_species';
  end if;

  for v_species, v_entry in
    select entry.key, entry.value
    from jsonb_each(p_stats) as entry
  loop
    if v_species !~ '^[A-Z][A-Za-z0-9]{0,31}$' then
      raise exception using errcode = '22023', message = 'invalid_species';
    end if;

    if not exists (
      select 1
      from public.community_species as allowed
      where allowed.species = v_species
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

    if v_kills < 1 or v_kills > 1000000000
       or v_caught < 0 or v_caught > 1000000000
       or v_shinies < 0 or v_shinies > 1000000000
       or v_thrown_a < 0 or v_thrown_a > 1000000000
       or v_thrown_b < 0 or v_thrown_b > 1000000000
       or v_caught_a < 0 or v_caught_a > 1000000000
       or v_caught_b < 0 or v_caught_b > 1000000000
       or v_ms < 0 or v_ms > 630720000000 then
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

  select client.*
  into v_client
  from public.community_clients as client
  where client.client_id = p_client_id
  for update;

  if not found then
    -- Serializa somente novos cadastros. IDs já conhecidos não disputam este lock.
    perform pg_catalog.pg_advisory_xact_lock(176034519);

    select client.*
    into v_client
    from public.community_clients as client
    where client.client_id = p_client_id
    for update;

    if not found then
      if (
        select count(*)
        from public.community_clients
        where created_at > v_now - interval '1 hour'
      ) >= 20 then
        return query
        select 'registration_limited'::text, 0, 0::bigint, 3600;
        return;
      end if;

      if (select count(*) from public.community_clients) >= 20000 then
        return query
        select 'registration_limited'::text, 0, 0::bigint, 86400;
        return;
      end if;

      insert into public.community_clients (
        client_id,
        token_hash,
        schema_version,
        last_app_version
      )
      values (p_client_id, p_token_hash, p_schema_version, p_app_version)
      returning * into v_client;
    end if;
  end if;

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
    accepted_submissions = least(accepted_submissions + 1, 1000000),
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
  with eligible as (
    select
      stats.*,
      least(1::numeric, 10000::numeric / nullif(stats.kills, 0)) as sample_weight
    from public.hunt_stats as stats
    join public.community_clients as client using (client_id)
    where stats.species = p_species
      and client.accepted_submissions >= 2
      and client.created_at <= statement_timestamp() - interval '24 hours'
  ), totals as (
    select
      eligible.species,
      count(distinct eligible.client_id) as contributors,
      round(sum(eligible.kills * eligible.sample_weight), 0) as kills,
      round(sum(eligible.caught * eligible.sample_weight), 0) as caught,
      round(sum(eligible.shinies * eligible.sample_weight), 0) as shinies,
      round(sum(eligible.thrown_a * eligible.sample_weight), 0) as thrown_a,
      round(sum(eligible.thrown_b * eligible.sample_weight), 0) as thrown_b,
      round(sum(eligible.caught_a * eligible.sample_weight), 6) as caught_a,
      round(sum(eligible.caught_b * eligible.sample_weight), 6) as caught_b,
      round(sum(eligible.ms * eligible.sample_weight), 0) as ms
    from eligible
    group by eligible.species
  )
  select
    totals.species,
    totals.contributors,
    totals.kills,
    totals.caught,
    totals.shinies,
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
  where totals.kills >= 500;
$$;

revoke all privileges on function public.get_species_stats(text)
  from public, anon, authenticated;
grant execute on function public.get_species_stats(text)
  to service_role;

-- Preserve fractional weighted totals until every rate has been calculated. Rounding a rare
-- event before division could erase it completely after the per-installation influence cap.
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
      sum(eligible.kills * eligible.sample_weight) as kills,
      sum(eligible.caught * eligible.sample_weight) as caught,
      sum(eligible.shinies * eligible.sample_weight) as shinies,
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

revoke all privileges on function public.get_species_stats(text)
  from public, anon, authenticated;
grant execute on function public.get_species_stats(text)
  to service_role;

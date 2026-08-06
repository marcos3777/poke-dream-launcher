'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HuntMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildApi() {
  function finiteNonNegative(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function percentage(numerator, denominator) {
    const num = finiteNonNegative(numerator);
    const den = finiteNonNegative(denominator);
    return num !== null && den !== null && den > 0 ? num / den * 100 : null;
  }

  function perEvent(total, events) {
    const all = finiteNonNegative(total);
    const count = finiteNonNegative(events);
    return all !== null && count !== null && count > 0 ? all / count : null;
  }

  function perHour(value, milliseconds) {
    const count = finiteNonNegative(value);
    const ms = finiteNonNegative(milliseconds);
    return count !== null && ms !== null && ms > 0 ? count * 3600000 / ms : null;
  }

  function describe(input) {
    const source = input && typeof input === 'object' ? input : {};
    const kills = finiteNonNegative(source.kills) || 0;
    const caught = finiteNonNegative(source.caught) || 0;
    const shinies = finiteNonNegative(source.shinies) || 0;
    const thrown = finiteNonNegative(source.thrown) || 0;
    const ms = finiteNonNegative(source.ms) || 0;
    return {
      kills, caught, shinies, thrown, ms,
      catchPct: percentage(caught, kills),
      shinyPct: percentage(shinies, kills),
      encountersPerCatch: perEvent(kills, caught),
      encountersPerShiny: perEvent(kills, shinies),
      ballsPerCatch: perEvent(thrown, caught),
      ballsPerEncounter: perEvent(thrown, kills),
      perHour: {
        kills: perHour(kills, ms),
        caught: perHour(caught, ms),
        shinies: perHour(shinies, ms),
        thrown: perHour(thrown, ms),
      },
    };
  }

  function enqueueStateUpdate(order, update) {
    if (!order || typeof order !== 'object' || !update || typeof update !== 'object') return [];
    if (!(order.pending instanceof Map)) order.pending = new Map();
    if (!Number.isSafeInteger(order.version) || order.version < 0) order.version = null;
    const version = Number(update.version);
    if (!Number.isSafeInteger(version) || version < 0) return [update];

    if (update.full) {
      if (order.version !== null && version <= order.version) return [];
      order.version = version;
      for (const pendingVersion of order.pending.keys()) {
        if (pendingVersion <= version) order.pending.delete(pendingVersion);
      }
      const ready = [update];
      while (order.pending.has(order.version + 1)) {
        const nextVersion = order.version + 1;
        ready.push(order.pending.get(nextVersion));
        order.pending.delete(nextVersion);
        order.version = nextVersion;
      }
      return ready;
    }

    if (order.version !== null && version <= order.version) return [];
    order.pending.set(version, update);
    const ready = [];
    while (order.version !== null && order.pending.has(order.version + 1)) {
      const nextVersion = order.version + 1;
      ready.push(order.pending.get(nextVersion));
      order.pending.delete(nextVersion);
      order.version = nextVersion;
    }
    const maxPending = Number.isSafeInteger(order.maxPending) && order.maxPending >= 2 ? order.maxPending : 12;
    if (!ready.length && order.pending.size >= maxPending) {
      const baselineVersion = Math.min(...order.pending.keys());
      const baseline = order.pending.get(baselineVersion);
      order.pending.delete(baselineVersion);
      order.version = baselineVersion;
      ready.push({ ...baseline, resetBaseline: true });
      while (order.pending.has(order.version + 1)) {
        const nextVersion = order.version + 1;
        ready.push(order.pending.get(nextVersion));
        order.pending.delete(nextVersion);
        order.version = nextVersion;
      }
    }
    return ready;
  }

  function recordObservation(entry, input) {
    if (!entry || typeof entry !== 'object') return false;
    const observation = input && typeof input === 'object' ? input : {};
    const ms = finiteNonNegative(observation.ms) || 0;
    const kills = finiteNonNegative(observation.kills) || 0;
    const caught = finiteNonNegative(observation.caught) || 0;
    const shinies = finiteNonNegative(observation.shinies) || 0;
    const thrownA = finiteNonNegative(observation.thrownA) || 0;
    const thrownB = finiteNonNegative(observation.thrownB) || 0;
    const shinyCaught = Math.min(caught, finiteNonNegative(observation.shinyCaught) || 0);
    const thrown = thrownA + thrownB;

    entry.ms = (finiteNonNegative(entry.ms) || 0) + ms;
    entry.kills = (finiteNonNegative(entry.kills) || 0) + kills;
    entry.caught = (finiteNonNegative(entry.caught) || 0) + caught;
    entry.shinies = (finiteNonNegative(entry.shinies) || 0) + shinies;
    entry.shinyCaught = (finiteNonNegative(entry.shinyCaught) || 0) + shinyCaught;
    entry.thrownA = (finiteNonNegative(entry.thrownA) || 0) + thrownA;
    entry.thrownB = (finiteNonNegative(entry.thrownB) || 0) + thrownB;

    entry.captureDryBalls = (finiteNonNegative(entry.captureDryBalls) || 0) + thrown;
    if (caught) entry.captureDryBalls = 0;
    entry.dryBalls = (finiteNonNegative(entry.dryBalls) || 0) + thrown;
    entry.dryKills = (finiteNonNegative(entry.dryKills) || 0) + kills;
    if (shinies) { entry.dryBalls = 0; entry.dryKills = 0; }

    if (caught) entry.pend = (finiteNonNegative(entry.pend) || 0) + caught;
    if (entry.pend && thrown) {
      const pending = entry.pend;
      entry.pend = 0;
      if (!thrownA) entry.caughtB = (finiteNonNegative(entry.caughtB) || 0) + pending;
      else if (!thrownB) entry.caughtA = (finiteNonNegative(entry.caughtA) || 0) + pending;
      else {
        const attributedA = pending * thrownA / thrown;
        entry.caughtA = (finiteNonNegative(entry.caughtA) || 0) + attributedA;
        entry.caughtB = (finiteNonNegative(entry.caughtB) || 0) + pending - attributedA;
      }
    }

    const activity = !!(kills || caught || shinies || shinyCaught || thrown);
    if (activity && Number.isFinite(Number(observation.now))) entry.updated = Number(observation.now);
    return !!(ms || activity);
  }

  return { describe, enqueueStateUpdate, perEvent, perHour, percentage, recordObservation };
});

'use strict';

const SUPABASE_URL = 'https://ddjhptkpndopbondgvlv.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_yTCUuFkmqnOSf3OmHYJZXA_FMnaPmpB';
const COMMUNITY_SCHEMA_VERSION = 1;
const POSITIVE_CACHE_MS = 30 * 60 * 1000;
const NEGATIVE_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_COUNTER = 1_000_000_000;
const MAX_HUNT_MS = 630_720_000_000;
const SPECIES_RE = /^[A-Z][A-Za-z0-9]{0,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;

class CommunityHttpError extends Error {
  constructor(message, status, code, data) {
    super(message);
    this.name = 'CommunityHttpError';
    this.status = Number.isFinite(status) ? status : 0;
    this.code = code || 'request_failed';
    this.data = data || null;
  }
}

class CommunitySnapshotError extends Error {
  constructor(species = null) {
    super('invalid local community snapshot');
    this.name = 'CommunitySnapshotError';
    this.code = 'invalid_local_snapshot';
    this.species = typeof species === 'string' ? species : null;
  }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function safeInteger(value, min, max) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}
function safeDecimal(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// Converte somente os campos comunitários. "shinies" vem de shinyKills (encontrados/derrotados),
// enquanto "caught" representa capturas; streaks, pendências e dados de conta nunca entram.
function huntLogToStats(huntLog) {
  const result = {};
  if (!isRecord(huntLog)) throw new CommunitySnapshotError();

  for (const species of Object.keys(huntLog).sort()) {
    if (!SPECIES_RE.test(species)) throw new CommunitySnapshotError(species);
    const entry = huntLog[species];
    if (!isRecord(entry)) throw new CommunitySnapshotError(species);

    const kills = safeInteger(entry.kills, 0, MAX_COUNTER);
    const caught = safeInteger(entry.caught, 0, MAX_COUNTER);
    const shinies = safeInteger(entry.shinies, 0, MAX_COUNTER);
    const thrownA = safeInteger(entry.thrownA, 0, MAX_COUNTER);
    const thrownB = safeInteger(entry.thrownB, 0, MAX_COUNTER);
    const caughtA = safeDecimal(entry.caughtA, 0, MAX_COUNTER);
    const caughtB = safeDecimal(entry.caughtB, 0, MAX_COUNTER);
    const ms = safeInteger(entry.ms, 0, MAX_HUNT_MS);

    if ([kills, caught, shinies, thrownA, thrownB, caughtA, caughtB, ms].some((value) => value === null)) {
      throw new CommunitySnapshotError(species);
    }
    if (caught > kills || shinies > kills || caught > thrownA + thrownB) throw new CommunitySnapshotError(species);
    if (caughtA > thrownA || caughtB > thrownB || caughtA + caughtB > caught + 0.000001) {
      throw new CommunitySnapshotError(species);
    }
    if (kills === 0) continue;

    result[species] = {
      kills,
      caught,
      shinies,
      thrown_a: thrownA,
      thrown_b: thrownB,
      caught_a: caughtA,
      caught_b: caughtB,
      ms,
    };
  }

  return result;
}

function buildSubmitPayload({ appVersion, clientId, clientToken, revision, huntLog, stats }) {
  if (typeof appVersion !== 'string' || !VERSION_RE.test(appVersion)) throw new TypeError('invalid appVersion');
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) throw new TypeError('invalid clientId');
  if (typeof clientToken !== 'string' || !TOKEN_RE.test(clientToken)) throw new TypeError('invalid clientToken');
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('invalid revision');

  const normalizedStats = stats === undefined ? huntLogToStats(huntLog) : stats;
  if (!isRecord(normalizedStats)) throw new TypeError('invalid stats');

  return {
    schema_version: COMMUNITY_SCHEMA_VERSION,
    app_version: appVersion,
    client_id: clientId,
    client_token: clientToken,
    revision,
    stats: normalizedStats,
  };
}

function parseAggregate(payload, species) {
  let value = payload;
  if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'data')) value = value.data;
  if (Array.isArray(value)) value = value[0] ?? null;
  if (value == null) return null;
  if (!isRecord(value) || value.species !== species) throw new CommunityHttpError('invalid server response', 0, 'invalid_response');

  const integerFields = ['contributors', 'kills', 'caught', 'shinies', 'thrown_a', 'thrown_b', 'ms'];
  const decimalFields = ['caught_a', 'caught_b', 'catch_pct', 'catch_pct_a', 'catch_pct_b', 'kills_per_shiny'];
  const result = { species };

  for (const key of integerFields) {
    const n = Number(value[key]);
    if (!Number.isSafeInteger(n) || n < 0) throw new CommunityHttpError('invalid server response', 0, 'invalid_response');
    result[key] = n;
  }
  for (const key of decimalFields) {
    if (value[key] == null) { result[key] = null; continue; }
    const n = Number(value[key]);
    if (!Number.isFinite(n) || n < 0) throw new CommunityHttpError('invalid server response', 0, 'invalid_response');
    result[key] = n;
  }
  return result;
}

function createCommunityClient(options = {}) {
  const baseUrl = String(options.baseUrl || SUPABASE_URL).replace(/\/+$/, '');
  const publishableKey = String(options.publishableKey || SUPABASE_PUBLISHABLE_KEY);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is not available');

  const cache = new Map();
  const inFlight = new Map();
  const activeSubmitControllers = new Set();

  async function requestJson(url, init, suppliedController) {
    const controller = suppliedController || new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      const aborted = controller.signal.aborted || (error && error.name === 'AbortError');
      const code = timedOut ? 'timeout' : (aborted ? 'aborted' : 'network_error');
      const message = timedOut ? 'request timed out' : (aborted ? 'request aborted' : 'network request failed');
      throw new CommunityHttpError(message, 0, code);
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      const code = isRecord(data) && typeof data.error === 'string' ? data.error : 'http_error';
      throw new CommunityHttpError(code, response.status, code, data);
    }
    return data;
  }

  async function submitStats(input) {
    const payload = buildSubmitPayload(input);
    const controller = new AbortController();
    activeSubmitControllers.add(controller);
    try {
      const data = await requestJson(`${baseUrl}/functions/v1/submit-stats`, {
        method: 'POST',
        headers: {
          apikey: publishableKey,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      }, controller);
      if (!isRecord(data) || data.ok !== true) throw new CommunityHttpError('invalid server response', 0, 'invalid_response');
      return data;
    } finally {
      activeSubmitControllers.delete(controller);
    }
  }

  function getSpeciesStats(species) {
    if (typeof species !== 'string' || !SPECIES_RE.test(species)) return Promise.reject(new TypeError('invalid species'));
    const cached = cache.get(species);
    const time = now();
    if (cached && cached.expiresAt > time) return Promise.resolve(cached.value);
    if (cached) cache.delete(species);
    if (inFlight.has(species)) return inFlight.get(species);

    const request = requestJson(`${baseUrl}/functions/v1/species-stats?species=${encodeURIComponent(species)}`, {
      method: 'GET',
      headers: { apikey: publishableKey, accept: 'application/json' },
    }).then((payload) => {
      const value = parseAggregate(payload, species);
      cache.set(species, {
        value,
        expiresAt: now() + (value ? POSITIVE_CACHE_MS : NEGATIVE_CACHE_MS),
      });
      return value;
    }).finally(() => { inFlight.delete(species); });

    inFlight.set(species, request);
    return request;
  }

  function clearCache(species) {
    if (species === undefined) cache.clear();
    else cache.delete(species);
  }

  function abortSubmissions() {
    for (const controller of activeSubmitControllers) controller.abort();
  }

  return { submitStats, getSpeciesStats, clearCache, abortSubmissions };
}

module.exports = {
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  COMMUNITY_SCHEMA_VERSION,
  CommunityHttpError,
  CommunitySnapshotError,
  huntLogToStats,
  buildSubmitPayload,
  createCommunityClient,
};

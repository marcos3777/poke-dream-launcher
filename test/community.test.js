'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SUPABASE_PUBLISHABLE_KEY,
  COMMUNITY_PREFERENCE_VERSION,
  CommunityHttpError,
  CommunitySnapshotError,
  huntLogToStats,
  buildSubmitPayload,
  createCommunityClient,
  resolveShareStatsSetting,
} = require('../community');

const CLIENT_ID = '3f2a91c4-7b8e-4d1a-9f60-2c5e8a4b1d33';
const CLIENT_TOKEN = 'A'.repeat(43);

test('compartilhamento começa ligado e respeita desligamento após a migração', () => {
  assert.equal(resolveShareStatsSetting({}), true);
  assert.equal(resolveShareStatsSetting({ shareStats: false }), true);
  assert.equal(resolveShareStatsSetting({ communityPreferenceVersion: COMMUNITY_PREFERENCE_VERSION, shareStats: true }), true);
  assert.equal(resolveShareStatsSetting({ communityPreferenceVersion: COMMUNITY_PREFERENCE_VERSION, shareStats: false }), false);
});

test('envio manual existe somente no modo de desenvolvimento', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const config = fs.readFileSync(path.join(root, 'config.html'), 'utf8');
  assert.match(main, /ipcMain\.handle\('forceCommunitySync',[\s\S]*?if \(app\.isPackaged\) throw/);
  assert.match(preload, /forceCommunitySync: \(\) => ipcRenderer\.invoke\('forceCommunitySync'\)/);
  assert.match(config, /id="share-force" style="display:none"/);
  assert.match(config, /P\.isDev\(\)[\s\S]*?share-force/);
});

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function aggregate(species = 'MrMime') {
  return {
    species,
    contributors: '2',
    kills: '800',
    caught: '120',
    shinies: '3',
    thrown_a: '200',
    thrown_b: '600',
    caught_a: '30.25',
    caught_b: '89.75',
    ms: '900000',
    catch_pct: '15.00',
    catch_pct_a: '15.13',
    catch_pct_b: '14.96',
    kills_per_shiny: '267',
  };
}

function weightedAggregate(species = 'MrMime') {
  return {
    ...aggregate(species),
    kills: '10000.0',
    caught: '17.25',
    shinies: '0.1',
    thrown_a: '51.5',
    thrown_b: '9948.5',
    caught_a: '1.25',
    caught_b: '16.0',
    ms: '3600000.5',
    catch_pct: '0.1725',
    catch_pct_a: '2.4272',
    catch_pct_b: '0.1608',
    kills_per_shiny: '100000',
  };
}

test('huntLogToStats separa shinies encontrados de capturas e envia somente dados comunitários', () => {
  const stats = huntLogToStats({
    MrMime: {
      kills: 20,
      caught: 1,
      shinies: 3,
      thrownA: 5,
      thrownB: 15,
      caughtA: 0.25,
      caughtB: 0.75,
      ms: 12345,
      dryBalls: 99,
      dryKills: 42,
      shinyCaught: 2,
      bestiary: { kills: 46000, caught: 0 },
      pend: 1,
      updated: 123,
      streaks: [{ name: 'Conta pessoal', balls: 4 }],
    },
    Empty: { kills: 0, caught: 0, shinies: 0, thrownA: 0, thrownB: 0, caughtA: 0, caughtB: 0, ms: 1 },
  });

  assert.deepEqual(stats, {
    MrMime: {
      kills: 20,
      caught: 1,
      shinies: 3,
      thrown_a: 5,
      thrown_b: 15,
      caught_a: 0.25,
      caught_b: 0.75,
      ms: 12345,
    },
  });
  assert.equal(JSON.stringify(stats).includes('Conta pessoal'), false);
  assert.equal(JSON.stringify(stats).includes('dryBalls'), false);
  assert.equal(JSON.stringify(stats).includes('shinyCaught'), false);
  assert.equal(JSON.stringify(stats).includes('bestiary'), false);
});

test('huntLogToStats rejeita o snapshot inteiro em vez de apagar uma espécie silenciosamente', () => {
  assert.throws(() => huntLogToStats({
    MrMime: { kills: 20, caught: 1, shinies: 3, thrownA: 5, thrownB: 15, caughtA: 0.25, caughtB: 0.75, ms: 12345 },
    'nome inválido': { kills: 10 },
  }), (error) => error instanceof CommunitySnapshotError && error.species === 'nome inválido');
});

test('buildSubmitPayload inclui versões, identidade e revisão', () => {
  const payload = buildSubmitPayload({
    appVersion: '1.5.2',
    clientId: CLIENT_ID,
    clientToken: CLIENT_TOKEN,
    revision: 7,
    stats: {},
  });
  assert.deepEqual(payload, {
    schema_version: 1,
    app_version: '1.5.2',
    client_id: CLIENT_ID,
    client_token: CLIENT_TOKEN,
    revision: 7,
    stats: {},
  });
});

test('submitStats usa endpoint e headers públicos corretos', async () => {
  let call;
  const client = createCommunityClient({
    baseUrl: 'https://example.supabase.co/',
    fetchImpl: async (url, init) => {
      call = { url, init };
      return jsonResponse({ ok: true, saved: 0, revision: 1 });
    },
  });

  const result = await client.submitStats({
    appVersion: '1.5.2', clientId: CLIENT_ID, clientToken: CLIENT_TOKEN, revision: 1, stats: {},
  });
  assert.equal(result.ok, true);
  assert.equal(call.url, 'https://example.supabase.co/functions/v1/submit-stats');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.apikey, SUPABASE_PUBLISHABLE_KEY);
  assert.equal(call.init.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(call.init.body).schema_version, 1);
});

test('erros HTTP preservam status e código público', async () => {
  const client = createCommunityClient({
    fetchImpl: async () => jsonResponse({ error: 'rate_limited', retry_after_seconds: 20 }, 429),
  });
  await assert.rejects(
    client.submitStats({ appVersion: '1.5.2', clientId: CLIENT_ID, clientToken: CLIENT_TOKEN, revision: 1, stats: {} }),
    (error) => error instanceof CommunityHttpError && error.status === 429 && error.code === 'rate_limited',
  );
});

test('conflito de revisão preserva a revisão aceita pelo servidor', async () => {
  const client = createCommunityClient({
    fetchImpl: async () => jsonResponse({ error: 'revision_conflict', revision: 8 }, 409),
  });
  await assert.rejects(
    client.submitStats({ appVersion: '1.5.2', clientId: CLIENT_ID, clientToken: CLIENT_TOKEN, revision: 7, stats: {} }),
    (error) => error instanceof CommunityHttpError
      && error.status === 409
      && error.code === 'revision_conflict'
      && error.data.revision === 8,
  );
});

test('getSpeciesStats interpreta envelope, números e cache positivo', async () => {
  let calls = 0;
  const client = createCommunityClient({
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url.endsWith('/functions/v1/species-stats?species=MrMime&format=precise'), true);
      assert.equal(init.headers.apikey, SUPABASE_PUBLISHABLE_KEY);
      return jsonResponse({ data: aggregate() });
    },
  });
  const first = await client.getSpeciesStats('MrMime');
  const second = await client.getSpeciesStats('MrMime');
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(first.contributors, 2);
  assert.equal(first.caught_a, 30.25);
});

test('getSpeciesStats preserva contagens ponderadas fracionárias do servidor', async () => {
  const client = createCommunityClient({
    fetchImpl: async () => jsonResponse({ data: weightedAggregate() }),
  });
  const stats = await client.getSpeciesStats('MrMime');
  assert.equal(stats.shinies, 0.1);
  assert.equal(stats.caught, 17.25);
  assert.equal(stats.thrown_a, 51.5);
  assert.equal(stats.ms, 3600000.5);
});

test('cache negativo expira antes do positivo', async () => {
  let calls = 0;
  let clock = 1000;
  const client = createCommunityClient({
    now: () => clock,
    fetchImpl: async () => { calls++; return jsonResponse({ data: null }); },
  });
  assert.equal(await client.getSpeciesStats('Tauros'), null);
  assert.equal(await client.getSpeciesStats('Tauros'), null);
  assert.equal(calls, 1);
  clock += 5 * 60 * 1000 + 1;
  assert.equal(await client.getSpeciesStats('Tauros'), null);
  assert.equal(calls, 2);
});

test('leituras simultâneas da mesma espécie compartilham uma requisição', async () => {
  let resolveFetch;
  let calls = 0;
  const client = createCommunityClient({
    fetchImpl: () => {
      calls++;
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
  });
  const first = client.getSpeciesStats('MrMime');
  const second = client.getSpeciesStats('MrMime');
  assert.equal(first, second);
  resolveFetch(jsonResponse({ data: aggregate() }));
  assert.equal((await first).kills, 800);
  assert.equal(calls, 1);
});

test('consulta iniciada antes da limpeza não recoloca resposta antiga no cache', async () => {
  let resolveFirst;
  let calls = 0;
  const client = createCommunityClient({
    fetchImpl: () => {
      calls++;
      if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return Promise.resolve(jsonResponse({ data: aggregate('MrMime') }));
    },
  });

  const stale = client.getSpeciesStats('MrMime');
  client.clearCache();
  const fresh = client.getSpeciesStats('MrMime');
  assert.equal(calls, 2);
  resolveFirst(jsonResponse({ data: aggregate('MrMime') }));
  await stale;
  await fresh;
  await client.getSpeciesStats('MrMime');
  assert.equal(calls, 2);
});

test('timeout aborta a chamada sem vazar o erro de rede', async () => {
  const client = createCommunityClient({
    timeoutMs: 10,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  await assert.rejects(
    client.getSpeciesStats('MrMime'),
    (error) => error instanceof CommunityHttpError && error.code === 'timeout' && error.status === 0,
  );
});

test('abortSubmissions cancela um envio quando o opt-in é desligado', async () => {
  const client = createCommunityClient({
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  const pending = client.submitStats({ appVersion: '1.5.2', clientId: CLIENT_ID, clientToken: CLIENT_TOKEN, revision: 1, stats: {} });
  client.abortSubmissions();
  await assert.rejects(pending, (error) => error instanceof CommunityHttpError && error.code === 'aborted');
});

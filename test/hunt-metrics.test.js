'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { describe, describeBroke, enqueueStateUpdate, perHour, percentage, recordObservation } = require('../hunt-metrics');

test('describe calcula frequências observadas por derrotado, nunca por captura', () => {
  const metrics = describe({ kills: 800, caught: 10, shinies: 4, thrown: 900, ms: 3600000 });
  assert.equal(metrics.catchPct, 1.25);
  assert.equal(metrics.shinyPct, 0.5);
  assert.equal(metrics.encountersPerShiny, 200);
  assert.equal(metrics.perHour.shinies, 4);
});

test('percentual sem denominador é indisponível e shiny maior que capturas é válido', () => {
  assert.equal(percentage(2, 0), null);
  assert.equal(describe({ kills: 100, caught: 1, shinies: 3 }).shinyPct, 3);
});

test('ritmo por hora depende somente do intervalo observado', () => {
  assert.equal(perHour(250, 30 * 60 * 1000), 500);
  assert.equal(perHour(10, 0), null);
});

test('recordObservation acumula somente deltas vistos pelo launcher', () => {
  const entry = {};
  assert.equal(recordObservation(entry, {
    ms: 1000,
    kills: 10,
    caught: 1,
    shinies: 0,
    shinyCaught: 0,
    thrownA: 4,
    thrownB: 6,
    account: { key: 'id:test', name: 'Teste' },
    now: 100,
  }), true);

  assert.deepEqual({
    ms: entry.ms,
    kills: entry.kills,
    caught: entry.caught,
    shinies: entry.shinies,
    shinyCaught: entry.shinyCaught,
    thrownA: entry.thrownA,
    thrownB: entry.thrownB,
    caughtA: entry.caughtA,
    caughtB: entry.caughtB,
    captureDryBalls: entry.captureDryBalls,
    dryBalls: entry.dryBalls,
    dryKills: entry.dryKills,
    updated: entry.updated,
  }, {
    ms: 1000,
    kills: 10,
    caught: 1,
    shinies: 0,
    shinyCaught: 0,
    thrownA: 4,
    thrownB: 6,
    caughtA: 0.4,
    caughtB: 0.6,
    captureDryBalls: 0,
    dryBalls: 10,
    dryKills: 10,
    updated: 100,
  });
  assert.deepEqual(entry.accounts['id:test'].stats, {
    ms: 1000,
    kills: 10,
    caught: 1,
    shinies: 0,
    shinyCaught: 0,
    thrownA: 4,
    thrownB: 6,
    caughtA: 0.4,
    caughtB: 0.6,
    pend: 0,
  });
});

test('sequencias observadas reiniciam apenas com o evento correspondente', () => {
  const entry = {};
  recordObservation(entry, { kills: 7, thrownA: 3, now: 100 });
  assert.equal(entry.captureDryBalls, 3);
  assert.equal(entry.dryBalls, 3);
  assert.equal(entry.dryKills, 7);

  recordObservation(entry, { kills: 1, caught: 1, thrownB: 2, now: 200 });
  assert.equal(entry.captureDryBalls, 0);
  assert.equal(entry.dryBalls, 5);
  assert.equal(entry.dryKills, 8);

  recordObservation(entry, { kills: 1, caught: 1, shinies: 1, shinyCaught: 1, thrownB: 2, now: 300 });
  assert.equal(entry.shinyCaught, 1);
  assert.equal(entry.captureDryBalls, 0);
  assert.equal(entry.dryBalls, 0);
  assert.equal(entry.dryKills, 0);
  assert.equal(entry.updated, 300);
});

test('shiny capturado confirmado nunca excede capturas do mesmo intervalo', () => {
  const entry = {};
  recordObservation(entry, { caught: 1, shinyCaught: 3 });
  assert.equal(entry.caught, 1);
  assert.equal(entry.shinyCaught, 1);
});

test('estados atrasados são enfileirados e aplicados em ordem de versão', () => {
  const order = { version: null, pending: new Map() };
  const patch3 = { version: 3, full: false, decoded: { name: 'patch-3' } };
  const patch2 = { version: 2, full: false, decoded: { name: 'patch-2' } };
  const full1 = { version: 1, full: true, decoded: { name: 'full-1' } };

  assert.deepEqual(enqueueStateUpdate(order, patch3), []);
  assert.deepEqual(enqueueStateUpdate(order, patch2), []);
  assert.deepEqual(enqueueStateUpdate(order, full1).map((item) => item.decoded.name), [
    'full-1', 'patch-2', 'patch-3',
  ]);
  assert.equal(order.version, 3);
  assert.deepEqual(enqueueStateUpdate(order, patch2), []);
});

test('estado completo mais novo substitui uma lacuna pendente', () => {
  const order = { version: 3, pending: new Map() };
  enqueueStateUpdate(order, { version: 5, full: false, decoded: {} });
  const ready = enqueueStateUpdate(order, { version: 6, full: true, decoded: { name: 'full-6' } });
  assert.deepEqual(ready.map((item) => item.decoded.name), ['full-6']);
  assert.equal(order.version, 6);
  assert.equal(order.pending.size, 0);
});

test('lacuna perdida reinicia uma janela conservadora e limita a fila', () => {
  const order = { version: 1, pending: new Map(), maxPending: 3 };
  assert.deepEqual(enqueueStateUpdate(order, { version: 3, full: false, decoded: { name: 'patch-3' } }), []);
  assert.deepEqual(enqueueStateUpdate(order, { version: 4, full: false, decoded: { name: 'patch-4' } }), []);
  const ready = enqueueStateUpdate(order, { version: 5, full: false, decoded: { name: 'patch-5' } });
  assert.deepEqual(ready.map((item) => item.decoded.name), ['patch-3', 'patch-4', 'patch-5']);
  assert.equal(ready[0].resetBaseline, true);
  assert.equal(order.version, 5);
  assert.equal(order.pending.size, 0);
});

test('fonte da hunt não lê Bestiary, Dex nem streak pronto do jogo', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(source, /prog\.(?:bestiary|caughtSpecies|caughtShinySpecies|ballsSinceCapture)\b/);
  assert.match(source, /const HUNTLOG_V = 3;/);
  assert.match(source, /preserveLegacyHuntLog/);
});

test('captura de estado aceita baseline comprimido e rejeita versões repetidas', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /st\.patchGz \|\| st\.stateGz/);
  assert.match(source, /enqueueStateUpdate\(order/);
  assert.match(source, /if \(Array\.isArray\(prog\.wilds\)\)/);
  assert.doesNotMatch(source, /Array\.isArray\(prog\.wilds\) && prog\.wilds\.length/);
});

test('sincronização encadeia o próximo envio e Stats deduplica personagem', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /scheduleCommunitySync\(COMMUNITY_SEND_INTERVAL_MS\)/);
  assert.doesNotMatch(source, /communityTimer = setInterval/);
  assert.match(source, /ipcMain\.handle\('getStats',[\s\S]*?seenCharacters/);
});

test('broke é sequência por conta e nunca soma entre personagens', () => {
  const entry = {};
  const A = { key: 'id:aaa', name: 'thanatos' };
  const B = { key: 'id:bbb', name: 'tang1078' };
  // conta A: 10 aparições, pega -> broke 10; depois 4 aparições, pega -> broke 4
  recordObservation(entry, { shinies: 10, account: A });
  recordObservation(entry, { shinies: 0, shinyCaught: 1, caught: 1, account: A });
  recordObservation(entry, { shinies: 4, account: A });
  recordObservation(entry, { shinies: 0, shinyCaught: 1, caught: 1, account: A });
  // conta B: 30 aparições, ainda sem pegar
  recordObservation(entry, { shinies: 30, account: B });

  const d = describeBroke(entry);
  const a = d.rows.find((r) => r.key === 'id:aaa');
  const b = d.rows.find((r) => r.key === 'id:bbb');
  assert.equal(a.brokeMax, 10);
  assert.equal(a.brokeMin, 4);
  assert.equal(a.streak, 0);
  assert.equal(b.brokeMax, null);        // ainda não capturou: sem amostra
  assert.equal(b.streak, 30);            // sequência corrente
  assert.equal(d.brokeMax, 10);          // pior entre contas, não soma
  assert.equal(d.brokeMin, 4);
  assert.equal(d.streak, null);          // duas contas: sequência única não faz sentido
  assert.equal(entry.shinies, 44);       // contadores simples continuam somando
});

test('broke com uma única captura dá máximo igual ao mínimo', () => {
  const entry = {};
  const acc = { key: 'id:x', name: 'thanateta' };
  recordObservation(entry, { shinies: 36, account: acc });
  recordObservation(entry, { shinies: 0, shinyCaught: 1, caught: 1, account: acc });
  const d = describeBroke(entry);
  assert.equal(d.brokeMax, 36);
  assert.equal(d.brokeMin, 36);
  assert.equal(d.rows[0].catchPct, 1 / 36 * 100);
});

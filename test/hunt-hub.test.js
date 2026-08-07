'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const HuntMetrics = require('../hunt-metrics');

const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const start = html.indexOf('  function numVal(v)');
const end = html.indexOf('  function openHuntLog(sp)', start);
assert.ok(start >= 0 && end > start, 'bloco do hub não encontrado em app.html');

const renderHub = new Function(
  'window', 'fmtInt', 'fmtDur', 'sprStatic', 'esc', 'sprItem',
  `${html.slice(start, end)}; return huntHubHTML;`,
)(
  { HuntMetrics },
  (value) => value == null ? '—' : Number(value).toLocaleString('pt-BR'),
  (ms) => `${Math.floor(Number(ms || 0) / 60000)}m`,
  () => '',
  (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]),
  (name) => `/items/${name}.png`,
);

function community(overrides = {}) {
  return {
    contributors: 1,
    kills: 10000,
    caught: 1500,
    shinies: 20,
    thrown_a: 2000,
    thrown_b: 8000,
    caught_a: 200,
    caught_b: 1300,
    ms: 3600000,
    catch_pct: 15,
    catch_pct_a: 10,
    catch_pct_b: 16.25,
    kills_per_shiny: 500,
    ...overrides,
  };
}

test('hub usa somente o histórico observado pelo launcher', () => {
  const output = renderHub('Abra', {
    ms: 3600000,
    kills: 800,
    caught: 10,
    shinies: 12,
    shinyCaught: 3,
    thrownA: 100,
    thrownB: 700,
    caughtA: 2,
    caughtB: 8,
    bestiary: { kills: 46000, caught: 0, shinyKills: 9999 },
    community: community(),
  }, false);
  assert.match(output, /Encontros/);
  assert.match(output, /hl-shiny/);                       // shiny tem seção própria
  assert.match(output, /Capturados/);
  assert.match(output, /Broke/);
  assert.match(output, /class="hl-i"/);                   // explicação virou tooltip
  assert.match(output, /1 a cada 67 encontros/);          // 800 encontros / 12 shinies
  assert.match(output, /1 a cada 80 tentativas/);         // 800 encontros / 10 capturas
  assert.match(output, /1,50%/);
  assert.doesNotMatch(output, /derrotado/i);              // unidade antiga não volta
  assert.doesNotMatch(output, /Bolas por hora|Bolas por captura|Bolas por derrotado/);   // linhas duplicadas
  assert.match(output, /No começo, a amostra pode vir somente de uma conta/);
  assert.doesNotMatch(output, /Histórico do jogo|46\.000|9\.999|bestiário/i);
});

test('hub mantém evento comunitário fracionário visível após ponderação', () => {
  const output = renderHub('MrMime', { community: community({
    caught: 0.2,
    caught_a: 0.1,
    shinies: 0.1,
    thrown_a: 51.5,
  }) }, false);
  assert.match(output, /≈ 0,1/);
  assert.match(output, /≈ 51,5 bolas/);
  assert.match(output, /0,0010%/);
});

test('hub não transforma ausência de denominador em taxa zero', () => {
  const output = renderHub('MrMime', { kills: 100, caught: 0, thrownA: 100 }, false);
  assert.match(output, /nenhum em 100 tentativas/);   // sem captura ainda: diz isso, não "1 a cada 0"
  assert.doesNotMatch(output, /1 a cada 0 /);
});

test('hub omite ritmo por hora em amostra curta e preserva raridades extremas', () => {
  const output = renderHub('MrMime', {
    ms: 60000,
    kills: 10,
    community: community({ kills: 1000000, shinies: 0.0001, ms: 60000 }),
  }, false);
  assert.match(output, /Amostra curta para ritmos por hora/);
  assert.match(output, /&lt; 0,0001%/);
});

test('hub mantém contagem ponderada rara abaixo de um décimo', () => {
  const output = renderHub('MrMime', { community: community({ caught_a: 0.01 }) }, false);
  assert.match(output, /≈ 0,01/);
});

test('amostra comunitária não se apresenta como histórico pessoal', () => {
  const output = renderHub('MrMime', { community: community() }, false);
  assert.match(output, /Encontros <i class="hl-i"[^>]*>i<\/i><\/div><div class="n">—/);
  assert.match(output, /Amostra da comunidade/);
});

test('falha comunitária sem histórico local é explicada no estado vazio', () => {
  const output = renderHub('MrMime', { communityError: true }, false);
  assert.match(output, /amostra da comunidade não pôde ser consultada/);
});

test('falha comunitária não apaga o histórico local', () => {
  const output = renderHub('MrMime', { kills: 500, caught: 5, shinies: 2, communityError: true }, false);
  assert.match(output, /Resumo da hunt/);
  assert.match(output, /A amostra não pôde ser consultada agora/);
});

test('hunt mista explica por que não há atribuição por espécie', () => {
  const output = renderHub('MrMime', { mixedNow: 1 }, false);
  assert.match(output, /hunt mista/);
  assert.match(output, /não atribui os totais globais/);
});

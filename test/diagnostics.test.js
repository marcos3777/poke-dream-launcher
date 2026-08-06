'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = source.indexOf('const REDACT = ');
const end = source.indexOf('// ---- extrai nome / hunt', start);
assert.ok(start >= 0 && end > start, 'bloco de redação do diagnóstico não encontrado');

const diagnostics = new Function(
  `${source.slice(start, end)}; return { diagBody, diagUrl, diagWsPayload };`,
)();

test('diagnóstico oculta credenciais e personagem em respostas de identidade', () => {
  const body = diagnostics.diagBody(JSON.stringify({
    id: 'character-id',
    name: 'Personagem',
    email: 'player@example.com',
    accessToken: 'secret-token',
  }), 'https://pokedream.com.br/api/characters');
  assert.doesNotMatch(body, /character-id|Personagem|player@example\.com|secret-token/);
  assert.match(body, /<redacted>/);
});

test('diagnóstico preserva campos úteis do jogo e remove identificadores direcionados', () => {
  const body = diagnostics.diagBody(JSON.stringify({
    name: 'Abra',
    id: 63,
    characterId: 'private-character',
    bestiaryTokens: 12,
  }), 'https://pokedream.com.br/api/characters/redacted/save');
  assert.match(body, /Abra/);
  assert.match(body, /bestiaryTokens/);
  assert.doesNotMatch(body, /private-character/);
});

test('diagnóstico limpa URL e payload Socket.IO sem destruir o nome do evento', () => {
  const url = diagnostics.diagUrl('https://example.test/characters/private-id/save?token=secret');
  assert.doesNotMatch(url, /private-id|secret/);
  const ws = diagnostics.diagWsPayload('42["session",{"email":"player@example.com","token":"secret"}]');
  assert.match(ws, /session/);
  assert.doesNotMatch(ws, /player@example\.com|secret/);
});

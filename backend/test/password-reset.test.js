'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createResetCode, digestResetCode, normalizeResetCode,
  resetRecordIsActive, verifyResetCode
} = require('../password-reset');

test('gera código legível com 12 caracteres aleatórios', () => {
  let value = 0;
  const code = createResetCode((min, max) => min + (value++ % (max - min)));
  assert.match(code, /^[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){2}$/);
  assert.equal(normalizeResetCode(code).length, 12);
});
test('assina e verifica o código sem armazenar seu valor', () => {
  const digest = digestResetCode('ABCD-EFGH-JKLM', 'ADMIN001', 'segredo');
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(verifyResetCode('abcd efgh jklm', 'ADMIN001', digest, 'segredo'), true);
  assert.equal(verifyResetCode('ABCD-EFGH-JKLN', 'ADMIN001', digest, 'segredo'), false);
});
test('rejeita registros expirados ou sem tentativas', () => {
  const now = Date.parse('2026-07-30T12:00:00Z');
  const active = { digest: 'abc', attemptsRemaining: 1, expiresAt: '2026-07-30T12:30:00Z' };
  assert.equal(resetRecordIsActive(active, now), true);
  assert.equal(resetRecordIsActive({ ...active, attemptsRemaining: 0 }, now), false);
});

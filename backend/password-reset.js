'use strict';
const crypto = require('crypto');
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function normalizeGpid(value) {
  return String(value || '').trim().toUpperCase();
}
function normalizeResetCode(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}
function createResetCode(randomInt) {
  const pick = randomInt || crypto.randomInt;
  let raw = '';
  for (let index = 0; index < 12; index += 1) {
    raw += ALPHABET[pick(0, ALPHABET.length)];
  }
  return raw.match(/.{1,4}/g).join('-');
}
function digestResetCode(code, gpid, secret) {
  return crypto.createHmac('sha256', String(secret || ''))
    .update(normalizeGpid(gpid) + '\n' + normalizeResetCode(code))
    .digest('hex');
}
function verifyResetCode(code, gpid, expectedDigest, secret) {
  const actual = Buffer.from(digestResetCode(code, gpid, secret), 'hex');
  const expected = Buffer.from(String(expectedDigest || ''), 'hex');
  return expected.length === actual.length && expected.length > 0 &&
    crypto.timingSafeEqual(actual, expected);
}
function resetRecordIsActive(record, now) {
  const currentTime = now === undefined ? Date.now() : Number(now);
  return !!(record && record.digest && Number(record.attemptsRemaining) > 0 &&
    Date.parse(record.expiresAt) > currentTime);
}
module.exports = {
  createResetCode, digestResetCode, normalizeGpid, normalizeResetCode,
  resetRecordIsActive, verifyResetCode
};

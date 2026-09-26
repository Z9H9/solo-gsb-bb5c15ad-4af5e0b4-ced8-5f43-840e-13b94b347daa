'use strict';

const crypto = require('node:crypto');

const UINT32_SPACE = 0x100000000; // 2^32

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// seed: 32 random bytes, hex-encoded (64 chars). Only its SHA-256 commitment
// is published until reveal time.
function generateSeed() {
  return crypto.randomBytes(32).toString('hex');
}

// commitment = SHA-256(seed), where seed is the UTF-8 hex string.
function commitmentFor(seed) {
  return sha256Hex(seed);
}

// A participant commits to SHA-256(secret) before revealing the secret.
function secretHash(secret) {
  return sha256Hex(secret);
}

// Multi-party entropy aggregation: concatenate every participant's secret
// hash in the fixed participant order declared at draw creation. Each digest
// is a fixed-width 64 hex chars, so the concatenation is unambiguous and the
// resulting string is the nonce fed into the existing shuffle.
function aggregateNonce(secretsInParticipantOrder) {
  return secretsInParticipantOrder.map(sha256Hex).join('');
}

// Deterministic uint32 stream:
//   block(i) = SHA-256(`${seed}:${nonce}:${i}`), i = 0, 1, 2, ...
// each 32-byte block yields 8 big-endian uint32 values, consumed in order.
function createUint32Stream(seed, nonce) {
  let counter = 0;
  let block = Buffer.alloc(0);
  let offset = 0;
  return function nextUint32() {
    if (offset + 4 > block.length) {
      block = crypto.createHash('sha256').update(`${seed}:${nonce}:${counter}`, 'utf8').digest();
      counter += 1;
      offset = 0;
    }
    const value = block.readUInt32BE(offset);
    offset += 4;
    return value;
  };
}

// Unbiased uniform integer in [0, n) via rejection sampling:
// reject x >= floor(2^32 / n) * n so every residue class has equal probability.
function makeUniform(nextUint32) {
  return function uniform(n) {
    const limit = Math.floor(UINT32_SPACE / n) * n;
    for (;;) {
      const x = nextUint32();
      if (x < limit) return x % n;
    }
  };
}

// Fisher-Yates shuffle driven by the deterministic stream. The result is the
// full winning order; the first `count` entries are the winners.
function computeOrder(seed, nonce, candidates) {
  const uniform = makeUniform(createUint32Stream(seed, nonce));
  const result = candidates.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = uniform(i + 1);
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}

module.exports = {
  sha256Hex,
  generateSeed,
  commitmentFor,
  secretHash,
  aggregateNonce,
  computeOrder,
};

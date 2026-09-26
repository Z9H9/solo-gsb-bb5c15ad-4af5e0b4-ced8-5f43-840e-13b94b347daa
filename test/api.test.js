'use strict';

const crypto = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { buildApp } = require('../src/app');
const {
  PROTOCOL_VERSION,
  commitmentFor,
  commitmentV2,
  candidateSnapshotDigest,
  encodeCandidateSnapshot,
  sha256Hex,
  computeOrder,
} = require('../src/lottery');

function makeApp() {
  const db = openDatabase(':memory:');
  const app = buildApp(db, { logger: false });
  return { db, app };
}

const CANDIDATES = ['alice', 'bob', 'carol', 'dave', 'erin'];

test('create returns only the commitment, never the seed', async () => {
  const { app } = makeApp();
  const res = await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { candidates: CANDIDATES, count: 2 },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.version, 2);
  assert.match(body.commitment, /^[0-9a-f]{64}$/);
  assert.match(body.snapshotDigest, /^[0-9a-f]{64}$/);
  assert.equal(body.snapshotDigest, candidateSnapshotDigest(CANDIDATES, 2));
  assert.equal(body.seed, undefined);
  assert.equal(body.status, 'pending');

  const shown = await app.inject({ method: 'GET', url: `/draws/${body.drawId}` });
  assert.equal(shown.json().seed, undefined, 'seed must stay hidden while pending');
  assert.equal(shown.json().version, 2);
  assert.equal(shown.json().snapshotDigest, body.snapshotDigest);
});

test('reveal is single-shot and reproducible', async () => {
  const { app } = makeApp();
  const created = (await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { candidates: CANDIDATES, count: 2 },
  })).json();

  const reveal = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/reveal`,
    payload: { nonce: 'nonce-1' },
  });
  assert.equal(reveal.statusCode, 200);
  const r = reveal.json();
  assert.equal(r.version, 2);
  assert.equal(r.snapshotDigest, created.snapshotDigest);
  assert.equal(
    commitmentV2(r.seed, candidateSnapshotDigest(CANDIDATES, 2)),
    created.commitment
  );
  assert.equal(commitmentFor(r.seed) === created.commitment, false, 'v2 commitment is not the legacy SHA-256(seed)');
  assert.deepEqual(r.order, computeOrder(r.seed, r.nonce, CANDIDATES));
  assert.deepEqual(r.winners, r.order.slice(0, 2));

  const again = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/reveal`,
    payload: { nonce: 'nonce-2' },
  });
  assert.equal(again.statusCode, 409, 'second nonce submission must be rejected');
});

test('independent verify accepts honest records and flags tampering', async () => {
  const { app } = makeApp();
  const created = (await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { candidates: CANDIDATES, count: 2 },
  })).json();
  const revealed = (await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/reveal`,
    payload: { nonce: 'nonce-1' },
  })).json();

  const record = {
    version: 2,
    commitment: revealed.commitment,
    snapshotDigest: revealed.snapshotDigest,
    seed: revealed.seed,
    nonce: revealed.nonce,
    candidates: revealed.candidates,
    count: revealed.count,
    order: revealed.order,
    winners: revealed.winners,
  };
  const ok = await app.inject({ method: 'POST', url: '/verify', payload: record });
  assert.equal(ok.json().valid, true);
  assert.equal(ok.json().version, 2);
  assert.equal(ok.json().checks.snapshotDigestMatch, true);
  assert.equal(ok.json().checks.commitmentMatch, true);

  const badSeed = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: { ...record, seed: '0'.repeat(64) },
  });
  assert.equal(badSeed.json().valid, false);
  assert.ok(badSeed.json().problems.some((p) => p.includes('commitment')));

  const badOrder = { ...record, order: record.order.slice().reverse() };
  const tampered = await app.inject({ method: 'POST', url: '/verify', payload: badOrder });
  assert.equal(tampered.json().valid, false);
  assert.ok(tampered.json().problems.some((p) => p.includes('order')));

  const badNonce = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: { ...record, nonce: 'forged' },
  });
  assert.equal(badNonce.json().valid, false);
});

test('v2 verify fails when candidate order, content or count changes', async () => {
  const { app } = makeApp();
  const created = (await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { candidates: CANDIDATES, count: 2 },
  })).json();
  const revealed = (await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/reveal`,
    payload: { nonce: 'nonce-1' },
  })).json();
  const record = {
    version: 2,
    commitment: revealed.commitment,
    snapshotDigest: revealed.snapshotDigest,
    seed: revealed.seed,
    nonce: revealed.nonce,
    candidates: revealed.candidates,
    count: revealed.count,
    order: revealed.order,
    winners: revealed.winners,
  };

  // Reordered candidates: digest, commitment and order all disagree.
  const reordered = { ...record, candidates: CANDIDATES.slice().reverse() };
  const rep1 = (await app.inject({ method: 'POST', url: '/verify', payload: reordered })).json();
  assert.equal(rep1.valid, false);
  assert.equal(rep1.checks.snapshotDigestMatch, false);
  assert.equal(rep1.checks.commitmentMatch, false);
  assert.equal(rep1.checks.orderMatch, false);

  // One candidate replaced: digest and commitment mismatch.
  const replaced = { ...record, candidates: CANDIDATES.map((c) => (c === 'bob' ? 'BOB' : c)) };
  const rep2 = (await app.inject({ method: 'POST', url: '/verify', payload: replaced })).json();
  assert.equal(rep2.valid, false);
  assert.equal(rep2.checks.snapshotDigestMatch, false);
  assert.equal(rep2.checks.commitmentMatch, false);

  // count changed but candidates untouched: digest and winners mismatch.
  const changedCount = { ...record, count: 3, winners: revealed.order.slice(0, 3) };
  const rep3 = (await app.inject({ method: 'POST', url: '/verify', payload: changedCount })).json();
  assert.equal(rep3.valid, false);
  assert.equal(rep3.checks.snapshotDigestMatch, false);
  assert.equal(rep3.checks.commitmentMatch, false);

  // Forged digest that "matches" the tampered candidates: commitment still
  // cannot be opened, so consistency holds end-to-end.
  const forged = {
    ...reordered,
    snapshotDigest: candidateSnapshotDigest(reordered.candidates, record.count),
    order: undefined,
    winners: undefined,
  };
  const rep4 = (await app.inject({ method: 'POST', url: '/verify', payload: forged })).json();
  assert.equal(rep4.checks.snapshotDigestMatch, true);
  assert.equal(rep4.checks.commitmentMatch, false);
  assert.equal(rep4.valid, false);

  // Stale v1 client verifying a v2 record without version/digest: the legacy
  // algorithm must reject it rather than silently accept.
  const legacyStyle = {
    commitment: record.commitment,
    seed: record.seed,
    nonce: record.nonce,
    candidates: record.candidates,
    count: record.count,
    order: record.order,
    winners: record.winners,
  };
  const rep5 = (await app.inject({ method: 'POST', url: '/verify', payload: legacyStyle })).json();
  assert.equal(rep5.version, 1, 'missing version defaults to the legacy algorithm');
  assert.equal(rep5.valid, false);
  assert.equal(rep5.checks.commitmentMatch, false);
});

test('stored v2 verify carries version and digest', async () => {
  const { app } = makeApp();
  const created = (await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { candidates: CANDIDATES, count: 3 },
  })).json();
  assert.equal(created.version, PROTOCOL_VERSION);

  const early = await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` });
  assert.equal(early.statusCode, 409, 'cannot verify a pending draw');

  await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/reveal`,
    payload: { nonce: 'abc' },
  });
  const verified = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(verified.valid, true);
  assert.equal(verified.version, 2);
  assert.equal(verified.checks.snapshotDigestMatch, true);
});

test('snapshot encoding is length-framed over raw UTF-8 bytes', () => {
  // count decimal, one newline, then '<utf8 byte length>:<raw bytes>' each.
  const candidates = ['甲乙', 'a:1\n2', '🐟'];
  const expected = Buffer.concat([
    Buffer.from('2\n', 'utf8'),
    Buffer.from('6:甲乙', 'utf8'),
    Buffer.from('5:a:1\n2', 'utf8'),
    Buffer.from('4:🐟', 'utf8'),
  ]);
  assert.deepEqual(encodeCandidateSnapshot(candidates, 2), expected);
  assert.equal(
    candidateSnapshotDigest(candidates, 2),
    crypto.createHash('sha256').update(expected).digest('hex')
  );

  // Different order => different digest; different count => different digest.
  assert.notEqual(
    candidateSnapshotDigest(candidates, 2),
    candidateSnapshotDigest([...candidates].reverse(), 2)
  );
  assert.notEqual(
    candidateSnapshotDigest(candidates, 2),
    candidateSnapshotDigest(candidates, 1)
  );
});

test('input validation', async () => {
  const { app } = makeApp();

  const dupes = await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { candidates: ['a', 'a'], count: 1 },
  });
  assert.equal(dupes.statusCode, 400, 'duplicate candidates rejected');

  const tooMany = await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { candidates: ['a', 'b'], count: 3 },
  });
  assert.equal(tooMany.statusCode, 400, 'count > candidates rejected');

  const emptyNonce = await app.inject({
    method: 'POST',
    url: '/draws/whatever/reveal',
    payload: { nonce: '' },
  });
  assert.equal(emptyNonce.statusCode, 400);

  const missing = await app.inject({ method: 'GET', url: '/draws/nope' });
  assert.equal(missing.statusCode, 404);
});

// Insert a draw row exactly as a pre-v2 database would store it: legacy
// SHA-256(seed) commitment, protocol_version=1, no snapshot digest.
function insertLegacyDraw(db, {
  id,
  mode = 'single',
  status = 'revealed',
  seed,
  nonce = 'legacy-nonce',
  candidates = CANDIDATES,
  count = 2,
  result,
}) {
  const order = result ? result.order : computeOrder(seed, nonce, candidates);
  const winners = result ? result.winners : order.slice(0, count);
  const createdAt = '2026-01-01T00:00:00.000Z';
  const revealedAt = status === 'revealed' ? '2026-01-02T00:00:00.000Z' : null;
  db.prepare(
    `INSERT INTO draws (id, mode, status, commitment, seed, nonce, candidates,
                        draw_count, result, created_at, revealed_at,
                        protocol_version, snapshot_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`
  ).run(
    id, mode, status, commitmentFor(seed), seed,
    status === 'revealed' ? nonce : null,
    JSON.stringify(candidates), count,
    status === 'revealed' ? JSON.stringify({ order, winners }) : null,
    createdAt, revealedAt
  );
  return { order, winners };
}

test('legacy v1 database records remain queryable and verifiable', async () => {
  const { db, app } = makeApp();
  const seed = 'a'.repeat(64);
  const { order, winners } = insertLegacyDraw(db, { id: 'legacy-single', seed });

  const shown = await app.inject({ method: 'GET', url: '/draws/legacy-single' });
  assert.equal(shown.statusCode, 200);
  const view = shown.json();
  assert.equal(view.version, 1);
  assert.equal(view.snapshotDigest, undefined);
  assert.equal(view.commitment, commitmentFor(seed));
  assert.equal(view.seed, seed);
  assert.deepEqual(view.order, order);

  const stored = await app.inject({ method: 'GET', url: '/draws/legacy-single/verify' });
  assert.equal(stored.statusCode, 200);
  assert.equal(stored.json().valid, true);
  assert.equal(stored.json().version, 1);
  assert.equal(stored.json().checks.commitmentMatch, true);
  assert.equal(stored.json().checks.snapshotDigestMatch, undefined);
  assert.deepEqual(stored.json().expected.order, order);
  assert.deepEqual(stored.json().expected.winners, winners);

  // Independent verification with the default (omitted) version uses the
  // legacy SHA-256(seed) algorithm and accepts the honest record.
  const independent = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: {
      commitment: commitmentFor(seed),
      seed,
      nonce: 'legacy-nonce',
      candidates: CANDIDATES,
      count: 2,
      order,
      winners,
    },
  });
  assert.equal(independent.json().valid, true);
  assert.equal(independent.json().version, 1);
});

test('legacy v1 verification still flags a tampered seed', async () => {
  const { app } = makeApp();
  const bad = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: {
      commitment: commitmentFor('a'.repeat(64)),
      seed: 'b'.repeat(64),
      nonce: 'n',
      candidates: CANDIDATES,
      count: 1,
    },
  });
  assert.equal(bad.json().valid, false);
  assert.equal(bad.json().version, 1);
  assert.equal(bad.json().checks.commitmentMatch, false);
});

test('shuffle is unbiased (rejection sampling sanity)', () => {  const trials = 120000;
  const first = new Map();
  for (let k = 0; k < trials; k += 1) {
    const order = computeOrder('f'.repeat(64), `n-${k}`, ['x', 'y', 'z']);
    first.set(order[0], (first.get(order[0]) || 0) + 1);
  }
  for (const name of ['x', 'y', 'z']) {
    const p = first.get(name) / trials;
    assert.ok(Math.abs(p - 1 / 3) < 0.01, `${name} first-place probability ${p} within 1% of 1/3`);
  }
});

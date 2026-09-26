'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { buildApp } = require('../src/app');
const {
  sha256Hex,
  commitmentFor,
  commitmentV2,
  candidateSnapshotDigest,
  secretHash,
  aggregateNonce,
  computeOrder,
} = require('../src/lottery');

function makeApp() {
  const db = openDatabase(':memory:');
  const app = buildApp(db, { logger: false });
  return { db, app };
}

const CANDIDATES = ['alice', 'bob', 'carol', 'dave', 'erin'];
const NAMES = ['alice', 'bob', 'carol'];
const SECRETS = {
  alice: 'alice-secret-entropy-01',
  bob: 'bob-secret-entropy-02',
  carol: 'carol-secret-entropy-03',
};

async function createMultiparty(app, participants = NAMES) {
  const res = await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { candidates: CANDIDATES, count: 2, participants },
  });
  assert.equal(res.statusCode, 201);
  return res.json();
}

async function commit(app, drawId, name, secret = SECRETS[name]) {
  return app.inject({
    method: 'POST',
    url: `/draws/${drawId}/participants/${name}/commitment`,
    payload: { commitment: secretHash(secret) },
  });
}

async function revealSecret(app, drawId, name, secret = SECRETS[name]) {
  return app.inject({
    method: 'POST',
    url: `/draws/${drawId}/participants/${name}/reveal`,
    payload: { secret },
  });
}

test('create with participants fixes the participant order and starts in commitment phase', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app);
  assert.equal(created.mode, 'multiparty');
  assert.equal(created.status, 'pending');
  assert.equal(created.version, 2);
  assert.equal(created.snapshotDigest, candidateSnapshotDigest(CANDIDATES, 2));
  assert.deepEqual(
    created.participants.map((p) => p.name),
    NAMES
  );
  assert.deepEqual(
    created.participants.map((p) => p.position),
    [0, 1, 2]
  );
  assert.ok(created.participants.every((p) => p.status === 'pending'));

  const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
  assert.equal(shown.mode, 'multiparty');
  assert.equal(shown.version, 2);
  assert.equal(shown.snapshotDigest, created.snapshotDigest);
  assert.equal(shown.committedCount, 0);
  assert.equal(shown.revealedCount, 0);
  // No commitment values or secrets are exposed before they are submitted.
  assert.ok(shown.participants.every((p) => p.commitment === null));
  assert.equal(shown.nonce, undefined);
});

test('full multi-party flow aggregates secret hashes in fixed order', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app);

  // Commitments can land in arbitrary order (here reversed).
  const c3 = await commit(app, created.drawId, 'carol');
  assert.equal(c3.statusCode, 201);
  assert.equal(c3.json().status, 'committed', 'first commitment opens the committed phase');
  assert.equal(c3.json().committedCount, 1);
  await commit(app, created.drawId, 'alice');
  await commit(app, created.drawId, 'bob');

  // Reveals can also be in arbitrary order; the last one finalizes.
  const r2 = await revealSecret(app, created.drawId, 'bob');
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().status, 'committed', 'draw is not finalized until everyone reveals');
  assert.equal(r2.json().revealedCount, 1);
  const r3 = await revealSecret(app, created.drawId, 'carol');
  assert.equal(r3.statusCode, 200);
  assert.equal(r3.json().status, 'committed');
  const r1 = await revealSecret(app, created.drawId, 'alice');
  assert.equal(r1.statusCode, 200, 'last reveal finalizes the draw');

  const final = r1.json();
  assert.equal(final.status, 'revealed');
  assert.equal(final.version, 2);
  assert.equal(final.snapshotDigest, created.snapshotDigest);
  assert.equal(
    commitmentV2(final.seed, candidateSnapshotDigest(CANDIDATES, 2)),
    created.commitment
  );
  assert.notEqual(commitmentFor(final.seed), created.commitment, 'v2 commitment differs from legacy SHA-256(seed)');

  // nonce = concat of SHA-256(secret) in the declared participant order.
  const expectedNonce = aggregateNonce(NAMES.map((n) => SECRETS[n]));
  assert.equal(final.nonce, expectedNonce);
  assert.equal(
    final.nonce,
    NAMES.map((n) => sha256Hex(SECRETS[n])).join('')
  );

  // The existing shuffle is reused verbatim.
  assert.deepEqual(final.order, computeOrder(final.seed, expectedNonce, CANDIDATES));
  assert.deepEqual(final.winners, final.order.slice(0, 2));

  // Auditable contribution list: positions, commitments, secrets and hashes.
  assert.equal(final.contributions.length, 3);
  assert.deepEqual(final.contributions.map((c) => c.position), [0, 1, 2]);
  assert.deepEqual(final.contributions.map((c) => c.name), NAMES);
  for (const c of final.contributions) {
    assert.equal(secretHash(c.secret), c.commitment, 'secret opens commitment');
    assert.equal(c.secretHash, secretHash(c.secret));
  }
});

test('rejects duplicate commitments and duplicate reveals', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app);
  await commit(app, created.drawId, 'alice');

  const dupCommit = await commit(app, created.drawId, 'alice');
  assert.equal(dupCommit.statusCode, 409, 'duplicate commitment rejected');

  await commit(app, created.drawId, 'bob');
  await commit(app, created.drawId, 'carol');
  await revealSecret(app, created.drawId, 'alice');
  const dupReveal = await revealSecret(app, created.drawId, 'alice');
  assert.equal(dupReveal.statusCode, 409, 'duplicate reveal rejected');
});

test('rejects out-of-order operations', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app);
  await commit(app, created.drawId, 'alice');

  // Cannot reveal while some participants still owe a commitment.
  const early = await revealSecret(app, created.drawId, 'alice');
  assert.equal(early.statusCode, 409, 'reveal before all commitments rejected');
  assert.deepEqual(early.json().waitingFor.sort(), ['bob', 'carol']);

  await commit(app, created.drawId, 'bob');
  await commit(app, created.drawId, 'carol');

  // bob never committed to anything... it did; but carol's secret mismatch
  const wrong = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/participants/carol/reveal`,
    payload: { secret: 'not-the-committed-secret' },
  });
  assert.equal(wrong.statusCode, 409, 'secret not matching commitment rejected');

  // Unknown participant names are rejected.
  const strangerCommit = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/participants/mallory/commitment`,
    payload: { commitment: secretHash('x') },
  });
  assert.equal(strangerCommit.statusCode, 400);
  const strangerReveal = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/participants/mallory/reveal`,
    payload: { secret: 'x' },
  });
  assert.equal(strangerReveal.statusCode, 400);

  // Phase is still the reveal phase; normal reveals now finalize.
  const r = await revealSecret(app, created.drawId, 'carol');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'committed');
});

test('commitments rejected after the draw is finalized', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app);
  for (const n of NAMES) await commit(app, created.drawId, n);
  for (const n of NAMES) await revealSecret(app, created.drawId, n);

  const lateCommit = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/participants/alice/commitment`,
    payload: { commitment: secretHash('whatever') },
  });
  assert.equal(lateCommit.statusCode, 409);

  const lateReveal = await revealSecret(app, created.drawId, 'alice');
  assert.equal(lateReveal.statusCode, 409, 'post-finalization reveals return the final state');
  assert.equal(lateReveal.json().draw.status, 'revealed');
});

test('single-nonce and multi-party endpoints cannot be mixed', async () => {
  const { app } = makeApp();

  const multi = await createMultiparty(app);
  const singleOnMulti = await app.inject({
    method: 'POST',
    url: `/draws/${multi.drawId}/reveal`,
    payload: { nonce: 'nope' },
  });
  assert.equal(singleOnMulti.statusCode, 409);

  const single = (await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { candidates: CANDIDATES, count: 1 },
  })).json();
  assert.equal(single.mode, 'single');
  const multiOnSingle = await commit(app, single.drawId, 'alice');
  assert.equal(multiOnSingle.statusCode, 409);
});

test('stored verify checks the multi-party contribution trail', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app);
  for (const n of NAMES) await commit(app, created.drawId, n);
  for (const n of NAMES) await revealSecret(app, created.drawId, n);

  const report = (await app.inject({
    method: 'GET',
    url: `/draws/${created.drawId}/verify`,
  })).json();
  assert.equal(report.mode, 'multiparty');
  assert.equal(report.valid, true);
  assert.equal(report.version, 2);
  assert.equal(report.checks.snapshotDigestMatch, true);
  assert.equal(report.checks.commitmentsOpen, true);
  assert.equal(report.checks.nonceDerived, true);
  assert.equal(report.checks.positionsComplete, true);
  assert.equal(report.checks.orderMatch, true);
});

test('independent verify flags tampered multi-party contributions', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app);
  for (const n of NAMES) await commit(app, created.drawId, n);
  await revealSecret(app, created.drawId, 'alice', SECRETS.alice);
  await revealSecret(app, created.drawId, 'bob', SECRETS.bob);
  const last = await revealSecret(app, created.drawId, 'carol', SECRETS.carol);
  const final = last.json();
  assert.equal(final.status, 'revealed');

  const base = {
    version: 2,
    commitment: final.commitment,
    snapshotDigest: final.snapshotDigest,
    seed: final.seed,
    nonce: final.nonce,
    candidates: CANDIDATES,
    count: 2,
    order: final.order,
    winners: final.winners,
    contributions: final.contributions,
  };

  // Reordering the candidate snapshot breaks the v2 commitment.
  const reorderedCandidates = {
    ...base,
    candidates: CANDIDATES.slice().reverse(),
    order: undefined,
    winners: undefined,
  };
  const rep0 = (await app.inject({ method: 'POST', url: '/verify', payload: reorderedCandidates })).json();
  assert.equal(rep0.valid, false);
  assert.equal(rep0.checks.snapshotDigestMatch, false);
  assert.equal(rep0.checks.commitmentMatch, false);
  // Contributions alone still open correctly; the failure is the snapshot, not the entropy trail.
  assert.equal(rep0.checks.commitmentsOpen, true);
  assert.equal(rep0.checks.nonceDerived, true);

  // Tamper one secret but keep the commitment: commitmentsOpen fails.
  const tamperedSecret = {
    ...base,
    contributions: base.contributions.map((c) =>
      c.name === 'bob' ? { ...c, secret: 'forged' } : c
    ),
  };
  const rep1 = (await app.inject({ method: 'POST', url: '/verify', payload: tamperedSecret })).json();
  assert.equal(rep1.valid, false);
  assert.equal(rep1.checks.commitmentsOpen, false);

  // Reorder contributions (swap positions) but keep pairs consistent:
  // positionsComplete and nonceDerived fail.
  const reordered = {
    ...base,
    contributions: base.contributions.map((c) => {
      if (c.name === 'alice') return { ...c, position: 1 };
      if (c.name === 'bob') return { ...c, position: 0 };
      return c;
    }),
  };
  const rep2 = (await app.inject({ method: 'POST', url: '/verify', payload: reordered })).json();
  assert.equal(rep2.valid, false);
  assert.equal(rep2.checks.nonceDerived, false);

  // Honest record: everything passes, including order recomputation.
  const ok = (await app.inject({ method: 'POST', url: '/verify', payload: base })).json();
  assert.equal(ok.valid, true);
  assert.equal(ok.checks.commitmentsOpen, true);
  assert.equal(ok.checks.nonceDerived, true);
  assert.equal(ok.checks.orderMatch, true);
  assert.equal(ok.checks.snapshotDigestMatch, true);
});

// A multi-party draw row created before v2: legacy SHA-256(seed) commitment,
// no snapshot digest. It must stay queryable and verify with the old algorithm.
test('legacy v1 multi-party records remain queryable and verifiable', async () => {
  const { db, app } = makeApp();
  const seed = 'c'.repeat(64);
  const nonce = aggregateNonce(NAMES.map((n) => SECRETS[n]));
  const order = computeOrder(seed, nonce, CANDIDATES);
  const winners = order.slice(0, 2);
  const createdAt = '2026-01-01T00:00:00.000Z';
  const revealedAt = '2026-01-02T00:00:00.000Z';
  db.prepare(
    `INSERT INTO draws (id, mode, status, commitment, seed, nonce, candidates,
                        draw_count, result, created_at, revealed_at,
                        protocol_version, snapshot_digest)
     VALUES (?, 'multiparty', 'revealed', ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`
  ).run(
    'legacy-multi', commitmentFor(seed), seed, nonce,
    JSON.stringify(CANDIDATES), 2,
    JSON.stringify({ order, winners }), createdAt, revealedAt
  );
  const insertParticipant = db.prepare(
    `INSERT INTO participants (draw_id, position, name, commitment, secret,
                               committed_at, revealed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  NAMES.forEach((name, position) => {
    insertParticipant.run(
      'legacy-multi', position, name,
      secretHash(SECRETS[name]), SECRETS[name], createdAt, revealedAt
    );
  });

  const shown = await app.inject({ method: 'GET', url: '/draws/legacy-multi' });
  assert.equal(shown.statusCode, 200);
  assert.equal(shown.json().version, 1);
  assert.equal(shown.json().snapshotDigest, undefined);
  assert.equal(shown.json().commitment, commitmentFor(seed));

  const stored = await app.inject({ method: 'GET', url: '/draws/legacy-multi/verify' });
  assert.equal(stored.statusCode, 200);
  const report = stored.json();
  assert.equal(report.version, 1);
  assert.equal(report.valid, true);
  assert.equal(report.checks.commitmentMatch, true);
  assert.equal(report.checks.commitmentsOpen, true);
  assert.equal(report.checks.nonceDerived, true);
  assert.equal(report.checks.orderMatch, true);
  assert.equal(report.checks.snapshotDigestMatch, undefined);

  const independent = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: {
      commitment: commitmentFor(seed),
      seed,
      nonce,
      candidates: CANDIDATES,
      count: 2,
      order,
      winners,
      contributions: NAMES.map((name, position) => ({
        name,
        position,
        commitment: secretHash(SECRETS[name]),
        secret: SECRETS[name],
      })),
    },
  });
  assert.equal(independent.json().valid, true);
  assert.equal(independent.json().version, 1);
});

test('participant list validation at creation', async () => {
  const { app } = makeApp();

  const dupes = await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { candidates: CANDIDATES, count: 1, participants: ['a', 'a'] },
  });
  assert.equal(dupes.statusCode, 400, 'duplicate participants rejected');

  const solo = await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { candidates: CANDIDATES, count: 1, participants: ['alone'] },
  });
  assert.equal(solo.statusCode, 400, 'a multi-party draw needs at least 2 participants');

  const badCommitment = await app.inject({
    method: 'POST',
    url: '/draws/x/participants/alice/commitment',
    payload: { commitment: 'not-a-sha256-hex' },
  });
  assert.equal(badCommitment.statusCode, 400);
});

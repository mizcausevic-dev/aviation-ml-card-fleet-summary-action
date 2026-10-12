'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkAviation, checkMro, inspectFiles } = require('../dist/index.cjs');

const syntheticUri = 'https://example.invalid/synthetic-evidence';
const aviation = () => ({
  aviation_ml_card_version: '0.1',
  assurance: { easa_ai_level: '2B' },
  human_ai_teaming: { human_override_available: true, override_procedure_ref: syntheticUri },
  odd: { operating_conditions: ['synthetic-day'], condition_evidence: [{ condition: 'synthetic-day', evidence_refs: [syntheticUri] }] }
});
const mro = () => ({
  mro_signoff_card_version: '0.1',
  artifact: { sha256: 'a'.repeat(64) },
  human_review: { staff_id: 'synthetic-staff', authority_ref: syntheticUri, reviewed_at: '2026-10-12T00:00:00Z', decision: 'accept' },
  signature: { profile: 'JCS-SHA256-Ed25519-v1', key_id: syntheticUri, signed_at: '2026-10-12T00:00:00Z', signature_b64url: 'A'.repeat(86) }
});

test('accepts structurally complete synthetic declarations without claiming verification', () => {
  assert.deepEqual(checkAviation(aviation()), []);
  assert.deepEqual(checkMro(mro()), []);
});

test('rejects card versions outside the published draft contracts', () => {
  const aviationCard = aviation();
  aviationCard.aviation_ml_card_version = '0.1.0';
  assert.match(checkAviation(aviationCard).join(' '), /must be 0\.1/);
  const mroCard = mro();
  mroCard.mro_signoff_card_version = '0.1.0';
  assert.match(checkMro(mroCard).join(' '), /must be 0\.1/);
});

test('rejects reserved level and missing conservative override fields', () => {
  const card = aviation();
  card.assurance.easa_ai_level = '3B';
  assert.match(checkAviation(card).join(' '), /3B/);
  card.assurance.easa_ai_level = '2B';
  card.human_ai_teaming.human_override_available = false;
  assert.match(checkAviation(card).join(' '), /override/);
});

test('rejects ODD reference gaps and invalid or duplicate mappings', () => {
  const card = aviation();
  card.odd.operating_conditions.push('synthetic-night');
  assert.match(checkAviation(card).join(' '), /no evidence mapping/);
  card.odd.condition_evidence.push({ condition: 'synthetic-night', evidence_refs: [] });
  assert.match(checkAviation(card).join(' '), /lacks HTTPS/);
  card.odd.condition_evidence[1].evidence_refs = ['http://example.invalid/unsafe'];
  assert.match(checkAviation(card).join(' '), /lacks HTTPS/);
});

test('rejects missing sign-off and missing override reason', () => {
  const card = mro();
  delete card.signature;
  assert.match(checkMro(card).join(' '), /signature/);
  card.signature = mro().signature;
  card.human_review.decision = 'override';
  assert.match(checkMro(card).join(' '), /override_reason/);
});

test('rejects unsafe authority pointers and time-order violations', () => {
  const card = mro();
  card.human_review.authority_ref = 'http://example.invalid/authority';
  assert.match(checkMro(card).join(' '), /HTTPS authority_ref/);
  card.human_review.authority_ref = syntheticUri;
  card.signature.signed_at = '2026-10-11T23:59:59Z';
  assert.match(checkMro(card).join(' '), /must not precede/);
  card.signature.signed_at = '2026-02-30T00:00:00Z';
  assert.match(checkMro(card).join(' '), /UTC signed_at/);
  card.signature.signed_at = '2026-10-12T00:00:00Z';
  card.human_review.override_reason = 'not an override';
  assert.match(checkMro(card).join(' '), /only for an override/);
});

test('rejects missing inputs, traversal, and malformed files without exposing contents', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-action-test-'));
  try {
    fs.writeFileSync(path.join(workspace, 'good.json'), JSON.stringify(aviation()));
    fs.writeFileSync(path.join(workspace, 'bad.json'), '{secret-placeholder:');
    fs.writeFileSync(path.join(workspace, 'duplicate.json'), '{"aviation_ml_card_version":"0.1","aviation_ml_card_version":"0.1"}');
    fs.writeFileSync(path.join(workspace, 'unsafe-number.json'), '{"aviation_ml_card_version":"0.1","number":9007199254740993}');
    fs.writeFileSync(path.join(workspace, 'exponent.json'), JSON.stringify(aviation()).replace(/}\s*$/, ',"number":1E30}'));
    assert.deepEqual(inspectFiles(workspace, ['good.json'], []), []);
    assert.match(inspectFiles(workspace, [], [])[0].error, /at least one/);
    assert.match(inspectFiles(workspace, ['../outside.json'], [])[0].error, /cannot inspect card/);
    const findings = inspectFiles(workspace, ['bad.json'], []);
    assert.match(findings[0].error, /cannot inspect card/);
    assert.doesNotMatch(findings[0].error, /secret-placeholder/);
    assert.match(inspectFiles(workspace, ['duplicate.json'], [])[0].error, /cannot inspect card/);
    assert.match(inspectFiles(workspace, ['unsafe-number.json'], [])[0].error, /cannot inspect card/);
    assert.deepEqual(inspectFiles(workspace, ['exponent.json'], []), []);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('escapes untrusted card paths in CI logs and job summary', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-action-output-test-'));
  const summary = path.join(workspace, 'summary.md');
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../dist/index.cjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_WORKSPACE: workspace,
        GITHUB_STEP_SUMMARY: summary,
        INPUT_AVIATION_CARDS: 'missing[evil](https://example.invalid)\u001b[31m.json'
      }
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /\u001b/);
    assert.doesNotMatch(fs.readFileSync(summary, 'utf8'), /\[evil\]\(https:/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

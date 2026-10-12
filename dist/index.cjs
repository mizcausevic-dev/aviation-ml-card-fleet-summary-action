'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseJcsJsonStrict } = require('./strict-json.cjs');

const MAX_FILES = 500;
const MAX_CARD_BYTES = 1024 * 1024;
const LEVELS = new Set(['1A', '1B', '2A', '2B', '3A']);
const SIG_PROFILE = 'JCS-SHA256-Ed25519-v1';

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function httpsUri(value) {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

function utcTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  return epoch;
}

function checkAviation(card) {
  const errors = [];
  if (!object(card) || card.aviation_ml_card_version !== '0.1') return ['aviation_ml_card_version must be 0.1'];
  const level = card.assurance?.easa_ai_level;
  if (!LEVELS.has(level)) errors.push('assurance.easa_ai_level must be one of 1A, 1B, 2A, 2B, 3A; 3B is outside this profile');
  if (level === '2B' || level === '3A') {
    if (card.human_ai_teaming?.human_override_available !== true || !httpsUri(card.human_ai_teaming?.override_procedure_ref)) {
      errors.push('Suite conservative profile requires human_override_available=true and HTTPS override_procedure_ref for level 2B/3A');
    }
  }
  const odd = card.odd;
  if (!object(odd) || !Array.isArray(odd.operating_conditions) || odd.operating_conditions.length === 0) {
    errors.push('odd.operating_conditions must name at least one declared condition');
    return errors;
  }
  if (!Array.isArray(odd.condition_evidence)) {
    errors.push('odd.condition_evidence must map each declared condition to evidence references');
    return errors;
  }
  const conditions = new Set();
  for (const condition of odd.operating_conditions) {
    if (!text(condition) || conditions.has(condition)) errors.push('odd.operating_conditions has an empty or duplicate condition');
    else conditions.add(condition);
  }
  const mapped = new Set();
  for (const [index, row] of odd.condition_evidence.entries()) {
    if (!object(row) || !text(row.condition) || !conditions.has(row.condition) || mapped.has(row.condition)) {
      errors.push('odd.condition_evidence has an unknown, duplicate, or empty condition');
      continue;
    }
    mapped.add(row.condition);
    if (!Array.isArray(row.evidence_refs) || row.evidence_refs.length === 0 || !row.evidence_refs.every(httpsUri)) {
      errors.push(`ODD evidence mapping ${index + 1} lacks HTTPS coverage evidence references`);
    }
  }
  for (const condition of conditions) {
    if (!mapped.has(condition)) errors.push('a declared ODD condition has no evidence mapping');
  }
  return errors;
}

function checkMro(card) {
  const errors = [];
  if (!object(card) || card.mro_signoff_card_version !== '0.1') return ['mro_signoff_card_version must be 0.1'];
  if (!/^[a-f0-9]{64}$/.test(card.artifact?.sha256 ?? '')) errors.push('artifact.sha256 must be a 64-character lowercase SHA-256 digest');
  const review = card.human_review;
  if (!object(review) || !text(review.staff_id) || !httpsUri(review.authority_ref) || utcTimestamp(review.reviewed_at) === null || !['accept', 'override', 'reject'].includes(review.decision)) {
    errors.push('human_review must include staff_id, HTTPS authority_ref, UTC reviewed_at, and a valid decision');
  } else {
    if (review.decision === 'override' && !text(review.override_reason)) errors.push('override decision requires human_review.override_reason');
    if (review.decision !== 'override' && review.override_reason !== undefined) errors.push('override_reason is permitted only for an override decision');
  }
  const signature = card.signature;
  if (!object(signature) || signature.profile !== SIG_PROFILE || !text(signature.key_id) || utcTimestamp(signature.signed_at) === null || !text(signature.signature_b64url)) {
    errors.push('signature must include profile, key_id, UTC signed_at, and signature_b64url');
  } else if (!/^[A-Za-z0-9_-]{86}$/.test(signature.signature_b64url) || Buffer.from(signature.signature_b64url, 'base64url').toString('base64url') !== signature.signature_b64url) {
    errors.push('signature.signature_b64url must encode a 64-byte Ed25519 signature without padding');
  }
  if (object(review) && object(signature) && utcTimestamp(review.reviewed_at) !== null && utcTimestamp(signature.signed_at) !== null && utcTimestamp(signature.signed_at) < utcTimestamp(review.reviewed_at)) {
    errors.push('signature.signed_at must not precede human_review.reviewed_at');
  }
  return errors;
}

function parsePaths(raw) {
  return (raw ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

function readCard(workspace, candidate) {
  if (path.isAbsolute(candidate) || candidate.split(/[\\/]/).includes('..')) throw new Error('card path must be workspace-relative without parent traversal');
  const root = fs.realpathSync(workspace);
  const file = fs.realpathSync(path.resolve(root, candidate));
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('card path is outside workspace');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_CARD_BYTES) throw new Error('card must be a regular JSON file of at most 1 MiB');
  return parseJcsJsonStrict(fs.readFileSync(file));
}

function inspectFiles(workspace, aviationPaths, mroPaths) {
  const entries = [...aviationPaths.map(file => ({ file, type: 'aviation' })), ...mroPaths.map(file => ({ file, type: 'mro' }))];
  if (entries.length === 0) return [{ file: '(inputs)', error: 'provide at least one aviation_cards or mro_cards path' }];
  if (entries.length > MAX_FILES) return [{ file: '(inputs)', error: 'at most 500 cards may be checked per invocation' }];
  const findings = [];
  for (const entry of entries) {
    try {
      const card = readCard(workspace, entry.file);
      const errors = entry.type === 'aviation' ? checkAviation(card) : checkMro(card);
      for (const error of errors) findings.push({ file: entry.file, error });
    } catch {
      findings.push({ file: entry.file, error: 'cannot inspect card (missing, unsafe, over limit, or invalid JSON)' });
    }
  }
  return findings;
}

function safeOutput(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 300);
}

function safeMarkdown(value) {
  return safeOutput(value).replace(/[\\|`*_\[\]!<>]/g, '\\$&').replace(/&/g, '&amp;');
}

function main() {
  const aviation = parsePaths(process.env.INPUT_AVIATION_CARDS);
  const mro = parsePaths(process.env.INPUT_MRO_CARDS);
  const findings = inspectFiles(process.env.GITHUB_WORKSPACE || process.cwd(), aviation, mro);
  const lines = ['## Aviation card fleet summary', '', `Checked ${aviation.length} aviation and ${mro.length} MRO card path(s).`, ''];
  if (findings.length) {
    lines.push('| File | Gate finding |', '| --- | --- |');
    for (const finding of findings) {
      lines.push(`| ${safeMarkdown(finding.file)} | ${safeMarkdown(finding.error)} |`);
      console.error(`FAIL ${safeOutput(finding.file)}: ${safeOutput(finding.error)}`);
    }
    process.exitCode = 1;
  } else {
    lines.push('Declared-field gate passed. Evidence URLs, signer identity, cryptographic validity, staff authority, and airworthiness were not verified.');
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  if (!findings.length) console.log(lines.at(-1));
}

if (require.main === module) main();
module.exports = { checkAviation, checkMro, inspectFiles, parsePaths };

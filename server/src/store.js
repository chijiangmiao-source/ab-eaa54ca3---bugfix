'use strict';

const crypto = require('crypto');
const { createEngine, ProofError, parseTermString } = require('./engine');

const MAX_STEPS = 180;
const AUDIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

// --- payload canonicalization ----------------------------------------------
//
// The frozen-record identity is (auditId, SHA-256(canonical payload)).  The
// canonical form must track *execution semantics*, not JSON surface shape:
//
//   * steps stay IN ORDER — moving a push/pop/eq/neq/claim relative to the
//     others is a different proof (e.g. claiming f(a)=f(b) before declaring
//     a=b must not replay the old "pass" verdict);
//   * finite constants are an unordered set, functions an unordered map;
//   * object key writing order is irrelevant;
//   * term strings are parsed and re-rendered, so whitespace that does not
//     change the parsed term does not change the hash;
//   * scope labels follow the engine's own String() coercion semantics.
//
// Anything that changes engine behavior (label text, arity, term content, any
// step's position or fields) necessarily produces a different hash.

function renderCanonical(term) {
  if (term.kind === 'const') return term.name;
  return `${term.fn}(${term.args.map(renderCanonical).join(',')})`;
}

// Whitespace-insensitive while remaining sensitive to term content.  Inputs
// the parser rejects keep their (outer-trimmed) raw text; the engine later
// rejects them at the responsible step.
function canonicalTerm(input) {
  if (typeof input !== 'string') return normalizeGeneric(input);
  try {
    return renderCanonical(parseTermString(input));
  } catch {
    return input.trim();
  }
}

function normalizeGeneric(value) {
  if (Array.isArray(value)) return value.map(normalizeGeneric);
  if (value && typeof value === 'object') {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeGeneric(value[key]);
    }
    return normalized;
  }
  return value;
}

function normalizeStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    return normalizeGeneric(step);
  }
  const normalized = {};
  for (const key of Object.keys(step).sort()) {
    const value = step[key];
    if (key === 'left' || key === 'right') {
      normalized[key] = canonicalTerm(value);
    } else if (key === 'label') {
      // Mirror the engine: absent label -> unnamed scope, anything else -> String().
      if (value !== undefined) normalized[key] = String(value);
    } else {
      normalized[key] = normalizeGeneric(value);
    }
  }
  return normalized;
}

// Steps are an ordered trace: never sort this array.
function normalizeSteps(steps) {
  return Array.isArray(steps) ? steps.map(normalizeStep) : normalizeGeneric(steps);
}

// Finite constants are an unordered declaration set.
function normalizeConstants(constants) {
  if (!Array.isArray(constants)) return normalizeGeneric(constants);
  return constants
    .map((c) => (typeof c === 'string' ? c : normalizeGeneric(c)))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

// Function declarations are an unordered name -> arity map.
function normalizeFunctions(functions) {
  if (!functions || typeof functions !== 'object' || Array.isArray(functions)) {
    return normalizeGeneric(functions);
  }
  const normalized = {};
  for (const name of Object.keys(functions).sort()) {
    normalized[name] = normalizeGeneric(functions[name]);
  }
  return normalized;
}

function normalizePayload(payload) {
  return {
    constants: normalizeConstants(payload.constants),
    functions: normalizeFunctions(payload.functions),
    steps: normalizeSteps(payload.steps),
  };
}

function hashPayload(payload) {
  const normalized = normalizePayload(payload);
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

class AuditStore {
  constructor() {
    this.sessions = new Map(); // auditId -> frozen record
  }

  static get MAX_STEPS() {
    return MAX_STEPS;
  }

  // Validate the envelope, run the proof trace, freeze the verdict keyed by
  // (auditId, payloadHash).  Identical replays return the frozen record; a
  // retransmission carrying a different payload is rejected outright.
  submit(raw) {
    const validationError = validateEnvelope(raw);
    if (validationError) {
      const record = frozenRejection(raw && raw.auditId, null, validationError, 0);
      return { status: 200, body: record };
    }

    const auditId = raw.auditId;
    const payload = {
      constants: raw.constants,
      functions: raw.functions,
      steps: raw.steps,
    };
    const payloadHash = hashPayload(payload);

    const existing = this.sessions.get(auditId);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        return {
          status: 409,
          body: {
            error: 'PAYLOAD_CHANGED',
            message: `审计标识 ${auditId} 已冻结：同标识重传必须携带完全相同的载荷，改换载荷明确拒绝`,
            auditId,
            frozenPayloadHash: existing.payloadHash,
            receivedPayloadHash: payloadHash,
          },
        };
      }
      return { status: 200, body: { ...existing.record, replayed: true } };
    }

    let engine;
    try {
      engine = createEngine({ constants: payload.constants, functions: payload.functions });
    } catch (err) {
      return this._freeze(auditId, payloadHash, payload, {
        code: err.code || 'BAD_TERM',
        message: err.message,
        index: -1,
        detail: err.detail || null,
      });
    }

    const trace = [];
    let failure = null;
    for (let i = 0; i < payload.steps.length; i++) {
      try {
        trace.push(engine.process(payload.steps[i], i));
      } catch (err) {
        failure = {
          index: i,
          code: err.code || 'BAD_STEP',
          message: err.message,
          detail: err.detail || null,
          op: payload.steps[i] && payload.steps[i].op,
        };
        break; // first failing claim / invalid step halts the trace
      }
    }

    return this._freeze(auditId, payloadHash, payload, failure, engine, trace);
  }

  _freeze(auditId, payloadHash, payload, failure, engine, trace) {
    let record;
    if (failure) {
      record = frozenRejection(auditId, payloadHash, failure, trace.length, {
        constants: payload.constants,
        functions: payload.functions,
        steps: payload.steps,
        trace,
      });
    } else {
      const claims = trace.filter((s) => s.op === 'claim');
      let verdict = 'pending';
      let latestClaim = null;
      if (claims.length) {
        latestClaim = claims[claims.length - 1];
        verdict = latestClaim.verdict === 'contradiction' ? 'contradiction' : 'equal';
      }
      record = {
        auditId,
        payloadHash,
        replayed: false,
        frozenAt: new Date().toISOString(),
        verdict,
        accepted: true,
        constants: payload.constants,
        functions: payload.functions,
        steps: payload.steps,
        trace,
        scopeDepth: engine.scopeDepth,
        openScopes: engine.checkpoints.map((c) => c.label),
        classes: engine.classes(),
        latestClaim,
        failure: null,
      };
    }
    this.sessions.set(auditId, { payloadHash, record });
    return { status: 200, body: record };
  }

  get(auditId) {
    const existing = this.sessions.get(auditId);
    return existing ? { status: 200, body: existing.record } : null;
  }
}

function frozenRejection(auditId, payloadHash, failure, processedCount, extra = {}) {
  return {
    auditId: auditId || null,
    payloadHash,
    replayed: false,
    frozenAt: new Date().toISOString(),
    verdict: 'rejected',
    accepted: false,
    failure: {
      ...failure,
      processedSteps: processedCount,
      totalSteps: extra.steps ? extra.steps.length : processedCount,
    },
    trace: extra.trace || [],
    constants: extra.constants || [],
    functions: extra.functions || {},
    steps: extra.steps || [],
    scopeDepth: null,
    openScopes: [],
    classes: [],
    latestClaim: null,
  };
}

function validateEnvelope(raw) {
  if (!raw || typeof raw !== 'object') {
    return { index: -1, code: 'BAD_REQUEST', message: '请求体必须是 JSON 对象' };
  }
  if (typeof raw.auditId !== 'string' || !AUDIT_ID_RE.test(raw.auditId)) {
    return {
      index: -1,
      code: 'BAD_AUDIT_ID',
      message: '缺少合法的稳定审计标识 auditId（字母数字、: _ -，长度 1–128）',
    };
  }
  if (!Array.isArray(raw.constants)) {
    return { index: -1, code: 'BAD_REQUEST', message: 'constants 必须是字符串数组' };
  }
  if (!raw.functions || typeof raw.functions !== 'object' || Array.isArray(raw.functions)) {
    return { index: -1, code: 'BAD_REQUEST', message: 'functions 必须是 函数名->元数 的对象' };
  }
  if (!Array.isArray(raw.steps)) {
    return { index: -1, code: 'BAD_REQUEST', message: 'steps 必须是数组' };
  }
  if (raw.steps.length > MAX_STEPS) {
    return {
      index: -1,
      code: 'TOO_MANY_STEPS',
      message: `证明轨迹最多 ${MAX_STEPS} 步，收到 ${raw.steps.length} 步`,
    };
  }
  return null;
}

module.exports = { AuditStore, hashPayload };

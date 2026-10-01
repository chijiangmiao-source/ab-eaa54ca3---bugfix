'use strict';

const crypto = require('crypto');
const { createEngine, ProofError } = require('./engine');

const MAX_STEPS = 180;
const AUDIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

function normalizeForHash(value) {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => normalizeForHash(entry));
    return entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === 'object') {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeForHash(value[key]);
    }
    return normalized;
  }
  return value;
}

function hashPayload(payload) {
  const normalized = normalizeForHash(payload);
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

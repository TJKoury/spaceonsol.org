// ====== Space Data Standards record store (local-first) ======
// Schemas mirror github.com/DigitalArsenal/spacedatastandards.org @ main:
//   TRE — Trust Edge Record  (truster -> trustee, WEIGHT [0,1], DELETED tombstone)
//   TNR — Trust Node Record  (durable node membership for isolated nodes)
//   EPM — Entity Profile Message (signed identity; see epm.js)
//   PNM — Publish Notification (signed announcement of a CID)
//   REC — Record Wrapper (archive envelope)
//
// Revocation is NOT a separate schema: a TRE with DELETED=true tombstones the
// edge. The live graph is a projection over the latest record per EDGE_ID.
//
// Stored LOCALLY in localStorage. Nothing is transmitted unless backed up.

const KEY = "sdn.sds.records.v2";
const BASE = "https://spacedatastandards.org/#/schemas/";

export const STANDARDS = {
  TRE: { code: "TRE", name: "Trust Edge Record", url: BASE + "TRE" },
  TNR: { code: "TNR", name: "Trust Node Record", url: BASE + "TNR" },
  EPM: { code: "EPM", name: "Entity Profile Message", url: BASE + "EPM" },
  PNM: { code: "PNM", name: "Publish Notification", url: BASE + "PNM" },
  REC: { code: "REC", name: "Record Wrapper", url: BASE + "REC" },
  // PROPOSED EXTENSION — no trust-policy schema exists upstream. TRE/TNR carry
  // trust *facts*; nothing encodes the *rules* that evaluate them
  // (Adversarial Security §3.2-3.4, §6). TRP fills that gap.
  TRP: { code: "TRP", name: "Trust Rule Policy (proposed)", url: BASE + "TRP", proposed: true },
};

/* ---------------- trust levels ----------------
   SDS defines peerRegistryTrustCategory / peerGroupTrustCategory as
   { Untrusted, Limited, Standard, Trusted, Admin }. Those map cleanly onto
   OpenPGP/GnuPG ownertrust, and onto the TRE WEIGHT range [0,1].
   GnuPG semantics: marginals-needed=3 (so marginal ~ 1/3), completes-needed=1.
*/
export const TRUST_LEVELS = [
  { sds: "Untrusted", pgp: "Never",     ordinal: 0, weight: 0.0,  desc: "Actively distrusted — do not rely on this key" },
  { sds: "Limited",   pgp: "Marginal",  ordinal: 1, weight: 0.33, desc: "Partial trust — needs corroboration (3 marginals = 1 full)" },
  { sds: "Standard",  pgp: "Undefined", ordinal: 2, weight: 0.50, desc: "Baseline — known, but no explicit judgement" },
  { sds: "Trusted",   pgp: "Full",      ordinal: 3, weight: 0.80, desc: "Fully trusted to introduce others" },
  { sds: "Admin",     pgp: "Ultimate",  ordinal: 4, weight: 1.0,  desc: "Ultimate trust — your own keys / root authority" },
];
export const levelBySds = (s) => TRUST_LEVELS.find((l) => l.sds === s) || TRUST_LEVELS[2];
export const levelByWeight = (w) =>
  TRUST_LEVELS.reduce((best, l) => Math.abs(l.weight - w) < Math.abs(best.weight - w) ? l : best, TRUST_LEVELS[0]);

function newId(prefix) {
  if (globalThis.crypto && crypto.randomUUID) return prefix + "_" + crypto.randomUUID();
  return prefix + "_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
const nowMs = () => Date.now();

const envelope = (code) => ({
  STANDARD: code,
  schema: STANDARDS[code].url,
  id: newId(code.toLowerCase()),
});

/* ---------------- TRE — Trust Edge Record ---------------- */
export function makeTRE({ trusterId, trusteeId, weight, level, deleted = false, providerPeerId = null, providerSignature = null, note = "", signature = null, amount = null }) {
  const lvl = level ? levelBySds(level) : null;
  return {
    ...envelope("TRE"),
    EDGE_ID: `${trusterId}->${trusteeId}`,
    TRUSTER_ID: trusterId,
    TRUSTEE_ID: trusteeId,
    WEIGHT: weight != null ? Math.max(0, Math.min(1, Number(weight))) : (lvl ? lvl.weight : 0.5),
    UPDATED_AT: nowMs(),
    DELETED: !!deleted,
    PROVIDER_PEER_ID: providerPeerId,
    PROVIDER_SIGNATURE: providerSignature,
    // local-only context, not part of the wire schema
    _level: lvl ? lvl.sds : levelByWeight(weight ?? 0.5).sds,
    _note: note,
    _txSignature: signature,
    _amount: amount,
  };
}

/** Tombstone an edge — this is how revocation works in TRE. */
export function makeTombstone({ trusterId, trusteeId, note = "", reason = "" }) {
  const t = makeTRE({ trusterId, trusteeId, weight: 0, deleted: true, note });
  t._reason = reason;
  return t;
}

export const REVOCATION_REASONS = [
  ["KEY_COMPROMISE", "Key compromise — funds drained or key leaked"],
  ["SUPERSEDED", "Superseded — replaced by a newer key"],
  ["NO_LONGER_TRUSTED", "No longer trusted — relationship ended"],
  ["CESSATION", "Cessation of operation — entity is inactive"],
  ["UNSPECIFIED", "Unspecified"],
];

/* ---------------- TNR — Trust Node Record ---------------- */
export function makeTNR({ nodeId, deleted = false, providerPeerId = null, label = "" }) {
  const t = nowMs();
  return {
    ...envelope("TNR"),
    NODE_ID: nodeId,
    CREATED_AT: t,
    UPDATED_AT: t,
    DELETED: !!deleted,
    PROVIDER_PEER_ID: providerPeerId,
    PROVIDER_SIGNATURE: null,
    _label: label,
  };
}

/* ---------------- PNM ---------------- */
export function makePNM({ cid, standard = "REC", gateway = null, count = 0, issuer = null, signature = null }) {
  return {
    ...envelope("PNM"),
    FILE_ID: standard,
    CID: cid,
    SIGNATURE: signature,
    SIGNATURE_TYPE: signature ? "Ed25519" : null,
    _gateway: gateway,
    _recordCount: count,
    _issuer: issuer,
    _issuedAt: new Date().toISOString(),
  };
}

/* ---------------- TRP — trust rule policy (PROPOSED) ---------------- */
export const RULE_TYPES = {
  MIN_BOND:          { label: "Minimum bond value",          unit: "USD",    signal: "value",         cmp: ">=", def: 1000 },
  MIN_CHAINS:        { label: "Funded on at least N chains", unit: "chains", signal: "chains",        cmp: ">=", def: 3 },
  MAX_CONCENTRATION: { label: "Max single-chain share",      unit: "%",      signal: "concentration", cmp: "<=", def: 60 },
  MIN_DURATION:      { label: "Funds unspent for",           unit: "days",   signal: "durationDays",  cmp: ">=", def: 30 },
  MAX_KEY_AGE:       { label: "Key rotated within",          unit: "days",   signal: "keyAgeDays",    cmp: "<=", def: 365 },
  MIN_ENDORSEMENTS:  { label: "Inbound trust edges",         unit: "edges",  signal: "endorsements",  cmp: ">=", def: 1 },
  MIN_TRUST_WEIGHT:  { label: "Aggregate inbound weight",    unit: "",       signal: "inboundWeight", cmp: ">=", def: 0.8 },
  REQUIRE_CERT:      { label: "X.509 certificate bound",     unit: "",       signal: "hasCert",       cmp: "==", def: true },
};

export function makeRule({ type, threshold, mode = "SCORE", weight = 1, dependsOn = null }) {
  const spec = RULE_TYPES[type];
  if (!spec) throw new Error("Unknown rule type: " + type);
  return {
    ruleId: newId("rule"),
    type, label: spec.label, signal: spec.signal, cmp: spec.cmp, unit: spec.unit,
    threshold: threshold ?? spec.def,
    mode, weight: Number(weight) || 1, dependsOn,
  };
}

export function makeTRP({ name, rules = [], issuer = null, note = "" }) {
  return { ...envelope("TRP"), name, issuer, note, rules, _issuedAt: new Date().toISOString() };
}

const cmpOk = (cmp, a, b) =>
  cmp === ">=" ? a >= b : cmp === "<=" ? a <= b : cmp === "==" ? (a === b || String(a) === String(b)) : false;

export function evaluatePolicy(rules, signals) {
  const byId = new Map(rules.map((r) => [r.ruleId, r]));
  const results = new Map();
  const evalRule = (rule, seen = new Set()) => {
    if (results.has(rule.ruleId)) return results.get(rule.ruleId);
    if (seen.has(rule.ruleId)) {
      const r = { rule, status: "SKIPPED", reason: "circular dependency", value: null };
      results.set(rule.ruleId, r); return r;
    }
    seen.add(rule.ruleId);
    if (rule.dependsOn) {
      const parent = byId.get(rule.dependsOn);
      if (parent && evalRule(parent, seen).status !== "PASS") {
        const r = { rule, status: "SKIPPED", reason: `depends on "${parent.label}"`, value: null };
        results.set(rule.ruleId, r); return r;
      }
    }
    let value = signals[rule.signal];
    if (value === undefined || value === null) {
      const r = { rule, status: "UNKNOWN", reason: "no data for this signal", value: null };
      results.set(rule.ruleId, r); return r;
    }
    if (rule.signal === "concentration") value = Math.round(value * 100);
    const r = { rule, status: cmpOk(rule.cmp, value, rule.threshold) ? "PASS" : "FAIL", value, reason: "" };
    results.set(rule.ruleId, r); return r;
  };
  for (const r of rules) evalRule(r);
  const list = rules.map((r) => results.get(r.ruleId));
  const gateFailed = list.filter((r) => r.rule.mode === "REQUIRE").some((r) => r.status !== "PASS");
  const scored = list.filter((r) => r.rule.mode === "SCORE");
  const totalW = scored.reduce((s, r) => s + r.rule.weight, 0);
  const gotW = scored.filter((r) => r.status === "PASS").reduce((s, r) => s + r.rule.weight, 0);
  const score = totalW ? Math.round((gotW / totalW) * 100) : (gateFailed ? 0 : 100);
  return {
    results: list, gateFailed, score: gateFailed ? 0 : score,
    verdict: gateFailed ? "REJECTED" : score >= 80 ? "TRUSTED" : score >= 50 ? "PROVISIONAL" : "INSUFFICIENT",
  };
}

/* ---------------- storage ---------------- */
export function loadAll() {
  try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}
export function saveAll(records) {
  try { localStorage.setItem(KEY, JSON.stringify(records)); return true; }
  catch (e) { console.warn("SDS local save failed", e); return false; }
}
export function addRecord(rec) { const all = loadAll(); all.push(rec); saveAll(all); return rec; }
export function removeRecord(id) { const all = loadAll().filter((r) => r.id !== id); saveAll(all); return all; }
export function clearAll() { localStorage.removeItem(KEY); }
export function byStandard(code) { return loadAll().filter((r) => r.STANDARD === code); }

/** Project the live trust graph: latest TRE per EDGE_ID, tombstones removed. */
export function projectEdges(records = loadAll()) {
  const latest = new Map();
  for (const r of records) {
    if (r.STANDARD !== "TRE") continue;
    const prev = latest.get(r.EDGE_ID);
    if (!prev || r.UPDATED_AT >= prev.UPDATED_AT) latest.set(r.EDGE_ID, r);
  }
  return [...latest.values()].filter((r) => !r.DELETED);
}
/** Latest record per edge including tombstones — for showing revoked state. */
export function projectEdgesWithTombstones(records = loadAll()) {
  const latest = new Map();
  for (const r of records) {
    if (r.STANDARD !== "TRE") continue;
    const prev = latest.get(r.EDGE_ID);
    if (!prev || r.UPDATED_AT >= prev.UPDATED_AT) latest.set(r.EDGE_ID, r);
  }
  return [...latest.values()];
}
export const activeTrust = () => projectEdges();
export function isRevoked(truster, trustee) {
  const e = projectEdgesWithTombstones().find((r) => r.EDGE_ID === `${truster}->${trustee}`);
  return !!(e && e.DELETED);
}

/** TRE requires the projected graph to be acyclic. Returns a cycle or null. */
export function findCycle(edges = projectEdges()) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.TRUSTER_ID)) adj.set(e.TRUSTER_ID, []);
    adj.get(e.TRUSTER_ID).push(e.TRUSTEE_ID);
  }
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map(), stack = [];
  let found = null;
  const visit = (n) => {
    if (found) return;
    color.set(n, GREY); stack.push(n);
    for (const m of adj.get(n) || []) {
      if (found) break;
      const c = color.get(m) ?? WHITE;
      if (c === GREY) { found = [...stack.slice(stack.indexOf(m)), m]; break; }
      if (c === WHITE) visit(m);
    }
    stack.pop(); color.set(n, BLACK);
  };
  for (const n of adj.keys()) if ((color.get(n) ?? WHITE) === WHITE) visit(n);
  return found;
}

/** Would adding truster->trustee create a cycle? */
export function wouldCreateCycle(truster, trustee, edges = projectEdges()) {
  if (truster === trustee) return [truster, trustee];
  const probe = [...edges, { TRUSTER_ID: truster, TRUSTEE_ID: trustee }];
  return findCycle(probe);
}

/* ---------------- archive ---------------- */
export function toArchive(records = loadAll()) {
  const counts = {};
  for (const r of records) counts[r.STANDARD] = (counts[r.STANDARD] || 0) + 1;
  return {
    STANDARD: "REC",
    schema: STANDARDS.REC.url,
    exportedAt: new Date().toISOString(),
    origin: location.origin,
    standards: Object.keys(counts).map((c) => ({ code: c, count: counts[c], schema: STANDARDS[c]?.url })),
    count: records.length,
    records,
  };
}
export const toBlob = (records = loadAll()) =>
  new Blob([JSON.stringify(toArchive(records), null, 2)], { type: "application/json" });
export const suggestedFilename = () => `sdn-trust-records-${new Date().toISOString().slice(0, 10)}.json`;

export function importArchive(json) {
  const incoming = Array.isArray(json) ? json : json?.records || null;
  if (!incoming) throw new Error("Not an SDS archive — expected a `records` array.");
  const all = loadAll();
  const seen = new Set(all.map((r) => r.id));
  let added = 0;
  for (const r of incoming) {
    if (!r?.id || seen.has(r.id)) continue;
    all.push(r); seen.add(r.id); added++;
  }
  saveAll(all);
  return { added, total: all.length };
}

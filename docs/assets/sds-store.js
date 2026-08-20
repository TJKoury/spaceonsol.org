// ====== Space Data Standards record store (local-first) ======
// Standards used here, per https://spacedatastandards.org
//   TRE — trust graph assertion   (I vouch for this key)
//   TNR — trust revocation        (I withdraw that vouch)
//   EPM — cryptographic key info  (the identity behind a wallet)
//   PNM — publish notification    (a signed announcement of an IPFS CID)
//   REC — record wrapper          (the archive envelope)
//
// Records are stored LOCALLY BY DEFAULT in localStorage. Nothing is
// transmitted anywhere unless the user explicitly backs it up.

const KEY = "sdn.sds.records.v1";
const BASE = "https://spacedatastandards.org/#/schemas/";

export const STANDARDS = {
  TRE: { code: "TRE", name: "Trust Graph Assertion", url: BASE + "TRE" },
  TNR: { code: "TNR", name: "Trust Revocation",      url: BASE + "TNR" },
  EPM: { code: "EPM", name: "Cryptographic Key Info", url: BASE + "EPM" },
  PNM: { code: "PNM", name: "Publish Notification",  url: BASE + "PNM" },
  REC: { code: "REC", name: "Record Wrapper",        url: BASE + "REC" },
  // PROPOSED EXTENSION — Space Data Standards has no trust-policy schema.
  // TRE/TNR carry trust *facts*; nothing encodes the *rules* that evaluate
  // them (whitepaper §3.2-3.4, §6). TRP fills that gap.
  TRP: { code: "TRP", name: "Trust Rule Policy (proposed)", url: BASE + "TRP", proposed: true },
};

function newId(prefix) {
  if (globalThis.crypto && crypto.randomUUID) return prefix + "_" + crypto.randomUUID();
  return prefix + "_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const envelope = (code) => ({
  STANDARD: code,
  schema: STANDARDS[code].url,
  version: 1,
  id: newId(code.toLowerCase()),
  issuedAt: new Date().toISOString(),
});

/* ---------------- TRE — assert trust ---------------- */
export function makeTRE({ issuer, subject, amount, token = "SPACE", mint, signature = null, note = "", source = "manual" }) {
  return {
    ...envelope("TRE"),
    issuer,                 // wallet asserting trust
    subject,                // wallet being trusted
    assertion: {
      type: "VALUE_TRANSFER",
      amount: Number(amount) || 0,
      token, mint: mint || null, chain: "solana",
    },
    signature,              // on-chain tx signature
    note,
    source,                 // manual | onchain
    status: "ACTIVE",
  };
}

/* ---------------- TNR — revoke trust ---------------- */
export function makeTNR({ issuer, subject, revokes = null, reason = "", note = "", signature = null }) {
  return {
    ...envelope("TNR"),
    issuer,                 // wallet withdrawing trust
    subject,                // wallet no longer trusted
    revokes,                // id of the TRE being revoked (if targeted)
    reason,                 // KEY_COMPROMISE | SUPERSEDED | NO_LONGER_TRUSTED | CESSATION | UNSPECIFIED
    note,
    signature,              // wallet signature over the revocation payload
    effectiveAt: new Date().toISOString(),
  };
}

export const REVOCATION_REASONS = [
  ["KEY_COMPROMISE", "Key compromise — funds drained or key leaked"],
  ["SUPERSEDED", "Superseded — replaced by a newer key"],
  ["NO_LONGER_TRUSTED", "No longer trusted — relationship ended"],
  ["CESSATION", "Cessation of operation — entity is inactive"],
  ["UNSPECIFIED", "Unspecified"],
];

/* ---------------- EPM — key / identity info ---------------- */
export function makeEPM({ address, chain = "solana", curve = "ed25519", derivationPath = "m/44'/501'/0'/0'", label = "" }) {
  return {
    ...envelope("EPM"),
    address,
    chain,
    curve,
    derivationPath,
    label,
  };
}

/* ---------------- PNM — publish notification ---------------- */
export function makePNM({ cid, standard = "REC", gateway = null, count = 0, issuer = null }) {
  return {
    ...envelope("PNM"),
    cid,
    contentStandard: standard,
    gateway,
    recordCount: count,
    issuer,
  };
}

/* ---------------- TRP — trust rule policy (proposed) ----------------
   Rules compose: each rule is a predicate over observable signals, with a
   weight. A policy is an ordered rule set; rules may REQUIRE (hard gate) or
   SCORE (weighted contribution). Later rules can build on earlier ones via
   `dependsOn`, so a rule only evaluates if its prerequisite passed —
   this is what makes the policy a lattice rather than a flat checklist.

   Signals, per Adversarial Security §2.3  T(a) = f(W(a), V(a), D(a)):
     value        V — total USD value bonded at the key's derived addresses
     chains       — how many independent chains hold a non-zero balance
     concentration— largest single-chain share (0-1)
     durationDays D — days the funds have sat unspent
     keyAgeDays   — age of the key
     endorsements W — count of active inbound TRE assertions
     hasCert      — X.509 binding present (§5.1)
*/
export const RULE_TYPES = {
  MIN_BOND:          { label: "Minimum bond value",      unit: "USD",   signal: "value",         cmp: ">=", def: 1000 },
  MIN_CHAINS:        { label: "Funded on at least N chains", unit: "chains", signal: "chains",   cmp: ">=", def: 3 },
  MAX_CONCENTRATION: { label: "Max single-chain share",   unit: "%",    signal: "concentration", cmp: "<=", def: 60 },
  MIN_DURATION:      { label: "Funds unspent for",        unit: "days", signal: "durationDays",  cmp: ">=", def: 30 },
  MAX_KEY_AGE:       { label: "Key rotated within",       unit: "days", signal: "keyAgeDays",    cmp: "<=", def: 365 },
  MIN_ENDORSEMENTS:  { label: "Inbound endorsements",     unit: "TRE",  signal: "endorsements",  cmp: ">=", def: 1 },
  REQUIRE_CERT:      { label: "X.509 certificate bound",  unit: "",     signal: "hasCert",       cmp: "==", def: true },
};

export function makeRule({ type, threshold, mode = "SCORE", weight = 1, dependsOn = null }) {
  const spec = RULE_TYPES[type];
  if (!spec) throw new Error("Unknown rule type: " + type);
  return {
    ruleId: newId("rule"),
    type, label: spec.label, signal: spec.signal, cmp: spec.cmp, unit: spec.unit,
    threshold: threshold ?? spec.def,
    mode,              // REQUIRE (hard gate) | SCORE (weighted)
    weight: Number(weight) || 1,
    dependsOn,         // ruleId that must pass first
  };
}

export function makeTRP({ name, rules = [], issuer = null, note = "" }) {
  return { ...envelope("TRP"), name, issuer, note, rules };
}

function cmpOk(cmp, a, b) {
  if (cmp === ">=") return a >= b;
  if (cmp === "<=") return a <= b;
  if (cmp === "==") return a === b || String(a) === String(b);
  return false;
}

/** Evaluate a policy's rules against a signal set. Returns per-rule results and a score. */
export function evaluatePolicy(rules, signals) {
  const byId = new Map(rules.map((r) => [r.ruleId, r]));
  const results = new Map();

  const evalRule = (rule, seen = new Set()) => {
    if (results.has(rule.ruleId)) return results.get(rule.ruleId);
    if (seen.has(rule.ruleId)) {                       // cycle guard
      const r = { rule, status: "SKIPPED", reason: "circular dependency", value: null };
      results.set(rule.ruleId, r); return r;
    }
    seen.add(rule.ruleId);

    if (rule.dependsOn) {
      const parent = byId.get(rule.dependsOn);
      if (parent) {
        const p = evalRule(parent, seen);
        if (p.status !== "PASS") {
          const r = { rule, status: "SKIPPED", reason: `depends on "${parent.label}"`, value: null };
          results.set(rule.ruleId, r); return r;
        }
      }
    }
    let value = signals[rule.signal];
    if (value === undefined || value === null) {
      const r = { rule, status: "UNKNOWN", reason: "no data for this signal", value: null };
      results.set(rule.ruleId, r); return r;
    }
    if (rule.signal === "concentration") value = Math.round(value * 100);
    const pass = cmpOk(rule.cmp, value, rule.threshold);
    const r = { rule, status: pass ? "PASS" : "FAIL", value, reason: "" };
    results.set(rule.ruleId, r); return r;
  };

  for (const r of rules) evalRule(r);

  const list = rules.map((r) => results.get(r.ruleId));
  const gates = list.filter((r) => r.rule.mode === "REQUIRE");
  const gateFailed = gates.some((r) => r.status !== "PASS");
  const scored = list.filter((r) => r.rule.mode === "SCORE");
  const totalW = scored.reduce((s, r) => s + r.rule.weight, 0);
  const gotW = scored.filter((r) => r.status === "PASS").reduce((s, r) => s + r.rule.weight, 0);
  const score = totalW ? Math.round((gotW / totalW) * 100) : (gateFailed ? 0 : 100);

  return {
    results: list,
    score: gateFailed ? 0 : score,
    gateFailed,
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

export function addRecord(rec) {
  const all = loadAll();
  all.push(rec);
  // a TNR marks its target TRE revoked
  if (rec.STANDARD === "TNR") {
    for (const r of all) {
      if (r.STANDARD !== "TRE") continue;
      const targeted = rec.revokes ? r.id === rec.revokes
        : r.issuer === rec.issuer && r.subject === rec.subject;
      if (targeted) { r.status = "REVOKED"; r.revokedBy = rec.id; }
    }
  }
  saveAll(all);
  return rec;
}

export function removeRecord(id) {
  const all = loadAll().filter((r) => r.id !== id);
  saveAll(all);
  return all;
}

export function clearAll() { localStorage.removeItem(KEY); }

export function byStandard(code) { return loadAll().filter((r) => r.STANDARD === code); }

/** Active (non-revoked) trust assertions. */
export function activeTrust() {
  return loadAll().filter((r) => r.STANDARD === "TRE" && r.status !== "REVOKED");
}

/** Is this issuer→subject edge revoked? */
export function isRevoked(issuer, subject) {
  return loadAll().some((r) => r.STANDARD === "TNR" && r.issuer === issuer && r.subject === subject);
}

/* ---------------- archive / backup ---------------- */
export function toArchive(records = loadAll()) {
  const counts = {};
  for (const r of records) counts[r.STANDARD] = (counts[r.STANDARD] || 0) + 1;
  return {
    ...envelope("REC"),
    origin: location.origin,
    standards: Object.keys(counts).map((c) => ({ code: c, count: counts[c], schema: STANDARDS[c]?.url })),
    count: records.length,
    records,
  };
}

export function toBlob(records = loadAll()) {
  return new Blob([JSON.stringify(toArchive(records), null, 2)], { type: "application/json" });
}

export function suggestedFilename() {
  return `sdn-trust-records-${new Date().toISOString().slice(0, 10)}.json`;
}

export function importArchive(json) {
  const incoming = Array.isArray(json) ? json : json && json.records ? json.records : null;
  if (!incoming) throw new Error("Not an SDS archive — expected a `records` array.");
  const all = loadAll();
  const seen = new Set(all.map((r) => r.id));
  let added = 0;
  for (const r of incoming) {
    if (!r || !r.id || seen.has(r.id)) continue;
    all.push(r); seen.add(r.id); added++;
  }
  saveAll(all);
  return { added, total: all.length };
}

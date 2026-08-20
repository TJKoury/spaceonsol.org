// ====== EPM — Entity Profile Message: canonical signing, vCard, QR ======
//
// Implements the NORMATIVE annex:
//   github.com/DigitalArsenal/spacedatastandards.org/blob/main/schema/EPM/CANONICAL_SERIALIZATION.md
//
// Key points from the annex, implemented verbatim below:
//  1. The signing preimage is an RFC 8785 (JCS) JSON projection — NEVER the
//     FlatBuffer bytes (vtable dedup / padding / framing are builder-dependent).
//  2. Fields absent or empty after Unicode-whitespace trim are OMITTED; a
//     nested object that becomes empty is itself omitted.
//  3. EPM.SIGNATURE is excluded from its own preimage. ChainProof.SIGNATURE stays.
//  4. SIGNATURE_TIMESTAMP is INCLUDED as a JSON number when nonzero.
//  5. ENTITY_TYPE is always present, projected as its enum NAME.
//  6. Vectors project as arrays; CryptoKey.KEY_TYPE projects as its enum name.
//  Production order (§3): KEYS sorted by (KEY_TYPE, ADDRESS_TYPE, PUBLIC_KEY, XPUB);
//  CHAIN_PROOFS by (CHAIN, ADDRESS, KEY_PATH); string vectors by value, deduped.
//  ed25519 (§4): signature is RAW ed25519 over the preimage; the verifying key
//  is the published key in KEYS[] (SLIP-10 has no public derivation).

import * as flatbuffers from "https://esm.sh/flatbuffers@25.9.23";
import * as EPMMod from "https://esm.sh/spacedatastandards.org@1.193.0/lib/js/EPM/main.js";

export const FILE_IDENTIFIER = "$EPM";
const KeyType = { Signing: 0, Encryption: 1 };
const EntityType = { User: 0, Node: 1 };
export const ENTITY_TYPES = ["User", "Node"];

/* ---------------- RFC 8785 (JCS) ---------------- */

/** JCS orders object members by UTF-16 code units. HTML escaping is disabled. */
function jcsSort(value) {
  if (Array.isArray(value)) return value.map(jcsSort);
  if (value && typeof value === "object") {
    const out = {};
    // Array.prototype.sort compares by UTF-16 code units — exactly what JCS requires.
    for (const k of Object.keys(value).sort()) out[k] = jcsSort(value[k]);
    return out;
  }
  return value;
}

/** Serialize to canonical JSON bytes. JSON.stringify does not HTML-escape,
 *  which matches the annex ("&, <, > and U+2028/U+2029 are emitted raw"). */
export function jcsStringify(obj) {
  return JSON.stringify(jcsSort(obj));
}

const trimmed = (v) => (typeof v === "string" ? v.trim() : v);
/** Rule 2: include only if non-empty after trim. */
function put(target, key, value) {
  const t = trimmed(value);
  if (t !== undefined && t !== null && t !== "") target[key] = t;
}
function strVector(arr) {
  if (!Array.isArray(arr)) return null;
  const seen = new Set(), out = [];
  for (const v of arr) {
    const t = trimmed(v);
    if (!t || seen.has(t)) continue;   // §3: dedupe exact duplicates after trim
    seen.add(t); out.push(t);
  }
  return out.length ? out.sort() : null; // §3: element value order
}
const cmpTuple = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };

/**
 * Build the canonical signing preimage for an EPM plain object.
 * Returns { json, bytes } where bytes is the UTF-8 of the JCS document.
 */
export function canonicalPreimage(epm) {
  const c = {};
  put(c, "DN", epm.DN);
  put(c, "LEGAL_NAME", epm.LEGAL_NAME);
  put(c, "FAMILY_NAME", epm.FAMILY_NAME);
  put(c, "GIVEN_NAME", epm.GIVEN_NAME);
  put(c, "ADDITIONAL_NAME", epm.ADDITIONAL_NAME);
  put(c, "HONORIFIC_PREFIX", epm.HONORIFIC_PREFIX);
  put(c, "HONORIFIC_SUFFIX", epm.HONORIFIC_SUFFIX);
  put(c, "JOB_TITLE", epm.JOB_TITLE);
  put(c, "OCCUPATION", epm.OCCUPATION);
  put(c, "EMAIL", epm.EMAIL);
  put(c, "TELEPHONE", epm.TELEPHONE);
  put(c, "SIGNATURE_ALGORITHM", epm.SIGNATURE_ALGORITHM);

  if (epm.ADDRESS) {
    const a = {};
    put(a, "COUNTRY", epm.ADDRESS.COUNTRY);
    put(a, "REGION", epm.ADDRESS.REGION);
    put(a, "LOCALITY", epm.ADDRESS.LOCALITY);
    put(a, "POSTAL_CODE", epm.ADDRESS.POSTAL_CODE);
    put(a, "STREET", epm.ADDRESS.STREET);
    put(a, "POST_OFFICE_BOX_NUMBER", epm.ADDRESS.POST_OFFICE_BOX_NUMBER);
    if (Object.keys(a).length) c.ADDRESS = a;   // rule 2: omit if empty
  }

  const alt = strVector(epm.ALTERNATE_NAMES);
  if (alt) c.ALTERNATE_NAMES = alt;

  if (Array.isArray(epm.KEYS) && epm.KEYS.length) {
    const keys = [];
    for (const k of epm.KEYS) {
      const e = {};
      put(e, "PUBLIC_KEY", k.PUBLIC_KEY);
      put(e, "XPUB", k.XPUB);
      put(e, "ADDRESS_TYPE", k.ADDRESS_TYPE);
      put(e, "KEY_ADDRESS", k.KEY_ADDRESS);
      put(e, "KEY_PATH", k.KEY_PATH);
      put(e, "ALGORITHM", k.ALGORITHM);
      put(e, "ENCODING", k.ENCODING);
      if (k.KEY_TYPE !== undefined && k.KEY_TYPE !== null) {
        e.KEY_TYPE = typeof k.KEY_TYPE === "string" ? k.KEY_TYPE
          : (k.KEY_TYPE === KeyType.Encryption ? "Encryption" : "Signing");
      }
      if (Object.keys(e).length) keys.push(e);
    }
    // §3 production order
    keys.sort((x, y) => cmpTuple(
      [x.KEY_TYPE || "", x.ADDRESS_TYPE || "", x.PUBLIC_KEY || "", x.XPUB || ""],
      [y.KEY_TYPE || "", y.ADDRESS_TYPE || "", y.PUBLIC_KEY || "", y.XPUB || ""]));
    if (keys.length) c.KEYS = keys;
  }

  const multi = strVector(epm.MULTIFORMAT_ADDRESS);
  if (multi) c.MULTIFORMAT_ADDRESS = multi;

  if (Array.isArray(epm.CHAIN_PROOFS) && epm.CHAIN_PROOFS.length) {
    const proofs = [];
    for (const p of epm.CHAIN_PROOFS) {
      const e = {};
      put(e, "CHAIN", p.CHAIN);
      put(e, "ADDRESS", p.ADDRESS);
      put(e, "PUBLIC_KEY", p.PUBLIC_KEY);
      put(e, "KEY_PATH", p.KEY_PATH);
      put(e, "SIGNATURE", p.SIGNATURE);       // rule 3: inner attestation stays
      put(e, "SIGNED_PAYLOAD", p.SIGNED_PAYLOAD);
      put(e, "ALGORITHM", p.ALGORITHM);
      put(e, "ENCODING", p.ENCODING);
      if (Object.keys(e).length) proofs.push(e);
    }
    proofs.sort((x, y) => cmpTuple(
      [x.CHAIN || "", x.ADDRESS || "", x.KEY_PATH || ""],
      [y.CHAIN || "", y.ADDRESS || "", y.KEY_PATH || ""]));
    if (proofs.length) c.CHAIN_PROOFS = proofs;
  }

  // rule 5: always present, as enum name
  c.ENTITY_TYPE = typeof epm.ENTITY_TYPE === "string"
    ? epm.ENTITY_TYPE
    : (epm.ENTITY_TYPE === EntityType.Node ? "Node" : "User");

  // rule 4: included when nonzero
  const ts = Number(epm.SIGNATURE_TIMESTAMP || 0);
  if (ts) c.SIGNATURE_TIMESTAMP = ts;

  const json = jcsStringify(c);
  return { json, bytes: new TextEncoder().encode(json) };
}

/* ---------------- hex / base helpers ---------------- */
export const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
export function fromHex(h) {
  const s = String(h).trim().replace(/^0[xX]/, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
export const b64 = (u8) => btoa(String.fromCharCode(...u8));
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/* ---------------- signing / verifying ---------------- */

/**
 * Sign an EPM with a connected Solana wallet.
 *
 * Per §4, the ed25519 verifying key is whatever is published in KEYS[] — it is
 * authoritative, because SLIP-10 ed25519 has no public derivation. The
 * m/44'/0'/N'/0'/0' path is a suggested convention, not a constraint on
 * verification, so the wallet's own ed25519 key is a valid signing key.
 *
 * KEY_PATH is deliberately left unset: the wallet does not tell us which
 * account index the user selected, and asserting a path we cannot confirm
 * would be worse than omitting it (rule 2 omits it cleanly).
 */
export async function signEPM(epm, provider, publicKeyBytes) {
  const record = { ...epm, SIGNATURE_ALGORITHM: "ed25519" };
  record.SIGNATURE_TIMESTAMP = Math.floor(Date.now() / 1000);

  const pubHex = toHex(publicKeyBytes);
  const keys = Array.isArray(record.KEYS) ? [...record.KEYS] : [];
  if (!keys.some((k) => (k.PUBLIC_KEY || "").toLowerCase() === pubHex)) {
    keys.unshift({
      PUBLIC_KEY: pubHex,
      ADDRESS_TYPE: "ed25519",
      KEY_ADDRESS: record._walletAddress || "",
      KEY_TYPE: "Signing",
      ALGORITHM: "ed25519",
      ENCODING: "raw-ed25519",
    });
  }
  record.KEYS = keys;

  const { bytes } = canonicalPreimage(record);
  const res = await provider.signMessage(bytes, "utf8");
  const sig = res?.signature || res;
  record.SIGNATURE = toHex(sig instanceof Uint8Array ? sig : new Uint8Array(sig));
  return record;
}

/** Verify an EPM's embedded signature per §4 (ed25519 branch). */
export async function verifyEPM(record) {
  if (!record?.SIGNATURE) return { ok: false, reason: "no SIGNATURE" };
  if (!record.SIGNATURE_TIMESTAMP) return { ok: false, reason: "no SIGNATURE_TIMESTAMP" };
  const key = (record.KEYS || []).find((k) => {
    const t = String(k.KEY_TYPE ?? "Signing");
    const at = String(k.ADDRESS_TYPE || "").toLowerCase();
    return (t === "Signing" || t === "0" || k.KEY_TYPE === 0) && (!at || at === "ed25519");
  });
  if (!key?.PUBLIC_KEY) return { ok: false, reason: "no ed25519 signing key in KEYS" };

  // SIGNATURE is excluded from its own preimage (rule 3)
  const { bytes, json } = canonicalPreimage({ ...record, SIGNATURE: undefined });
  try {
    const { verify } = await import("https://esm.sh/@noble/ed25519@2.1.0");
    const ok = await verify(fromHex(record.SIGNATURE), bytes, fromHex(key.PUBLIC_KEY));
    return { ok, reason: ok ? "" : "signature does not verify", preimage: json, publicKey: key.PUBLIC_KEY };
  } catch (e) {
    return { ok: false, reason: "verify failed: " + e.message, preimage: json };
  }
}

/* ---------------- FlatBuffer encode / decode ---------------- */

/** Encode to size-prefixed FlatBuffer bytes with the "$EPM" identifier. */
export function encodeEPM(record) {
  const B = new flatbuffers.Builder(2048);
  const E = EPMMod.EPM, CK = EPMMod.CryptoKey, AD = EPMMod.Address, CP = EPMMod.ChainProof;
  const s = (v) => (v && String(v).trim() ? B.createString(String(v).trim()) : null);

  const sortedKeys = [...(record.KEYS || [])].sort((x, y) => cmpTuple(
    [String(x.KEY_TYPE ?? "Signing"), x.ADDRESS_TYPE || "", x.PUBLIC_KEY || "", x.XPUB || ""],
    [String(y.KEY_TYPE ?? "Signing"), y.ADDRESS_TYPE || "", y.PUBLIC_KEY || "", y.XPUB || ""]));
  const keyOffsets = sortedKeys.map((k) => {
    const pk = s(k.PUBLIC_KEY), xp = s(k.XPUB), ka = s(k.KEY_ADDRESS), at = s(k.ADDRESS_TYPE);
    const kp = s(k.KEY_PATH), al = s(k.ALGORITHM), en = s(k.ENCODING);
    CK.startCryptoKey(B);
    if (pk) CK.addPublicKey(B, pk);
    if (xp) CK.addXpub(B, xp);
    if (ka) CK.addKeyAddress(B, ka);
    if (at) CK.addAddressType(B, at);
    if (kp && CK.addKeyPath) CK.addKeyPath(B, kp);
    if (al && CK.addAlgorithm) CK.addAlgorithm(B, al);
    if (en && CK.addEncoding) CK.addEncoding(B, en);
    CK.addKeyType(B, k.KEY_TYPE === "Encryption" ? KeyType.Encryption : KeyType.Signing);
    return CK.endCryptoKey(B);
  });
  const keysVec = keyOffsets.length ? E.createKeysVector(B, keyOffsets) : null;

  const sortedProofs = [...(record.CHAIN_PROOFS || [])].sort((x, y) => cmpTuple(
    [x.CHAIN || "", x.ADDRESS || "", x.KEY_PATH || ""],
    [y.CHAIN || "", y.ADDRESS || "", y.KEY_PATH || ""]));
  const proofOffsets = sortedProofs.map((p) => {
    const ch = s(p.CHAIN), ad = s(p.ADDRESS), pk = s(p.PUBLIC_KEY), kp = s(p.KEY_PATH);
    const sg = s(p.SIGNATURE), sp = s(p.SIGNED_PAYLOAD), al = s(p.ALGORITHM), en = s(p.ENCODING);
    CP.startChainProof(B);
    if (ch) CP.addChain(B, ch);
    if (ad) CP.addAddress(B, ad);
    if (pk) CP.addPublicKey(B, pk);
    if (kp) CP.addKeyPath(B, kp);
    if (sg) CP.addSignature(B, sg);
    if (sp) CP.addSignedPayload(B, sp);
    if (al) CP.addAlgorithm(B, al);
    if (en) CP.addEncoding(B, en);
    return CP.endChainProof(B);
  });
  const proofsVec = proofOffsets.length ? E.createChainProofsVector(B, proofOffsets) : null;

  // §3: producers MUST emit vectors in canonical order so an independent
  // reconstruction is byte-identical. Reuse the same normalization the
  // preimage uses (trim, drop empties, dedupe, sort).
  const canonAlt = strVector(record.ALTERNATE_NAMES) || [];
  const canonMulti = strVector(record.MULTIFORMAT_ADDRESS) || [];
  const altVec = canonAlt.length
    ? E.createAlternateNamesVector(B, canonAlt.map((v) => B.createString(v))) : null;
  const multiVec = canonMulti.length
    ? E.createMultiformatAddressVector(B, canonMulti.map((v) => B.createString(v))) : null;

  let addrOff = null;
  if (record.ADDRESS && Object.values(record.ADDRESS).some((v) => v && String(v).trim())) {
    const co = s(record.ADDRESS.COUNTRY), re = s(record.ADDRESS.REGION), lo = s(record.ADDRESS.LOCALITY);
    const pc = s(record.ADDRESS.POSTAL_CODE), st = s(record.ADDRESS.STREET), pb = s(record.ADDRESS.POST_OFFICE_BOX_NUMBER);
    AD.startAddress(B);
    if (co) AD.addCountry(B, co); if (re) AD.addRegion(B, re); if (lo) AD.addLocality(B, lo);
    if (pc) AD.addPostalCode(B, pc); if (st) AD.addStreet(B, st); if (pb) AD.addPostOfficeBoxNumber(B, pb);
    addrOff = AD.endAddress(B);
  }

  const dn = s(record.DN), ln = s(record.LEGAL_NAME), fn = s(record.FAMILY_NAME), gn = s(record.GIVEN_NAME);
  const an = s(record.ADDITIONAL_NAME), hp = s(record.HONORIFIC_PREFIX), hs = s(record.HONORIFIC_SUFFIX);
  const jt = s(record.JOB_TITLE), oc = s(record.OCCUPATION), em = s(record.EMAIL), tel = s(record.TELEPHONE);
  const sig = s(record.SIGNATURE), sal = s(record.SIGNATURE_ALGORITHM);

  E.startEPM(B);
  if (dn) E.addDn(B, dn);
  if (ln) E.addLegalName(B, ln);
  if (fn) E.addFamilyName(B, fn);
  if (gn) E.addGivenName(B, gn);
  if (an) E.addAdditionalName(B, an);
  if (hp) E.addHonorificPrefix(B, hp);
  if (hs) E.addHonorificSuffix(B, hs);
  if (jt) E.addJobTitle(B, jt);
  if (oc) E.addOccupation(B, oc);
  if (addrOff !== null) E.addAddress(B, addrOff);
  if (altVec !== null) E.addAlternateNames(B, altVec);
  if (em) E.addEmail(B, em);
  if (tel) E.addTelephone(B, tel);
  if (keysVec !== null) E.addKeys(B, keysVec);
  if (multiVec !== null) E.addMultiformatAddress(B, multiVec);
  if (sig) E.addSignature(B, sig);
  if (record.SIGNATURE_TIMESTAMP) E.addSignatureTimestamp(B, BigInt(record.SIGNATURE_TIMESTAMP));
  if (proofsVec !== null) E.addChainProofs(B, proofsVec);
  E.addEntityType(B, record.ENTITY_TYPE === "Node" ? EntityType.Node : EntityType.User);
  if (sal && E.addSignatureAlgorithm) E.addSignatureAlgorithm(B, sal);
  const off = E.endEPM(B);
  E.finishSizePrefixedEPMBuffer(B, off);
  return B.asUint8Array();
}

/** Decode size-prefixed "$EPM" bytes back to a plain object.
 *  Note: generated getters are UPPER_SNAKE on the instance, while the static
 *  builder methods are camelCase (addDn). */
export function decodeEPM(bytes) {
  const buf = new flatbuffers.ByteBuffer(bytes);
  const e = EPMMod.EPM.getSizePrefixedRootAsEPM(buf);
  const out = {
    DN: e.DN(), LEGAL_NAME: e.LEGAL_NAME(), FAMILY_NAME: e.FAMILY_NAME(), GIVEN_NAME: e.GIVEN_NAME(),
    ADDITIONAL_NAME: e.ADDITIONAL_NAME(), HONORIFIC_PREFIX: e.HONORIFIC_PREFIX(),
    HONORIFIC_SUFFIX: e.HONORIFIC_SUFFIX(), JOB_TITLE: e.JOB_TITLE(), OCCUPATION: e.OCCUPATION(),
    EMAIL: e.EMAIL(), TELEPHONE: e.TELEPHONE(), SIGNATURE: e.SIGNATURE(),
    SIGNATURE_TIMESTAMP: Number(e.SIGNATURE_TIMESTAMP?.() ?? 0),
    ENTITY_TYPE: e.ENTITY_TYPE() === EntityType.Node ? "Node" : "User",
    SIGNATURE_ALGORITHM: e.SIGNATURE_ALGORITHM?.() || undefined,
    ALTERNATE_NAMES: [], MULTIFORMAT_ADDRESS: [], KEYS: [], CHAIN_PROOFS: [],
  };
  const a = e.ADDRESS?.();
  if (a) out.ADDRESS = {
    COUNTRY: a.COUNTRY(), REGION: a.REGION(), LOCALITY: a.LOCALITY(),
    POSTAL_CODE: a.POSTAL_CODE(), STREET: a.STREET(), POST_OFFICE_BOX_NUMBER: a.POST_OFFICE_BOX_NUMBER(),
  };
  for (let i = 0; i < e.alternateNamesLength(); i++) out.ALTERNATE_NAMES.push(e.ALTERNATE_NAMES(i));
  for (let i = 0; i < e.multiformatAddressLength(); i++) out.MULTIFORMAT_ADDRESS.push(e.MULTIFORMAT_ADDRESS(i));
  for (let i = 0; i < e.keysLength(); i++) {
    const k = e.KEYS(i);
    out.KEYS.push({
      PUBLIC_KEY: k.PUBLIC_KEY(), XPUB: k.XPUB(), KEY_ADDRESS: k.KEY_ADDRESS(),
      ADDRESS_TYPE: k.ADDRESS_TYPE(), KEY_PATH: k.KEY_PATH?.(), ALGORITHM: k.ALGORITHM?.(),
      ENCODING: k.ENCODING?.(), KEY_TYPE: k.KEY_TYPE() === KeyType.Encryption ? "Encryption" : "Signing",
    });
  }
  for (let i = 0; i < e.chainProofsLength(); i++) {
    const p = e.CHAIN_PROOFS(i);
    out.CHAIN_PROOFS.push({
      CHAIN: p.CHAIN(), ADDRESS: p.ADDRESS(), PUBLIC_KEY: p.PUBLIC_KEY(), KEY_PATH: p.KEY_PATH(),
      SIGNATURE: p.SIGNATURE(), SIGNED_PAYLOAD: p.SIGNED_PAYLOAD(), ALGORITHM: p.ALGORITHM(), ENCODING: p.ENCODING(),
    });
  }
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return out;
}

/* ---------------- CID (raw CIDv1, sha2-256) ---------------- */
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(u8) {
  let bits = 0, value = 0, out = "";
  for (const b of u8) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
/** raw CIDv1 sha2-256 — matches the PNM announcement in the SDN spec. */
export async function cidV1Raw(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const prefix = new Uint8Array([0x01, 0x55, 0x12, 0x20]); // cidv1, raw, sha2-256, len 32
  const full = new Uint8Array(prefix.length + digest.length);
  full.set(prefix); full.set(digest, prefix.length);
  return "b" + base32(full); // multibase base32lower
}

/* ---------------- vCard ---------------- */
const esc = (v) => String(v || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
/** Fold long lines at 75 octets per RFC 6350. */
function fold(line) {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) { parts.push(" " + rest.slice(0, 74)); rest = rest.slice(74); }
  if (rest) parts.push(" " + rest);
  return parts.join("\r\n");
}

/**
 * Export a signed EPM as a vCard. Per the SDN trust model,
 * X-SDN-EPM-B64 carries the complete signed EPM bytes and is the source of
 * truth — importers must prefer it over mutable display fields like FN/ORG.
 */
export async function toVCard(record, { peerId = null, directoryKind = "user" } = {}) {
  const bytes = encodeEPM(record);
  const cid = await cidV1Raw(bytes);
  const name = record.LEGAL_NAME || [record.GIVEN_NAME, record.FAMILY_NAME].filter(Boolean).join(" ") || record.DN || "SDN Entity";
  const L = [
    "BEGIN:VCARD", "VERSION:4.0",
    `FN:${esc(name)}`,
    `N:${esc(record.FAMILY_NAME)};${esc(record.GIVEN_NAME)};${esc(record.ADDITIONAL_NAME)};${esc(record.HONORIFIC_PREFIX)};${esc(record.HONORIFIC_SUFFIX)}`,
  ];
  if (record.JOB_TITLE) L.push(`TITLE:${esc(record.JOB_TITLE)}`);
  if (record.OCCUPATION) L.push(`ROLE:${esc(record.OCCUPATION)}`);
  if (record.EMAIL) L.push(`EMAIL:${esc(record.EMAIL)}`);
  if (record.TELEPHONE) L.push(`TEL:${esc(record.TELEPHONE)}`);
  if (record.ADDRESS) {
    const a = record.ADDRESS;
    L.push(`ADR:${esc(a.POST_OFFICE_BOX_NUMBER)};;${esc(a.STREET)};${esc(a.LOCALITY)};${esc(a.REGION)};${esc(a.POSTAL_CODE)};${esc(a.COUNTRY)}`);
  }
  for (const alt of record.ALTERNATE_NAMES || []) L.push(`NICKNAME:${esc(alt)}`);
  if (record.DN) L.push(`X-SDN-DN:${esc(record.DN)}`);
  // SDN extensions — X-SDN-EPM-B64 is the source of truth
  L.push(fold(`X-SDN-EPM-B64:${b64(bytes)}`));
  L.push(`X-SDN-EPM-CID:${cid}`);
  if (record.SIGNATURE) L.push(fold(`X-SDN-EPM-SIGNATURE:${record.SIGNATURE}`));
  if (record.SIGNATURE_TIMESTAMP) L.push(`X-SDN-EPM-SIGNATURE-TIMESTAMP:${record.SIGNATURE_TIMESTAMP}`);
  if (peerId) L.push(`X-SDN-PEER-ID:${esc(peerId)}`);
  L.push(`X-SDN-DIRECTORY-KIND:${esc(directoryKind)}`);
  L.push("END:VCARD");
  return { vcard: L.join("\r\n") + "\r\n", cid, bytes };
}

/** Parse a vCard, preferring the embedded signed EPM payload. */
export function fromVCard(text) {
  // unfold RFC 6350 continuation lines
  const unfolded = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  const m = unfolded.match(/^X-SDN-EPM-B64:(.+)$/mi);
  if (!m) return { record: null, reason: "no X-SDN-EPM-B64 in vCard" };
  try {
    return { record: decodeEPM(unb64(m[1].trim())), reason: "" };
  } catch (e) {
    return { record: null, reason: "could not decode embedded EPM: " + e.message };
  }
}

// ====== $SPACE Trust Graph — real on-chain data + trust rule engine ======
import { Connection, PublicKey, Transaction } from "https://esm.sh/@solana/web3.js@1.95.2";
import {
  getAssociatedTokenAddress, createTransferInstruction,
  createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID,
} from "https://esm.sh/@solana/spl-token@0.4.8";
import * as SDS from "./sds-store.js";

const MINT_STR = "Ge5rnW2w6EzSh3EkQWxH76P8LEjEJE7qe7entq9pLQ3F";
const MINT = new PublicKey(MINT_STR);
const DECIMALS = 6;
const POOL = "6scs7WHhyjY3UJWL1LaXbLLVsotBLcL4Ko6Vc65C3x8z";
// api.mainnet-beta.solana.com returns 403 to browser origins — these allow CORS.
const RPC_FALLBACKS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];
const DEFAULT_RPC = RPC_FALLBACKS[0];

const $ = (id) => document.getElementById(id);
const short = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "—");
const fmtC = (n) => n == null ? "—" : n >= 1e9 ? (n/1e9).toFixed(2)+"B" : n >= 1e6 ? (n/1e6).toFixed(2)+"M" : n >= 1e3 ? (n/1e3).toFixed(1)+"K" : String(Math.round(n));

let provider = null, wallet = null, connection = null, oldestSig = null, totalMoved = 0;

function toast(msg, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3600);
}
function conn() {
  const url = ($("rpc").value || "").trim() || DEFAULT_RPC;
  if (!connection || connection.rpcEndpoint !== url) connection = new Connection(url, "confirmed");
  return connection;
}

/* ---------- tabs ---------- */
document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll(".tabpane").forEach((p) =>
      p.classList.toggle("on", p.id === "pane-" + b.dataset.tab));
  }));

/* ---------- wallet ---------- */
const getProv = () => window.solana?.isPhantom ? window.solana
  : window.solflare?.isSolflare ? window.solflare : window.solana || null;

$("connectBtn").addEventListener("click", async () => {
  if (wallet) {
    try { await provider.disconnect(); } catch {}
    provider = null; wallet = null;
    $("connectBtn").textContent = "Connect wallet";
    $("sendBtn").disabled = true; $("myHistoryBtn").disabled = true;
    Graph.setYou(null);
    return toast("Disconnected");
  }
  const p = getProv();
  if (!p) return toast("No Solana wallet found — install Phantom or Solflare", true);
  try {
    await p.connect();
    provider = p; wallet = p.publicKey.toString();
    $("connectBtn").textContent = short(wallet);
    $("sendBtn").disabled = false; $("myHistoryBtn").disabled = false;
    Graph.setYou(wallet);
    if (!SDS.byStandard("EPM").some((r) => r.address === wallet)) {
      SDS.addRecord(SDS.makeEPM({ address: wallet, label: "Connected wallet" }));
    }
    renderRecords();
    toast("Wallet connected");
  } catch { toast("Connection rejected", true); }
});

/* ---------- read real transfers ---------- */
function netByOwner(meta) {
  const net = new Map();
  const apply = (list, sign) => {
    for (const b of list || []) {
      if (b.mint !== MINT_STR || !b.owner) continue;
      net.set(b.owner, (net.get(b.owner) || 0) + Number(b.uiTokenAmount?.uiAmount || 0) * sign);
    }
  };
  apply(meta.preTokenBalances, -1);
  apply(meta.postTokenBalances, +1);
  return net;
}

async function loadChain(append = false) {
  $("syncInfo").textContent = "Reading $SPACE transfers…";
  try {
    const c = conn();
    const sigs = await c.getSignaturesForAddress(MINT, { limit: 12, ...(append && oldestSig ? { before: oldestSig } : {}) });
    if (!sigs.length) { Graph.hideSpinner(); $("syncInfo").textContent = append ? "No older transfers" : "Nothing returned — try a custom RPC"; return; }
    oldestSig = sigs[sigs.length - 1].signature;

    const txs = await Promise.all(sigs.map((s) =>
      c.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
        .then((t) => ({ sig: s.signature, t })).catch(() => null)));

    let n = 0;
    for (const it of txs) {
      if (!it?.t?.meta) continue;
      const net = netByOwner(it.t.meta);
      const senders = [], receivers = [];
      for (const [o, d] of net) (d < -1e-9 ? senders : d > 1e-9 ? receivers : []).push?.([o, Math.abs(d)]);
      senders.sort((a, b) => b[1] - a[1]); receivers.sort((a, b) => b[1] - a[1]);
      for (const [from, out] of senders) {
        let rem = out;
        for (const r of receivers) {
          if (rem <= 1e-9) break;
          const take = Math.min(rem, r[1]);
          if (take > 1e-9 && from !== r[0]) {
            Graph.addNode(from, { pool: from === POOL });
            Graph.addNode(r[0], { pool: r[0] === POOL });
            Graph.addEdge(from, r[0], take, it.sig);
            totalMoved += take; rem -= take; n++;
          }
        }
      }
    }
    Graph.hideSpinner(); renderStats();
    $("syncInfo").textContent = `${Graph.edgeCount()} transfers · ${Graph.nodeCount()} wallets mapped`;
    if (!n && !append) toast("No transfers parsed — a custom RPC gives better results", true);
  } catch (e) {
    Graph.hideSpinner();
    $("syncInfo").textContent = "Chain read failed";
    toast("RPC error — public endpoints rate-limit hard. Add your own above.", true);
  }
}
$("reloadBtn").addEventListener("click", () => { Graph.reset(); totalMoved = 0; oldestSig = null; Graph.showSpinner(); loadChain(); });
$("moreBtn").addEventListener("click", () => loadChain(true));

$("myHistoryBtn").addEventListener("click", async () => {
  if (!wallet) return toast("Connect a wallet first", true);
  try {
    $("syncInfo").textContent = "Reading your transfers…";
    const c = conn();
    const ata = await getAssociatedTokenAddress(MINT, new PublicKey(wallet));
    const sigs = await c.getSignaturesForAddress(ata, { limit: 15 });
    let n = 0;
    for (const s of sigs) {
      const t = await c.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (!t?.meta) continue;
      const net = netByOwner(t.meta);
      const mine = net.get(wallet) || 0;
      if (Math.abs(mine) < 1e-9) continue;
      const cp = [...net.entries()]
        .filter(([o, d]) => o !== wallet && Math.sign(d) !== Math.sign(mine) && Math.abs(d) > 1e-9)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
      if (!cp) continue;
      const from = mine < 0 ? wallet : cp[0], to = mine < 0 ? cp[0] : wallet;
      Graph.addNode(from, { pool: from === POOL }); Graph.addNode(to, { pool: to === POOL });
      Graph.addEdge(from, to, Math.abs(mine), s.signature);
      totalMoved += Math.abs(mine); n++;
    }
    Graph.hideSpinner(); renderStats();
    $("syncInfo").textContent = `${Graph.edgeCount()} transfers · ${Graph.nodeCount()} wallets mapped`;
    toast(n ? `Mapped ${n} of your transfers` : "No $SPACE transfers found");
  } catch (e) { toast("Failed: " + (e.message || e), true); }
});

/* ---------- send (TRE) ---------- */
$("sendBtn").addEventListener("click", async () => {
  const to = $("toAddr").value.trim(), amt = parseFloat($("amount").value);
  if (!to || !(amt > 0)) return toast("Enter a recipient and amount", true);
  let toPub; try { toPub = new PublicKey(to); } catch { return toast("Invalid address", true); }
  if (!provider) return toast("Connect a wallet first", true);
  try {
    const c = conn();
    const fromAta = await getAssociatedTokenAddress(MINT, provider.publicKey);
    const toAta = await getAssociatedTokenAddress(MINT, toPub);
    const bal = await c.getTokenAccountBalance(fromAta).catch(() => null);
    if (!bal?.value) return toast("This wallet holds no $SPACE", true);
    if (Number(bal.value.uiAmount) < amt) return toast(`Only ${bal.value.uiAmount} $SPACE available`, true);

    const tx = new Transaction();
    if (!(await c.getAccountInfo(toAta)))
      tx.add(createAssociatedTokenAccountInstruction(provider.publicKey, toAta, toPub, MINT));
    tx.add(createTransferInstruction(fromAta, toAta, provider.publicKey,
      BigInt(Math.round(amt * 10 ** DECIMALS)), [], TOKEN_PROGRAM_ID));
    tx.feePayer = provider.publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;

    const res = await provider.signAndSendTransaction(tx);
    const sig = res?.signature || res;
    Graph.addNode(wallet); Graph.addNode(to);
    Graph.addEdge(wallet, to, amt, sig);
    totalMoved += amt; Graph.hideSpinner(); renderStats();
    SDS.addRecord(SDS.makeTRE({ issuer: wallet, subject: to, amount: amt, mint: MINT_STR, signature: sig, note: $("note").value.trim() }));
    renderRecords();
    $("toAddr").value = $("amount").value = $("note").value = "";
    toast(`Sent ${amt} $SPACE → ${short(to)}`);
  } catch (e) { toast("Send failed: " + (e.message || e), true); }
});

/* ---------- revoke (TNR) ---------- */
SDS.REVOCATION_REASONS.forEach(([v, l]) => $("revokeReason").add(new Option(l, v)));
$("revokeBtn").addEventListener("click", () => {
  const subject = $("revokeAddr").value.trim();
  if (!subject) return toast("Enter the wallet to revoke", true);
  if (!wallet) return toast("Connect a wallet — a revocation is issued by your key", true);
  const existing = SDS.activeTrust().find((r) => r.issuer === wallet && r.subject === subject);
  SDS.addRecord(SDS.makeTNR({ issuer: wallet, subject, revokes: existing?.id || null,
    reason: $("revokeReason").value, note: $("revokeNote").value.trim() }));
  Graph.revoke(wallet, subject);
  renderRecords();
  $("revokeAddr").value = $("revokeNote").value = "";
  toast(`Trust revoked for ${short(subject)}`);
});

/* ---------- rule engine (TRP) ---------- */
let rules = (SDS.byStandard("TRP").slice(-1)[0]?.rules) || [];

Object.entries(SDS.RULE_TYPES).forEach(([k, v]) =>
  $("ruleType").add(new Option(`${v.label}${v.unit ? " (" + v.unit + ")" : ""}`, k)));
$("ruleType").addEventListener("change", () => {
  $("ruleThreshold").value = SDS.RULE_TYPES[$("ruleType").value].def;
});
$("ruleThreshold").value = SDS.RULE_TYPES[$("ruleType").value].def;

function saveRules() {
  SDS.addRecord(SDS.makeTRP({ name: "Trust policy", issuer: wallet, rules }));
  renderRules(); renderRecords();
}
function renderRules() {
  $("ruleCount").textContent = `${rules.length} rule${rules.length === 1 ? "" : "s"}`;
  const dep = $("ruleDep");
  dep.innerHTML = '<option value="">— always apply —</option>';
  rules.forEach((r) => dep.add(new Option(r.label, r.ruleId)));
  $("rulesList").innerHTML = rules.length
    ? rules.map((r) => {
        const parent = rules.find((x) => x.ruleId === r.dependsOn);
        return `<div class="rule">
          <span class="rule-mode ${r.mode === "REQUIRE" ? "req" : "sco"}">${r.mode === "REQUIRE" ? "GATE" : "×" + r.weight}</span>
          <div><b>${r.label}</b> <span class="rule-cmp">${r.cmp} ${r.threshold}${r.unit ? " " + r.unit : ""}</span>
          ${parent ? `<small>only if “${parent.label}” passes</small>` : ""}</div>
          <button class="copy rec-del" data-rule="${r.ruleId}">✕</button></div>`;
      }).join("")
    : '<p class="rec-empty">No rules yet — add one, or load a preset.</p>';
  $("rulesList").querySelectorAll("[data-rule]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.rule;
      rules = rules.filter((r) => r.ruleId !== id).map((r) => r.dependsOn === id ? { ...r, dependsOn: null } : r);
      saveRules();
    }));
}
$("addRuleBtn").addEventListener("click", () => {
  try {
    rules.push(SDS.makeRule({
      type: $("ruleType").value,
      threshold: $("ruleType").value === "REQUIRE_CERT" ? true : parseFloat($("ruleThreshold").value),
      mode: $("ruleMode").value, weight: parseFloat($("ruleWeight").value) || 1,
      dependsOn: $("ruleDep").value || null,
    }));
    saveRules(); toast("Rule added");
  } catch (e) { toast(e.message, true); }
});
$("presetBtn").addEventListener("click", () => {
  const bond = SDS.makeRule({ type: "MIN_BOND", threshold: 1000, mode: "REQUIRE" });
  const chains = SDS.makeRule({ type: "MIN_CHAINS", threshold: 3, mode: "SCORE", weight: 2, dependsOn: bond.ruleId });
  rules = [
    bond, chains,
    SDS.makeRule({ type: "MAX_CONCENTRATION", threshold: 60, mode: "SCORE", weight: 2, dependsOn: chains.ruleId }),
    SDS.makeRule({ type: "MIN_DURATION", threshold: 30, mode: "SCORE", weight: 3 }),
    SDS.makeRule({ type: "MAX_KEY_AGE", threshold: 365, mode: "SCORE", weight: 1 }),
    SDS.makeRule({ type: "MIN_ENDORSEMENTS", threshold: 1, mode: "SCORE", weight: 1 }),
  ];
  saveRules(); toast("Loaded whitepaper preset");
});
$("clearRulesBtn").addEventListener("click", () => { rules = []; saveRules(); toast("Rules cleared"); });

/* ---------- evaluate ---------- */
$("evalBtn").addEventListener("click", async () => {
  const addr = $("evalAddr").value.trim();
  if (!addr) return toast("Enter a wallet to evaluate", true);
  if (!rules.length) return toast("Add rules first — try the preset", true);
  $("evalOut").innerHTML = '<p class="rec-empty">Gathering signals…</p>';
  const signals = await gatherSignals(addr);
  const res = SDS.evaluatePolicy(rules, signals);
  $("evalOut").innerHTML = `
    <div class="verdict v-${res.verdict.toLowerCase()}">
      <b>${res.score}</b><span>${res.verdict}</span></div>
    <div class="sig-row">${Object.entries(signals).map(([k, v]) =>
      `<span><i>${k}</i>${v === null ? "—" : typeof v === "number" ? (k === "concentration" ? Math.round(v*100)+"%" : fmtC(v)) : v}</span>`).join("")}</div>
    ${res.results.map((r) => `<div class="ev ev-${r.status.toLowerCase()}">
        <span class="ev-dot"></span>
        <div><b>${r.rule.label}</b> <small>${r.rule.cmp} ${r.rule.threshold}${r.rule.unit ? " "+r.rule.unit : ""}${r.value !== null ? ` · actual ${r.rule.signal === "concentration" ? r.value+"%" : r.value}` : ""}${r.reason ? " · " + r.reason : ""}</small></div>
        <span class="ev-status">${r.status}</span></div>`).join("")}`;
});

/** Real, observable signals for a wallet. Unknown signals stay null so the
 *  engine reports UNKNOWN rather than inventing data. */
async function gatherSignals(addr) {
  const s = { value: null, chains: null, concentration: null, durationDays: null, keyAgeDays: null, endorsements: 0, hasCert: false };
  try {
    const c = conn();
    const pub = new PublicKey(addr);
    const sol = await c.getBalance(pub);
    const accts = await c.getParsedTokenAccountsByOwner(pub, { programId: TOKEN_PROGRAM_ID });
    const solUsd = await fetch("https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112")
      .then((r) => r.json()).then((j) => parseFloat(j.pairs?.[0]?.priceUsd) || 0).catch(() => 0);
    const spaceUsd = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + MINT_STR)
      .then((r) => r.json()).then((j) => parseFloat(j.pairs?.[0]?.priceUsd) || 0).catch(() => 0);

    const solVal = (sol / 1e9) * solUsd;
    let spaceVal = 0;
    for (const a of accts.value) {
      const info = a.account.data.parsed.info;
      if (info.mint === MINT_STR) spaceVal += Number(info.tokenAmount.uiAmount || 0) * spaceUsd;
    }
    s.value = solVal + spaceVal;
    // this page can only observe Solana — one chain
    s.chains = s.value > 0 ? 1 : 0;
    s.concentration = s.value > 0 ? Math.max(solVal, spaceVal) / s.value : null;

    const sigs = await c.getSignaturesForAddress(pub, { limit: 1000 }).catch(() => []);
    if (sigs.length) {
      const newest = sigs[0].blockTime, oldest = sigs[sigs.length - 1].blockTime;
      const now = Date.now() / 1000;
      if (newest) s.durationDays = Math.floor((now - newest) / 86400);
      if (oldest) s.keyAgeDays = Math.floor((now - oldest) / 86400);
    }
  } catch (e) { console.warn("signal gather failed", e); }
  s.endorsements = SDS.activeTrust().filter((r) => r.subject === addr).length;
  return s;
}

/* ---------- records + backup ---------- */
function renderStats() {
  $("n-wallets").textContent = Graph.nodeCount();
  $("n-edges").textContent = Graph.edgeCount();
  $("n-volume").textContent = fmtC(totalMoved);
}
function renderRecords() {
  const all = SDS.loadAll();
  $("recCount").textContent = all.length;
  $("recordsList").innerHTML = all.length
    ? all.slice().reverse().map((r) => {
        let body = "";
        if (r.STANDARD === "TRE") body = `${short(r.issuer)} → ${short(r.subject)} · ${fmtC(r.assertion.amount)} $SPACE`;
        else if (r.STANDARD === "TNR") body = `${short(r.issuer)} ⊘ ${short(r.subject)} · ${r.reason}`;
        else if (r.STANDARD === "EPM") body = `${short(r.address)} · ${r.curve}`;
        else if (r.STANDARD === "PNM") body = `CID ${r.cid?.slice(0, 16)}… · ${r.recordCount} records`;
        else if (r.STANDARD === "TRP") body = `${r.name} · ${r.rules?.length || 0} rules`;
        return `<div class="rec ${r.status === "REVOKED" ? "rec-revoked" : ""}">
          <span class="rec-tag rec-${r.STANDARD.toLowerCase()}">${r.STANDARD}</span>
          <div class="rec-body"><b>${body}</b><small>${new Date(r.issuedAt).toLocaleString()}${r.note ? " · " + r.note : ""}${r.status === "REVOKED" ? " · REVOKED" : ""}</small></div>
          <button class="copy rec-del" data-del="${r.id}">✕</button></div>`;
      }).join("")
    : '<p class="rec-empty">No records yet.</p>';
  $("recordsList").querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => { SDS.removeRecord(b.dataset.del); renderRecords(); }));
}
const out = (html) => ($("backupOut").innerHTML = html);
const need = () => { const a = SDS.loadAll(); if (!a.length) { toast("No records to back up", true); return null; } return a; };

$("dlBtn").addEventListener("click", () => {
  const all = need(); if (!all) return;
  const url = URL.createObjectURL(SDS.toBlob(all));
  const a = document.createElement("a");
  a.href = url; a.download = SDS.suggestedFilename(); a.click();
  URL.revokeObjectURL(url);
  out(`Downloaded ${all.length} records ✓`); toast("Downloaded");
});

$("ipfsBtn").addEventListener("click", async () => {
  const all = need(); if (!all) return;
  const api = $("ipfsApi").value.trim(), token = $("ipfsToken").value.trim();
  if (!api && !token) { out("Add an IPFS endpoint or pinning token in Backup settings."); return; }
  try {
    out("Pinning to IPFS…");
    const fd = new FormData();
    fd.append("file", SDS.toBlob(all), SDS.suggestedFilename());
    let cid, gateway;
    if (token) {
      const r = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
        method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
      if (!r.ok) throw new Error("Pinata " + r.status);
      cid = (await r.json()).IpfsHash; gateway = "https://gateway.pinata.cloud/ipfs/" + cid;
    } else {
      const r = await fetch(api.replace(/\/$/, "") + "/api/v0/add?pin=true", { method: "POST", body: fd });
      if (!r.ok) throw new Error("IPFS node " + r.status);
      cid = (await r.json()).Hash; gateway = "https://ipfs.io/ipfs/" + cid;
    }
    SDS.addRecord(SDS.makePNM({ cid, gateway, count: all.length, issuer: wallet }));
    renderRecords();
    out(`Pinned ✓ <a href="${gateway}" target="_blank" rel="noopener">${cid}</a> — PNM record created`);
    toast("Pinned to IPFS");
  } catch (e) { out("IPFS failed: " + (e.message || e) + " — check CORS/auth."); toast("IPFS pin failed", true); }
});

$("s3Btn").addEventListener("click", async () => {
  const all = need(); if (!all) return;
  const url = $("s3Url").value.trim();
  if (!url) { out("Add a presigned PUT URL in Backup settings."); return; }
  try {
    out("Uploading to S3…");
    const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: SDS.toBlob(all) });
    if (!r.ok) throw new Error("S3 " + r.status);
    out(`Uploaded ${all.length} records to S3 ✓`); toast("Backed up to S3");
  } catch (e) { out("S3 failed: " + (e.message || e) + " — URL may be expired, or CORS blocks PUT."); toast("S3 upload failed", true); }
});

$("gdBtn").addEventListener("click", () => {
  const all = need(); if (!all) return;
  const cid = $("gdClient").value.trim();
  if (!cid) { out("Add your Google OAuth client ID in Backup settings."); return; }
  if (!window.google?.accounts?.oauth2) { out("Google Identity script didn't load."); return; }
  google.accounts.oauth2.initTokenClient({
    client_id: cid, scope: "https://www.googleapis.com/auth/drive.file",
    callback: async (resp) => {
      if (!resp.access_token) return out("Authorization failed.");
      try {
        out("Uploading to Drive…");
        const fd = new FormData();
        fd.append("metadata", new Blob([JSON.stringify({ name: SDS.suggestedFilename(), mimeType: "application/json" })], { type: "application/json" }));
        fd.append("file", SDS.toBlob(all));
        const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
          method: "POST", headers: { Authorization: "Bearer " + resp.access_token }, body: fd });
        if (!r.ok) throw new Error("Drive " + r.status);
        const j = await r.json();
        out(`Uploaded ✓ <a href="https://drive.google.com/file/d/${j.id}" target="_blank" rel="noopener">open in Drive</a>`);
        toast("Backed up to Drive");
      } catch (e) { out("Drive failed: " + (e.message || e)); }
    },
  }).requestAccessToken();
});

$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const r = SDS.importArchive(JSON.parse(await f.text()));
    rules = SDS.byStandard("TRP").slice(-1)[0]?.rules || rules;
    renderRecords(); renderRules();
    out(`Imported ${r.added} records (${r.total} total) ✓`); toast("Imported");
  } catch (err) { out("Import failed: " + err.message); toast("Import failed", true); }
  e.target.value = "";
});
$("captureBtn").addEventListener("click", () => {
  const top = Graph.topEdges(25);
  if (!top.length) return toast("No transfers in the graph yet", true);
  top.forEach((e) => SDS.addRecord(SDS.makeTRE({
    issuer: e.from, subject: e.to, amount: e.amt, mint: MINT_STR, signature: e.sig || null, source: "onchain" })));
  renderRecords(); toast(`Captured ${top.length} transfers as TRE`);
});
$("wipeBtn").addEventListener("click", () => { SDS.clearAll(); rules = []; renderRecords(); renderRules(); toast("Local records cleared"); });

/* ---------- graph ---------- */
const Graph = (() => {
  const canvas = $("graph"), ctx = canvas.getContext("2d");
  let W = 0, H = 0, you = null;
  const nodes = new Map(), edges = new Map(), revoked = new Set();
  function resize() {
    const dpr = devicePixelRatio || 1, r = canvas.getBoundingClientRect();
    W = r.width; H = r.height; canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(canvas);

  const addNode = (id, o = {}) => {
    if (nodes.has(id)) { if (o.pool) nodes.get(id).pool = true; return nodes.get(id); }
    const n = { id, x: W/2+(Math.random()-.5)*160, y: H/2+(Math.random()-.5)*160, vx: 0, vy: 0, r: o.pool ? 17 : 10, pool: !!o.pool, w: 0 };
    nodes.set(id, n); return n;
  };
  const addEdge = (from, to, amt, sig) => {
    const k = from + ">" + to;
    edges.has(k) ? (edges.get(k).amt += amt) : edges.set(k, { from, to, amt, sig });
    nodes.get(from) && (nodes.get(from).w += amt);
    nodes.get(to) && (nodes.get(to).w += amt);
  };
  function step() {
    const arr = [...nodes.values()];
    for (const a of arr) for (const b of arr) {
      if (a === b) continue;
      const dx = a.x-b.x, dy = a.y-b.y, d2 = dx*dx+dy*dy || .01, d = Math.sqrt(d2), f = 5200/d2;
      a.vx += dx/d*f; a.vy += dy/d*f;
    }
    for (const e of edges.values()) {
      const a = nodes.get(e.from), b = nodes.get(e.to); if (!a || !b) continue;
      const dx = b.x-a.x, dy = b.y-a.y, d = Math.hypot(dx, dy) || .01, f = .01*(d-130);
      a.vx += dx/d*f; a.vy += dy/d*f; b.vx -= dx/d*f; b.vy -= dy/d*f;
    }
    for (const n of arr) {
      n.vx += (W/2-n.x)*.0009; n.vy += (H/2-n.y)*.0009;
      n.vx *= .85; n.vy *= .85; n.x += n.vx; n.y += n.vy;
      n.x = Math.max(n.r+8, Math.min(W-n.r-8, n.x)); n.y = Math.max(n.r+8, Math.min(H-n.r-8, n.y));
    }
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    const max = Math.max(1, ...[...edges.values()].map((e) => e.amt));
    for (const e of edges.values()) {
      const a = nodes.get(e.from), b = nodes.get(e.to); if (!a || !b) continue;
      const rev = revoked.has(e.from + ">" + e.to);
      ctx.save();
      if (rev) { ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(255,107,107,.6)"; }
      else { const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        g.addColorStop(0, "rgba(110,168,255,.45)"); g.addColorStop(1, "rgba(255,194,92,.6)"); ctx.strokeStyle = g; }
      ctx.lineWidth = 1 + (e.amt/max)*4.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.restore();
      const ang = Math.atan2(b.y-a.y, b.x-a.x), bx = b.x-Math.cos(ang)*(b.r+3), by = b.y-Math.sin(ang)*(b.r+3);
      ctx.fillStyle = rev ? "rgba(255,107,107,.85)" : "rgba(255,194,92,.85)";
      ctx.beginPath(); ctx.moveTo(bx, by);
      ctx.lineTo(bx-Math.cos(ang-.4)*8, by-Math.sin(ang-.4)*8);
      ctx.lineTo(bx-Math.cos(ang+.4)*8, by-Math.sin(ang+.4)*8);
      ctx.closePath(); ctx.fill();
    }
    for (const n of nodes.values()) {
      const isYou = n.id === you, rad = isYou ? n.r+5 : n.r;
      ctx.shadowColor = isYou ? "rgba(70,224,200,.9)" : n.pool ? "rgba(201,139,255,.6)" : "rgba(110,168,255,.45)";
      ctx.shadowBlur = isYou ? 22 : 10;
      ctx.fillStyle = isYou ? "#46e0c8" : n.pool ? "#c98bff" : "#6ea8ff";
      ctx.beginPath(); ctx.arc(n.x, n.y, rad, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(n.x, n.y, rad, 0, 7); ctx.stroke();
      if (isYou || n.pool || n.w > max*.25) {
        ctx.fillStyle = "#aeb7c9"; ctx.font = "600 10px system-ui,sans-serif"; ctx.textAlign = "center";
        ctx.fillText(isYou ? "you" : n.pool ? "pool" : short(n.id), n.x, n.y+rad+13);
      }
    }
    ctx.textAlign = "start";
  }
  let drag = null;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX-r.left, y: e.clientY-r.top }; };
  const hit = (p) => [...nodes.values()].find((n) => (p.x-n.x)**2+(p.y-n.y)**2 < (n.r+6)**2);
  canvas.addEventListener("mousedown", (e) => (drag = hit(pos(e))));
  addEventListener("mousemove", (e) => {
    if (drag) { const p = pos(e); drag.x = p.x; drag.y = p.y; drag.vx = drag.vy = 0; return; }
    const n = hit(pos(e)); canvas.title = n ? `${n.id}\n${fmtC(n.w)} $SPACE flowed` : "";
  });
  addEventListener("mouseup", () => (drag = null));
  canvas.addEventListener("touchstart", (e) => { const t = e.touches[0], r = canvas.getBoundingClientRect(); drag = hit({ x: t.clientX-r.left, y: t.clientY-r.top }); }, { passive: true });
  canvas.addEventListener("touchmove", (e) => { if (!drag) return; const t = e.touches[0], r = canvas.getBoundingClientRect(); drag.x = t.clientX-r.left; drag.y = t.clientY-r.top; drag.vx = drag.vy = 0; }, { passive: true });
  canvas.addEventListener("touchend", () => (drag = null));
  (function loop() { step(); draw(); requestAnimationFrame(loop); })();
  resize();
  return {
    addNode, addEdge, setYou: (a) => { you = a; if (a) addNode(a); },
    revoke: (f, t) => revoked.add(f + ">" + t),
    nodeCount: () => nodes.size, edgeCount: () => edges.size,
    topEdges: (n) => [...edges.values()].sort((a, b) => b.amt-a.amt).slice(0, n),
    reset: () => { nodes.clear(); edges.clear(); revoked.clear(); if (you) addNode(you); },
    showSpinner: () => ($("graphEmpty").style.display = "flex"),
    hideSpinner: () => ($("graphEmpty").style.display = nodes.size ? "none" : "flex"),
  };
})();

/* ---------- token stats ---------- */
(async function tokenStats() {
  try { $("n-supply").textContent = fmtC((await conn().getTokenSupply(MINT)).value.uiAmount); } catch {}
  try {
    const p = (await (await fetch("https://api.dexscreener.com/latest/dex/tokens/" + MINT_STR)).json()).pairs?.[0];
    if (p) {
      const price = parseFloat(p.priceUsd), mc = parseFloat(p.marketCap || p.fdv);
      $("n-price").textContent = price >= 1 ? "$" + price.toFixed(4) : "$" + price.toPrecision(3);
      $("n-mcap").textContent = mc >= 1e6 ? "$" + (mc/1e6).toFixed(2) + "M" : "$" + (mc/1e3).toFixed(1) + "K";
    }
  } catch {}
})();

renderRules();
renderRecords();
loadChain();

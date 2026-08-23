// ====== Your web of trust — ego graph, TRE levels, signed EPM, signed posts ======
import { Connection, PublicKey, Transaction } from "https://esm.sh/@solana/web3.js@1.95.2";
import {
  getAssociatedTokenAddress, createTransferInstruction,
  createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID,
} from "https://esm.sh/@solana/spl-token@0.4.8";
import * as SDS from "./sds-store.js?v=19";
import * as EPM from "./epm.js?v=19";
import { listWallets, connectTo } from "./wallet.js?v=19";
import { LANG_NAMES, applyLang, t as i18t } from "./i18n.js?v=19";

const MINT_STR = "Ge5rnW2w6EzSh3EkQWxH76P8LEjEJE7qe7entq9pLQ3F";
const MINT = new PublicKey(MINT_STR);
const DECIMALS = 6;
const POOL = "6scs7WHhyjY3UJWL1LaXbLLVsotBLcL4Ko6Vc65C3x8z";
// api.mainnet-beta.solana.com returns 403 to browser origins.
const DEFAULT_RPC = "https://solana-rpc.publicnode.com";

const $ = (id) => document.getElementById(id);
const short = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "—");
const usd = (n) => n == null ? "—" : n >= 1e6 ? "$" + (n/1e6).toFixed(2) + "M"
  : n >= 1e3 ? "$" + (n/1e3).toFixed(1) + "K" : n >= 1 ? "$" + n.toFixed(2) : fmtPrice(n);

/** Sub-penny values use the crypto subscript convention: $0.0(3)102 means
 *  three zeros after the point, i.e. 0.000102. */
function fmtPrice(n) {
  if (n == null || !isFinite(n) || n === 0) return "—";
  if (n >= 1) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 0.01) return "$" + n.toFixed(4);
  const exp = Math.floor(Math.log10(n));
  const zeros = Math.abs(exp) - 1;
  const digits = Math.round(n * Math.pow(10, Math.abs(exp) + 2));
  return `$0.0<sub>${zeros}</sub>${digits}`;
}
const fmtC = (n) => n == null ? "—" : n >= 1e9 ? (n/1e9).toFixed(2)+"B" : n >= 1e6 ? (n/1e6).toFixed(2)+"M" : n >= 1e3 ? (n/1e3).toFixed(1)+"K" : String(Math.round(n));

let provider = null, wallet = null, walletPubBytes = null, connection = null;
let signedEpm = null, signedEpmBytes = null;
let spacePriceUsd = 0, solPriceUsd = 0, myBondUsd = null;

function toast(msg, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3800);
}
function conn() {
  const url = ($("rpc").value || "").trim() || DEFAULT_RPC;
  if (!connection || connection.rpcEndpoint !== url) connection = new Connection(url, "confirmed");
  return connection;
}

/* ---------- tabs (scoped per group, so sections don't switch each other) ---------- */
document.querySelectorAll(".tabs").forEach((group) => {
  const section = group.closest("section") || document;
  group.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      group.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === b));
      const target = "pane-" + b.dataset.tab;
      section.querySelectorAll(":scope .tabpane").forEach((p) => p.classList.toggle("on", p.id === target));
    }));
});

/* ---------- trust levels ---------- */
const LEVEL_COLORS = { Untrusted: "#ff6b6b", Limited: "#ffc25c", Standard: "#8b93a7", Trusted: "#6ea8ff", Admin: "#46e0c8" };
const levelColor = (s) => LEVEL_COLORS[s] || "#6ea8ff";

SDS.TRUST_LEVELS.forEach((l) =>
  $("trustLevel").add(new Option(`${l.sds} — PGP “${l.pgp}” (weight ${l.weight})`, l.sds)));
$("trustLevel").value = "Trusted";

$("legend").innerHTML =
  SDS.TRUST_LEVELS.map((l) => `<span><i style="background:${levelColor(l.sds)}"></i>${l.sds}</span>`).join("") +
  `<span><i class="ln rev"></i>revoked</span>`;

/* ---------- address / .sol name resolution ---------- */
const snsCache = new Map();

/* ---------- language ---------- */
let LANG = localStorage.getItem("sdn.lang") || (navigator.language || "en").slice(0, 2);
if (!LANG_NAMES[LANG]) LANG = "en";
Object.entries(LANG_NAMES).forEach(([c, n]) => $("langSel").add(new Option(n, c)));
$("langSel").value = LANG;
applyLang(LANG);
$("langSel").addEventListener("change", () => {
  LANG = $("langSel").value;
  localStorage.setItem("sdn.lang", LANG);
  applyLang(LANG);
  renderList();
});

/* ---------- tutorial carousel — full-size on first visit only ---------- */
(() => {
  const track = $("tutTrack"), dots = $("tutDots");
  if (!track) return;
  const TUT_KEY = "sdn.trust.tutSeen.v1";
  if (localStorage.getItem(TUT_KEY)) {
    $("tut").hidden = true;
    $("tutInfoBtn").hidden = false;
  } else {
    localStorage.setItem(TUT_KEY, "1");
  }
  $("tutInfoBtn").addEventListener("click", () => {
    $("tut").hidden = !$("tut").hidden;
    $("tutInfoBtn").classList.toggle("on", !$("tut").hidden);
  });
  $("tutCloseBtn").addEventListener("click", () => {
    $("tut").hidden = true;
    $("tutInfoBtn").hidden = false;     // leave the info toggle behind
    $("tutInfoBtn").classList.remove("on");
  });
  const n = track.children.length;
  let i = 0, timer = null;
  for (let k = 0; k < n; k++) {
    const d = document.createElement("button");
    d.className = "tut-dot"; d.setAttribute("aria-label", "Slide " + (k + 1));
    d.addEventListener("click", () => go(k, true));
    dots.appendChild(d);
  }
  function go(k, manual) {
    i = (k + n) % n;
    track.style.transform = `translateX(-${i * 100}%)`;
    [...dots.children].forEach((d, j) => d.classList.toggle("on", j === i));
    if (manual) restart();
  }
  function restart() { clearInterval(timer); timer = setInterval(() => go(i + 1), 7000); }
  $("tutPrev").addEventListener("click", () => go(i - 1, true));
  $("tutNext").addEventListener("click", () => go(i + 1, true));
  $("tut").addEventListener("mouseenter", () => clearInterval(timer));
  $("tut").addEventListener("mouseleave", restart);
  go(0); restart();
})();

/* ---------- archived nodes ---------- */
const HIDDEN_KEY = "sdn.trust.hidden.v1";
let hiddenNodes = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]"));
function saveHidden() {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenNodes]));
  $("hiddenBtn").hidden = !hiddenNodes.size;
  $("hiddenCount").textContent = hiddenNodes.size;
  $("navArchived").hidden = !hiddenNodes.size;         // header link appears when >0
  $("navArchivedCount").textContent = hiddenNodes.size;
}

/** Plain-text USD for the canvas (no HTML subscripts). */
const usdPlain = (n) => n == null ? null
  : n >= 1e6 ? "$" + (n/1e6).toFixed(1) + "M" : n >= 1e3 ? "$" + (n/1e3).toFixed(1) + "K"
  : n >= 1 ? "$" + n.toFixed(0) : n > 0 ? "$" + n.toFixed(2) : "$0";

/** Account info per node: SOL lamports + what KIND of account this is.
 *  "wallet"  — ordinary system-owned account
 *  "empty"   — no account on chain yet (fresh key)
 *  "program" — executable
 *  "sys"     — owned by another program (token account, PDA, vault, …);
 *              tokens sent to these don't show up as normal holdings. */
const SOL_BAL = new Map();
const ACCT_TYPE = new Map();
const acctLookingUp = new Set();
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
function queueSolLookup(address) {
  if (!address || ACCT_TYPE.has(address) || acctLookingUp.has(address)) return;
  acctLookingUp.add(address);
  (async () => {
    let done = false;
    try {
      const info = await conn().getAccountInfo(new PublicKey(address));
      SOL_BAL.set(address, info?.lamports || 0);
      ACCT_TYPE.set(address, !info ? "empty"
        : info.executable ? "program"
        : info.owner.toBase58() !== SYSTEM_PROGRAM ? "sys" : "wallet");
      done = true;
      maybeAutoUntrust(address, SPACE_BAL.get(address));
    } catch (e) { console.warn("account lookup failed, will retry", address, e); }
    acctLookingUp.delete(address);
    if (!done) setTimeout(() => queueSolLookup(address), 20_000);
  })();
}
const TYPE_BADGE = { program: "PROGRAM", sys: "SYS ACCT" };

/** Total wallet value in USD (SOL + $SPACE), when everything is known. */
function walletValueUsd(address) {
  const lam = SOL_BAL.get(address), space = SPACE_BAL.get(address);
  if (lam == null || space == null || !(solPriceUsd || spacePriceUsd)) return null;
  return (lam / 1e9) * solPriceUsd + space * spacePriceUsd;
}

/** A key drained to 0 $SPACE is treated as compromised: auto-flag Untrusted.
 *  Special accounts (programs, PDAs, tagged addresses) are exempt — a vault
 *  or system account holding 0 in its direct ATA is not a drained wallet. */
function maybeAutoUntrust(address, balance) {
  if (balance !== 0 || !wallet || address === wallet) return;
  const type = ACCT_TYPE.get(address);
  if (type === undefined || type === "program" || type === "sys") return;
  const edge = SDS.projectEdges().find((e) => e.EDGE_ID === `${wallet}->${address}`);
  if (!edge || edge._level === "Untrusted" || edge._tag) return;
  SDS.addRecord(SDS.makeTRE({
    trusterId: wallet, trusteeId: address, level: "Untrusted",
    note: ((edge._note || "") + " · auto: $SPACE drained to 0").replace(/^ · /, ""),
    xAccount: edge._xAccount || "", amount: edge._amount ?? null, signature: edge._txSignature ?? null,
  }));
  redraw(); renderRecords();
  toast(`${short(address)} drained to 0 $SPACE — auto-set to Untrusted`, true);
}

/** $SPACE balance per node: address -> uiAmount. Lazy like the SNS lookup;
 *  drawn inside each bubble as it lands. Missing ATA counts as 0. */
const SPACE_BAL = new Map();
const balLookingUp = new Set();
function queueBalLookup(address) {
  if (!address || SPACE_BAL.has(address) || balLookingUp.has(address)) return;
  balLookingUp.add(address);
  (async () => {
    let done = false;
    try {
      const c = conn();
      const ata = await getAssociatedTokenAddress(MINT, new PublicKey(address));
      const bal = await c.getTokenAccountBalance(ata).catch((e) => {
        if (/could not find account/i.test(e?.message || "")) return null;  // no ATA = holds 0
        throw e;
      });
      const amount = bal ? Number(bal.value.uiAmount || 0) : 0;
      SPACE_BAL.set(address, amount);
      done = true;
      maybeAutoUntrust(address, amount);
    } catch (e) { console.warn("balance lookup failed, will retry", address, e); }
    balLookingUp.delete(address);
    if (!done) setTimeout(() => queueBalLookup(address), 20_000);
  })();
}

/** Reverse lookup: address -> primary .sol name (or null). Filled lazily; the
 *  canvas reads this map every frame, so names appear as lookups land. */
const SNS_NAMES = new Map();
const snsLookingUp = new Set();
function queueSnsLookup(address) {
  if (!address || SNS_NAMES.has(address) || snsLookingUp.has(address)) return;
  snsLookingUp.add(address);
  (async () => {
    let done = false;
    try {
      const sns = await import("https://esm.sh/@bonfida/spl-name-service@3.0.4");
      const c = conn(), owner = new PublicKey(address);
      // NOTE: the high-level helpers (getFavoriteDomain / reverseLookup) run a
      // tokenized-domain mint check that public RPCs reject, so we read the
      // reverse-name account directly instead.
      const reverseOf = async (domainKey) => {
        const acc = await c.getAccountInfo(sns.getReverseKeyFromDomainKey(domainKey));
        return acc ? sns.deserializeReverse(acc.data.slice(96)) : null;
      };
      let name = null;
      try {
        const [favKey] = sns.FavouriteDomain.getKeySync(sns.NAME_OFFERS_ID, owner);
        const fav = await sns.FavouriteDomain.retrieve(c, favKey);
        name = await reverseOf(fav.nameAccount);
      } catch { /* no primary domain set — fall through */ }
      if (!name) {
        const domains = await sns.getAllDomains(c, owner);   // throws on RPC failure → retry
        if (domains.length) name = await reverseOf(domains[0]);
      }
      SNS_NAMES.set(address, name ? name + ".sol" : null);   // only cache definitive answers
      done = true;
    } catch (e) { console.warn("SNS lookup failed, will retry", address, e); }
    snsLookingUp.delete(address);
    if (!done) setTimeout(() => queueSnsLookup(address), 15_000);  // transient RPC failure — retry
  })();
}

/** Accept either a base58 address or a Solana Name Service name ("tjkoury.sol",
 *  or bare "tjkoury"). Returns { address, name } or throws with a clear reason. */
async function resolveAddress(input) {
  const raw = (input || "").trim();
  if (!raw) throw new Error("Enter an address or .sol name");

  // A plain base58 pubkey resolves to itself.
  if (!raw.includes(".") && raw.length >= 32 && raw.length <= 44) {
    try { return { address: new PublicKey(raw).toBase58(), name: null }; } catch { /* fall through */ }
  }

  const name = raw.replace(/\.sol$/i, "").toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`"${raw}" is not a valid address or .sol name`);
  if (snsCache.has(name)) return { address: snsCache.get(name), name: name + ".sol" };

  const sns = await import("https://esm.sh/@bonfida/spl-name-service@3.0.4");
  const owner = await sns.resolve(conn(), name).catch(() => null);
  if (!owner) throw new Error(`Could not resolve "${name}.sol"`);
  const address = owner.toBase58();
  snsCache.set(name, address);
  return { address, name: name + ".sol" };
}

/** Resolve a field in place, showing the resolved name back to the user. */
async function resolveField(id) {
  const r = await resolveAddress($(id).value);
  if (r.name) { $(id).value = r.address; toast(`${r.name} → ${short(r.address)}`); }
  return r.address;
}

/* ---------- wallet ---------- */
// Discovery + connection live in wallet.js (Wallet Standard first, legacy
// injection second) — that is what makes Jupiter, Backpack etc. show up.
function pickWallet(list) {
  return new Promise((resolve) => {
    const m = document.createElement("div");
    m.className = "wmodal";
    m.innerHTML = '<div class="wmodal-box"><h3>Connect a wallet</h3><div class="wlist"></div><button class="mini wmodal-cancel">Cancel</button></div>';
    const done = (v) => { m.remove(); resolve(v); };
    const wl = m.querySelector(".wlist");
    for (const w of list) {
      const b = document.createElement("button");
      b.className = "wopt";
      if (w.icon) { const img = document.createElement("img"); img.src = w.icon; img.alt = ""; b.appendChild(img); }
      else { const d = document.createElement("span"); d.className = "wopt-dot"; b.appendChild(d); }
      const nm = document.createElement("b"); nm.textContent = w.name; b.appendChild(nm);
      b.addEventListener("click", () => done(w));
      wl.appendChild(b);
    }
    m.querySelector(".wmodal-cancel").addEventListener("click", () => done(null));
    m.addEventListener("click", (e) => { if (e.target === m) done(null); });
    document.body.appendChild(m);
  });
}

$("connectBtn").addEventListener("click", async () => {
  if (wallet) {
    try { await provider.disconnect(); } catch {}
    provider = null; wallet = null; walletPubBytes = null;
    $("wlabel").textContent = i18t(LANG, "connect"); $("connectBtn").classList.remove("on");
    $("walletChip").hidden = true;
    ["assignBtn", "signEpmBtn", "msgSignBtn"].forEach((i) => $(i).disabled = true);
    $("syncInfo").textContent = "Not connected.";
    localStorage.removeItem(LAST_WALLET_KEY);
    stopChainSync();
    closeNodePop();
    Graph.setYou(null); redraw();
    return toast("Disconnected");
  }
  const list = await listWallets();
  if (!list.length) return toast("No Solana wallet found — install Phantom, Solflare, Backpack or Jupiter", true);
  const entry = list.length === 1 ? list[0] : await pickWallet(list);
  if (!entry) return;
  try {
    const w = await connectTo(entry);
    localStorage.setItem(LAST_WALLET_KEY, entry.name || "");
    finishConnect(w);
  } catch { toast("Connection rejected", true); }
});

const LAST_WALLET_KEY = "sdn.wallet.last";

function finishConnect(w) {
  {
    provider = w; wallet = w.publicKey.toString();
    walletPubBytes = w.publicKey.toBytes();
    $("wlabel").textContent = short(wallet); $("connectBtn").classList.add("on");
    $("walletChip").textContent = short(wallet);
    $("walletChip").title = wallet;
    $("walletChip").href = "https://solscan.io/account/" + wallet;
    $("walletChip").hidden = false;
    ["assignBtn", "signEpmBtn", "msgSignBtn"].forEach((i) => $(i).disabled = false);
    Graph.setYou(wallet);
    // your own key is Ultimate trust, by definition
    if (!SDS.byStandard("TNR").some((r) => r.NODE_ID === wallet))
      SDS.addRecord(SDS.makeTNR({ nodeId: wallet, label: "self" }));
    redraw(); renderRecords();
    refreshMyBond();
    startChainSync();   // auto-import transfers + watch for new ones
  }
}

// silent auto-reconnect after the first successful connection
(async function autoConnect() {
  const last = localStorage.getItem(LAST_WALLET_KEY);
  if (last === null) return;
  for (let i = 0; i < 6 && !wallet; i++) {
    await new Promise((r) => setTimeout(r, 250 * (i + 1)));   // wallets register async
    const list = await listWallets().catch(() => []);
    const entry = list.find((e) => e.name === last) || (list.length === 1 ? list[0] : null);
    if (!entry) continue;
    try { finishConnect(await connectTo(entry, { silent: true })); } catch { /* not trusted yet — stay quiet */ }
    return;
  }
})();

/* ---------- assign trust (TRE) ---------- */
/** Send $SPACE and return the tx signature. Throws with a readable reason. */
async function transferSpace(to, amt) {
  const c = conn();
  const toPub = new PublicKey(to);
  const fromAta = await getAssociatedTokenAddress(MINT, provider.publicKey);
  const toAta = await getAssociatedTokenAddress(MINT, toPub);
  const bal = await c.getTokenAccountBalance(fromAta).catch(() => null);
  if (!bal?.value) throw new Error("This wallet holds no $SPACE");
  if (Number(bal.value.uiAmount) < amt) throw new Error(`Only ${bal.value.uiAmount} $SPACE available`);
  const tx = new Transaction();
  if (!(await c.getAccountInfo(toAta)))
    tx.add(createAssociatedTokenAccountInstruction(provider.publicKey, toAta, toPub, MINT));
  tx.add(createTransferInstruction(fromAta, toAta, provider.publicKey,
    BigInt(Math.round(amt * 10 ** DECIMALS)), [], TOKEN_PROGRAM_ID));
  tx.feePayer = provider.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  const res = await provider.signAndSendTransaction(tx);
  // some wallets only sign; broadcast on their behalf
  return res.signedTransaction
    ? await c.sendRawTransaction(res.signedTransaction)
    : (res.signature || res);
}

const MAX_SEND = 100;
let repeatConfirmFor = null;

/** "@handle", "x.com/handle", "https://twitter.com/handle" → "handle" */
function cleanXHandle(v) {
  return (v || "").trim()
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "")
    .replace(/^@/, "").replace(/[/?#].*$/, "").trim();
}

/** Live readout of exactly what will be sent. */
function updateSendTotal() {
  const el = $("sendTotal");
  const amt = parseFloat($("amount").value);
  if (!(amt > 0)) { el.hidden = true; return; }
  el.hidden = false;
  const over = amt > MAX_SEND;
  el.classList.toggle("over", over);
  el.innerHTML = over
    ? `Total: <b>${amt}</b> $SPACE — over the ${MAX_SEND} $SPACE maximum`
    : `Total to send: <b>${amt}</b> $SPACE${spacePriceUsd ? ` · ≈ ${usd(amt * spacePriceUsd)}` : ""}`;
}
$("amount").addEventListener("input", updateSendTotal);
$("toAddr").addEventListener("input", () => { repeatConfirmFor = null; $("repeatWarn").hidden = true; });

$("assignBtn").addEventListener("click", async () => {
  let to;
  try { to = await resolveField("toAddr"); }
  catch (e) { return toast(e.message, true); }
  if (to === wallet) return toast("You can't certify your own key — it's Ultimate by definition", true);

  // TRE requires the projected graph to stay acyclic
  const cycle = SDS.wouldCreateCycle(wallet, to);
  if (cycle) {
    showCycle(cycle);
    return toast("That edge would create a cycle — TRE requires an acyclic graph", true);
  }

  const level = $("trustLevel").value;
  const amt = parseFloat($("amount").value);

  // The transfer IS the trust relationship. Without it there is no edge.
  if (!(amt > 0)) return toast("Enter an amount — sending $SPACE is what establishes the trust", true);
  if (amt > MAX_SEND) return toast(`Maximum bond is ${MAX_SEND} $SPACE`, true);

  // already linked? make the user confirm they mean to send MORE
  const existing = SDS.projectEdges().find((e) => e.EDGE_ID === `${wallet}->${to}`);
  if (existing && repeatConfirmFor !== to) {
    repeatConfirmFor = to;
    const w = $("repeatWarn");
    w.hidden = false;
    w.innerHTML = `You already have a <b>${existing._level}</b> link with ${short(to)}` +
      (existing._amount ? ` (bonded <b>${fmtC(existing._amount)}</b> $SPACE)` : "") +
      `. Press the button again to send <b>${amt}</b> more $SPACE.`;
    return;
  }
  repeatConfirmFor = null;
  $("repeatWarn").hidden = true;

  let txSig = null;
  try { txSig = await transferSpace(to, amt); }
  catch (e) { return toast("Transfer failed — no trust established: " + (e.message || e), true); }

  // sign the trust edge itself with the wallet key
  const tre = SDS.makeTRE({
    trusterId: wallet, trusteeId: to, level,
    note: $("note").value.trim(), xAccount: cleanXHandle($("xAcct").value),
    signature: txSig, amount: amt || null,
    providerPeerId: wallet,
  });
  try {
    const payload = new TextEncoder().encode(
      `sdn-tre/1\n${tre.EDGE_ID}\n${tre.WEIGHT}\n${tre.UPDATED_AT}\n`);
    const sr = await provider.signMessage(payload);
    tre.PROVIDER_SIGNATURE = EPM.toHex(sr.signature);
  } catch { /* edge is still valid locally if the user declines */ }

  SDS.addRecord(tre);
  $("toAddr").value = $("amount").value = $("note").value = $("xAcct").value = "";
  updateSendTotal();
  redraw(); renderRecords();
  toast(`Sent ${amt} $SPACE — ${level} trust established with ${short(to)}`);
});

function showCycle(cycle) {
  const el = $("cycleWarn");
  el.hidden = false;
  el.innerHTML = `<b>Cycle detected</b> — TRE requires an acyclic trust graph: ` +
    cycle.map(short).join(" → ");
}

/* ---------- chain sync: transfers auto-import as edges, kept live ---------- */
// A change on your $SPACE token account triggers a re-import (websocket
// subscription), with a polling fallback for RPCs whose websocket is flaky.
// seenSigs keeps repeat scans cheap: each signature is parsed at most once.
const seenSigs = new Set();
/** sender -> { amount, signature, time } for $SPACE sent TO you. If you have
 *  no outbound edge back, it's a pending connection request. */
const INBOUND = new Map();
let syncSubId = null, syncTimer = null, syncBusy = false;

async function importChainTransfers() {
  if (!wallet || syncBusy) return 0;
  syncBusy = true;
  try {
    const c = conn();
    const ata = await getAssociatedTokenAddress(MINT, new PublicKey(wallet));
    const sigs = await c.getSignaturesForAddress(ata, { limit: 25 });
    let n = 0;
    for (const s of sigs) {
      if (seenSigs.has(s.signature)) continue;
      const t = await c.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (!t?.meta) continue;
      seenSigs.add(s.signature);
      const net = new Map();
      const apply = (list, sign) => {
        for (const b of list || []) {
          if (b.mint !== MINT_STR || !b.owner) continue;
          net.set(b.owner, (net.get(b.owner) || 0) + Number(b.uiTokenAmount?.uiAmount || 0) * sign);
        }
      };
      apply(t.meta.preTokenBalances, -1); apply(t.meta.postTokenBalances, +1);
      const mine = net.get(wallet) || 0;
      if (mine > 1e-9) {
        // net incoming: someone sent you $SPACE — a connection request
        const sender = [...net.entries()]
          .filter(([o, d]) => o !== wallet && d < -1e-9).sort((a, b) => a[1] - b[1])[0];
        if (sender && sender[0] !== POOL) {
          const prev = INBOUND.get(sender[0]);
          INBOUND.set(sender[0], {
            amount: (prev?.amount || 0) + mine,
            signature: s.signature, time: s.blockTime || 0,
          });
          n++;   // counts as a change so the graph refreshes
        }
        continue;
      }
      if (mine >= -1e-9) continue;              // only outbound = things you vouched for
      const cp = [...net.entries()]
        .filter(([o, d]) => o !== wallet && d > 1e-9).sort((a, b) => b[1] - a[1])[0];
      if (!cp || cp[0] === POOL) continue;      // swaps against the pool aren't trust
      if (SDS.projectEdges().some((e) => e.EDGE_ID === `${wallet}->${cp[0]}`)) continue;
      if (SDS.wouldCreateCycle(wallet, cp[0])) continue;
      if (!(Math.abs(mine) > 0)) continue;   // an edge requires a real transfer
      SDS.addRecord(SDS.makeTRE({
        trusterId: wallet, trusteeId: cp[0], level: "Standard",
        amount: Math.abs(mine), signature: s.signature, note: "imported from chain",
      }));
      n++;
    }
    if (n) {
      SPACE_BAL.clear();          // balances moved — refetch on redraw
      redraw(); renderRecords(); refreshMyBond();
      toast(`Imported ${n} transfer${n === 1 ? "" : "s"} as Standard-trust edges`);
    }
    return n;
  } catch (e) { console.warn("chain sync failed", e); return 0; }
  finally { syncBusy = false; $("syncInfo").textContent = statusLine(); }
}

async function startChainSync() {
  stopChainSync();
  $("syncInfo").textContent = "Reading your $SPACE transfers…";
  await importChainTransfers();
  const c = conn();
  try {
    const ata = await getAssociatedTokenAddress(MINT, new PublicKey(wallet));
    // fires on any balance change of your $SPACE account — in or out
    syncSubId = c.onAccountChange(ata, () => {
      SPACE_BAL.delete(wallet); queueBalLookup(wallet);
      importChainTransfers();
    }, "confirmed");
  } catch (e) { console.warn("account subscription unavailable, polling only", e); }
  syncTimer = setInterval(importChainTransfers, 60_000);
}

function stopChainSync() {
  if (syncSubId != null) { try { connection?.removeAccountChangeListener(syncSubId); } catch {} syncSubId = null; }
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  seenSigs.clear();
  INBOUND.clear();
  syncBusy = false;
}

/* ---------- ego graph state ---------- */
function statusLine() {
  if (!wallet) return "Not connected.";
  const out = SDS.projectEdges().filter((e) => e.TRUSTER_ID === wallet).length;
  const base = out ? `${out} key${out === 1 ? "" : "s"} in your web of trust.` : "No trust assigned yet.";
  return base + " Watching the chain — new $SPACE transfers import automatically. Click a node to set its level.";
}

const NODE_TAGS = new Map();   // address -> manual tag from its edge
function redraw() {
  Graph.reset();
  const all = SDS.projectEdgesWithTombstones();
  const live = all.filter((e) => !e.DELETED);
  NODE_TAGS.clear();
  for (const e of live) if (e._tag) NODE_TAGS.set(e.TRUSTEE_ID, e._tag);

  if (wallet) {
    Graph.addNode(wallet, { you: true, level: "Admin" });
    // BFS outward from you — your web of trust, not arbitrary traffic
    const seen = new Set([wallet]);
    let frontier = [wallet], depth = 0;
    while (frontier.length && depth < 4) {
      const next = [];
      for (const from of frontier) {
        for (const e of live.filter((x) => x.TRUSTER_ID === from)) {
          if (hiddenNodes.has(e.TRUSTEE_ID)) continue;
          Graph.addNode(e.TRUSTEE_ID, { level: e._level });
          Graph.addEdge(e.TRUSTER_ID, e.TRUSTEE_ID, e.WEIGHT, e._level, false, depth);
          if (!seen.has(e.TRUSTEE_ID)) { seen.add(e.TRUSTEE_ID); next.push(e.TRUSTEE_ID); }
        }
      }
      frontier = next; depth++;
    }
    // inbound edges (who trusts you)
    for (const e of live.filter((x) => x.TRUSTEE_ID === wallet)) {
      if (hiddenNodes.has(e.TRUSTER_ID)) continue;
      Graph.addNode(e.TRUSTER_ID, { level: e._level });
      Graph.addEdge(e.TRUSTER_ID, wallet, e.WEIGHT, e._level, false, 0);
      seen.add(e.TRUSTER_ID);
    }
    // revoked edges you issued, shown dashed
    for (const e of all.filter((x) => x.DELETED && x.TRUSTER_ID === wallet)) {
      if (hiddenNodes.has(e.TRUSTEE_ID)) continue;
      Graph.addNode(e.TRUSTEE_ID, { level: "Untrusted" });
      Graph.addEdge(e.TRUSTER_ID, e.TRUSTEE_ID, 0, "Untrusted", true, 0);
    }
    // incoming $SPACE: mutual if you sent back, otherwise a connection request
    const myOut = new Set(live.filter((e) => e.TRUSTER_ID === wallet).map((e) => e.TRUSTEE_ID));
    for (const [sender] of INBOUND) {
      if (sender === wallet || hiddenNodes.has(sender)) continue;
      if (myOut.has(sender)) {
        Graph.setEdgeKind(wallet, sender, "mutual");   // transfers both ways
      } else {
        Graph.addNode(sender, { level: "Standard", request: true });
        Graph.addEdge(sender, wallet, .4, "Standard", false, 0, "request");
      }
    }
    const mine = live.filter((e) => e.TRUSTER_ID === wallet);
    // "you trust" means actual trust — Untrusted (PGP Never) edges don't count
    $("n-out").textContent = mine.filter((e) => e._level !== "Untrusted").length;
    $("n-in").textContent = live.filter((e) => e.TRUSTEE_ID === wallet).length;
    $("n-depth").textContent = Math.max(0, seen.size - 1);
    $("n-archived").textContent = hiddenNodes.size;

    // value you have bonded outward across your active trust edges
    const bondedSpace = mine.reduce((a, e) => a + (Number(e._amount) || 0), 0);
    $("n-bonded").innerHTML = bondedSpace
      ? `${fmtC(bondedSpace)}<small class="st-sub">$SPACE${spacePriceUsd ? " · " + usd(bondedSpace * spacePriceUsd) : ""}</small>`
      : "—";
    $("n-mybond").innerHTML = myBondUsd == null ? "—"
      : `${usd(myBondUsd)}<small class="st-sub">at your key</small>`;
  }

  const cycle = SDS.findCycle(live);
  if (cycle) showCycle(cycle); else $("cycleWarn").hidden = true;

  $("syncInfo").textContent = statusLine();
  Graph.refreshEmpty();
  renderList();
}
$("fitBtn").addEventListener("click", () => Graph.recenter());
$("graphEmpty").addEventListener("click", () => { if (!wallet) $("connectBtn").click(); });

/* ---------- node popover: set level + note by clicking a node ---------- */
SDS.TRUST_LEVELS.forEach((l) => $("npLevel").add(new Option(`${l.sds} — PGP “${l.pgp}”`, l.sds)));
let npNodeId = null;
let npSavedId = null;    // record created by autosave this session — replaced, not stacked
let npSaveTimer = null;

function closeNodePop() {
  if (npSaveTimer) { clearTimeout(npSaveTimer); npSaveTimer = null; saveNodeEdits(); }
  npNodeId = null; npSavedId = null;
  $("nodePop").hidden = true;
}

function openNodePop(node) {
  if (npNodeId && npNodeId !== node.id) closeNodePop();   // flush pending edits first
  npNodeId = node.id;
  npSavedId = null;
  $("npSaved").hidden = true;
  $("npConnect").hidden = true;

  // SNS name is the headline when it exists; the address is always a link out.
  const nm = SNS_NAMES.get(node.id);
  const name = $("npName"), sub = $("npSub");
  const explorer = "https://solscan.io/account/" + node.id;
  if (nm) {
    name.textContent = (node.you ? "you · " : "") + nm;
    name.href = "https://www.sns.id/domain/" + nm.replace(/\.sol$/, "");
    sub.textContent = node.id;
    sub.href = explorer;
    sub.classList.remove("nm-missing");
  } else {
    name.textContent = (node.you ? "you · " : "") + short(node.id);
    name.href = explorer;
    name.title = node.id;
    sub.textContent = "(SNS not found)";
    sub.removeAttribute("href");
    sub.classList.add("nm-missing");
  }
  const typeBadge = NODE_TAGS.get(node.id) || TYPE_BADGE[ACCT_TYPE.get(node.id)];
  $("npType").hidden = !typeBadge || !!node.you;
  $("npType").textContent = typeBadge ? typeBadge.toUpperCase() : "";
  $("npHide").hidden = !!node.you;   // you can't hide yourself
  const edge = wallet && !node.you
    ? SDS.projectEdgesWithTombstones().find((e) => e.EDGE_ID === `${wallet}->${node.id}`)
    : null;
  const hint = $("npHint"), body = $("npBody");
  if (node.you) {
    body.hidden = true; hint.hidden = false;
    hint.textContent = "Your own key — Ultimate trust, by definition.";
  } else if (!wallet) {
    body.hidden = true; hint.hidden = false;
    hint.textContent = "Connect your wallet to set trust levels.";
  } else if (!edge) {
    body.hidden = true; hint.hidden = true;
    const req = INBOUND.get(node.id);
    $("npConnect").hidden = false;
    $("npConnHint").textContent = req
      ? `Connection request — this key sent you ${fmtC(req.amount)} $SPACE. Send $SPACE back to establish the connection.`
      : "No direct link from you — send $SPACE to establish a connection.";
  } else {
    body.hidden = false;
    $("npLevel").value = edge._level || "Standard";
    $("npTag").value = edge._tag || "";
    $("npNote").value = edge._note || "";
    $("npX").value = edge._xAccount ? "@" + edge._xAccount : "";
    updateNpXLink();
    hint.hidden = !edge.DELETED;
    if (edge.DELETED) hint.textContent = "Revoked — changing the level re-instates this edge locally.";
  }
  $("nodePop").hidden = false;
}

$("npClose").addEventListener("click", closeNodePop);

$("npConnectBtn").addEventListener("click", async () => {
  if (!wallet || !npNodeId) return;
  const to = npNodeId;
  const amt = parseFloat($("npAmount").value);
  if (!(amt > 0)) return toast("Enter an amount — sending $SPACE is what establishes the connection", true);
  if (amt > MAX_SEND) return toast(`Maximum bond is ${MAX_SEND} $SPACE`, true);
  const cycle = SDS.wouldCreateCycle(wallet, to);
  if (cycle) return toast("That edge would create a cycle — TRE requires an acyclic graph", true);
  let txSig = null;
  try { txSig = await transferSpace(to, amt); }
  catch (e) { return toast("Transfer failed — no connection established: " + (e.message || e), true); }
  SDS.addRecord(SDS.makeTRE({
    trusterId: wallet, trusteeId: to, level: "Standard",
    note: "connection established", signature: txSig, amount: amt,
  }));
  $("npAmount").value = "";
  closeNodePop();
  redraw(); renderRecords(); refreshMyBond();
  toast(`Sent ${amt} $SPACE — connection established with ${short(to)}`);
});
$("nodePop").addEventListener("click", (e) => { if (e.target === $("nodePop")) closeNodePop(); });
$("npHide").addEventListener("click", () => {
  if (!npNodeId) return;
  hiddenNodes.add(npNodeId);
  saveHidden();
  toast(`${short(npNodeId)} archived — restore it from the "archived" menu`);
  closeNodePop();
  redraw();
});

function updateNpXLink() {
  const h = cleanXHandle($("npX").value);
  const a = $("npXLink");
  a.hidden = !h;
  if (h) { a.href = "https://x.com/" + encodeURIComponent(h); a.textContent = "open @" + h + " on X ↗"; }
}
$("npX").addEventListener("input", updateNpXLink);

/* Autosave: level changes save immediately; note / X handle save after a
   short pause. Repeated saves in one popover session replace the previous
   autosaved record instead of stacking history. */
function saveNodeEdits() {
  if (!wallet || !npNodeId || $("npBody").hidden) return;
  const edgeId = `${wallet}->${npNodeId}`;
  // preserve the bond details from the last live version of this edge
  const prior = SDS.loadAll().filter((r) =>
    r.STANDARD === "TRE" && r.EDGE_ID === edgeId && !r.DELETED && r.id !== npSavedId).slice(-1)[0];
  if (npSavedId) SDS.removeRecord(npSavedId);
  const rec = SDS.makeTRE({
    trusterId: wallet, trusteeId: npNodeId,
    level: $("npLevel").value, note: $("npNote").value.trim(),
    xAccount: cleanXHandle($("npX").value), tag: $("npTag").value,
    amount: prior?._amount ?? null, signature: prior?._txSignature ?? null,
  });
  SDS.addRecord(rec);
  npSavedId = rec.id;
  redraw(); renderRecords();
  const s = $("npSaved");
  s.hidden = false;
  clearTimeout(saveNodeEdits._t);
  saveNodeEdits._t = setTimeout(() => (s.hidden = true), 1600);
}
function queueNodeSave() {
  clearTimeout(npSaveTimer);
  npSaveTimer = setTimeout(() => { npSaveTimer = null; saveNodeEdits(); }, 700);
}
$("npLevel").addEventListener("change", () => { clearTimeout(npSaveTimer); npSaveTimer = null; saveNodeEdits(); });
$("npTag").addEventListener("change", () => { clearTimeout(npSaveTimer); npSaveTimer = null; saveNodeEdits(); });
$("npNote").addEventListener("input", queueNodeSave);
$("npX").addEventListener("input", queueNodeSave);

/* ---------- trust matrix import / export, on the graph ---------- */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}
// Format is chosen at download time, in a modal.
$("gExportBtn").addEventListener("click", () => ($("exportModal").hidden = false));
$("expCancelBtn").addEventListener("click", () => ($("exportModal").hidden = true));
$("exportModal").addEventListener("click", (e) => { if (e.target === $("exportModal")) $("exportModal").hidden = true; });
$("expFbBtn").addEventListener("click", async () => {
  $("exportModal").hidden = true;
  const all = SDS.loadAll();
  try {
    const bytes = await SDS.toFlatBufferArchive(all);
    downloadBlob(new Blob([bytes], { type: "application/octet-stream" }), SDS.fbFilename());
    toast(`Exported ${all.length} records as size-prefixed FlatBuffers`);
  } catch (e) { toast("Export failed: " + (e.message || e), true); }
});
$("expJsonBtn").addEventListener("click", () => {
  $("exportModal").hidden = true;
  const all = SDS.loadAll();
  downloadBlob(SDS.toBlob(all), SDS.suggestedFilename());
  toast(`Exported ${all.length} records as JSON`);
});

/* ---------- hidden nodes modal ---------- */
function renderHiddenList() {
  const q = ($("hiddenFilter").value || "").toLowerCase().trim();
  const rows = [...hiddenNodes].filter((a) => {
    const nm = (SNS_NAMES.get(a) || "").toLowerCase();
    return !q || a.toLowerCase().includes(q) || nm.includes(q);
  });
  $("hiddenList").innerHTML = rows.length ? rows.map((a) => {
    const nm = SNS_NAMES.get(a);
    return `<div class="hidden-row">
      <div class="hidden-id"><b>${nm || short(a)}</b><small title="${a}">${nm ? short(a) : a.slice(0, 20) + "…"}</small></div>
      <button class="mini strong" data-show="${a}">restore</button></div>`;
  }).join("") : `<p class="rec-empty">${hiddenNodes.size ? "No matches." : "Nothing archived."}</p>`;
  $("hiddenList").querySelectorAll("[data-show]").forEach((b) =>
    b.addEventListener("click", () => {
      hiddenNodes.delete(b.dataset.show);
      saveHidden(); renderHiddenList(); redraw();
    }));
}
function openArchivedModal() { $("hiddenFilter").value = ""; renderHiddenList(); $("hiddenModal").hidden = false; }
$("hiddenBtn").addEventListener("click", openArchivedModal);
$("navArchived").addEventListener("click", (e) => { e.preventDefault(); openArchivedModal(); });
$("hiddenFilter").addEventListener("input", renderHiddenList);
$("hiddenShowAllBtn").addEventListener("click", () => { hiddenNodes.clear(); saveHidden(); renderHiddenList(); redraw(); });
$("hiddenCloseBtn").addEventListener("click", () => ($("hiddenModal").hidden = true));
$("hiddenModal").addEventListener("click", (e) => { if (e.target === $("hiddenModal")) $("hiddenModal").hidden = true; });
saveHidden();   // initialise the "archived (n)" button state

/* ---------- identities from signed EPMs / vCards ---------- */
// address -> { name, ok } from locally stored EPM records. Uploading a signed
// EPM or vCard binds a human identity to the wallet addresses it attests.
let IDENTITIES = new Map();
function rebuildIdentities() {
  IDENTITIES = new Map();
  const b58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  for (const r of SDS.byStandard("EPM")) {
    const name = r.LEGAL_NAME || [r.GIVEN_NAME, r.FAMILY_NAME].filter(Boolean).join(" ") || r.DN;
    if (!name) continue;
    const addrs = new Set();
    for (const k of r.KEYS || []) if (b58.test(k.KEY_ADDRESS || "")) addrs.add(k.KEY_ADDRESS);
    for (const p of r.CHAIN_PROOFS || []) if (b58.test(p.ADDRESS || "")) addrs.add(p.ADDRESS);
    for (const m of r.MULTIFORMAT_ADDRESS || []) {
      const mm = String(m).match(/[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      if (mm) addrs.add(mm[0]);
    }
    for (const a of addrs) IDENTITIES.set(a, { name, ok: !!r._sigOk, rec: r });
  }
}
rebuildIdentities();

$("uploadIdBtn").addEventListener("click", () => $("uploadIdFile").click());
$("uploadIdFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    let rec;
    if (/\.vcf$|\.vcard$/i.test(f.name)) {
      const r = EPM.fromVCard(await f.text());
      if (!r.record) throw new Error(r.reason);
      rec = r.record;
    } else {
      rec = EPM.decodeEPM(new Uint8Array(await f.arrayBuffer()));
    }
    const v = await EPM.verifyEPM(rec);
    const bytes = EPM.encodeEPM(rec);
    const cid = await EPM.cidV1Raw(bytes);
    SDS.addRecord({
      STANDARD: "EPM", schema: SDS.STANDARDS.EPM.url, id: "epm_" + cid.slice(0, 12),
      ...rec, _cid: cid, _bytesB64: EPM.b64(bytes), _sigOk: v.ok,
    });
    rebuildIdentities(); renderRecords(); renderList();
    toast(v.ok ? "Identity imported — signature verifies ✓" : "Imported, but signature INVALID: " + v.reason, !v.ok);
  } catch (err) { toast("Identity import failed: " + err.message, true); }
  e.target.value = "";
});

/* ---------- list view: searchable, sortable table over the same nodes ---------- */
let listSort = { key: "bal", dir: -1 };
function setView(mode) {   // "graph" | "list" | "stats" | "assign"
  $("listView").hidden = mode !== "list";
  $("statsView").hidden = mode !== "stats";
  $("assignView").hidden = mode !== "assign";
  $("fileView").hidden = mode !== "file";
  $("viewGraphBtn").classList.toggle("on", mode === "graph");
  $("viewListBtn").classList.toggle("on", mode === "list");
  $("viewStatsBtn").classList.toggle("on", mode === "stats");
  $("viewAssignBtn").classList.toggle("on", mode === "assign");
  $("viewFileBtn").classList.toggle("on", mode === "file");
  if (mode === "list") renderList();
}
$("viewGraphBtn").addEventListener("click", () => setView("graph"));
$("viewListBtn").addEventListener("click", () => setView("list"));
$("viewStatsBtn").addEventListener("click", () => setView("stats"));
$("viewAssignBtn").addEventListener("click", () => setView("assign"));
$("viewFileBtn").addEventListener("click", () => setView("file"));
$("listSearch").addEventListener("input", () => renderList());
document.querySelectorAll(".node-table th").forEach((th) =>
  th.addEventListener("click", () => {
    const k = th.dataset.sort;
    listSort = { key: k, dir: listSort.key === k ? -listSort.dir : -1 };
    renderList();
  }));
setInterval(() => { if (!$("listView").hidden) renderList(); }, 5000);  // pick up async lookups

function listRows() {
  return Graph.nodeList().map((n) => {
    const edge = wallet ? SDS.projectEdges().find((e) => e.EDGE_ID === `${wallet}->${n.id}`) : null;
    return {
      id: n.id, you: n.you,
      identity: IDENTITIES.get(n.id)?.name || "",
      sns: SNS_NAMES.get(n.id) || "",
      addr: n.id,
      conn: n.you ? "" : (edge && INBOUND.has(n.id)) ? "mutual" : edge ? "outgoing" : INBOUND.has(n.id) ? "request" : "",
      level: n.you ? "Admin" : (edge?._level || n.level || ""),
      bal: SPACE_BAL.get(n.id) ?? null,
      val: walletValueUsd(n.id),
      tag: NODE_TAGS.get(n.id) || TYPE_BADGE[ACCT_TYPE.get(n.id)] || "",
    };
  });
}

function renderList() {
  if ($("listView").hidden) return;
  const q = ($("listSearch").value || "").toLowerCase().trim();
  let rows = listRows().filter((r) => !q ||
    [r.identity, r.sns, r.addr, r.level, r.tag, r.conn].some((v) => String(v).toLowerCase().includes(q)));
  const { key, dir } = listSort;
  rows.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === "number" || typeof bv === "number") return ((av ?? -1) - (bv ?? -1)) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
  document.querySelectorAll(".node-table th").forEach((th) => {
    th.innerHTML = i18t(LANG, th.dataset.i18n) + (th.dataset.sort === key ? ` <span class="arr">${dir < 0 ? "▼" : "▲"}</span>` : "");
  });
  $("listRows").innerHTML = rows.length ? rows.map((r) => `
    <tr data-node="${r.id}">
      <td><button class="mini vcard-btn" data-vcard="${r.id}" title="${r.identity || "No identity on file"}"
        ${r.identity ? "" : "disabled"}>vCard</button></td>
      <td class="nt-name">${r.sns || "—"}</td>
      <td class="nt-addr" title="${r.addr}">${r.you ? "you · " : ""}${short(r.addr)}</td>
      <td>${r.conn === "mutual" ? '<span class="nt-conn c-mut">⇄ mutual</span>'
        : r.conn === "outgoing" ? '<span class="nt-conn c-out">→ outgoing</span>'
        : r.conn === "request" ? '<span class="nt-conn c-req">⇠ request</span>' : "—"}</td>
      <td><span class="nt-lvl"><i style="background:${levelColor(r.level)}"></i>${r.level || "—"}</span></td>
      <td>${r.bal == null ? "…" : fmtC(r.bal)}</td>
      <td>${r.val == null ? "…" : usdPlain(r.val)}</td>
      <td class="nt-tag">${r.tag ? r.tag.toUpperCase() : ""}</td>
    </tr>`).join("")
    : `<tr><td colspan="8" class="nt-empty">${i18t(LANG, "listEmpty")}</td></tr>`;
  $("listRows").querySelectorAll("[data-node]").forEach((tr) =>
    tr.addEventListener("click", () => openNodePop({ id: tr.dataset.node, you: tr.dataset.node === wallet })));
  $("listRows").querySelectorAll("[data-vcard]:not([disabled])").forEach((b) =>
    b.addEventListener("click", async (ev) => {
      ev.stopPropagation();   // don't open the node modal
      const ident = IDENTITIES.get(b.dataset.vcard);
      if (!ident?.rec) return;
      try {
        const { vcard } = await EPM.toVCard(ident.rec, { peerId: b.dataset.vcard,
          directoryKind: (ident.rec.ENTITY_TYPE || "User").toLowerCase() });
        downloadBlob(new Blob([vcard], { type: "text/vcard" }),
          (ident.name || b.dataset.vcard.slice(0, 8)).replace(/\W+/g, "-").toLowerCase() + ".vcf");
      } catch (e) { toast("vCard failed: " + (e.message || e), true); }
    }));
}
$("gImportBtn").addEventListener("click", () => $("gImportFile").click());
$("gImportFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    // sniff: JSON archives start with whitespace/{/[, FlatBuffer streams don't
    const first = bytes.find((b) => b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d);
    const r = (first === 0x7b || first === 0x5b)
      ? SDS.importArchive(JSON.parse(new TextDecoder().decode(bytes)))
      : await SDS.importFlatBufferArchive(bytes);
    rules = SDS.byStandard("TRP").slice(-1)[0]?.rules || rules;
    rebuildIdentities();
    renderRecords(); renderRules(); redraw();
    toast(`Imported ${r.added} records (${r.total} total)`);
  } catch (err) { toast("Import failed: " + err.message, true); }
  e.target.value = "";
});

/* ---------- EPM identity ---------- */
function readEpmForm() {
  return {
    DN: $("epmDn").value, LEGAL_NAME: $("epmLegal").value,
    FAMILY_NAME: $("epmFamily").value, GIVEN_NAME: $("epmGiven").value,
    JOB_TITLE: $("epmTitle").value, EMAIL: $("epmEmail").value, TELEPHONE: $("epmTel").value,
    ENTITY_TYPE: $("epmEntity").value,
    MULTIFORMAT_ADDRESS: [], ALTERNATE_NAMES: [], CHAIN_PROOFS: [], KEYS: [],
    _walletAddress: wallet,
  };
}

$("signEpmBtn").addEventListener("click", async () => {
  if (!provider) return toast("Connect a wallet first", true);
  try {
    const draft = readEpmForm();
    signedEpm = await EPM.signEPM(draft, provider, walletPubBytes);
    signedEpmBytes = EPM.encodeEPM(signedEpm);
    const cid = await EPM.cidV1Raw(signedEpmBytes);
    signedEpm._cid = cid;

    SDS.addRecord({
      STANDARD: "EPM", schema: SDS.STANDARDS.EPM.url,
      id: "epm_" + cid.slice(0, 12),
      ...signedEpm, _cid: cid, _bytesB64: EPM.b64(signedEpmBytes),
    });
    renderEpm(); renderRecords();
    ["epmDownloadBtn", "epmVcardBtn", "epmQrBtn", "epmVerifyBtn"].forEach((i) => $(i).disabled = false);
    toast("EPM signed");
  } catch (e) { toast("Signing failed: " + (e.message || e), true); }
});

function renderEpm() {
  if (!signedEpm) return;
  const { json } = EPM.canonicalPreimage({ ...signedEpm, SIGNATURE: undefined });
  $("epmState").textContent = "signed · " + (signedEpmBytes?.length || 0) + " bytes";
  $("epmOut").innerHTML = `
    <div class="epm-row"><span>CID</span><code>${signedEpm._cid || "—"}</code></div>
    <div class="epm-row"><span>Signature</span><code>${(signedEpm.SIGNATURE || "").slice(0, 32)}…</code></div>
    <div class="epm-row"><span>Signed at</span><code>${new Date((signedEpm.SIGNATURE_TIMESTAMP || 0) * 1000).toLocaleString()}</code></div>
    <div class="epm-row"><span>Algorithm</span><code>${signedEpm.SIGNATURE_ALGORITHM || "ed25519"}</code></div>
    <details class="epm-pre"><summary>Canonical signing payload (RFC 8785)</summary><pre>${json.replace(/</g, "&lt;")}</pre></details>`;
}

$("epmDownloadBtn").addEventListener("click", () => {
  if (!signedEpmBytes) return;
  const url = URL.createObjectURL(new Blob([signedEpmBytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url; a.download = `${(signedEpm.LEGAL_NAME || signedEpm.GIVEN_NAME || "identity").replace(/\W+/g, "-").toLowerCase()}.epm`;
  a.click(); URL.revokeObjectURL(url);
  toast("Downloaded signed EPM (size-prefixed $EPM FlatBuffer)");
});

$("epmVcardBtn").addEventListener("click", async () => {
  if (!signedEpm) return;
  const { vcard } = await EPM.toVCard(signedEpm, { peerId: wallet, directoryKind: signedEpm.ENTITY_TYPE.toLowerCase() });
  const url = URL.createObjectURL(new Blob([vcard], { type: "text/vcard" }));
  const a = document.createElement("a");
  a.href = url; a.download = `${(signedEpm.LEGAL_NAME || signedEpm.GIVEN_NAME || "identity").replace(/\W+/g, "-").toLowerCase()}.vcf`;
  a.click(); URL.revokeObjectURL(url);
  toast("vCard exported — X-SDN-EPM-B64 carries the signed record");
});

$("epmQrBtn").addEventListener("click", async () => {
  if (!signedEpmBytes) return;
  try {
    const QR = (await import("https://esm.sh/qrcode@1.5.4")).default;
    const box = $("qrBox"); box.hidden = false;
    // QR capacity is finite; a full EPM often exceeds it, so fall back to the CID.
    const payload = EPM.b64(signedEpmBytes);
    const full = "sdn-epm:" + payload;
    let mode = "full record";
    let data = full;
    if (full.length > 2200) { data = "sdn-epm-cid:" + signedEpm._cid; mode = "CID only (record too large for one QR)"; }
    await QR.toCanvas($("qrCanvas"), data, { width: 260, margin: 1, errorCorrectionLevel: "L",
      color: { dark: "#06070d", light: "#ffffff" } });
    $("qrNote").textContent = `${mode} · ${data.length} chars`;
    toast("QR generated");
  } catch (e) { toast("QR failed: " + (e.message || e), true); }
});

$("epmVerifyBtn").addEventListener("click", async () => {
  if (!signedEpm) return;
  const res = await EPM.verifyEPM(signedEpm);
  toast(res.ok ? "Signature verifies ✓" : "Signature INVALID: " + res.reason, !res.ok);
});

$("epmImportBtn").addEventListener("click", () => $("epmImportFile").click());
$("epmImportFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    let rec = null;
    if (/\.vcf$|\.vcard$/i.test(f.name)) {
      const r = EPM.fromVCard(await f.text());
      if (!r.record) throw new Error(r.reason);
      rec = r.record;
    } else {
      rec = EPM.decodeEPM(new Uint8Array(await f.arrayBuffer()));
    }
    const v = await EPM.verifyEPM(rec);
    signedEpm = rec;
    signedEpmBytes = EPM.encodeEPM(rec);
    signedEpm._cid = await EPM.cidV1Raw(signedEpmBytes);
    renderEpm();
    ["epmDownloadBtn", "epmVcardBtn", "epmQrBtn", "epmVerifyBtn"].forEach((i) => $(i).disabled = false);
    // reflect into the form
    $("epmGiven").value = rec.GIVEN_NAME || ""; $("epmFamily").value = rec.FAMILY_NAME || "";
    $("epmLegal").value = rec.LEGAL_NAME || ""; $("epmTitle").value = rec.JOB_TITLE || "";
    $("epmEmail").value = rec.EMAIL || ""; $("epmTel").value = rec.TELEPHONE || "";
    $("epmDn").value = rec.DN || ""; $("epmEntity").value = rec.ENTITY_TYPE || "User";
    toast(v.ok ? "Imported — signature verifies ✓" : "Imported, but signature INVALID: " + v.reason, !v.ok);
  } catch (err) { toast("Import failed: " + err.message, true); }
  e.target.value = "";
});

/* ---------- signed messages for X ---------- */
const MSG_TAG = "sdn-sig/1";
$("msgText").addEventListener("input", () => $("msgCount").textContent = $("msgText").value.length);

$("msgSignBtn").addEventListener("click", async () => {
  const text = $("msgText").value.trim();
  if (!text) return toast("Write a message first", true);
  try {
    const payload = new TextEncoder().encode(`${MSG_TAG}\n${text}`);
    const sr = await provider.signMessage(payload);
    const sig = sr.signature;
    const b64u = EPM.b64(sig instanceof Uint8Array ? sig : new Uint8Array(sig))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const block = `${text}\n\n— ${MSG_TAG} ${wallet} ${b64u}`;
    $("msgSigned").value = block;
    $("msgOut").hidden = false;
    $("msgTweetBtn").href = "https://x.com/intent/tweet?text=" + encodeURIComponent(block);
    toast(`Signed — ${block.length} chars` + (block.length > 280 ? " (over X's limit; trim the message)" : ""));
  } catch (e) { toast("Signing failed: " + (e.message || e), true); }
});
$("msgCopyBtn").addEventListener("click", () => {
  navigator.clipboard.writeText($("msgSigned").value).then(() => toast("Copied"));
});

$("verifyMsgBtn").addEventListener("click", async () => {
  const raw = $("verText").value;
  const m = raw.match(/—\s*sdn-sig\/1\s+([1-9A-HJ-NP-Za-km-z]{32,44})\s+([A-Za-z0-9_-]{80,90})/);
  if (!m) { $("verOut").innerHTML = '<div class="vres bad"><b>No signature found</b><span>That text does not carry a signature block.</span></div>'; return; }
  const [, addr, b64u] = m;
  const text = raw.slice(0, raw.indexOf("— sdn-sig/1")).trim();
  try {
    const { verify } = await import("https://esm.sh/@noble/ed25519@2.1.0");
    const sig = EPM.unb64(b64u.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - b64u.length % 4) % 4));
    const pub = new PublicKey(addr).toBytes();
    const ok = await verify(sig, new TextEncoder().encode(`${MSG_TAG}\n${text}`), pub);
    $("verOut").innerHTML = ok
      ? `<div class="vres ok"><b>Signature valid</b><span>Signed by <code>${addr}</code>. The text has not been altered.</span></div>`
      : `<div class="vres bad"><b>Signature invalid</b><span>This text does not match the signature. It was altered, or it was not signed by that key.</span></div>`;
  } catch (e) { $("verOut").innerHTML = `<div class="vres bad"><b>Could not verify</b><span>${e.message}</span></div>`; }
});

/* ---------- rules ---------- */
let rules = SDS.byStandard("TRP").slice(-1)[0]?.rules || [];
Object.entries(SDS.RULE_TYPES).forEach(([k, v]) =>
  $("ruleType").add(new Option(`${v.label}${v.unit ? " (" + v.unit + ")" : ""}`, k)));
$("ruleType").addEventListener("change", () => $("ruleThreshold").value = SDS.RULE_TYPES[$("ruleType").value].def);
$("ruleThreshold").value = SDS.RULE_TYPES[$("ruleType").value].def;

function saveRules() { SDS.addRecord(SDS.makeTRP({ name: "Trust policy", issuer: wallet, rules })); renderRules(); renderRecords(); }
function renderRules() {
  $("ruleCount").textContent = `${rules.length} rule${rules.length === 1 ? "" : "s"}`;
  const dep = $("ruleDep");
  dep.innerHTML = '<option value="">— always apply —</option>';
  rules.forEach((r) => dep.add(new Option(r.label, r.ruleId)));
  $("rulesList").innerHTML = rules.length ? rules.map((r) => {
    const parent = rules.find((x) => x.ruleId === r.dependsOn);
    return `<div class="rule">
      <span class="rule-mode ${r.mode === "REQUIRE" ? "req" : "sco"}">${r.mode === "REQUIRE" ? "GATE" : "×" + r.weight}</span>
      <div><b>${r.label}</b> <span class="rule-cmp">${r.cmp} ${r.threshold}${r.unit ? " " + r.unit : ""}</span>
      ${parent ? `<small>only if “${parent.label}” passes</small>` : ""}</div>
      <button class="copy rec-del" data-rule="${r.ruleId}">✕</button></div>`;
  }).join("") : '<p class="rec-empty">No rules yet — tap “Use recommended” to start.</p>';
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
  rules = [bond, chains,
    SDS.makeRule({ type: "MAX_CONCENTRATION", threshold: 60, mode: "SCORE", weight: 2, dependsOn: chains.ruleId }),
    SDS.makeRule({ type: "MIN_DURATION", threshold: 30, mode: "SCORE", weight: 3 }),
    SDS.makeRule({ type: "MAX_KEY_AGE", threshold: 365, mode: "SCORE", weight: 1 }),
    SDS.makeRule({ type: "MIN_ENDORSEMENTS", threshold: 1, mode: "SCORE", weight: 1 }),
    SDS.makeRule({ type: "MIN_TRUST_WEIGHT", threshold: 0.8, mode: "SCORE", weight: 2 })];
  saveRules(); toast("Loaded whitepaper preset");
});
$("clearRulesBtn").addEventListener("click", () => { rules = []; saveRules(); toast("Rules cleared"); });

$("evalBtn").addEventListener("click", async () => {
  if (!rules.length) return toast("Add rules first — try the preset", true);
  let addr;
  try { addr = await resolveField("evalAddr"); }
  catch (e) { return toast(e.message, true); }
  $("evalOut").innerHTML = '<p class="rec-empty">Gathering signals…</p>';
  const signals = await gatherSignals(addr);
  const res = SDS.evaluatePolicy(rules, signals);
  $("evalOut").innerHTML = `
    <div class="verdict v-${res.verdict.toLowerCase()}"><b>${res.score}</b><span>${res.verdict}</span></div>
    <div class="sig-row">${Object.entries(signals).map(([k, v]) =>
      `<span><i>${k}</i>${v === null ? "—" : typeof v === "number" ? (k === "concentration" ? Math.round(v*100)+"%" : fmtC(v)) : v}</span>`).join("")}</div>
    ${res.results.map((r) => `<div class="ev ev-${r.status.toLowerCase()}"><span class="ev-dot"></span>
      <div><b>${r.rule.label}</b> <small>${r.rule.cmp} ${r.rule.threshold}${r.rule.unit ? " "+r.rule.unit : ""}${r.value !== null ? ` · actual ${r.rule.signal === "concentration" ? r.value+"%" : r.value}` : ""}${r.reason ? " · " + r.reason : ""}</small></div>
      <span class="ev-status">${r.status}</span></div>`).join("")}`;
});

/** Only Solana is observable from this page, so cross-chain signals stay null
 *  and the engine reports UNKNOWN rather than inventing data. */
async function gatherSignals(addr) {
  const s = { value: null, chains: null, concentration: null, durationDays: null,
              keyAgeDays: null, endorsements: 0, inboundWeight: 0, hasCert: false };
  try {
    const c = conn(), pub = new PublicKey(addr);
    const sol = await c.getBalance(pub);
    const accts = await c.getParsedTokenAccountsByOwner(pub, { programId: TOKEN_PROGRAM_ID });
    const px = (mint) => fetch("https://api.dexscreener.com/latest/dex/tokens/" + mint)
      .then((r) => r.json()).then((j) => parseFloat(j.pairs?.[0]?.priceUsd) || 0).catch(() => 0);
    const [solUsd, spaceUsd] = await Promise.all([px("So11111111111111111111111111111111111111112"), px(MINT_STR)]);
    const solVal = (sol / 1e9) * solUsd;
    let spaceVal = 0;
    for (const a of accts.value) {
      const i = a.account.data.parsed.info;
      if (i.mint === MINT_STR) spaceVal += Number(i.tokenAmount.uiAmount || 0) * spaceUsd;
    }
    s.value = solVal + spaceVal;
    s.chains = s.value > 0 ? 1 : 0;
    s.concentration = s.value > 0 ? Math.max(solVal, spaceVal) / s.value : null;
    const sigs = await c.getSignaturesForAddress(pub, { limit: 1000 }).catch(() => []);
    if (sigs.length) {
      const now = Date.now() / 1000;
      if (sigs[0].blockTime) s.durationDays = Math.floor((now - sigs[0].blockTime) / 86400);
      const oldest = sigs[sigs.length - 1].blockTime;
      if (oldest) s.keyAgeDays = Math.floor((now - oldest) / 86400);
    }
  } catch (e) { console.warn("signal gather failed", e); }
  const inbound = SDS.projectEdges().filter((r) => r.TRUSTEE_ID === addr);
  s.endorsements = inbound.length;
  s.inboundWeight = inbound.reduce((a, e) => a + (e.WEIGHT || 0), 0);
  return s;
}

/* ---------- records + backup ---------- */
function renderRecords() {
  const all = SDS.loadAll();
  $("recCount").textContent = all.length;
  $("recordsList").innerHTML = all.length ? all.slice().reverse().map((r) => {
    let body = "";
    if (r.STANDARD === "TRE") body = r.DELETED
      ? `${short(r.TRUSTER_ID)} ⊘ ${short(r.TRUSTEE_ID)} · tombstone`
      : `${short(r.TRUSTER_ID)} → ${short(r.TRUSTEE_ID)} · ${r._level} (w=${r.WEIGHT})`;
    else if (r.STANDARD === "TNR") body = `${short(r.NODE_ID)}${r._label ? " · " + r._label : ""}`;
    else if (r.STANDARD === "EPM") body = `${r.LEGAL_NAME || r.GIVEN_NAME || short(r.id)} · ${(r._cid || "").slice(0, 14)}…`;
    else if (r.STANDARD === "PNM") body = `CID ${r.CID?.slice(0, 16)}…`;
    else if (r.STANDARD === "TRP") body = `${r.name} · ${r.rules?.length || 0} rules`;
    const when = r.UPDATED_AT || r.CREATED_AT || (r.SIGNATURE_TIMESTAMP ? r.SIGNATURE_TIMESTAMP * 1000 : null);
    return `<div class="rec ${r.DELETED ? "rec-revoked" : ""}">
      <span class="rec-tag rec-${r.STANDARD.toLowerCase()}">${r.STANDARD}</span>
      <div class="rec-body"><b>${body}</b><small>${when ? new Date(when).toLocaleString() : ""}${r._note ? " · " + r._note : ""}</small></div>
      <button class="copy rec-del" data-del="${r.id}">✕</button></div>`;
  }).join("") : '<p class="rec-empty">No records yet.</p>';
  $("recordsList").querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => { SDS.removeRecord(b.dataset.del); renderRecords(); redraw(); }));
}
const out = (h) => ($("backupOut").innerHTML = h);
const need = () => { const a = SDS.loadAll(); if (!a.length) { toast("No records to back up", true); return null; } return a; };

$("ipfsBtn").addEventListener("click", async () => {
  const all = need(); if (!all) return;
  const api = $("ipfsApi").value.trim(), token = $("ipfsToken").value.trim();
  if (!api && !token) return out("Add an IPFS endpoint or pinning token in Backup settings.");
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
    out(`Pinned ✓ <a href="${gateway}" target="_blank" rel="noopener">${cid}</a> — PNM created`);
  } catch (e) { out("IPFS failed: " + (e.message || e)); }
});
$("s3Btn").addEventListener("click", async () => {
  const all = need(); if (!all) return;
  const url = $("s3Url").value.trim();
  if (!url) return out("Add a presigned PUT URL in Backup settings.");
  try {
    out("Uploading to S3…");
    const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: SDS.toBlob(all) });
    if (!r.ok) throw new Error("S3 " + r.status);
    out(`Uploaded ${all.length} records ✓`);
  } catch (e) { out("S3 failed: " + (e.message || e) + " — URL may be expired, or CORS blocks PUT."); }
});
$("gdBtn").addEventListener("click", () => {
  const all = need(); if (!all) return;
  const cid = $("gdClient").value.trim();
  if (!cid) return out("Add your Google OAuth client ID in Backup settings.");
  if (!window.google?.accounts?.oauth2) return out("Google Identity script didn't load.");
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
      } catch (e) { out("Drive failed: " + (e.message || e)); }
    },
  }).requestAccessToken();
});
$("wipeBtn").addEventListener("click", () => {
  SDS.clearAll(); rules = []; rebuildIdentities(); renderRecords(); renderRules(); redraw(); toast("Local records cleared");
});

/* ---------- graph renderer ---------- */
const Graph = (() => {
  const canvas = $("graph"), ctx = canvas.getContext("2d");
  let W = 0, H = 0, you = null;
  const nodes = new Map(), edges = new Map();
  function resize() {
    const dpr = devicePixelRatio || 1, r = canvas.getBoundingClientRect();
    W = r.width; H = r.height; canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(canvas);

  const posCache = new Map();   // id -> {x,y} so redraws don't scramble the layout
  const addNode = (id, o = {}) => {
    if (nodes.has(id)) { const ex = nodes.get(id); if (o.you) ex.you = true; if (o.level) ex.level = o.level; if (o.request) ex.request = true; return ex; }
    const p = posCache.get(id);
    const n = { id, x: p ? p.x : W/2 + (Math.random()-.5)*200, y: p ? p.y : H/2 + (Math.random()-.5)*200,
      vx: 0, vy: 0, r: o.you ? 33 : 27, you: !!o.you, request: !!o.request, level: o.level || "Standard" };
    nodes.set(id, n);
    queueSnsLookup(id);
    queueBalLookup(id);
    queueSolLookup(id);
    return n;
  };
  const addEdge = (from, to, weight, level, revoked, depth, kind = "out") => {
    edges.set(from + ">" + to, { from, to, weight, level, revoked, depth, kind });
  };
  const setEdgeKind = (from, to, kind) => {
    const e = edges.get(from + ">" + to);
    if (e) e.kind = kind;
  };
  function step() {
    const arr = [...nodes.values()];
    for (const a of arr) for (const b of arr) {
      if (a === b) continue;
      const dx = a.x-b.x, dy = a.y-b.y, d2 = dx*dx+dy*dy || .01, d = Math.sqrt(d2), f = 9800/d2;
      a.vx += dx/d*f; a.vy += dy/d*f;
    }
    for (const e of edges.values()) {
      const a = nodes.get(e.from), b = nodes.get(e.to); if (!a || !b) continue;
      // stronger trust pulls closer
      const rest = 125 + (1 - (e.weight || .5)) * 95;
      const dx = b.x-a.x, dy = b.y-a.y, d = Math.hypot(dx, dy) || .01, f = .012*(d-rest);
      a.vx += dx/d*f; a.vy += dy/d*f; b.vx -= dx/d*f; b.vy -= dy/d*f;
    }
    for (const n of arr) {
      if (n.you) { // anchor the ego node at centre
        n.x += (W/2 - n.x) * .12; n.y += (H/2 - n.y) * .12; n.vx *= .5; n.vy *= .5;
      } else { n.vx += (W/2-n.x)*.0007; n.vy += (H/2-n.y)*.0007; }
      // no hard clamp — the graph may outgrow the card; panning covers it
      n.vx *= .85; n.vy *= .85; n.x += n.vx; n.y += n.vy;
    }
  }
  let camX = 0, camY = 0, zoom = 1;   // pan + pinch/wheel zoom
  const clampZoom = (z) => Math.max(.35, Math.min(3.5, z));
  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(camX, camY);
    ctx.scale(zoom, zoom);
    for (const e of edges.values()) {
      const a = nodes.get(e.from), b = nodes.get(e.to); if (!a || !b) continue;
      const col = e.kind === "request" ? "#ffc25c" : levelColor(e.level);
      const ang = Math.atan2(b.y-a.y, b.x-a.x);
      const cos = Math.cos(ang), sin = Math.sin(ang);
      const HL = 13;                                        // arrowhead length
      // node-edge endpoints; the LINE stops at the arrow base so heads cap the line
      const sx = a.x + cos*(a.r+3), sy = a.y + sin*(a.r+3); // tip at a (mutual)
      const tx = b.x - cos*(b.r+3), ty = b.y - sin*(b.r+3); // tip at b
      const lx1 = e.kind === "mutual" ? sx + cos*(HL-2) : sx;
      const ly1 = e.kind === "mutual" ? sy + sin*(HL-2) : sy;
      const lx2 = tx - cos*(HL-2), ly2 = ty - sin*(HL-2);
      ctx.save();
      if (e.revoked) { ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(255,107,107,.55)"; ctx.lineWidth = 1.4; }
      else if (e.kind === "request") { ctx.setLineDash([3, 5]); ctx.strokeStyle = "rgba(255,194,92,.7)"; ctx.lineWidth = 1.8; }
      else { ctx.strokeStyle = col + "aa"; ctx.lineWidth = 1 + (e.weight || .5) * 3.6; }
      ctx.beginPath(); ctx.moveTo(lx1, ly1); ctx.lineTo(lx2, ly2); ctx.stroke(); ctx.restore();
      const head = (x, y, dir) => {                         // triangle with tip at (x,y)
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(dir - .42)*HL, y - Math.sin(dir - .42)*HL);
        ctx.lineTo(x - Math.cos(dir + .42)*HL, y - Math.sin(dir + .42)*HL);
        ctx.closePath(); ctx.fill();
      };
      ctx.fillStyle = e.revoked ? "rgba(255,107,107,.85)" : col;
      head(tx, ty, ang);                                    // transfer went from -> to
      if (e.kind === "mutual") head(sx, sy, ang + Math.PI); // …and back
    }
    for (const n of nodes.values()) {
      const col = n.you ? "#46e0c8" : levelColor(n.level);
      ctx.shadowColor = col + "cc"; ctx.shadowBlur = n.you ? 24 : 10;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,255,255,.2)"; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7); ctx.stroke();
      if (n.request) {
        ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = "rgba(255,194,92,.8)"; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 5, 0, 7); ctx.stroke(); ctx.restore();
      }
      // account-type / manual tag badge above the bubble
      const tag = NODE_TAGS.get(n.id) || TYPE_BADGE[ACCT_TYPE.get(n.id)];
      if (tag && !n.you) {
        ctx.textAlign = "center";
        ctx.fillStyle = "#ffc25c";
        ctx.font = "700 10px ui-monospace,Menlo,monospace";
        ctx.fillText(tag.toUpperCase(), n.x, n.y - n.r - 8);
      }
      // $SPACE held at this key + total wallet value, inside the bubble
      const bal = SPACE_BAL.get(n.id);
      const val = walletValueUsd(n.id);
      ctx.textAlign = "center";
      if (bal != null) {
        ctx.fillStyle = "rgba(4,6,10,.94)";
        ctx.font = "700 " + (n.you ? "14px" : "12px") + " ui-monospace,Menlo,monospace";
        ctx.fillText(fmtC(bal), n.x, n.y + (val != null ? -1 : 4.5));
        if (val != null) {
          ctx.font = "600 " + (n.you ? "10.5px" : "9.5px") + " ui-monospace,Menlo,monospace";
          ctx.fillStyle = "rgba(4,6,10,.78)";
          ctx.fillText("(" + usdPlain(val) + ")", n.x, n.y + 12);
        }
      }
      ctx.fillStyle = n.you ? "#e7ecf3" : "#c6cddb";
      ctx.font = (n.you ? "700 " : "600 ") + "13.5px system-ui,sans-serif";
      ctx.fillText(n.you ? "you" : short(n.id), n.x, n.y + n.r + 17);
      const nm = SNS_NAMES.get(n.id) || IDENTITIES.get(n.id)?.name;
      if (nm) {
        ctx.fillStyle = "rgba(70,224,200,.9)";
        ctx.font = "600 12px system-ui,sans-serif";
        ctx.fillText(nm, n.x, n.y + n.r + 32);
      }
    }
    ctx.textAlign = "start";
    ctx.restore();
  }
  let drag = null, downAt = null, moved = false, clickCb = null, lastP = null;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX-r.left, y: e.clientY-r.top }; };
  const world = (p) => ({ x: (p.x - camX) / zoom, y: (p.y - camY) / zoom });
  const hit = (p) => { const w = world(p); return [...nodes.values()].find((n) => (w.x-n.x)**2 + (w.y-n.y)**2 < (n.r+6)**2); };
  const down = (p) => { drag = hit(p); downAt = p; lastP = p; moved = false; };
  const move = (p) => {
    if (downAt && Math.hypot(p.x-downAt.x, p.y-downAt.y) > 5) moved = true;
    if (!downAt || !moved) return false;
    if (drag) { const w = world(p); drag.x = w.x; drag.y = w.y; drag.vx = drag.vy = 0; }
    else { camX += p.x - lastP.x; camY += p.y - lastP.y; }   // pan the whole graph
    lastP = p;
    return true;
  };
  const up = (isCanvas) => {
    if (downAt && !moved && isCanvas && clickCb) clickCb(drag || null);
    drag = null; downAt = null; lastP = null; moved = false;
  };
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = pos(e), w = world(p);
    zoom = clampZoom(zoom * Math.exp(-e.deltaY * 0.0016));
    camX = p.x - w.x * zoom; camY = p.y - w.y * zoom;
  }, { passive: false });
  canvas.addEventListener("mousedown", (e) => down(pos(e)));
  addEventListener("mousemove", (e) => {
    const p = pos(e);
    if (move(p)) return;
    if (downAt) return;
    const n = hit(p); canvas.style.cursor = n ? "pointer" : "";
    canvas.title = n ? `${n.id}${SNS_NAMES.get(n.id) ? "\n" + SNS_NAMES.get(n.id) : ""}\n${n.you ? "your key" : n.level + " trust"} — click to edit` : "";
  });
  addEventListener("mouseup", (e) => up(e.target === canvas));
  let pinch = null;
  const touchPts = (e) => {
    const r = canvas.getBoundingClientRect();
    return [...e.touches].map((t) => ({ x: t.clientX - r.left, y: t.clientY - r.top }));
  };
  canvas.addEventListener("touchstart", (e) => {
    const pts = touchPts(e);
    if (pts.length >= 2) {                       // two fingers = pinch, not drag/click
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      pinch = { d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, z0: zoom, w0: world(mid) };
      drag = null; downAt = null; moved = true;
      return;
    }
    down(pts[0]);
  }, { passive: true });
  canvas.addEventListener("touchmove", (e) => {
    const pts = touchPts(e);
    if (pinch && pts.length >= 2) {
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      zoom = clampZoom(pinch.z0 * d / pinch.d0);
      camX = mid.x - pinch.w0.x * zoom; camY = mid.y - pinch.w0.y * zoom;
      return;
    }
    if (pts.length) move(pts[0]);
  }, { passive: true });
  canvas.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) pinch = null;
    if (e.touches.length === 0) up(true);
  });
  (function loop() { step(); draw(); requestAnimationFrame(loop); })();
  resize();
  return {
    addNode, addEdge,
    setYou: (a) => { you = a; },
    getNode: (id) => nodes.get(id) || null,
    setEdgeKind,
    nodeList: () => [...nodes.values()].map((n) => ({ id: n.id, you: n.you, level: n.level })),
    onNodeClick: (fn) => { clickCb = fn; },
    reset: () => { for (const n of nodes.values()) posCache.set(n.id, { x: n.x, y: n.y }); nodes.clear(); edges.clear(); },
    recenter: () => { camX = camY = 0; zoom = 1; posCache.clear(); for (const n of nodes.values()) { n.x = W/2 + (Math.random()-.5)*180; n.y = H/2 + (Math.random()-.5)*180; } },
    refreshEmpty: () => ($("graphEmpty").style.display = nodes.size ? "none" : "flex"),
  };
})();
Graph.onNodeClick((node) => { node ? openNodePop(node) : closeNodePop(); });

/* ---------- market + your own bond ---------- */
const priceOf = (mint) => fetch("https://api.dexscreener.com/latest/dex/tokens/" + mint)
  .then((r) => r.json()).then((j) => parseFloat(j.pairs?.[0]?.priceUsd) || 0).catch(() => 0);

/** Your bond = the value sitting at your key. Under Adversarial Security this
 *  is the number that proves the key is intact: undrained value means uncompromised. */
async function refreshMyBond() {
  if (!wallet) { myBondUsd = null; return; }
  try {
    const c = conn(), pub = new PublicKey(wallet);
    const [lamports, accts] = await Promise.all([
      c.getBalance(pub),
      c.getParsedTokenAccountsByOwner(pub, { programId: TOKEN_PROGRAM_ID }),
    ]);
    let space = 0;
    for (const a of accts.value) {
      const i = a.account.data.parsed.info;
      if (i.mint === MINT_STR) space += Number(i.tokenAmount.uiAmount || 0);
    }
    myBondUsd = (lamports / 1e9) * solPriceUsd + space * spacePriceUsd;
    redraw();
  } catch (e) { console.warn("bond read failed", e); }
}

(async function tokenStats() {
  try {
    const j = await (await fetch("https://api.dexscreener.com/latest/dex/tokens/" + MINT_STR)).json();
    const p = j.pairs?.[0];
    if (p) spacePriceUsd = parseFloat(p.priceUsd) || 0;   // used to value bonds in USD
    solPriceUsd = await priceOf("So11111111111111111111111111111111111111112");
    if (wallet) refreshMyBond(); else redraw();
  } catch {}
})();

renderRules();
renderRecords();
redraw();

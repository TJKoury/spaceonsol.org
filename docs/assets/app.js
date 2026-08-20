// ====== SPACE token site logic ======
const MINT = "Ge5rnW2w6EzSh3EkQWxH76P8LEjEJE7qe7entq9pLQ3F";

document.getElementById("year").textContent = new Date().getFullYear();

// Nav scroll state
const nav = document.getElementById("nav");
addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 20));

// Copy buttons
document.querySelectorAll(".copy").forEach((btn) => {
  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(btn.dataset.copy).then(() => {
      const t = btn.textContent;
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = t; btn.classList.remove("copied"); }, 1400);
    });
  });
});

// ---- Formatting helpers ----
// Sub-penny prices use the crypto subscript convention: $0.0(4)8632 means
// four zeros after the decimal point, so 0.00008632.
function fmtPrice(n) {
  if (n == null || !isFinite(n)) return "—";
  if (n >= 1) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 0.01) return "$" + n.toFixed(4);
  const exp = Math.floor(Math.log10(n));          // e.g. -5 for 8.6e-5
  const zeros = Math.abs(exp) - 1;                // zeros between "0." and first digit
  const digits = Math.round(n * Math.pow(10, Math.abs(exp) + 3));
  return `$0.0<sub>${zeros}</sub>${digits}`;
}

const fmtCompact = (n) =>
  n == null || !isFinite(n) ? "—" :
  n >= 1e9 ? "$" + (n / 1e9).toFixed(2) + "B" :
  n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" :
  n >= 1e3 ? "$" + (n / 1e3).toFixed(1) + "K" :
  "$" + n.toFixed(0);

const fmtNum = (n) =>
  n == null ? "—" :
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" :
  n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n);

// ---- Live data from DexScreener ----
async function loadMarket() {
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + MINT);
    const d = await r.json();
    const p = (d.pairs && d.pairs[0]) || null;
    if (!p) throw new Error("no pair");
    const price = parseFloat(p.priceUsd);
    const mcap = parseFloat(p.marketCap || p.fdv);
    const liq = p.liquidity ? parseFloat(p.liquidity.usd) : null;
    const vol = p.volume ? parseFloat(p.volume.h24) : null;
    const chg = p.priceChange ? parseFloat(p.priceChange.h24) : null;
    const buys = p.txns && p.txns.h24 ? p.txns.h24.buys : null;
    const sells = p.txns && p.txns.h24 ? p.txns.h24.sells : null;

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerHTML = v; };
    const setCls = (id, cls) => { const el = document.getElementById(id); if (el) el.className = "stat-num " + cls; };

    // hero
    set("priceUsd", fmtPrice(price));
    set("mcap", fmtCompact(mcap));
    set("liq", fmtCompact(liq));
    const pcEl = document.getElementById("priceChange");
    if (pcEl && chg != null) {
      pcEl.textContent = (chg >= 0 ? "▲ " : "▼ ") + Math.abs(chg).toFixed(1) + "% 24h";
      pcEl.className = "price-change " + (chg >= 0 ? "up" : "down");
    }
    // stats
    set("s-price", fmtPrice(price));
    set("s-mcap", fmtCompact(mcap));
    set("s-liq", fmtCompact(liq));
    set("s-vol", fmtCompact(vol));
    set("s-holders", buys != null ? fmtNum(buys) + " / " + fmtNum(sells) : "—");
    set("s-change", chg != null ? (chg >= 0 ? "+" : "") + chg.toFixed(1) + "%" : "—");
    if (chg != null) setCls("s-change", chg >= 0 ? "up" : "down");
  } catch (e) {
    console.warn("market data load failed", e);
  }
}
loadMarket();
setInterval(loadMarket, 30000);

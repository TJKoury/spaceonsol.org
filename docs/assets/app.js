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
const fmtUsd = (n, full = false) =>
  n == null ? "—" :
  full ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 }) :
  n >= 1 ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 4 }) :
  "$" + n.toPrecision(4);

const fmtCompact = (n) =>
  n == null ? "—" :
  n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" :
  n >= 1e3 ? "$" + (n / 1e3).toFixed(1) + "K" :
  "$" + n.toFixed(0);

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

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    // hero
    set("priceUsd", fmtUsd(price));
    set("mcap", fmtCompact(mcap));
    set("liq", fmtCompact(liq));
    const pcEl = document.getElementById("priceChange");
    if (pcEl && chg != null) {
      pcEl.textContent = (chg >= 0 ? "▲ " : "▼ ") + Math.abs(chg).toFixed(1) + "% 24h";
      pcEl.className = "price-change " + (chg >= 0 ? "up" : "down");
    }
    // stats
    set("s-price", fmtUsd(price));
    set("s-mcap", fmtCompact(mcap));
    set("s-liq", fmtCompact(liq));
    set("s-vol", fmtCompact(vol));
    set("s-holders", buys != null ? buys + " / " + sells : "—");
    set("s-change", chg != null ? (chg >= 0 ? "+" : "") + chg.toFixed(1) + "%" : "—");
  } catch (e) {
    console.warn("market data load failed", e);
  }
}
loadMarket();
setInterval(loadMarket, 30000);

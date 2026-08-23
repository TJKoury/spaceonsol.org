// ====== Wallet connection ======
// Detects wallets two ways and normalises them behind one interface:
//
//  1. Wallet Standard (window registry) — how Jupiter, Backpack, Solflare and
//     current Phantom builds announce themselves. This is the modern path and
//     the reason a Phantom-only check misses Jupiter entirely.
//  2. Legacy window injection (window.solana / window.solflare) — older builds.
//
// Everything downstream sees the same shape:
//   { name, icon, publicKey, signMessage(bytes), signAndSendTransaction(tx), disconnect() }

import { PublicKey } from "https://esm.sh/@solana/web3.js@1.95.2";

const CHAIN = "solana:mainnet";

/* ---------------- discovery ---------------- */

async function standardWallets() {
  try {
    const { getWallets } = await import("https://esm.sh/@wallet-standard/app@1.1.0");
    const { get } = getWallets();
    return get().filter((w) =>
      w.features?.["standard:connect"] &&
      (w.features["solana:signAndSendTransaction"] || w.features["solana:signTransaction"]) &&
      w.chains?.some((c) => c.startsWith("solana:")));
  } catch (e) {
    console.warn("wallet-standard discovery failed", e);
    return [];
  }
}

function legacyWallets() {
  const out = [];
  const seen = new Set();
  const add = (p, name) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push({ __legacy: true, provider: p, name, icon: null });
  };
  if (window.phantom?.solana) add(window.phantom.solana, "Phantom");
  else if (window.solana?.isPhantom) add(window.solana, "Phantom");
  if (window.solflare?.isSolflare) add(window.solflare, "Solflare");
  if (window.backpack?.solana) add(window.backpack.solana, "Backpack");
  if (window.solana && !window.solana.isPhantom) add(window.solana, "Injected wallet");
  return out;
}

/** Every wallet we can see, de-duplicated by name (Standard entries win). */
export async function listWallets() {
  const std = await standardWallets();
  const names = new Set(std.map((w) => w.name.toLowerCase()));
  const legacy = legacyWallets().filter((w) => !names.has(w.name.toLowerCase()));
  return [
    ...std.map((w) => ({ id: w.name, name: w.name, icon: w.icon, __std: w })),
    ...legacy.map((w) => ({ id: w.name, name: w.name, icon: null, __legacy: w.provider })),
  ];
}

/* ---------------- adapters ---------------- */

function adaptStandard(wallet, account) {
  const pk = new PublicKey(account.address);
  return {
    name: wallet.name,
    icon: wallet.icon,
    publicKey: pk,

    async signMessage(bytes) {
      const f = wallet.features["solana:signMessage"];
      if (!f) throw new Error(`${wallet.name} cannot sign messages`);
      const [res] = await f.signMessage({ account, message: bytes });
      return { signature: res.signature };
    },

    async signAndSendTransaction(tx) {
      const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const sas = wallet.features["solana:signAndSendTransaction"];
      if (sas) {
        const [res] = await sas.signAndSendTransaction({
          account, chain: CHAIN, transaction: new Uint8Array(wire),
        });
        return { signature: bs58(res.signature) };
      }
      // wallet can only sign — caller broadcasts
      const st = wallet.features["solana:signTransaction"];
      const [res] = await st.signTransaction({ account, chain: CHAIN, transaction: new Uint8Array(wire) });
      return { signedTransaction: res.signedTransaction };
    },

    async disconnect() {
      try { await wallet.features["standard:disconnect"]?.disconnect(); } catch {}
    },
  };
}

function adaptLegacy(provider) {
  return {
    name: provider.isPhantom ? "Phantom" : provider.isSolflare ? "Solflare" : "Wallet",
    icon: null,
    publicKey: provider.publicKey,
    async signMessage(bytes) {
      const r = await provider.signMessage(bytes, "utf8");
      return { signature: r?.signature || r };
    },
    async signAndSendTransaction(tx) {
      const r = await provider.signAndSendTransaction(tx);
      return { signature: r?.signature || r };
    },
    async disconnect() { try { await provider.disconnect(); } catch {} },
  };
}

/** base58 for signature bytes returned by Wallet Standard. */
function bs58(bytes) {
  if (typeof bytes === "string") return bytes;
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}

/* ---------------- connect ---------------- */

/** Connect to a specific entry from listWallets(). */
export async function connectTo(entry) {
  if (entry.__std) {
    const w = entry.__std;
    const { accounts } = await w.features["standard:connect"].connect();
    const account = accounts?.[0] || w.accounts?.[0];
    if (!account) throw new Error(`${w.name} returned no account`);
    return adaptStandard(w, account);
  }
  const p = entry.__legacy;
  await p.connect();
  if (!p.publicKey) throw new Error("Wallet returned no public key");
  return adaptLegacy(p);
}

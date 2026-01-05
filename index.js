require("dotenv").config();
const fs = require("fs");
const path = require("path");
const bs58 = require("bs58");
const axios = require("axios");
const {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  SystemInstruction,
} = require("@solana/web3.js");

// ================== ENV ==================
function mustEnv(name, def = null) {
  const v = process.env[name] ?? def;
  if (v === null || v === undefined || v === "") throw new Error(`Missing env: ${name}`);
  return v;
}

const RPC_URL = mustEnv("RPC_URL");
const WATCH_ADDRESS = mustEnv("WATCH_ADDRESS");
const DISCORD_WEBHOOK_URL = mustEnv("DISCORD_WEBHOOK_URL");

const DISCORD_PING = String(process.env.DISCORD_PING || "").trim();

const POLL_SECONDS = Number(process.env.POLL_SECONDS || "10");
const MIN_SOL = Number(process.env.MIN_SOL || "0.1");
const MAX_SOL = Number(process.env.MAX_SOL || "20");
const WINDOW_OUTFLOWS = Number(process.env.WINDOW_OUTFLOWS || "10");
const REQUIRED_MATCH = Number(process.env.REQUIRED_MATCH || "3");
const SIG_FETCH_LIMIT = Number(process.env.SIG_FETCH_LIMIT || "60");
const PREVIEW_DEST_LIMIT = Number(process.env.PREVIEW_DEST_LIMIT || "10");

const STATE_FILE = path.join(__dirname, "state.json");

// ================== STATE ==================
let state = {
  anchorSig: null,
  outflows: [], // [{signature, ts}]
  lastAlertKey: null,
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const obj = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (obj && typeof obj === "object") state = { ...state, ...obj };
    }
  } catch {}
  if (!Array.isArray(state.outflows)) state.outflows = [];
}
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

// ================== HELPERS ==================
function solscanAccountUrl(addr) {
  return `https://solscan.io/account/${addr}`;
}
function solscanTxUrl(sig) {
  return `https://solscan.io/tx/${sig}`;
}

function makeAlertKey(outflowSigs) {
  return outflowSigs.map((x) => x.signature).join("|");
}

function inSolRangeLamports(lamports) {
  const sol = Math.abs(lamports) / LAMPORTS_PER_SOL;
  return sol >= MIN_SOL && sol <= MAX_SOL;
}

// ================== SOL FORMAT (NO PAD, NO EXTRA 0) ==================
// Convert lamports -> SOL string with up to 9 decimals, TRIM trailing zeros, NEVER pad extra zeros.
function lamportsToSolStringTrim(lamports) {
  const v = BigInt(lamports < 0 ? -lamports : lamports);
  const base = 1000000000n;

  const intPart = v / base;
  let frac = (v % base).toString().padStart(9, "0"); // internal only
  frac = frac.replace(/0+$/, ""); // trim trailing zeros

  if (!frac) return intPart.toString();
  return `${intPart.toString()}.${frac}`;
}

// digits = remove dot from trimmed string, count length (includes leading "0" before dot)
function digitsCountFromSolString(solStr) {
  return solStr.replace(".", "").length;
}

// MATCH rule for "5 digits" with NO auto-adding zeros:
// - Use trimmed SOL string (no trailing zeros)
// - Remove dot and count digits must be exactly 5
function isFiveDigitsPostBalanceLamports(postLamports) {
  const abs = Math.abs(Number(postLamports || 0));
  if (!Number.isFinite(abs) || abs <= 0) return false;

  const solStr = lamportsToSolStringTrim(abs);
  const digits = digitsCountFromSolString(solStr);
  return digits === 5;
}

// ================== DISCORD NOTIFY (GỌN + ĐẸP, KHÔNG PAD) ==================
async function sendDiscordText({ watch, matches, windowSize, matchedCount }) {
  // matches: [{postSolStr, destWallet, sig}]
  const top = matches.slice(0, PREVIEW_DEST_LIMIT);

  const header = `🚨 **OUTFLOW HIT** • **${matchedCount}/${REQUIRED_MATCH}** matched`;
  const watchLine = `👀 **Watch:** \`${watch}\`\n🔗 ${solscanAccountUrl(watch)}`;
  const ruleLine = `✅ **Rule:** dest pre=0 & post has **exactly 5 digits** (no padding) • Range **${MIN_SOL}→${MAX_SOL} SOL** • Window **${windowSize}**`;

  const list =
    top.length === 0
      ? "🧾 **Matches:** _None_"
      : "🧾 **Matches:**\n" +
        top
          .map(
            (x, i) =>
              `**${i + 1}.** \`${x.postSolStr}\` → \`${x.destWallet}\`\n   ↳ ${solscanTxUrl(x.sig)}`
          )
          .join("\n");

  const content = (DISCORD_PING ? `${DISCORD_PING}\n` : "") + [header, watchLine, ruleLine, list].join("\n\n");

  await axios.post(
    DISCORD_WEBHOOK_URL,
    {
      content,
      allowed_mentions: { parse: DISCORD_PING ? ["everyone", "roles", "users"] : [] },
    },
    { timeout: 20_000 }
  );
}

// ================== PARSE TRANSFERS OUT (to get DEST wallet) ==================
function extractTransfersFromParsed(parsedTx, watchBase58) {
  const out = [];

  function handleParsedIx(ix) {
    if (!ix) return;
    const prog = ix.program;
    const parsed = ix.parsed;
    if (prog !== "system" || !parsed) return;

    const info = parsed.info || {};
    const source = info.source || info.from;
    const dest = info.destination || info.to;
    const lamports = Number(info.lamports || 0);

    if (!source || !dest) return;
    if (source !== watchBase58) return;
    if (!Number.isFinite(lamports) || lamports <= 0) return;

    out.push({ to: dest, lamports });
  }

  const outer = parsedTx?.transaction?.message?.instructions || [];
  for (const ix of outer) handleParsedIx(ix);

  const inner = parsedTx?.meta?.innerInstructions || [];
  for (const innerItem of inner) {
    for (const ix of innerItem.instructions || []) handleParsedIx(ix);
  }

  return out;
}

// ================== COMPILED FALLBACK ==================
function pubkeyToString(k) {
  if (!k) return "";
  if (typeof k === "string") return k;
  if (k?.toBase58) return k.toBase58();
  if (k?.pubkey) return typeof k.pubkey === "string" ? k.pubkey : k.pubkey.toBase58();
  return String(k);
}

function getAllAccountKeysFromTx(tx) {
  const msg = tx?.transaction?.message;
  const meta = tx?.meta;

  const keys = [];
  const ak = msg?.accountKeys || [];
  for (const k of ak) keys.push(pubkeyToString(k));

  const la = meta?.loadedAddresses;
  if (la?.writable?.length) keys.push(...la.writable);
  if (la?.readonly?.length) keys.push(...la.readonly);

  return keys;
}

function decodeIxDataToBuffer(dataStr) {
  if (!dataStr) return null;
  try {
    const b64 = Buffer.from(dataStr, "base64");
    if (b64.length > 0) return b64;
  } catch {}
  try {
    return Buffer.from(bs58.decode(dataStr));
  } catch {}
  return null;
}

function decodeSystemTransfersOutCompiled(tx, watchBase58) {
  const msg = tx?.transaction?.message;
  const meta = tx?.meta;
  if (!msg || !meta) return [];

  const keys = getAllAccountKeysFromTx(tx);
  const outer = msg.instructions || [];
  const inner = meta.innerInstructions || [];

  const out = [];

  function handleCompiledIx(ix) {
    try {
      const programId = keys[ix.programIdIndex];
      if (programId !== SystemProgram.programId.toBase58()) return;

      const dataBuf = decodeIxDataToBuffer(ix.data);
      if (!dataBuf) return;

      const metas = (ix.accounts || []).map((ai) => ({
        pubkey: new PublicKey(keys[ai]),
        isSigner: false,
        isWritable: true,
      }));

      const txIxLike = { programId: SystemProgram.programId, keys: metas, data: dataBuf };

      const t = SystemInstruction.decodeInstructionType(txIxLike);
      if (t === "Transfer") {
        const tr = SystemInstruction.decodeTransfer(txIxLike);
        const from = tr.fromPubkey.toBase58();
        const to = tr.toPubkey.toBase58();
        if (from === watchBase58) out.push({ to, lamports: tr.lamports });
      } else if (t === "TransferWithSeed") {
        const tr = SystemInstruction.decodeTransferWithSeed(txIxLike);
        const from = tr.fromPubkey.toBase58();
        const to = tr.toPubkey.toBase58();
        if (from === watchBase58) out.push({ to, lamports: tr.lamports });
      }
    } catch {}
  }

  for (const ix of outer) handleCompiledIx(ix);
  for (const innerItem of inner) {
    for (const ix of innerItem.instructions || []) handleCompiledIx(ix);
  }

  return out;
}

// ================== BALANCES: get pre/post for DEST ==================
function getDestPrePostLamportsFromTx(txObj, destBase58) {
  try {
    const meta = txObj?.meta;
    if (!meta?.preBalances || !meta?.postBalances) return null;

    const keys = getAllAccountKeysFromTx(txObj);
    if (!keys.length) return null;

    const idx = keys.indexOf(destBase58);
    if (idx < 0) return null;

    const pre = Number(meta.preBalances[idx]);
    const post = Number(meta.postBalances[idx]);
    if (!Number.isFinite(pre) || !Number.isFinite(post)) return null;

    return { pre, post };
  } catch {
    return null;
  }
}

// Determine whether a tx is an "outflow tx"
async function isOutflowTx(conn, sig, watchBase58) {
  try {
    const ptx = await conn.getParsedTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (ptx) {
      const transfers = extractTransfersFromParsed(ptx, watchBase58);
      if (transfers.length > 0) return true;
    }
  } catch {}

  try {
    const tx = await conn.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const transfers = decodeSystemTransfersOutCompiled(tx, watchBase58);
    return transfers.length > 0;
  } catch {}

  return false;
}

// ================== NEW-ONLY SIGNATURES ==================
async function fetchNewestSignature(conn, watchPk) {
  const sigs = await conn.getSignaturesForAddress(watchPk, { limit: 1 }, "confirmed");
  return sigs?.[0]?.signature || null;
}

async function fetchNewSignatures(conn, watchPk, anchorSig) {
  const sigs = await conn.getSignaturesForAddress(watchPk, { limit: SIG_FETCH_LIMIT }, "confirmed");
  if (!sigs.length) return [];
  if (!anchorSig) return [];

  const fresh = [];
  for (const s of sigs) {
    if (s.signature === anchorSig) break;
    fresh.push(s.signature);
  }
  return fresh;
}

// ================== MAIN ==================
async function main() {
  loadState();

  const conn = new Connection(RPC_URL, { commitment: "confirmed" });
  const watchPk = new PublicKey(WATCH_ADDRESS);
  const watch = watchPk.toBase58();

  console.log("✅ SOL Outflow watcher (MATCH: dest pre=0 & post digits=5, NO padding zeros)");
  console.log("WATCH:", watch);
  console.log(
    `Config: window=${WINDOW_OUTFLOWS}, required=${REQUIRED_MATCH}, range=[${MIN_SOL}, ${MAX_SOL}] SOL, poll=${POLL_SECONDS}s`
  );

  if (!state.anchorSig) {
    state.anchorSig = await fetchNewestSignature(conn, watchPk);
    state.outflows = [];
    state.lastAlertKey = null;
    saveState();
    console.log("🧊 Warm-up done. AnchorSig =", state.anchorSig);
    console.log("➡️ Only tx AFTER bot start will be processed.");
  } else {
    console.log("🔁 Loaded state. AnchorSig =", state.anchorSig);
    console.log(`🔁 Loaded outflows window: ${state.outflows.length}/${WINDOW_OUTFLOWS}`);
  }

  while (true) {
    try {
      const newSigs = await fetchNewSignatures(conn, watchPk, state.anchorSig);

      if (newSigs.length > 0) {
        state.anchorSig = newSigs[0];

        const ordered = [...newSigs].reverse();
        let addedOutflows = 0;

        for (const sig of ordered) {
          const isOut = await isOutflowTx(conn, sig, watch);
          if (!isOut) continue;

          state.outflows.unshift({ signature: sig, ts: Date.now() });
          addedOutflows++;

          if (state.outflows.length > WINDOW_OUTFLOWS) {
            state.outflows = state.outflows.slice(0, WINDOW_OUTFLOWS);
          }
        }

        saveState();
        console.log(`🆕 NewSigs=${newSigs.length} | AddedOutflows=${addedOutflows}`);
      }

      if (state.outflows.length >= WINDOW_OUTFLOWS) {
        const matches = [];

        for (const item of state.outflows) {
          const sig = item.signature;

          let txObj = null;
          let transfers = [];

          // parsed first
          try {
            txObj = await conn.getParsedTransaction(sig, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });
            if (txObj) transfers = extractTransfersFromParsed(txObj, watch);
          } catch {}

          // fallback tx
          if (!txObj) {
            try {
              txObj = await conn.getTransaction(sig, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
              });
            } catch {}
          }

          // fallback decode transfers
          if ((!transfers || transfers.length === 0) && txObj) {
            try {
              transfers = decodeSystemTransfersOutCompiled(txObj, watch);
            } catch {}
          }

          // 1 tx counts max 1 match
          for (const t of transfers || []) {
            if (!t?.to) continue;

            const pp = txObj ? getDestPrePostLamportsFromTx(txObj, t.to) : null;
            if (!pp) continue;

            const { pre, post } = pp;

            // ✅ preBalance must be 0 (brand new wallet)
            if (pre !== 0) continue;

            // ✅ range based on post (since pre=0)
            if (!inSolRangeLamports(post)) continue;

            // ✅ digits=5 based on POST balance string (trimmed, NO extra zeros)
            if (!isFiveDigitsPostBalanceLamports(post)) continue;

            const postSolStr = lamportsToSolStringTrim(post);
            matches.push({ postSolStr, destWallet: t.to, sig });
            break;
          }
        }

        const matchedCount = matches.length;
        console.log(`🧾 Window=${state.outflows.length} | Matched=${matchedCount}/${REQUIRED_MATCH}`);

        if (matchedCount >= REQUIRED_MATCH) {
          const alertKey = makeAlertKey(state.outflows);

          if (state.lastAlertKey !== alertKey) {
            state.lastAlertKey = alertKey;
            saveState();

            try {
              await sendDiscordText({
                watch,
                matches,
                windowSize: state.outflows.length,
                matchedCount,
              });
              console.log("✅ Sent Discord notify.");
            } catch (e) {
              console.error("❌ Discord webhook failed:", e?.message || e);
            }

            // reset window + reset anchor
            state.outflows = [];
            state.lastAlertKey = null;
            state.anchorSig = await fetchNewestSignature(conn, watchPk);
            saveState();

            console.log("🧼 Reset window & moved anchor after trigger.");
          } else {
            console.log("🔁 Trigger already sent for this window.");
          }
        }
      } else {
        console.log(`⏳ Waiting outflows: ${state.outflows.length}/${WINDOW_OUTFLOWS} (new sigs=${newSigs.length})`);
      }
    } catch (e) {
      console.error("❌ Loop error:", e?.message || e);
    }

    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

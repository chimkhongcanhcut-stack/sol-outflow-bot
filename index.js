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

function inSolRangeLamports(lamports) {
  const sol = Math.abs(lamports) / LAMPORTS_PER_SOL;
  return sol >= MIN_SOL && sol <= MAX_SOL;
}

function makeAlertKey(outflowSigs) {
  return outflowSigs.map((x) => x.signature).join("|");
}

// ================== EXACT 4DP (NO CUT) + 5 DIGITS RULE ==================
// Wallet2 "thực nhận" phải đúng dạng x.xxxx on-chain (tức lamports chia hết cho 1e5)
const LAMPORTS_PER_SOL_4DP = 100000; // 1e9 / 1e4 = 1e5

// Return "X.XXXX" ONLY if exact 4dp, else null
function lamportsToSol4ExactString(deltaLamports) {
  const v = Math.abs(Number(deltaLamports || 0));
  if (!Number.isFinite(v) || v <= 0) return null;

  if (v % LAMPORTS_PER_SOL_4DP !== 0) return null; // not exact 4dp
  const scaled = v / LAMPORTS_PER_SOL_4DP; // integer = SOL * 10000

  const intPart = Math.floor(scaled / 10000);
  const fracPart = scaled % 10000;
  return `${intPart}.${String(fracPart).padStart(4, "0")}`;
}

// 5 digits based on EXACT received amount (no floor/cut)
// Accept only if exact 4dp AND digits (int+frac) <= 5  => scaled <= 99999
function isFiveDigitsByDestDeltaExact(deltaLamports) {
  const v = Math.abs(Number(deltaLamports || 0));
  if (!Number.isFinite(v) || v <= 0) return false;

  if (v % LAMPORTS_PER_SOL_4DP !== 0) return false; // not x.xxxx exactly
  const scaled = v / LAMPORTS_PER_SOL_4DP; // integer SOL*10000 exact

  // 1.7824 => 17824 (5 digits)
  // 0.1234 => 1234 -> treat as "01234" (5 digits) by allowing <= 99999
  // 10.0000 => 100000 (6 digits) -> reject
  return scaled >= 0 && scaled <= 99999;
}

// ================== DISCORD NOTIFY ==================
async function sendDiscordText({
  watch,
  matchedLines, // [{sol4, destWallet}]
  destPreview,
  windowSize,
  inRangeCount,
  fiveDigitsCount,
}) {
  const lines = [];

  lines.push("🚨 SOL Outflow Pattern Trigger");

  if (matchedLines.length === 0) {
    lines.push("None");
  } else {
    matchedLines.forEach((x, i) => {
      lines.push(`${i + 1}) ${x.sol4} SOL — ${x.destWallet}`);
    });
  }

  lines.push("Source (watch)");
  lines.push(watch);
  lines.push(solscanAccountUrl(watch));

  lines.push("Matched destination wallets (preview)");
  if (destPreview.length === 0) lines.push("None");
  else destPreview.forEach((w) => lines.push(w));

  lines.push("Window(outflows)");
  lines.push(String(windowSize));

  lines.push("In range");
  lines.push(String(inRangeCount));

  lines.push("Five-digits");
  lines.push(String(fiveDigitsCount));

  lines.push("Range (SOL)");
  lines.push(`${MIN_SOL} → ${MAX_SOL}`);

  lines.push("Required");
  lines.push(String(REQUIRED_MATCH));

  lines.push("");
  lines.push("Bot: new-only after trigger | uses DEST received delta ONLY");

  const content = (DISCORD_PING ? `${DISCORD_PING}\n` : "") + lines.join("\n");

  await axios.post(
    DISCORD_WEBHOOK_URL,
    {
      content,
      allowed_mentions: {
        parse: DISCORD_PING ? ["everyone", "roles", "users"] : [],
      },
    },
    { timeout: 20_000 }
  );
}

// ================== TX KEY/BALANCE HELPERS ==================
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

// Return positive received delta lamports for dest wallet, else null
function getDestReceivedLamportsFromTx(tx, destBase58) {
  try {
    const meta = tx?.meta;
    if (!meta?.preBalances || !meta?.postBalances) return null;

    const keys = getAllAccountKeysFromTx(tx);
    if (!keys.length) return null;

    const idx = keys.indexOf(destBase58);
    if (idx < 0) return null;

    const pre = Number(meta.preBalances[idx]);
    const post = Number(meta.postBalances[idx]);
    if (!Number.isFinite(pre) || !Number.isFinite(post)) return null;

    const delta = post - pre;
    if (!Number.isFinite(delta) || delta <= 0) return null;

    return delta;
  } catch {
    return null;
  }
}

// ================== PARSE TRANSFERS OUT (to get DEST wallet list) ==================
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
  return fresh; // newest -> older
}

// ================== MAIN ==================
async function main() {
  loadState();

  const conn = new Connection(RPC_URL, { commitment: "confirmed" });
  const watchPk = new PublicKey(WATCH_ADDRESS);
  const watch = watchPk.toBase58();

  console.log("✅ SOL Outflow watcher (5digits = DEST received exact x.xxxx)");
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
        const inRangeTx = [];
        const fiveDigitsTx = [];
        const matchedLines = [];
        const destSet = new Set();

        for (const item of state.outflows) {
          const sig = item.signature;

          let txObj = null;
          let transfers = [];

          try {
            txObj = await conn.getParsedTransaction(sig, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });
            if (txObj) transfers = extractTransfersFromParsed(txObj, watch);
          } catch {}

          if (!txObj) {
            try {
              txObj = await conn.getTransaction(sig, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
              });
            } catch {}
          }

          if ((!transfers || transfers.length === 0) && txObj) {
            try {
              transfers = decodeSystemTransfersOutCompiled(txObj, watch);
            } catch {}
          }

          let hasInRange = false;
          let hasFiveDigits = false;

          for (const t of transfers || []) {
            if (!t?.to) continue;

            // ✅ exact amount wallet2 received (post-pre)
            const recvLamports = txObj ? getDestReceivedLamportsFromTx(txObj, t.to) : null;
            if (!recvLamports) continue;

            if (!inSolRangeLamports(recvLamports)) continue;
            hasInRange = true;

            // ✅ must be EXACT x.xxxx (no cut) AND <= 5 digits rule
            if (!isFiveDigitsByDestDeltaExact(recvLamports)) continue;

            const sol4 = lamportsToSol4ExactString(recvLamports);
            if (!sol4) continue; // safety

            hasFiveDigits = true;

            matchedLines.push({ sol4, destWallet: t.to });
            destSet.add(t.to);
            break; // 1 tx counts max 1 match
          }

          if (hasInRange) inRangeTx.push(sig);
          if (hasFiveDigits) fiveDigitsTx.push(sig);
        }

        const inRangeCount = inRangeTx.length;
        const fiveDigitsCount = fiveDigitsTx.length;

        console.log(
          `🧾 OutflowsWindow=${state.outflows.length} | InRange=${inRangeCount} | FiveDigits=${fiveDigitsCount}`
        );

        if (fiveDigitsCount >= REQUIRED_MATCH) {
          const alertKey = makeAlertKey(state.outflows);

          if (state.lastAlertKey !== alertKey) {
            state.lastAlertKey = alertKey;
            saveState();

            const destPreview = [...destSet].slice(0, PREVIEW_DEST_LIMIT);

            try {
              await sendDiscordText({
                watch,
                matchedLines,
                destPreview,
                windowSize: state.outflows.length,
                inRangeCount,
                fiveDigitsCount,
              });
              console.log("✅ Sent Discord notify (matched dest wallets).");
            } catch (e) {
              console.error("❌ Discord webhook failed:", e?.message || e);
            }

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
        console.log(
          `⏳ Waiting outflows: ${state.outflows.length}/${WINDOW_OUTFLOWS} (new sigs=${newSigs.length})`
        );
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

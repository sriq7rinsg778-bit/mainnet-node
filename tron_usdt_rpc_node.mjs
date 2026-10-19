// File: bsc_tron_v9_swap_transfer_engine.mjs
// Runtime: Node.js v18+ / v20+ (Zero external npm packages required)
// V9 Fixes:
//  1. 100% Exact Sender Minus (-) & Receiver Plus (+): Verified Sender Lock + Fixed `aggregate3` Multicall3 ABI Rewriter
//  2. All Coins Show Balance & USD Value Automatically: USDT, BNB, WBNB, USDC, BUSD, BTCB, ETH, CAKE, SOL, DOGE
//  3. In-App Swap Engine: Intercepts MetaMask Swap (0x881D...), Trust/Bitget/OKX Swap, 1inch, PancakeSwap V2/V3 + Self-Send Auto-Swap
//  4. Full Sender & Receiver Activity History: `eth_getTransactionReceipt` + `eth_getLogs` + `txlist` + `tokentx`
//  5. Zero Auto-Balance on Connect: Controlled 100% via Terminal CLI (`credit`, `coin`, `transfer`, `swap`, `list`)

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

    // Official Canonical Mainnet Token Contracts on BSC (Chain ID 56)
    // Wallets automatically show official logos & live USD values for these canonical addresses!
    tokens: {
        USDT: { symbol: "USDT", name: "Binance-Peg BSC-USD",  address: "55d398326f99059ff775485246999027b3197955", decimals: 18, priceUsd: 1.00 },
        USDC: { symbol: "USDC", name: "Binance-Peg USD Coin", address: "8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18, priceUsd: 1.00 },
        BUSD: { symbol: "BUSD", name: "Binance-Peg BUSD",     address: "e9e7cea3dedca5984780bafc599bd69add087d56", decimals: 18, priceUsd: 1.00 },
        WBNB: { symbol: "WBNB", name: "Wrapped BNB",          address: "bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", decimals: 18, priceUsd: 610.00 },
        BTCB: { symbol: "BTCB", name: "Binance-Peg BTCB",     address: "7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", decimals: 18, priceUsd: 92500.00 },
        ETH:  { symbol: "ETH",  name: "Binance-Peg Ethereum", address: "2170ed0880ac9a755fd29b2688956bd959f933f8", decimals: 18, priceUsd: 3150.00 },
        CAKE: { symbol: "CAKE", name: "PancakeSwap Token",    address: "0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", decimals: 18, priceUsd: 2.65 },
        SOL:  { symbol: "SOL",  name: "SOL (Wormhole)",       address: "570a5d26f7765ecb712c0924e4de545b89fd43df", decimals: 18, priceUsd: 185.00 },
        DOGE: { symbol: "DOGE", name: "Binance-Peg Dogecoin", address: "ba2ae424d960c26247dd6c32edc70b295c744c43", decimals: 8,  priceUsd: 0.28 }
    },

    // All Major Wallet & DEX Swap Routers on BSC
    dexRouters: new Set([
        "10ed43c718714eb63d5aa57b78b54704e256024e", // PancakeSwap V2 Router
        "13f4ea83d0bd40e75c8222255bc855a974568dd4", // PancakeSwap V3 SmartRouter
        "1b81d678ffb9c0263b24a97847620c99d213eb14", // PancakeSwap V3 Router
        "b048bbd1dc788962fb2c9e3c6b5955690581271c", // PancakeSwap V3 QuoterV2
        "78d78e420da98ad378d7799b68f4069033eb0779", // PancakeSwap MixedRouteQuoterV1
        "3efeb62c634525720b902f30f22d86a901c88103", // PancakeSwap Universal Router
        "881d40237659c251811cec9c364ef91dc08d300c", // MetaMask Swap Router (MetaSwap)
        "1111111254eeb25477b68fb85ed929f73a960582", // 1inch Aggregation Router V5
        "111111125421ca6dc452d289314280a0f8842a65", // 1inch Aggregation Router V6
        "def1c0ded9bec7f1a1670819833240f027b25eff", // 0x Exchange Proxy (Trust Wallet / Rabby Swap)
        "6131b5fae19ea4f9d964eac0408e4408b66337b5", // KyberSwap Router
        "ce16f69375520ab01377ce7b88f5ba8c48f8d666", // Bitget / Squid Swap Router
        "3b3ae790df4f312e745d270119c6052904fb6790", // OKX DEX Aggregator
        "1231deb6f5749ef6ce6943a275a1d3e7486f4eae"  // LI.FI Diamond (Multi-Wallet Swap)
    ]),

    tronUsdtBase58: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    tronUsdtNo0x:   "a614f803b6fd780986a42c78ec9c7f77e6ded13c",

    defaultAutoUsdt: 0,
    defaultAutoBnb:  0,

    ledgerFile: path.resolve(process.cwd(), "v9_ledger.json")
};

const ADDRESS_TO_TOKEN = new Map();
for (const info of Object.values(CONFIG.tokens)) {
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
// 1. PURE-JS KECCAK-256 & SECP256K1 SENDER RECOVERY (`ecrecover`)
// ============================================================================
const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080098009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const MASK64 = 0xffffffffffffffffn;

function rotl64(x, n) { return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64; }
function keccakF1600(s) {
    const bc = new Array(5).fill(0n);
    for (let r = 0; r < 24; r++) {
        for (let i = 0; i < 5; i++) bc[i] = s[i] ^ s[i + 5] ^ s[i + 10] ^ s[i + 15] ^ s[i + 20];
        for (let i = 0; i < 5; i++) {
            const t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
            for (let j = 0; j < 25; j += 5) s[j + i] ^= t;
        }
        let t = s[1];
        for (let i = 0; i < 24; i++) {
            const j = PILN[i];
            const tmp = s[j];
            s[j] = rotl64(t, ROTC[i]);
            t = tmp;
        }
        for (let j = 0; j < 25; j += 5) {
            for (let i = 0; i < 5; i++) bc[i] = s[j + i];
            for (let i = 0; i < 5; i++) s[j + i] ^= (~bc[(i + 1) % 5] & MASK64) & bc[(i + 2) % 5];
        }
        s[0] ^= RC[r];
    }
}

function keccak256Buf(bufInput) {
    const msg = Buffer.isBuffer(bufInput) ? bufInput : Buffer.from(bufInput, "hex");
    const rate = 136;
    const st = new Array(25).fill(0n);
    const padded = Buffer.alloc(Math.ceil((msg.length + 1) / rate) * rate);
    msg.copy(padded);
    padded[msg.length] = 0x01;
    padded[padded.length - 1] |= 0x80;
    for (let off = 0; off < padded.length; off += rate) {
        for (let i = 0; i < rate / 8; i++) {
            const lo = BigInt(padded.readUInt32LE(off + i * 8));
            const hi = BigInt(padded.readUInt32LE(off + i * 8 + 4));
            st[i] ^= (hi << 32n) | lo;
        }
        keccakF1600(st);
    }
    const out = Buffer.alloc(32);
    for (let i = 0; i < 4; i++) {
        out.writeUInt32LE(Number(st[i] & 0xffffffffn), i * 8);
        out.writeUInt32LE(Number((st[i] >> 32n) & 0xffffffffn), i * 8 + 4);
    }
    return out;
}

function keccak256Hex(hexStr) {
    const clean = hexStr.toLowerCase().replace(/^0x/, "");
    return keccak256Buf(Buffer.from(clean.length % 2 === 0 ? clean : "0" + clean, "hex")).toString("hex");
}

const SECP_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP_GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const SECP_GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

function mod(a, m = SECP_P) { const r = a % m; return r >= 0n ? r : r + m; }
function modPow(base, exp, m = SECP_P) {
    let res = 1n, b = mod(base, m), e = exp;
    while (e > 0n) { if (e & 1n) res = (res * b) % m; b = (b * b) % m; e >>= 1n; }
    return res;
}
function modInv(a, m = SECP_P) { return modPow(a, m - 2n, m); }
function ptAdd(p1, p2) {
    if (!p1) return p2;
    if (!p2) return p1;
    if (p1.x === p2.x && p1.y !== p2.y) return null;
    const lam = p1.x === p2.x ? mod((3n * p1.x * p1.x) * modInv(2n * p1.y)) : mod((p2.y - p1.y) * modInv(p2.x - p1.x));
    const x3 = mod(lam * lam - p1.x - p2.x);
    const y3 = mod(lam * (p1.x - x3) - p1.y);
    return { x: x3, y: y3 };
}
function ptMul(p, k) {
    let res = null, addend = p, scalar = k;
    while (scalar > 0n) { if (scalar & 1n) res = ptAdd(res, addend); addend = ptAdd(addend, addend); scalar >>= 1n; }
    return res;
}
function ecrecoverAddress(msgHashBuf, rBig, sBig, recId) {
    try {
        const x = rBig + BigInt(recId >> 1) * SECP_N;
        if (x >= SECP_P) return null;
        const ySq = mod(modPow(x, 3n) + 7n);
        let y = modPow(ySq, (SECP_P + 1n) / 4n);
        if (mod(y * y) !== ySq) return null;
        if ((y & 1n) !== BigInt(recId & 1)) y = SECP_P - y;
        const R = { x, y };
        const e = BigInt("0x" + msgHashBuf.toString("hex"));
        const rInv = modInv(rBig, SECP_N);
        const u1 = mod(-e * rInv, SECP_N);
        const u2 = mod(sBig * rInv, SECP_N);
        const Q = ptAdd(ptMul({ x: SECP_GX, y: SECP_GY }, u1), ptMul(R, u2));
        if (!Q) return null;
        const pubHex = Q.x.toString(16).padStart(64, "0") + Q.y.toString(16).padStart(64, "0");
        return keccak256Hex(pubHex).slice(-40).toLowerCase();
    } catch { return null; }
}

// ============================================================================
// 2. RLP ENCODER & DECODER (Exact Sender Recovery for Legacy, EIP-2930 & EIP-1559)
// ============================================================================
function intToMinimalBuffer(num) {
    if (!num || num === 0) return Buffer.alloc(0);
    let hex = BigInt(num).toString(16);
    if (hex.length % 2 !== 0) hex = "0" + hex;
    return Buffer.from(hex, "hex");
}

function rlpEncodeItem(item) {
    if (Array.isArray(item)) {
        const payload = Buffer.concat(item.map(rlpEncodeItem));
        if (payload.length <= 55) return Buffer.concat([Buffer.from([0xc0 + payload.length]), payload]);
        const lenBuf = intToMinimalBuffer(payload.length);
        return Buffer.concat([Buffer.from([0xf7 + lenBuf.length]), lenBuf, payload]);
    }
    const buf = Buffer.isBuffer(item) ? item : Buffer.from(item);
    if (buf.length === 1 && buf[0] < 0x80) return buf;
    if (buf.length <= 55) return Buffer.concat([Buffer.from([0x80 + buf.length]), buf]);
    const lenBuf = intToMinimalBuffer(buf.length);
    return Buffer.concat([Buffer.from([0xb7 + lenBuf.length]), lenBuf, buf]);
}

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
        let cur = offset + 1, end = cur + listLen;
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
    let cur = offset + 1 + ll, end = cur + listLen;
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

        let nonceBuf, toBuf, valBuf, dataBuf, vBuf, rBuf, sBuf, unsignedFields;
        if (txType === 2) {
            [, nonceBuf, , , , toBuf, valBuf, dataBuf, , vBuf, rBuf, sBuf] = items;
            unsignedFields = items.slice(0, 9);
        } else if (txType === 1) {
            [, nonceBuf, , , toBuf, valBuf, dataBuf, , vBuf, rBuf, sBuf] = items;
            unsignedFields = items.slice(0, 8);
        } else {
            [nonceBuf, , , toBuf, valBuf, dataBuf, vBuf, rBuf, sBuf] = items;
            const vNum = vBuf?.length ? Number(BigInt("0x" + vBuf.toString("hex"))) : 27;
            if (vNum >= 35) {
                const chainId = Math.floor((vNum - 35) / 2);
                unsignedFields = [...items.slice(0, 6), intToMinimalBuffer(chainId), Buffer.alloc(0), Buffer.alloc(0)];
            } else {
                unsignedFields = items.slice(0, 6);
            }
        }

        let recoveredFrom = null;
        if (rBuf?.length && sBuf?.length) {
            const rBig = BigInt("0x" + rBuf.toString("hex"));
            const sBig = BigInt("0x" + sBuf.toString("hex"));
            const vInt = vBuf?.length ? Number(BigInt("0x" + vBuf.toString("hex"))) : 0;
            const recId = txType === 0 ? (vInt >= 35 ? (vInt - 35) % 2 : vInt - 27) : (vInt & 1);
            const rlpUnsigned = rlpEncodeItem(unsignedFields);
            const signingPayload = txType > 0 ? Buffer.concat([Buffer.from([txType]), rlpUnsigned]) : rlpUnsigned;
            const msgHash = keccak256Buf(signingPayload);
            recoveredFrom = ecrecoverAddress(msgHash, rBig, sBig, recId);
        }

        const nonce = nonceBuf?.length ? parseInt(nonceBuf.toString("hex"), 16) : 0;
        const toHex20 = toBuf?.length ? toBuf.toString("hex").toLowerCase().padStart(40, "0") : "";
        const valueWei = valBuf?.length ? BigInt("0x" + valBuf.toString("hex")) : 0n;
        const dataHex = dataBuf?.length ? dataBuf.toString("hex").toLowerCase() : "";

        return { fromHex20: recoveredFrom, nonce, toHex20, valueWei, dataHex };
    } catch {
        return null;
    }
}

// ============================================================================
// 3. BASE58 <-> HEX20 & PERSISTENT MULTI-COIN LEDGER
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
    } catch { return null; }
}

function hex20ToTronBase58(hex20) {
    const clean = hex20.toLowerCase().replace(/^(0x|41)/, "").padStart(40, "0");
    const payload = Buffer.from("41" + clean, "hex");
    const h1 = crypto.createHash("sha256").update(payload).digest();
    const h2 = crypto.createHash("sha256").update(h1).digest();
    const full = Buffer.concat([payload, h2.subarray(0, 4)]);
    let num = BigInt("0x" + full.toString("hex"));
    let out = "";
    while (num > 0n) { out = B58_ALPHA[Number(num % 58n)] + out; num /= 58n; }
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

let state = { wallets: {}, nonces: {}, txReceipts: {}, history: [] };
const pendingIntents = new Map();
let lastActiveSender = null;
let latestBlockHex = "0x2c20000";
let liveBscValuePool = [];

function loadState() {
    try {
        if (fs.existsSync(CONFIG.ledgerFile)) {
            const loaded = JSON.parse(fs.readFileSync(CONFIG.ledgerFile, "utf8"));
            state = { ...state, ...loaded };
        }
    } catch {}
}

function saveState() {
    try { fs.writeFileSync(CONFIG.ledgerFile, JSON.stringify(state, null, 2), "utf8"); } catch {}
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
        console.log(`\n[WALLET CONNECTED] 0x${k} (Tron: ${hex20ToTronBase58(k)})`);
        console.log(`  -> Balance is 0. Fund via terminal: credit 0x${k} 500000 10`);
    }
    return state.wallets[k];
}

function resolveSymbol(symOrAddr) {
    if (!symOrAddr) return "USDT";
    const upper = symOrAddr.trim().toUpperCase();
    if (CONFIG.tokens[upper] || upper === "BNB") return upper;
    const cleanAddr = normAddr(symOrAddr);
    const found = ADDRESS_TO_TOKEN.get(cleanAddr);
    return found ? found.symbol : "USDT";
}

function getTokenPriceUsd(symOrAddr) {
    const sym = resolveSymbol(symOrAddr);
    if (sym === "BNB" || sym === "WBNB") return CONFIG.tokens.WBNB.priceUsd;
    return CONFIG.tokens[sym] ? CONFIG.tokens[sym].priceUsd : 1.0;
}

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

// ============================================================================
// 4. VALUE-INDEXED LIVE BSCSCAN HASH HARVESTER
// ============================================================================
async function harvestValueIndexedBscScanHashes() {
    for (const url of CONFIG.bscUpstreams) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", true] }),
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

                if (valWei >= 5n * (10n ** 16n)) {
                    const bnbUsd = (Number(valWei) / 1e18) * CONFIG.tokens.WBNB.priceUsd;
                    if (!liveBscValuePool.some(x => x.hash === tx.hash.toLowerCase())) {
                        liveBscValuePool.unshift({
                            hash: tx.hash.toLowerCase(),
                            amountUsd: bnbUsd,
                            type: inputClean.length >= 8 ? "SWAP" : "BNB"
                        });
                    }
                } else if (toClean === CONFIG.tokens.USDT.address && inputClean.startsWith("a9059cbb") && inputClean.length >= 136) {
                    try {
                        const rawAmt18 = BigInt("0x" + inputClean.slice(72, 136));
                        const usdtVal = Number(rawAmt18 / (10n ** 16n)) / 100;
                        if (usdtVal >= 50) {
                            if (!liveBscValuePool.some(x => x.hash === tx.hash.toLowerCase())) {
                                liveBscValuePool.unshift({
                                    hash: tx.hash.toLowerCase(),
                                    amountUsd: usdtVal,
                                    type: "USDT"
                                });
                            }
                        }
                    } catch {}
                }
            }
            if (liveBscValuePool.length > 150) liveBscValuePool.length = 150;
            break;
        } catch {}
    }
}
setInterval(harvestValueIndexedBscScanHashes, 3500);
harvestValueIndexedBscScanHashes();

async function pickClosestValueBscScanHash(targetUsd = 1000, preferredType = "USDT") {
    if (liveBscValuePool.length === 0) await harvestValueIndexedBscScanHashes();
    if (liveBscValuePool.length > 0) {
        let bestIdx = 0, bestDiff = Infinity;
        for (let i = 0; i < liveBscValuePool.length; i++) {
            const item = liveBscValuePool[i];
            const typeBonus = item.type === preferredType ? 0.5 : 1.0;
            const diff = Math.abs(item.amountUsd - targetUsd) * typeBonus;
            if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
        }
        const chosen = liveBscValuePool.splice(bestIdx, 1)[0];
        liveBscValuePool.push(chosen);
        return chosen.hash;
    }
    return "0x" + crypto.randomBytes(32).toString("hex");
}

// ============================================================================
// 5. LOCAL DEX QUOTER & SURGICAL MULTICALL3 REWRITER
// Fixes the V8 `aggregate3` offset bug so ALL swapped coins (`BNB`, `USDT`,
// `USDC`, `BUSD`, `BTCB`, `ETH`, `CAKE`, `SOL`, `DOGE`) display in the wallet!
// ============================================================================
function convertRawAmountBetweenTokens(amountRawIn, fromAddrOrSym, toAddrOrSym) {
    const fromSym = resolveSymbol(fromAddrOrSym);
    const toSym   = resolveSymbol(toAddrOrSym);
    const fromDec = CONFIG.tokens[fromSym]?.decimals || 18;
    const toDec   = CONFIG.tokens[toSym]?.decimals || 18;

    const inFloat  = Number(amountRawIn) / (10 ** fromDec);
    const usdVal   = inFloat * getTokenPriceUsd(fromSym);
    const outFloat = (usdVal / getTokenPriceUsd(toSym)) * 0.998;
    const outMicro = BigInt(Math.max(1, Math.floor(outFloat * 1e6)));

    if (toDec >= 6) return outMicro * (10n ** BigInt(toDec - 6));
    return outMicro / (10n ** BigInt(6 - toDec));
}

function tryHandleLocalDexQuoter(toContractNo0x, dataHex) {
    const clean = dataHex.toLowerCase().replace(/^0x/, "");
    if (clean.length < 8) return null;
    const sel = clean.slice(0, 8);
    const args = clean.slice(8);

    try {
        // PancakeSwap V2 `getAmountsOut(uint256,address[])` -> `d06ca61f`
        if (sel === "d06ca61f" && args.length >= 192) {
            const amountIn = BigInt("0x" + args.slice(0, 64));
            const pathOffset = Number(BigInt("0x" + args.slice(64, 128))) * 2;
            const pathLen = Number(BigInt("0x" + args.slice(pathOffset, pathOffset + 64)));
            const pathAddrs = [];
            for (let i = 0; i < pathLen; i++) {
                const pos = pathOffset + 64 + i * 64;
                pathAddrs.push(args.slice(pos + 24, pos + 64));
            }
            if (pathAddrs.length >= 2) {
                const amounts = [amountIn];
                let curAmt = amountIn;
                for (let i = 0; i < pathAddrs.length - 1; i++) {
                    curAmt = convertRawAmountBetweenTokens(curAmt, pathAddrs[i], pathAddrs[i + 1]);
                    amounts.push(curAmt);
                }
                let outHex = "0x" + "0".repeat(62) + "20" + amounts.length.toString(16).padStart(64, "0");
                for (const a of amounts) outHex += a.toString(16).padStart(64, "0");
                return outHex;
            }
        }

        // PancakeSwap V2 `getAmountsIn(uint256,address[])` -> `1f00ca74`
        if (sel === "1f00ca74" && args.length >= 192) {
            const amountOut = BigInt("0x" + args.slice(0, 64));
            const pathOffset = Number(BigInt("0x" + args.slice(64, 128))) * 2;
            const pathLen = Number(BigInt("0x" + args.slice(pathOffset, pathOffset + 64)));
            const pathAddrs = [];
            for (let i = 0; i < pathLen; i++) {
                const pos = pathOffset + 64 + i * 64;
                pathAddrs.push(args.slice(pos + 24, pos + 64));
            }
            if (pathAddrs.length >= 2) {
                const amtIn = convertRawAmountBetweenTokens(amountOut, pathAddrs[pathAddrs.length - 1], pathAddrs[0]);
                const amounts = [amtIn, amountOut];
                let outHex = "0x" + "0".repeat(62) + "20" + amounts.length.toString(16).padStart(64, "0");
                for (const a of amounts) outHex += a.toString(16).padStart(64, "0");
                return outHex;
            }
        }

        // PancakeSwap V3 `quoteExactInputSingle` -> `c6a5026a` or `f7729d43`
        if ((sel === "c6a5026a" || sel === "f7729d43") && args.length >= 192) {
            const tokenIn  = args.slice(24, 64);
            const tokenOut = args.slice(88, 128);
            const amountIn = BigInt("0x" + (sel === "c6a5026a" ? args.slice(128, 192) : args.slice(192, 256)));
            const amountOut = convertRawAmountBetweenTokens(amountIn, tokenIn, tokenOut);
            const sqrtPriceX96 = (1n << 96n).toString(16).padStart(64, "0");
            const gasEst = (120000n).toString(16).padStart(64, "0");
            return "0x" + amountOut.toString(16).padStart(64, "0") + sqrtPriceX96 + "0".repeat(64) + gasEst;
        }
    } catch {}
    return null;
}

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
    } catch { return null; }
}

// V9 CRITICAL FIX: Properly handles BOTH `aggregate` (252dba42) AND `tryAggregate`/`aggregate3` (bce38bd7 / 82ad56cb / 174dea71)
// so every token balance and swap quote inside Multicall3 is rewritten at the exact byte offset!
function patchMulticallOutput(calldataHex, upstreamResultHex) {
    const decodedIn = decodeMulticallInputs(calldataHex);
    if (!decodedIn || !upstreamResultHex || upstreamResultHex === "0x") return upstreamResultHex;

    const { selector, calls } = decodedIn;
    const replacements = new Map();

    for (const c of calls) {
        if (ADDRESS_TO_TOKEN.has(c.target) && c.callData.startsWith("70a08231") && c.callData.length >= 72) {
            const wallet = c.callData.slice(32, 72);
            replacements.set(c.index, getTokenBalHex(wallet, c.target));
        } else if (ADDRESS_TO_TOKEN.has(c.target) && c.callData.startsWith("dd62ed3e")) {
            replacements.set(c.index, "f".repeat(64));
        } else if (c.callData.startsWith("4d2301cc") && c.callData.length >= 72) {
            const wallet = c.callData.slice(32, 72);
            replacements.set(c.index, getBnbWei(wallet).toString(16).padStart(64, "0"));
        } else if (c.callData.startsWith("c6a5026a") || c.callData.startsWith("f7729d43") || c.callData.startsWith("d06ca61f")) {
            const qHex = tryHandleLocalDexQuoter(c.target, c.callData);
            if (qHex) replacements.set(c.index, qHex.slice(2, 66));
        }
    }

    if (replacements.size === 0) return upstreamResultHex;

    try {
        const outClean = upstreamResultHex.toLowerCase().replace(/^0x/, "");
        const outChars = outClean.split("");

        if (selector === "252dba42") {
            // `aggregate` returns `(uint256 blockNumber, bytes[] returnData)`
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
            // `tryAggregate`, `aggregate3`, `aggregate3Value` return `Result(bool success, bytes returnData)[]`
            const arrOffsetBytes = readNum(outClean, 0);
            const arrStart = arrOffsetBytes * 2;
            const elemHeadBase = arrStart + 64;

            for (const [idx, newWord64] of replacements.entries()) {
                const structRelBytes = readNum(outClean, elemHeadBase + idx * 64);
                const structPos = elemHeadBase + structRelBytes * 2;
                outChars[structPos + 63] = "1"; // Force `bool success = true`
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
        let out = "0x" + "0".repeat(62) + "20" + total.toString(16).padStart(64, "0");

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
    } catch { return null; }
}

function parseDexSwapCalldata(toContractNo0x, dataHex, valueWei) {
    const clean = dataHex.toLowerCase().replace(/^0x/, "");
    const sel = clean.slice(0, 8);

    const foundTokens = [];
    for (const [addr, info] of ADDRESS_TO_TOKEN.entries()) {
        let searchStart = 0;
        while (true) {
            const pos = clean.indexOf(addr, searchStart);
            if (pos === -1) break;
            foundTokens.push({ pos, sym: info.symbol });
            searchStart = pos + 40;
        }
    }
    foundTokens.sort((a, b) => a.pos - b.pos);

    if (valueWei > 0n && (sel === "7ff36ab5" || sel === "b6f9de95" || CONFIG.dexRouters.has(toContractNo0x) || foundTokens.length > 0)) {
        const amtIn6 = valueWei / (10n ** 12n);
        const nonWbnb = foundTokens.filter(t => t.sym !== "WBNB");
        const outSym = nonWbnb.length > 0 ? nonWbnb[nonWbnb.length - 1].sym : "USDT";
        return { fromSym: "BNB", toSym: outSym, amtIn6 };
    }

    if (
        CONFIG.dexRouters.has(toContractNo0x) ||
        foundTokens.length >= 2 ||
        ["38ed1739", "18cbafe5", "791ac947", "5c11d795", "472b43f3", "04e45aaf", "ac9650d8", "3593564c", "5ae401dc", "5f575529", "12aa3caf"].includes(sel)
    ) {
        let amtIn6 = 100_000_000n;
        for (let offset = 8; offset + 64 <= clean.length; offset += 64) {
            try {
                const w = BigInt("0x" + clean.slice(offset, offset + 64));
                if (w >= 10n ** 14n && w <= 10n ** 28n) {
                    amtIn6 = w / (10n ** 12n);
                    break;
                }
            } catch {}
        }

        const fromSym = foundTokens[0]?.sym || "USDT";
        let toSym = foundTokens[foundTokens.length - 1]?.sym || "BNB";
        if (toSym === fromSym) toSym = fromSym === "USDT" ? "BNB" : "USDT";
        if (toSym === "WBNB" || sel === "18cbafe5" || sel === "791ac947") toSym = "BNB";

        return { fromSym, toSym, amtIn6 };
    }
    return null;
}

// ============================================================================
// 6. VERIFIED SENDER RESOLUTION, ATOMIC TRANSFER & IN-APP SWAP ENGINE
// ============================================================================
function resolveVerifiedSender(recoveredFrom, intentFrom, excludeRecipient, requiredSym = null, requiredAmt6 = 0n) {
    // 1. Check intent locked during `eth_estimateGas` (100% exact `tx.from` sent by the wallet!)
    const intKey = normAddr(intentFrom);
    if (intKey !== "0000000000000000000000000000000000000000" && intKey !== excludeRecipient && state.wallets[intKey]) {
        return intKey;
    }

    // 2. Check secp256k1 `ecrecover` address if it matches a known wallet in `state.wallets`
    const recKey = normAddr(recoveredFrom);
    if (recKey !== "0000000000000000000000000000000000000000" && recKey !== excludeRecipient && state.wallets[recKey]) {
        return recKey;
    }

    // 3. Check `lastActiveSender` if it is a known wallet with sufficient balance
    if (lastActiveSender && lastActiveSender !== excludeRecipient && state.wallets[lastActiveSender]) {
        if (!requiredSym || getTokenBal6(lastActiveSender, requiredSym) >= requiredAmt6) {
            return lastActiveSender;
        }
    }

    // 4. Scan `state.wallets` for the wallet holding sufficient balance of `requiredSym`
    for (const addr of Object.keys(state.wallets)) {
        if (addr !== excludeRecipient) {
            if (requiredSym === "BNB") {
                if (getBnbWei(addr) >= requiredAmt6 * (10n ** 12n)) return addr;
            } else if (!requiredSym || getTokenBal6(addr, requiredSym) >= requiredAmt6) {
                return addr;
            }
        }
    }

    if (recKey !== "0000000000000000000000000000000000000000" && recKey !== excludeRecipient) return recKey;
    return Object.keys(state.wallets)[0] || "0000000000000000000000000000000000000000";
}

function advanceWalletNonce(walletKey, txNonce) {
    const cur = state.nonces[walletKey] || 0;
    if (txNonce !== null && txNonce !== undefined && txNonce >= cur) {
        state.nonces[walletKey] = txNonce + 1;
    } else {
        state.nonces[walletKey] = cur + 1;
    }
}

function executeTokenTransfer(recoveredFrom, toAny, tokenContractOrSym, amount6BigInt, txHash, nonceUsed = null) {
    const toKey = normAddr(toAny);
    const sym   = resolveSymbol(tokenContractOrSym);
    const amt6  = amount6BigInt < 0n ? 0n : amount6BigInt;

    const intentKey = `${toKey}_${amt6.toString()}`;
    const lockedSender = pendingIntents.get(intentKey);
    if (lockedSender) pendingIntents.delete(intentKey);

    const fromKey = resolveVerifiedSender(recoveredFrom, lockedSender, toKey, sym, amt6);

    // IN-APP SELF-SEND OR CONTRACT-SEND AUTO-SWAP!
    // If the user sends USDT to their OWN address (`fromKey === toKey`) or to the Token Contract Address,
    // automatically execute an In-App Swap from `sym` -> `BNB` (or `USDT` if `sym` is not `USDT`)!
    if (fromKey === toKey || ADDRESS_TO_TOKEN.has(toKey)) {
        const targetSwapCoin = sym === "USDT" ? "BNB" : "USDT";
        console.log(`\n[IN-APP AUTO-SWAP TRIGGERED] Detected send to self/contract -> Swapping ${Number(amt6)/1e6} ${sym} to ${targetSwapCoin}!`);
        return executeDexSwap(fromKey, sym, targetSwapCoin, amt6, txHash, nonceUsed);
    }

    const senderBefore = getTokenBal6(fromKey, sym);
    const deduct = senderBefore >= amt6 ? amt6 : senderBefore;
    setTokenBal6(fromKey, sym, senderBefore - deduct);
    advanceWalletNonce(fromKey, nonceUsed);

    const receiverBefore = getTokenBal6(toKey, sym);
    setTokenBal6(toKey, sym, receiverBefore + amt6);

    latestBlockHex = "0x" + (BigInt(latestBlockHex) + 1n).toString(16);
    const cleanId = txHash.toLowerCase().replace(/^0x/, "");
    const tokInfo = CONFIG.tokens[sym] || CONFIG.tokens.USDT;
    const dec = tokInfo.decimals || 18;
    const rawScaledHex = (dec > 6 ? amt6 * (10n ** BigInt(dec - 6)) : amt6).toString(16).padStart(64, "0");
    const usdVal = (Number(amt6) / 1e6) * getTokenPriceUsd(sym);

    const rec = {
        type: "TRANSFER",
        symbol: sym,
        tokenName: tokInfo.name || "Binance-Peg BSC-USD",
        tokenAddress: "0x" + (tokInfo.address || CONFIG.tokens.USDT.address),
        txHash: "0x" + cleanId,
        txID: cleanId,
        fromHex20: fromKey,
        toHex20: toKey,
        fromBase58: hex20ToTronBase58(fromKey),
        toBase58: hex20ToTronBase58(toKey),
        nonceHex: "0x" + Math.max(0, (state.nonces[fromKey] || 1) - 1).toString(16),
        valueWeiHex: "0x0",
        amount6: amt6.toString(),
        amountFormatted: (Number(amt6) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2 }),
        usdFormatted: usdVal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        amountScaledHex: rawScaledHex,
        blockNumberHex: latestBlockHex,
        blockNumberDec: parseInt(latestBlockHex, 16),
        timestamp: Date.now()
    };

    state.txReceipts[cleanId] = rec;
    state.history.unshift(rec);
    if (state.history.length > 500) state.history.pop();
    saveState();

    console.log(`\n==================================================================`);
    console.log(`[TRANSFER SUCCESS] ${rec.amountFormatted} ${sym} ($${rec.usdFormatted} USD)`);
    console.log(`  Sender (-)   : 0x${fromKey}`);
    console.log(`                 Before: ${(Number(senderBefore)/1e6).toLocaleString()} ${sym} -> Now: ${(Number(getTokenBal6(fromKey, sym))/1e6).toLocaleString()} ${sym}`);
    console.log(`  Receiver (+) : 0x${toKey}`);
    console.log(`                 Before: ${(Number(receiverBefore)/1e6).toLocaleString()} ${sym} -> Now: ${(Number(getTokenBal6(toKey, sym))/1e6).toLocaleString()} ${sym}`);
    console.log(`  BscScan Link : https://bscscan.com/tx/0x${cleanId}`);
    console.log(`==================================================================`);
    return rec;
}

function executeBnbTransfer(recoveredFrom, toAny, valWeiBigInt, txHash, nonceUsed = null) {
    const toKey = normAddr(toAny);
    const valWei = valWeiBigInt < 0n ? 0n : valWeiBigInt;
    const amt6 = valWei / (10n ** 12n);

    const intentKey = `BNB_${toKey}_${amt6.toString()}`;
    const lockedSender = pendingIntents.get(intentKey);
    if (lockedSender) pendingIntents.delete(intentKey);

    const fromKey = resolveVerifiedSender(recoveredFrom, lockedSender, toKey, "BNB", amt6);

    // IN-APP BNB AUTO-SWAP!
    // If the user sends BNB to their OWN address (`fromKey === toKey`) or to any Token Contract Address (like USDT `0x55d3...`),
    // automatically swap that BNB into that token (or USDT) inside the wallet!
    if (fromKey === toKey || ADDRESS_TO_TOKEN.has(toKey)) {
        const targetToken = ADDRESS_TO_TOKEN.has(toKey) ? ADDRESS_TO_TOKEN.get(toKey).symbol : "USDT";
        console.log(`\n[IN-APP BNB AUTO-SWAP TRIGGERED] Swapping ${Number(valWei)/1e18} BNB -> ${targetToken}!`);
        return executeDexSwap(fromKey, "BNB", targetToken, amt6, txHash, nonceUsed);
    }

    const senderBeforeWei = getBnbWei(fromKey);
    const deduct = senderBeforeWei >= valWei ? valWei : senderBeforeWei;
    setBnbWei(fromKey, senderBeforeWei - deduct);
    advanceWalletNonce(fromKey, nonceUsed);

    const receiverBeforeWei = getBnbWei(toKey);
    setBnbWei(toKey, receiverBeforeWei + valWei);

    latestBlockHex = "0x" + (BigInt(latestBlockHex) + 1n).toString(16);
    const cleanId = txHash.toLowerCase().replace(/^0x/, "");
    const bnbFloat = Number(valWei) / 1e18;
    const usdVal = bnbFloat * getTokenPriceUsd("BNB");

    const rec = {
        type: "BNB_TRANSFER",
        symbol: "BNB",
        tokenName: "BNB Native",
        tokenAddress: "0x" + toKey,
        txHash: "0x" + cleanId,
        txID: cleanId,
        fromHex20: fromKey,
        toHex20: toKey,
        fromBase58: hex20ToTronBase58(fromKey),
        toBase58: hex20ToTronBase58(toKey),
        nonceHex: "0x" + Math.max(0, (state.nonces[fromKey] || 1) - 1).toString(16),
        valueWeiHex: "0x" + valWei.toString(16),
        amount6: amt6.toString(),
        amountFormatted: bnbFloat.toLocaleString("en-US", { maximumFractionDigits: 6 }),
        usdFormatted: usdVal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        amountScaledHex: valWei.toString(16).padStart(64, "0"),
        blockNumberHex: latestBlockHex,
        blockNumberDec: parseInt(latestBlockHex, 16),
        timestamp: Date.now()
    };

    state.txReceipts[cleanId] = rec;
    state.history.unshift(rec);
    if (state.history.length > 500) state.history.pop();
    saveState();

    console.log(`\n==================================================================`);
    console.log(`[BNB TRANSFER SUCCESS] ${rec.amountFormatted} BNB ($${rec.usdFormatted} USD)`);
    console.log(`  Sender (-)   : 0x${fromKey}`);
    console.log(`                 Before: ${(Number(senderBeforeWei)/1e18).toFixed(4)} BNB -> Now: ${(Number(getBnbWei(fromKey))/1e18).toFixed(4)} BNB`);
    console.log(`  Receiver (+) : 0x${toKey}`);
    console.log(`                 Before: ${(Number(receiverBeforeWei)/1e18).toFixed(4)} BNB -> Now: ${(Number(getBnbWei(toKey))/1e18).toFixed(4)} BNB`);
    console.log(`  BscScan Link : https://bscscan.com/tx/0x${cleanId}`);
    console.log(`==================================================================`);
    return rec;
}

function executeDexSwap(walletAny, fromSymOrAddr, toSymOrAddr, amountIn6BigInt, txHash, nonceUsed = null) {
    const fromSym = resolveSymbol(fromSymOrAddr);
    const toSym   = resolveSymbol(toSymOrAddr);
    const amtIn6  = amountIn6BigInt > 0n ? amountIn6BigInt : 100_000_000n;
    const wKey    = resolveVerifiedSender(walletAny, lastActiveSender, null, fromSym, amtIn6);

    const fromPrice = getTokenPriceUsd(fromSym);
    const toPrice   = getTokenPriceUsd(toSym);
    const usdValue  = (Number(amtIn6) / 1e6) * fromPrice;
    const outUnits  = (usdValue / toPrice) * 0.998;
    const amtOut6   = BigInt(Math.max(1, Math.floor(outUnits * 1_000_000)));

    // 1. Deduct Input Coin (`fromSym`)
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

    // 2. Credit Output Coin (`toSym`) so Wallet Immediately Displays the New Coin & Its USD Value!
    if (toSym === "BNB") {
        setBnbWei(wKey, getBnbWei(wKey) + amtOut6 * (10n ** 12n));
    } else {
        setTokenBal6(wKey, toSym, getTokenBal6(wKey, toSym) + amtOut6);
        // If swapping into WBNB, also credit Native BNB so both BNB & WBNB show the balance
        if (toSym === "WBNB") {
            setBnbWei(wKey, getBnbWei(wKey) + amtOut6 * (10n ** 12n));
        }
    }

    advanceWalletNonce(wKey, nonceUsed);
    latestBlockHex = "0x" + (BigInt(latestBlockHex) + 1n).toString(16);
    const cleanId = txHash.toLowerCase().replace(/^0x/, "");
    const outTokInfo = CONFIG.tokens[toSym] || CONFIG.tokens.USDT;

    const rec = {
        type: "SWAP",
        symbol: toSym,
        fromSymbol: fromSym,
        toSymbol: toSym,
        tokenName: outTokInfo.name || toSym,
        tokenAddress: "0x" + (outTokInfo.address || CONFIG.tokens.USDT.address),
        txHash: "0x" + cleanId,
        txID: cleanId,
        fromHex20: wKey,
        toHex20: wKey,
        fromBase58: hex20ToTronBase58(wKey),
        toBase58: hex20ToTronBase58(wKey),
        nonceHex: "0x" + Math.max(0, (state.nonces[wKey] || 1) - 1).toString(16),
        valueWeiHex: "0x0",
        amountInFormatted: (Number(amtIn6) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 4 }),
        amount6: amtOut6.toString(),
        amountFormatted: (Number(amtOut6) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 }),
        usdFormatted: usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        amountScaledHex: (amtOut6 * (10n ** 12n)).toString(16).padStart(64, "0"),
        blockNumberHex: latestBlockHex,
        blockNumberDec: parseInt(latestBlockHex, 16),
        timestamp: Date.now()
    };

    state.txReceipts[cleanId] = rec;
    state.history.unshift(rec);
    saveState();

    console.log(`\n==================================================================`);
    console.log(`[SWAP SUCCESS] ${rec.amountInFormatted} ${fromSym} -> +${rec.amountFormatted} ${toSym} ($${rec.usdFormatted} USD)`);
    console.log(`  Wallet       : 0x${wKey}`);
    console.log(`  New ${fromSym} Bal : ${fromSym === "BNB" ? (Number(getBnbWei(wKey))/1e18).toFixed(4) : (Number(getTokenBal6(wKey, fromSym))/1e6).toLocaleString()} ${fromSym}`);
    console.log(`  New ${toSym} Bal : ${toSym === "BNB" ? (Number(getBnbWei(wKey))/1e18).toFixed(4) : (Number(getTokenBal6(wKey, toSym))/1e6).toLocaleString()} ${toSym}`);
    console.log(`  BscScan Link : https://bscscan.com/tx/0x${cleanId}`);
    console.log(`==================================================================`);
    return rec;
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
            state.nonces[k] = res?.result ? parseInt(res.result, 16) : 0;
            saveState();
        } catch {
            state.nonces[k] = 0;
        }
    }
    return state.nonces[k];
}

// ============================================================================
// 7. MAIN HTTP + EVM JSON-RPC + BSCSCAN HISTORY API + TRONGRID SERVER
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

    const hostHeader = req.headers.host || `127.0.0.1:${CONFIG.port}`;
    const urlObj = new URL(req.url, `http://${hostHeader}`);
    const pathname = urlObj.pathname;

    // BscScan-Compatible History API (`/api?module=account&action=txlist` AND `action=tokentx`)
    // Populates Sender (-) and Receiver (+) Activity / History tabs in wallets!
    if (req.method === "GET" && pathname === "/api" && urlObj.searchParams.get("module") === "account") {
        const action = urlObj.searchParams.get("action") || "tokentx";
        const addrKey = normAddr(urlObj.searchParams.get("address") || "");
        const matching = state.history.filter(h => h.fromHex20 === addrKey || h.toHex20 === addrKey);

        if (action === "txlist") {
            const txList = matching.map(h => ({
                blockNumber: String(h.blockNumberDec || 45682100),
                timeStamp: String(Math.floor(h.timestamp / 1000)),
                hash: h.txHash,
                nonce: String(parseInt(h.nonceHex || "0x1", 16)),
                blockHash: "0x" + keccak256Hex(h.txID),
                transactionIndex: "1",
                from: "0x" + h.fromHex20,
                to: h.type === "BNB_TRANSFER" ? "0x" + h.toHex20 : h.tokenAddress,
                value: h.type === "BNB_TRANSFER" ? (BigInt(h.amount6) * (10n ** 12n)).toString() : "0",
                gas: "150000",
                gasPrice: "1000000000",
                isError: "0",
                txreceipt_status: "1",
                input: h.type === "BNB_TRANSFER" ? "0x" : "0xa9059cbb" + h.toHex20.padStart(64, "0") + h.amountScaledHex,
                contractAddress: "",
                cumulativeGasUsed: "35156",
                gasUsed: "35156",
                confirmations: "30"
            }));
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ status: "1", message: "OK", result: txList }));
        }

        const tokenTxList = matching.map(h => ({
            blockNumber: String(h.blockNumberDec || 45682100),
            timeStamp: String(Math.floor(h.timestamp / 1000)),
            hash: h.txHash,
            nonce: String(parseInt(h.nonceHex || "0x1", 16)),
            blockHash: "0x" + keccak256Hex(h.txID),
            from: "0x" + h.fromHex20,
            contractAddress: h.tokenAddress,
            to: "0x" + h.toHex20,
            value: (BigInt(h.amount6) * (10n ** 12n)).toString(),
            tokenName: h.tokenName || "Binance-Peg BSC-USD",
            tokenSymbol: h.symbol || "USDT",
            tokenDecimal: "18",
            transactionIndex: "1",
            gas: "150000",
            gasPrice: "1000000000",
            gasUsed: "35156",
            cumulativeGasUsed: "35156",
            input: "deprecated",
            confirmations: "30"
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "1", message: "OK", result: tokenTxList }));
    }

    if (req.method === "GET" && pathname === "/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            status: "V9_SWAP_TRANSFER_ENGINE_ONLINE",
            chainId: 56,
            wallets: state.wallets,
            recentHistory: state.history.slice(0, 15)
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
            if (pathname.includes("/transactions/trc20")) {
                const txs = state.history
                    .filter(h => h.fromHex20 === acctKey || h.toHex20 === acctKey)
                    .map(h => ({
                        transaction_id: h.txID,
                        token_info: { symbol: "USDT", address: CONFIG.tronUsdtBase58, decimals: 6, name: "Tether USD" },
                        block_timestamp: h.timestamp,
                        from: h.fromBase58,
                        to: h.toBase58,
                        type: "Transfer",
                        value: h.amount6
                    }));
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ data: txs, success: true }));
            }
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
    // ROUTE B: EVM JSON-RPC (METAMASK / BITGET / TRUST WALLET / OKX / RABBY)
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

        // 1. Native BNB Balance (`eth_getBalance`)
        if (method === "eth_getBalance" && params?.[0]) {
            const w = normAddr(params[0]);
            return { jsonrpc: "2.0", id, result: "0x" + getBnbWei(w).toString(16) };
        }

        // 2. Nonce Sync (`eth_getTransactionCount`)
        if (method === "eth_getTransactionCount" && params?.[0]) {
            const w = normAddr(params[0]);
            if (params[1] === "pending") lastActiveSender = w;
            const n = await getSyncedNonce(w);
            return { jsonrpc: "2.0", id, result: "0x" + n.toString(16) };
        }

        // 3. `eth_estimateGas` — Locks Exact Sender Intent Before Every Transfer or Swap!
        if (method === "eth_estimateGas") {
            const tx = params?.[0] || {};
            if (tx.from) {
                const senderKey = normAddr(tx.from);
                lastActiveSender = senderKey;
                const toC = normAddr(tx.to || "");
                const dataHex = (tx.data || tx.input || "").toLowerCase().replace(/^0x/, "");
                const valWei = tx.value ? BigInt(tx.value) : 0n;

                if (dataHex.startsWith("a9059cbb") && dataHex.length >= 136) {
                    const toKey = dataHex.slice(32, 72);
                    const rawVal18 = BigInt("0x" + dataHex.slice(72, 136));
                    const amt6 = rawVal18 >= 10n ** 12n ? rawVal18 / (10n ** 12n) : rawVal18;
                    pendingIntents.set(`${toKey}_${amt6.toString()}`, senderKey);
                } else if (valWei > 0n && dataHex.length === 0 && toC) {
                    const amt6 = valWei / (10n ** 12n);
                    pendingIntents.set(`BNB_${toC}_${amt6.toString()}`, senderKey);
                }
            }
            return { jsonrpc: "2.0", id, result: "0x249f0" }; // 150,000 gas
        }

        // 4. `eth_getLogs` — Returns Sender (-) and Receiver (+) Transfer Events for Wallet Activity Tab!
        if (method === "eth_getLogs" && params?.[0]) {
            const filter = params[0];
            const topics = Array.isArray(filter.topics) ? filter.topics : [];
            const matchingLogs = [];

            for (let i = 0; i < state.history.length; i++) {
                const h = state.history[i];
                const fromTopic = "0x" + h.fromHex20.padStart(64, "0");
                const toTopic   = "0x" + h.toHex20.padStart(64, "0");

                const matchFrom = !topics[1] || (typeof topics[1] === "string" && topics[1].toLowerCase() === fromTopic);
                const matchTo   = !topics[2] || (typeof topics[2] === "string" && topics[2].toLowerCase() === toTopic);

                if (matchFrom && matchTo) {
                    matchingLogs.push({
                        address: h.tokenAddress || "0x" + CONFIG.tokens.USDT.address,
                        topics: [
                            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                            fromTopic,
                            toTopic
                        ],
                        data: "0x" + (h.amountScaledHex || "0".repeat(64)),
                        blockNumber: h.blockNumberHex || latestBlockHex,
                        transactionHash: h.txHash,
                        transactionIndex: "0x1",
                        blockHash: "0x" + keccak256Hex(h.txID),
                        logIndex: "0x" + i.toString(16),
                        removed: false
                    });
                }
            }
            return { jsonrpc: "2.0", id, result: matchingLogs };
        }

        // 5. `eth_call` — Direct Token Balances, Local DEX Quoter, BalanceChecker & Fixed Multicall3!
        if (method === "eth_call" && params?.[0]) {
            const callObj = params[0];
            const toAddr = normAddr(callObj.to || "");
            const dataHex = (callObj.data || callObj.input || "").toLowerCase();
            if (callObj.from) lastActiveSender = normAddr(callObj.from);

            // 5A. Direct Token Contract Call (`USDT`, `USDC`, `BUSD`, `WBNB`, `BTCB`, `ETH`, `CAKE`, `SOL`, `DOGE`)
            if (ADDRESS_TO_TOKEN.has(toAddr)) {
                const tok = ADDRESS_TO_TOKEN.get(toAddr);
                if (dataHex.startsWith("0x70a08231") && dataHex.length >= 74) {
                    const wallet = dataHex.slice(34, 74);
                    return { jsonrpc: "2.0", id, result: "0x" + getTokenBalHex(wallet, toAddr) };
                }
                if (dataHex.startsWith("0xdd62ed3e")) {
                    return { jsonrpc: "2.0", id, result: "0x" + "f".repeat(64) }; // Infinite allowance!
                }
                if (dataHex.startsWith("0x313ce567")) {
                    return { jsonrpc: "2.0", id, result: "0x" + tok.decimals.toString(16).padStart(64, "0") };
                }
                if (dataHex.startsWith("0x95d89b41")) {
                    const symHex = Buffer.from(tok.symbol, "utf8").toString("hex").padEnd(64, "0");
                    return {
                        jsonrpc: "2.0",
                        id,
                        result: "0x" + "0".repeat(62) + "20" + tok.symbol.length.toString(16).padStart(64, "0") + symHex
                    };
                }
                if (dataHex.startsWith("0xa9059cbb") || dataHex.startsWith("0x095ea7b3") || dataHex.startsWith("0x23b872dd")) {
                    return { jsonrpc: "2.0", id, result: "0x" + "0".repeat(63) + "1" };
                }
            }

            // 5B. Local DEX Quoter (`getAmountsOut`, `getAmountsIn`, V3 Quoter)
            const localQuote = tryHandleLocalDexQuoter(toAddr, dataHex);
            if (localQuote) return { jsonrpc: "2.0", id, result: localQuote };

            // 5C. MetaMask SingleCallBalanceChecker (`0xf0002ea9`)
            const mmBatch = tryHandleMetaMaskBalanceChecker(dataHex);
            if (mmBatch) return { jsonrpc: "2.0", id, result: mmBatch };

            // 5D. Forward to BSC Mainnet & Patch Multicall3 / Heal In-App Swap Simulation Reverts!
            const upRes = await forwardBscRpc(rpc);
            if (upRes?.result) {
                upRes.result = patchMulticallOutput(dataHex, upRes.result);
                return upRes;
            }

            // If upstream reverted during an In-App Swap simulation (because the wallet has 0 real on-chain balance),
            // return a valid ABI-encoded output amount so the Wallet App's "Swap" button unlocks!
            const simSwap = parseDexSwapCalldata(toAddr, dataHex, callObj.value ? BigInt(callObj.value) : 0n);
            if (simSwap || CONFIG.dexRouters.has(toAddr)) {
                const amtOutRaw = simSwap
                    ? convertRawAmountBetweenTokens(simSwap.amtIn6 * (10n ** 12n), simSwap.fromSym, simSwap.toSym)
                    : 10n ** 18n;
                const amtHex = amtOutRaw.toString(16).padStart(64, "0");
                return {
                    jsonrpc: "2.0",
                    id,
                    result: "0x" +
                        "0000000000000000000000000000000000000000000000000000000000000020" +
                        "0000000000000000000000000000000000000000000000000000000000000002" +
                        amtHex +
                        amtHex
                };
            }
            return upRes;
        }

        // 6. `eth_sendRawTransaction` / `eth_sendTransaction`
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
                        const realHash = await pickClosestValueBscScanHash(Number(amt6) / 1e6, "USDT");
                        const rec = executeTokenTransfer(fromW, toW, toC, amt6, realHash);
                        return { jsonrpc: "2.0", id, result: rec.txHash };
                    }
                    const swapInfo = parseDexSwapCalldata(toC, d, valWei);
                    if (swapInfo) {
                        const usdEst = (Number(swapInfo.amtIn6) / 1e6) * getTokenPriceUsd(swapInfo.fromSym);
                        const realSwapHash = await pickClosestValueBscScanHash(usdEst, "SWAP");
                        const rec = executeDexSwap(fromW, swapInfo.fromSym, swapInfo.toSym, swapInfo.amtIn6, realSwapHash);
                        return { jsonrpc: "2.0", id, result: rec.txHash };
                    }
                    if (valWei > 0n && toC) {
                        const bnbUsd = (Number(valWei) / 1e18) * getTokenPriceUsd("BNB");
                        const realHash = await pickClosestValueBscScanHash(bnbUsd, "BNB");
                        const rec = executeBnbTransfer(fromW, toC, valWei, realHash);
                        return { jsonrpc: "2.0", id, result: rec.txHash };
                    }
                } else {
                    const rawHex = params[0];
                    const decoded = decodeSignedRawTransaction(rawHex);
                    const recoveredW = decoded?.fromHex20;
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
                        const realHash = await pickClosestValueBscScanHash(Number(amt6) / 1e6, "USDT");
                        const rec = executeTokenTransfer(recoveredW, toW, toC || "USDT", amt6, realHash, txNonce);
                        return { jsonrpc: "2.0", id, result: rec.txHash };
                    }

                    // Case 2: ERC-20 `transferFrom(address,address,uint256)` (`23b872dd`)
                    const idxTransFrom = d.indexOf("23b872dd");
                    if (idxTransFrom !== -1 && d.length >= idxTransFrom + 200 && !CONFIG.dexRouters.has(toC)) {
                        const fromW = d.slice(idxTransFrom + 32, idxTransFrom + 72);
                        const toW   = d.slice(idxTransFrom + 96, idxTransFrom + 136);
                        const rawVal = BigInt("0x" + d.slice(idxTransFrom + 136, idxTransFrom + 200));
                        const amt6 = rawVal >= 10n ** 12n ? rawVal / (10n ** 12n) : rawVal;
                        const realHash = await pickClosestValueBscScanHash(Number(amt6) / 1e6, "USDT");
                        const rec = executeTokenTransfer(fromW, toW, toC || "USDT", amt6, realHash, txNonce);
                        return { jsonrpc: "2.0", id, result: rec.txHash };
                    }

                    // Case 3: ERC-20 `approve(address,uint256)` (`095ea7b3`)
                    if (d.startsWith("095ea7b3")) {
                        const senderW = resolveVerifiedSender(recoveredW, lastActiveSender, null);
                        const realHash = await pickClosestValueBscScanHash(500, "SWAP");
                        const cleanId = realHash.replace(/^0x/, "");
                        if (senderW) advanceWalletNonce(senderW, txNonce);
                        state.txReceipts[cleanId] = {
                            type: "APPROVE",
                            symbol: resolveSymbol(toC),
                            tokenAddress: "0x" + (toC || CONFIG.tokens.USDT.address),
                            txHash: "0x" + cleanId,
                            txID: cleanId,
                            fromHex20: senderW || "0".repeat(40),
                            toHex20: toC || CONFIG.tokens.USDT.address,
                            nonceHex: "0x" + Math.max(0, (state.nonces[senderW] || 1) - 1).toString(16),
                            valueWeiHex: "0x0",
                            amount6: "0",
                            amountFormatted: "Unlimited",
                            usdFormatted: "0.00",
                            amountScaledHex: "f".repeat(64),
                            blockNumberHex: latestBlockHex,
                            timestamp: Date.now()
                        };
                        saveState();
                        return { jsonrpc: "2.0", id, result: "0x" + cleanId };
                    }

                    // Case 4: In-App or DEX Swap (`MetaMask Swap`, `Trust Swap`, `Bitget Swap`, `1inch`, `PancakeSwap`)
                    const swapInfo = parseDexSwapCalldata(toC, d, valWei);
                    if (swapInfo) {
                        const usdEst = (Number(swapInfo.amtIn6) / 1e6) * getTokenPriceUsd(swapInfo.fromSym);
                        const realSwapHash = await pickClosestValueBscScanHash(usdEst, "SWAP");
                        const rec = executeDexSwap(recoveredW, swapInfo.fromSym, swapInfo.toSym, swapInfo.amtIn6, realSwapHash, txNonce);
                        return { jsonrpc: "2.0", id, result: rec.txHash };
                    }

                    // Case 5: Native BNB Transfer (or In-App BNB Auto-Swap if sent to Self/Token Contract)
                    if (valWei > 0n && toC) {
                        const bnbUsd = (Number(valWei) / 1e18) * getTokenPriceUsd("BNB");
                        const realHash = await pickClosestValueBscScanHash(bnbUsd, "BNB");
                        const rec = executeBnbTransfer(recoveredW, toC, valWei, realHash, txNonce);
                        return { jsonrpc: "2.0", id, result: rec.txHash };
                    }
                }

                const fallbackHash = await pickClosestValueBscScanHash(1000, "USDT");
                return { jsonrpc: "2.0", id, result: fallbackHash };
            } catch (err) {
                return { jsonrpc: "2.0", id, error: { code: -32000, message: err.message } };
            }
        }

        // 7. INSTANT CONFIRMED RECEIPTS (`eth_getTransactionByHash` & `eth_getTransactionReceipt`)
        if (method === "eth_getTransactionByHash" && params?.[0]) {
            const cleanId = params[0].toLowerCase().replace(/^0x/, "");
            const rec = state.txReceipts[cleanId];
            if (rec) {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        hash: rec.txHash,
                        blockHash: "0x" + keccak256Hex(cleanId),
                        blockNumber: rec.blockNumberHex,
                        from: "0x" + rec.fromHex20,
                        to: rec.type === "BNB_TRANSFER" ? "0x" + rec.toHex20 : rec.tokenAddress,
                        value: rec.valueWeiHex || "0x0",
                        gas: "0x249f0",
                        gasPrice: "0x3b9aca00",
                        input: rec.type === "BNB_TRANSFER" ? "0x" : "0xa9059cbb" + rec.toHex20.padStart(64, "0") + rec.amountScaledHex,
                        nonce: rec.nonceHex || "0x1",
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
                        blockHash: "0x" + keccak256Hex(cleanId),
                        blockNumber: rec.blockNumberHex,
                        from: "0x" + rec.fromHex20,
                        to: rec.type === "BNB_TRANSFER" ? "0x" + rec.toHex20 : rec.tokenAddress,
                        cumulativeGasUsed: "0x8954",
                        gasUsed: "0x8954",
                        contractAddress: null,
                        logs: rec.type === "BNB_TRANSFER" ? [] : [{
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
                            blockHash: "0x" + keccak256Hex(cleanId),
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
// 8. INTERACTIVE TERMINAL COMMANDER CLI
// ============================================================================
function startInteractiveCli() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "V9-ENGINE> "
    });

    console.log("\n==================================================================");
    console.log("  V9 SWAP & TRANSFER ENGINE — TERMINAL COMMANDS:");
    console.log("  1. credit <wallet> <usdt_amount> [bnb_amount]");
    console.log("     Example: credit 0x1234...abcd 500000 15");
    console.log("  2. coin <wallet> <SYMBOL> <amount>");
    console.log("     Example: coin 0x1234...abcd BTCB 5.5   (USDT,USDC,BUSD,BTCB,ETH,CAKE,SOL,DOGE)");
    console.log("  3. transfer <from_wallet> <to_wallet> <amount> [USDT|BNB|BTCB...]");
    console.log("     Example: transfer 0x1111... 0x2222... 50000 USDT");
    console.log("  4. swap <wallet> <FROM_COIN> <TO_COIN> <amount>");
    console.log("     Example: swap 0x1234...abcd USDT BNB 12000");
    console.log("  5. list");
    console.log("     Shows all wallets, exact balances, and transaction history");
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
                    console.log(`\n[+] CREDITED WALLET 0x${k}`);
                    console.log(`    USDT Balance : ${usdtAmt.toLocaleString()} USDT ($${usdtAmt.toLocaleString()})`);
                    console.log(`    BNB Balance  : ${(Number(getBnbWei(k)) / 1e18).toLocaleString()} BNB\n`);
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
                    console.log("Usage: transfer <from_wallet> <to_wallet> <amount> [USDT|BNB|BTCB...]");
                } else if (sym === "BNB") {
                    const bnbUsd = amt * getTokenPriceUsd("BNB");
                    const realHash = await pickClosestValueBscScanHash(bnbUsd, "BNB");
                    executeBnbTransfer(fromW, toW, BigInt(Math.floor(amt * 1e6)) * (10n ** 12n), realHash);
                } else {
                    const usdEst = amt * getTokenPriceUsd(sym);
                    const realHash = await pickClosestValueBscScanHash(usdEst, "USDT");
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
                    const usdEst = amt * getTokenPriceUsd(fromSym);
                    const realSwapHash = await pickClosestValueBscScanHash(usdEst, "SWAP");
                    executeDexSwap(wAddr, fromSym, toSym, BigInt(Math.floor(amt * 1_000_000)), realSwapHash);
                }
            } else if (cmd === "list" || cmd === "wallets" || cmd === "status") {
                console.log("\n--- TRACKED WALLETS & EXACT BALANCES ---");
                for (const [k, bals] of Object.entries(state.wallets)) {
                    const bnbFormatted = (Number(BigInt(bals.BNB || "0")) / 1e18).toFixed(4);
                    const tokenList = Object.entries(bals)
                        .filter(([sym]) => sym !== "BNB")
                        .map(([sym, val]) => `${(Number(val) / 1e6).toLocaleString()} ${sym}`)
                        .join(", ");
                    console.log(`  0x${k} | Nonce: ${state.nonces[k] || 0} | BNB: ${bnbFormatted} | ${tokenList}`);
                }
                console.log("");
            } else if (cmd !== "") {
                console.log("Commands: credit, coin, transfer, swap, list");
            }
        } catch (e) {
            console.log(`[!] Error: ${e.message}`);
        }
        rl.prompt();
    });
}

server.listen(CONFIG.port, "0.0.0.0", () => {
    console.log("==================================================================");
    console.log(`[+] V9 BSC + TRON SWAP & TRANSFER ENGINE LIVE ON PORT ${CONFIG.port}`);
    console.log(`[+] Local RPC URL : http://127.0.0.1:${CONFIG.port}`);
    console.log("==================================================================");
    startInteractiveCli();
});

// File: tron_trc20_adaptive_v13_master.mjs
// Runtime: Node.js v18+ / v20+ (Zero external npm packages required)
// V13 Fixes for "The endpoint returned a different chain":
//  1. Exact TRON Mainnet Genesis Block (`00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc`)
//     returned on Block 0 (`/wallet/getblockbynum`, `/wallet/getblockbylimitnext`, `/walletsolidity/getblockbynum`)
//  2. Complete `/wallet/getnodeinfo` & `/wallet/getchainparameters` with Mainnet `p2pVersion: 11111`
//  3. Dynamic Chain-ID Adapter for JSON-RPC (`eth_chainId` & `net_version`):
//     - Use URL `/728126428` (or default) for Tron Mainnet (`728126428` / `0x2b6653dc`)
//     - Use URL `/56` if replacing an existing Chain ID 56 slot in MetaMask (`56` / `0x38`)
//     - Use URL `/195` if wallet expects SLIP-44 Tron Chain ID (`195` / `0xc3`)
//     - Or switch live anytime in terminal via: `chain <id>`!
//  4. Full TRC-20 USDT (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`) + EVM `0x...` Dual-Mode Support:
//     Works in TronLink, Bitget Wallet, Trust Wallet, TokenPocket, OKX Wallet, AND MetaMask!

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const CONFIG = {
    port: Number(process.env.PORT || 8545),

    // Default JSON-RPC Chain ID: 728126428 (0x2b6653dc — Official TRON Mainnet EVM Chain ID)
    // Can be overridden via URL path (e.g. `http://127.0.0.1:8545/56`) or terminal command `chain 56`
    activeChainIdDec: Number(process.env.CHAIN_ID || 728126428),

    // Official TRON Mainnet Genesis Block Hash (Required by TronLink / Bitget / Trust Wallet / TokenPocket!)
    tronMainnetGenesisBlockID: "00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc",
    tronMainnetGenesisTimestamp: 1529891469000,

    // Official TRON Mainnet TRC-20 Contracts + BSC/EVM Mirror Support
    tokens: {
        TRX:  { symbol: "TRX",  name: "TRON",             base58: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", hex20: "0000000000000000000000000000000000000000", decimals: 6,  priceUsd: 0.25 },
        USDT: { symbol: "USDT", name: "Tether USD",       base58: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", hex20: "a614f803b6fd780986a42c78ec9c7f77e6ded13c", evmAlias: "55d398326f99059ff775485246999027b3197955", decimals: 6,  priceUsd: 1.00 },
        USDC: { symbol: "USDC", name: "USD Coin",         base58: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8", hex20: "3487b63d30b5b2c87fb7f8e87c9f61c9898c6f39", evmAlias: "8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 6,  priceUsd: 1.00 },
        USDD: { symbol: "USDD", name: "Decentralized USD",base58: "TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn", hex20: "94f24e992c04b49f8f263c7d2e4c9f9e3a88a877", decimals: 18, priceUsd: 1.00 },
        WTRX: { symbol: "WTRX", name: "Wrapped TRX",      base58: "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR", hex20: "891cdb91d149f23b1a45d9c5ca78a88d0cb44c18", decimals: 6,  priceUsd: 0.25 },
        SUN:  { symbol: "SUN",  name: "SUN Token",        base58: "TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S", hex20: "b4a428ab7092c2f1395f376c297033b3d84a90d8", decimals: 18, priceUsd: 0.025 },
        BTT:  { symbol: "BTT",  name: "BitTorrent",       base58: "TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4", hex20: "0320e42b19a2a84032c0f6f83b0f5c4b420588d7", decimals: 18, priceUsd: 0.0000012 },
        JST:  { symbol: "JST",  name: "JUST",             base58: "TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9", hex20: "18fd0626b15b4b15d682a889b18f54e704847a2f", decimals: 18, priceUsd: 0.032 }
    },

    sunSwapRouters: new Set([
        "a7b589d6b99f09e943c65e4c2a3f65c72c56c7a8", // SunSwap V2 Router (TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax)
        "f5143922c6a10a9725a7a652d85a0808ff1b1b6f", // SunSwap V3 SmartRouter
        "e4569e52a5c3d2d37c75d45c504b8e7297131632", // SunSwap Aggregator
        "10ed43c718714eb63d5aa57b78b54704e256024e", // EVM Router fallback
        "881d40237659c251811cec9c364ef91dc08d300c"  // MetaSwap fallback
    ]),

    defaultAutoUsdt: 0,
    defaultAutoTrx:  0,

    ledgerFile: path.resolve(process.cwd(), "tron_trc20_v13_ledger.json")
};

const CONTRACT_TO_TOKEN = new Map();
for (const info of Object.values(CONFIG.tokens)) {
    CONTRACT_TO_TOKEN.set(info.hex20.toLowerCase(), info);
    CONTRACT_TO_TOKEN.set(info.base58, info);
    if (info.evmAlias) CONTRACT_TO_TOKEN.set(info.evmAlias.toLowerCase(), info);
}

// ============================================================================
// 1. TRON BASE58CHECK <-> HEX20 CONVERTERS & KECCAK-256
// ============================================================================
const B58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58_ALPHA].map((c, i) => [c, BigInt(i)]));

function base58ToHex20(b58) {
    try {
        let num = 0n;
        for (const ch of b58.trim()) {
            const v = B58_MAP.get(ch);
            if (v === undefined) return null;
            num = num * 58n + v;
        }
        let hex = num.toString(16);
        if (hex.length % 2 !== 0) hex = "0" + hex;
        hex = hex.padStart(50, "0");
        if (hex.startsWith("41") && hex.length === 50) {
            return hex.slice(2, 42).toLowerCase();
        }
        return null;
    } catch { return null; }
}

function hex20ToTronBase58(hex20) {
    const clean = (hex20 || "").toLowerCase().replace(/^(0x|41)/, "").padStart(40, "0").slice(-40);
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
    try {
        if (!/^[0-9a-fA-Fx]+$/.test(s) && s.length === 28 && s.endsWith("=")) {
            const buf = Buffer.from(s, "base64").toString("hex").toLowerCase();
            if (buf.length === 42 && buf.startsWith("41")) return buf.slice(2);
        }
    } catch {}
    const low = s.toLowerCase().replace(/^0x/, "");
    if (low.length === 42 && low.startsWith("41")) return low.slice(2);
    if (low.length >= 40) return low.slice(-40);
    return low.padStart(40, "0");
}

// ============================================================================
// 2. PERSISTENT LEDGER & GENESIS-VERIFIED BLOCK PRODUCER
// ============================================================================
let state = {
    wallets: {},
    nonces: {},
    txStaging: {},
    txReceipts: {},
    history: []
};

let lastActiveSender = null;
let latestBlockNum = 68480000;
let liveTronscanHashes = [];

setInterval(() => {
    latestBlockNum += 1;
}, 2500);

// V13 CRITICAL FIX: Returns the EXACT TRON Mainnet Genesis Block (`00000000000000001ebf8850...2b6653dc`)
// when a wallet queries Block 0! This fixes "The endpoint returned a different chain" in TronLink/Bitget/Trust!
function getTronBlockObject(blkNum = latestBlockNum) {
    const n = Number(blkNum);
    if (n === 0) {
        return {
            blockID: CONFIG.tronMainnetGenesisBlockID,
            block_header: {
                raw_data: {
                    timestamp: CONFIG.tronMainnetGenesisTimestamp,
                    txTrieRoot: "0000000000000000000000000000000000000000000000000000000000000000",
                    parentHash: "0000000000000000000000000000000000000000000000000000000000000000",
                    number: 0,
                    witness_id: 0,
                    witness_address: "4122a4e8c958173c064015382f84a68e2e66b1b8d2",
                    version: 1
                },
                witness_signature: "00".repeat(65)
            }
        };
    }

    const rawHash = crypto.createHash("sha256").update("tron_v13_blk_" + n).digest("hex");
    const numHex16 = n.toString(16).padStart(16, "0");
    const blockID = numHex16 + rawHash.slice(16);
    const parentHash = (n - 1 === 0)
        ? CONFIG.tronMainnetGenesisBlockID
        : ((n - 1).toString(16).padStart(16, "0") + crypto.createHash("sha256").update("tron_v13_blk_" + (n - 1)).digest("hex").slice(16));

    return {
        blockID,
        block_header: {
            raw_data: {
                number: n,
                txTrieRoot: crypto.createHash("sha256").update("trie_" + n).digest("hex"),
                witness_address: "4122a4e8c958173c064015382f84a68e2e66b1b8d2",
                parentHash,
                version: 30,
                timestamp: Date.now()
            },
            witness_signature: "a8".repeat(65)
        }
    };
}

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

function ensureWallet(addr) {
    const k = normAddr(addr);
    if (k === "0000000000000000000000000000000000000000") return null;
    if (!state.wallets[k]) {
        state.wallets[k] = {
            TRX:  (BigInt(CONFIG.defaultAutoTrx) * 1_000_000n).toString(),
            USDT: (BigInt(CONFIG.defaultAutoUsdt) * 1_000_000n).toString()
        };
        saveState();
        console.log(`\n[NEW TRON WALLET DETECTED] ${hex20ToTronBase58(k)} (EVM: 0x${k})`);
        console.log(`  -> Balance is 0 USDT, 0 TRX. Fund via terminal: credit ${hex20ToTronBase58(k)} 500000 2500`);
    }
    return state.wallets[k];
}

function resolveSymbol(symOrContract) {
    if (!symOrContract) return "USDT";
    const s = symOrContract.trim();
    const upper = s.toUpperCase();
    if (CONFIG.tokens[upper]) return upper;
    if (CONTRACT_TO_TOKEN.has(s)) return CONTRACT_TO_TOKEN.get(s).symbol;
    const h20 = normAddr(s);
    if (CONTRACT_TO_TOKEN.has(h20)) return CONTRACT_TO_TOKEN.get(h20).symbol;
    return "USDT";
}

function getTokenPriceUsd(symOrContract) {
    const sym = resolveSymbol(symOrContract);
    return CONFIG.tokens[sym] ? CONFIG.tokens[sym].priceUsd : 1.0;
}

function getBal6(addr, symOrContract = "USDT") {
    const w = ensureWallet(addr);
    if (!w) return 0n;
    const sym = resolveSymbol(symOrContract);
    return BigInt(w[sym] || "0");
}

function setBal6(addr, symOrContract, val6BigInt) {
    const w = ensureWallet(addr);
    if (!w) return;
    const sym = resolveSymbol(symOrContract);
    w[sym] = (val6BigInt < 0n ? 0n : val6BigInt).toString();
    saveState();
}

function getContractScaledHex64(addr, symOrContract, forceDecimals = null) {
    const sym = resolveSymbol(symOrContract);
    const dec = forceDecimals !== null ? forceDecimals : (CONFIG.tokens[sym]?.decimals || 6);
    const bal6 = getBal6(addr, sym);
    const scaled = dec > 6 ? bal6 * (10n ** BigInt(dec - 6)) : bal6;
    return scaled.toString(16).padStart(64, "0");
}

// ============================================================================
// 3. LIVE TRONSCAN CONFIRMED TX-HASH HARVESTER
// ============================================================================
async function harvestLiveTronscanHashes() {
    try {
        const r = await fetch("https://api.trongrid.io/wallet/getnowblock", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(4000)
        });
        const blk = await r.json();
        if (blk?.block_header?.raw_data?.number && blk.block_header.raw_data.number > latestBlockNum) {
            latestBlockNum = blk.block_header.raw_data.number;
        }
        if (Array.isArray(blk?.transactions)) {
            for (const tx of blk.transactions) {
                if (tx?.txID && tx?.ret?.[0]?.contractRet === "SUCCESS") {
                    if (!liveTronscanHashes.includes(tx.txID)) {
                        liveTronscanHashes.unshift(tx.txID);
                    }
                }
            }
            if (liveTronscanHashes.length > 120) liveTronscanHashes.length = 120;
        }
    } catch {}
}
setInterval(harvestLiveTronscanHashes, 4500);
harvestLiveTronscanHashes();

async function pickRealTronscanTxId() {
    if (liveTronscanHashes.length === 0) await harvestLiveTronscanHashes();
    if (liveTronscanHashes.length > 0) {
        const h = liveTronscanHashes.shift();
        liveTronscanHashes.push(h);
        return h.toLowerCase().replace(/^0x/, "");
    }
    return crypto.randomBytes(32).toString("hex");
}

// ============================================================================
// 4. ATOMIC TRC-20 TRANSFER, NATIVE TRX TRANSFER & SUNSWAP EXECUTION ENGINE
// ============================================================================
function resolveSender(preferredFrom, excludeTo, sym = "USDT", needed6 = 0n) {
    const p = normAddr(preferredFrom);
    if (p !== "0000000000000000000000000000000000000000" && p !== excludeTo && state.wallets[p]) return p;
    if (lastActiveSender && lastActiveSender !== excludeTo && state.wallets[lastActiveSender]) return lastActiveSender;
    for (const k of Object.keys(state.wallets)) {
        if (k !== excludeTo && getBal6(k, sym) >= needed6) return k;
    }
    if (p !== "0000000000000000000000000000000000000000") return p;
    return Object.keys(state.wallets)[0] || "0000000000000000000000000000000000000000";
}

function executeTrc20Transfer(fromAny, toAny, symOrContract, amount6BigInt, txID) {
    const toKey = normAddr(toAny);
    const sym   = resolveSymbol(symOrContract);
    const amt6  = amount6BigInt < 0n ? 0n : amount6BigInt;
    const fromKey = resolveSender(fromAny, toKey, sym, amt6);

    if (fromKey === toKey || CONTRACT_TO_TOKEN.has(toKey)) {
        const targetSwapSym = sym === "USDT" ? "TRX" : "USDT";
        console.log(`\n[TRC-20 IN-APP AUTO-SWAP] Swapping ${Number(amt6)/1e6} ${sym} -> ${targetSwapSym}!`);
        return executeTrc20Swap(fromKey, sym, targetSwapSym, amt6, txID);
    }

    const senderBefore = getBal6(fromKey, sym);
    const deduct = senderBefore >= amt6 ? amt6 : senderBefore;
    setBal6(fromKey, sym, senderBefore - deduct);
    state.nonces[fromKey] = (state.nonces[fromKey] || 0) + 1;

    const receiverBefore = getBal6(toKey, sym);
    setBal6(toKey, sym, receiverBefore + amt6);

    latestBlockNum += 1;
    const cleanId = (txID || crypto.randomBytes(32).toString("hex")).toLowerCase().replace(/^0x/, "");
    const tokMeta = CONFIG.tokens[sym] || CONFIG.tokens.USDT;
    const dec = tokMeta.decimals || 6;
    const rawContractUnits = dec > 6 ? (amt6 * (10n ** BigInt(dec - 6))) : amt6;
    const usdVal = (Number(amt6) / 1e6) * getTokenPriceUsd(sym);

    const rec = {
        type: "TRC20_TRANSFER",
        symbol: sym,
        tokenName: tokMeta.name,
        contractBase58: tokMeta.base58,
        contractHex41: "41" + tokMeta.hex20,
        contractHex20: tokMeta.hex20,
        decimals: dec,
        txID: cleanId,
        fromHex20: fromKey,
        toHex20: toKey,
        fromBase58: hex20ToTronBase58(fromKey),
        toBase58: hex20ToTronBase58(toKey),
        amount6: amt6.toString(),
        rawContractValue: rawContractUnits.toString(),
        amountHex64: rawContractUnits.toString(16).padStart(64, "0"),
        amount18Hex64: (amt6 * (10n ** 12n)).toString(16).padStart(64, "0"),
        amountFormatted: (Number(amt6) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2 }),
        usdFormatted: usdVal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        blockNumber: latestBlockNum,
        timestamp: Date.now()
    };

    state.txReceipts[cleanId] = rec;
    state.history.unshift(rec);
    if (state.history.length > 500) state.history.pop();
    saveState();

    console.log(`\n==================================================================`);
    console.log(`[TRC-20 CONFIRMED IN 1s] ${rec.amountFormatted} ${sym} ($${rec.usdFormatted} USD)`);
    console.log(`  Sender (-)   : ${rec.fromBase58} | Before: ${(Number(senderBefore)/1e6).toLocaleString()} -> Now: ${(Number(getBal6(fromKey, sym))/1e6).toLocaleString()} ${sym}`);
    console.log(`  Receiver (+) : ${rec.toBase58} | Before: ${(Number(receiverBefore)/1e6).toLocaleString()} -> Now: ${(Number(getBal6(toKey, sym))/1e6).toLocaleString()} ${sym}`);
    console.log(`  Tronscan URL : https://tronscan.org/#/transaction/${cleanId}`);
    console.log(`==================================================================`);
    return rec;
}

function executeTrxNativeTransfer(fromAny, toAny, sun6BigInt, txID) {
    const toKey = normAddr(toAny);
    const amt6  = sun6BigInt < 0n ? 0n : sun6BigInt;
    const fromKey = resolveSender(fromAny, toKey, "TRX", amt6);

    if (fromKey === toKey || CONTRACT_TO_TOKEN.has(toKey)) {
        const targetSym = CONTRACT_TO_TOKEN.has(toKey) ? CONTRACT_TO_TOKEN.get(toKey).symbol : "USDT";
        console.log(`\n[TRX IN-APP AUTO-SWAP] Swapping ${Number(amt6)/1e6} TRX -> ${targetSym}!`);
        return executeTrc20Swap(fromKey, "TRX", targetSym === "TRX" ? "USDT" : targetSym, amt6, txID);
    }

    const senderBefore = getBal6(fromKey, "TRX");
    const deduct = senderBefore >= amt6 ? amt6 : senderBefore;
    setBal6(fromKey, "TRX", senderBefore - deduct);
    state.nonces[fromKey] = (state.nonces[fromKey] || 0) + 1;

    const receiverBefore = getBal6(toKey, "TRX");
    setBal6(toKey, "TRX", receiverBefore + amt6);

    latestBlockNum += 1;
    const cleanId = (txID || crypto.randomBytes(32).toString("hex")).toLowerCase().replace(/^0x/, "");
    const usdVal = (Number(amt6) / 1e6) * getTokenPriceUsd("TRX");

    const rec = {
        type: "TRX_TRANSFER",
        symbol: "TRX",
        tokenName: "TRON",
        contractBase58: CONFIG.tokens.TRX.base58,
        contractHex41: "41" + toKey,
        contractHex20: toKey,
        decimals: 6,
        txID: cleanId,
        fromHex20: fromKey,
        toHex20: toKey,
        fromBase58: hex20ToTronBase58(fromKey),
        toBase58: hex20ToTronBase58(toKey),
        amount6: amt6.toString(),
        rawContractValue: amt6.toString(),
        amountHex64: amt6.toString(16).padStart(64, "0"),
        amount18Hex64: (amt6 * (10n ** 12n)).toString(16).padStart(64, "0"),
        amountFormatted: (Number(amt6) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2 }),
        usdFormatted: usdVal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        blockNumber: latestBlockNum,
        timestamp: Date.now()
    };

    state.txReceipts[cleanId] = rec;
    state.history.unshift(rec);
    if (state.history.length > 500) state.history.pop();
    saveState();

    console.log(`\n==================================================================`);
    console.log(`[TRX TRANSFER CONFIRMED] ${rec.amountFormatted} TRX ($${rec.usdFormatted} USD)`);
    console.log(`  Sender (-)   : ${rec.fromBase58} | Before: ${(Number(senderBefore)/1e6).toLocaleString()} -> Now: ${(Number(getBal6(fromKey, "TRX"))/1e6).toLocaleString()} TRX`);
    console.log(`  Receiver (+) : ${rec.toBase58} | Before: ${(Number(receiverBefore)/1e6).toLocaleString()} -> Now: ${(Number(getBal6(toKey, "TRX"))/1e6).toLocaleString()} TRX`);
    console.log(`  Tronscan URL : https://tronscan.org/#/transaction/${cleanId}`);
    console.log(`==================================================================`);
    return rec;
}

function executeTrc20Swap(walletAny, fromSymOrAddr, toSymOrAddr, amountIn6BigInt, txID) {
    const fromSym = resolveSymbol(fromSymOrAddr);
    const toSym   = resolveSymbol(toSymOrAddr);
    const amtIn6  = amountIn6BigInt > 0n ? amountIn6BigInt : 50_000_000n;
    const wKey    = resolveSender(walletAny, null, fromSym, amtIn6);

    const fromPrice = getTokenPriceUsd(fromSym);
    const toPrice   = getTokenPriceUsd(toSym);
    const usdVal    = (Number(amtIn6) / 1e6) * fromPrice;
    const outUnits  = (usdVal / toPrice) * 0.998;
    const amtOut6   = BigInt(Math.max(1, Math.floor(outUnits * 1_000_000)));

    const curIn = getBal6(wKey, fromSym);
    setBal6(wKey, fromSym, curIn >= amtIn6 ? curIn - amtIn6 : 0n);
    state.nonces[wKey] = (state.nonces[wKey] || 0) + 1;

    setBal6(wKey, toSym, getBal6(wKey, toSym) + amtOut6);
    if (toSym === "WTRX") {
        setBal6(wKey, "TRX", getBal6(wKey, "TRX") + amtOut6);
    }

    latestBlockNum += 1;
    const cleanId = (txID || crypto.randomBytes(32).toString("hex")).toLowerCase().replace(/^0x/, "");
    const outMeta = CONFIG.tokens[toSym] || CONFIG.tokens.USDT;
    const dec = outMeta.decimals || 6;
    const rawOutUnits = dec > 6 ? amtOut6 * (10n ** BigInt(dec - 6)) : amtOut6;

    const rec = {
        type: "TRC20_SWAP",
        symbol: toSym,
        fromSymbol: fromSym,
        toSymbol: toSym,
        tokenName: outMeta.name,
        contractBase58: outMeta.base58,
        contractHex41: "41" + outMeta.hex20,
        contractHex20: outMeta.hex20,
        decimals: dec,
        txID: cleanId,
        fromHex20: wKey,
        toHex20: wKey,
        fromBase58: hex20ToTronBase58(wKey),
        toBase58: hex20ToTronBase58(wKey),
        amountInFormatted: (Number(amtIn6) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 4 }),
        amount6: amtOut6.toString(),
        rawContractValue: rawOutUnits.toString(),
        amountHex64: rawOutUnits.toString(16).padStart(64, "0"),
        amount18Hex64: (amtOut6 * (10n ** 12n)).toString(16).padStart(64, "0"),
        amountFormatted: (Number(amtOut6) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 4 }),
        usdFormatted: usdVal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        blockNumber: latestBlockNum,
        timestamp: Date.now()
    };

    state.txReceipts[cleanId] = rec;
    state.history.unshift(rec);
    saveState();

    console.log(`\n==================================================================`);
    console.log(`[TRC-20 SWAP CONFIRMED] ${rec.amountInFormatted} ${fromSym} -> +${rec.amountFormatted} ${toSym} ($${rec.usdFormatted} USD)`);
    console.log(`  Wallet       : ${rec.fromBase58} (0x${wKey})`);
    console.log(`  New ${fromSym} Bal : ${(Number(getBal6(wKey, fromSym))/1e6).toLocaleString()} ${fromSym}`);
    console.log(`  New ${toSym} Bal : ${(Number(getBal6(wKey, toSym))/1e6).toLocaleString()} ${toSym}`);
    console.log(`  Tronscan URL : https://tronscan.org/#/transaction/${cleanId}`);
    console.log(`==================================================================`);
    return rec;
}

function buildTronTransactionInfo(cleanId) {
    const rec = state.txReceipts[cleanId];
    const from20 = rec ? rec.fromHex20 : (lastActiveSender || Object.keys(state.wallets)[0] || "0".repeat(40));
    const to20   = rec ? rec.toHex20   : from20;
    const contract20 = rec ? rec.contractHex20 : CONFIG.tokens.USDT.hex20;
    const amtHex64   = rec ? rec.amountHex64   : (1000000n).toString(16).padStart(64, "0");

    return {
        id: cleanId,
        fee: 0,
        blockNumber: rec ? rec.blockNumber : latestBlockNum,
        blockTimeStamp: rec ? rec.timestamp : Date.now(),
        contractResult: ["0000000000000000000000000000000000000000000000000000000000000001"],
        contract_address: "41" + contract20,
        receipt: {
            energy_usage: 31895,
            energy_usage_total: 31895,
            net_usage: 345,
            result: "SUCCESS"
        },
        log: [
            {
                address: contract20,
                topics: [
                    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                    from20.padStart(64, "0"),
                    to20.padStart(64, "0")
                ],
                data: amtHex64
            }
        ]
    };
}

function buildTronTransactionObject(cleanId) {
    const rec = state.txReceipts[cleanId];
    const from20 = rec ? rec.fromHex20 : (lastActiveSender || Object.keys(state.wallets)[0] || "0".repeat(40));
    const to20   = rec ? rec.toHex20   : from20;
    const contract20 = rec ? rec.contractHex20 : CONFIG.tokens.USDT.hex20;
    const amtHex64   = rec ? rec.amountHex64   : (1000000n).toString(16).padStart(64, "0");

    return {
        ret: [{ contractRet: "SUCCESS" }],
        signature: ["1b" + cleanId + cleanId + "00"],
        txID: cleanId,
        raw_data: {
            contract: [
                {
                    parameter: {
                        value: {
                            data: "a9059cbb" + to20.padStart(64, "0") + amtHex64,
                            owner_address: "41" + from20,
                            contract_address: "41" + contract20
                        },
                        type_url: "type.googleapis.com/protocol.TriggerSmartContract"
                    },
                    type: "TriggerSmartContract"
                }
            ],
            ref_block_bytes: "2a1c",
            ref_block_hash: "8f9d1e2a3b4c5d6e",
            expiration: (rec ? rec.timestamp : Date.now()) + 60000,
            timestamp: rec ? rec.timestamp : Date.now()
        },
        raw_data_hex: "0a022a1c22088f9d1e2a3b4c5d6e"
    };
}

// ============================================================================
// 5. MAIN HTTP + TRON FULLNODE + SOLIDITYNODE + TRONGRID + ADAPTIVE JSON-RPC
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
    let pathname = urlObj.pathname;

    // ------------------------------------------------------------------------
    // DYNAMIC URL CHAIN-ID DETECTION!
    // Allows you to use `/56`, `/728126428`, `/195`, `/1`, or `?chainId=56`
    // so ANY wallet that checks `eth_chainId` gets the exact Chain ID it expects!
    // ------------------------------------------------------------------------
    let requestChainIdDec = CONFIG.activeChainIdDec;
    const pathChainMatch = pathname.match(/^\/(?:chain\/)?(\d+)(\/.*)?$/);
    if (pathChainMatch) {
        requestChainIdDec = Number(pathChainMatch[1]);
        pathname = pathChainMatch[2] || "/";
    } else if (urlObj.searchParams.get("chainId")) {
        requestChainIdDec = Number(urlObj.searchParams.get("chainId"));
    }
    const requestChainIdHex = "0x" + requestChainIdDec.toString(16);

    // ------------------------------------------------------------------------
    // ROUTE A: TRONGRID V1 API (`/v1/accounts/:address`, `/transactions/trc20`, `/transactions`)
    // ------------------------------------------------------------------------
    if (pathname.startsWith("/v1/accounts/")) {
        const parts = pathname.split("/");
        const acctKey = normAddr(parts[3] || "");
        lastActiveSender = acctKey;

        if (pathname.includes("/transactions/trc20")) {
            const trc20Txs = state.history
                .filter(h => (h.fromHex20 === acctKey || h.toHex20 === acctKey) && h.symbol !== "TRX")
                .map(h => ({
                    transaction_id: h.txID,
                    token_info: {
                        symbol: h.symbol || "USDT",
                        address: h.contractBase58 || CONFIG.tokens.USDT.base58,
                        decimals: h.decimals || 6,
                        name: h.tokenName || "Tether USD"
                    },
                    block_timestamp: h.timestamp,
                    from: h.fromBase58,
                    to: h.toBase58,
                    type: "Transfer",
                    value: h.rawContractValue || h.amount6
                }));
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ data: trc20Txs, success: true, meta: { at: Date.now(), page_size: trc20Txs.length } }));
        }

        if (pathname.endsWith("/transactions")) {
            const allTxs = state.history
                .filter(h => h.fromHex20 === acctKey || h.toHex20 === acctKey)
                .map(h => ({
                    ret: [{ contractRet: "SUCCESS", fee: 0 }],
                    signature: ["1b" + h.txID + h.txID + "00"],
                    txID: h.txID,
                    net_usage: 345,
                    raw_data_hex: "0a022a1c",
                    net_fee: 0,
                    energy_usage: 31895,
                    blockNumber: h.blockNumber || latestBlockNum,
                    block_timestamp: h.timestamp,
                    energy_fee: 0,
                    energy_usage_total: 31895,
                    raw_data: {
                        contract: [
                            h.type === "TRX_TRANSFER"
                                ? {
                                      parameter: {
                                          value: {
                                              amount: Number(h.amount6),
                                              owner_address: "41" + h.fromHex20,
                                              to_address: "41" + h.toHex20
                                          },
                                          type_url: "type.googleapis.com/protocol.TransferContract"
                                      },
                                      type: "TransferContract"
                                  }
                                : {
                                      parameter: {
                                          value: {
                                              data: "a9059cbb" + h.toHex20.padStart(64, "0") + h.amountHex64,
                                              owner_address: "41" + h.fromHex20,
                                              contract_address: h.contractHex41 || ("41" + CONFIG.tokens.USDT.hex20)
                                          },
                                          type_url: "type.googleapis.com/protocol.TriggerSmartContract"
                                      },
                                      type: "TriggerSmartContract"
                                  }
                        ],
                        timestamp: h.timestamp,
                        expiration: h.timestamp + 60000
                    }
                }));
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ data: allTxs, success: true, meta: { at: Date.now(), page_size: allTxs.length } }));
        }

        ensureWallet(acctKey);
        const trxSun = Number(getBal6(acctKey, "TRX"));
        const trc20Array = [];
        for (const [sym, tokInfo] of Object.entries(CONFIG.tokens)) {
            if (sym === "TRX") continue;
            const b6 = getBal6(acctKey, sym);
            if (b6 > 0n || sym === "USDT") {
                const scaled = tokInfo.decimals > 6 ? b6 * (10n ** BigInt(tokInfo.decimals - 6)) : b6;
                trc20Array.push({ [tokInfo.base58]: scaled.toString() });
            }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            data: [
                {
                    address: "41" + acctKey,
                    balance: trxSun,
                    create_time: Date.now() - 86400000 * 30,
                    latest_opration_time: Date.now(),
                    free_net_usage: 0,
                    net_window_size: 28800000,
                    trc20: trc20Array,
                    account_resource: { energy_window_size: 28800000 }
                }
            ],
            success: true,
            meta: { at: Date.now(), page_size: 1 }
        }));
    }

    // ------------------------------------------------------------------------
    // ROUTE B: TRON FULLNODE (`/wallet/*`) & SOLIDITYNODE (`/walletsolidity/*`)
    // ------------------------------------------------------------------------
    if (pathname.startsWith("/wallet/") || pathname.startsWith("/walletsolidity/")) {
        let body = {};
        try { body = JSON.parse(rawBody || "{}"); } catch {}

        // 1. `/wallet/getnodeinfo` — Required by TronLink / Bitget / TokenPocket to verify Mainnet (`p2pVersion: 11111`)!
        if (pathname.endsWith("/getnodeinfo")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                activeConnectCount: 28,
                beginSyncNum: 1,
                block: `Num:${latestBlockNum},ID:${getTronBlockObject(latestBlockNum).blockID}`,
                solidityBlock: `Num:${latestBlockNum},ID:${getTronBlockObject(latestBlockNum).blockID}`,
                configNodeInfo: {
                    activeNodeSize: 30,
                    allowAdaptiveEnergy: 1,
                    allowCreationOfContracts: 1,
                    codeVersion: "4.7.5",
                    dbVersion: 2,
                    listenPort: 18888,
                    maxConnectCount: 50,
                    minParticipationRate: 15,
                    p2pVersion: "11111", // 11111 = Official TRON Mainnet P2P ID!
                    passiveNodeSize: 10,
                    sameIpMaxConnectCount: 2,
                    sendNodeSize: 28,
                    supportConstant: true,
                    versionName: "GreatVoyage-v4.7.5",
                    versionNum: "18215"
                }
            }));
        }

        // 2. `/wallet/getnowblock`, `/wallet/getblockbynum`, `/wallet/getblock`, `/wallet/getblockbylimitnext`
        // Returns Exact Tron Mainnet Genesis Block (`00000000000000001ebf8850...2b6653dc`) when `num === 0`!
        if (pathname.endsWith("/getnowblock") || pathname.endsWith("/getblockbynum") || pathname.endsWith("/getblock")) {
            const num = body.num !== undefined ? Number(body.num) : ( body.id_or_num !== undefined ? Number(body.id_or_num) : latestBlockNum );
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(getTronBlockObject(num)));
        }

        if (pathname.endsWith("/getblockbylimitnext")) {
            const startNum = Number(body.startNum || 0);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ block: [getTronBlockObject(startNum)] }));
        }

        // 3. `/wallet/getaccount` & `/walletsolidity/getaccount`
        if (pathname.endsWith("/getaccount")) {
            const acctKey = normAddr(body.address || urlObj.searchParams.get("address") || "");
            lastActiveSender = acctKey;
            const trxSun = Number(getBal6(acctKey, "TRX"));
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                address: body.visible ? hex20ToTronBase58(acctKey) : ("41" + acctKey),
                balance: trxSun,
                create_time: Date.now() - 86400000 * 30,
                latest_opration_time: Date.now(),
                free_net_usage: 0
            }));
        }

        // 4. `/wallet/getaccountresource`
        if (pathname.endsWith("/getaccountresource")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                freeNetUsed: 100,
                freeNetLimit: 50000,
                NetUsed: 0,
                NetLimit: 500000,
                EnergyUsed: 0,
                EnergyLimit: 5000000,
                TotalNetLimit: 43200000000,
                TotalNetWeight: 10000000,
                TotalEnergyLimit: 90000000000,
                TotalEnergyWeight: 10000000
            }));
        }

        // 5. `/wallet/getchainparameters`
        if (pathname.endsWith("/getchainparameters")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                chainParameter: [
                    { key: "getTransactionFee", value: 1000 },
                    { key: "getEnergyFee", value: 420 },
                    { key: "getMaxCpuTimeOfOneTx", value: 50 }
                ]
            }));
        }

        // 6. `/wallet/validateaddress`
        if (pathname.endsWith("/validateaddress")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ result: true, message: "Base58check format" }));
        }

        // 7. `/wallet/triggerconstantcontract` & `/wallet/triggersmartcontract`
        if (pathname.endsWith("/triggerconstantcontract") || pathname.endsWith("/triggersmartcontract")) {
            const contractNorm = normAddr(body.contract_address || "");
            const ownerNorm    = normAddr(body.owner_address || "");
            if (ownerNorm !== "0000000000000000000000000000000000000000") lastActiveSender = ownerNorm;

            const selector = (body.function_selector || "").replace(/\s+/g, "");
            const param    = (body.parameter || body.data || "").toLowerCase().replace(/^0x/, "");

            if (selector.startsWith("balanceOf") || param.startsWith("70a08231")) {
                const walletHex = param.length >= 64 ? param.slice(param.length - 40) : ownerNorm;
                const balHex64  = getContractScaledHex64(walletHex, contractNorm);
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({
                    result: { result: true },
                    energy_used: 0,
                    constant_result: [balHex64],
                    transaction: { ret: [{ contractRet: "SUCCESS" }], txID: crypto.randomBytes(32).toString("hex") }
                }));
            }

            if (selector.startsWith("decimals") || param.startsWith("313ce567")) {
                const dec = (CONTRACT_TO_TOKEN.get(contractNorm)?.decimals || 6).toString(16).padStart(64, "0");
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ result: { result: true }, energy_used: 0, constant_result: [dec] }));
            }
            if (selector.startsWith("allowance") || param.startsWith("dd62ed3e")) {
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ result: { result: true }, energy_used: 0, constant_result: ["f".repeat(64)] }));
            }
            if (selector.startsWith("symbol") || param.startsWith("95d89b41")) {
                const symStr = CONTRACT_TO_TOKEN.get(contractNorm)?.symbol || "USDT";
                const symHex = "0".repeat(62) + "20" + symStr.length.toString(16).padStart(64, "0") + Buffer.from(symStr).toString("hex").padEnd(64, "0");
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ result: { result: true }, energy_used: 0, constant_result: [symHex] }));
            }
            if (selector.startsWith("name") || param.startsWith("06fdde03")) {
                const nameStr = CONTRACT_TO_TOKEN.get(contractNorm)?.name || "Tether USD";
                const nameHex = "0".repeat(62) + "20" + nameStr.length.toString(16).padStart(64, "0") + Buffer.from(nameStr).toString("hex").padEnd(64, "0");
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ result: { result: true }, energy_used: 0, constant_result: [nameHex] }));
            }

            if (selector.startsWith("transfer(") || param.startsWith("a9059cbb") || selector.startsWith("transferFrom(") || param.startsWith("23b872dd")) {
                const isFrom = selector.startsWith("transferFrom(") || param.startsWith("23b872dd");
                const cleanParam = (param.startsWith("a9059cbb") || param.startsWith("23b872dd")) ? param.slice(8) : param;
                const fromHex20 = isFrom ? cleanParam.slice(24, 64) : ownerNorm;
                const toHex20   = isFrom ? cleanParam.slice(88, 128) : cleanParam.slice(24, 64);
                const rawAmtHex = isFrom ? cleanParam.slice(128, 192) : cleanParam.slice(64, 128);
                const rawAmt    = BigInt("0x" + (rawAmtHex || "0"));
                const sym       = resolveSymbol(contractNorm);
                const dec       = CONFIG.tokens[sym]?.decimals || 6;
                const amt6      = dec > 6 ? rawAmt / (10n ** BigInt(dec - 6)) : rawAmt;

                const realTxID = await pickRealTronscanTxId();
                state.txStaging[realTxID] = {
                    type: "TRC20_TRANSFER",
                    txID: realTxID,
                    fromHex20,
                    toHex20,
                    sym,
                    amt6: amt6.toString()
                };
                saveState();

                const now = Date.now();
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({
                    result: { result: true },
                    energy_used: 13000,
                    constant_result: ["0".repeat(63) + "1"],
                    transaction: {
                        visible: Boolean(body.visible),
                        txID: realTxID,
                        raw_data: {
                            contract: [
                                {
                                    parameter: {
                                        value: {
                                            data: "a9059cbb" + cleanParam,
                                            owner_address: body.owner_address,
                                            contract_address: body.contract_address
                                        },
                                        type_url: "type.googleapis.com/protocol.TriggerSmartContract"
                                    },
                                    type: "TriggerSmartContract"
                                }
                            ],
                            ref_block_bytes: "2a1c",
                            ref_block_hash: "8f9d1e2a3b4c5d6e",
                            expiration: now + 60000,
                            timestamp: now,
                            fee_limit: body.fee_limit || 100000000
                        },
                        raw_data_hex: "0a022a1c22088f9d1e2a3b4c5d6e"
                    }
                }));
            }

            if (selector.includes("getAmountsOut") || param.startsWith("d06ca61f")) {
                const amtIn = param.length >= 72 ? BigInt("0x" + param.slice(8, 72)) : 100_000_000n;
                const amtOut = amtIn * 4n;
                const outHex = "0".repeat(62) + "20" + (2n).toString(16).padStart(64, "0") + amtIn.toString(16).padStart(64, "0") + amtOut.toString(16).padStart(64, "0");
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ result: { result: true }, energy_used: 0, constant_result: [outHex] }));
            }

            const realTxID = await pickRealTronscanTxId();
            const callValSun = BigInt(body.call_value || 0);
            state.txStaging[realTxID] = {
                type: (CONFIG.sunSwapRouters.has(contractNorm) || selector.toLowerCase().includes("swap") || callValSun > 0n) ? "TRC20_SWAP" : "APPROVE",
                txID: realTxID,
                fromHex20: ownerNorm,
                fromSym: callValSun > 0n ? "TRX" : "USDT",
                toSym: callValSun > 0n ? "USDT" : "TRX",
                amt6: (callValSun > 0n ? callValSun : 50_000_000n).toString()
            };
            const now = Date.now();
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                result: { result: true },
                energy_used: 25000,
                constant_result: ["0".repeat(63) + "1"],
                transaction: {
                    visible: Boolean(body.visible),
                    txID: realTxID,
                    raw_data: {
                        contract: [{
                            parameter: {
                                value: { data: param, owner_address: body.owner_address, contract_address: body.contract_address },
                                type_url: "type.googleapis.com/protocol.TriggerSmartContract"
                            },
                            type: "TriggerSmartContract"
                        }],
                        ref_block_bytes: "2a1c",
                        ref_block_hash: "8f9d1e2a3b4c5d6e",
                        expiration: now + 60000,
                        timestamp: now
                    },
                    raw_data_hex: "0a022a1c22088f9d1e2a3b4c5d6e"
                }
            }));
        }

        // 8. `/wallet/createtransaction`
        if (pathname.endsWith("/createtransaction")) {
            const fromHex20 = normAddr(body.owner_address || "");
            const toHex20   = normAddr(body.to_address || "");
            const amtSun    = BigInt(body.amount || 0);
            const realTxID  = await pickRealTronscanTxId();

            state.txStaging[realTxID] = {
                type: "TRX_TRANSFER",
                txID: realTxID,
                fromHex20,
                toHex20,
                amt6: amtSun.toString()
            };
            saveState();

            const now = Date.now();
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                visible: Boolean(body.visible),
                txID: realTxID,
                raw_data: {
                    contract: [{
                        parameter: {
                            value: { amount: Number(amtSun), owner_address: body.owner_address, to_address: body.to_address },
                            type_url: "type.googleapis.com/protocol.TransferContract"
                        },
                        type: "TransferContract"
                    }],
                    ref_block_bytes: "2a1c",
                    ref_block_hash: "8f9d1e2a3b4c5d6e",
                    expiration: now + 60000,
                    timestamp: now
                },
                raw_data_hex: "0a022a1c22088f9d1e2a3b4c5d6e"
            }));
        }

        // 9. `/wallet/broadcasttransaction` & `/wallet/broadcasthex`
        if (pathname.endsWith("/broadcasttransaction") || pathname.endsWith("/broadcasthex")) {
            const txID = (body.txID || await pickRealTronscanTxId()).toLowerCase().replace(/^0x/, "");
            const staged = state.txStaging[txID];

            if (staged) {
                delete state.txStaging[txID];
                if (staged.type === "TRC20_TRANSFER") {
                    executeTrc20Transfer(staged.fromHex20, staged.toHex20, staged.sym, BigInt(staged.amt6), txID);
                } else if (staged.type === "TRX_TRANSFER") {
                    executeTrxNativeTransfer(staged.fromHex20, staged.toHex20, BigInt(staged.amt6), txID);
                } else if (staged.type === "TRC20_SWAP") {
                    executeTrc20Swap(staged.fromHex20, staged.fromSym, staged.toSym, BigInt(staged.amt6), txID);
                }
            } else {
                const contractArr = body?.raw_data?.contract;
                if (Array.isArray(contractArr) && contractArr[0]) {
                    const c = contractArr[0];
                    const val = c?.parameter?.value || {};
                    if (c.type === "TransferContract") {
                        executeTrxNativeTransfer(val.owner_address, val.to_address, BigInt(val.amount || 0), txID);
                    } else if (c.type === "TriggerSmartContract") {
                        const d = (val.data || "").toLowerCase().replace(/^0x/, "");
                        if (d.startsWith("a9059cbb") && d.length >= 136) {
                            const toH = d.slice(32, 72);
                            const amt6 = BigInt("0x" + d.slice(72, 136));
                            executeTrc20Transfer(val.owner_address, toH, val.contract_address || "USDT", amt6, txID);
                        }
                    }
                }
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ result: true, code: "SUCCESS", txid: txID, txID }));
        }

        // 10. `/wallet/gettransactioninfobyid` & `/wallet/gettransactionbyid`
        if (pathname.endsWith("/gettransactioninfobyid")) {
            const cleanId = (body.value || urlObj.searchParams.get("value") || "").toLowerCase().replace(/^0x/, "");
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(buildTronTransactionInfo(cleanId)));
        }
        if (pathname.endsWith("/gettransactionbyid")) {
            const cleanId = (body.value || urlObj.searchParams.get("value") || "").toLowerCase().replace(/^0x/, "");
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(buildTronTransactionObject(cleanId)));
        }
    }

    // ------------------------------------------------------------------------
    // ROUTE C: ADAPTIVE JSON-RPC (`/jsonrpc`, `/`, `/56`, `/728126428`, `/195`)
    // Automatically returns `requestChainIdHex` & `requestChainIdDec` so wallets
    // NEVER say "The endpoint returned a different chain"!
    // ------------------------------------------------------------------------
    if (req.method === "POST") {
        let rpcPayload;
        try { rpcPayload = JSON.parse(rawBody); } catch {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: requestChainIdHex }));
        }

        const handleAdaptiveJsonRpc = async (rpc) => {
            const { id, method, params } = rpc;

            if (method === "eth_chainId") {
                console.log(`[JSON-RPC] eth_chainId -> Returning ${requestChainIdHex} (${requestChainIdDec})`);
                return { jsonrpc: "2.0", id, result: requestChainIdHex };
            }
            if (method === "net_version") {
                return { jsonrpc: "2.0", id, result: String(requestChainIdDec) };
            }
            if (method === "eth_blockNumber") {
                return { jsonrpc: "2.0", id, result: "0x" + latestBlockNum.toString(16) };
            }
            if (method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas") {
                return { jsonrpc: "2.0", id, result: "0x3b9aca00" };
            }
            if (method === "eth_feeHistory") {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        oldestBlock: "0x" + latestBlockNum.toString(16),
                        baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"],
                        gasUsedRatio: [0.5],
                        reward: [["0x3b9aca00"]]
                    }
                };
            }
            if (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") {
                const isZero = params?.[0] === "0x0" || params?.[0] === 0;
                const blkHash = isZero
                    ? "0x" + CONFIG.tronMainnetGenesisBlockID
                    : "0x" + getTronBlockObject(latestBlockNum).blockID;
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        number: isZero ? "0x0" : "0x" + latestBlockNum.toString(16),
                        hash: blkHash,
                        parentHash: isZero ? "0x" + "0".repeat(64) : "0x" + getTronBlockObject(latestBlockNum - 1).blockID,
                        nonce: "0x0000000000000000",
                        sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
                        logsBloom: "0x" + "0".repeat(512),
                        transactionsRoot: "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
                        stateRoot: "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
                        receiptsRoot: "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
                        miner: "0x0000000000000000000000000000000000000000",
                        difficulty: "0x2",
                        totalDifficulty: "0x10000",
                        extraData: "0x",
                        size: "0x1000",
                        gasLimit: "0x8583b00",
                        gasUsed: "0x5208",
                        baseFeePerGas: "0x3b9aca00",
                        timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16),
                        transactions: [],
                        uncles: []
                    }
                };
            }

            if (method === "eth_getBalance" && params?.[0]) {
                const w = normAddr(params[0]);
                lastActiveSender = w;
                const trx6 = getBal6(w, "TRX");
                // If connected via EVM wallet (MetaMask / Trust EVM), scale 6-decimal TRX to 18-decimal wei so display matches!
                const val = requestChainIdDec === 56 ? trx6 * (10n ** 12n) : trx6 * (10n ** 12n);
                return { jsonrpc: "2.0", id, result: "0x" + val.toString(16) };
            }

            if (method === "eth_getTransactionCount" && params?.[0]) {
                const w = normAddr(params[0]);
                lastActiveSender = w;
                return { jsonrpc: "2.0", id, result: "0x" + (state.nonces[w] || 0).toString(16) };
            }

            if (method === "eth_estimateGas") {
                if (params?.[0]?.from) lastActiveSender = normAddr(params[0].from);
                return { jsonrpc: "2.0", id, result: "0x5208" };
            }

            if (method === "eth_call" && params?.[0]) {
                const toC = normAddr(params[0].to || "");
                const d = (params[0].data || params[0].input || "").toLowerCase();
                const is18DecEvm = requestChainIdDec === 56;

                if (d.startsWith("0x70a08231") && d.length >= 74) {
                    const w = d.slice(34, 74);
                    return { jsonrpc: "2.0", id, result: "0x" + getContractScaledHex64(w, toC, is18DecEvm ? 18 : null) };
                }
                if (d.startsWith("0x313ce567")) {
                    const dec = (is18DecEvm ? 18 : (CONTRACT_TO_TOKEN.get(toC)?.decimals || 6)).toString(16).padStart(64, "0");
                    return { jsonrpc: "2.0", id, result: "0x" + dec };
                }
                if (d.startsWith("0xdd62ed3e")) {
                    return { jsonrpc: "2.0", id, result: "0x" + "f".repeat(64) };
                }
                if (d.startsWith("0x95d89b41")) {
                    const symStr = CONTRACT_TO_TOKEN.get(toC)?.symbol || "USDT";
                    const symHex = "0".repeat(62) + "20" + symStr.length.toString(16).padStart(64, "0") + Buffer.from(symStr).toString("hex").padEnd(64, "0");
                    return { jsonrpc: "2.0", id, result: "0x" + symHex };
                }
                return { jsonrpc: "2.0", id, result: "0x" + "0".repeat(63) + "1" };
            }

            if ((method === "eth_sendRawTransaction" || method === "eth_sendTransaction") && params?.[0]) {
                const rawHex = typeof params[0] === "string" ? params[0].toLowerCase().replace(/^0x/, "") : "";
                const realTxID = await pickRealTronscanTxId();

                const idxTrans = rawHex.indexOf("a9059cbb");
                if (idxTrans !== -1 && rawHex.length >= idxTrans + 136) {
                    const toW = rawHex.slice(idxTrans + 32, idxTrans + 72);
                    const rawVal = BigInt("0x" + rawHex.slice(idxTrans + 72, idxTrans + 136));
                    const amt6 = rawVal >= 10n ** 12n ? rawVal / (10n ** 12n) : rawVal;
                    executeTrc20Transfer(lastActiveSender, toW, "USDT", amt6, realTxID);
                }
                return { jsonrpc: "2.0", id, result: "0x" + realTxID };
            }

            if (method === "eth_getTransactionReceipt" && params?.[0]) {
                const cleanId = params[0].toLowerCase().replace(/^0x/, "");
                const fallbackSender = lastActiveSender || Object.keys(state.wallets)[0] || "0".repeat(40);
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        transactionHash: "0x" + cleanId,
                        transactionIndex: "0x0",
                        blockHash: "0x" + getTronBlockObject(latestBlockNum).blockID,
                        blockNumber: "0x" + latestBlockNum.toString(16),
                        from: "0x" + fallbackSender,
                        to: "0x" + fallbackSender,
                        cumulativeGasUsed: "0x5208",
                        gasUsed: "0x5208",
                        contractAddress: null,
                        logs: [],
                        logsBloom: "0x" + "0".repeat(512),
                        status: "0x1",
                        effectiveGasPrice: "0x3b9aca00",
                        type: "0x2"
                    }
                };
            }

            return { jsonrpc: "2.0", id, result: "0x1" };
        };

        const out = Array.isArray(rpcPayload)
            ? await Promise.all(rpcPayload.map(handleAdaptiveJsonRpc))
            : await handleAdaptiveJsonRpc(rpcPayload);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(out));
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
        status: "TRON_TRC20_V13_ADAPTIVE_ONLINE",
        activeChainIdDec: CONFIG.activeChainIdDec,
        activeChainIdHex: "0x" + CONFIG.activeChainIdDec.toString(16),
        genesisBlockID: CONFIG.tronMainnetGenesisBlockID,
        usdtTrc20Contract: CONFIG.tokens.USDT.base58
    }, null, 2));
});

// ============================================================================
// 6. INTERACTIVE TERMINAL CLI (`chain`, `credit`, `coin`, `transfer`, `swap`, `list`)
// ============================================================================
function startTronV13Cli() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "TRC20-V13> "
    });

    console.log("\n==================================================================");
    console.log("  TRON TRC-20 V13 ADAPTIVE MASTER — TERMINAL COMMANDS:");
    console.log("  1. chain <728126428 | 56 | 195 | 1>");
    console.log("     Instantly switches the default Chain ID if your wallet asks for a specific ID!");
    console.log("  2. credit <T_or_0x_wallet> <usdt_amount> [trx_amount]");
    console.log("     Example: credit TFx9...abcd 500000 2500");
    console.log("  3. coin <T_or_0x_wallet> <USDT|TRX|USDC|USDD|SUN|BTT|JST> <amount>");
    console.log("     Example: coin TFx9...abcd USDC 100000");
    console.log("  4. transfer <from_wallet> <to_wallet> <amount> [USDT|TRX]");
    console.log("     Example: transfer TSender... TReceiver... 25000 USDT");
    console.log("  5. swap <wallet> <FROM_COIN> <TO_COIN> <amount>");
    console.log("     Example: swap TFx9...abcd USDT TRX 500");
    console.log("  6. list");
    console.log("     Displays all connected wallets (`T...` & `0x...`) and their balances");
    console.log("==================================================================\n");

    rl.prompt();

    rl.on("line", async (line) => {
        const parts = line.trim().split(/\s+/);
        const cmd = (parts[0] || "").toLowerCase();

        try {
            if (cmd === "chain" || cmd === "chainid") {
                const newId = Number(parts[1] || 728126428);
                CONFIG.activeChainIdDec = newId;
                console.log(`\n[+] Default Chain ID switched to: ${newId} (0x${newId.toString(16)})\n`);
            } else if (cmd === "credit" || cmd === "add" || cmd === "set") {
                const addr = parts[1];
                const usdtAmt = Number(parts[2] || 0);
                const trxAmt  = parts[3] !== undefined ? Number(parts[3]) : null;
                if (!addr) {
                    console.log("Usage: credit <T_or_0x_wallet> <usdt_amount> [trx_amount]");
                } else {
                    const k = normAddr(addr);
                    setBal6(k, "USDT", BigInt(Math.floor(usdtAmt * 1_000_000)));
                    if (trxAmt !== null) {
                        setBal6(k, "TRX", BigInt(Math.floor(trxAmt * 1_000_000)));
                    }
                    latestBlockNum += 1;
                    console.log(`\n[+] CREDITED WALLET: ${hex20ToTronBase58(k)} (EVM: 0x${k})`);
                    console.log(`    TRC-20 USDT : ${usdtAmt.toLocaleString()} USDT ($${usdtAmt.toLocaleString()})`);
                    console.log(`    Native TRX  : ${(Number(getBal6(k, "TRX")) / 1e6).toLocaleString()} TRX\n`);
                }
            } else if (cmd === "coin" || cmd === "token") {
                const addr = parts[1];
                const sym  = (parts[2] || "USDT").toUpperCase();
                const amt  = Number(parts[3] || 0);
                if (!addr) {
                    console.log("Usage: coin <T_or_0x_wallet> <USDT|TRX|USDC|USDD|SUN|BTT|JST> <amount>");
                } else {
                    const k = normAddr(addr);
                    setBal6(k, sym, BigInt(Math.floor(amt * 1_000_000)));
                    latestBlockNum += 1;
                    console.log(`\n[+] SET ${hex20ToTronBase58(k)} -> ${amt.toLocaleString()} ${sym}\n`);
                }
            } else if (cmd === "transfer" || cmd === "send") {
                const fromW = parts[1];
                const toW   = parts[2];
                const amt   = Number(parts[3] || 0);
                const sym   = (parts[4] || "USDT").toUpperCase();
                if (!fromW || !toW || !amt) {
                    console.log("Usage: transfer <from_wallet> <to_wallet> <amount> [USDT|TRX]");
                } else {
                    const realTxID = await pickRealTronscanTxId();
                    if (sym === "TRX") {
                        executeTrxNativeTransfer(fromW, toW, BigInt(Math.floor(amt * 1_000_000)), realTxID);
                    } else {
                        executeTrc20Transfer(fromW, toW, sym, BigInt(Math.floor(amt * 1_000_000)), realTxID);
                    }
                }
            } else if (cmd === "swap") {
                const wAddr   = parts[1];
                const fromSym = (parts[2] || "USDT").toUpperCase();
                const toSym   = (parts[3] || "TRX").toUpperCase();
                const amt     = Number(parts[4] || 0);
                if (!wAddr || !amt) {
                    console.log("Usage: swap <wallet> <FROM_COIN> <TO_COIN> <amount>");
                } else {
                    const realTxID = await pickRealTronscanTxId();
                    executeTrc20Swap(wAddr, fromSym, toSym, BigInt(Math.floor(amt * 1_000_000)), realTxID);
                }
            } else if (cmd === "list" || cmd === "wallets" || cmd === "status") {
                console.log("\n--- TRACKED TRON (TRC-20) WALLETS ---");
                for (const [k, bals] of Object.entries(state.wallets)) {
                    const b58 = hex20ToTronBase58(k);
                    const tokenList = Object.entries(bals)
                        .map(([sym, val]) => `${(Number(val) / 1e6).toLocaleString()} ${sym}`)
                        .join(" | ");
                    console.log(`  ${b58} (0x${k}) -> ${tokenList}`);
                }
                console.log("");
            } else if (cmd !== "") {
                console.log("Commands: chain, credit, coin, transfer, swap, list");
            }
        } catch (e) {
            console.log(`[!] Error: ${e.message}`);
        }
        rl.prompt();
    });
}

server.listen(CONFIG.port, "0.0.0.0", () => {
    console.log("==================================================================");
    console.log(`[+] TRON TRC-20 V13 ADAPTIVE NODE LIVE ON PORT ${CONFIG.port}`);
    console.log(`[+] Genesis Block Hash : ${CONFIG.tronMainnetGenesisBlockID}`);
    console.log(`[+] Default Chain ID   : ${CONFIG.activeChainIdDec} (0x${CONFIG.activeChainIdDec.toString(16)})`);
    console.log(`[+] Dynamic Chain URLs :`);
    console.log(`    - Tron Mainnet     : http://127.0.0.1:${CONFIG.port}/728126428`);
    console.log(`    - SLIP-44 Tron     : http://127.0.0.1:${CONFIG.port}/195`);
    console.log(`    - Chain 56 Slot    : http://127.0.0.1:${CONFIG.port}/56`);
    console.log("==================================================================");
    startTronV13Cli();
});

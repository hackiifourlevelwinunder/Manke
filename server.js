
// tron_trx_highest server
// Fetches latest Tron block, computes number = int(hash,16) % 10
// Also finds the transaction in that minute/block with highest TRX amount and includes it in the preview+reveal.
// Schedules preview at minuteStart - 40s, reveal at minuteStart.
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const STORAGE = path.join(__dirname, 'history.json');
const MAX_HISTORY = 500;

let history = [];
try { if (fs.existsSync(STORAGE)) history = JSON.parse(fs.readFileSync(STORAGE,'utf8')||'[]'); } catch(e){ console.error('history load', e); history = []; }

function saveHistory(){ try { fs.writeFileSync(STORAGE, JSON.stringify(history.slice(-MAX_HISTORY), null,2)); } catch(e){ console.error('saveHistory', e); } }

// Helpers to work with times
function floorToMinute(ms){ const d=new Date(ms); d.setSeconds(0,0); d.setMilliseconds(0); return d.getTime(); }

// SSE clients
let clients = [];

// broadcast SSE
function broadcast(event, data){
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(payload); } catch(e){ /* ignore broken */ }
  });
}

// Try to fetch latest block using TronGrid V1
async function fetchLatestBlock(){
  try {
    const r = await axios.get('https://api.trongrid.io/v1/blocks/latest', { timeout: 10000 });
    if (r.data && r.data.data && r.data.data.length) return r.data.data[0];
    return r.data;
  } catch (e) {
    // fallback empty
    console.error('fetchLatestBlock error', e.message || e);
    return null;
  }
}

// Try to fetch block by number via multiple methods
async function fetchBlockByNum(blockNum){
  try {
    // first try TronGrid v1 block transactions endpoint
    const url1 = `https://api.trongrid.io/v1/blocks/${blockNum}/transactions`;
    const r1 = await axios.get(url1, { timeout: 10000 });
    if (r1.data && r1.data.data) return { block: r1.data.block || null, transactions: r1.data.data };
  } catch(e){ /* ignore */ }
  try {
    // fallback to wallet/getblockbynum (RPC)
    const rpcUrl = 'https://api.trongrid.io/wallet/getblockbynum';
    const r2 = await axios.post(rpcUrl, { num: Number(blockNum) }, { timeout: 10000 });
    if (r2.data) {
      // transactions may be under r2.data.transactions
      return { block: r2.data, transactions: r2.data.transactions || [] };
    }
  } catch(e){ /* ignore */ }
  // final fallback: try Tronscan API
  try {
    const ts = `https://apilist.tronscan.org/api/block?number=${blockNum}`;
    const r3 = await axios.get(ts, { timeout: 10000 });
    if (r3.data && r3.data.txCount !== undefined){
      // Tronscan's block endpoint doesn't return tx list easily without another call; return empty txs
      return { block: r3.data, transactions: [] };
    }
  } catch(e){ /* ignore */ }
  return { block: null, transactions: [] };
}

// Extract TRX amount from a transaction object (best-effort)
// Returns amount in SUN (1 TRX = 1e6 SUN)
function extractAmountFromTx(tx){
  try {
    // Common patterns: tx.raw_data.contract[0].parameter.value.amount
    if (tx && tx.raw_data && Array.isArray(tx.raw_data.contract) && tx.raw_data.contract[0]){
      const p = tx.raw_data.contract[0].parameter;
      if (p && p.value){
        if (typeof p.value.amount === 'number') return p.value.amount;
        if (typeof p.value.amount === 'string' && !isNaN(Number(p.value.amount))) return Number(p.value.amount);
      }
    }
    // Some API formats: tx.contract[0].parameter.value.amount
    if (tx && tx.contract && Array.isArray(tx.contract) && tx.contract[0]){
      const p = tx.contract[0].parameter;
      if (p && p.value && typeof p.value.amount === 'number') return p.value.amount;
    }
    // Tronscan transaction may have 'value' or 'amount' fields
    if (tx && tx.value && typeof tx.value === 'number') return tx.value;
    if (tx && tx.amount && typeof tx.amount === 'number') return tx.amount;
  } catch(e){ /* ignore */ }
  return 0;
}

// Convert hex hash to number 0-9
function hashToDigit(hash){
  try {
    if (!hash) return null;
    // remove 0x if present
    const h = String(hash).replace(/^0x/, '');
    // take last 12 hex chars to keep BigInt small
    const slice = h.slice(-12);
    const big = BigInt('0x' + slice);
    return Number(big % 10n);
  } catch(e){
    return null;
  }
}

// Main: fetch block, compute RNG, find highest trx tx in that block's transactions
async function buildEntryForMinute(minuteStartMs){
  // fetch latest block then fetch block by number to get transactions
  const latest = await fetchLatestBlock();
  if (!latest) return null;
  // get block number and hash
  const blockNum = latest.block_header && latest.block_header.raw_data && latest.block_header.raw_data.number ? latest.block_header.raw_data.number : latest.number || latest.blockNum || latest.block_number || latest.blockID || null;
  const blockHash = latest.hash || latest.blockID || (latest.blockID ? latest.blockID : null) || latest.hashHex || latest.txid || null;
  // if blockNum not found, try parsing latest as block object
  let blockNumber = blockNum;
  if (!blockNumber && latest.number !== undefined) blockNumber = latest.number;
  if (!blockNumber && latest.block_header && latest.block_header.raw_data && latest.block_header.raw_data.number !== undefined) blockNumber = latest.block_header.raw_data.number;
  // fetch transactions for that block number if available
  let txs = [];
  if (blockNumber !== undefined && blockNumber !== null){
    const fetched = await fetchBlockByNum(blockNumber);
    if (fetched && Array.isArray(fetched.transactions)) txs = fetched.transactions;
    // sometimes latest provides transactions directly
    if ((!txs || txs.length===0) && latest.transactions) txs = latest.transactions;
  } else {
    if (latest.transactions) txs = latest.transactions;
  }

  // compute RNG from block hash if present
  const hashForUse = blockHash || (latest.hash ? latest.hash : null) || (latest.blockID ? latest.blockID : null);
  const number = hashToDigit(hashForUse) ?? Math.floor(Math.random()*10);

  // find tx with highest amount (sun)
  let maxTx = null;
  let maxAmount = -1;
  for (const tx of txs){
    const amt = extractAmountFromTx(tx) || 0;
    if (amt > maxAmount){
      maxAmount = amt;
      maxTx = tx;
    }
  }
  // convert to TRX for readability
  const maxAmountTRX = maxAmount / 1e6;

  const entry = {
    minuteStartIso: new Date(minuteStartMs).toISOString(),
    assignedAt: new Date().toISOString(),
    blockNumber: blockNumber,
    blockHash: hashForUse,
    number,
    topTx: maxTx ? { txID: maxTx.txID || maxTx.tx_id || maxTx.txid || maxTx.hash || null, amountSun: maxAmount, amountTRX: maxAmountTRX } : null,
    txCount: txs.length
  };
  return entry;
}

// Scheduler: schedule preview at minuteStart - 40s, reveal at minuteStart
let scheduled = {}; // minuteStartMs -> entry
function scheduleNext(){
  const now = Date.now();
  const currentMinute = floorToMinute(now);
  const nextMinute = currentMinute + 60_000;
  const previewAt = nextMinute - 40_000;
  const msUntilPreview = previewAt - now;

  if (msUntilPreview <= 0){
    // missed, build immediately and schedule reveal if possible
    (async ()=>{
      const entry = await buildEntryForMinute(nextMinute);
      if (entry){
        scheduled[nextMinute] = entry;
        broadcast('preview', entry);
        // schedule reveal at nextMinute
        const msToReveal = nextMinute - Date.now();
        if (msToReveal > 0) setTimeout(()=>{ history.unshift(Object.assign({ revealedAt: new Date().toISOString() }, entry)); saveHistory(); broadcast('reveal', entry); delete scheduled[nextMinute]; }, msToReveal);
      }
    })();
    setTimeout(scheduleNext, 1000);
    return;
  }

  // schedule preview
  setTimeout(async ()=>{
    const entry = await buildEntryForMinute(nextMinute);
    if (entry){
      scheduled[nextMinute] = entry;
      broadcast('preview', entry);
      // schedule reveal at nextMinute
      const msToReveal = nextMinute - Date.now();
      if (msToReveal > 0) setTimeout(()=>{ history.unshift(Object.assign({ revealedAt: new Date().toISOString() }, entry)); saveHistory(); broadcast('reveal', entry); delete scheduled[nextMinute]; }, msToReveal);
    }
    // schedule next after this cycle
    scheduleNext();
  }, msUntilPreview);
}

// SSE endpoint
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.flushHeaders();
  clients.push(res);
  // send init
  res.write(`event: init\ndata: ${JSON.stringify({ history: history.slice(0,50), serverTime: new Date().toISOString() })}\n\n`);

  req.on('close', ()=>{ clients = clients.filter(c=>c!==res); });
});

app.get('/history', (req,res)=> res.json(history.slice(0,50)));

app.use(express.static(path.join(__dirname,'public')));

app.listen(PORT, ()=>{
  console.log('Server listening on', PORT);
  scheduleNext();
});

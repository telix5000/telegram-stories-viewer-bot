import {
  insertInvoice,
  markInvoicePaid,
  updatePaidAmount,
  getInvoice,
  getPendingInvoiceByAddress,
  updateFromAddress,
  recordTxid,
  isTxidUsed,
  PaymentRow,
  upsertPaymentCheck,
  deletePaymentCheck,
  listPaymentChecks,
  PaymentCheckRow,
  reserveAddressIndex,
  getInviterForUser,
  wasReferralPaidRewarded,
  markReferralPaidRewarded,
} from '../db';
import { IContextBot } from 'config/context-interface';
import { BTC_WALLET_ADDRESS, BTC_XPUB, BTC_YPUB, BTC_ZPUB } from 'config/env-config';
import * as bitcoin from 'bitcoinjs-lib';
import { BIP32Factory } from 'bip32';
import bs58check from 'bs58check';
import * as ecc from 'tiny-secp256k1';
import { extendPremium, getPremiumDaysLeft, calcPremiumDays } from './premium-service';
import type { Telegraf } from 'telegraf';
import { t } from 'lib/i18n';
import { findUserById } from '../repositories/user-repository';
const bip32 = BIP32Factory(ecc);

const DEFAULT_FETCH_TIMEOUT = 15_000; // 15 seconds

async function fetchJson(url: string, timeout = DEFAULT_FETCH_TIMEOUT): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const res = await fetch(url, { signal: controller.signal });
  clearTimeout(timer);
  return res.json();
}

function normalizeXpub(xpub: string): string {
  try {
    const data = Buffer.from(bs58check.decode(xpub));
    const version = data.readUInt32BE(0);
    if (version !== bitcoin.networks.bitcoin.bip32.public) {
      data.writeUInt32BE(bitcoin.networks.bitcoin.bip32.public, 0);
      return bs58check.encode(data);
    }
  } catch {
    // ignore, return original
  }
  return xpub;
}

// Use var here to avoid temporal dead zone issues when this module
// is required before initialization completes in certain tests.
var botInstance: Telegraf<IContextBot> | null = null;
export function setBotInstance(b: Telegraf<IContextBot>): void {
  botInstance = b;
}

export interface PaymentCheckResult {
  invoice: PaymentRow | null;
  unexpectedSenders?: string[];
}

const paymentTimers = new Map<number, NodeJS.Timeout>();
const reminderTimers = new Map<number, NodeJS.Timeout>();

// Allow invoices to be considered paid when at least 90% of the expected
// amount is received to account for network fees.
const PAYMENT_TOLERANCE = 0.1; // 10%
// Send a reminder if payment hasn't been detected after 45 minutes
const REMINDER_DELAY_MS = 45 * 60 * 1000; // 45 minutes

function scheduleInvoiceCheck(
  invoice: PaymentRow,
  userId: string,
  fromAddress: string,
  checkStart: number,
  nextCheck?: number,
): void {
  const doCheck = async () => {
    const inv = getInvoice(invoice.id);
    if (!inv) {
      deletePaymentCheck(invoice.id);
      paymentTimers.delete(invoice.id);
      if (reminderTimers.has(invoice.id)) {
        clearTimeout(reminderTimers.get(invoice.id)!);
        reminderTimers.delete(invoice.id);
      }
      return;
    }

    if (Date.now() - checkStart * 1000 > 24 * 60 * 60 * 1000) {
      if (botInstance) {
        const lang = findUserById(userId)?.language;
        await botInstance.telegram.sendMessage(
          userId,
          t(lang, 'invoice.expired'),
        );
      }
      deletePaymentCheck(invoice.id);
      paymentTimers.delete(invoice.id);
      if (reminderTimers.has(invoice.id)) {
        clearTimeout(reminderTimers.get(invoice.id)!);
        reminderTimers.delete(invoice.id);
      }
      return;
    }

    const result = await checkPayment(inv, checkStart);

    if (result.unexpectedSenders && result.unexpectedSenders.length) {
      if (botInstance) {
        const lang = findUserById(userId)?.language;
        await botInstance.telegram.sendMessage(
          userId,
          t(lang, 'payment.unexpectedAddress', {
            addresses: result.unexpectedSenders.join(', '),
            from: fromAddress,
          }),
        );
      }
    }

    const newInv = result.invoice;

    if (newInv && newInv.paid_at) {
      const daysAdded = calcPremiumDays(newInv.invoice_amount, newInv.paid_amount);
      extendPremium(userId, daysAdded);
      const inviter = getInviterForUser(userId);
      if (inviter && !wasReferralPaidRewarded(userId)) {
        extendPremium(inviter, daysAdded);
        markReferralPaidRewarded(userId);
        if (botInstance) {
          const inviterLang = findUserById(inviter)?.language;
          await botInstance.telegram.sendMessage(
            inviter,
            t(inviterLang, 'referral.paid', { days: daysAdded }),
          );
        }
      }
      if (botInstance) {
        const userLang = findUserById(userId)?.language;
        await botInstance.telegram.sendMessage(
          userId,
          t(userLang, 'verify.success', { days: daysAdded }),
        );
        const { updatePremiumPinnedMessage } = await import('lib');
        const days = getPremiumDaysLeft(userId);
        await updatePremiumPinnedMessage(
          botInstance,
          userId,
          userId,
          days,
          true,
        );
      }
      deletePaymentCheck(invoice.id);
      paymentTimers.delete(invoice.id);
      if (reminderTimers.has(invoice.id)) {
        clearTimeout(reminderTimers.get(invoice.id)!);
        reminderTimers.delete(invoice.id);
      }
      return;
    } else if (newInv && newInv.id !== invoice.id) {
      invoice = newInv;
      if (botInstance) {
        const lang = findUserById(userId)?.language;
        await botInstance.telegram.sendMessage(
          userId,
          t(lang, 'payment.partial', {
            amount: newInv.invoice_amount.toFixed(8),
            address: newInv.user_address,
          }),
          { parse_mode: 'Markdown' },
        );
      }
      deletePaymentCheck(inv.id);
      upsertPaymentCheck(newInv.id, Math.floor(Date.now() / 1000), checkStart);
      paymentTimers.delete(inv.id);
      if (reminderTimers.has(inv.id)) {
        clearTimeout(reminderTimers.get(inv.id)!);
        reminderTimers.delete(inv.id);
      }
      scheduleInvoiceCheck(newInv, userId, fromAddress, checkStart);
      return;
    }

    const delay = 15 * 60 * 1000 + Math.floor(Math.random() * 15 * 60 * 1000);
    upsertPaymentCheck(invoice.id, Math.floor(Date.now() / 1000) + Math.floor(delay / 1000), checkStart);
    const timer = setTimeout(doCheck, delay);
    paymentTimers.set(invoice.id, timer);
  };

  const initialDelay = nextCheck ? Math.max(nextCheck * 1000 - Date.now(), 0) : 15 * 60 * 1000 + Math.floor(Math.random() * 15 * 60 * 1000);
  upsertPaymentCheck(invoice.id, Math.floor(Date.now() / 1000) + Math.floor(initialDelay / 1000), checkStart);
  const timer = setTimeout(doCheck, initialDelay);
  paymentTimers.set(invoice.id, timer);
  if (!reminderTimers.has(invoice.id)) {
    const rTimer = setTimeout(() => {
      if (botInstance) {
        const lang = findUserById(userId)?.language;
        botInstance.telegram
          .sendMessage(userId, t(lang, 'payment.reminder'))
          .catch(() => {});
      }
      reminderTimers.delete(invoice.id);
    }, REMINDER_DELAY_MS);
    reminderTimers.set(invoice.id, rTimer);
  }
}

async function fetchTransactions(address: string): Promise<any[]> {
  const urls = [
    `https://blockstream.info/api/address/${address}/txs`,
    `https://mempool.space/api/address/${address}/txs`,
    `https://api.blockcypher.com/v1/btc/main/addrs/${address}/full?limit=50`,
  ];
  const results = await Promise.allSettled(urls.map((u) => fetchJson(u)));
  for (const res of results) {
    if (res.status === 'fulfilled') {
      const val = res.value;
      if (Array.isArray(val)) return val;
      if (Array.isArray(val?.txs)) return val.txs;
    }
  }
  return [];
}

async function fetchTransactionById(txid: string): Promise<any | null> {
  const urls = [
    `https://blockstream.info/api/tx/${txid}`,
    `https://mempool.space/api/tx/${txid}`,
    `https://api.blockcypher.com/v1/btc/main/txs/${txid}`,
    `https://sochain.com/api/v2/get_tx/BTC/${txid}`,
  ];
  const results = await Promise.allSettled(urls.map((u) => fetchJson(u)));
  for (const res of results) {
    if (res.status === 'fulfilled' && res.value) {
      const val = res.value.data ?? res.value;
      if (val && typeof val === 'object') return val;
    }
  }
  return null;
}

/** Fetch BTC/USD prices from multiple sources and return the average */
export async function getBtcPriceUsd(): Promise<number> {
  const endpoints = [
    {
      url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      parse: (d: any) => Number(d?.bitcoin?.usd),
    },
    {
      url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
      parse: (d: any) => Number(d?.data?.amount),
    },
    {
      url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
      parse: (d: any) => Number(d?.price),
    },
    {
      url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/',
      parse: (d: any) => Number(d?.last),
    },
    {
      url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
      parse: (d: any) => Number(d?.result?.XXBTZUSD?.c?.[0]),
    },
    {
      url: 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT',
      parse: (d: any) => Number(d?.data?.[0]?.last),
    },
    {
      url: 'https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD',
      parse: (d: any) => Number(d?.USD),
    },
    {
      url: 'https://api.coinpaprika.com/v1/tickers/btc-bitcoin',
      parse: (d: any) => Number(d?.quotes?.USD?.price),
    },
    {
      url: 'https://api.coincap.io/v2/assets/bitcoin',
      parse: (d: any) => Number(d?.data?.priceUsd),
    },
  ];

  const requests = await Promise.allSettled(
    endpoints.map((e) => fetchJson(e.url)),
  );

  const prices: number[] = [];
  for (let i = 0; i < requests.length; i++) {
    const res = requests[i];
    if (res.status === 'fulfilled') {
      const val = endpoints[i].parse(res.value);
      if (!isNaN(val)) prices.push(val);
    }
  }

  if (!prices.length) throw new Error('Unable to fetch BTC price');
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

export async function createInvoice(
  userId: string,
  expectedUsd: number,
): Promise<PaymentRow> {
  const price = await getBtcPriceUsd();
  const invoiceAmount = Math.round((expectedUsd / price) * 1e8) / 1e8;
  const expires = Math.floor(Date.now() / 1000) + 60 * 60;
  let address = BTC_WALLET_ADDRESS;
  let idx: number | null = null;
  const extPub = BTC_XPUB || BTC_YPUB || BTC_ZPUB;
  if (extPub) {
    idx = reserveAddressIndex();
    const node = bip32.fromBase58(normalizeXpub(extPub), bitcoin.networks.bitcoin);
    const child = node.derive(0).derive(idx);
    address = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(child.publicKey), network: bitcoin.networks.bitcoin }).address!;
  }
  return insertInvoice(userId, invoiceAmount, address, idx, expires);
}

async function queryAddressBalance(address: string): Promise<number> {
  const urls = [
    `https://blockstream.info/api/address/${address}`,
    `https://mempool.space/api/address/${address}`,
    `https://api.blockcypher.com/v1/btc/main/addrs/${address}/balance`,
    `https://sochain.com/api/v2/get_address_balance/BTC/${address}`,
  ];

  const results = await Promise.allSettled(urls.map((u) => fetchJson(u)));
  const amounts: number[] = [];

  if (results[0].status === 'fulfilled') {
    const v = results[0].value;
    const total =
      v.chain_stats?.funded_txo_sum + v.mempool_stats?.funded_txo_sum;
    if (typeof total === 'number') amounts.push(total / 1e8);
  }
  if (results[1].status === 'fulfilled') {
    const v = results[1].value;
    const total =
      v.chain_stats?.funded_txo_sum + v.mempool_stats?.funded_txo_sum;
    if (typeof total === 'number') amounts.push(total / 1e8);
  }
  if (results[2].status === 'fulfilled') {
    const v = results[2].value;
    const bal = v.total_received ?? v.balance ?? v.final_balance;
    if (typeof bal === 'number') amounts.push(bal / 1e8);
  }
  if (results[3].status === 'fulfilled') {
    const v = results[3].value;
    const bal =
      v.data?.confirmed_balance ?? v.data?.confirmed ?? v.data?.balance;
    if (typeof bal === 'string') amounts.push(Number(bal));
  }

  return amounts.length ? Math.max(...amounts) : 0;
}

export async function checkPayment(
  invoice: PaymentRow,
  checkStart = 0,
): Promise<PaymentCheckResult> {
  const balance = await queryAddressBalance(invoice.user_address);
  let receivedFromUser = 0;
  const unexpected = new Set<string>();
  const usedTxids: string[] = [];

  if (invoice.from_address) {
    const txs = await fetchTransactions(invoice.user_address);
    for (const tx of txs) {
      const tsRaw =
        tx.status?.block_time ??
        tx.block_time ??
        tx.time ??
        tx.timestamp ??
        (tx.received ? Date.parse(tx.received) / 1000 : undefined) ??
        (tx.confirmed ? Date.parse(tx.confirmed) / 1000 : undefined) ??
        0;
      const txTimestamp = Math.floor(Number(tsRaw) || 0);
      if (txTimestamp && txTimestamp < checkStart) continue;
      const outs = tx.vout ?? tx.outputs;
      const ins = tx.vin ?? tx.inputs;
      const toUs = outs?.find(
        (o: any) =>
          o.scriptpubkey_address === invoice.user_address ||
          o.addr === invoice.user_address ||
          o.addresses?.includes?.(invoice.user_address),
      );
      if (!toUs) continue;
      const fromAddrs = (ins || [])
        .map((i: any) =>
          i.prevout?.scriptpubkey_address ||
          i.prev_out?.addr ||
          i.addresses?.[0],
        )
        .filter(Boolean);
      const txid = tx.txid ?? tx.hash ?? tx.id;
      if (fromAddrs.includes(invoice.from_address) && txid && !isTxidUsed(txid)) {
        const val =
          toUs.value ??
          toUs.prevout?.value ??
          toUs.output_value;
        if (typeof val === 'number') {
          receivedFromUser += val / 1e8;
          usedTxids.push(txid);
        }
      } else {
        fromAddrs.forEach((a: string) => unexpected.add(a));
      }
    }
  }

  if (receivedFromUser > invoice.paid_amount) {
    updatePaidAmount(invoice.id, receivedFromUser - invoice.paid_amount);
  }

  // Accept slightly underpaid invoices if they meet the tolerance threshold.
  const threshold = invoice.invoice_amount * (1 - PAYMENT_TOLERANCE);

  if (receivedFromUser >= threshold) {
    markInvoicePaid(invoice.id);
    usedTxids.forEach((tx) => recordTxid(invoice.id, tx));
    return { invoice: getInvoice(invoice.id) || null };
  }

  const remaining = invoice.invoice_amount - receivedFromUser;
  if (remaining > 0) {
    const usdRate = await getBtcPriceUsd();
    const remainingUsd = remaining * usdRate;
    const newInvoice = await createInvoice(invoice.user_id, remainingUsd);
    return { invoice: newInvoice, unexpectedSenders: Array.from(unexpected) };
  }

  return { invoice: null, unexpectedSenders: Array.from(unexpected) };
}

export async function verifyPaymentByTxid(txid: string): Promise<PaymentRow | null> {
  if (isTxidUsed(txid)) return null;
  const tx = await fetchTransactionById(txid);
  if (!tx) return null;
  const outs = tx.vout ?? tx.outputs;
  const ins = tx.vin ?? tx.inputs;
  let invoice: PaymentRow | undefined;
  let toUs: any;
  for (const o of outs || []) {
    const addr =
      o.scriptpubkey_address || o.addr || o.addresses?.[0];
    if (!addr) continue;
    const inv = getPendingInvoiceByAddress(addr);
    if (inv) {
      invoice = inv;
      toUs = o;
      break;
    }
  }
  if (!invoice || !toUs) return null;
  const fromAddrs = (ins || [])
    .map((i: any) =>
      i.prevout?.scriptpubkey_address || i.prev_out?.addr || i.addresses?.[0],
    )
    .filter(Boolean);
  if (invoice.from_address && !fromAddrs.includes(invoice.from_address)) {
    return null;
  }
  const val =
    toUs.value ?? toUs.prevout?.value ?? toUs.output_value ?? toUs.value_sat;
  const amount = typeof val === 'number' ? val / 1e8 : Number(val) / 1e8;
  if (amount > invoice.paid_amount) {
    updatePaidAmount(invoice.id, amount - invoice.paid_amount);
  }
  const threshold = invoice.invoice_amount * (1 - PAYMENT_TOLERANCE);
  if (amount >= threshold) {
    if (!invoice.from_address && fromAddrs[0]) {
      updateFromAddress(invoice.id, fromAddrs[0]);
    }
    markInvoicePaid(invoice.id);
    recordTxid(invoice.id, txid);
    return getInvoice(invoice.id) || null;
  }
  return null;
}

export function schedulePaymentCheck(ctx: IContextBot): void {
  const state = ctx.session?.upgrade;
  if (!state || !state.fromAddress) return;

  if (!state.checkStart) state.checkStart = Date.now();
  scheduleInvoiceCheck(
    state.invoice,
    String(ctx.from!.id),
    state.fromAddress,
    Math.floor(state.checkStart / 1000),
  );
}

export function resumePendingChecks(): void {
  const rows = listPaymentChecks();
  for (const row of rows) {
    const inv = getInvoice(row.invoice_id);
    if (!inv || inv.paid_at || !inv.from_address) {
      deletePaymentCheck(row.invoice_id);
      continue;
    }
    if (inv.expires_at && inv.expires_at < Math.floor(Date.now() / 1000)) {
      deletePaymentCheck(row.invoice_id);
      continue;
    }
    scheduleInvoiceCheck(inv, inv.user_id, inv.from_address, row.check_start, row.next_check);
  }
}

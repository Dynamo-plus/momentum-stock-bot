// macd-momentum-bot.js
import YahooFinance from "yahoo-finance2";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
import chalk from "chalk";

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const POLL_INTERVAL_SEC = parseInt(process.env.POLL_INTERVAL_SEC || "60", 10);

const yahooFinance = new YahooFinance();

// Safety / tuning
const MAX_ALERTS_PER_DAY = 20;
const ALERT_COOLDOWN_MINUTES = 15;
const HIST_INTERVAL = "1d"; // "1m" or "5m" — shorter = more near-real-time but more rate use
const HIST_PERIOD_DAYS = 3; // how many days of bars to fetch (gives enough context for MACD)
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

// ---- Real 40-per-minute Rate Limiter ----
class RateLimiter {
  constructor(maxPerMinute) {
    this.maxPerMinute = maxPerMinute;
    this.tokens = maxPerMinute;
    this.refillRate = maxPerMinute / 60; // tokens per second
    this.lastRefill = Date.now();
  }

  async consume() {
    this._refill();

    while (this.tokens < 1) {
      await sleep(200); // wait & retry
      this._refill();
    }

    this.tokens -= 1;
  }

  _refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    const refillAmount = elapsedSec * this.refillRate;

    if (refillAmount > 0) {
      this.tokens = Math.min(
        this.maxPerMinute,
        this.tokens + refillAmount
      );
      this.lastRefill = now;
    }
  }
}

const yahooLimiter = new RateLimiter(40)
// === Load Allowed Tickers from CSV ===
const CSV_TICKERS_FILE = "./tickers.csv";

function loadTickersFromCSV() {
  if (!fs.existsSync(CSV_TICKERS_FILE)) {
    console.warn(chalk.yellow("tickers.csv not found — using fallback watchlist"));
    return null;
  }

  try {
    const raw = fs.readFileSync(CSV_TICKERS_FILE, "utf8");
    return raw
      .split(/\r?\n/)
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t.length > 0);
  } catch (err) {
    console.error("Failed to read tickers.csv:", err);
    return null;
  }
}

// Load CSV tickers once at startup
let CSV_TICKERS = [];
try {
  CSV_TICKERS = loadTickersFromCSV() || [];  
  console.log(chalk.green(`Loaded ${CSV_TICKERS.length} CSV tickers.`));
} catch (err) {
  console.error(chalk.red(`Error loading CSV tickers: ${err.message}`));
}


// Watchlist persistence
const WATCHLIST_FILE = "./macd-watchlist.json";

function loadWatchlist() {

  if (CSV_TICKERS && CSV_TICKERS.length > 0) {
    console.log(chalk.green(`Loaded ${CSV_TICKERS.length} tickers from tickers.csv`));
    return CSV_TICKERS;
  }

  // fallback to original JSON storage
  if (!fs.existsSync(WATCHLIST_FILE)) {
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(["AAPL", "TSLA", "NVDA"], null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf8"));
  } catch (e) {
    console.error("Failed reading watchlist:", e);
    return ["AAPL", "TSLA", "NVDA"];
  }
}

function saveWatchlist(list) {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2));
}
let WATCHLIST = loadWatchlist();

// Alert cooldowns / counters
const lastAlertAt = new Map(); // ticker -> timestamp ms
const dailyAlerts = new Map(); // ticker -> count
let lastDailyReset = new Date().toDateString();

function resetDailyCounts() {
  const today = new Date().toDateString();
  if (today !== lastDailyReset) {
    dailyAlerts.clear();
    lastDailyReset = today;
    console.log(chalk.blue("Daily alert counters reset"));
  }
}

function canAlert(ticker) {
  resetDailyCounts();
  if ((dailyAlerts.get(ticker) || 0) >= MAX_ALERTS_PER_DAY) return false;
  const last = lastAlertAt.get(ticker);
  if (!last) return true;
  const diffMinutes = (Date.now() - last) / 60000;
  return diffMinutes >= ALERT_COOLDOWN_MINUTES;
}
function recordAlert(ticker) {
  lastAlertAt.set(ticker, Date.now());
  dailyAlerts.set(ticker, (dailyAlerts.get(ticker) || 0) + 1);
}

// ---------- Technical helpers ----------
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  const s = slice.reduce((a, b) => a + b, 0);
  return s / period;
}
function ema(values, period) {
  // values: array of numbers (chronological oldest->newest)
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  // start with SMA of first period
  let emaPrev = sma(values.slice(0, period), period);
  // iterate from index = period to end
  for (let i = period; i < values.length; i++) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
  }
  return emaPrev;
}
function emaSeries(values, period) {
  // returns array of EMA values aligned with original values (null before enough pts)
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  // initial SMA at index period-1
  let prev = values.slice(0, period).reduce((a,b)=>a+b,0) / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function macdSeries(closePrices) {
  // returns { macd:[], signal:[], hist:[] } arrays aligned with closePrices
  const fast = emaSeries(closePrices, MACD_FAST);
  const slow = emaSeries(closePrices, MACD_SLOW);
  const macd = new Array(closePrices.length).fill(null);
  for (let i = 0; i < closePrices.length; i++) {
    if (fast[i] != null && slow[i] != null) {
      macd[i] = fast[i] - slow[i];
    }
  }
  // compute signal as EMA over macd values (skip nulls)
  const macdVals = macd.map((v) => (v === null ? 0 : v)); // for emaSeries we need numbers, but we must align carefully
  // We'll compute signal only for indices where macd has enough consecutive non-null values.
  const signal = emaSeries(macdVals, MACD_SIGNAL).map((v, idx) => (macd[idx] === null ? null : v));
  const hist = macd.map((v, i) => (v === null || signal[i] === null ? null : v - signal[i]));
  return { macd, signal, hist };
}

// Simple divergence detection:
// Compare last two local peaks/troughs in price vs macd: if price makes a higher high but macd makes lower high => bearish divergence.
// We'll do a quick heuristic: find last two price highs (local maxima over window) and corresponding macd values.
function findLocalExtrema(values, lookback = 10) {
  // returns array of indices that are local highs (peak) or lows (trough) (very simple)
  const highs = [];
  const lows = [];
  for (let i = lookback; i < values.length - lookback; i++) {
    const center = values[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (values[j] >= center) isHigh = false;
      if (values[j] <= center) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

function checkDivergence(closePrices, macdSeriesArr) {
  // returns "bullish-div", "bearish-div", or null
  const { highs, lows } = findLocalExtrema(closePrices, 6);
  // bearish divergence: price makes higher high, macd makes lower high
  if (highs.length >= 2) {
    const i1 = highs[highs.length - 2];
    const i2 = highs[highs.length - 1];
    const priceHigherHigh = closePrices[i2] > closePrices[i1];
    const macd = macdSeriesArr.macd;
    if (macd[i1] != null && macd[i2] != null && priceHigherHigh && macd[i2] < macd[i1]) {
      return "bearish-div";
    }
  }
  // bullish divergence: price makes lower low, macd makes higher low
  if (lows.length >= 2) {
    const i1 = lows[lows.length - 2];
    const i2 = lows[lows.length - 1];
    const priceLowerLow = closePrices[i2] < closePrices[i1];
    const macd = macdSeriesArr.macd;
    if (macd[i1] != null && macd[i2] != null && priceLowerLow && macd[i2] > macd[i1]) {
      return "bullish-div";
    }
  }
  return null;
}

// ---------- Fetcher ----------
async function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
class Fetcher {
  constructor() {
    this.lastRequest = 0;
  }

  // Fetch intraday bars using yahoo-finance2, returns sorted oldest->newest closes array
  async fetchCloseSeries(ticker) {
    await yahooLimiter.consume();   // ONLY rate limit used now

    try {
      const now = new Date();
      const period1 = '2025-01-01';
      const period2 = now.toISOString().split('T')[0];

      const result = await yahooFinance.historical(ticker, {
        period1,
        period2,
        interval: HIST_INTERVAL
      });

      if (!result || !Array.isArray(result) || result.length === 0) return null;

      const sorted = result.sort((a, b) => new Date(a.date) - new Date(b.date));
      const closes = sorted.map(r => r.close);

      return { closes, raw: sorted };
    } catch (err) {
      console.error(chalk.red(`fetchCloseSeries error ${ticker}: ${err.message}`));
      return null;
    }
  }

}

// ---------- Analyzer ----------
class MACDAnalyzer {
  constructor() {
    this.fetcher = new Fetcher();
    // Keep last known macd/signal to detect cross events reliably
    this.lastState = new Map(); // ticker -> { macdLast, signalLast }
  }

  async analyzeTicker(ticker) {
    const data = await this.fetcher.fetchCloseSeries(ticker);
    if (!data) return null;
    const { closes, raw } = data;
    if (!closes || closes.length < MACD_SLOW + MACD_SIGNAL + 2) {
      // Not enough bars for stable MACD
      return null;
    }
    const macdObj = macdSeries(closes); // macd, signal, hist aligned
    // find latest non-null index
    let idx = macdObj.macd.length - 1;
    while (idx >= 0 && (macdObj.macd[idx] === null || macdObj.signal[idx] === null)) idx--;
    if (idx < 1) return null;

    const macdNow = macdObj.macd[idx];
    const signalNow = macdObj.signal[idx];
    const macdPrev = macdObj.macd[idx - 1];
    const signalPrev = macdObj.signal[idx - 1];

    // Detect cross
    let cross = null;
    // prev: macdPrev < signalPrev  and now macdNow > signalNow => bullish cross
    if (
      macdPrev != null &&
      signalPrev != null &&
      macdNow != null &&
      signalNow != null
    ) {
        if (macdPrev < signalPrev && macdNow > signalNow) cross = "bullish-cross";
        if (macdPrev > signalPrev && macdNow < signalNow) cross = "bearish-cross";
    }

    // divergence
    const divergence = checkDivergence(closes, macdObj); // "bullish-div" | "bearish-div" | null

    // Basic strength filter: require histogram increase in direction
    const histNow = macdObj.hist[idx];
    const histPrev = macdObj.hist[idx - 1];

    // Price info (latest bar)
    const latestBar = raw[idx];
    const prevBar = raw[idx - 1];

    return {
      ticker,
      cross,
      divergence,
      macdNow,
      signalNow,
      histNow,
      histPrev,
      price: latestBar.close,
      prevPrice: prevBar.close,
      timestamp: latestBar.date,
      raw,
      idx,
    };
  }
}

// ---------- Discord bot wiring ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const analyzer = new MACDAnalyzer();

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Show available commands"),
    new SlashCommandBuilder().setName("status").setDescription("Show bot status"),
    new SlashCommandBuilder().setName("watchlist").setDescription("Show monitored tickers"),
    new SlashCommandBuilder()
      .setName("add-ticker")
      .setDescription("Add ticker to monitor")
      .addStringOption((o) => o.setName("symbol").setDescription("Ticker").setRequired(true)),
    new SlashCommandBuilder()
      .setName("remove-ticker")
      .setDescription("Remove ticker")
      .addStringOption((o) => o.setName("symbol").setDescription("Ticker").setRequired(true)),
    new SlashCommandBuilder().setName("scan-now").setDescription("Run immediate scan"),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
  console.log(chalk.green("Slash commands registered"));
}

function formatEmbedForAlert(res, type) {
  const color = type === "bullish" ? 0x00ff00 : 0xff0000;
  const emoji = type === "bullish" ? "🟢 Bullish MACD" : "🔴 Bearish MACD";
  const divText = res.divergence ? ` • Divergence: ${res.divergence}` : "";
  const timeStr = new Date(res.timestamp).toLocaleString();
  return new EmbedBuilder()
    .setTitle(`${emoji} ${res.ticker}`)
    .setDescription(`Price: $${res.price} • Cross: ${res.cross}${divText}`)
    .addFields(
      { name: "MACD", value: `${res.macdNow.toFixed(6)}`, inline: true },
      { name: "Signal", value: `${res.signalNow.toFixed(6)}`, inline: true },
      { name: "Histogram", value: `${res.histNow != null ? res.histNow.toFixed(6) : "N/A"}`, inline: true },
      { name: "Time", value: `${timeStr}`, inline: true }
    )
    .setColor(color)
    .setTimestamp();
}

// scanning loop
let scanning = false;
async function runScanOnce(channel, tickers = WATCHLIST) {
  console.log(chalk.magenta(`Starting MACD scan for ${tickers.length} tickers at ${new Date().toLocaleTimeString()}`));
  for (const sym of tickers) {
    try {
      const res = await analyzer.analyzeTicker(sym);
      if (!res) {
        console.log(chalk.gray(`No MACD data for ${sym}`));
        continue;
      }
      if (!res.cross) {
        // we only alert on cross events; if divergence alone and no cross you could choose to alert, optional.
        console.log(chalk.gray(`${sym}: no cross (div: ${res.divergence || "none"})`));
        continue;
      }
      const tickerOk = canAlert(sym);
      if (!tickerOk) {
        console.log(chalk.yellow(`Skipped ${sym} due to cooldown or daily limit`));
        continue;
      }
      // Additional filter: confirm histogram moved in same direction
      // bullish-cross: histNow > histPrev (gaining positive momentum)
      let pass = true;
      if (res.cross !== "bullish-cross") {
          console.log(chalk.gray(`${sym}: ignoring bearish signals — bullish-only mode`));
          continue;
      }

      // histogram rising
      if (!(res.histNow > res.histPrev)) {
          console.log(chalk.gray(`${sym}: MACD bullish but histogram not rising -> skip`));
          continue;
      }

      // PRICE rising confirmation
      if (!(res.price > res.prevPrice)) {
          console.log(chalk.gray(`${sym}: MACD bullish but price not rising -> skip`));
          continue;
      }

      if (!pass) {
        console.log(chalk.gray(`${sym}: cross detected but histogram not confirming -> no alert`));
        continue;
      }
      const type = res.cross === "bullish-cross" ? "bullish" : "bearish";
      const embed = formatEmbedForAlert(res, type);
      try {
        await channel.send({ embeds: [embed] });
        recordAlert(sym);
        console.log(chalk.green(`Alert sent for ${sym} (${res.cross}${res.divergence ? " + " + res.divergence : ""})`));
      } catch (err) {
        console.error(chalk.red(`Failed to send message for ${sym}: ${err.message}`));
      }
    } catch (err) {
      console.error(chalk.red(`Error analyzing ${sym}: ${err.message}`));
    }
  }
  console.log(chalk.green("Scan finished"));
}

// orchestrator: periodic scanning
let loopHandle = null;
async function startLoop(client) {
  if (scanning) return;
  scanning = true;
  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
  // run immediately once
  runScanOnce(channel).catch((e) => console.error("Initial scan error:", e));
  loopHandle = setInterval(() => {
    runScanOnce(channel).catch((e) => console.error("Periodic scan error:", e));
  }, POLL_INTERVAL_SEC * 1000);
  console.log(chalk.blue(`Started periodic scanning every ${POLL_INTERVAL_SEC}s`));
}
function stopLoop() {
  if (loopHandle) clearInterval(loopHandle);
  scanning = false;
}

// ---------- Interaction handler ----------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;
  try {
    if (name === "help") {
      return interaction.reply({
        content:
          "/help, /status, /watchlist, /add-ticker SYMBOL, /remove-ticker SYMBOL, /scan-now\n\nNote: Use tickers like AAPL, TSLA, NVDA.",
        ephemeral: true,
      });
    }
    if (name === "status") {
      return interaction.reply({
        content: `Monitoring **${WATCHLIST.length}** tickers. Poll interval: ${POLL_INTERVAL_SEC}s.\nScanning: ${scanning}`,
        ephemeral: true,
      });
    }
    if (name === "watchlist") {
      return interaction.reply({ content: `Watchlist:\n${WATCHLIST.join(", ")}`, ephemeral: true });
    }

    if (name === "add-ticker") {
      await interaction.deferReply({ ephemeral: true });

      const symbol = interaction.options.getString("symbol").trim().toUpperCase();

      // Validate against CSV list
      if (CSV_TICKERS.length > 0 && !CSV_TICKERS.includes(symbol)) {
        return interaction.editReply(
          `❌ ${symbol} is not in tickers.csv.\nUpdate tickers.csv if you want to allow this ticker.`
        );
      }

      if (WATCHLIST.includes(symbol)) {
        return interaction.editReply(`Already watching ${symbol}.`);
      }

      // Validate ticker by fetching data
      const test = await analyzer.fetcher.fetchCloseSeries(symbol);
      if (!test || !test.closes || test.closes.length === 0) {
        return interaction.editReply(`❌ Could not fetch data for ${symbol}. Not added.`);
      }

      WATCHLIST.push(symbol);
      saveWatchlist(WATCHLIST);

      return interaction.editReply(`✅ Added ${symbol} to watchlist.`);
    }

    if (name === "remove-ticker") {
      const symbol = interaction.options.getString("symbol").trim().toUpperCase();
      if (!WATCHLIST.includes(symbol)) return interaction.reply({ content: `${symbol} not in watchlist.`, ephemeral: true });
      WATCHLIST = WATCHLIST.filter((s) => s !== symbol);
      saveWatchlist(WATCHLIST);
      return interaction.reply({ content: `Removed ${symbol}`, ephemeral: true });
    }

    if (name === "scan-now") {
      await interaction.reply({ content: "Manual scan started...", ephemeral: true });
      const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
      await runScanOnce(channel, WATCHLIST);
    }

  } catch (err) {
    console.error("Interaction error:", err);
    try {
      if (interaction.deferred || interaction.replied) {
        interaction.followUp({ content: `Error: ${err.message}`, ephemeral: true });
      } else {
        interaction.reply({ content: `Error: ${err.message}`, ephemeral: true });
      }
    } catch (e) {}
  }
});

// ---------- startup ----------
client.once("ready", async () => {
  console.log(chalk.greenBright(`Logged in as ${client.user.tag}`));
  await registerCommands();
  startLoop(client).catch((e) => console.error("Start loop error:", e));
});

client.login(DISCORD_TOKEN);
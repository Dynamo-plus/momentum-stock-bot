// ================= IMPORTS =================
import YahooFinance from "yahoo-finance2";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
import chalk from "chalk";

dotenv.config();

const yahooFinance = new YahooFinance();

// ================= CONFIG =================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const SCAN_INTERVAL_MINUTES = 5;
const BATCH_SIZE = 5;
const DELAY_BETWEEN_STOCKS = 2000;
const DELAY_BETWEEN_BATCHES = 10000;

const MIN_VOLUME = 500000;
const MIN_PRICE_CHANGE = 5.0;
const MIN_REL_VOLUME = 1.3;
const MAX_PRICE = 1000;
const MIN_PRICE = 0.01;

const ALERT_COOLDOWN_MINUTES = 15;
const MAX_ALERTS_PER_STOCK = 20;

const WATCHLIST_FILE = "./watchlist.json";

// ================= WATCHLIST HANDLER =================
function loadWatchlist() {
  if (!fs.existsSync(WATCHLIST_FILE)) {
    fs.writeFileSync(
      WATCHLIST_FILE,
      JSON.stringify(
        ["AAPL", "TSLA", "NVDA", "AMD", "PLTR", "COIN", "RIVN", "SOFI", "OSCR", "VIVK"],
        null,
        2
      )
    );
  }
  return JSON.parse(fs.readFileSync(WATCHLIST_FILE));
}

function saveWatchlist(list) {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2));
}

let WATCHLIST = loadWatchlist();

// ================= RATE LIMITER =================
class RateLimiter {
  constructor() {
    this.lastRequest = null;
    this.minDelay = 1000;
    this.backoffDelay = 5000;
    this.rateLimited = false;
  }

  async wait() {
    if (this.rateLimited) {
      console.log(chalk.yellow(`   ⏳ Rate limited - waiting ${this.backoffDelay / 1000}s...`));
      await new Promise((res) => setTimeout(res, this.backoffDelay));
      this.rateLimited = false;
    }
    if (this.lastRequest) {
      const elapsed = Date.now() - this.lastRequest;
      if (elapsed < this.minDelay) {
        await new Promise((res) => setTimeout(res, this.minDelay - elapsed));
      }
    }
    this.lastRequest = Date.now();
  }

  markRateLimited() {
    this.rateLimited = true;
    this.backoffDelay = Math.min(this.backoffDelay * 1.5, 30000);
  }

  reset() {
    this.backoffDelay = 5000;
  }
}

// ================= STOCK FETCHER =================
class StockDataFetcher {
  constructor() {
    this.rateLimiter = new RateLimiter();
  }

  async getStockData(ticker) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`   ⏳ Requesting Yahoo data for ${ticker} (attempt ${attempt})`);
      try {
        await this.rateLimiter.wait();

        const result = await yahooFinance.quote(ticker);
        if (!result || !result.regularMarketPrice) {
          throw new Error("No valid data returned");
        }

        const price = result.regularMarketPrice;
        const change_pct = result.regularMarketChangePercent;
        const volume = result.regularMarketVolume;
        const avgVolume = result.averageDailyVolume3Month || result.averageDailyVolume10Day || 1;
        const rel_volume = (volume / avgVolume).toFixed(2);

        console.log(
          `   ✅ Data fetched for ${ticker}: $${price}, ${change_pct}% (${rel_volume}x volume)`
        );

        return {
          ticker,
          price,
          change_pct,
          volume,
          rel_volume,
          timestamp: new Date(),
        };
      } catch (err) {
        console.error(`   ❌ Error fetching ${ticker}: ${err.message}`);
        if (attempt === 2) return null;
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
    return null;
  }
}

// ================= MOMENTUM SCANNER =================
class MomentumScanner {
  constructor() {
    this.fetcher = new StockDataFetcher();
    this.alertHistory = new Map();
    this.alertCounter = new Map();
    this.lastReset = new Date().toDateString();
  }

  resetDailyCounters() {
    const today = new Date().toDateString();
    if (today !== this.lastReset) {
      this.alertCounter.clear();
      this.lastReset = today;
      console.log(chalk.blue("📅 Daily counters reset"));
    }
  }

  canSendAlert(ticker) {
    this.resetDailyCounters();
    if ((this.alertCounter.get(ticker) || 0) >= MAX_ALERTS_PER_STOCK) return false;
    if (this.alertHistory.has(ticker)) {
      const last = this.alertHistory.get(ticker);
      const diff = (Date.now() - last) / 60000;
      if (diff < ALERT_COOLDOWN_MINUTES) return false;
    }
    return true;
  }

  recordAlert(ticker) {
    this.alertHistory.set(ticker, Date.now());
    this.alertCounter.set(ticker, (this.alertCounter.get(ticker) || 0) + 1);
  }

  getAlertNumber(ticker) {
    return (this.alertCounter.get(ticker) || 0) + 1;
  }

  checkMomentum(data) {
    if (!data) return [false, "No data"];
    if (data.price > MAX_PRICE) return [false, "Price too high"];
    if (data.price < MIN_PRICE) return [false, "Price too low"];
    if (data.volume < MIN_VOLUME) return [false, "Volume too low"];
    if (Math.abs(data.change_pct) < MIN_PRICE_CHANGE) return [false, "Move too small"];
    if (data.rel_volume < MIN_REL_VOLUME) return [false, "RelVol too low"];
    return [true, "Momentum detected!"];
  }

  formatDiscordEmbed(data) {
    const alertNum = this.getAlertNumber(data.ticker);
    const color = data.change_pct > 0 ? 0x00ff00 : 0xff0000;
    const emoji = data.change_pct > 0 ? "🟢" : "🔴";

    return new EmbedBuilder()
      .setTitle(`${emoji} ${data.ticker} | Alert #${alertNum}`)
      .setDescription(`**$${data.price}** | ${data.change_pct > 0 ? "+" : ""}${data.change_pct}%`)
      .setColor(color)
      .addFields({
        name: "📊 Volume Info",
        value: `${data.volume.toLocaleString()} (${data.rel_volume}x RelVol)`,
        inline: true,
      })
      .setTimestamp();
  }
}

// ================= MAIN BOT =================
class MomentumBot {
  constructor(client) {
    this.client = client;
    this.scanner = new MomentumScanner();
    this.scanCount = 0;
  }

  async scanBatch(batch, channel) {
    console.log(chalk.magenta(`🔍 Scanning batch: ${batch.join(", ")}`));

    for (const ticker of batch) {
      console.log(chalk.cyan(`   ▶️ Fetching ${ticker}...`));
      const data = await this.scanner.fetcher.getStockData(ticker);

      if (!data) continue;

      const [isMomentum, reason] = this.scanner.checkMomentum(data);
      if (isMomentum && this.scanner.canSendAlert(ticker)) {
        const embed = this.scanner.formatDiscordEmbed(data);
        await channel.send({ embeds: [embed] });
        this.scanner.recordAlert(ticker);
        console.log(chalk.green(`   🚨 ALERT SENT for ${ticker} (${reason})`));
      } else {
        console.log(chalk.gray(`   ❌ No alert for ${ticker} (${reason})`));
      }

      await new Promise((res) => setTimeout(res, DELAY_BETWEEN_STOCKS));
    }
  }

  async scanAndPost(channel) {
    this.scanCount++;
    console.log(chalk.blueBright(`\n📦 Starting scan #${this.scanCount}`));

    for (let i = 0; i < WATCHLIST.length; i += BATCH_SIZE) {
      const batch = WATCHLIST.slice(i, i + BATCH_SIZE);
      await this.scanBatch(batch, channel);
      if (i + BATCH_SIZE < WATCHLIST.length) {
        console.log(chalk.gray(`⏸ Waiting before next batch...`));
        await new Promise((res) => setTimeout(res, DELAY_BETWEEN_BATCHES));
      }
    }
  }

  async start() {
    const channel = await this.client.channels.fetch(DISCORD_CHANNEL_ID);
    console.log(chalk.green("🚀 Momentum Scanner Bot Started!"));
    await channel.send(`🤖 **Bot Started** - Watching ${WATCHLIST.length} stocks`);

    while (true) {
      try {
        await this.scanAndPost(channel);
        console.log(chalk.gray(`🕒 Waiting ${SCAN_INTERVAL_MINUTES} minutes before next scan...`));
        await new Promise((res) => setTimeout(res, SCAN_INTERVAL_MINUTES * 60000));
      } catch (e) {
        console.error(chalk.red(`❌ Error: ${e.message}`));
        await new Promise((res) => setTimeout(res, 60000));
      }
    }
  }
}

// ================= DISCORD CLIENT =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// ================= COMMANDS =================
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName("status").setDescription("Show scanner status"),
    new SlashCommandBuilder().setName("watchlist").setDescription("List watched tickers"),
    new SlashCommandBuilder().setName("scan-now").setDescription("Force manual scan"),
  ].map((cmd) => cmd.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
  console.log(chalk.green("✅ Slash commands registered"));
}

client.once("ready", async () => {
  console.log(chalk.greenBright(`✅ Logged in as ${client.user.tag}`));
  await registerCommands();
  const bot = new MomentumBot(client);
  bot.start();
});

client.login(DISCORD_TOKEN);

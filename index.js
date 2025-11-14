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
  try {
    return JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf8"));
  } catch (err) {
    console.error("Failed to parse watchlist.json, resetting:", err);
    const defaults = ["AAPL", "TSLA", "NVDA", "AMD", "PLTR"];
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
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

  // Returns object or null
  async getStockData(ticker) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.rateLimiter.wait();

        const result = await yahooFinance.quote(ticker);
        if (!result || typeof result.regularMarketPrice === "undefined") {
          throw new Error("No valid data returned");
        }

        const price = result.regularMarketPrice;
        const change_pct = result.regularMarketChangePercent ?? 0;
        const volume = result.regularMarketVolume ?? 0;
        const avgVolume = result.averageDailyVolume3Month || result.averageDailyVolume10Day || 1;
        const rel_volume = avgVolume > 0 ? parseFloat((volume / avgVolume).toFixed(2)) : 1.0;

        return {
          ticker,
          price,
          change_pct,
          volume,
          rel_volume,
          timestamp: new Date(),
        };
      } catch (err) {
        console.error(chalk.red(`Error fetching ${ticker}: ${err.message}`));
        // backoff on Yahoo rate limits
        const msg = (err.message || "").toLowerCase();
        if (msg.includes("rate") || msg.includes("429") || msg.includes("limit")) {
          this.rateLimiter.markRateLimited();
        }
        if (attempt === 2) return null;
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
    return null;
  }

  // Quick single-ticker price fetch for /price command
  async fetchPrice(ticker) {
    try {
      const result = await yahooFinance.quote(ticker);
      if (!result || typeof result.regularMarketPrice === "undefined") return null;
      return result;
    } catch (err) {
      console.error(`fetchPrice error for ${ticker}:`, err.message);
      return null;
    }
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
    const time = data.timestamp.toLocaleTimeString();

    return new EmbedBuilder()
      .setTitle(`${emoji} ${data.ticker} | Alert #${alertNum}`)
      .setDescription(`**$${data.price}** | ${data.change_pct > 0 ? "+" : ""}${data.change_pct}%`)
      .setColor(color)
      .addFields(
        {
          name: "📊 Volume",
          value: `${data.volume.toLocaleString()}\n${data.rel_volume}x RelVol`,
          inline: true,
        },
        {
          name: "⏱ Time",
          value: `${time}`,
          inline: true,
        }
      )
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
      if (!data) {
        console.log(chalk.yellow(`   ⚠️ No data for ${ticker}`));
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_STOCKS));
        continue;
      }

      const [isMomentum, reason] = this.scanner.checkMomentum(data);
      if (isMomentum && this.scanner.canSendAlert(ticker)) {
        const embed = this.scanner.formatDiscordEmbed(data);
        try {
          await channel.send({ embeds: [embed] });
          this.scanner.recordAlert(ticker);
          console.log(chalk.green(`   🚨 ALERT SENT for ${ticker} (${reason})`));
        } catch (err) {
          console.error("Failed to send alert to channel:", err.message);
        }
      } else {
        console.log(chalk.gray(`   ❌ No alert for ${ticker} (${reason})`));
      }

      await new Promise((res) => setTimeout(res, DELAY_BETWEEN_STOCKS));
    }
  }

  async scanAndPost(channel) {
    this.scanCount++;
    console.log(chalk.blueBright(`\n📦 Starting scan #${this.scanCount} at ${new Date().toLocaleTimeString()}`));

    for (let i = 0; i < WATCHLIST.length; i += BATCH_SIZE) {
      const batch = WATCHLIST.slice(i, i + BATCH_SIZE);
      await this.scanBatch(batch, channel);
      if (i + BATCH_SIZE < WATCHLIST.length) {
        console.log(chalk.gray(`   ⏸ Waiting ${DELAY_BETWEEN_BATCHES / 1000}s before next batch...`));
        await new Promise((res) => setTimeout(res, DELAY_BETWEEN_BATCHES));
      }
    }

    console.log(chalk.greenBright(`🏁 Scan #${this.scanCount} complete at ${new Date().toLocaleTimeString()}`));
  }

  // Start periodic scanning (non-blocking)
  start() {
    // run once immediately
    this.client.channels.fetch(DISCORD_CHANNEL_ID)
      .then((channel) => this.scanAndPost(channel))
      .catch((e) => console.error("Failed to fetch channel for initial scan:", e.message));

    // schedule repeating scans
    setInterval(async () => {
      try {
        const channel = await this.client.channels.fetch(DISCORD_CHANNEL_ID);
        await this.scanAndPost(channel);
      } catch (e) {
        console.error("Scanner periodic error:", e.message);
      }
    }, SCAN_INTERVAL_MINUTES * 60000);
  }
}

// ================= DISCORD CLIENT =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const fetcher = new StockDataFetcher();

// ================= COMMAND REGISTRATION =================
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName("stock-help").setDescription("Show all available bot commands"),
    new SlashCommandBuilder().setName("status").setDescription("Show scanner status"),
    new SlashCommandBuilder().setName("watchlist").setDescription("List watched tickers"),
    new SlashCommandBuilder().setName("scan-now").setDescription("Force manual scan"),
    new SlashCommandBuilder()
      .setName("add-ticker")
      .setDescription("Add a ticker to the watchlist")
      .addStringOption((opt) =>
        opt.setName("symbol").setDescription("Ticker symbol (e.g. AAPL)").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("remove-ticker")
      .setDescription("Remove a ticker from the watchlist")
      .addStringOption((opt) =>
        opt.setName("symbol").setDescription("Ticker symbol (e.g. TSLA)").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("price")
      .setDescription("Get current price for a ticker")
      .addStringOption((opt) =>
        opt.setName("symbol").setDescription("Ticker symbol (e.g. NVDA)").setRequired(true)
      ),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
  console.log(chalk.green("✅ Slash commands registered"));
}

// ================= INTERACTION HANDLER =================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;

  try {
    if (name === "stock-help") {
      const helpText = [
        "📘 **Available Commands**",
        "",
        "**/help** — Show all commands",
        "**/status** — Show bot status & scan interval",
        "**/watchlist** — View current ticker watchlist",
        "**/add-ticker SYMBOL** — Add new ticker",
        "**/remove-ticker SYMBOL** — Remove ticker",
        "**/price SYMBOL** — Get real-time price for a ticker",
        "**/scan-now** — Manually trigger a scan",
      ].join("\n");

      return interaction.reply({ content: helpText, ephemeral: true });
    }

    if (name === "status") {
      return interaction.reply({
        content: `📡 Bot is running.\nWatching **${WATCHLIST.length}** tickers.\nScan interval: ${SCAN_INTERVAL_MINUTES} minutes.`,
        ephemeral: true,
      });
    }

    if (name === "watchlist") {
      return interaction.reply({
        content: `📋 **Watchlist:**\n${WATCHLIST.join(", ")}`,
        ephemeral: true,
      });
    }

    if (name === "scan-now") {
      // Reply immediately then run the scan in the background
      await interaction.reply({ content: "⚙️ Manual scan started...", ephemeral: true });
      const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
      const bot = new MomentumBot(client);
      bot.scanAndPost(channel).catch((e) => {
        console.error("Manual scan error:", e.message);
        // attempt to notify user if possible
        try {
          interaction.followUp({ content: `❌ Manual scan failed: ${e.message}`, ephemeral: true });
        } catch (e) {}
      });
      return;
    }

    if (name === "add-ticker") {
      const raw = interaction.options.getString("symbol");
      const symbol = raw.trim().toUpperCase();
      if (!/^[A-Z0-9\.\-]{1,8}$/.test(symbol)) {
        return interaction.reply({ content: "⚠️ Invalid ticker format.", ephemeral: true });
      }
      if (WATCHLIST.includes(symbol)) {
        return interaction.reply({ content: `⚠️ ${symbol} is already in the watchlist.`, ephemeral: true });
      }

      // Validate symbol exists by fetching quick price
      await interaction.deferReply({ ephemeral: true }); // allow more time
      const info = await fetcher.fetchPrice(symbol);
      if (!info) {
        return interaction.editReply({ content: `❌ Could not find data for ${symbol}. Not added.` });
      }

      WATCHLIST.push(symbol);
      saveWatchlist(WATCHLIST);
      console.log(chalk.green(`Added ${symbol} to watchlist`));
      return interaction.editReply({ content: `✅ Added ${symbol} to the watchlist.` });
    }

    if (name === "remove-ticker") {
      const raw = interaction.options.getString("symbol");
      const symbol = raw.trim().toUpperCase();
      if (!WATCHLIST.includes(symbol)) {
        return interaction.reply({ content: `⚠️ ${symbol} is not in the watchlist.`, ephemeral: true });
      }
      WATCHLIST = WATCHLIST.filter((s) => s !== symbol);
      saveWatchlist(WATCHLIST);
      console.log(chalk.yellow(`Removed ${symbol} from watchlist`));
      return interaction.reply({ content: `🗑️ Removed ${symbol} from the watchlist.`, ephemeral: true });
    }

    if (name === "price") {
      const raw = interaction.options.getString("symbol");
      const symbol = raw.trim().toUpperCase();

      await interaction.deferReply({ ephemeral: true }); // allow extra time for fetch
      const info = await fetcher.fetchPrice(symbol);
      if (!info) {
        return interaction.editReply({ content: `❌ Could not fetch price for ${symbol}.` });
      }

      const price = info.regularMarketPrice ?? "N/A";
      const change = info.regularMarketChange ?? 0;
      const changePct = info.regularMarketChangePercent ?? 0;
      const pre = info.preMarketPrice;
      const post = info.postMarketPrice;
      const vol = info.regularMarketVolume ?? 0;

      const embed = new EmbedBuilder()
        .setTitle(`${info.shortName ?? info.symbol} — ${info.symbol}`)
        .setDescription(`**$${price}**  |  ${change >= 0 ? "+" : ""}${change.toFixed(2)} (${changePct >= 0 ? "+" : ""}${(changePct * 1).toFixed(2)}%)`)
        .addFields(
          { name: "Volume", value: `${vol.toLocaleString()}`, inline: true },
          { name: "Day Range", value: `${info.regularMarketDayLow ?? "N/A"} - ${info.regularMarketDayHigh ?? "N/A"}`, inline: true }
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  } catch (err) {
    console.error("Interaction handler error:", err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: `❌ Error: ${err.message}`, ephemeral: true });
      } else {
        await interaction.reply({ content: `❌ Error: ${err.message}`, ephemeral: true });
      }
    } catch (e) {
      console.error("Failed to notify user of error:", e.message);
    }
  }
});

// ================= START BOT =================
client.once("ready", async () => {
  console.log(chalk.greenBright(`✅ Logged in as ${client.user.tag}`));
  await registerCommands();
  const bot = new MomentumBot(client);
  bot.start();
});

client.login(DISCORD_TOKEN);

import fs from "node:fs/promises";
import path from "node:path";

const tokenArg = process.argv[2];
const exchangeArg = process.argv[3] || "binance";

const ROOT = process.cwd();
const RESULTS_DIR = path.join(ROOT, "data", "results");
const REQUESTS_DIR = path.join(ROOT, "data", "requests");
const INDEX_FILE = path.join(ROOT, "data", "search-index.json");

const SOURCES = {
  coingeckoSearch: "https://api.coingecko.com/api/v3/search",
  coingeckoCoins: "https://api.coingecko.com/api/v3/coins",
  binance24h: "https://api.binance.com/api/v3/ticker/24hr",
  binanceKlines: "https://api.binance.com/api/v3/klines",
  googleNewsRss: "https://news.google.com/rss/search",
  deepseek: "https://api.deepseek.com/chat/completions"
};

function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureDirs() {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  await fs.mkdir(REQUESTS_DIR, { recursive: true });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "accept": "application/json",
      "user-agent": "crypto-mint/0.1",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText} from ${url}: ${text.slice(0, 300)}`);
  }

  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/rss+xml,text/xml,text/plain",
      "user-agent": "crypto-mint/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} from ${url}`);
  }

  return response.text();
}

function extractRssItems(xml, max = 12) {
  const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, max);
  return itemMatches.map((match) => {
    const block = match[1];
    const read = (tag) => {
      const found = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return found ? decodeXml(found[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()) : "";
    };

    return {
      title: read("title"),
      link: read("link"),
      source: read("source"),
      publishedAt: read("pubDate"),
      snippet: read("description").replace(/<[^>]+>/g, "").slice(0, 300)
    };
  });
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function getCoinGeckoProfile(symbol) {
  const searchUrl = `${SOURCES.coingeckoSearch}?query=${encodeURIComponent(symbol)}`;
  const search = await fetchJson(searchUrl);
  const candidate = (search.coins || []).find((coin) => coin.symbol?.toUpperCase() === symbol) || search.coins?.[0];

  if (!candidate?.id) {
    return { candidate: null, detail: null };
  }

  const detailUrl = `${SOURCES.coingeckoCoins}/${encodeURIComponent(candidate.id)}?localization=false&tickers=false&market_data=true&community_data=true&developer_data=true&sparkline=false`;
  const detail = await fetchJson(detailUrl);
  return { candidate, detail };
}

async function getBinanceMarket(symbol) {
  const pairs = [`${symbol}USDT`, `${symbol}FDUSD`, `${symbol}USDC`, `${symbol}BTC`];
  const attempts = [];

  for (const pair of pairs) {
    try {
      const ticker = await fetchJson(`${SOURCES.binance24h}?symbol=${pair}`);
      const klines = await fetchJson(`${SOURCES.binanceKlines}?symbol=${pair}&interval=1d&limit=30`);
      return {
        exchange: "binance",
        pair,
        ticker,
        dailyCandles: klines.map((row) => ({
          openTime: new Date(row[0]).toISOString(),
          open: row[1],
          high: row[2],
          low: row[3],
          close: row[4],
          volume: row[5],
          closeTime: new Date(row[6]).toISOString()
        }))
      };
    } catch (error) {
      attempts.push({ pair, error: error.message });
    }
  }

  return { exchange: "binance", pair: null, ticker: null, dailyCandles: [], attempts };
}

async function getNews(symbol, coinName) {
  const query = `${symbol} ${coinName || "crypto"} token price news OR listing OR partnership OR mainnet`;
  const url = `${SOURCES.googleNewsRss}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await fetchText(url);
  return extractRssItems(xml);
}

function compactCoinGecko(detail) {
  if (!detail) return null;

  const market = detail.market_data || {};
  return {
    id: detail.id,
    symbol: detail.symbol?.toUpperCase(),
    name: detail.name,
    categories: detail.categories || [],
    homepage: detail.links?.homepage?.filter(Boolean).slice(0, 3) || [],
    description: detail.description?.en?.replace(/\s+/g, " ").slice(0, 1200) || "",
    marketCapRank: detail.market_cap_rank,
    currentPriceUsd: market.current_price?.usd ?? null,
    marketCapUsd: market.market_cap?.usd ?? null,
    fullyDilutedValuationUsd: market.fully_diluted_valuation?.usd ?? null,
    totalVolumeUsd: market.total_volume?.usd ?? null,
    priceChange24hPct: market.price_change_percentage_24h ?? null,
    priceChange7dPct: market.price_change_percentage_7d ?? null,
    priceChange14dPct: market.price_change_percentage_14d ?? null,
    priceChange30dPct: market.price_change_percentage_30d ?? null,
    athUsd: market.ath?.usd ?? null,
    athChangePct: market.ath_change_percentage?.usd ?? null,
    circulatingSupply: market.circulating_supply ?? null,
    totalSupply: market.total_supply ?? null,
    maxSupply: market.max_supply ?? null,
    sentimentVotesUpPct: detail.sentiment_votes_up_percentage ?? null,
    watchlistUsers: detail.watchlist_portfolio_users ?? null,
    genesisDate: detail.genesis_date ?? null
  };
}

function compactBinance(market) {
  if (!market?.ticker) return market;

  const candles = market.dailyCandles || [];
  const latest = candles.at(-1);
  const first = candles[0];
  const thirtyDayChangePct = latest && first
    ? ((Number(latest.close) - Number(first.open)) / Number(first.open)) * 100
    : null;

  return {
    exchange: market.exchange,
    pair: market.pair,
    lastPrice: Number(market.ticker.lastPrice),
    priceChange24hPct: Number(market.ticker.priceChangePercent),
    highPrice24h: Number(market.ticker.highPrice),
    lowPrice24h: Number(market.ticker.lowPrice),
    volumeBase24h: Number(market.ticker.volume),
    volumeQuote24h: Number(market.ticker.quoteVolume),
    thirtyDayChangePct,
    dailyCandles: candles.slice(-14)
  };
}

function buildPrompt({ symbol, exchange, profile, market, news }) {
  return [
    {
      role: "system",
      content: [
        "You are a crypto secondary-market research analyst.",
        "Use the supplied public data only. Do not invent facts.",
        "Return strict JSON only, with no markdown fences.",
        "This is research, not financial advice.",
        "For buy calls, be conservative and explicitly weigh liquidity, news freshness, valuation, unlock/supply, and momentum risk.",
        "All prose fields must be in Simplified Chinese."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "Analyze why the token may be rising, whether it is worth buying, expected upside, and holding period.",
        requiredJsonShape: {
          token: "SYMBOL",
          name: "token name or unknown",
          generatedAt: "ISO time",
          summary: "short Chinese summary",
          rating: {
            score: "0-100 integer",
            label: "强烈回避/观望/谨慎试仓/可以买但严控仓位/高确定性机会",
            confidence: "低/中/高"
          },
          recommendation: {
            action: "不买/观察/小仓试错/分批买入",
            expectedUpsidePct: "number or null",
            holdingPeriod: "例如 1-3天 / 1-2周 / 1-3个月",
            invalidation: "什么情况说明逻辑失效"
          },
          catalysts: ["上涨原因或潜在催化"],
          latestNews: [{ title: "news title", impact: "利好/利空/中性", reason: "why it matters" }],
          fundamentals: ["项目资料和基本面要点"],
          marketRead: ["行情和成交量解读"],
          risks: ["风险点"],
          watchlist: ["后续需要盯的信号"],
          sourceNotes: ["数据不足或可靠性说明"]
        },
        input: { symbol, exchange },
        collectedAt: nowIso(),
        data: {
          profile,
          market,
          news
        }
      })
    }
  ];
}

function parseDeepSeekJson(content) {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const found = trimmed.match(/\{[\s\S]*\}/);
    if (!found) throw new Error("DeepSeek did not return JSON.");
    return JSON.parse(found[0]);
  }
}

async function askDeepSeek(payload) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("Missing DEEPSEEK_API_KEY environment variable.");
  }

  const response = await fetchJson(SOURCES.deepseek, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: buildPrompt(payload)
    })
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("DeepSeek response did not include message content.");
  }

  return parseDeepSeekJson(content);
}

function fallbackAnalysis({ symbol, profile, market, news, error }) {
  const price24h = market?.priceChange24hPct;
  const profileName = profile?.name || "未知项目";
  const score = typeof price24h === "number"
    ? Math.max(15, Math.min(62, Math.round(38 + price24h / 2)))
    : 35;

  return {
    token: symbol,
    name: profileName,
    generatedAt: nowIso(),
    summary: "AI 分析暂时不可用，以下为基于公开数据的保守占位结论。建议等待完整模型分析后再做决策。",
    rating: {
      score,
      label: score >= 55 ? "谨慎试仓" : "观望",
      confidence: "低"
    },
    recommendation: {
      action: "观察",
      expectedUpsidePct: null,
      holdingPeriod: "等待更多消息确认",
      invalidation: "若成交量回落、消息无法验证或价格跌破启动位，应视为逻辑失效。"
    },
    catalysts: news.slice(0, 5).map((item) => item.title).filter(Boolean),
    latestNews: news.slice(0, 6).map((item) => ({
      title: item.title,
      impact: "中性",
      reason: "仅抓取到新闻标题，尚未完成模型判断。"
    })),
    fundamentals: profile ? [
      `${profile.name || symbol} 当前市值排名为 ${profile.marketCapRank ?? "未知"}。`,
      `近 24 小时价格变化为 ${profile.priceChange24hPct ?? "未知"}%。`
    ] : ["未匹配到可靠的 CoinGecko 项目资料。"],
    marketRead: market?.pair ? [
      `${market.pair} 24 小时涨跌幅为 ${market.priceChange24hPct}%，成交额约为 ${market.volumeQuote24h}。`
    ] : ["未匹配到 Binance 主流交易对。"],
    risks: ["AI 分析失败或未配置 DeepSeek Key。", "公开数据可能延迟或不完整。"],
    watchlist: ["确认消息来源真实性。", "观察成交量是否持续放大。", "检查交易所公告、解锁和做市变化。"],
    sourceNotes: [`DeepSeek error: ${error.message}`]
  };
}

async function readIndex() {
  try {
    return JSON.parse(await fs.readFile(INDEX_FILE, "utf8"));
  } catch {
    return { updatedAt: null, results: [] };
  }
}

async function writeResult(symbol, result) {
  const latestName = `${symbol}-latest.json`;
  const timestampName = `${symbol}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const latestPath = path.join(RESULTS_DIR, latestName);
  const timestampPath = path.join(RESULTS_DIR, timestampName);

  const json = JSON.stringify(result, null, 2);
  await fs.writeFile(latestPath, `${json}\n`);
  await fs.writeFile(timestampPath, `${json}\n`);

  const index = await readIndex();
  const withoutCurrent = (index.results || []).filter((item) => item.token !== symbol);
  const nextItem = {
    token: symbol,
    name: result.analysis?.name || result.profile?.name || symbol,
    score: result.analysis?.rating?.score ?? null,
    label: result.analysis?.rating?.label || "未知",
    action: result.analysis?.recommendation?.action || "未知",
    generatedAt: result.generatedAt,
    latestPath: `data/results/${latestName}`
  };

  const next = {
    updatedAt: nowIso(),
    results: [nextItem, ...withoutCurrent].slice(0, 100)
  };

  await fs.writeFile(INDEX_FILE, `${JSON.stringify(next, null, 2)}\n`);
}

async function writeRequest(symbol, exchange) {
  const record = {
    token: symbol,
    exchange,
    requestedAt: nowIso(),
    source: "github-actions"
  };
  const file = path.join(REQUESTS_DIR, `${symbol}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
}

async function main() {
  const symbol = normalizeSymbol(tokenArg);
  const exchange = exchangeArg.trim().toLowerCase();

  if (!symbol) {
    throw new Error("Usage: node scripts/analyze-token.mjs TOKEN [exchange]");
  }

  await ensureDirs();
  await writeRequest(symbol, exchange);

  const errors = [];
  const [profileResult, marketResult] = await Promise.allSettled([
    getCoinGeckoProfile(symbol),
    getBinanceMarket(symbol)
  ]);

  if (profileResult.status === "rejected") errors.push(`CoinGecko: ${profileResult.reason.message}`);
  if (marketResult.status === "rejected") errors.push(`Binance: ${marketResult.reason.message}`);

  const profile = compactCoinGecko(profileResult.value?.detail);
  const market = compactBinance(marketResult.value);

  let news = [];
  try {
    news = await getNews(symbol, profile?.name);
  } catch (error) {
    errors.push(`Google News RSS: ${error.message}`);
  }

  let analysis;
  let analysisStatus = "deepseek";
  try {
    analysis = await askDeepSeek({ symbol, exchange, profile, market, news });
  } catch (error) {
    analysisStatus = "fallback";
    errors.push(`DeepSeek: ${error.message}`);
    analysis = fallbackAnalysis({ symbol, profile, market, news, error });
  }

  const result = {
    token: symbol,
    exchange,
    generatedAt: nowIso(),
    analysisStatus,
    analysis,
    profile,
    market,
    news,
    sources: SOURCES,
    errors
  };

  await writeResult(symbol, result);
  console.log(`Wrote analysis for ${symbol} with status ${analysisStatus}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

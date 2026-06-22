import fs from "node:fs/promises";
import path from "node:path";

const tokenArg = process.argv[2];
const exchangeArg = process.argv[3] || "binance";
const DEFAULT_BATCH_CONCURRENCY = 4;

const ROOT = process.cwd();
const RESULTS_DIR = path.join(ROOT, "data", "results");
const REQUESTS_DIR = path.join(ROOT, "data", "requests");
const INDEX_FILE = path.join(ROOT, "data", "search-index.json");

const SOURCES = {
  coingeckoSearch: "https://api.coingecko.com/api/v3/search",
  coingeckoCoins: "https://api.coingecko.com/api/v3/coins",
  binance24h: "https://api.binance.com/api/v3/ticker/24hr",
  binanceKlines: "https://api.binance.com/api/v3/klines",
  bitgetSpotTicker: "https://api.bitget.com/api/v2/spot/market/tickers",
  bitgetSpotCandles: "https://api.bitget.com/api/v2/spot/market/candles",
  dexscreenerSearch: "https://api.dexscreener.com/latest/dex/search",
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

function parseTokenInputs(value) {
  return [...new Set(String(value || "")
    .split(",")
    .map((item) => item.trim().replace(/^\$/, ""))
    .filter(Boolean))];
}

function parseSymbols(value) {
  return [...new Set(String(value || "")
    .split(/[\s,;，；、]+/)
    .map(normalizeSymbol)
    .filter(Boolean))];
}

function getBatchConcurrency() {
  const value = Number(process.env.BATCH_CONCURRENCY || DEFAULT_BATCH_CONCURRENCY);
  if (!Number.isFinite(value)) return DEFAULT_BATCH_CONCURRENCY;
  return Math.max(1, Math.min(12, Math.floor(value)));
}

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeLookup(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\$/, "")
    .replace(/\s+/g, " ");
}

function isShortAmbiguousSymbol(symbol) {
  return symbol.length <= 3;
}

function scoreCoinCandidate(coin, symbol) {
  const candidateSymbol = coin.symbol?.toUpperCase();
  if (candidateSymbol !== symbol) return -1;

  const rank = Number(coin.market_cap_rank);
  const rankScore = Number.isFinite(rank) ? Math.max(0, 1000 - rank) : 0;
  return 10_000 + rankScore;
}

function scoreCoinSearchCandidate(coin, input) {
  const symbol = normalizeSymbol(input);
  const lookup = normalizeLookup(input);
  const candidateSymbol = coin.symbol?.toUpperCase();
  const candidateName = normalizeLookup(coin.name);
  const candidateId = normalizeLookup(coin.id).replace(/-/g, " ");
  const rank = Number(coin.market_cap_rank);
  const rankScore = Number.isFinite(rank) ? Math.max(0, 1000 - rank) : 0;

  if (candidateName === lookup) return 30_000 + rankScore;
  if (candidateId === lookup) return 25_000 + rankScore;
  if (candidateSymbol === symbol) return 20_000 + rankScore;
  if (!isShortAmbiguousSymbol(symbol) && candidateName.includes(lookup)) return 5_000 + rankScore;
  return -1;
}

function isLikelyContractAddress(value) {
  const text = String(value || "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(text) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);
}

function scoreDexPair(pair, input) {
  const baseToken = pair.baseToken || {};
  const inputSymbol = normalizeSymbol(input);
  const lookup = normalizeLookup(input);
  const baseSymbol = normalizeSymbol(baseToken.symbol);
  const baseName = normalizeLookup(baseToken.name);
  const baseAddress = normalizeLookup(baseToken.address);
  const liquidityUsd = Number(pair.liquidity?.usd || 0);
  const volume24h = Number(pair.volume?.h24 || 0);
  const activityScore = Math.log10(Math.max(1, liquidityUsd + volume24h));

  if (isLikelyContractAddress(input) && baseAddress === lookup) return 50_000 + activityScore;
  if (baseName === lookup) return 30_000 + activityScore;
  if (baseSymbol === inputSymbol) return 20_000 + activityScore;
  if (!isShortAmbiguousSymbol(inputSymbol) && baseName.includes(lookup)) return 5_000 + activityScore;
  return -1;
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

async function getCoinGeckoProfile(input) {
  const inputSymbol = normalizeSymbol(input);
  const searchUrl = `${SOURCES.coingeckoSearch}?query=${encodeURIComponent(input)}`;
  const search = await fetchJson(searchUrl);
  const candidates = search.coins || [];
  const matches = candidates
    .map((coin) => ({ coin, score: scoreCoinSearchCandidate(coin, input) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.coin);

  // Very short symbols such as ID, IO, RE, OG are easy to confuse with words or
  // unrelated coin ids. Full-name matches are allowed, but we avoid blind fallbacks.
  const candidate = matches[0] || (isShortAmbiguousSymbol(inputSymbol) ? null : candidates[0]);

  if (!candidate?.id) {
    return { symbol: inputSymbol, candidate: null, detail: null };
  }

  const detailUrl = `${SOURCES.coingeckoCoins}/${encodeURIComponent(candidate.id)}?localization=false&tickers=false&market_data=true&community_data=true&developer_data=true&sparkline=false`;
  const detail = await fetchJson(detailUrl);
  return { symbol: normalizeSymbol(detail.symbol || candidate.symbol || inputSymbol), candidate, detail };
}

async function getDexScreenerProfile(input) {
  const searchUrl = `${SOURCES.dexscreenerSearch}?q=${encodeURIComponent(input)}`;
  const search = await fetchJson(searchUrl);
  const pairs = Array.isArray(search.pairs) ? search.pairs : [];
  const matches = pairs
    .map((pair) => ({ pair, score: scoreDexPair(pair, input) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score);

  const pair = matches[0]?.pair || null;
  return {
    symbol: normalizeSymbol(pair?.baseToken?.symbol || input),
    pair
  };
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

async function getBitgetMarket(symbol) {
  const pairs = [`${symbol}USDT`, `${symbol}USDC`, `${symbol}BTC`];
  const attempts = [];

  for (const pair of pairs) {
    try {
      const tickerData = await fetchJson(`${SOURCES.bitgetSpotTicker}?symbol=${pair}`);
      const ticker = Array.isArray(tickerData.data) ? tickerData.data[0] : null;
      if (!ticker?.symbol) throw new Error(`No Bitget ticker for ${pair}`);

      const candleData = await fetchJson(`${SOURCES.bitgetSpotCandles}?symbol=${pair}&granularity=1day&limit=30`);
      const rows = Array.isArray(candleData.data) ? candleData.data : [];
      return {
        exchange: "bitget",
        pair,
        ticker,
        dailyCandles: rows.map((row) => ({
          openTime: new Date(Number(row[0])).toISOString(),
          open: row[1],
          high: row[2],
          low: row[3],
          close: row[4],
          volume: row[5],
          quoteVolume: row[6]
        }))
      };
    } catch (error) {
      attempts.push({ pair, error: error.message });
    }
  }

  return { exchange: "bitget", pair: null, ticker: null, dailyCandles: [], attempts };
}

async function getMarket(symbol, exchange) {
  const normalizedExchange = String(exchange || "").toLowerCase();
  if (normalizedExchange === "bitget") return getBitgetMarket(symbol);
  return getBinanceMarket(symbol);
}

function newsKey(item) {
  return slug(`${item.title}-${item.source}`) || item.link;
}

function hasTokenSignal(item, symbol, coinName) {
  const text = `${item.title} ${item.snippet} ${item.source}`.toLowerCase();
  const symbolRe = new RegExp(`(^|[^a-z0-9])\\$?${symbol.toLowerCase()}([^a-z0-9]|$)`);
  if (symbolRe.test(text)) return true;
  if (coinName && text.includes(String(coinName).toLowerCase())) return true;
  return false;
}

async function getNews(symbol, coinName, exchange) {
  const name = coinName || "";
  const exchangeName = exchange && exchange !== "other" ? exchange : "";
  const queries = [
    `"${symbol}" ${name} crypto token price news`,
    `"${symbol}" ${name} crypto listing partnership mainnet`,
    `"${symbol}" ${name} crypto airdrop funding ecosystem`,
    exchangeName ? `"${symbol}" ${name} ${exchangeName} crypto` : "",
    `"${symbol}" ${name} site:bitget.com/news`,
    `"${symbol}" ${name} site:binance.com/en/support/announcement`,
    `"${symbol}" ${name} site:coindesk.com OR site:theblock.co OR site:decrypt.co`
  ].filter(Boolean);

  const settled = await Promise.allSettled(queries.map(async (query) => {
    const url = `${SOURCES.googleNewsRss}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const xml = await fetchText(url);
    return extractRssItems(xml, 8);
  }));

  const items = [];
  const seen = new Set();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const item of result.value) {
      const key = newsKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }

  return items
    .filter((item) => hasTokenSignal(item, symbol, coinName))
    .slice(0, 16);
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

function compactBitget(market) {
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
    lastPrice: Number(market.ticker.lastPr),
    priceChange24hPct: Number(market.ticker.change24h ?? market.ticker.changeUtc24h) * 100,
    highPrice24h: Number(market.ticker.high24h),
    lowPrice24h: Number(market.ticker.low24h),
    volumeBase24h: Number(market.ticker.baseVolume),
    volumeQuote24h: Number(market.ticker.quoteVolume),
    thirtyDayChangePct,
    dailyCandles: candles.slice(-14)
  };
}

function compactDexScreener(pair) {
  if (!pair?.baseToken) return null;

  const websites = Array.isArray(pair.info?.websites)
    ? pair.info.websites.map((item) => item.url).filter(Boolean).slice(0, 3)
    : [];
  const socials = Array.isArray(pair.info?.socials)
    ? pair.info.socials.map((item) => `${item.type}: ${item.url}`).filter(Boolean).slice(0, 5)
    : [];

  return {
    id: pair.baseToken.address || pair.pairAddress,
    symbol: normalizeSymbol(pair.baseToken.symbol),
    name: pair.baseToken.name || pair.baseToken.symbol,
    categories: [pair.chainId, pair.dexId].filter(Boolean),
    homepage: websites,
    description: [
      `DexScreener pair on ${pair.chainId || "unknown chain"} / ${pair.dexId || "unknown DEX"}.`,
      pair.url ? `Pair URL: ${pair.url}` : "",
      socials.length ? `Socials: ${socials.join("; ")}` : ""
    ].filter(Boolean).join(" "),
    marketCapRank: null,
    currentPriceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
    marketCapUsd: pair.marketCap ?? null,
    fullyDilutedValuationUsd: pair.fdv ?? null,
    totalVolumeUsd: pair.volume?.h24 ?? null,
    priceChange24hPct: pair.priceChange?.h24 ?? null,
    priceChange7dPct: null,
    priceChange14dPct: null,
    priceChange30dPct: null,
    athUsd: null,
    athChangePct: null,
    circulatingSupply: null,
    totalSupply: null,
    maxSupply: null,
    sentimentVotesUpPct: null,
    watchlistUsers: null,
    genesisDate: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString().slice(0, 10) : null,
    chainId: pair.chainId,
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    baseTokenAddress: pair.baseToken.address,
    quoteToken: pair.quoteToken,
    liquidityUsd: pair.liquidity?.usd ?? null,
    pairUrl: pair.url,
    source: "dexscreener"
  };
}

function compactDexMarket(pair) {
  if (!pair?.baseToken) return null;

  return {
    exchange: pair.dexId || "dex",
    pair: `${pair.baseToken.symbol || "TOKEN"}/${pair.quoteToken?.symbol || "QUOTE"}`,
    chainId: pair.chainId,
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    pairUrl: pair.url,
    lastPrice: pair.priceUsd ? Number(pair.priceUsd) : null,
    priceChange24hPct: pair.priceChange?.h24 ?? null,
    highPrice24h: null,
    lowPrice24h: null,
    volumeBase24h: null,
    volumeQuote24h: pair.volume?.h24 ?? null,
    liquidityUsd: pair.liquidity?.usd ?? null,
    fullyDilutedValuationUsd: pair.fdv ?? null,
    marketCapUsd: pair.marketCap ?? null,
    thirtyDayChangePct: null,
    dailyCandles: []
  };
}

function compactMarket(market) {
  if (market?.exchange === "bitget") return compactBitget(market);
  return compactBinance(market);
}

function normalizeAnalysis(analysis, symbol, profile, errors) {
  if (!analysis || typeof analysis !== "object") return analysis;

  const returnedToken = normalizeSymbol(analysis.token);
  if (returnedToken && returnedToken !== symbol) {
    errors.push(`AI returned mismatched token ${returnedToken}; forced back to ${symbol}.`);
  }

  return {
    ...analysis,
    token: symbol,
    name: profile?.name || analysis.name || symbol
  };
}

function buildPrompt({ symbol, exchange, profile, market, news }) {
  return [
    {
      role: "system",
      content: [
        "You are a crypto token research analyst covering both on-chain DEX markets and centralized exchanges.",
        "Use the supplied public data only. Do not invent facts.",
        "Return strict JSON only, with no markdown fences.",
        "This is research, not financial advice.",
        "For buy calls, be conservative and explicitly weigh liquidity, news freshness, valuation, unlock/supply, contract/DEX risk, and momentum risk.",
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

async function writeResultFiles(symbol, result) {
  const latestName = `${symbol}-latest.json`;
  const timestampName = `${symbol}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const latestPath = path.join(RESULTS_DIR, latestName);
  const timestampPath = path.join(RESULTS_DIR, timestampName);

  const json = JSON.stringify(result, null, 2);
  await fs.writeFile(latestPath, `${json}\n`);
  await fs.writeFile(timestampPath, `${json}\n`);
}

async function updateIndex(results) {
  const index = await readIndex();
  const resultList = Array.isArray(results) ? results : [results];
  const nextItems = resultList.map((result) => ({
    token: result.token,
    requestedInput: result.requestedInput,
    name: result.analysis?.name || result.profile?.name || result.token,
    score: result.analysis?.rating?.score ?? null,
    label: result.analysis?.rating?.label || "未知",
    action: result.analysis?.recommendation?.action || "未知",
    generatedAt: result.generatedAt,
    latestPath: `data/results/${result.token}-latest.json`
  }));
  const currentTokens = new Set(nextItems.map((item) => item.token));
  const withoutCurrent = (index.results || []).filter((item) => !currentTokens.has(item.token));

  const next = {
    updatedAt: nowIso(),
    results: [...nextItems, ...withoutCurrent].slice(0, 100)
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

async function analyzeOne(input, exchange) {
  const requestedInput = String(input || "").trim();

  const errors = [];
  const [profileResult, dexResult] = await Promise.allSettled([
    getCoinGeckoProfile(requestedInput),
    getDexScreenerProfile(requestedInput)
  ]);

  if (profileResult.status === "rejected") errors.push(`CoinGecko: ${profileResult.reason.message}`);
  if (dexResult.status === "rejected") errors.push(`DexScreener: ${dexResult.reason.message}`);

  const coingeckoProfile = compactCoinGecko(profileResult.value?.detail);
  const dexProfile = compactDexScreener(dexResult.value?.pair);
  const symbol = coingeckoProfile?.symbol || dexProfile?.symbol || profileResult.value?.symbol || dexResult.value?.symbol || normalizeSymbol(requestedInput);
  await writeRequest(symbol, exchange);

  const marketResult = await Promise.resolve(getMarket(symbol, exchange))
    .then((value) => ({ status: "fulfilled", value }))
    .catch((reason) => ({ status: "rejected", reason }));

  if (marketResult.status === "rejected") errors.push(`${exchange}: ${marketResult.reason.message}`);

  if (profileResult.value?.candidate && coingeckoProfile?.symbol !== symbol) {
    errors.push(`CoinGecko returned ${coingeckoProfile.symbol} for ${symbol}; profile ignored to avoid token mix-up.`);
  }
  if (dexProfile?.symbol && dexProfile.symbol !== symbol) {
    errors.push(`DexScreener returned ${dexProfile.symbol} for ${symbol}; DEX profile ignored to avoid token mix-up.`);
  }
  const safeProfile = coingeckoProfile?.symbol === symbol ? coingeckoProfile : (dexProfile?.symbol === symbol ? dexProfile : null);
  const cexMarket = compactMarket(marketResult.value);
  const dexMarket = dexResult.value?.pair ? compactDexMarket(dexResult.value.pair) : null;
  const market = cexMarket?.pair ? cexMarket : (dexMarket || cexMarket);

  let news = [];
  try {
    news = await getNews(symbol, safeProfile?.name, exchange);
  } catch (error) {
    errors.push(`Google News RSS: ${error.message}`);
  }

  let analysis;
  let analysisStatus = "deepseek";
  try {
    analysis = await askDeepSeek({ symbol, exchange, profile: safeProfile, market, news });
    analysis = normalizeAnalysis(analysis, symbol, safeProfile, errors);
  } catch (error) {
    analysisStatus = "fallback";
    errors.push(`DeepSeek: ${error.message}`);
    analysis = fallbackAnalysis({ symbol, profile: safeProfile, market, news, error });
  }

  const result = {
    token: symbol,
    requestedInput,
    exchange,
    generatedAt: nowIso(),
    analysisStatus,
    analysis,
    profile: safeProfile,
    market,
    dexPair: dexResult.value?.pair || null,
    news,
    sources: SOURCES,
    errors
  };

  await writeResultFiles(symbol, result);
  console.log(`Wrote analysis for ${symbol} with status ${analysisStatus}.`);
  return result;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker())
  );

  return results;
}

async function main() {
  const tokenInputs = parseTokenInputs(tokenArg);
  const exchange = exchangeArg.trim().toLowerCase();

  if (!tokenInputs.length) {
    throw new Error("Usage: node scripts/analyze-token.mjs \"TOKEN OR TOKEN NAME,TOKEN2\" [exchange]");
  }

  await ensureDirs();

  const concurrency = getBatchConcurrency();
  console.log(`Analyzing ${tokenInputs.length} token(s) with concurrency ${concurrency}: ${tokenInputs.join(", ")}`);
  const results = await mapLimit(tokenInputs, concurrency, (input) => analyzeOne(input, exchange));
  await updateIndex(results);
  console.log(`Updated index for ${results.length} token(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

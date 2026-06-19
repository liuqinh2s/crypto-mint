const OWNER_FALLBACK = "liuqinh2s";
const REPO_FALLBACK = "crypto-mint";
const BRANCH_FALLBACK = "main";
const WORKFLOW_FILE = "analyze-token.yml";
const SITE_BASE = new URL("./", window.location.href);

const form = document.querySelector("#analysis-form");
const tokenInput = document.querySelector("#token-input");
const exchangeInput = document.querySelector("#exchange-input");
const statusCard = document.querySelector("#status-card");
const statusText = document.querySelector("#status-text");
const resultPanel = document.querySelector("#result-panel");
const historyList = document.querySelector("#history-list");
const refreshIndexButton = document.querySelector("#refresh-index");

const ownerInput = document.querySelector("#owner-input");
const repoInput = document.querySelector("#repo-input");
const branchInput = document.querySelector("#branch-input");
const githubTokenInput = document.querySelector("#github-token-input");
const saveSettingsButton = document.querySelector("#save-settings");

const settingsKey = "crypto-mint-settings";
let pollTimer = null;

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(settingsKey)) || {};
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  localStorage.setItem(settingsKey, JSON.stringify(settings));
}

function applySettings() {
  const settings = readSettings();
  ownerInput.value = settings.owner || OWNER_FALLBACK;
  repoInput.value = settings.repo || REPO_FALLBACK;
  branchInput.value = settings.branch || BRANCH_FALLBACK;
  githubTokenInput.value = settings.githubToken || "";
}

function getSettings() {
  return {
    owner: ownerInput.value.trim() || OWNER_FALLBACK,
    repo: repoInput.value.trim() || REPO_FALLBACK,
    branch: branchInput.value.trim() || BRANCH_FALLBACK,
    githubToken: githubTokenInput.value.trim()
  };
}

function setStatus(message, kind = "") {
  statusText.textContent = message;
  statusCard.classList.remove("is-working", "is-ready", "is-error");
  if (kind) statusCard.classList.add(`is-${kind}`);
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function fmtNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "未知";
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

function fmtPct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "未知";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function list(items) {
  const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!safeItems.length) return "<p class=\"small\">暂无数据</p>";
  return `<ul>${safeItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderHistory(index) {
  const rows = Array.isArray(index.results) ? index.results : [];
  if (!rows.length) {
    historyList.innerHTML = "<p class=\"small\">还没有分析结果。</p>";
    return;
  }

  historyList.innerHTML = rows.map((item) => `
    <button class="history-item" type="button" data-path="${escapeHtml(item.latestPath)}">
      <span class="history-top">
        <span>${escapeHtml(item.token)} · ${escapeHtml(item.name || "")}</span>
        <span class="score-pill">${escapeHtml(item.score ?? "-")}</span>
      </span>
      <span class="small">${escapeHtml(item.action || "")} · ${escapeHtml(item.label || "")}</span>
    </button>
  `).join("");
}

function renderResult(result) {
  const analysis = result.analysis || {};
  const rating = analysis.rating || {};
  const recommendation = analysis.recommendation || {};
  const market = result.market || {};
  const profile = result.profile || {};
  const latestNews = Array.isArray(analysis.latestNews) ? analysis.latestNews : [];

  resultPanel.innerHTML = `
    <header class="result-header">
      <div>
        <div class="result-title">
          <h2>${escapeHtml(result.token || analysis.token)}</h2>
          <span class="meta">${escapeHtml(analysis.name || profile.name || "")}</span>
        </div>
        <p class="summary">${escapeHtml(analysis.summary || "暂无总结。")}</p>
        <p class="meta">生成时间：${escapeHtml(result.generatedAt || analysis.generatedAt || "")} · 状态：${escapeHtml(result.analysisStatus || "")}</p>
      </div>
      <div class="rating-box">
        <strong>${escapeHtml(rating.score ?? "-")}</strong>
        <span>${escapeHtml(rating.label || "未评级")} · ${escapeHtml(rating.confidence || "未知置信度")}</span>
      </div>
    </header>

    <section class="decision-grid">
      <div class="metric"><span>动作</span><strong>${escapeHtml(recommendation.action || "未知")}</strong></div>
      <div class="metric"><span>预计空间</span><strong>${recommendation.expectedUpsidePct === null || recommendation.expectedUpsidePct === undefined ? "未知" : `${escapeHtml(recommendation.expectedUpsidePct)}%`}</strong></div>
      <div class="metric"><span>持仓周期</span><strong>${escapeHtml(recommendation.holdingPeriod || "未知")}</strong></div>
      <div class="metric"><span>24h 涨跌</span><strong>${escapeHtml(fmtPct(market.priceChange24hPct ?? profile.priceChange24hPct))}</strong></div>
    </section>

    <section class="content-grid">
      <div class="info-block">
        <h3>上涨逻辑</h3>
        ${list(analysis.catalysts)}
      </div>
      <div class="info-block">
        <h3>买入失效条件</h3>
        <p>${escapeHtml(recommendation.invalidation || "暂无")}</p>
      </div>
      <div class="info-block">
        <h3>基本面</h3>
        ${list(analysis.fundamentals)}
      </div>
      <div class="info-block">
        <h3>行情解读</h3>
        ${list(analysis.marketRead)}
      </div>
      <div class="info-block">
        <h3>风险</h3>
        ${list(analysis.risks)}
      </div>
      <div class="info-block">
        <h3>后续观察</h3>
        ${list(analysis.watchlist)}
      </div>
    </section>

    <section class="info-block">
      <h3>最新消息</h3>
      <div class="news-list">
        ${latestNews.length ? latestNews.map((item, index) => {
          const source = result.news?.[index];
          return `
            <div class="news-card">
              <strong>${escapeHtml(item.title)}</strong>
              <span>${escapeHtml(item.impact || "未知")} · ${escapeHtml(item.reason || "")}</span>
              ${source?.link ? `<p><a class="source-link" href="${escapeHtml(source.link)}" target="_blank" rel="noreferrer">查看来源</a></p>` : ""}
            </div>
          `;
        }).join("") : "<p class=\"small\">暂无新闻数据。</p>"}
      </div>
    </section>

    <section class="decision-grid">
      <div class="metric"><span>交易对</span><strong>${escapeHtml(market.pair || "未知")}</strong></div>
      <div class="metric"><span>现价</span><strong>${escapeHtml(fmtNumber(market.lastPrice ?? profile.currentPriceUsd, 8))}</strong></div>
      <div class="metric"><span>24h 成交额</span><strong>${escapeHtml(fmtNumber(market.volumeQuote24h ?? profile.totalVolumeUsd, 0))}</strong></div>
      <div class="metric"><span>市值排名</span><strong>${escapeHtml(profile.marketCapRank || "未知")}</strong></div>
    </section>
  `;
}

async function loadIndex() {
  const response = await fetch(new URL(`data/search-index.json?t=${Date.now()}`, SITE_BASE), { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取结果索引");
  const index = await response.json();
  renderHistory(index);
  return index;
}

async function loadResult(path) {
  const response = await fetch(new URL(`${path}?t=${Date.now()}`, SITE_BASE), { cache: "no-store" });
  if (!response.ok) throw new Error("结果还没生成");
  const result = await response.json();
  renderResult(result);
  setStatus(`已加载 ${result.token} 的最新分析。`, "ready");
  return result;
}

async function dispatchWorkflow(symbol, exchange) {
  const settings = getSettings();
  if (!settings.githubToken) {
    throw new Error("请先在触发设置里保存 GitHub Token。");
  }

  const url = `https://api.github.com/repos/${settings.owner}/${settings.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${settings.githubToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      ref: settings.branch,
      inputs: { token: symbol, exchange }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`触发失败：${response.status} ${text.slice(0, 160)}`);
  }
}

function startPolling(symbol) {
  const path = `data/results/${symbol}-latest.json`;
  let attempts = 0;
  clearInterval(pollTimer);

  pollTimer = setInterval(async () => {
    attempts += 1;
    try {
      await loadResult(path);
      await loadIndex();
      clearInterval(pollTimer);
    } catch {
      setStatus(`分析已启动，等待结果生成中... ${attempts * 15}s`, "working");
      if (attempts >= 32) {
        clearInterval(pollTimer);
        setStatus("分析仍在运行或提交结果较慢，请稍后刷新。", "working");
      }
    }
  }, 15000);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const symbol = normalizeToken(tokenInput.value);
  const exchange = exchangeInput.value;

  if (!symbol) {
    setStatus("请输入有效的代币符号。", "error");
    return;
  }

  tokenInput.value = symbol;
  setStatus(`正在触发 ${symbol} 分析...`, "working");

  try {
    await dispatchWorkflow(symbol, exchange);
    setStatus(`${symbol} 分析已启动，通常需要 1-3 分钟。`, "working");
    startPolling(symbol);
  } catch (error) {
    setStatus(error.message, "error");
  }
});

saveSettingsButton.addEventListener("click", () => {
  writeSettings(getSettings());
  setStatus("设置已保存在本机浏览器。", "ready");
});

refreshIndexButton.addEventListener("click", async () => {
  try {
    await loadIndex();
    setStatus("最近结果已刷新。", "ready");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

historyList.addEventListener("click", async (event) => {
  const item = event.target.closest("[data-path]");
  if (!item) return;

  try {
    setStatus("正在加载结果...", "working");
    await loadResult(item.dataset.path);
  } catch (error) {
    setStatus(error.message, "error");
  }
});

applySettings();
loadIndex().catch(() => {
  renderHistory({ results: [] });
});

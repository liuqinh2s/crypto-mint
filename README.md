# Crypto Mint

Crypto Mint is a static GitHub Pages app that analyzes the news and market narrative behind a listed crypto token.

It supports two self-hosted input paths:

- Web UI: enter a token symbol and trigger GitHub Actions from the page.
- API: call GitHub's workflow dispatch endpoint directly.

The GitHub Action searches public data sources, sends the collected context to DeepSeek, and writes public JSON results under `data/results/`.

## Setup

1. Enable GitHub Pages for this repository and set the source to `GitHub Actions`.
2. Add a repository secret named `DEEPSEEK_API_KEY`.
3. In Actions settings, allow workflows to read and write repository contents.
4. For web UI triggering, create a fine-grained GitHub token for this repo with `Actions: Read and write` permission. Paste it into the page settings. It is stored only in your browser local storage.
5. Open the site, expand trigger settings, confirm owner/repo/branch, save the token, then enter a token symbol such as `SYN`.

## Self-Use API

Replace the owner, repo, and token values:

```bash
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_GITHUB_TOKEN" \
  https://api.github.com/repos/OWNER/REPO/actions/workflows/analyze-token.yml/dispatches \
  -d '{"ref":"main","inputs":{"token":"SYN","exchange":"binance"}}'
```

Results are published to:

```text
data/results/SYN-latest.json
```

and listed in:

```text
data/search-index.json
```

## Notes

This project produces research and risk analysis, not financial advice. Crypto prices move quickly and public sources can be incomplete, delayed, or wrong.

# AG IT Project Portfolio Dashboard

Live dashboard pulling data from Azure DevOps. Auto-deploys to GitHub Pages via GitHub Actions (artifact deploy — built HTML is **not** committed to `main`).

**Live:** https://agwork-co.github.io/ag-it-dashboard/

## Setup

### 1. Repository Secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|--------|-------|
| `AZURE_DEVOPS_PAT` | Your Azure DevOps Personal Access Token (needs Work Items read scope) |
| `AZURE_DEVOPS_ORG_URL` | `https://dev.azure.com/AssembliesOfGod` |
| `REFRESH_WORKER_URL` | Cloudflare Worker URL for the in-page Refresh button (optional) |

### 2. Enable GitHub Pages (one-time)

Go to **Settings → Pages** and set:
- **Source**: **GitHub Actions** (not "Deploy from a branch")

After the first successful `Build & Deploy Dashboard` run, the site is live at:
`https://agwork-co.github.io/ag-it-dashboard/`

### 3. Manual Refresh

Click **Actions → Build & Deploy Dashboard → Run workflow** to trigger an immediate refresh.
The in-page **Refresh Data** button does the same via the Cloudflare worker.

## Schedule

The dashboard auto-refreshes 3× daily on weekdays (UTC cron `0 13,17,21 * * 1-5`):
- ~7:00 AM CST / 8:00 AM CDT
- ~11:00 AM CST / 12:00 PM CDT
- ~3:00 PM CST / 4:00 PM CDT

## How deploy works

1. Actions runs `npm run build` (Node `build.js` → `docs/index.html`).
2. Sprint/burndown JSON under `cache/` is restored/saved with `actions/cache` between runs (not committed).
3. `docs/` is uploaded as a Pages artifact and published with `actions/deploy-pages`.
4. Source of truth on `main` is `build.js`, `template.html`, `refresh-worker/`, and docs — **not** the generated HTML.

## Local Development

```bash
export AZURE_DEVOPS_PAT=your_pat_here
export AZURE_DEVOPS_ORG_URL=https://dev.azure.com/AssembliesOfGod
npm install
npm run build
open docs/index.html
```

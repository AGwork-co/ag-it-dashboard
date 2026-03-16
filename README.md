# AG IT Project Portfolio Dashboard

Live dashboard pulling data from Azure DevOps. Auto-deploys to GitHub Pages via GitHub Actions.

## Setup

### 1. Repository Secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|--------|-------|
| `AZURE_DEVOPS_PAT` | Your Azure DevOps Personal Access Token (needs Work Items read scope) |
| `AZURE_DEVOPS_ORG_URL` | `https://dev.azure.com/AssembliesOfGod` |

### 2. Enable GitHub Pages

Go to **Settings → Pages** and set:
- **Source**: Deploy from a branch
- **Branch**: `main`
- **Folder**: `/docs`

### 3. Manual Refresh

Click **Actions → Build & Deploy Dashboard → Run workflow** to trigger an immediate refresh.

## Schedule

The dashboard auto-refreshes 3× daily on weekdays:
- 7:00 AM CST
- 11:00 AM CST
- 3:00 PM CST

## Local Development

```bash
export AZURE_DEVOPS_PAT=your_pat_here
export AZURE_DEVOPS_ORG_URL=https://dev.azure.com/AssembliesOfGod
npm install
npm run build
open docs/index.html
```

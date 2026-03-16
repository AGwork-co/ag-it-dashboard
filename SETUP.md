# Quick Setup Guide

## Step 1: Create the GitHub Repo

Already done! This repo is live at https://github.com/AGwork-co/ag-it-dashboard

## Step 2: Add Secrets

Go to: https://github.com/AGwork-co/ag-it-dashboard/settings/secrets/actions

Add these two repository secrets:

| Secret Name              | Value                                       |
|--------------------------|---------------------------------------------|
| `AZURE_DEVOPS_PAT`      | Your Azure DevOps Personal Access Token      |
| `AZURE_DEVOPS_ORG_URL`  | `https://dev.azure.com/AssembliesOfGod`      |

**PAT Requirements**: Needs at minimum **Work Items (Read)** scope.

## Step 3: Enable GitHub Pages

Go to: https://github.com/AGwork-co/ag-it-dashboard/settings/pages

- **Source**: Deploy from a branch
- **Branch**: `main`
- **Folder**: `/docs`

Click **Save**.

## Step 4: Trigger First Build

Go to: https://github.com/AGwork-co/ag-it-dashboard/actions

Click **Build & Deploy Dashboard** → **Run workflow** → **Run workflow**

Wait ~2 minutes for it to complete. Your dashboard will be live at:
`https://agwork-co.github.io/ag-it-dashboard/`

## Auto-Refresh Schedule

The dashboard rebuilds automatically 3× per weekday:
- 7:00 AM CST
- 11:00 AM CST
- 3:00 PM CST

You can also trigger a manual refresh anytime from the Actions tab.

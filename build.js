#!/usr/bin/env node
/**
 * AG IT Project Portfolio Dashboard — Build Script
 *
 * Queries Azure DevOps REST API for live project data,
 * then generates a self-contained HTML dashboard.
 *
 * Required env vars:
 *   AZURE_DEVOPS_PAT          — Personal Access Token
 *   AZURE_DEVOPS_ORG_URL      — e.g. https://dev.azure.com/AssembliesOfGod
 *
 * Usage:
 *   node build.js
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const ORG_URL = process.env.AZURE_DEVOPS_ORG_URL || 'https://dev.azure.com/AssembliesOfGod';
const PAT = process.env.AZURE_DEVOPS_PAT;
const API_VERSION = '7.1';

if (!PAT) {
  console.error('ERROR: AZURE_DEVOPS_PAT environment variable is required.');
  process.exit(1);
}

const AUTH_HEADER = 'Basic ' + Buffer.from(':' + PAT).toString('base64');

// ── Project definitions (maps DevOps project names to dashboard config) ─────
const PROJECT_CONFIGS = [
  { priority: 1,  devopsProject: 'CRM',                   shortName: 'CRM',             displayName: 'CRM (Salesforce)' },
  { priority: 2,  devopsProject: 'GPH',                   shortName: 'GPH',             displayName: 'GPH (Gospel Publishing House)' },
  { priority: 3,  devopsProject: 'CMS vNext',             shortName: 'CMS',             displayName: 'CMS vNext' },
  { priority: 4,  devopsProject: 'Bible Engagement Project', shortName: 'BEP',          displayName: 'Bible Engagement Project' },
  { priority: 5,  devopsProject: 'Fine Arts',             shortName: 'Fine Arts',        displayName: 'Fine Arts' },
  { priority: 6,  devopsProject: 'Chi Alpha',             shortName: 'Chi Alpha',        displayName: 'Chi Alpha' },
  { priority: 7,  devopsProject: 'AG.Giving',             shortName: 'AG.Giving',        displayName: 'AG.Giving' },
  { priority: 8,  devopsProject: 'AGWM Mobilization',     shortName: 'Mobilization',     displayName: 'AGWM Mobilization' },
  { priority: 9,  devopsProject: 'AGWM Apps',             shortName: 'AGWM Apps',        displayName: 'AGWM Apps' },
  { priority: 10, devopsProject: 'AGWM Financial Reporting', shortName: 'Financial',     displayName: 'AGWM Financial Reporting' },
  { priority: 11, devopsProject: 'AG Missions Common',    shortName: 'Missions Common',  displayName: 'AG Missions Common' },
  { priority: 12, devopsProject: 'Infrastructure',        shortName: 'Infra',            displayName: 'Infrastructure' },
];

// ── Azure DevOps API helpers ────────────────────────────────────────────────

async function adoFetch(url) {
  const resp = await fetch(url, {
    headers: { 'Authorization': AUTH_HEADER, 'Content-Type': 'application/json' }
  });
  if (!resp.ok) {
    console.warn(`  ⚠ API ${resp.status} for ${url}`);
    return null;
  }
  return resp.json();
}

/** Run a WIQL query against a specific project */
async function wiqlQuery(project, query) {
  const url = `${ORG_URL}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=${API_VERSION}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': AUTH_HEADER, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  if (!resp.ok) {
    console.warn(`  ⚠ WIQL ${resp.status} for ${project}`);
    return [];
  }
  const data = await resp.json();
  return data.workItems || [];
}

/** Fetch work item details in batches of 200 */
async function getWorkItemDetails(ids, fields) {
  if (!ids.length) return [];
  const results = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const url = `${ORG_URL}/_apis/wit/workitems?ids=${batch.join(',')}&fields=${fields.join(',')}&api-version=${API_VERSION}`;
    const data = await adoFetch(url);
    if (data && data.value) results.push(...data.value);
  }
  return results;
}

// ── Data collection ─────────────────────────────────────────────────────────

async function fetchProjectData(config) {
  const project = config.devopsProject;
  console.log(`📦 Fetching: ${project}...`);

  // 1. Get all Epics
  const epicRefs = await wiqlQuery(project,
    `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Epic' AND [System.TeamProject] = '${project}' ORDER BY [System.Id]`
  );
  const epicIds = epicRefs.map(w => w.id);

  const epics = await getWorkItemDetails(epicIds, [
    'System.Id', 'System.Title', 'System.State', 'System.Description',
    'Microsoft.VSTS.Common.Priority'
  ]);

  // 2. Get Features count per epic
  const featureRefs = await wiqlQuery(project,
    `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Feature' AND [System.TeamProject] = '${project}' ORDER BY [System.Id]`
  );
  const featureIds = featureRefs.map(w => w.id);

  let features = [];
  if (featureIds.length) {
    features = await getWorkItemDetails(featureIds, [
      'System.Id', 'System.State', 'System.Parent'
    ]);
  }

  // 3. Get User Stories with story points
  const storyRefs = await wiqlQuery(project,
    `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'User Story' AND [System.TeamProject] = '${project}' ORDER BY [System.Id]`
  );
  const storyIds = storyRefs.map(w => w.id);

  let stories = [];
  if (storyIds.length) {
    stories = await getWorkItemDetails(storyIds, [
      'System.Id', 'System.State', 'System.Parent',
      'Microsoft.VSTS.Scheduling.StoryPoints',
      'System.IterationPath'
    ]);
  }

  // 4. Build epic summaries
  const epicSummaries = epics.map(e => {
    const eid = e.id;
    const f = e.fields;
    const childFeatures = features.filter(ft => ft.fields['System.Parent'] === eid);
    // Stories that are children of this epic's features
    const featureIdsForEpic = childFeatures.map(ft => ft.id);
    const childStories = stories.filter(s => featureIdsForEpic.includes(s.fields['System.Parent']));

    return {
      id: eid,
      title: f['System.Title'],
      state: f['System.State'],
      features: childFeatures.length,
      stories: childStories.length
    };
  });

  // 5. Estimation data
  const estimated = stories.filter(s => s.fields['Microsoft.VSTS.Scheduling.StoryPoints'] != null);
  const totalSP = stories.reduce((sum, s) => sum + (s.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || 0), 0);
  const incompleteSP = stories
    .filter(s => s.fields['System.State'] !== 'Closed' && s.fields['System.State'] !== 'Resolved')
    .reduce((sum, s) => sum + (s.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || 0), 0);

  // 6. Sprint distribution (group by iteration)
  const sprintSP = {};
  stories.forEach(s => {
    const iter = s.fields['System.IterationPath'] || 'Unassigned';
    const sp = s.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || 0;
    // Extract the last part of iteration path as sprint name
    const parts = iter.split('\\');
    const sprintName = parts[parts.length - 1] || 'Unassigned';
    if (sp > 0) {
      sprintSP[sprintName] = (sprintSP[sprintName] || 0) + sp;
    }
  });

  // 7. Determine phase from epic states
  const states = epicSummaries.map(e => e.state);
  let phase = 'New';
  if (states.includes('Active') || states.includes('In Progress')) phase = 'Active';
  if (states.every(s => s === 'Closed' || s === 'Resolved')) phase = 'Completed';

  return {
    priority: config.priority,
    name: config.displayName,
    shortName: config.shortName,
    phase,
    epics: epicSummaries,
    estimation: {
      total: stories.length,
      estimated: estimated.length,
      unestimated: stories.length - estimated.length,
      totalSP: Math.round(totalSP * 100) / 100,
      incompleteSP: Math.round(incompleteSP * 100) / 100,
      sprintSP
    }
  };
}

// ── HTML generation ─────────────────────────────────────────────────────────

function generateHTML(projectsData, buildTime) {
  const template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');

  // Inject live data
  const html = template
    .replace('/*__PROJECT_DATA__*/', JSON.stringify(projectsData, null, 2))
    .replace('__BUILD_TIME__', buildTime);

  return html;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 AG IT Dashboard — Build starting...');
  console.log(`   Org: ${ORG_URL}`);
  console.log(`   Projects: ${PROJECT_CONFIGS.length}\n`);

  const projectsData = [];

  for (const config of PROJECT_CONFIGS) {
    try {
      const data = await fetchProjectData(config);
      projectsData.push(data);
      const epicCount = data.epics.length;
      const storyCount = data.estimation.total;
      console.log(`   ✅ ${config.shortName}: ${epicCount} epics, ${storyCount} stories, ${data.estimation.incompleteSP} SP backlog`);
    } catch (err) {
      console.error(`   ❌ ${config.shortName}: ${err.message}`);
      // Push a skeleton so the dashboard still renders
      projectsData.push({
        priority: config.priority,
        name: config.displayName,
        shortName: config.shortName,
        phase: 'Error',
        epics: [],
        estimation: { total: 0, estimated: 0, unestimated: 0, totalSP: 0, incompleteSP: 0, sprintSP: {} }
      });
    }
  }

  const buildTime = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });

  const html = generateHTML(projectsData, buildTime);

  // Write to docs/ for GitHub Pages
  const outDir = path.join(__dirname, 'docs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), html);

  console.log(`\n✨ Dashboard built → docs/index.html`);
  console.log(`   Build time: ${buildTime}`);
  console.log(`   Total projects: ${projectsData.length}`);
  console.log(`   Total epics: ${projectsData.reduce((s, p) => s + p.epics.length, 0)}`);
  console.log(`   Total stories: ${projectsData.reduce((s, p) => s + p.estimation.total, 0)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

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

// ── Sprint / Iteration helpers ──────────────────────────────────────────────

/** Get the current iteration for a project's default team */
async function getCurrentIteration(project) {
  const url = `${ORG_URL}/${encodeURIComponent(project)}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=${API_VERSION}`;
  const data = await adoFetch(url);
  if (data && data.value && data.value.length > 0) return data.value[0];
  return null;
}

/** Get team capacity for a specific iteration */
async function getIterationCapacity(project, iterationId) {
  const url = `${ORG_URL}/${encodeURIComponent(project)}/_apis/work/teamsettings/iterations/${iterationId}/capacities?api-version=${API_VERSION}`;
  const data = await adoFetch(url);
  if (data && data.value) return data.value;
  return [];
}

/** Get work item updates (revision history) for burndown calculation */
async function getWorkItemUpdates(workItemId) {
  const url = `${ORG_URL}/_apis/wit/workitems/${workItemId}/updates?api-version=${API_VERSION}`;
  const data = await adoFetch(url);
  if (data && data.value) return data.value;
  return [];
}

const DONE_STATES = ['Closed', 'Resolved', 'Done', 'Removed'];

/** Strip HTML tags to get plain text */
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

/** Generate a short sprint goals summary from story titles and descriptions */
function generateSprintGoals(sprintStories) {
  if (!sprintStories.length) return '';

  // Group stories by theme (use title keywords) and collect summaries
  const goals = [];
  const seen = new Set();

  for (const story of sprintStories) {
    const title = story.title || '';
    const desc = stripHtml(story.description || '');
    const acceptance = stripHtml(story.acceptanceCriteria || '');

    // Build a concise goal line from title + first meaningful sentence of description
    let goal = title;
    if (desc && desc.length > 10) {
      // Take first sentence of description (up to 150 chars)
      const firstSentence = desc.split(/[.!?\n]/).filter(s => s.trim().length > 10)[0];
      if (firstSentence && !title.toLowerCase().includes(firstSentence.trim().toLowerCase().slice(0, 20))) {
        goal += ' — ' + firstSentence.trim().slice(0, 150);
      }
    }

    // Deduplicate similar goals
    const key = title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
    if (!seen.has(key)) {
      seen.add(key);
      goals.push(goal);
    }
  }

  return goals.join('\n');
}

/** Build burndown data from story completion dates within a sprint */
function buildBurndown(sprintStories, startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cutoff = end < today ? end : today;

  const totalSP = sprintStories.reduce((s, st) => s + (st.storyPoints || 0), 0);

  // Build a map of date -> SP completed on that date
  const completedByDate = {};
  sprintStories.forEach(st => {
    if (st.completedDate && st.storyPoints) {
      const d = st.completedDate.split('T')[0];
      completedByDate[d] = (completedByDate[d] || 0) + st.storyPoints;
    }
  });

  // Generate daily burndown points
  const points = [];
  let remaining = totalSP;
  const numDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

  for (let i = 0; i < numDays; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const dayOfWeek = d.getDay();

    // Skip weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    remaining -= (completedByDate[dateStr] || 0);

    // Only include data up to today
    if (d <= cutoff) {
      points.push({ date: dateStr, remaining: Math.max(0, remaining) });
    }
  }

  // Calculate ideal burndown (working days only)
  const workingDays = points.length > 0 ? (() => {
    let count = 0;
    for (let i = 0; i < numDays; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      if (d.getDay() !== 0 && d.getDay() !== 6) count++;
    }
    return count;
  })() : 1;

  const ideal = [];
  let wd = 0;
  for (let i = 0; i < numDays; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    ideal.push({ date: dateStr, remaining: Math.max(0, totalSP - (totalSP / (workingDays - 1)) * wd) });
    wd++;
  }

  return { totalSP, points, ideal };
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

  // 3. Get User Stories with story points + assigned to
  const storyRefs = await wiqlQuery(project,
    `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'User Story' AND [System.TeamProject] = '${project}' ORDER BY [System.Id]`
  );
  const storyIds = storyRefs.map(w => w.id);

  let stories = [];
  if (storyIds.length) {
    stories = await getWorkItemDetails(storyIds, [
      'System.Id', 'System.Title', 'System.State', 'System.Parent',
      'Microsoft.VSTS.Scheduling.StoryPoints',
      'System.IterationPath',
      'System.AssignedTo',
      'System.Description',
      'Microsoft.VSTS.Common.AcceptanceCriteria'
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
    .filter(s => !['Closed', 'Resolved', 'Done', 'Removed'].includes(s.fields['System.State']))
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
  if (states.every(s => ['Closed', 'Resolved', 'Done'].includes(s))) phase = 'Completed';

  // 8. Current sprint data
  let currentSprint = null;
  try {
    const iteration = await getCurrentIteration(project);
    if (iteration) {
      const iterPath = iteration.path || '';
      const sprintName = iteration.name || 'Unknown Sprint';
      const startDate = iteration.attributes?.startDate || null;
      const endDate = iteration.attributes?.finishDate || null;

      // Get stories in this sprint
      const sprintStories = stories.filter(s => {
        const sIter = s.fields['System.IterationPath'] || '';
        return sIter === iterPath || sIter.endsWith('\\' + sprintName);
      });

      // Build story details with assigned-to info
      const sprintStoryDetails = sprintStories.map(s => {
        const f = s.fields;
        const assignedTo = f['System.AssignedTo'];
        const state = f['System.State'];
        const sp = f['Microsoft.VSTS.Scheduling.StoryPoints'] || 0;
        const isDone = DONE_STATES.includes(state);
        return {
          id: s.id,
          title: f['System.Title'],
          description: f['System.Description'] || '',
          acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
          state,
          storyPoints: sp,
          completedSP: isDone ? sp : 0,
          remainingSP: isDone ? 0 : sp,
          assignedTo: assignedTo ? (assignedTo.displayName || assignedTo) : 'Unassigned',
          completedDate: null, // will be populated below
          url: `${ORG_URL}/${encodeURIComponent(project)}/_workitems/edit/${s.id}`
        };
      });

      // Fetch completion dates for done stories (for burndown)
      const doneStories = sprintStoryDetails.filter(s => DONE_STATES.includes(s.state));
      for (const story of doneStories) {
        try {
          const updates = await getWorkItemUpdates(story.id);
          // Find the update where state changed to a done state
          for (let u = updates.length - 1; u >= 0; u--) {
            const stateChange = updates[u]?.fields?.['System.State'];
            if (stateChange && DONE_STATES.includes(stateChange.newValue)) {
              story.completedDate = updates[u].revisedDate || updates[u].fields?.['System.ChangedDate']?.newValue;
              break;
            }
          }
        } catch (e) {
          // Skip if we can't get updates for this item
        }
      }

      const sprintTotalSP = sprintStoryDetails.reduce((s, st) => s + st.storyPoints, 0);
      const sprintCompletedSP = sprintStoryDetails.reduce((s, st) => s + st.completedSP, 0);
      const sprintRemainingSP = sprintTotalSP - sprintCompletedSP;

      // Get team capacity
      let capacityHoursPerDay = 0;
      let members = [];
      try {
        const capacities = await getIterationCapacity(project, iteration.id);
        capacities.forEach(c => {
          const name = c.teamMember?.displayName || 'Unknown';
          const dailyHours = (c.activities || []).reduce((sum, a) => sum + (a.capacityPerDay || 0), 0);
          const daysOff = (c.daysOff || []).length;
          members.push({ name, dailyHours, daysOff });
          capacityHoursPerDay += dailyHours;
        });
      } catch (e) {
        // Capacity data may not be available for all projects
      }

      // Build burndown
      const burndown = (startDate && endDate) ? buildBurndown(sprintStoryDetails, startDate, endDate) : null;

      // Generate sprint goals summary from story titles/descriptions
      const sprintGoals = generateSprintGoals(sprintStoryDetails);

      // Strip descriptions from story details before output (keep JSON small)
      const storiesForOutput = sprintStoryDetails.map(s => {
        const { description, acceptanceCriteria, ...rest } = s;
        return rest;
      });

      currentSprint = {
        name: sprintName,
        startDate,
        endDate,
        totalSP: sprintTotalSP,
        completedSP: sprintCompletedSP,
        remainingSP: sprintRemainingSP,
        storyCount: storiesForOutput.length,
        stories: storiesForOutput,
        sprintGoals,
        capacity: { hoursPerDay: capacityHoursPerDay, members },
        burndown
      };

      console.log(`   🏃 Sprint "${sprintName}": ${sprintStoryDetails.length} stories, ${sprintTotalSP} SP (${sprintCompletedSP} done)`);
    }
  } catch (e) {
    console.warn(`   ⚠ Could not fetch sprint data for ${project}: ${e.message}`);
  }

  return {
    priority: config.priority,
    name: config.displayName,
    shortName: config.shortName,
    devopsProject: config.devopsProject,
    phase,
    epics: epicSummaries,
    estimation: {
      total: stories.length,
      estimated: estimated.length,
      unestimated: stories.length - estimated.length,
      totalSP: Math.round(totalSP * 100) / 100,
      incompleteSP: Math.round(incompleteSP * 100) / 100,
      sprintSP
    },
    currentSprint
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

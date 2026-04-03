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

// ── Display name overrides (maps malformed ADO names → proper names) ────────
const DISPLAY_NAME_MAP = {
  'pawlik.gregor gmail.com': 'Greg Pawlik',
};
function normalizeName(name) {
  if (!name) return 'Unassigned';
  return DISPLAY_NAME_MAP[name] || name;
}

// ── Project display name overrides (DevOps name → friendly names) ───────────
const PROJECT_DISPLAY_NAMES = {
  'CRM': { shortName: 'CRM', displayName: 'CRM (Salesforce)' },
  'GPH': { shortName: 'GPH', displayName: 'GPH (Gospel Publishing House)' },
  'CMS vNext': { shortName: 'CMS', displayName: 'CMS vNext' },
  'Bible Engagement Project': { shortName: 'BEP', displayName: 'Bible Engagement Project' },
  'AGWM Mobilization': { shortName: 'Mobilization', displayName: 'AGWM Mobilization' },
  'AGWM Financial Reporting': { shortName: 'Financial', displayName: 'AGWM Financial Reporting' },
  'AG Missions Common': { shortName: 'Missions Common', displayName: 'AG Missions Common' },
  'Infrastructure': { shortName: 'Infra', displayName: 'Infrastructure' },
  'Business Software Support': { shortName: 'Biz Support', displayName: 'Business Software Support' },
  'Document Management': { shortName: 'Doc Mgmt', displayName: 'Document Management' },
  'Missions Support': { shortName: 'Missions Support', displayName: 'Missions Support' },
  'Missions Portal': { shortName: 'Missions Portal', displayName: 'Missions Portal' },
  'Systems Development': { shortName: 'Sys Dev', displayName: 'Systems Development' },
};

/** Fetch all projects from the Azure DevOps org and build PROJECT_CONFIGS dynamically */
async function fetchProjectConfigs() {
  const url = `${ORG_URL}/_apis/projects?$top=200&api-version=${API_VERSION}`;
  const data = await adoFetch(url);
  if (!data || !data.value) {
    console.error('ERROR: Could not fetch projects from Azure DevOps');
    process.exit(1);
  }
  const projects = data.value
    .filter(p => p.state === 'wellFormed')
    .sort((a, b) => a.name.localeCompare(b.name));

  return projects.map((p, i) => {
    const override = PROJECT_DISPLAY_NAMES[p.name];
    return {
      priority: i + 1,
      devopsProject: p.name,
      shortName: override?.shortName || p.name,
      displayName: override?.displayName || p.name,
    };
  });
}

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

/** Get child task IDs for a set of work items via relations */
async function getChildTaskIds(parentIds) {
  if (!parentIds.length) return {};
  const parentToChildren = {};
  // Fetch parents with relations expanded
  for (let i = 0; i < parentIds.length; i += 200) {
    const batch = parentIds.slice(i, i + 200);
    const url = `${ORG_URL}/_apis/wit/workitems?ids=${batch.join(',')}&$expand=relations&api-version=${API_VERSION}`;
    const data = await adoFetch(url);
    if (data && data.value) {
      data.value.forEach(wi => {
        const children = (wi.relations || [])
          .filter(r => r.rel === 'System.LinkTypes.Hierarchy-Forward') // child link
          .map(r => parseInt(r.url.split('/').pop()))
          .filter(id => !isNaN(id));
        if (children.length) parentToChildren[wi.id] = children;
      });
    }
  }
  return parentToChildren;
}

/** Fetch Remaining Work, Completed Work, and daily remaining history for child tasks */
async function getChildTaskWork(parentIds) {
  const parentToChildren = await getChildTaskIds(parentIds);
  const allChildIds = [...new Set(Object.values(parentToChildren).flat())];
  if (!allChildIds.length) return {};

  const taskFields = ['System.Id', 'System.State', 'Microsoft.VSTS.Scheduling.RemainingWork', 'Microsoft.VSTS.Scheduling.CompletedWork', 'System.AssignedTo'];
  const taskDetails = await getWorkItemDetails(allChildIds, taskFields);

  const taskMap = {};
  taskDetails.forEach(t => { taskMap[t.id] = t; });

  // Fetch revision history for each child task to build daily remaining work timeline
  // Key: taskId -> [{ date, remaining }]
  const taskHistory = {};
  for (const taskId of allChildIds) {
    try {
      const updates = await getWorkItemUpdates(taskId);
      const history = [];
      updates.forEach(u => {
        const remField = u.fields?.['Microsoft.VSTS.Scheduling.RemainingWork'];
        if (remField && remField.newValue !== undefined) {
          const changed = u.fields?.['System.ChangedDate']?.newValue;
          const revised = u.revisedDate;
          const dateStr = (changed || revised || '').split('T')[0];
          if (dateStr) {
            history.push({ date: dateStr, remaining: remField.newValue || 0 });
          }
        }
      });
      taskHistory[taskId] = history;
    } catch (e) {
      // Skip if we can't get history
    }
  }

  // Sum remaining/completed per parent story, plus daily history
  const result = {};
  for (const [parentId, childIds] of Object.entries(parentToChildren)) {
    let remaining = 0, completed = 0;
    const assignees = new Set();
    childIds.forEach(cid => {
      const t = taskMap[cid];
      if (t) {
        remaining += t.fields['Microsoft.VSTS.Scheduling.RemainingWork'] || 0;
        completed += t.fields['Microsoft.VSTS.Scheduling.CompletedWork'] || 0;
        const assignee = t.fields['System.AssignedTo'];
        if (assignee) assignees.add(typeof assignee === 'object' ? assignee.displayName : assignee);
      }
    });
    // Aggregate daily remaining across all child tasks for this story
    // For each date that any child task changed, compute the total remaining at end of that date
    const dailyChanges = {};
    childIds.forEach(cid => {
      (taskHistory[cid] || []).forEach(h => {
        if (!dailyChanges[h.date]) dailyChanges[h.date] = [];
        dailyChanges[h.date].push({ taskId: cid, remaining: h.remaining });
      });
    });
    result[parentId] = { remaining, completed, dailyChanges, childIds };
  }
  // Attach taskMap for per-person aggregation in template
  result._taskMap = taskMap;
  result._taskHistory = taskHistory;
  result._parentToChildren = parentToChildren;
  return result;
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

/** Generate a concise 2-3 sentence sprint goals summary from story titles and descriptions */
function generateSprintGoals(sprintStories) {
  if (!sprintStories.length) return '';

  const stopWords = new Set(['the','a','an','as','is','are','was','were','be','been','to','of','in','for','on','with','at','by','from','and','or','not','this','that','it','we','i','can','will','should','must','have','has','do','does','so','if','but','all','new','get','set','add','update','create','make','use','using','need','needs','able','also','when','then','into','each','per','via','may','our','any','both','more','work','item','items','user','users','page','data','system','feature','ensure','allow','based','within','between','support','provide','include','includes','story','stories','task','tasks']);

  // Extract keywords from each story title
  function titleKeywords(title) {
    return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  }

  // Build keyword frequency across all stories
  const wordFreq = {};
  for (const story of sprintStories) {
    const words = titleKeywords(story.title || '');
    const seen = new Set();
    for (const w of words) {
      if (!seen.has(w)) { wordFreq[w] = (wordFreq[w] || 0) + 1; seen.add(w); }
    }
  }

  // Cluster stories by their best shared keyword
  const assigned = new Set();
  const clusters = [];
  const sortedKeywords = Object.entries(wordFreq)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);

  for (const [keyword] of sortedKeywords) {
    const members = sprintStories.filter((s, i) => !assigned.has(i) && titleKeywords(s.title || '').includes(keyword));
    if (members.length < 2) continue;
    members.forEach(m => assigned.add(sprintStories.indexOf(m)));
    clusters.push({ keyword, stories: members });
  }
  const remaining = sprintStories.filter((_, i) => !assigned.has(i));

  // Build natural-language theme phrases
  const phrases = [];
  for (const cluster of clusters) {
    const label = cluster.keyword.charAt(0).toUpperCase() + cluster.keyword.slice(1);
    const n = cluster.stories.length;
    // Try to find a second keyword that co-occurs to make a richer label
    const coWords = {};
    cluster.stories.forEach(s => {
      titleKeywords(s.title || '').filter(w => w !== cluster.keyword).forEach(w => {
        coWords[w] = (coWords[w] || 0) + 1;
      });
    });
    const coTop = Object.entries(coWords).sort((a, b) => b[1] - a[1])[0];
    const modifier = coTop && coTop[1] >= 2 ? ` ${coTop[0]}` : '';
    phrases.push(`${label.toLowerCase()}${modifier} enhancements`);
  }

  // Summarize remaining stories concisely
  if (remaining.length > 0) {
    if (remaining.length <= 2) {
      remaining.forEach(s => {
        const t = (s.title || '').trim();
        phrases.push(t.length > 70 ? t.slice(0, 67) + '...' : t.toLowerCase());
      });
    } else {
      // Pick top 2 remaining titles and note the rest
      const titles = remaining.slice(0, 2).map(s => {
        const t = (s.title || '').trim();
        return t.length > 50 ? t.slice(0, 47) + '...' : t.toLowerCase();
      });
      phrases.push(`${titles.join(', ')}, and ${remaining.length - 2} other items`);
    }
  }

  // Compose a flowing summary — join themes as a readable sentence
  if (phrases.length === 0) return '';
  let summary = 'Delivering ' + phrases[0];
  if (phrases.length === 2) {
    summary += ', along with ' + phrases[1];
  } else if (phrases.length > 2) {
    summary += ', ' + phrases.slice(1, -1).join(', ') + ', and ' + phrases[phrases.length - 1];
  }
  summary += '.';

  // Cap length for scannability
  if (summary.length > 350) {
    summary = summary.slice(0, 347) + '...';
  }

  return summary;
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
          assignedTo: normalizeName(assignedTo ? (assignedTo.displayName || assignedTo) : 'Unassigned'),
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
              // revisedDate on the latest revision is "9999-01-01T00:00:00Z" (sentinel)
              // Use ChangedDate from the revision, or revisedDate only if it's a real date
              const revised = updates[u].revisedDate;
              const changed = updates[u].fields?.['System.ChangedDate']?.newValue;
              const isRealDate = revised && !revised.startsWith('9999');
              story.completedDate = isRealDate ? revised : (changed || revised);
              break;
            }
          }
        } catch (e) {
          // Skip if we can't get updates for this item
        }
      }

      // Fetch child task Remaining/Completed Work for each story
      const storyIds = sprintStoryDetails.map(s => s.id);
      let childTaskWork = {};
      try {
        childTaskWork = await getChildTaskWork(storyIds);
      } catch (e) {
        console.warn(`   ⚠ Could not fetch child task work: ${e.message}`);
      }

      // Attach task-level remaining/completed to each story
      const taskMap = childTaskWork._taskMap || {};
      const taskHistory = childTaskWork._taskHistory || {};
      const parentToChildren = childTaskWork._parentToChildren || {};

      sprintStoryDetails.forEach(s => {
        const taskWork = childTaskWork[s.id];
        if (taskWork) {
          s.taskRemainingWork = Math.round(taskWork.remaining * 100) / 100;
          s.taskCompletedWork = Math.round(taskWork.completed * 100) / 100;
        } else {
          // Fallback: use story-level SP if no child tasks
          s.taskRemainingWork = s.remainingSP;
          s.taskCompletedWork = s.completedSP;
        }
      });

      // Build per-person daily task remaining history for burndown charts
      // For each person, track the total remaining work from their assigned tasks over time
      const personTaskBurndown = {};
      if (startDate && endDate) {
        const sDate = new Date(startDate.split('T')[0] + 'T12:00:00');
        const eDate = new Date(endDate.split('T')[0] + 'T12:00:00');
        // Collect all child task IDs and their assigned person
        const taskToPerson = {};
        const taskInitialRemaining = {};
        Object.entries(parentToChildren).forEach(([pid, childIds]) => {
          const story = sprintStoryDetails.find(s => s.id === parseInt(pid));
          childIds.forEach(cid => {
            const t = taskMap[cid];
            if (t) {
              const assignee = t.fields['System.AssignedTo'];
              const person = normalizeName(assignee ? (typeof assignee === 'object' ? assignee.displayName : assignee) : (story ? story.assignedTo : 'Unassigned'));
              taskToPerson[cid] = person;
              // Find initial remaining from first revision or original estimate
              const hist = taskHistory[cid] || [];
              taskInitialRemaining[cid] = hist.length > 0 ? hist[0].remaining : (t.fields['Microsoft.VSTS.Scheduling.RemainingWork'] || 0);
            }
          });
        });

        // For each person, compute remaining work snapshot at end of each working day
        const personTasks = {};
        Object.entries(taskToPerson).forEach(([tid, person]) => {
          if (!personTasks[person]) personTasks[person] = [];
          personTasks[person].push(parseInt(tid));
        });

        Object.entries(personTasks).forEach(([person, taskIds]) => {
          // For each task, build a timeline: date -> remaining at end of that date
          const taskTimelines = {};
          taskIds.forEach(tid => {
            const hist = taskHistory[tid] || [];
            const t = taskMap[tid];
            const currentRemaining = t ? (t.fields['Microsoft.VSTS.Scheduling.RemainingWork'] || 0) : 0;
            // Determine the original remaining work (before any changes during sprint)
            // Walk history backwards from the first sprint-day change to find original value
            // The first history entry's old value is the original, or if no history use current
            let originalRemaining = currentRemaining;
            if (hist.length > 0) {
              // History tracks newValue changes. To find what it was BEFORE the first change,
              // we need the old value. Since we only store newValue, reconstruct:
              // If there's history, the value before first change = first entry represents a SET,
              // so the original is what it was set to initially (often the same as first entry for new tasks)
              // Best approximation: use the MAX remaining seen in history (the original estimate)
              const allVals = hist.map(h => h.remaining);
              allVals.push(currentRemaining);
              originalRemaining = Math.max(...allVals);
            }
            // Build sorted changes
            const changes = {};
            hist.forEach(h => {
              changes[h.date] = h.remaining; // last change on that date wins
            });
            taskTimelines[tid] = { initial: originalRemaining, changes, current: originalRemaining };
          });

          // Walk through each working day and compute total remaining
          const dailyRemaining = {};
          for (let d = new Date(sDate); d <= eDate; d.setDate(d.getDate() + 1)) {
            if (d.getDay() === 0 || d.getDay() === 6) continue;
            const ds = d.toISOString().split('T')[0];
            let total = 0;
            taskIds.forEach(tid => {
              const tl = taskTimelines[tid];
              if (tl.changes[ds] !== undefined) {
                tl.current = tl.changes[ds];
              }
              total += tl.current;
            });
            dailyRemaining[ds] = Math.round(total * 100) / 100;
          }
          personTaskBurndown[person] = dailyRemaining;
        });
      }

      const sprintTotalSP = sprintStoryDetails.reduce((s, st) => s + st.storyPoints, 0);
      const sprintCompletedSP = sprintStoryDetails.reduce((s, st) => s + st.completedSP, 0);
      const sprintRemainingSP = sprintTotalSP - sprintCompletedSP;

      // Get team capacity with days-off date ranges for cross-project dedup
      let capacityHoursPerDay = 0;
      let members = [];
      try {
        const capacities = await getIterationCapacity(project, iteration.id);
        capacities.forEach(c => {
          const name = normalizeName(c.teamMember?.displayName || 'Unknown');
          const dailyHours = (c.activities || []).reduce((sum, a) => sum + (a.capacityPerDay || 0), 0);
          // Collect actual date ranges for days off (for dedup across projects)
          const daysOffRanges = (c.daysOff || []).map(d => ({
            start: d.start ? d.start.split('T')[0] : null,
            end: d.end ? d.end.split('T')[0] : null
          })).filter(d => d.start);
          members.push({ name, dailyHours, daysOffRanges });
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
        burndown,
        personTaskBurndown
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
    .replace('__BUILD_TIME__', buildTime)
    .replace('__REFRESH_WORKER_URL__', process.env.REFRESH_WORKER_URL || '');

  return html;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 AG IT Dashboard — Build starting...');
  console.log(`   Org: ${ORG_URL}`);

  // Dynamically fetch all projects from the Azure DevOps org
  const PROJECT_CONFIGS = await fetchProjectConfigs();
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

/**
 * Sprint dropdown grouping. Exercises the functions in template.html
 * against the live-data shape that produced two "Q4 2026 - Sprint 1" rows.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'template.html'), 'utf8');
const start = html.indexOf('// Selected sprint slot.');
const end = html.indexOf('function renderSprintView()');
assert.ok(start > 0 && end > start, 'sprint slot functions not found in template.html');

function load(projectData) {
  const context = { projects: projectData };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  return context;
}

function sprint(name, startDate, endDate, storyCount) {
  return { name, startDate, endDate, storyCount, totalSP: storyCount, stories: [] };
}

function project(shortName, sprints) {
  return { shortName, name: shortName, allSprints: sprints };
}

// Copy out of the template vm so assertions use this realm's arrays.
function plainSlots(slots) {
  return Array.from(slots).map(s => ({
    name: s.name,
    start: s.start,
    end: s.end,
    isCurrent: s.isCurrent,
    startDates: Array.from(s.startDates)
  }));
}

function labels(slots) {
  return plainSlots(slots).map(s => `${s.name}${s.isCurrent ? ' (Current)' : ''}`);
}

// Live shape, 2026-10-01: same sprint name, start dates one day apart, same end.
const q4Projects = [
  project('AG Accounts', [sprint('Q4 2026 - Sprint 1', '2026-09-30T00:00:00Z', '2026-10-13T00:00:00Z', 1)]),
  project('Missions Common', [sprint('Q4 2026 - Sprint 1', '2026-09-30T00:00:00Z', '2026-10-13T00:00:00Z', 1)]),
  project('Financial', [sprint('Q4 2026 - Sprint 1', '2026-09-30T00:00:00Z', '2026-10-13T00:00:00Z', 1)]),
  project('CRM', [sprint('Q4 2026 - Sprint 1', '2026-09-30T00:00:00Z', '2026-10-13T00:00:00Z', 9)]),
  project('GenSec', [sprint('Q4 2026 - Sprint 1', '2026-09-30T00:00:00Z', '2026-10-13T00:00:00Z', 14)]),
  project('Infra', [sprint('Q4 2026 - Sprint 1', '2026-09-30T00:00:00Z', '2026-10-13T00:00:00Z', 28)]),
  project('AG.Giving', [sprint('Q4 2026 - Sprint 1', '2026-10-01T00:00:00Z', '2026-10-13T00:00:00Z', 12)]),
  project('GPH', [sprint('Q4 2026 - Sprint 1', '2026-10-01T00:00:00Z', '2026-10-13T00:00:00Z', 16)]),
  project('CRM later', [sprint('Q4 2026 - Sprint 2', '2026-10-14T00:00:00Z', '2026-10-27T00:00:00Z', 4)])
];

const q4 = load(q4Projects);
const q4Slots = plainSlots(q4.getSprintSlots('2026-10-01'));
assert.deepStrictEqual(
  labels(q4.getSprintSlots('2026-10-01')).filter(l => l.includes('Sprint 1')),
  ['Q4 2026 - Sprint 1 (Current)'],
  'one-day start skew must not produce two identical sprint labels'
);
const q4Slot = q4Slots.find(s => s.name === 'Q4 2026 - Sprint 1');
assert.ok(q4Slot, 'merged slot keeps the shared display name');
assert.strictEqual(q4Slot.start, '2026-09-30T00:00:00Z', 'option value is the earliest ADO start');
assert.deepStrictEqual(
  q4Slot.startDates.slice().sort(),
  ['2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z']
);
assert.strictEqual(q4Slot.isCurrent, true);
const q4Names = Array.from(q4.projectsInSprintSlot(q4Slot)).map(p => p.shortName).sort();
assert.deepStrictEqual(q4Names, [
  'AG Accounts', 'AG.Giving', 'CRM', 'Financial', 'GPH', 'GenSec', 'Infra', 'Missions Common'
]);
assert.ok(q4Slots.some(s => s.name === 'Q4 2026 - Sprint 2' && !s.isCurrent));
assert.strictEqual(new Set(q4Slots.map(s => s.start)).size, q4Slots.length, 'option values are unique');

// Same display name, two-week-apart windows stay separate and are distinguishable.
const split = load([
  project('Most', [sprint('Q1 2026 - Sprint 4', '2026-02-11T00:00:00Z', '2026-02-24T00:00:00Z', 5)]),
  project('LMS', [sprint('Q1 2026 - Sprint 4', '2026-02-25T00:00:00Z', '2026-03-10T00:00:00Z', 1)])
]);
const splitSlots = plainSlots(split.getSprintSlots('2026-10-01'));
assert.strictEqual(splitSlots.length, 2);
assert.notStrictEqual(splitSlots[0].name, splitSlots[1].name);
assert.ok(splitSlots.every(s => s.name.startsWith('Q1 2026 - Sprint 4 (')));
assert.ok(splitSlots.some(s => s.name.includes('Feb 11') && s.name.includes('Most')));
assert.ok(splitSlots.some(s => s.name.includes('Feb 25') && s.name.includes('LMS')));
assert.notStrictEqual(splitSlots[0].start, splitSlots[1].start);

// Same calendar day with a punctuation variant is still one row (majority name).
const sameDay = load([
  project('A', [sprint('Q1 2026 - Sprint 1', '2025-12-31T00:00:00Z', '2026-01-13T00:00:00Z', 3)]),
  project('B', [sprint('Q1 2026 - Sprint 1', '2025-12-31T00:00:00Z', '2026-01-13T00:00:00Z', 3)]),
  project('C', [sprint('Q1 2026 -- Sprint 1', '2025-12-31T00:00:00Z', '2026-01-13T00:00:00Z', 1)])
]);
const sameDaySlots = plainSlots(sameDay.getSprintSlots('2026-10-01'));
assert.strictEqual(sameDaySlots.length, 1);
assert.strictEqual(sameDaySlots[0].name, 'Q1 2026 - Sprint 1');
assert.strictEqual(sameDay.projectsInSprintSlot(sameDaySlots[0]).length, 3);

// Iterations with no stories do not get a dropdown row.
const empty = load([
  project('X', [sprint('Q4 2026 - Sprint 9', '2026-12-01T00:00:00Z', '2026-12-14T00:00:00Z', 0)])
]);
assert.strictEqual(empty.getSprintSlots('2026-10-01').length, 0);

console.log('sprint slot tests passed');

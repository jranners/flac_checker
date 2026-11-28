import test from 'node:test';
import assert from 'node:assert/strict';
import { computeQueueProgress } from './queueProgress';
import type { QueueItem } from './types';

function makeItem(
  id: string,
  state: QueueItem['state'],
  stageLabel?: string,
): QueueItem {
  return {
    id,
    displayName: `${id}.flac`,
    fileSize: 1024,
    state,
    stageLabel,
  };
}

test('computeQueueProgress handles empty queue', () => {
  const summary = computeQueueProgress([]);
  assert.deepEqual(summary, {
    total: 0,
    completed: 0,
    inProgress: 0,
    percent: 0,
    isComplete: false,
  });
});

test('computeQueueProgress calculates weighted intermediate progress and never hits 100% early', () => {
  const items: QueueItem[] = [
    makeItem('1', 'done'),
    makeItem('2', 'analyzing', 'Running spectral forensics…'),
    makeItem('3', 'validating', 'Validating header…'),
    makeItem('4', 'queued', 'Queued…'),
  ];
  // (1 + 0.75 + 0.2 + 0) / 4 = 0.4875 -> 49%
  const summary = computeQueueProgress(items);
  assert.equal(summary.total, 4);
  assert.equal(summary.completed, 1);
  assert.equal(summary.inProgress, 3);
  assert.equal(summary.percent, 49);
  assert.equal(summary.isComplete, false);
});

test('computeQueueProgress reaches 100% when all items are done, rejected, or errored', () => {
  const items: QueueItem[] = [
    makeItem('1', 'done'),
    makeItem('2', 'rejected'),
    makeItem('3', 'error'),
  ];
  const summary = computeQueueProgress(items);
  assert.deepEqual(summary, {
    total: 3,
    completed: 3,
    inProgress: 0,
    percent: 100,
    isComplete: true,
  });
});

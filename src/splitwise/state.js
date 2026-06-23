import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const STATE_PATH = resolve(process.cwd(), 'config', 'splitwise-state.json');

function readState() {
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    return {
      appliedExpenseIds: state.appliedExpenseIds || [],
      records: state.records || [],
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { appliedExpenseIds: [], records: [] };
    }

    throw new Error(`Failed to read ${STATE_PATH}: ${err.message}`);
  }
}

function writeState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Check if a Splitwise expense has already been applied.
 */
export function isApplied(expenseId) {
  const state = readState();
  if (state.appliedExpenseIds.includes(expenseId)) return true;

  const record = state.records.find(r => r.splitwiseId === expenseId);
  return ['matched', 'placeholder', 'manual'].includes(record?.status);
}

/**
 * Mark Splitwise expense IDs as applied. Kept for backward compatibility.
 */
export function markApplied(expenseIds) {
  const state = readState();
  const set = new Set(state.appliedExpenseIds);
  for (const id of expenseIds) set.add(id);
  state.appliedExpenseIds = [...set];
  writeState(state);
}

export function getRecord(expenseId) {
  const state = readState();
  return state.records.find(r => r.splitwiseId === expenseId) || null;
}

export function getAppliedRecord(expenseId) {
  const record = getRecord(expenseId);
  if (['matched', 'placeholder', 'manual'].includes(record?.status)) return record;
  return null;
}

export function upsertRecords(records) {
  if (records.length === 0) return;

  const state = readState();
  const byId = new Map(state.records.map(r => [r.splitwiseId, r]));

  for (const record of records) {
    byId.set(record.splitwiseId, {
      ...byId.get(record.splitwiseId),
      ...record,
      updatedAt: new Date().toISOString(),
    });
  }

  state.records = [...byId.values()];
  writeState(state);
}

/**
 * Get the default "since" date (60 days rolling window).
 */
export function getDefaultSinceDate() {
  const d = new Date();
  d.setDate(d.getDate() - 60);
  return d.toISOString().split('T')[0];
}

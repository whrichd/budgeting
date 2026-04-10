import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const STATE_PATH = resolve(process.cwd(), 'config', 'splitwise-state.json');

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return { appliedExpenseIds: [] };
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
  return state.appliedExpenseIds.includes(expenseId);
}

/**
 * Mark Splitwise expense IDs as applied.
 */
export function markApplied(expenseIds) {
  const state = readState();
  const set = new Set(state.appliedExpenseIds);
  for (const id of expenseIds) set.add(id);
  state.appliedExpenseIds = [...set];
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

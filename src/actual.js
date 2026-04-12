import api from '@actual-app/api';
import { loadConfig } from './config.js';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

const DATA_DIR = resolve(process.cwd(), 'data', 'api-cache');

export async function connect() {
  const config = loadConfig();
  mkdirSync(DATA_DIR, { recursive: true });

  await api.init({
    dataDir: DATA_DIR,
    serverURL: config.actual.serverURL,
    password: config.actual.password,
  });

  const dlOpts = config.actual.encryptionPassword
    ? { password: config.actual.encryptionPassword }
    : {};
  await api.downloadBudget(config.actual.budgetId, dlOpts);
}

export async function importTransactions(accountId, transactions) {
  const result = await api.importTransactions(accountId, transactions);
  return result;
}

export async function getAccounts() {
  return await api.getAccounts();
}

export async function getAccountBalance(accountId) {
  return await api.getAccountBalance(accountId);
}

export async function disconnect() {
  await api.sync();
  await api.shutdown();
}

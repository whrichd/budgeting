import { loadConfig } from '../config.js';

const BASE_URL = 'https://secure.splitwise.com/api/v3.0';

function getApiKey() {
  const config = loadConfig();
  const key = config.splitwise?.apiKey;
  if (!key) {
    console.error('Splitwise API key not configured. Add splitwise.apiKey to config/accounts.yml');
    process.exit(1);
  }
  return key;
}

async function request(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${getApiKey()}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Splitwise API ${res.status}: ${body}`);
  }

  return res.json();
}

/**
 * Get the current authenticated user.
 */
export async function getCurrentUser() {
  const data = await request('/get_current_user');
  return data.user;
}

/**
 * Get all friends with balances.
 */
export async function getFriends() {
  const data = await request('/get_friends');
  return data.friends;
}

/**
 * Get expenses, paginated. Fetches all pages since `since` date.
 * @param {string} since - ISO date string (YYYY-MM-DD)
 * @param {number} limit - per-page limit (max 50)
 */
export async function getExpenses(since, limit = 50) {
  const allExpenses = [];
  let offset = 0;

  while (true) {
    const data = await request('/get_expenses', {
      dated_after: since,
      limit,
      offset,
    });

    const expenses = data.expenses || [];
    if (expenses.length === 0) break;

    // Filter out deleted expenses
    const active = expenses.filter(e => !e.deleted_at);
    allExpenses.push(...active);

    if (expenses.length < limit) break;
    offset += limit;
  }

  return allExpenses;
}

/**
 * Parse a Splitwise expense into a simpler format.
 * @param {object} expense - raw Splitwise expense object
 * @param {number} currentUserId - your Splitwise user ID
 */
export function parseExpense(expense, currentUserId) {
  const isPayment = expense.payment === true;
  const totalCents = Math.round(parseFloat(expense.cost) * 100);
  const date = expense.date.split('T')[0]; // YYYY-MM-DD
  const description = expense.description;

  // Find your share in the expense
  const myUser = expense.users.find(u => u.user_id === currentUserId);
  if (!myUser) return null;

  const paidCents = Math.round(parseFloat(myUser.paid_share) * 100);
  const owedCents = Math.round(parseFloat(myUser.owed_share) * 100);

  // Determine who paid
  const youPaid = paidCents > 0;
  const yourShareCents = owedCents;
  const othersShareCents = youPaid ? (paidCents - owedCents) : 0;

  return {
    id: expense.id,
    date,
    description,
    totalCents,
    yourShareCents,
    othersShareCents,
    youPaid,
    paidCents,
    isPayment, // settlement
    groupName: expense.group_id ? `group:${expense.group_id}` : null,
    users: expense.users.map(u => ({
      userId: u.user_id,
      firstName: u.user?.first_name || 'Unknown',
      paidShare: Math.round(parseFloat(u.paid_share) * 100),
      owedShare: Math.round(parseFloat(u.owed_share) * 100),
    })),
  };
}

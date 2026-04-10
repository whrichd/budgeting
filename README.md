# Budgeting Tools

Personal budgeting system built on [Actual Budget](https://actualbudget.org/) (self-hosted) with automated transaction imports from Canadian banks and Splitwise integration.

## Setup

1. Install [Docker](https://docs.docker.com/get-docker/) and [Node.js](https://nodejs.org/) (v18+)
2. Clone this repo and install dependencies:
   ```bash
   npm install
   ```
3. Start Actual Budget:
   ```bash
   ./start.sh
   ```
4. Open http://localhost:5006, create a budget and your accounts
5. Copy the config template and fill in your values:
   ```bash
   cp config/accounts.example.yml config/accounts.yml
   ```
6. Fill in the config — see [Finding Account UUIDs](#finding-account-uuids) below

## Finding Account UUIDs

The config needs Actual Budget account UUIDs (not names). To find them:

```bash
node --input-type=module -e "
import api from '@actual-app/api';
import { mkdirSync } from 'fs';
import { loadConfig } from './src/config.js';
const config = loadConfig();
mkdirSync('./data/api-cache', { recursive: true });
await api.init({ dataDir: './data/api-cache', serverURL: config.actual.serverURL, password: config.actual.password });
await api.downloadBudget(config.actual.budgetId);
const accounts = await api.getAccounts();
for (const a of accounts) console.log(a.id + '  ' + a.name + '  (' + (a.offbudget ? 'tracking' : 'on-budget') + ')');
await api.shutdown();
"
```

This prints all accounts with their UUIDs. Copy the UUIDs into `config/accounts.yml`.

You need at minimum the `actual.serverURL`, `actual.password`, and `actual.budgetId` filled in before running this. The budget ID (Sync ID) is found in Actual Budget UI under Settings > Advanced.

## Importing Transactions

### TD, CIBC, Amex — OFX via Actual Budget UI

These banks export OFX files, which Actual Budget imports natively:

1. Download OFX file from your bank's website
2. In Actual Budget, open the account > click Import > select the OFX file

Deduplication is handled automatically.

### EQ Bank, Wealthsimple — CSV via CLI

These banks don't support OFX, so use the CLI:

```bash
# Import all CSVs in the imports folder
node src/cli.js import ./imports/

# Preview without importing
node src/cli.js import --dry-run ./imports/

# Import a specific file
node src/cli.js import ./imports/eqbank.csv

# Force a specific account
node src/cli.js import --account ws_chequing file.csv
```

Drop your CSV files into `imports/` — the parser auto-detects EQ Bank vs Wealthsimple from the file headers. Safe to re-import the same file (duplicates are skipped).

### Supported CSV formats

| Bank | Format | Auto-detected by |
|------|--------|-----------------|
| EQ Bank | `Transfer date, Description, Amount, Balance` | Header: "Transfer date" |
| Wealthsimple Chequing | `date, transaction, description, amount, balance, currency` | Header: "transaction" + "balance" |
| Wealthsimple Credit Card | `transaction_date, post_date, type, details, amount, currency` | Header: "post_date" + "type" |

## Splitwise Integration

Sync shared expenses from Splitwise into Actual Budget. Handles split transactions so your budget reflects your actual share, not the full payment.

### Setup

1. Register an app at https://secure.splitwise.com/apps and get your API key
2. Create two tracking accounts in Actual Budget: "Splitwise: Receivable" and "Splitwise: Payable" (both off-budget)
3. Add to `config/accounts.yml`:
   ```yaml
   splitwise:
     apiKey: "your-api-key"
   accounts:
     splitwise_receivable: "uuid"
     splitwise_payable: "uuid"
   ```

### Commands

```bash
# List recent Splitwise expenses
node src/cli.js splitwise expenses

# Show who owes whom
node src/cli.js splitwise balances

# Sync: match expenses to bank transactions, show proposed splits, confirm
node src/cli.js splitwise sync

# Sync with custom date range
node src/cli.js splitwise sync --since 2026-01-01
```

### How sync works

1. Import bank statements first (OFX/CSV)
2. Run `splitwise sync` — fetches last 60 days of Splitwise expenses
3. For each expense, it shows what it wants to do:
   - **You paid**: split the bank transaction into your share + receivable
   - **They paid**: create a payable entry for your share
   - **Settlement**: match the e-transfer to payable/receivable
4. You confirm before any changes are applied
5. Already-processed expenses are skipped on re-runs

## Remote Access and Sharing

Use [Tailscale](https://tailscale.com/) (free) to access Actual Budget from your phone or share with others.

### Setup

1. Install Tailscale on the server machine, your phone, and any other devices
2. All devices join the same Tailscale network (tailnet)
3. Access Actual Budget at `http://<server-tailscale-hostname>:5006` from any device

### Sharing with another person

1. They create their own Tailscale account (free)
2. Share your server device with them via [Tailscale admin console](https://login.tailscale.com/admin/machines)
3. Optionally use [ACLs](https://tailscale.com/kb/1018/acls/) to restrict access to port 5006 only
4. They access the same URL in their browser — same password, same budget

Actual Budget supports simultaneous access from multiple devices. Changes sync automatically.

### Running CLI from a different machine

If the server runs on one laptop and you run CLI tools from another:

1. Both machines need Tailscale
2. Update `config/accounts.yml` on the CLI machine:
   ```yaml
   actual:
     serverURL: "http://<server-tailscale-hostname>:5006"
   ```
3. Everything else works the same — the CLI talks to the server over Tailscale

## Upgrading Actual Budget

Server and API versions must match. To upgrade:

1. Check latest version at https://actualbudget.org/docs/releases/
2. Update `VERSION` in `start.sh`
3. Update `image` tag in `docker-compose.yml`
4. Run `npm install @actual-app/api@<same-version>`
5. Restart: `./start.sh`

If you see `out-of-sync-migrations` errors, the versions are mismatched.

## Project Structure

```
budgeting/
├── start.sh                    # Start/restart Actual Budget container
├── docker-compose.yml          # Alternative to start.sh (for docker compose)
├── src/
│   ├── cli.js                  # CLI entry point
│   ├── config.js               # Loads config/accounts.yml
│   ├── actual.js               # Actual Budget API wrapper
│   ├── parsers/
│   │   ├── index.js            # Auto-detection logic
│   │   ├── eqbank.js           # EQ Bank CSV parser
│   │   ├── wealthsimple.js     # Wealthsimple CSV parser (chequing + credit card)
│   │   └── utils.js            # Shared utilities (imported_id generation)
│   └── splitwise/
│       ├── client.js           # Splitwise API client
│       ├── sync.js             # Sync orchestrator (match, propose, apply)
│       ├── matcher.js          # Match Splitwise expenses to bank transactions
│       └── state.js            # Track processed expense IDs
├── config/
│   └── accounts.example.yml    # Config template
├── imports/                    # Drop CSV/OFX files here (gitignored)
└── data/                       # Actual Budget server data (gitignored)
```

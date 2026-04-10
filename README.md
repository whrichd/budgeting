# Budgeting Tools

Personal budgeting system built on [Actual Budget](https://actualbudget.org/) (self-hosted) with automated transaction imports from Canadian banks.

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
   You need the server password and account UUIDs (found in Actual Budget settings).

## Importing Transactions

### TD, CIBC, Amex — OFX via Actual Budget UI

These banks export OFX files, which Actual Budget imports natively:

1. Download OFX file from your bank's website
2. In Actual Budget, open the account → click Import → select the OFX file

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

## Other Commands

```bash
node src/cli.js balances    # Show account balances from Actual Budget
```

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
│   └── parsers/
│       ├── index.js            # Auto-detection logic
│       ├── eqbank.js           # EQ Bank CSV parser
│       ├── wealthsimple.js     # Wealthsimple CSV parser (chequing + credit card)
│       └── utils.js            # Shared utilities (imported_id generation)
├── config/
│   └── accounts.example.yml    # Config template
├── imports/                    # Drop CSV/OFX files here (gitignored)
└── data/                       # Actual Budget server data (gitignored)
```

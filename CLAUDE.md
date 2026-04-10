# Budgeting Tools

Personal budgeting system built on Actual Budget (self-hosted) with CSV import for banks that don't support OFX.

## Architecture

- **Actual Budget** runs in Docker (port 5006), stores data in `./data/` (SQLite)
- **Import scripts** are Node.js, using `@actual-app/api` (official API)
- **Parsers** in `src/parsers/` — one per bank, each exports `detect()` and `parse()`
- **CLI** at `src/cli.js` — main entry point for importing transactions

## Supported Banks

| Bank | Import Method | Tool |
|------|--------------|------|
| TD Canada Trust | OFX file | Actual Budget UI (built-in) |
| CIBC | OFX file | Actual Budget UI (built-in) |
| Amex Canada | OFX file | Actual Budget UI (built-in) |
| EQ Bank | CSV file | CLI: `node src/cli.js import` |
| Wealthsimple | CSV file (two formats: chequing + credit card) | CLI: `node src/cli.js import` |
| Wealthsimple | Holdings report CSV | CLI: `node src/cli.js holdings` |

## Commands

```bash
./start.sh                                            # Start Actual Budget (pinned to v26.4.0)
node src/cli.js import ./imports/                     # Import EQ Bank + WS CSVs
node src/cli.js import --dry-run ./imports/           # Parse without importing
node src/cli.js import --account ws_chequing file.csv # Explicit account
node src/cli.js balances                              # Show balances
node src/cli.js holdings ./imports/holdings-report-*.csv      # Update investment balances
node src/cli.js holdings --dry-run ./imports/holdings-*.csv   # Preview without updating
```

### Holdings Setup

To track Wealthsimple investment account balances (RRSP, TFSA):

1. Create two **tracking accounts** in Actual Budget (Settings → Add Account → Off-budget)
   - Name them e.g. "WS RRSP" and "WS TFSA"
2. Get each account's UUID from Actual Budget (Settings → Advanced → Show IDs, then click the account)
3. Add them to `config/accounts.yml`:
   ```yaml
   accounts:
     ws_rrsp: "the-rrsp-account-uuid"
     ws_tfsa: "the-tfsa-account-uuid"
   ```
4. Download the holdings report CSV from Wealthsimple (Accounts → Download → Holdings report)
5. Run: `node src/cli.js holdings ./imports/holdings-report-2026-04-10.csv`

Repeat monthly to track net worth over time. Fetches live USD/CAD rate from Bank of Canada for currency conversion.

## Key Conventions

- Amounts are integers in cents (Actual Budget format). Negative = outflow.
- `imported_id` uses SHA-256 hash for deduplication. Safe to re-import same file.
- Config lives in `config/accounts.yml` (gitignored — contains server password and account UUIDs).
- See `config/accounts.example.yml` for the template.
- `@actual-app/api` version must match the Actual Budget server version (both v26.x).
- Parser extensibility: add a new file in `src/parsers/`, export `detect(content, filename)` and `parse(content, filename)`, register in `src/parsers/index.js`.

## Upgrading Actual Budget

Server and API versions must match. To upgrade:

1. Check latest version at https://actualbudget.org/docs/releases/
2. Update `VERSION` in `start.sh`
3. Update `image` tag in `docker-compose.yml`
4. Run `npm install @actual-app/api@<same-version>`
5. Restart: `./start.sh`

If you see `out-of-sync-migrations` errors, the versions are mismatched.

## Phases

- **Phase 1** (current): OFX import (TD/CIBC/Amex via UI) + CSV import (EQ Bank/Wealthsimple via CLI)
- **Phase 2**: Splitwise API integration (shared expense reconciliation)
- **Phase 2**: Triangle Bank, Simplii parsers (when samples available)
- **Phase 3**: Mobile access via Tailscale + PWA

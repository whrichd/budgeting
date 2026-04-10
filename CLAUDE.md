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

## Commands

```bash
docker run -d -p 5006:5006 -v $(pwd)/data:/data --name actual_budget actualbudget/actual-server:latest
node src/cli.js import ./imports/                     # Import EQ Bank + WS CSVs
node src/cli.js import --dry-run ./imports/           # Parse without importing
node src/cli.js import --account ws_chequing file.csv # Explicit account
node src/cli.js balances                              # Show balances
```

## Key Conventions

- Amounts are integers in cents (Actual Budget format). Negative = outflow.
- `imported_id` uses SHA-256 hash for deduplication. Safe to re-import same file.
- Config lives in `config/accounts.yml` (gitignored — contains server password and account UUIDs).
- See `config/accounts.example.yml` for the template.
- `@actual-app/api` version must match the Actual Budget server version (both v26.x).
- Parser extensibility: add a new file in `src/parsers/`, export `detect(content, filename)` and `parse(content, filename)`, register in `src/parsers/index.js`.

## Phases

- **Phase 1** (current): OFX import (TD/CIBC/Amex via UI) + CSV import (EQ Bank/Wealthsimple via CLI)
- **Phase 2**: Splitwise API integration (shared expense reconciliation)
- **Phase 2**: Triangle Bank, Simplii parsers (when samples available)
- **Phase 3**: Mobile access via Tailscale + PWA

# Budgeting Tools

Personal budgeting system built on Actual Budget (self-hosted) with automated CSV/XLS import from Canadian banks.

## Architecture

- **Actual Budget** runs in Docker (port 5006), stores data in `./data/` (SQLite)
- **Import scripts** are Node.js, using `@actual-app/api` (official API)
- **Parsers** in `src/parsers/` — one per bank, each exports `detect()` and `parse()`
- **CLI** at `src/cli.js` — main entry point for importing transactions

## Supported Banks

| Bank | Parser | Format | Account Resolution |
|------|--------|--------|-------------------|
| TD Canada Trust | `td.js` | CSV (no headers, MM/DD/YYYY) | Filename or `--account` flag |
| CIBC | `cibc.js` | CSV (no headers, YYYY-MM-DD) | Auto (card mask = credit, else chequing) |
| Amex Canada | `amex.js` | Binary .xls | Auto (only one account) |
| EQ Bank | `eqbank.js` | CSV (has headers) | Auto (only one account) |
| Wealthsimple | `wealthsimple.js` | CSV (has headers, two formats) | Auto (header detection) |

## Commands

```bash
docker compose up -d                              # Start Actual Budget
node src/cli.js import ./imports/                  # Import all files
node src/cli.js import --account td_credit file.csv  # Explicit account
node src/cli.js balances                           # Show balances
```

## Key Conventions

- Amounts are integers in cents (Actual Budget format). Negative = outflow.
- `imported_id` uses SHA-256 hash for deduplication. Safe to re-import same file.
- Config lives in `config/accounts.yml` (gitignored — contains server password and account UUIDs).
- See `config/accounts.example.yml` for the template.
- Parser extensibility: add a new file in `src/parsers/`, export `detect(content, filename)` and `parse(content, filename)`, register in `src/parsers/index.js`.

## Phases

- **Phase 1** (current): CSV/XLS import from TD, CIBC, Amex, EQ Bank, Wealthsimple
- **Phase 2**: Splitwise API integration (shared expense reconciliation)
- **Phase 2**: Triangle Bank, Simplii parsers (when samples available)
- **Phase 3**: Mobile access via Tailscale + PWA

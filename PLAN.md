# Personal Budgeting System — Implementation Plan

## Context

User currently tracks expenses in a Google Sheet that's becoming unwieldy. They want to automate budgeting with:
- **Actual Budget** (self-hosted via Docker) as the core app
- **CSV/XLS imports** from Canadian banks (TD, CIBC, Amex, EQ Bank, Wealthsimple) — no SimpleFIN
- **Splitwise API** integration for shared expenses (later phase)
- **Mobile access** via PWA + Tailscale (later phase)
- **Node.js** for all import scripts (official `@actual-app/api`)
- **Wealthsimple** exports are per-account CSVs (chequing + credit card), not multi-account
- Git-tracked project with CLAUDE.md for project conventions

## Architecture

```
budgeting/
├── CLAUDE.md                       # Project conventions and change log
├── .gitignore
├── docker-compose.yml              # Actual Budget server
├── package.json                    # Node.js project
├── src/
│   ├── config.js                   # Server URL, password, account mappings
│   ├── actual.js                   # Actual Budget API wrapper
│   ├── parsers/
│   │   ├── index.js                # Auto-detect bank from file content/headers
│   │   ├── td.js                   # TD (credit + chequing)
│   │   ├── cibc.js                 # CIBC (credit + chequing)
│   │   ├── amex.js                 # Amex Canada (XLS format)
│   │   ├── eqbank.js               # EQ Bank
│   │   └── wealthsimple.js         # Wealthsimple (multi-account, splits by account_id)
│   ├── splitwise/                  # Phase 2
│   │   ├── client.js
│   │   ├── sync.js
│   │   └── reconcile.js
│   └── cli.js                      # CLI entry point
├── imports/                        # Drop CSVs/XLS here
├── config/
│   └── accounts.example.yml        # Example account mapping
└── data/                           # Actual Budget server data (Docker volume)
```

## Account Mapping: How Imports Know Which Account to Update

Each import must resolve to a specific Actual Budget account. This uses a 3-tier resolution with both **filename convention** and **CLI flags**:

**Tier 1 — Auto-detect from file content** (no user input needed):
| File type | How account is determined |
|-----------|--------------------------|
| CIBC credit | Card mask in column 5 → `cibc_credit` |
| CIBC chequing | YYYY-MM-DD, 4 cols, verbose description, no card mask → `cibc_chequing` |
| EQ Bank | Header "Transfer date" → `eq_savings` (only one account) |
| Amex | `.xls` extension → `amex` (only one account) |
| WS Chequing | Header has `transaction` + `balance` cols → `ws_chequing` |
| WS Credit Card | Header has `post_date` + `type` cols → `ws_credit` |

**Tier 2 — Filename convention** (for TD, where credit/chequing CSVs are identical):
- Filename contains `credit` → `td_credit`
- Filename contains `chequing` or `checking` → `td_chequing`
- Example: `td_credit.csv`, `td_checking_march.csv`

**Tier 3 — CLI `--account` flag** (explicit override, works for any bank):
- `node src/cli.js import --account td_credit file.csv`
- Always wins over auto-detection
- Required when auto-detect and filename convention both fail (prints error with available account names)

**Resolution order**: CLI flag → filename convention → auto-detect from content → error with helpful message.

The `--account` flag value maps directly to keys in `config/accounts.yml`.

## Verified CSV/XLS Formats (from user samples)

### TD Credit & Chequing (`td.js`)
- **No headers**, 4-5 columns
- Format: `MM/DD/YYYY, Description, Debit, Credit, Balance`
- Debit/Credit are in separate columns (one empty per row)
- Detection: headerless + MM/DD/YYYY date format
- Differentiation: user specifies `--account chequing` or `--account credit` (or via filename convention like `td_credit.csv`)

### CIBC Credit (`cibc.js` — credit mode)
- **No headers**, 5 columns
- Format: `YYYY-MM-DD, "Description", Debit, Credit, CardNumber`
- Description may contain commas (quoted)
- Has masked card number in column 5 (e.g., `5268********8064`)
- Detection: headerless + YYYY-MM-DD + 5th column matches `\d{4}\*+\d{4}`

### CIBC Chequing (`cibc.js` — chequing mode)
- **No headers**, 4 columns
- Format: `YYYY-MM-DD, LongDescription, Debit, Credit`
- Descriptions are very verbose (include transaction type prefix like "Point of Sale - Interac", "Internet Banking", "Electronic Funds Transfer")
- Parser should extract clean payee name from verbose description
- Detection: headerless + YYYY-MM-DD + no card number column + verbose description patterns

### EQ Bank (`eqbank.js`)
- **Has headers**: `Transfer date, Description, Amount, Balance`
- Format: `YYYY-MM-DD, Description, $Amount, $Balance`
- Amounts have `$` prefix and are signed (negative = outflow)
- Clean, simple format
- Detection: header row contains "Transfer date"

### Amex Canada (`amex.js`)
- **Binary .xls file** (not CSV or XLSX), parsed via `xlsx` npm package
- First ~12 rows are summary/header info (card name, date range, account number, totals)
- Transaction data starts at row with headers: `Date, Date Processed, Description, Amount, Foreign Spend Amount, Commission, Exchange Rate, Merchant, Merchant Address, Additional Information`
- Date format: `DD MMM. YYYY` (e.g., `26 Mar. 2026`)
- Amount has `$` prefix, signed (negative = payment/credit, positive = charge)
- Description and Merchant columns are often identical — use `Description` for payee
- Detection: `.xls` file extension

### Wealthsimple Chequing (`wealthsimple.js` — chequing mode)
- **Has headers**: `date, transaction, description, amount, balance, currency`
- Per-account export — account ID is in the **filename** (e.g., `WK1YRQV30CAD`)
- `transaction` column has type codes: `E_TRFOUT`, `TRFOUT`, `INT`, `AFT_OUT`, `AFT_IN`, `P2P_RECEIVED`, `P2P_SENT`, `OBP_OUT`, `EFT`, `GIVEAWAY`
- Amount is signed float string (negative = outflow)
- Detection: header row contains `"transaction"` and `"balance"` columns

### Wealthsimple Credit Card (`wealthsimple.js` — credit card mode)
- **Has headers**: `transaction_date, post_date, type, details, amount, currency`
- `type` values: `Payment` (negative amount = credit), `Purchase` (positive = charge)
- Positive amount = outflow from user's perspective (charges)
- Detection: header row contains `"post_date"` and `"type"` columns

## Implementation Steps

### Step 0: Project Setup
- Remove Python artifacts: `pyproject.toml`, `.python-version`, `main.py`
- Create `CLAUDE.md` with project conventions, architecture decisions, change history
- Replace `.gitignore` with Node.js patterns: `node_modules/`, `data/`, `imports/`, `config/accounts.yml` (secrets)
- Initial commit

### Step 1: Docker Setup for Actual Budget
- Create `docker-compose.yml` with `actualbudget/actual-server:latest`
- Mount `./data` volume for persistence
- Expose port 5006
- Verify: `docker compose up -d` → access at `http://localhost:5006`
- User creates budget and accounts manually in the UI first

### Step 2: Node.js Project Scaffold
- `package.json` with dependencies:
  - `@actual-app/api` — official Actual Budget API
  - `csv-parse` — CSV parsing (handles quoted fields, etc.)
  - `xlsx` — XLS/XLSX parsing (for Amex)
  - `commander` — CLI framework
  - `yaml` — config file parsing
  - `crypto` — stable imported_id generation (built-in)
- `src/config.js` — loads `config/accounts.yml` mapping:
  ```yaml
  actual:
    serverURL: "http://localhost:5006"
    password: "your-password"
    budgetId: "your-sync-id"
  accounts:
    td_chequing: "actual-account-uuid"
    td_credit: "actual-account-uuid"
    cibc_chequing: "actual-account-uuid"
    cibc_credit: "actual-account-uuid"
    amex: "actual-account-uuid"
    eq_savings: "actual-account-uuid"
    ws_chequing: "actual-account-uuid"
    ws_credit: "actual-account-uuid"
  ```
- `src/actual.js` — thin wrapper: `connect()`, `importTransactions()`, `updateAccountBalance()`, `disconnect()`

### Step 3: CSV/XLS Parsers
Each parser exports:
```js
module.exports = {
  detect(content, filename) → boolean,   // Can this parser handle this file?
  parse(content, filename) → { account: string, transactions: Transaction[] }
}
```

Transaction object:
```js
{
  date: "2026-03-17",           // YYYY-MM-DD
  amount: -16101,               // Integer cents, negative = outflow
  payee_name: "COSTCO W552",    // Cleaned up merchant name
  imported_id: "abc123hash",    // Stable hash for dedup
  notes: ""                     // Optional
}
```

**`imported_id` generation**: `sha256(bank + date + amount_cents + raw_description + row_index_within_same_day_amount_desc)`. The row_index suffix handles identical transactions on the same day (e.g., two Tim Hortons $5.00). Re-importing the same file always produces the same IDs → safe to re-run.

**Parser auto-detection order** (`parsers/index.js`):
1. If `.xls`/`.xlsx` extension → Amex parser
2. Read first line; if it has known headers:
   - Contains `"Transfer date"` → EQ Bank
   - Contains `"transaction"` + `"balance"` → WS Chequing
   - Contains `"post_date"` + `"type"` → WS Credit Card
3. If headerless, check date format:
   - `MM/DD/YYYY` → TD parser
   - `YYYY-MM-DD` + 5 columns with card mask → CIBC credit
   - `YYYY-MM-DD` + 4 columns with verbose description → CIBC chequing
4. Fallback: require `--account` flag

**CIBC chequing description cleanup**: Extract payee from verbose strings like:
- `"Point of Sale - Interac RETAIL PURCHASE 607812266366 CONSULATE GENER"` → `"CONSULATE GENER"`
- `"Internet Banking INTERNET TRANSFER 000000116465"` → `"Internet Transfer"`
- `"Electronic Funds Transfer PAY 10677735683 DIALPAD CANADA INC"` → `"DIALPAD CANADA INC"`
- `"Branch Transaction SERVICE CHARGE CAPPED MONTHLY FEE..."` → `"Service Charge"`

### Step 4: CLI Import Tool
```bash
node src/cli.js import ./imports/              # Import all files in folder
node src/cli.js import ./imports/td_credit.csv # Filename convention resolves account
node src/cli.js import --account td_credit file.csv  # Explicit account override
node src/cli.js balances                       # Show account balances from Actual
```

Import flow:
1. Read file(s) from path argument
2. For each file:
   a. If `--account` flag provided → use it directly (maps to `config/accounts.yml` key)
   b. Else auto-detect bank parser from file content
   c. Parser returns `account` key; for TD, also check filename for `credit`/`chequing`
   d. If account still ambiguous → print error: `"Cannot determine account for file.csv. Use --account <name> or rename file. Available: td_chequing, td_credit, ..."`
3. Parse to normalized transactions
4. Connect to Actual Budget via `@actual-app/api`
5. For each account's transactions: call `api.importTransactions(accountId, transactions)`
   - Actual's built-in dedup uses `imported_id` — safe to re-import
6. Print summary per account:
   ```
   TD Credit:     45 imported, 12 skipped (duplicates)
   EQ Bank:        5 imported, 1 skipped (duplicates)
   Errors:         0
   ```
7. If errors: print the problematic rows with line numbers + reason
8. Disconnect

### Step 5: Splitwise Integration (Phase 2 — later)
- Splitwise API client with OAuth
- Fetch expenses, match to bank transactions by date + amount
- Create split transactions in Actual Budget
- Track receivables/payables in tracking accounts
- Paybacks can come from any account (TD, Wealthsimple Cash, etc.)

### Step 6: Triangle Bank & Simplii (Phase 2 — when samples available)
- Add parsers when user provides sample CSVs
- Same `detect()`/`parse()` pattern — just a new file in `parsers/`

## Account Structure in Actual Budget

| Account | Type | Sync Method |
|---------|------|-------------|
| TD Chequing | On-budget | CSV import |
| TD Credit Card | On-budget | CSV import |
| CIBC Chequing | On-budget | CSV import |
| CIBC Credit Card | On-budget | CSV import |
| Amex Credit Card | On-budget | XLS import |
| EQ Bank Savings | On-budget | CSV import |
| WS Chequing | On-budget | CSV import |
| WS Credit Card | On-budget | CSV import |
| Splitwise: Receivable | Off-budget (tracking) | Splitwise API (Phase 2) |
| Splitwise: Payable | Off-budget (tracking) | Splitwise API (Phase 2) |

## Dependencies

- `@actual-app/api` — official Actual Budget API
- `csv-parse` — CSV parsing with quoted field support
- `xlsx` — XLS/XLSX binary file parsing (for Amex)
- `commander` — CLI framework
- `yaml` — config file parsing
- `crypto` (built-in) — stable imported_id hashing

## Verification Plan

1. **Docker**: `docker compose up -d` → access at `http://localhost:5006`, create budget
2. **Parse test**: Run each parser against sample files, verify output matches expected transactions
3. **Import test**: `node src/cli.js import ./imports/td_credit.csv` → verify transactions in Actual UI
4. **Dedup test**: Re-run same import → verify 0 new transactions, same totals
5. **Multi-file test**: `node src/cli.js import ./imports/` with multiple bank files → verify all accounts populated
6. **Wealthsimple**: Import WS chequing and credit card CSVs → verify transactions in correct accounts

### Resetting Test Data

1. **Wipe everything** (nuclear option):
   ```bash
   docker compose down
   rm -rf data/
   docker compose up -d
   # Re-create budget and accounts in the Actual UI
   ```
2. **Reimport over existing data** (non-destructive): just re-run the import — `imported_id` dedup means duplicates are skipped automatically. If you deleted transactions in the UI and re-import, only the deleted ones get re-added.
3. **Delete specific transactions**: use the Actual Budget UI → go to account → select transactions → delete

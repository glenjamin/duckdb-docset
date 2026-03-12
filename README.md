# DuckDB Dash Docset

Generate a [Dash](https://kapeli.com/dash)-compatible docset from the [DuckDB](https://duckdb.org) documentation.

## Prerequisites

- Node.js

## Setup

```bash
npm install
npm run clone
```

## Usage

```bash
npm run generate
```

This produces `DuckDB.docset/` which you can open directly in Dash:

```bash
open DuckDB.docset
```

Or install it to the default Dash docsets directory:

```bash
npm run install-docset
```

## What's included

- All pages from the DuckDB stable documentation
- Syntax-highlighted code blocks
- Railroad diagrams on statement pages
- Callout boxes (Note, Warning, Tip, Best Practice, Deprecated)
- Full-text search enabled

### Search index

The search index includes:

| Source | Dash type | Example |
|---|---|---|
| SQL statements | Statement | `SELECT`, `CREATE TABLE` |
| Function pages | Function | `json_exists`, `list_transform` |
| Function aliases | Function | `json_extract_path`, `array_agg` |
| Data types | Type | `BIGINT`, `VARCHAR` |
| Query syntax | Section | `GROUP BY`, `WINDOW` |
| Expressions | Expression | `CASE`, `IN Operator` |
| Configuration | Setting | `Pragmas`, `Secrets Manager` |
| Everything else | Guide | Client APIs, extensions, guides |
| Section headings | (per page) | Deep links to `##`–`#####` headings |

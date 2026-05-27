# Contributing

## Adding a new SQL table

Classify the table per `docs/superpowers/specs/2026-05-18-backend-migration-design.md` §6.1
and `docs/superpowers/specs/2026-05-18-phase-c-audit-sql-writes-design.md` §4.1:

- **Tier A (append-only)** — security/audit/quota data. Add `BEFORE UPDATE` and
  `BEFORE DELETE` triggers in the migration that `RAISE(ABORT, '<table> is append-only')`,
  AND add a Rust write command (e.g., `audit_append`-style; see
  `src-tauri/src/audit/mod.rs`). JS reads via the SQL plugin; JS never writes
  directly.
- **Tier B (mutable, privileged)** — security-relevant fields/columns. JS reads
  via the SQL plugin. Legitimate writers go through a Rust command that emits an
  audit event inside the same transaction as the data UPDATE. Note: until field-split
  ships, a compromised renderer with `sql:allow-execute` can still UPDATE the whole
  blob — see Phase C spec §5 residual.
- **Tier C (JS-mutable)** — user data with no security boundary. Unchanged.

Default to Tier C if unsure — over-classification adds friction; consciously elevate
when needed.

## Retention

Tier-A tables are append-only; DELETE is blocked at the engine. Retention is handled
by table rotation (e.g., rename `audit_log` → `audit_log_2026Q2`, create a fresh
`audit_log`). See Phase C spec §4.4. No code should issue raw `DELETE FROM <tier-A>`.

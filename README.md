# DataFlip

A VS Code extension modelled on the JetBrains Rider database tool window. Clean-room: it mirrors the workflow, not Rider's code.

- **Data Sources** view: data source → schema → tables / views → columns (PK, type, nullability)
- **Query consoles**: any `.sql` file can be attached to a data source (status bar)
- **Cmd/Ctrl+Enter** runs the selection, or the statement under the caret
- **Results** grid in the bottom panel; **Open Table Data** shows the first 500 rows
- PostgreSQL (`pg`), MySQL / MariaDB (`mysql2`), SQLite (built-in `node:sqlite`)
- Passwords live in VS Code secret storage

## Develop

```bash
npm install
npm test
```

Press F5 in VS Code to launch an Extension Development Host.
Set `DATAFLIP_PG` / `DATAFLIP_MYSQL` to a JSON connection config to also run the driver tests against Postgres / MySQL (see `test/drivers.test.js`).

## Limits

Read-only grid (no cell editing), no autocomplete, one result tab, one Postgres database per data source, at most 1000 rows rendered.

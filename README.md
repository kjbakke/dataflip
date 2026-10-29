# DataFlip

A VS Code extension modelled on the JetBrains Rider database tool window. Clean-room: it mirrors the workflow, not Rider's code.

- **Data Sources** view: data source → schema → tables / views → columns (PK, type, nullability)
- **Query consoles**: any `.sql` file can be attached to a data source (status bar)
- **Cmd/Ctrl+Enter** runs the selection, or the statement under the caret
- **Results** grid in the bottom panel; **Open Table Data** shows the first 500 rows
- PostgreSQL (`pg`), MySQL / MariaDB (`mysql2`), SQL Server (`mssql`), SQLite (built-in `node:sqlite`), BigQuery (`@google-cloud/bigquery`)
- Passwords live in VS Code secret storage

### BigQuery

Datasets show as schemas. Auth uses Application Default Credentials (`gcloud auth application-default login`) or a service account key file. Queries fetch only the first 1000 rows (the grid shows the total), so large results do not get pulled down. Every query is billed as usual.

## Develop

```bash
npm install
npm test
```

Press F5 in VS Code to launch an Extension Development Host.
Set `DATAFLIP_PG`, `DATAFLIP_MYSQL`, `DATAFLIP_MSSQL` or `DATAFLIP_BIGQUERY` to a JSON connection config to also run the driver tests against those engines (see `test/drivers.test.js`; BigQuery runs against [goccy/bigquery-emulator](https://github.com/goccy/bigquery-emulator)).

## Limits

Read-only grid (no cell editing), no autocomplete, one result tab, one Postgres database per data source, at most 1000 rows rendered.

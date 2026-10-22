# Frozen v8 baseline

Source: release v2.6.0, commit `3890679`. `manifest.json` pins the SHA-256 of each original schema source after CRLF-to-LF normalization. No historical source files are rewritten.

`tests/persistence-v9.test.ts` constructs isolated v1–v8 databases from the immutable v1/v2 fixtures and the frozen versioned SQL. For v8 it also adds synthetic discovery records with the existing v6 fixture helper. It verifies the original fields of every table, checkpoints, catalog state, new NULL values, dictionary rows, DDL equivalence and rollback. `persistence-v8.test.ts` independently keeps testing the original v7 → v8 step and NCSS constraints. Packaged acceptance uses the original v2.6.0 exporter from the source commit.

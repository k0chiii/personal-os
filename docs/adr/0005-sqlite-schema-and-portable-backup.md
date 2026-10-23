# ADR 0005: Version SQLite and portable canonical backups

## Context

Projection loss must be recoverable, and silent schema drift would make event replay unsafe.

## Decision

SQLite stores an explicit schema version and fails closed on an unknown version. Backup schema 1
contains canonical Stored Events plus hash-addressed Raw Evidence bytes. Restore is permitted only
into an empty Event Store, verifies every hash and stream version, then rebuilds all projections.

## Alternatives

- Copying the live SQLite file couples backup to WAL state and local storage layout.
- Backing up projections duplicates derived data and can preserve inconsistencies.

## Consequences

Backups are portable and inspectable but can be large. Encryption and off-device transport remain
outside the core because they require deployment-specific key management.

## Revisit condition

Introduce migrations or chunked/encrypted archive adapters before schema 2 or large binary imports.

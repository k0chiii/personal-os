# ADR-0004: Use SQLite events, rebuildable projections, and content-addressed files locally

## Status

Accepted

## Context

The first Personal OS vertical slice must import Evidence, preserve the raw source, create an
Assertion Proposal, require human review, append canonical history, update a searchable read model,
and explain an Assertion from its Evidence.

The canonical store and the read model have different responsibilities. Canonical history must be
append-only and auditable. Search data may be discarded and rebuilt. Raw Evidence must retain stable
identity independently of either database representation.

The local profile also needs to run without a commercial LLM API or cloud service.

## Decision

The local adapter uses three storage roles:

1. `canonical_events` in SQLite is the append-only Event Store. Each stream uses an expected version
   for optimistic concurrency, and command idempotency keys can return the original append result.
2. Raw Evidence is stored in the filesystem under its SHA-256 digest. Re-importing identical content
   reuses the same object and Evidence projection.
3. Evidence, Proposal, Assertion, audit, and FTS5 tables are rebuildable projections. `personal rebuild`
   clears these tables and replays every canonical event in global order.

Proposal creation does not emit `assertion.created`. Approval emits `proposal.approved` and
`assertion.created` together. Rejection emits only `proposal.rejected`. This makes human authority a
state-transition rule instead of a prompt convention.

SQLite rows and JSON event payloads are validated when they cross the adapter boundary. Domain and
Application packages do not import Node, SQLite, or filesystem APIs.

## Alternatives

### Store current Assertions directly

This is simpler, but it loses the canonical history needed for rebuilds, audit, and later temporal
state reconstruction.

### Store raw Evidence in SQLite blobs

This would reduce the number of storage mechanisms, but it couples large source objects to the Event
Store and makes independent content-addressed backup less direct.

### Use an ORM

The first slice uses a small schema and important SQL behavior. Direct SQL keeps event ordering,
optimistic concurrency, FTS5, and rebuild semantics visible while the persistence model is still
changing.

## Consequences

### Positive

- The slice runs locally with Node.js, SQLite, and the filesystem.
- Canonical history survives projection loss.
- Raw Evidence can be verified by content hash.
- Search uses FTS5 while temporal and privacy filters remain explicit.
- AI-created Proposals cannot directly become canonical Assertions.
- Application and Domain code remain independent from local infrastructure.

### Negative

- An append can succeed while projection application fails. Callers may observe temporary projection
  lag until `personal rebuild` succeeds.
- Filesystem objects and SQLite events require coordinated backup.
- Direct SQL and JSON boundary validation add adapter code.
- The first slice supports Preference Assertions only.

## Revisit conditions

Revisit this decision when measured data requires a dedicated vector store, when multiple local
writers need stronger coordination, when purge semantics are implemented, or when a cloud Event Store
adapter is introduced.

## Related requirements

- FR-001, FR-002, FR-003, FR-004, FR-005
- FR-012, FR-013, FR-022, FR-023
- NFR-004, NFR-005, NFR-006, NFR-012
- AC-05, AC-06, AC-08, AC-09, AC-15

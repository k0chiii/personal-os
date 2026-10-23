# ADR 0007: Require human approval and append temporal updates

## Context

An inferred memory must not become a fact merely because an agent produced it, and changing a
Preference must not erase the previous state.

## Decision

Agents create pending Proposals. Only approve/edit creates a canonical Assertion event. Supersede
closes the old half-open validity interval and creates a new Assertion ID in one canonical event;
dispute and retract are also append-only status transitions.

## Alternatives

- Direct agent writes remove owner authority.
- Updating one current row destroys provenance and historical queries.

## Consequences

Writes require a review step and projections contain historical rows. Event replay deterministically
recreates both present and past state.

## Revisit condition

Consider narrowly scoped auto-approval only for low-risk objective facts with separately documented
policy and audit controls.

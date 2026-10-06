# ADR-0003: Use Temporal.Instant for temporal validity

## Status

Accepted

## Context

Personal OS must distinguish the period in which an Assertion is valid in
the real world from the time at which Personal OS records that Assertion.

The domain model therefore requires temporal validity with:

- validFrom
- optional validUntil

The current project runtime includes Node.js 24 and may also run in browser
and Cloudflare environments.

JavaScript Date is widely available, but it is mutable and combines several
date/time concerns in one API.

Temporal has reached TC39 Stage 4. Native support is available in some
current runtimes, including Node.js 26, but native support is not yet
available across every runtime targeted by Personal OS.

## Decision

Use Temporal.Instant to represent exact instants in the Domain.

Until all supported runtimes provide compatible native Temporal support,
the Domain imports Temporal from the `temporal-polyfill` package.

TemporalValidity represents a half-open interval:

    [validFrom, validUntil)

validFrom is inclusive.

validUntil is exclusive.

A null validUntil represents an open-ended interval.

validUntil earlier than validFrom is invalid.

validUntil equal to validFrom is allowed and represents an empty interval.

recordedAt is not part of TemporalValidity. It represents when Personal OS
recorded an Assertion and belongs to the Assertion or event model.

UUID generation timestamps are also independent from temporal validity.

## Alternatives

### JavaScript Date

Date is supported across the target runtimes without an additional
dependency.

It was not selected because Date is mutable and its API makes it easier to
mix instant, local date/time, and timezone concerns.

### Native Temporal only

Using only the global native Temporal implementation would avoid a
polyfill dependency.

It was not selected because the current Node.js 24 runtime and all target
browser/runtime environments cannot yet be assumed to provide Temporal.

### ISO 8601 strings

The Domain could represent validFrom and validUntil as strings.

This would require repeated parsing and validation and would allow invalid
or semantically incompatible strings to circulate through Domain code.

## Consequences

Domain temporal values are immutable Temporal.Instant objects.

Comparison uses Temporal.Instant.compare.

The Domain has a dependency on `temporal-polyfill` while native Temporal
support remains incomplete across supported runtimes.

Persistence adapters must serialize and restore Temporal.Instant values.

Validity intervals use one consistent boundary rule throughout the system.

## Revisit Conditions

Revisit the polyfill dependency when every supported runtime provides a
compatible native Temporal implementation.

Revisit the temporal model if the Domain needs to represent date-only
validity, uncertain dates, approximate periods, or timezone-dependent civil
time rather than exact instants.

## Related Requirements

- DOM-022
- DOM-023
- DOM-024
- DOM-025
- DOM-026
- DOM-027
- DOM-028

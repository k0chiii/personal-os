# Dependency Boundaries

## Purpose

Personal OS follows an inward dependency direction.

Domain code represents core business concepts and rules.
It must remain independent from infrastructure implementations.

## Core Rule

`packages/domain` must not depend on or import from
`packages/adapters-local`.

Forbidden:

```text
domain ──────X──────> adapters-local
```

Allowed:

```text
adapters-local ─────> domain
```

## Why

Adapters are infrastructure details.
The Domain layer must remain usable without knowing whether
persistence or external services are implemented using:

- SQLite
- Cloudflare
- AWS
- local files
- external APIs

Infrastructure depends inward on the Domain, not the reverse.

## Package-Level Rule

`packages/domain/package.json` must not declare `@personal-os/adapters-local` as a dependency.

## Source-Level Rule

Source files under `packages/domain` must not import:

```ts
import ... from "@personal-os/adapters-local";
```

or otherwise reach into `packages/adapters-local`.

## Future Extension

The same dependency direction is expected to apply to other
adapter packages as the architecture is implemented.

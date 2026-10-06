# ADR-0002: Adopt dependency-cruiser for architecture dependency enforcement

## Status

Accepted

## Context

Personal OS is configured as a modular monolith with explicit package boundaries.

The repository contains, for example, the following packages:

```text
packages/domain
packages/application
packages/ports
packages/adapters-local
packages/adapters-openai
packages/adapters-ollama
packages/adapters-cloudflare
packages/adapters-aws
```

However, simply separating directories and defining packages as a pnpm workspace does not guarantee architectural dependency direction.

pnpm workspace mainly handles:

- Packages belonging to the workspace
- Dependency resolution between packages

and does not handle the architectural rules themselves, such as:

```text
domain must not depend on adapters
```

In Personal OS, it is an important invariant that inner layers do not depend on outer infrastructure implementations.

For example, the following dependencies are prohibited:

```text
domain ──────X──────> adapters-local
domain ──────X──────> adapters-openai
domain ──────X──────> adapters-cloudflare
```

On the other hand, allowing outer adapters to depend on Domain or Ports is acceptable:

```text
adapters-local ─────> domain
adapters-local ─────> ports
```

Such architectural rules must not only be written as documentation, but also be mechanically verifiable.

In ENV-058, we mainly compared the following two options as methods for architecture dependency enforcement:

1. Use a dedicated static dependency analyzer like dependency-cruiser
2. Implement repository-owned architecture tests on Vitest

As a result of the comparison, we emphasize that what we want to verify this time is not the runtime behavior of the application, but the static dependency structure of the source code.

```text
unit / integration test
  → Verifies runtime behavior

architecture dependency check
  → Verifies static structure
```

Due to this difference in responsibility, it is more natural to handle architecture dependency enforcement separately from regular tests.

## Decision

In Personal OS v0.1, we adopt dependency-cruiser for architecture dependency enforcement.

The dependency-cruiser configuration will serve as the Source of Truth for source-level architecture dependency rules.

Initially, we will define at least the following rule:

```text
packages/domain/**
    must not depend on
packages/adapters-*/**
```

In the future, as the architecture becomes more concrete, we will express dependency directions such as:

```text
domain
  X→ application
  X→ adapters
  X→ apps

application
  → domain
  → ports
  X→ concrete adapters

adapters
  → domain
  → ports

apps
  → application
  → adapters
```

We will provide a repository command to run the architecture check:

```text
pnpm check:arch
```

Dependency-cruiser will be executed via this command, utilizing the same rule set in both local development and CI.

Architecture validation will be separated from unit and integration tests:

```text
vp check
  → formatting
  → lint
  → type checking

pnpm check:arch
  → architecture dependency analysis

vp test
  → unit tests
  → integration tests
```

Allowing these to be executed collectively from higher-level commands like Vite Tasks in the future is acceptable, but the responsibilities of each check will remain separated.

## Local Git Hook Policy

To discover architecture violations as early as possible during development, we configure the setup so that `pnpm check:arch` can be executed from Git hooks.

Git hooks are positioned as a developer feedback mechanism, not as the Source of Truth for architectural rules.

```text
git commit / git push
        ↓
pnpm check:arch
        ↓
Early detection of violations
```

Whether to run this during `pre-commit` or `pre-push` will be determined based on the actual execution time of dependency-cruiser.

While the repository is small and sufficiently fast, execution during `pre-commit` is allowed.

If the growth of the repository causes the check to hinder the development workflow, moving it to `pre-push` will be considered.

Execution time will be measured, for example, as follows:

```bash
time pnpm check:arch
```

Because Git hooks can be bypassed with `--no-verify` or similar flags, they will not be used as the ultimate guarantee of architecture enforcement.

## CI Policy

CI will serve as the authoritative enforcement mechanism for architecture dependency rules.

For Pull Requests, the following will be executed at a minimum:

```text
vp check
pnpm check:arch
vp test
```

If `pnpm check:arch` fails, the change will be treated as violating architectural rules, and merging will not be permitted.

This establishes the following structure:

```text
dependency-cruiser configuration
        ↓
Source of Truth for architecture rules

pnpm check:arch
        ↓
Common execution interface

Git hook
        ↓
Local feedback

CI
        ↓
Authoritative enforcement
```

## Package Manifest Validation

The primary target verified by dependency-cruiser is the module dependency graph existing in source code.

On the other hand, cases may exist where invalid dependencies are declared in `package.json`, such as below, but are not yet imported from source code:

```json
{
  "dependencies": {
    "@personal-os/adapters-local": "workspace:*"
  }
}
```

This is a different issue from source dependency analysis.

In the long term, we will consider treating architecture enforcement as two layers:

```text
Architecture Enforcement
├── dependency-cruiser
│   └── source / module dependency graph
│
└── manifest validation
    └── package.json dependency declarations
```

However, in v0.1, we prioritize source-level dependency enforcement via dependency-cruiser.

Manifest validation will be added at the point when its necessity actually becomes clear.

## Alternatives Considered

### Alternative A: Repository-Owned Architecture Tests

We considered implementing architecture tests on Vitest to inspect, for example, `packages/domain/package.json` or source files.

This approach has the following advantages:

- Existing `vp test` infrastructure can be utilized
- No need to add new architecture-analysis tools
- Easy implementation for small invariants
- Rule meanings are directly visible as test code

On the other hand, accurately analyzing source-level dependencies requires handling the following:

```text
static import
re-export
dynamic import
TypeScript module resolution
package alias
circular dependency
transitive dependency
```

Extending this implementation would mean re-implementing parts of a dedicated dependency-analysis tool inside Personal OS.

Because architecture dependency analysis itself is not Personal OS's product domain, we avoid re-implementing in the repository problems that existing dedicated tools already solve.

Therefore, we do not adopt this in v0.1.

### Alternative B: Documentation Only

Recording architecture rules in `docs/architecture` and relying on human code review to verify violations was also considered.

This is the simplest option requiring no additional tools, but architectural rules are not enforced.

As the repository grows, missed violations during reviews and violations by contributors unaware of design intent become more likely to occur.

In Personal OS, because architectural boundaries are considered important invariants, we do not rely solely on documentation.

### Alternative C: TypeScript Configuration Only

Constraining dependency directions using TypeScript project structures, path aliases, package boundaries, etc., was also considered.

However, TypeScript configurations are mainly responsible for module resolution and type checking, and are insufficient for declaring architecture dependency graph policies.

We also want to avoid complicating `tsconfig` for the sake of architecture rule enforcement.

Therefore, TypeScript configuration and architecture enforcement will be treated as separate responsibilities.

## Consequences

### Positive

Architecture dependency rules become machine-checkable.

The separation between Domain and infrastructure can be maintained without relying solely on developer memory or code reviews.

By using a dedicated dependency-analysis tool, there is no need to custom-implement source dependency parsing.

Rules can be managed declaratively.

Easily expandable in the future to:

```text
circular dependency detection
package-level dependency restrictions
layer dependency rules
cross-context restrictions
dependency graph inspection
```

The same `pnpm check:arch` can be utilized from both Git hooks and CI.

The responsibilities of unit / integration tests and architecture validation are separated.

### Negative

Adds a new development dependency and configuration in dependency-cruiser.

Adds one more check that is not completed by Vite+ alone.

Requires understanding and maintaining dependency-cruiser rule syntax and behavior.

Because the source-level dependency graph and `package.json` manifest dependencies are not completely identical issues, separate manifest validation may become necessary in the future.

When running architecture checks in local Git hooks, execution time may affect developer experience as the repository grows.

## Revisit Conditions

This decision will be reconsidered under the following circumstances:

If dependency-cruiser can no longer correctly analyze required dependencies of TypeScript / workspace structures.

If Vite+ or another existing toolchain comes to provide equivalent or superior architecture dependency enforcement.

If the maintenance cost of dependency-cruiser becomes too large compared to the value of the architecture rules.

If a need arises to comprehensively verify package manifests, runtime dependencies, deployment boundaries, etc., in addition to source dependencies.

If architecture rules come to be generated from ontologies or repository metadata, making manual management of dedicated configs unnatural.

If execution time on Git hooks continuously degrades developer experience. In this case, however, rather than deprecating dependency-cruiser itself, moving from `pre-commit` to `pre-push` will be considered first.

## Related Requirements

- ENV-056
- ENV-057
- ENV-058
- ENV-059
- ENV-DOD-03
- ENV-DOD-05

## Related ADRs

- ADR-0001: Adopt Vite+ as the unified TypeScript toolchain

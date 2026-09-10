# Development Toolchain

## Current Toolchain

Personal OS uses Vite+ as the primary TypeScript development
toolchain.

The toolchain includes:

- Vite+
- Oxlint
- Oxfmt
- Vitest
- tsgolint (via `oxlint-tsgolint`)
- Vite Task
- tsdown
- Rolldown

pnpm remains the explicitly selected workspace package manager.

mise remains responsible for the local Node.js and pnpm environment.

## Configuration Boundary

Root `vite.config.ts` is the source of truth for shared static
checks:

- Oxlint
- Oxfmt
- `vp check`
- shared Vitest defaults

Do not add a repository-primary `.oxlintrc.json`, `oxlint.config.ts`,
`.oxfmtrc.json`, or `vitest.config.ts`.

Package-local `vite.config.ts` is allowed when an app needs its own
Vite, Vitest, framework, or runtime configuration. Those files must
not become a second source of truth for root lint, format, or check
policy.

Domain and Application behavior must not be encoded in toolchain
configuration.

```text
common lint / fmt / check
        → root vite.config.ts

app-specific Vite / Vitest / runtime
        → package-local vite.config.ts, when needed

Domain / Application behavior
        → application code, not tool config
```

## Test Layout

`vp test` is the repository test command.

Placement:

```text
unit
  colocated *.test.ts / *.spec.ts
  or tests/unit/**

integration
  tests/integration/**
  or *.integration.test.ts
```

Keep package-specific Vitest setup in that package's `vite.config.ts`
only after the root defaults are insufficient.

## Monorepo Overrides

Root lint overrides express environment and rule differences:

```text
apps/web/**
apps/api/**
apps/mcp-server/**
packages/**
**/*.test.ts
**/*.spec.ts
```

Package-specific rules belong in `lint.overrides`, not in a nested
Oxlint config.

## Standard Commands

```text
vp check   format + lint + type-aware lint + type check
vp test    Vitest
```

CI runs:

```text
pnpm install --frozen-lockfile
vp check
vp test
```

## Architecture Risk: Vite+ Beta

Vite+ is currently beta.

This project accepts that risk because the repository is still in
early development and the unified VoidZero toolchain is useful for
the intended TypeScript monorepo.

### Mitigations

- Pin the project-local `vite-plus` version.
- Upgrade Vite+ explicitly rather than implicitly.
- Keep Vite+ configuration outside Domain and Application code.
- Keep pnpm explicitly declared in `package.json`.
- Keep runtime/package-manager management independent through mise.
- Preserve the ability to use Oxlint, Oxfmt, and Vitest independently
  if necessary.

### Revisit Conditions

Reconsider this decision if:

- breaking changes become frequent,
- CI reproducibility suffers,
- required lint/type-check behavior is unavailable,
- runtime compatibility becomes problematic,
- or Vite+ integration becomes more complex than using the underlying
  tools directly.

## Related ADRs

- ADR-0001 Adopt Vite+ as the unified TypeScript toolchain

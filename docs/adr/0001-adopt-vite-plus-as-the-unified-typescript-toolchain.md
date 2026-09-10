# ADR-0001: Adopt Vite+ as the unified TypeScript toolchain

## Status

Accepted

## Context

Personal OS is an early TypeScript monorepo. It needs a local
development toolchain for linting, formatting, type checking, tests,
and later application/library builds.

The alternatives are a separately assembled ESLint + Prettier +
Vitest + Vite stack, or Biome as a unified but separate lint/format
tool next to Vite/Vitest.

Vite+ is officially beta: stable enough to use, but not complete.
This repository already chose pnpm and mise as the package manager
and environment manager, so the toolchain must not take over those
roles.

## Decision

Adopt Vite+ as the unified TypeScript toolchain.

- Pin the project-local `vite-plus` version exactly.
- Keep configuration in root `vite.config.ts`.
- Use Oxlint with the TypeScript plugin, type-aware lint, and full
  type check.
- Use Oxfmt from the root `fmt` block.
- Use Vitest through the root `test` block.
- Use `vp check` as the standard static-check command.
- Use `vp test` as the standard test command.
- Keep `packageManager: pnpm@12.3.4` explicit.
- Keep Node.js and pnpm management in mise, with `vp env off`.
- Allow package-local `vite.config.ts` only for app-specific Vite,
  Vitest, framework, or runtime configuration.

## Alternatives Considered

### Alternative A: Biome

Biome unifies linting and formatting, but it is a different stack
from Vite, Rolldown, Oxlint, Oxfmt, and Vitest.

Personal OS wants one VoidZero toolchain for the TypeScript monorepo
rather than Biome plus a separate Vite/Vitest assembly.

### Alternative B: Separate ESLint, Prettier, Vitest, and Vite

This is the default assembled JavaScript toolchain. It works, but it
reintroduces multiple config files, version drift, and slower
type-aware lint plus type-check as separate passes.

Vite+ exists specifically to keep those tools in one configuration
and one `vp check` command.

### Alternative C: Let Vite+ manage Node.js and the package manager

Vite+ can manage runtimes itself. This repository already uses mise
and an explicit pnpm pin. Two environment managers for the same
binaries would make local and CI installs harder to reproduce.

## Consequences

### Positive

- Lint, format, type check, and tests share one root config.
- `vp check` and `vp test` are the default developer and CI
  commands.
- Underlying tools remain available if Vite+ integration has to be
  unwound later.

### Negative

- Vite+ is still beta, so upgrades must be explicit.
- Contributors need the `vp` CLI in addition to pnpm.
- Toolchain metadata (`vp toolchain`) and the pnpm lockfile can
  report different transitive versions.

## Fallback

If Vite+ becomes a liability, fall back to the underlying tools
directly:

- Oxlint
- Oxfmt
- Vitest
- Vite / Rolldown
- tsgolint via `oxlint-tsgolint`

Keep those tools out of Domain and Application packages so the
fallback does not rewrite business code.

## Revisit Conditions

Reconsider this decision if:

- Vite+ breaking changes become frequent,
- Cloudflare or Node runtime compatibility becomes a serious
  problem,
- required type-checking or lint rules are unavailable,
- CI reproducibility declines,
- or Vite+ integration becomes more complex than using the
  underlying tools directly.

## Related Requirements

- ENV-025
- ENV-026
- ENV-027
- ENV-028
- ENV-029
- ENV-030
- ENV-031
- ENV-032
- ENV-033
- ENV-034
- ENV-035
- ENV-036
- ENV-037
- ENV-038
- ENV-039

## Related ADRs

- None

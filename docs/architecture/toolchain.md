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

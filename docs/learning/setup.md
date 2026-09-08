# Development Environment

## Environment Manager

mise

## Node.js

```text
v24.18.0
```

## Package Manager

```text
12.3.4
```

## Vite+

```text
vp v0.3.0

Local vite-plus:
  vite-plus  v0.3.0

Tools:
  vite             v8.2.2
  rolldown         v1.2.5
  vitest           v4.1.11
  oxfmt            v0.64.0
  oxlint           v1.79.0
  oxlint-tsgolint  v7.0.2001
  tsdown           v0.22.14

Environment:
  Package manager  pnpm v12.3.4
  Node.js          v24.20.0
```

## Global Vite+ Toolchain

```text
Vite+ toolchain (global)

vite-plus@0.3.0
├── depends on @voidzero-dev/vite-plus-core@0.3.0
│   ├── bundles vite@8.2.2
│   │   └── uses rolldown@1.2.5
│   │       ├── compiles oxc@0.146.0
│   │       └── compiles oxc-resolver@11.24.2
│   ├── bundles rolldown@1.2.5
│   │   ├── compiles oxc@0.146.0
│   │   └── compiles oxc-resolver@11.24.2
│   └── bundles tsdown@0.22.14
├── depends on vitest@4.1.11
├── depends on oxlint@1.79.0
├── depends on oxlint-tsgolint@7.0.2001
├── depends on oxfmt@0.64.0
└── compiles vite-task (built 2026-08-24T03:41:26Z, revision d05b1dcdbaabaa69643ee0b89cebe3cd390957e9)
```

## Project Vite+ Toolchain

```text
Vite+ toolchain (local)

vite-plus@0.3.0
├── depends on @voidzero-dev/vite-plus-core@0.3.0
│   ├── bundles vite@8.2.2
│   │   └── uses rolldown@1.2.5
│   │       ├── compiles oxc@0.146.0
│   │       └── compiles oxc-resolver@11.24.2
│   ├── bundles rolldown@1.2.5
│   │   ├── compiles oxc@0.146.0
│   │   └── compiles oxc-resolver@11.24.2
│   └── bundles tsdown@0.22.14
├── depends on vitest@4.1.11
├── depends on oxlint@1.79.0
├── depends on oxlint-tsgolint@7.0.2001
├── depends on oxfmt@0.64.0
└── compiles vite-task (built 2026-08-24T03:41:26Z, revision d05b1dcdbaabaa69643ee0b89cebe3cd390957e9)
```

## Environment Policy

mise manages Node.js and pnpm.

Vite+ environment management is disabled with:

```text
vp env off
```

Vite+ is used as the repository toolchain rather than as the
authoritative runtime manager.

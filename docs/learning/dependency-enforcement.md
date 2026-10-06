# Architecture Dependency Enforcement

## この内容を学ぶ理由

Personal OS は、明示的な package boundary を持つ modular monolith として構成する。

`packages/domain` や `packages/adapters-local` のようにディレクトリを分けただけでは、architecture は自動的には守られない。

TypeScript では、architecture 上は禁止したい dependency であっても、通常の import として記述できる。

たとえば Domain layer から infrastructure adapter への依存は認めない。

禁止する dependency:

```text
domain ──────X──────> adapters-local
```

一方で、外側の infrastructure adapter が内側の Domain や Port に依存することは認める。

```text
adapters-local ─────> domain
adapters-local ─────> ports
```

Architecture dependency enforcement の目的は、このようなルールを、

```text
開発者が覚えて守る規約
```

ではなく、

```text
違反したら機械的に検出される制約
```

にすることである。

関連タスク:

- `ENV-056`
- `ENV-057`
- `ENV-058`
- `ENV-059`

## 学ぶ前の理解

当初は、package boundary は主にディレクトリ構造や pnpm workspace によって作られるものだと考えていた。

たとえば、

```text
packages/domain
packages/application
packages/adapters-local
```

と分離すれば、それだけである程度 architecture が守られるようにも見える。

しかし pnpm workspace が定義しているのは主に、

- どの package が workspace に所属するか
- workspace package をどのように解決するか

である。

pnpm 自体は、

```text
domain must not depend on adapters
```

という architecture rule を知らない。

したがって、

```text
workspace structure
```

と、

```text
architecture dependency policy
```

は別の概念として考える必要がある。

## Workspace Dependency と Architecture Rule の違い

たとえば `packages/application/package.json` に、

```json
{
  "dependencies": {
    "@personal-os/domain": "workspace:*"
  }
}
```

と書くことは、

```text
application → domain
```

という dependency を宣言することである。

`workspace:*` は、

> この dependency を workspace 内の package から解決する

という指定であり、

> この dependency direction が architecture 上正しい

ことを保証するものではない。

つまり、以下は別々の層である。

```text
pnpm workspace
    ↓
どの package が workspace に存在するか

package.json dependencies
    ↓
どの package がどの package に依存するか

architecture rule
    ↓
どの dependency direction を許可するか

architecture enforcement
    ↓
rule 違反をどのように機械的に検出するか
```

## 今回守りたい Architecture Rule

最初の rule は意図的に単純にする。

> `packages/domain` は infrastructure adapter に依存してはならない。

禁止したい例:

```ts
import { Something } from "@personal-os/adapters-local";
```

type-only import であっても dependency とみなす。

```ts
import type { Something } from "@personal-os/adapters-local";
```

また、package name を使わず相対 import で迂回することも認めない。

```ts
import type { Something } from "../../adapters-local/src/something";
```

重要なのは、特定の文字列を禁止することではない。

本質的な rule は、

> Domain が concrete infrastructure implementation の存在を知らない

ということである。

Domain は将来 infrastructure が、

- SQLite
- local file
- Cloudflare D1
- AWS
- OpenAI API
- Ollama

などのどれで実装されても、それ自体の model や rule を変更せずに利用できる状態を目指す。

## Runtime Test と Static Architecture Check

今回検証したいものは application behavior ではない。

```text
unit / integration test
  → 実行した結果や振る舞いを検証する

architecture dependency check
  → source code の静的構造を検証する
```

という違いがある。

たとえば、

```text
domain → adapters-local
```

が存在するかどうかを調べるために application を実行する必要はない。

source code 上の dependency を静的に解析すればよい。

そのため architecture dependency enforcement は、通常の unit test より static analysis として扱う方が自然だと考えた。

## 最初に比較した選択肢

当初は主に以下を比較した。

1. dependency-cruiser のような専用 dependency-analysis tool
2. repository-owned architecture test
3. documentation と code review のみによる運用

この中では、最初は dependency-cruiser が最も筋がよいように感じた。

理由は、dependency graph の検査そのものを目的とした専用 tool だからである。

## dependency-cruiser に期待したこと

dependency-cruiser は JavaScript / TypeScript の module dependency graph を解析する tool である。

概念的には、

```text
packages/domain/**
```

から、

```text
packages/adapters-*/**
```

への dependency を禁止する rule を宣言できる。

専用 tool なので、

- forbidden dependency
- dependency direction
- circular dependency
- dependency graph analysis
- cross-package restriction

などを扱える。

source code を単純な文字列として検索するよりも、dependency graph として扱える点も魅力だった。

## Repository-Owned Architecture Test の問題

Vitest 上に architecture test を実装する方法も検討した。

たとえば、

```text
packages/domain 以下を検索して
@personal-os/adapters-* が存在したら fail
```

という test は簡単に作れる。

しかし、この方法を正確にしていこうとすると、

- static import
- re-export
- dynamic import
- type-only import
- TypeScript module resolution
- package alias
- circular dependency
- transitive dependency

などを扱う必要がある。

ここまで来ると、

> dependency-analysis tool を Personal OS 内部で再実装する

状態になってしまう。

Architecture analysis 自体は Personal OS の product domain ではないため、この方向には進まないことにした。

また、architecture dependency は runtime behavior ではないため、毎回通常の test suite の一部として扱うことにも違和感があった。

## dependency-cruiser を実際に試した

比較だけで終わらせず、dependency-cruiser 18.5.0 を実際に Personal OS repository に導入して確認した。

まず、

```bash
pnpm exec dependency-cruiser --info
```

を実行した。

Node.js 24 は対応していた。

一方 TypeScript については、

```text
typescript   >=2.0.0 <7.0.0
```

と表示された。

Personal OS は TypeScript 7.0.2 を利用している。

その結果、

```text
x typescript
x .ts
x .tsx
x .d.ts
```

となり、dependency-cruiser から TypeScript compiler が利用可能な transpiler として認識されなかった。

さらに、

```bash
pnpm exec dependency-cruiser --init
```

を実行した。

以下は正しく認識された。

- monorepo
- ESM package
- packages directory
- TypeScript configuration

また、

```text
Also regard TypeScript dependencies that exist only before compilation?
```

についても `yes` を選択した。

これは、

```ts
import type { Something } from "...";
```

のような compile 後に消える dependency も architecture coupling として扱いたかったためである。

しかし initialization の最後で、

```text
TypeScript compiler not found
```

という warning が表示された。

これは TypeScript 自体が repository に存在しないという意味ではなく、dependency-cruiser が対応している TypeScript version range に 7.0.2 が含まれていないためだった。

## TypeScript を下げる案

dependency-cruiser を利用するため、

```text
TypeScript 7
↓
TypeScript 6
```

へ downgrade する案も考えた。

ただし Personal OS ではすでに TypeScript 7 を toolchain の一部として利用している。

Architecture checker を導入するためだけに primary language toolchain を過去 version へ合わせるのは、

```text
project toolchain
  ↓
architecture tool
```

ではなく、

```text
architecture tool
  ↓
project toolchain
```

に設計判断が引っ張られているように感じた。

これは望ましくない。

また、正式な compatibility range 外の dependency-cruiser をそのまま使う方法も考えられるが、architecture enforcement の信頼性を高めるために導入する tool 自体を unsupported configuration で動かすのは矛盾している。

そのため dependency-cruiser は v0.1 では採用しないことにした。

## 既存 Toolchain の再確認

dependency-cruiser が利用しにくいことが分かったため、既存の Vite+ / Oxlint toolchain で同じ目的を達成できないかを確認した。

現在 Personal OS はすでに、

```text
Vite+
  ↓
Oxlint
```

を static analysis の中心にしている。

Oxlint には architecture enforcement に利用できる rule が存在する。

特に、

```text
no-restricted-imports
```

と、

```text
import/no-cycle
```

が今回の v0.1 requirements に合っていた。

## Oxlint の `no-restricted-imports`

`no-restricted-imports` を Domain package に対する override として設定する。

概念的には、

```text
packages/domain/**
        X
        └── @personal-os/adapters-*
```

を表現する。

package name 経由の dependency を禁止する。

```ts
import { Something } from "@personal-os/adapters-local";
```

type-only import も禁止する。

```ts
import type { Something } from "@personal-os/adapters-local";
```

さらに相対 import による迂回も禁止する。

```ts
import type { Something } from "../../adapters-local/src/something";
```

実際の configuration は概ね以下の形になる。

```ts
{
  files: ["packages/domain/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["@personal-os/adapters-*"],
            message:
              "Domain must not depend on infrastructure adapters.",
          },
          {
            regex:
              "^(\\.\\./)+(packages/)?adapters-[^/]+(/|$)",
            message:
              "Domain must not bypass package boundaries with relative imports.",
          },
        ],
      },
    ],
  },
}
```

これにより、Domain layer から concrete adapter implementation への dependency を static lint error として扱える。

## Circular Dependency

Architecture violation は layer crossing だけではない。

たとえば、

```text
A → B
↑   ↓
└── C
```

のような cycle も dependency graph を理解しにくくする。

そのため、

```text
import/no-cycle
```

も有効にする。

Personal OS では type-only dependency も architecture coupling と考えるため、

```ts
ignoreTypes: false;
```

とする。

概念的には、

```ts
"import/no-cycle": [
  "error",
  {
    ignoreTypes: false,
  },
]
```

となる。

## Oxlint を選ぶ理由

Oxlint を採用することで、

```text
Vite+
└── Oxlint
    ├── normal lint rules
    ├── TypeScript related checks
    ├── architecture import restrictions
    └── circular dependency checks
```

という構造になる。

dependency-cruiser を追加する場合に必要だった、

```text
dependency-cruiser dependency
dependency-cruiser config
pnpm check:arch
additional CI step
```

が不要になる。

つまり architecture enforcement のためだけに別の static-analysis pipeline を作らずに済む。

これは既存の Vite+ toolchain を統一的な入口として保つという Personal OS の方針とも整合する。

## `vp test` ではなく `vp check`

最初に感じていた、

> architecture rule を毎 test 検証するのは責務として変ではないか

という違和感も、Oxlintを採用することで解消された。

構造は、

```text
vp check
├── static lint
├── type-related checks
├── architecture boundary enforcement
└── cycle detection

vp test
├── unit test
└── integration test
```

となる。

architecture dependency は static structure なので `vp check` が担当する。

behavior は `vp test` が担当する。

この分離はかなり自然である。

## CI との統合

Personal OS の CI はすでに、

```text
vp check
vp test
```

を実行している。

したがって architecture enforcement を Oxlint に追加すると、CI pipeline を別途増やさなくても、そのまま architecture violation が CI failure になる。

構造は、

```text
vite.config.ts
      ↓
Oxlint architecture rules
      ↓
vp check
      ↓
GitHub Actions
      ↓
merge gate
```

となる。

これは local と CI で同じ static-analysis command を利用できるという利点もある。

## Negative Test による確認

configuration を追加しただけでは、本当に機能しているかは分からない。

特に現時点では Domain package に実コードがほとんど存在しないため、

```text
rule が正しいから green
```

なのか、

```text
解析対象がないから green
```

なのかを区別する必要がある。

そこで一時的に、

```text
packages/domain
    ↓
packages/adapters-local
```

という禁止 dependency を作成した。

relative TypeScript import を用いて意図的に Domain から adapter へ依存させた状態で、

```bash
vp check
```

を実行した。

その結果 `vp check` は期待どおり失敗した。

その後、temporary violation を削除すると再び check が成功した。

これにより、

> architecture rule が実際に enforcement として機能している

ことを確認できた。

## package.json Dependency は別問題

Oxlint の `no-restricted-imports` は source code 上の dependency を検査する。

一方、

```json
{
  "dependencies": {
    "@personal-os/adapters-local": "workspace:*"
  }
}
```

のように `package.json` に dependency を追加しただけで、source code ではまだ import していない場合は別の問題になる。

したがって、将来的には、

```text
Architecture Enforcement
├── source dependency
│   └── Oxlint
│
└── package manifest dependency
    └── future validation
```

の二層になる可能性がある。

v0.1 では source dependency direction を優先して enforce する。

manifest validation は、package dependency graph が実際に複雑になった段階で追加を検討する。

## 現時点での Architecture Enforcement

v0.1 の構造は以下とする。

```text
Source Code
    ↓
Oxlint
├── no-restricted-imports
│   └── Domain → Adapter を禁止
│
└── import/no-cycle
    └── circular dependency を禁止
    ↓
vp check
    ↓
CI
```

architecture rule の Source of Truth は Vite+ / Oxlint configuration となる。

## dependency-cruiser を試したことの意味

dependency-cruiser を一度選びかけたこと自体は無駄ではなかった。

むしろ、

```text
architecture dependency
    ↓
runtime test ではなく static analysis
```

という問題の性質を明確にできた。

さらに実際に tool を導入して、

```text
dependency-cruiser
    ↓
TypeScript 7 compatibility problem
```

を確認したことで、

```text
既存 Oxlint で必要十分な enforcement が可能か
```

という次の問いにつながった。

最終的に追加 tool を使わない結論になったが、

```text
何も検討せず既存toolを使った
```

のではなく、

```text
専用toolを比較
↓
実際に導入
↓
compatibilityを確認
↓
既存toolchainを再評価
↓
より単純な構成へ戻した
```

という意思決定になった。

この過程は ADR に残す価値がある。

## 今回学んだこと

最も重要なのは、

```text
monorepo
≠
package dependency
≠
architecture rule
≠
architecture enforcement
```

という区別である。

また、

```text
architecture enforcement
```

は必ずしも専用architecture toolを導入することを意味しない。

必要なのは、

> 守りたい invariant を、十分信頼できる方法で機械的に検証すること

である。

v0.1 の Personal OS では、既存の Oxlint がその役割を十分に担える。

新しい tool を追加することそのものに価値があるわけではない。

既存toolchainで必要な invariant を明確かつ安全に enforce できるなら、その方が構成は単純になる。

## 将来再検討する条件

現在の Oxlint-based enforcement は v0.1 の規模には適している。

ただし以下の場合には再検討する。

- package 数が大幅に増えた
- allowed dependency matrix が複雑になった
- bounded context 間の制約が増えた
- manifest dependency も同時に検証したくなった
- architecture graph を可視化したくなった
- cross-package rule が lint override では管理しにくくなった
- dependency-cruiser が TypeScript 7 に正式対応した
- Nx 等の project graph が別の理由でも必要になった

その場合でも、

```text
domain must not depend on concrete adapters
```

という architecture invariant 自体は維持する。

変更されるのは enforcement tool であり、architecture rule そのものではない。

## 関連 Architecture

- `docs/architecture/dependency-boundaries.md`

## 関連 ADR

- `ADR-0002: Enforce architecture dependency boundaries with Oxlint`

## References

- Oxlint documentation
- Vite+ documentation
- dependency-cruiser documentation
- pnpm workspace documentation
- Personal OS architecture documentation

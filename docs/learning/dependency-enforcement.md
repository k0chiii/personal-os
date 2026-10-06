# Architecture Dependency Enforcement

## この内容を学ぶ理由

Personal OS は、明示的な package boundary を持つ modular monolith として構成する。

`packages/domain` や `packages/adapters-local` のようにディレクトリを分けただけでは、architecture は自動的には守られない。TypeScript は、禁止したい依存方向であっても、通常の import として書けてしまう。

たとえば、Domain layer から infrastructure adapter への依存は認めない。

禁止する依存方向:

```text
domain ──────X──────> adapters-local
```

一方で、外側の infrastructure が内側の Domain に依存することは認める。

```text
adapters-local ─────> domain
```

Architecture dependency enforcement の目的は、このようなルールを「開発者が覚えて守る規約」ではなく、「違反したら自動的に検出できる制約」にすることである。

関連タスク:

- `ENV-056`
- `ENV-057`
- `ENV-058`
- `ENV-059`

## 学ぶ前の理解

当初は、package boundary は主にディレクトリ構造や pnpm workspace によって作られるものだと考えていた。

たとえば、以下のように分離すれば、

```text
packages/domain
packages/application
packages/adapters-local
```

不適切な依存もある程度防げるように見える。

しかし、pnpm workspace が定義するのは主に、

- どの package が workspace に所属するか
- workspace 内の package をどのように解決するか

ということであり、

```text
domain must not depend on adapters-local
```

のような architecture rule そのものではない。

そのため、package 構造とは別に、dependency direction を検証する仕組みが必要になる。

## 今回守りたい Architecture Rule

Personal OS で最初に守るルールは、意図的に単純なものとする。

> `packages/domain` は infrastructure adapter package に依存してはならない。

少なくとも、`packages/domain/package.json` に以下のような dependency が存在してはいけない。

```json
{
  "dependencies": {
    "@personal-os/adapters-local": "workspace:*"
  }
}
```

また、Domain の source code が以下のような import を持つことも認めない。

```ts
import { Something } from "@personal-os/adapters-local";
```

ただし、本質的なルールは「特定の import 文を禁止する」ということではない。

重要なのは、

> Domain layer が infrastructure implementation の存在を知らない

ということである。

Domain は、永続化や外部通信が具体的に何で実装されているかに依存しない。

たとえば、将来 infrastructure が以下のどれで実装されても、Domain 自体は変更されない状態を目指す。

- SQLite
- local file system
- Cloudflare D1
- AWS
- external API

つまり、外側の layer が内側へ依存し、内側の layer は外側の implementation を知らない構造を維持する。

## 比較する選択肢

Architecture dependency を機械的に検証する方法として、以下の2案を比較する。

1. dependency-cruiser のような専用 dependency-analysis tool を利用する
2. repository 内に architecture test を自作する

## 選択肢A: dependency-cruiser

dependency-cruiser は、JavaScript / TypeScript の module dependency graph を解析するための専用 tool である。

たとえば概念的には、

```text
packages/domain/**
```

から、

```text
packages/adapters-*/**
```

への依存を禁止する、といった rule を定義できる。

### 利点

専用 tool なので、dependency graph の解析に強い。

たとえば以下のようなルールを扱いやすい。

- 禁止された dependency の検出
- layer 間の依存方向の制約
- circular dependency の検出
- package 間の dependency 制限
- dependency graph の可視化・解析

package 数や architecture rule が増えるほど、専用 tool の価値は高くなる。

また、source code を単純な文字列として扱うのではなく、dependency graph として解析するため、architecture enforcement の用途に適している。

### 欠点

repository に新しい tool と、そのための設定を追加する必要がある。

Personal OS ではすでに、

```text
Vite+
  ├── vp check
  └── vp test
```

という標準的な実行経路を作っている。

ここに dependency-cruiser を追加すると、

- どの config file を Source of Truth にするか
- CI でどの command を実行するか
- Vite+ とどのように役割分担するか
- tool version をどのように管理するか

といった新しい設計判断が必要になる。

現時点では architecture rule の数が少ないため、専用 tool の能力が過剰である可能性もある。

## 選択肢B: Repository-Owned Architecture Test

もう一つの方法は、architecture rule 自体を通常の test として表現する方法である。

たとえば、

```text
packages/domain/package.json
```

を読み込み、adapter package が dependency に含まれていないことを Vitest で検証する。

architecture test は、たとえば以下に置く。

```text
tests/architecture/
```

そして既存の、

```text
vp test
```

から実行する。

### 利点

すでに存在する test infrastructure をそのまま利用できる。

新しい architecture analysis tool を導入せず、

```text
vp test
```

の中に architecture validation を含められる。

また、Personal OS 固有の architecture rule を、その意味に近い形で test として表現できる。

たとえば、

```text
domain must not depend on adapters
```

というルールを、そのまま test case に近い形で書ける。

これは、architecture を学びながら実装する段階では特に有用である。

rule がどのように検証されているかが隠蔽されにくく、仕組み自体を理解しやすい。

### 欠点

自作 test は、実装した範囲しか検証できない。

たとえば、source file 内から、

```text
@personal-os/adapters-local
```

という文字列を単純に検索するだけでは、完全な dependency analysis にはならない。

コメントにも反応する可能性がある。

```ts
// @personal-os/adapters-local は使用禁止
```

一方で、import の書き方によっては十分に検出できない可能性もある。

より正確に source-level dependency を解析しようとすると、

- static import
- export / re-export
- dynamic import
- TypeScript module resolution
- package alias
- path mapping

などを扱う必要が出てくる。

そこまで進むと、Personal OS のために小さな dependency-cruiser を自作する状態になり、本来の目的から外れてしまう。

## 比較

| 観点                           | dependency-cruiser              | 自作 Architecture Test  |
| ------------------------------ | ------------------------------- | ----------------------- |
| 禁止 dependency の検出         | 強い                            | 自分で実装する          |
| dependency graph の解析        | 標準機能                        | 自作が必要              |
| circular dependency            | 検出可能                        | 別途実装が必要          |
| package.json dependency の検査 | 可能                            | 簡単に実装可能          |
| source import の解析           | 得意                            | 実装方法次第            |
| 新しい tool dependency         | 増える                          | 増えない                |
| `vp test` との統合             | 別途統合が必要                  | 自然に統合可能          |
| 初期設定コスト                 | やや高い                        | 低い                    |
| 少数 rule への適性             | やや過剰                        | 高い                    |
| 大規模 dependency graph        | 高い                            | 維持が難しくなる        |
| 学習上の透明性                 | tool の設定を理解する必要がある | rule の実装が直接見える |

## 重要な区別: 文字列検索と Dependency Analysis

自作 architecture test を採用する場合でも、単純な文字列検索をそのまま完全な dependency analysis と考えてはいけない。

たとえば、

```text
packages/domain 以下の全ファイルを読む
↓
"@personal-os/adapters-" を検索する
↓
見つかったら失敗
```

という方法は簡単だが、architecture analysis としては限定的である。

false positive や false negative が発生する可能性がある。

そのため、自作 test は、まず以下のような単純かつ明確な invariant の検証に向いている。

```text
packages/domain/package.json は
adapter package を dependency に持ってはならない
```

source-level dependency の解析が複雑になってきた場合は、自作実装を拡張し続けるのではなく、専用 dependency-analysis tool の導入を検討すべきである。

## 学んだこと

Monorepo を作ることと、architecture boundary を作ることは同じではない。

以下は別の概念である。

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
違反をどのように自動検出するか
```

たとえば、`packages/application/package.json` に、

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

という実際の dependency を定義する。

しかし pnpm は、

```text
domain → adapters-local
```

を architecture 上禁止したいという意図までは知らない。

つまり architecture を維持するためには、

```text
documentation
+
machine-checkable rule
```

の両方が必要になる。

## Personal OS への設計上の示唆

Personal OS では、重要な architecture boundary を単なる慣習としてではなく、実行可能な制約として扱うべきである。

一方で、enforcement mechanism の複雑さは repository の規模に見合ったものにする必要がある。

v0.1 の段階では architecture rule の数が少ないため、過度に複雑な dependency-analysis infrastructure を導入する必要はない。

重要なのは、最初から完璧な dependency graph analyzer を作ることではなく、

```text
守りたい architecture invariant
↓
機械的に検証する
```

という習慣を作ることである。

将来的に以下のような状況になった場合は、専用 tool の導入を再検討する。

- package 数が大幅に増えた
- package ごとの dependency rule が増えた
- circular dependency の検出が必要になった
- allowed / forbidden dependency の組み合わせが複雑になった
- source-level dependency analysis の自作が難しくなった
- architecture test が専用 dependency-analysis tool の機能を再実装し始めた

このような状態は、自作 test をさらに巨大化させる理由ではなく、専用 tool へ移行するシグナルと考える。

## 未解決の問い

- v0.1 の architecture test は `package.json` の dependency だけを検査すべきか、それとも source import まで検査すべきか
- architecture rule が何個程度になったら dependency-cruiser の導入を検討すべきか
- architecture validation は将来的に `vp check` に含めるべきか、それとも `vp test` に残すべきか
- `ports`、`application`、複数の adapter package に実装が入り始めたとき、dependency rule をどこまで細かく定義すべきか
- 将来的に package 間の依存を完全な allowed dependency matrix として定義するべきか

## 関連 Architecture

- `docs/architecture/dependency-boundaries.md`

## 関連 ADR

最終的な v0.1 の enforcement 方針は、別途 ADR で決定する。

- `ADR-0002: Architecture dependency enforcement`

## References

- pnpm workspace protocol documentation
- dependency-cruiser documentation
- Personal OS architecture documentation

## 追記: 比較後の考え

比較を進める中で、Personal OS の architecture dependency enforcement は、Vitest 上の自作 test よりも dependency-cruiser のような専用の static dependency analyzer を利用する方が設計上自然だと考えるようになった。

当初は、既存の `vp test` に architecture test を統合することで、新しい tool を増やさずに済むという利点を重視していた。

しかし、今回検証したいものは application behavior ではなく、source code の静的な dependency structure である。

つまり、

```text
unit / integration test
  → 実行時の振る舞いを検証する

architecture dependency check
  → source code の構造を静的に検証する
```

という責務の違いがある。

この観点から見ると、architecture rule を毎回 Vitest の test case として検証するよりも、dependency graph を解析するために設計された専用 tool に任せる方が責務の分離として自然である。

## Static Analysis を選びたい理由

Personal OS で守りたいのは、たとえば以下のような rule である。

```text
packages/domain
    X
    └── packages/adapters-*
```

これは「ある入力に対して期待した出力が得られるか」という test ではない。

repository の dependency graph が、定義した architecture constraint を満たしているかという静的な問題である。

そのため理想的には、source code を実行せずに、

```text
source code
    ↓
import / export dependency graph
    ↓
architecture rules
    ↓
violation detection
```

という形で検証したい。

dependency-cruiser はこの用途を直接扱うため、自作 test で dependency parser を徐々に再実装するよりも筋がよい。

## 自作 Architecture Test に対する再評価

自作 architecture test にも、以下の利点はある。

- 既存の Vitest infrastructure を利用できる
- rule の意味が test code として明示される
- 小さな invariant であれば実装が容易

一方で、source-level dependency を正確に検証しようとすると、

- static import
- re-export
- dynamic import
- TypeScript module resolution
- package alias
- circular dependency
- transitive dependency

などを扱う必要が出てくる。

ここまで実装を広げると、Personal OS の architecture を検証するために、簡易的な dependency-analysis tool を自作することになる。

これは本来の Personal OS の開発対象ではない。

そのため、

> 専用 tool がすでに解決している問題を repository 固有の test infrastructure として再実装しない

という判断を重視する。

## dependency-cruiser を利用する場合の役割

dependency-cruiser の configuration を architecture dependency rule の Source of Truth とする。

概念的には以下のような rule を宣言する。

```text
from:
  packages/domain/**

must not depend on:
  packages/adapters-*/**
```

将来的には、必要に応じて以下のような rule に拡張できる。

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

これにより architecture dependency を単なる documentation ではなく、実際の dependency graph に対する executable constraint として扱える。

## Test と Architecture Check を分離する

architecture dependency check は `vp test` の一部として扱うのではなく、独立した repository check とする。

たとえば、

```text
vp check
  → format
  → lint
  → type check

pnpm check:arch
  → dependency-cruiser

vp test
  → unit test
  → integration test
```

のように責務を分離する。

将来的に Vite Task 等を利用して一つの上位 command にまとめることはできるが、内部的な責務まで同一視する必要はない。

## Git Hook と CI の役割

architecture violation は、できるだけ開発者が早い段階で検出できることが望ましい。

そのため local development では Git hook から architecture check を実行する。

ただし Git hook だけを enforcement mechanism としてはいけない。

Git hook は、

```text
git commit / git push
    ↓
architecture check
    ↓
違反を早期に通知
```

という developer feedback mechanism である。

一方、CI は、

```text
pull request
    ↓
architecture check
    ↓
違反があれば merge を失敗させる
```

という authoritative enforcement mechanism とする。

Git hook は `--no-verify` 等で回避できるため、architecture rule の保証は CI 側で行う。

したがって、

```text
dependency-cruiser config
        ↓
architecture rule の Source of Truth

pnpm check:arch
        ↓
共通実行 command

Git hook
        ↓
高速な local feedback

CI
        ↓
必須 enforcement
```

という構成を目指す。

## pre-commit と pre-push の選択

architecture check を `pre-commit` と `pre-push` のどちらで実行するかは、実行時間によって判断する。

repository が小さいうちは dependency-cruiser の解析時間も短いため、`pre-commit` で実行しても開発体験を大きく損なわない可能性が高い。

一方、repository が成長し解析時間が長くなった場合、毎 commit ごとに全 dependency graph を解析するのは開発の妨げになる。

その場合は、

```text
pre-commit
  → formatter / lint など高速な処理

pre-push
  → architecture check
  → 必要に応じて test

CI
  → 全ての必須 check
```

のように移行する。

この判断は固定的な思想ではなく、実際の実行時間を測定して決める。

たとえば、

```bash
time pnpm check:arch
```

を利用し、local feedback と実行コストのバランスを確認する。

## package.json Dependency との違い

dependency-cruiser が主に解析するのは、source code 上に実際に存在する module dependency である。

一方で、

```json
{
  "dependencies": {
    "@personal-os/adapters-local": "workspace:*"
  }
}
```

のように `package.json` に dependency を宣言したものの、source code からまだ import していない場合は別の問題になる。

そのため、長期的には architecture enforcement を、

```text
Architecture Enforcement
├── dependency-cruiser
│   └── source / module dependency graph
│
└── manifest validation
    └── package.json dependency declarations
```

の二層として考える余地がある。

ただし v0.1 では、まず実際の source dependency direction を dependency-cruiser で守ることを優先し、manifest validation は必要性が明確になった段階で追加する。

## 現時点での結論

ENV-058 の比較を踏まえ、v0.1 では dependency-cruiser を architecture dependency enforcement に利用する方針が最も自然だと考える。

理由は以下である。

- architecture dependency は runtime behavior ではなく static structure の問題である
- dependency graph analysis を自作する必要がない
- architecture rule を宣言的に表現できる
- circular dependency などへ自然に拡張できる
- package 数が増えても同じ仕組みを利用できる
- Git hook と CI の双方から同じ command を実行できる
- unit / integration test と architecture validation の責務を分離できる

正式な採用判断とその consequences は ADR-0002 に記録する。

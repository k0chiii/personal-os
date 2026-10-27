# Cloudflare セットアップ手順

この手順は Personal OS を Cloudflare Workers、D1、R2、Vectorize、Access で一人運用する
ためのものです。正規イベントはD1、Raw EvidenceはR2、再生成可能なベクトルはVectorizeへ
保存します。

## 1. 前提条件

- Node.js 22、pnpm、RTK
- Workers、D1、R2、Vectorize、Zero Trust Access を使える Cloudflare アカウント
- Accessで許可する自分のメールアドレス
- 本番では管理中のカスタムドメイン

リポジトリのルートで依存関係と全体を検証します。

```bash
rtk pnpm install --frozen-lockfile
rtk pnpm check
rtk pnpm test
rtk pnpm --filter @personal-os/web build
rtk pnpm --dir apps/worker exec wrangler login
rtk pnpm --dir apps/worker exec wrangler whoami
```

## 2. ストレージとベクトル索引

名前を変更する場合は `apps/worker/wrangler.jsonc` の各 binding も同じ名前へ変更します。

```bash
rtk pnpm --dir apps/worker exec wrangler d1 create personal-os
rtk pnpm --dir apps/worker exec wrangler r2 bucket create personal-os-evidence
rtk pnpm --dir apps/worker exec wrangler vectorize create personal-os-assertions \
  --dimensions=256 \
  --metric=cosine
```

D1作成結果の `database_id` を `apps/worker/wrangler.jsonc` の
`replace-with-d1-database-id` と置き換えます。次にリモートD1へスキーマを適用します。

```bash
rtk pnpm --filter @personal-os/worker db:migrate:remote
```

## 3. 任意の OpenAI キー

OpenAIを使う場合だけWorker Secretへ登録します。使わない場合、シミュレーション以外は動作
します。値を設定ファイルや通常の `vars` へ置かないでください。

```bash
rtk pnpm --dir apps/worker exec wrangler secret put OPENAI_API_KEY
```

モデル名を変える場合は `wrangler.jsonc` の `vars.OPENAI_MODEL` に非秘密のモデル名を追加
します。

## 4. Worker の初回デプロイ

```bash
rtk pnpm --filter @personal-os/web build
rtk pnpm --filter @personal-os/worker run deploy
```

pnpm 12 は `deploy` を組み込みコマンドとして扱うので、`run deploy` で Worker のスクリプトを呼びます。
`apps/web/dist` もWorkerの静的アセットとして配信されます。`wrangler.jsonc` は
`workers_dev: false` と `preview_urls: false` を指定しているため、デプロイしても `workers.dev`
URL とプレビューURLは公開されません。Access設定が終わるまで個人データを投入しないでください。

## 5. カスタムドメインと Cloudflare Access

Workerは `CF-Access-Authenticated-User-Email` を認証済み主体として使います。このヘッダーを
外部から偽装できないことがセキュリティ境界です。

1. Workers & Pages の対象Workerで、カスタムドメイン `personal.example.com` を追加する。
2. Zero Trust > Access > Applications で Self-hosted application を追加する。
3. Application domain を `personal.example.com/*` とし、自分のメールだけを `Allow` する。
4. 外部監視が必要なら、`/health` 専用のAccessポリシーと認証方法を別に設計する。
5. ダッシュボードで `workers.dev` やプレビューURLを有効にしない。`wrangler.jsonc` の `workers_dev` と `preview_urls` は `false` のままにし、代替の公開経路を残さない。
6. `wrangler.jsonc` の `REQUIRE_ACCESS` は本番で必ず `"true"` のままにする。

Accessを通らない公開 `workers.dev` URLを残すと、認証ヘッダーをクライアントが直接送れるため
危険です。

## 6. Web UI と疎通確認

Web UI はWorkerの静的アセットとしてAPIと同じドメインから配信されます。Accessへログインして
`https://personal.example.com` を開き、画面のAPI URLにも同じURLを設定します。同一ドメインの
ため、ブラウザはAPIリクエストにもAccess Cookieを送信します。

```bash
rtk pnpm --filter @personal-os/web build
rtk pnpm --filter @personal-os/worker run deploy
```

未認証ではAccessのログイン画面が表示され、認証後だけWeb UIとAPIを利用できることを確認します。
Evidenceを1件投入し、Proposalの作成・承認、検索、timeline、来歴表示までを画面で確認します。

## 7. 移行・バックアップ用の一時認証情報

通常のWorker実行には次の資格情報は不要です。暗号化バックアップまたはクラウド移行を行う
期間だけ作成します。

- Cloudflare API token: 対象アカウント、対象D1に限定し、エクスポートはD1 Read、復元はD1 Edit
- R2 API token: `personal-os-evidence` バケットだけの Object Read/Write

作成後、次の環境変数として安全に注入します。値は `.env`、リポジトリ、作業ログへ残しません。

| 変数                              | 内容                   |
| --------------------------------- | ---------------------- |
| `CLOUDFLARE_ACCOUNT_ID`           | アカウントID           |
| `CLOUDFLARE_D1_DATABASE_ID`       | D1 database ID         |
| `CLOUDFLARE_API_TOKEN`            | D1 API token           |
| `CLOUDFLARE_R2_ACCESS_KEY_ID`     | R2 access key ID       |
| `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | R2 secret access key   |
| `CLOUDFLARE_R2_BUCKET_NAME`       | `personal-os-evidence` |
| `PERSONAL_OS_BACKUP_KEY`          | 32バイト鍵のbase64     |

```bash
rtk pnpm cloud:transfer verify cloudflare
rtk pnpm cloud:transfer export cloudflare /secure/off-device/personal-os-cloudflare.pos
```

作業後はD1 API tokenとR2 API tokenを失効させます。移行手順は
[`cloud-migration.ja.md`](cloud-migration.ja.md) を参照してください。

## 8. 一人運用の費用目安

アクセスが少なくデータ量も小さい一人運用では、各サービスの利用量も小さくなります。R2保存量、
D1の行読み書き、Vectorizeの保存・検索次元、Workerのリクエストが主な変動要素です。独自
ドメインとOpenAIは別料金です。

無料枠と単価は変更されるため、デプロイ時点のCloudflare公式料金を確認し、Billing通知も設定
してください。

## 9. 更新とロールバック

- Workerのデグレは直前の正常なデプロイへロールバックする
- D1 migration は原則として前方互換にし、適用前に暗号化バックアップを作る
- Projectionは `rtk pnpm cloud:transfer rebuild cloudflare` で正規イベントから再生成できる
- R2 Raw Evidence とD1 canonical eventsを、派生ProjectionやVectorizeより優先して保護する
- 認証障害時もAccessを迂回するために `REQUIRE_ACCESS=false` や `workers.dev` 公開を行わない

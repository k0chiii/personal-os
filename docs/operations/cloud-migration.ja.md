# AWS / Cloudflare 移行手順

AWSからCloudflareへ、またはCloudflareからAWSへ移行できます。理由は正規データを
`CanonicalBackup` としてインフラ非依存の形式へ書き出し、Raw Evidenceも同じ内容ハッシュの
キーで保持する設計だからです。DynamoDB/D1のProjectionとVector索引は派生データなので、
移行先でイベントから再生成します。

```text
AWS:        DynamoDB Events + S3 Evidence
                         ↓ 暗号化 CanonicalBackup
Cloudflare: D1 Events       + R2 Evidence
```

移行はオンライン同期ではなく、短い書き込み停止を伴う一括切替です。一人利用なら、全クライアント
を閉じて作業中に更新しない運用で十分です。無停止の双方向レプリケーションは実装していません。

## 共通の安全条件

1. ソースへの書き込みを止める。閲覧は可能だが、移行中の更新は禁止する。
2. 移行先は専用の新規環境にする。既存イベントが1件でもあると復元は拒否される。
3. 32バイトの同じバックアップ鍵をexportとrestoreで使い、バックアップとは別に保管する。
4. DNSやWeb UIのAPI URLは、復元後の受入確認が終わるまで変更しない。
5. 移行前にロールバック期間を決め、その期間は移行元を削除せず、書き込み停止のまま残す。

鍵を新規生成する場合は、出力をパスワードマネージャーへ直接保存します。

```bash
rtk openssl rand -base64 32
```

移行CLIは暗号化ファイルを既存パスへ上書きせず、所有者だけが読める権限で新規作成します。
CLIの書式は次のとおりです。

```bash
rtk pnpm cloud:transfer verify <aws|cloudflare>
rtk pnpm cloud:transfer rebuild <aws|cloudflare>
rtk pnpm cloud:transfer export <aws|cloudflare> <new-backup-file>
rtk pnpm cloud:transfer restore <aws|cloudflare> <backup-file>
```

## 必要な環境変数

### AWS

AWS CLIと同じ認証チェーンおよびリージョンに加え、次を設定します。

- `EVENT_TABLE_NAME`
- `PROJECTION_TABLE_NAME`
- `EVIDENCE_BUCKET_NAME`
- export/restore時だけ `PERSONAL_OS_BACKUP_KEY`

スタック出力は次で確認できます。

```bash
rtk aws cloudformation describe-stacks \
  --stack-name personal-os \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output table
```

CLI用IAM主体は対象2テーブルの必要な読み書きと、対象EvidenceバケットのObject読み書きだけに
限定します。exportだけならDynamoDB/S3は読み取り権限で足ります。

### Cloudflare

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_D1_DATABASE_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_R2_ACCESS_KEY_ID`
- `CLOUDFLARE_R2_SECRET_ACCESS_KEY`
- `CLOUDFLARE_R2_BUCKET_NAME`
- export/restore時だけ `PERSONAL_OS_BACKUP_KEY`

D1 tokenは対象アカウントへ限定し、exportはD1 Read、restore/rebuildはD1 Editを付与します。
R2 tokenは対象バケットだけのObject Read/Writeへ限定し、作業後に失効させます。

## AWS から Cloudflare へ

### 1. 新しいCloudflare移行先を準備

[`cloudflare-setup.ja.md`](cloudflare-setup.ja.md) の手順で、新しいD1、R2、Vectorizeを作成し、
D1 migrationを適用します。Workerはデプロイして構いませんが、まだWeb UIやDNSを切り替えません。
`canonical_events` が空であることを確認します。

### 2. AWSソースを固定して書き出す

全クライアントを閉じて更新を止めた後、Projectionを正規イベントへ揃え、整合性を確認します。

```bash
rtk pnpm cloud:transfer rebuild aws
rtk pnpm cloud:transfer verify aws
rtk pnpm cloud:transfer export aws /secure/migration/aws-to-cloudflare.pos
```

3コマンドの `eventCount` と `evidenceChecked` を記録します。exportは先に整合性検証を行い、失敗時は
ファイルを作りません。

### 3. Cloudflareへ復元

```bash
rtk pnpm cloud:transfer restore cloudflare /secure/migration/aws-to-cloudflare.pos
rtk pnpm cloud:transfer verify cloudflare
```

restoreとverifyの件数がAWSの記録と一致することを確認します。Cloudflare REST API経由のD1操作は
保守用に順番に実行され、1トランザクションではありません。途中で失敗した場合は、そのD1を本番
利用せず、新しい空のD1を作って最初から復元します。部分復元へ継ぎ足してはいけません。

### 4. 受入確認と切替

- `/health` が成功する
- Access未認証の `/v1/*` が拒否される
- 現在状態、検索、timeline、代表的AssertionのEvidence来歴が一致する
- P0〜P3のアクセス範囲が意図どおりである
- 新規Evidenceを1件登録し、Proposalの承認と検索が成功する

受入用に作ったデータが不要なら、削除ではなく監査可能な通常の保持・purge手順を使います。確認後、
Web UIのAPI URLまたはDNSをCloudflareへ切り替えます。DNSを切り替える場合は、TTLを事前に
短くしておくと戻しやすくなります。

## Cloudflare から AWS へ

### 1. 新しいAWS移行先を準備

[`aws-setup.ja.md`](aws-setup.ja.md) の手順で新しいスタックをデプロイします。既存本番スタックへ
上書きせず、別のスタック名を使います。Eventテーブルが空であることを確認し、まだWeb UIを
切り替えません。

### 2. Cloudflareソースを固定して書き出す

```bash
rtk pnpm cloud:transfer rebuild cloudflare
rtk pnpm cloud:transfer verify cloudflare
rtk pnpm cloud:transfer export cloudflare /secure/migration/cloudflare-to-aws.pos
```

件数を記録し、生成ファイルと鍵を別々の安全な場所へ保管します。

### 3. AWSへ復元

AWS環境変数を新しいスタックの出力へ切り替えてから実行します。

```bash
rtk pnpm cloud:transfer restore aws /secure/migration/cloudflare-to-aws.pos
rtk pnpm cloud:transfer verify aws
```

件数と代表データをCloudflare側の記録と比較します。AWSのイベント追加はDynamoDB transactionで
原子的ですが、バックアップ全体は複数transactionです。失敗時は部分復元先を本番にせず、新しい
空のスタックへ復元し直します。

### 4. 受入確認と切替

- `/health` が成功する
- Cognito JWTなしの `/v1/*` が401になる
- JWTありで現在状態、検索、timeline、Evidence来歴が一致する
- 新規Evidence、Proposal承認、検索が成功する
- CloudWatch error/throttle alarm とBudget通知先を確認する

問題がなければWeb UIのAPI URLまたはDNSをAWSへ切り替えます。

## ロールバック

切替後に重大な問題が出た場合は、移行先の書き込みを直ちに止めます。移行元へ戻すだけなら、DNS
またはWeb UIのAPI URLを旧環境へ戻します。ただし、切替後に移行先で新しい正規イベントを作った
場合、そのイベントは旧環境に存在しません。

その場合は次のどちらかを選びます。

1. 新しいイベントを破棄できると判断し、旧環境へ戻す。
2. 移行先を新たなソースとして書き出し、空の移行元代替環境へ再復元する。

異なる正規イベント履歴を持つ2環境を同時に書き込み可能にしてはいけません。自動マージ機能はなく、
DynamoDBとD1のテーブルを直接コピー・結合する方法もサポートしません。

## 完了条件

- sourceとdestinationの `eventCount`、`evidenceChecked` が一致する
- 代表的な現在状態、履歴、検索、来歴が一致する
- 認証とプライバシー境界を確認した
- 新しい書き込みがdestinationだけへ届く
- 暗号化バックアップと鍵を別々に保管した
- 一時API tokenを失効させた
- ロールバック期限と旧環境の削除予定日を記録した

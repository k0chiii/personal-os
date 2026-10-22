# AWS セットアップ手順

この手順はPersonal OS の API と正規データを AWS で一人運用するためのものです。SAM
スタックは Lambda、API Gateway HTTP API、Cognito、DynamoDB 2テーブル、S3、CloudWatch、
SNS、任意の AWS Budgets を作成します。Web UI は静的ファイルなので、AWS Amplify Hosting、
S3 + CloudFront、または手元のPCから配信できます。

## 1. 前提条件

- Node.js 22、pnpm、RTK、AWS CLI v2、AWS SAM CLI
- 対象AWSアカウントで CloudFormation、IAM、Lambda、API Gateway、Cognito、DynamoDB、
  S3、SSM、CloudWatch、SNS、Budgets を作成できる認証情報
- Web UI を配信するHTTPSオリジン。最初の検証だけなら `http://localhost:3000` でよい

アカウントとリージョンを必ず確認します。既定リージョンは東京です。

```bash
rtk aws sts get-caller-identity
rtk aws configure get region
```

## 2. ローカル検証

リポジトリのルートで実行します。

```bash
rtk pnpm install --frozen-lockfile
rtk pnpm check
rtk pnpm test
rtk pnpm aws:validate
rtk pnpm aws:build
rtk pnpm build
```

`check`、`test`、`aws:validate`、`aws:build` のすべてが成功してからデプロイします。

## 3. 任意の OpenAI キー

OpenAIを使わなくても、保存、検索、来歴確認、Context API は動きます。利用する場合だけ、
SecureString を `/personal-os/` 配下へ保存します。値はソース、SAMパラメータ、シェル履歴へ
書かず、パスワードマネージャーから現在のプロセスへ安全に渡してください。

```bash
rtk aws ssm put-parameter \
  --name /personal-os/openai-api-key \
  --type SecureString \
  --value "$OPENAI_API_KEY" \
  --overwrite
```

## 4. デプロイ

`AllowedOrigin` は Web UI の正確なオリジンに置き換えます。通知が不要なら `AlertEmail` と
`OpenAiApiKeyParameterName` を空にできます。

```bash
rtk pnpm aws:deploy -- \
  --parameter-overrides \
    AllowedOrigin=https://personal.example.com \
    AlertEmail=owner@example.com \
    MonthlyBudgetUsd=10 \
    RateLimitPerMinute=120 \
    ApiThrottleRateLimit=10 \
    ApiThrottleBurstLimit=20 \
    OpenAiApiKeyParameterName=/personal-os/openai-api-key
```

CloudFormation の変更セットを確認して承認します。通知メールを指定した場合は、SNSから届く
購読確認も行います。デプロイ後、出力値を記録します。

```bash
rtk aws cloudformation describe-stacks \
  --stack-name personal-os \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output table
```

特に次を安全な運用メモへ控えます。

| 出力                              | 用途                             |
| --------------------------------- | -------------------------------- |
| `ApiUrl`                          | Web UI と疎通確認                |
| `UserPoolId` / `UserPoolClientId` | 一人目のユーザーとJWT            |
| `EventTableName`                  | 正規イベント、バックアップ、移行 |
| `ProjectionTableName`             | 再生成可能な検索ビュー           |
| `EvidenceBucketName`              | Raw Evidence                     |

## 5. 一人目の Cognito ユーザー

パスワードは14文字以上で、大文字、小文字、数字、記号を含めます。以下の
`PERSONAL_OS_PASSWORD` はパスワードマネージャーから現在のシェルだけへ設定し、履歴や
ファイルへ保存しません。

```bash
rtk aws cognito-idp admin-create-user \
  --user-pool-id '<UserPoolId>' \
  --username owner@example.com \
  --message-action SUPPRESS

rtk aws cognito-idp admin-set-user-password \
  --user-pool-id '<UserPoolId>' \
  --username owner@example.com \
  --password "$PERSONAL_OS_PASSWORD" \
  --permanent
```

Web UI が要求するアクセストークンは、次の認証結果の `AccessToken` です。認証結果をログや
共有画面へ残さないでください。

```bash
rtk aws cognito-idp initiate-auth \
  --client-id '<UserPoolClientId>' \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=owner@example.com,PASSWORD=$PERSONAL_OS_PASSWORD"
```

## 6. Web UI と疎通確認

最初はローカル配信で確認できます。画面で `ApiUrl` と Cognito の `AccessToken` を設定します。

```bash
rtk pnpm --filter @personal-os/web dev
```

別の端末からヘルスチェックを行います。

```bash
rtk curl --fail --silent --show-error '<ApiUrl>/health'
rtk curl --fail --silent --show-error \
  --header "Authorization: Bearer <AccessToken>" \
  '<ApiUrl>/v1/self/current?privacy=P0,P1,P2,P3'
```

本番の静的配信先を決めた後、`AllowedOrigin` をそのHTTPSオリジンへ変更してSAMを再デプロイ
します。トークンはブラウザのセッションストレージにだけ保持されます。

## 7. バックアップと整合性確認

32バイトの鍵を一度生成し、バックアップとは別のパスワードマネージャーへ保存します。

```bash
rtk openssl rand -base64 32
```

AWS認証情報と次の環境変数を設定した状態で実行します。出力ファイルは既存ファイルを上書き
せず、作成時に所有者だけが読める権限になります。

```bash
rtk pnpm cloud:transfer verify aws
rtk pnpm cloud:transfer export aws /secure/off-device/personal-os-aws.pos
```

必要な変数は `EVENT_TABLE_NAME`、`PROJECTION_TABLE_NAME`、`EVIDENCE_BUCKET_NAME`、
`PERSONAL_OS_BACKUP_KEY` です。復元訓練と他クラウドへの移行は
[`cloud-migration.ja.md`](cloud-migration.ja.md) を参照してください。

## 8. 一人運用の費用目安

低頻度利用なら、Lambda、API Gateway、DynamoDB、S3、Cognito の利用量は小さくなります。
CloudWatch アラームとログ保持、DynamoDB PITR、S3の保存量も費用へ加算されます。OpenAI、
独自ドメイン、Amplify/CloudFront は別料金です。

価格と無料枠は変わるため、デプロイ前に AWS Pricing Calculator で東京リージョンを確認し、
`AlertEmail` と `MonthlyBudgetUsd=10` を設定してください。Budget は通知であり、利用を自動停止
する上限ではありません。

## 9. 更新、ロールバック、削除

- アプリのデグレは同じスタックパラメータで直前の正常なリビジョンを再デプロイする
- EventテーブルとEvidenceバケットは `Retain` なので、ロールバック目的でスタックを削除しない
- Projectionテーブルは派生データなので `rtk pnpm cloud:transfer rebuild aws` で再生成できる
- 正規データ障害では書き込みを止め、DynamoDB PITRから新しいテーブルへ復元する
- 完全削除時も、保持されたEventテーブルとS3バケットはバックアップ確認後に別途処理する

日常運用と実AWS上のアダプター契約テストは
[`aws-runbook.md`](aws-runbook.md) にあります。

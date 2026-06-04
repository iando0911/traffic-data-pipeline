# AWS IAM OIDC 設定說明
# 讓 GitHub Actions 免長效金鑰直接認證 AWS（更安全）

## 為什麼用 OIDC？

傳統做法是把 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
存進 GitHub Secrets，但長效金鑰一旦外洩就需要緊急輪換。

OIDC 讓 GitHub Actions 在執行時向 AWS 請求短效憑證（1 小時），
**完全不需要在 GitHub 存放長效金鑰**。

---

## 一次性設定步驟

### 步驟 1：在 AWS 建立 OIDC Provider

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

> 如果已存在會報錯，可忽略。

---

### 步驟 2：建立 IAM Role（給 GitHub Actions 用）

建立 `trust-policy.json`：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<YOUR_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:<YOUR_GITHUB_ORG>/<YOUR_REPO>:*"
        }
      }
    }
  ]
}
```

> 請替換 `<YOUR_ACCOUNT_ID>`、`<YOUR_GITHUB_ORG>`、`<YOUR_REPO>`

```bash
# 建立 Role
aws iam create-role \
  --role-name GitHubActions-TrafficDashboard \
  --assume-role-policy-document file://trust-policy.json

# 附加 S3 + CloudFront 權限
aws iam put-role-policy \
  --role-name GitHubActions-TrafficDashboard \
  --policy-name DeployPolicy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": ["s3:PutObject","s3:DeleteObject","s3:GetObject","s3:ListBucket"],
        "Resource": [
          "arn:aws:s3:::<YOUR_BUCKET_NAME>",
          "arn:aws:s3:::<YOUR_BUCKET_NAME>/*"
        ]
      },
      {
        "Effect": "Allow",
        "Action": "cloudfront:CreateInvalidation",
        "Resource": "arn:aws:cloudfront::<YOUR_ACCOUNT_ID>:distribution/<YOUR_CF_DIST_ID>"
      }
    ]
  }'
```

---

### 步驟 3：部署 CloudFormation Stack

```bash
aws cloudformation deploy \
  --template-file aws/cloudformation.yml \
  --stack-name traffic-dashboard \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides ProjectName=traffic-dashboard
```

部署完成後，記下輸出的三個值。

---

### 步驟 4：設定 GitHub Repository Secrets

前往：`Settings → Secrets and variables → Actions → New repository secret`

| Secret 名稱            | 值來源                                |
|------------------------|---------------------------------------|
| `AWS_OIDC_ROLE_ARN`    | `arn:aws:iam::<ACCT>:role/GitHubActions-TrafficDashboard` |
| `S3_BUCKET_NAME`       | CloudFormation Output: S3BucketName   |
| `CLOUDFRONT_DIST_ID`   | CloudFormation Output: CloudFrontDistributionId |
| `CLOUDFRONT_DOMAIN`    | CloudFormation Output: CloudFrontDomain |

---

### 完成！

推送到 `main` branch 或手動觸發 workflow，
GitHub Actions 即會自動：
1. 🐳 用 Docker 執行 ETL
2. ☁️  同步到 AWS S3 + 清除 CloudFront 快取
3. 📄 同時部署到 GitHub Pages

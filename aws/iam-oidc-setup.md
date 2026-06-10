# AWS IAM OIDC 設定說明

本文件說明如何讓 GitHub Actions 透過 **OIDC（OpenID Connect）** 安全地認證 AWS，讓本專題的 CI/CD workflow 可以部署到 **AWS S3 + CloudFront**，而不需要在 GitHub Secrets 內保存長效 AWS Access Key。

本專題對應的 workflow：

```text
.github/workflows/deploy.yml
```

部署流程：

```text
GitHub Actions
      │
      │ OIDC Token
      ▼
AWS IAM OIDC Provider
      │
      │ AssumeRoleWithWebIdentity
      ▼
AWS IAM Role
      │
      ├── S3 sync dashboard files
      └── CloudFront cache invalidation
```

---

## 1. 為什麼使用 OIDC？

傳統做法通常會把下列長效憑證放進 GitHub Secrets：

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
```

這種方式雖然簡單，但如果 secrets 外洩，就必須立刻輪換金鑰，也會增加維護風險。

OIDC 的做法是：

1. GitHub Actions 執行 workflow 時，向 GitHub OIDC Provider 取得短效 token。
2. AWS IAM 驗證這個 token 是否來自指定 GitHub repository。
3. 驗證成功後，AWS STS 發給 GitHub Actions 短期 AWS credentials。
4. Workflow 使用短期 credentials 部署 S3 / CloudFront。

優點：

* 不需要在 GitHub 儲存長效 AWS Access Key。
* 權限可以綁定到指定 GitHub repository。
* 權限可以限制在指定 branch / environment。
* 憑證是短期有效，比長效金鑰更安全。
* 符合雲端 CI/CD 的安全實務。

---

## 2. 本專題需要的 GitHub Secrets

在 GitHub Repository 設定以下 secrets：

```text
Settings → Secrets and variables → Actions → New repository secret
```

| Secret 名稱            | 用途                                         | 範例                                                              |
| -------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| `AWS_OIDC_ROLE_ARN`  | GitHub Actions 要 assume 的 AWS IAM Role ARN | `arn:aws:iam::123456789012:role/GitHubActions-TrafficDashboard` |
| `S3_BUCKET_NAME`     | CloudFormation 建立的 S3 bucket 名稱            | `traffic-dashboard-123456789012-ap-northeast-1`                 |
| `CLOUDFRONT_DIST_ID` | CloudFront Distribution ID                 | `E123ABC456XYZ`                                                 |
| `CLOUDFRONT_DOMAIN`  | CloudFront domain name                     | `d111111abcdef8.cloudfront.net`                                 |

---

## 3. 先部署 AWS S3 + CloudFront

在設定 OIDC Role 權限前，建議先部署 CloudFormation，取得 S3 bucket 與 CloudFront distribution 的實際名稱。

### 3.1 部署 CloudFormation

在專案根目錄執行：

```bash
aws cloudformation deploy \
  --template-file aws/cloudformation.yml \
  --stack-name traffic-dashboard \
  --parameter-overrides ProjectName=traffic-dashboard \
  --region ap-northeast-1
```

若你的 `cloudformation.yml` 使用到 IAM resource，再加上：

```bash
--capabilities CAPABILITY_IAM
```

目前本專題主要建立 S3 / CloudFront 資源，通常不需要 `CAPABILITY_IAM`，但保留也不會影響部署。

---

### 3.2 查詢 CloudFormation Outputs

```bash
aws cloudformation describe-stacks \
  --stack-name traffic-dashboard \
  --region ap-northeast-1 \
  --query "Stacks[0].Outputs"
```

請記下：

```text
S3BucketName
CloudFrontDistributionId
CloudFrontDomain
```

後面要填入 GitHub Secrets。

---

## 4. 建立 GitHub OIDC Provider

### 4.1 檢查是否已存在 Provider

```bash
aws iam list-open-id-connect-providers
```

如果結果中已經有：

```text
arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com
```

代表已經建立過，可以跳過建立 provider。

---

### 4.2 建立 OIDC Provider

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

> 如果 AWS 回覆 provider 已存在，通常可以忽略，繼續下一步建立 IAM Role。

---

## 5. 建立 IAM Role Trust Policy

建立檔案：

```text
trust-policy.json
```

內容如下。

請把：

```text
<YOUR_ACCOUNT_ID>
<YOUR_GITHUB_OWNER>
<YOUR_REPO>
```

替換成你的實際資訊。

你的 repository 為：

```text
iando0911/traffic-data-pipeline
```

所以 `<YOUR_GITHUB_OWNER>` 可填：

```text
iando0911
```

`<YOUR_REPO>` 可填：

```text
traffic-data-pipeline
```

### 5.1 建議版本：限制 main branch

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowGitHubActionsMainBranch",
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<YOUR_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:iando0911/traffic-data-pipeline:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

這個版本只允許 `main` branch 的 workflow assume role，安全性較高。

---

### 5.2 若使用 GitHub Environment production

如果你的 workflow job 有設定：

```yaml
environment: production
```

GitHub OIDC token 的 `sub` 可能會使用 environment 格式。此時可用下面版本：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowGitHubActionsProductionEnvironment",
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<YOUR_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:iando0911/traffic-data-pipeline:environment:production"
        }
      }
    }
  ]
}
```

你的 `deploy-aws` job 使用：

```yaml
environment: production
```

因此如果 main branch 版本一直出現 `Not authorized to perform sts:AssumeRoleWithWebIdentity`，請改用 environment 版本。

---

### 5.3 Demo / 課堂展示用寬鬆版本

如果只是為了期末專題展示，想先確認流程能跑，可以暫時使用較寬鬆版本：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowGitHubActionsRepository",
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
          "token.actions.githubusercontent.com:sub": "repo:iando0911/traffic-data-pipeline:*"
        }
      }
    }
  ]
}
```

此版本允許同一 repository 的所有 branch / environment 使用此 role。正式環境建議使用 main branch 或 production environment 限制版本。

---

## 6. 建立 IAM Role

```bash
aws iam create-role \
  --role-name GitHubActions-TrafficDashboard \
  --assume-role-policy-document file://trust-policy.json
```

建立成功後查詢 role ARN：

```bash
aws iam get-role \
  --role-name GitHubActions-TrafficDashboard \
  --query "Role.Arn" \
  --output text
```

你會得到類似：

```text
arn:aws:iam::123456789012:role/GitHubActions-TrafficDashboard
```

這個值要填入 GitHub Secret：

```text
AWS_OIDC_ROLE_ARN
```

---

## 7. 建立最小部署權限 Policy

建立檔案：

```text
deploy-policy.json
```

請替換：

```text
<YOUR_BUCKET_NAME>
<YOUR_ACCOUNT_ID>
<YOUR_CLOUDFRONT_DIST_ID>
```

### 7.1 S3 + CloudFront 部署權限

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListDashboardBucket",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::<YOUR_BUCKET_NAME>"
    },
    {
      "Sid": "WriteDashboardObjects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::<YOUR_BUCKET_NAME>/*"
    },
    {
      "Sid": "InvalidateCloudFrontCache",
      "Effect": "Allow",
      "Action": [
        "cloudfront:CreateInvalidation"
      ],
      "Resource": "arn:aws:cloudfront::<YOUR_ACCOUNT_ID>:distribution/<YOUR_CLOUDFRONT_DIST_ID>"
    }
  ]
}
```

---

### 7.2 附加 Inline Policy 到 Role

```bash
aws iam put-role-policy \
  --role-name GitHubActions-TrafficDashboard \
  --policy-name TrafficDashboardDeployPolicy \
  --policy-document file://deploy-policy.json
```

---

## 8. 設定 GitHub Repository Secrets

進入 GitHub repository：

```text
traffic-data-pipeline → Settings → Secrets and variables → Actions
```

點選：

```text
New repository secret
```

建立以下四個 secrets：

| Secret 名稱            | 值                                                               |
| -------------------- | --------------------------------------------------------------- |
| `AWS_OIDC_ROLE_ARN`  | `arn:aws:iam::<ACCOUNT_ID>:role/GitHubActions-TrafficDashboard` |
| `S3_BUCKET_NAME`     | CloudFormation Output: `S3BucketName`                           |
| `CLOUDFRONT_DIST_ID` | CloudFormation Output: `CloudFrontDistributionId`               |
| `CLOUDFRONT_DOMAIN`  | CloudFormation Output: `CloudFrontDomain`                       |

---

## 9. 確認 GitHub Actions Workflow 權限

在 `.github/workflows/deploy.yml` 內要有：

```yaml
permissions:
  contents: read
  pages: write
  id-token: write
  actions: read
```

`deploy-aws` job 內也要有：

```yaml
permissions:
  contents: read
  id-token: write
```

AWS credentials step：

```yaml
- name: 🔑 Configure AWS credentials (OIDC)
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ secrets.AWS_OIDC_ROLE_ARN }}
    aws-region: ap-northeast-1
```

---

## 10. 手動觸發部署

進入 GitHub repository：

```text
Actions → Traffic ETL — Docker Build → AWS S3 + GitHub Pages → Run workflow
```

設定：

```text
target_year: 115
```

按下：

```text
Run workflow
```

成功後 workflow 會執行：

```text
Build Docker & Run ETL
      │
      ├── Deploy to AWS S3 + CloudFront
      └── Deploy to GitHub Pages
```

---

## 11. 驗證 AWS 部署結果

### 11.1 查看 GitHub Actions Log

在 `Deploy to AWS S3 + CloudFront` job 中應看到：

```text
✅ AWS secrets found. AWS deploy enabled.
```

以及：

```text
✅ AWS 部署完成
🌐 URL: https://<CLOUDFRONT_DOMAIN>
```

---

### 11.2 測試 CloudFront URL

瀏覽器開啟：

```text
https://<CLOUDFRONT_DOMAIN>
```

或命令列測試：

```bash
curl -I https://<CLOUDFRONT_DOMAIN>
```

預期回應：

```text
HTTP/2 200
```

或至少不是 `403` / `404`。

---

### 11.3 測試主要檔案

```bash
curl -I https://<CLOUDFRONT_DOMAIN>/index.html
curl -I https://<CLOUDFRONT_DOMAIN>/app.js
curl -I https://<CLOUDFRONT_DOMAIN>/style.css
curl -I https://<CLOUDFRONT_DOMAIN>/dashboard_data.json
curl -I https://<CLOUDFRONT_DOMAIN>/heatmap.html
```

---

## 12. 常見錯誤排除

### 12.1 `No OpenIDConnect provider found`

原因：

AWS IAM 尚未建立 GitHub OIDC Provider。

處理：

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

---

### 12.2 `Not authorized to perform sts:AssumeRoleWithWebIdentity`

常見原因：

* `trust-policy.json` 的 repo 名稱錯誤
* `sub` 條件與 workflow 實際 branch / environment 不一致
* workflow 沒有 `id-token: write`
* GitHub Secret `AWS_OIDC_ROLE_ARN` 填錯
* IAM Role 的 trusted entity 不是 GitHub OIDC provider

處理方式：

1. 確認 repository 名稱：

```text
iando0911/traffic-data-pipeline
```

2. 如果 workflow 使用 `environment: production`，trust policy 可改用：

```text
repo:iando0911/traffic-data-pipeline:environment:production
```

3. 確認 workflow permissions：

```yaml
id-token: write
```

4. 確認 role ARN：

```bash
aws iam get-role \
  --role-name GitHubActions-TrafficDashboard \
  --query "Role.Arn" \
  --output text
```

---

### 12.3 `AccessDenied` when running `aws s3 sync`

常見原因：

* IAM Role 沒有 `s3:ListBucket`
* IAM Role 沒有 `s3:PutObject`
* IAM Role 沒有 `s3:DeleteObject`
* policy 的 bucket name 與 GitHub Secret `S3_BUCKET_NAME` 不一致

處理：

確認 policy 中同時包含：

```text
arn:aws:s3:::<YOUR_BUCKET_NAME>
arn:aws:s3:::<YOUR_BUCKET_NAME>/*
```

---

### 12.4 `AccessDenied` when creating CloudFront invalidation

常見原因：

* IAM Role 沒有 `cloudfront:CreateInvalidation`
* CloudFront Distribution ID 寫錯
* policy resource ARN 中 account ID 或 distribution ID 錯誤

處理：

確認：

```text
arn:aws:cloudfront::<YOUR_ACCOUNT_ID>:distribution/<YOUR_CLOUDFRONT_DIST_ID>
```

也可以暫時測試用：

```json
{
  "Effect": "Allow",
  "Action": "cloudfront:CreateInvalidation",
  "Resource": "*"
}
```

測試成功後再收斂回指定 distribution ARN。

---

### 12.5 CloudFront 網頁還是舊版

原因：

CloudFront cache 尚未更新。

處理：

確認 workflow 有執行：

```bash
aws cloudfront create-invalidation \
  --distribution-id <YOUR_CLOUDFRONT_DIST_ID> \
  --paths "/*"
```

也可以手動執行：

```bash
aws cloudfront create-invalidation \
  --distribution-id <YOUR_CLOUDFRONT_DIST_ID> \
  --paths "/*"
```

---

### 12.6 CloudFront 回傳 403

常見原因：

* S3 Bucket Policy 沒有允許 CloudFront OAC
* CloudFront Origin 設定錯誤
* `index.html` 沒有成功上傳
* S3 Block Public Access 開啟但 CloudFront 沒有正確 OAC 權限

處理：

1. 確認 S3 有檔案：

```bash
aws s3 ls s3://<YOUR_BUCKET_NAME>/
```

2. 確認 CloudFront origin 指向正確 S3 bucket regional domain name。

3. 確認 CloudFormation 的 Bucket Policy 允許 CloudFront Distribution 存取 S3 object。

---

## 13. 刪除 AWS 資源

如果期末展示結束後想刪除資源：

```bash
aws cloudformation delete-stack \
  --stack-name traffic-dashboard \
  --region ap-northeast-1
```

如果 S3 bucket 不是空的，CloudFormation 可能無法刪除。先清空 bucket：

```bash
aws s3 rm s3://<YOUR_BUCKET_NAME>/ --recursive
```

再刪除 stack。

刪除 IAM Role：

```bash
aws iam delete-role-policy \
  --role-name GitHubActions-TrafficDashboard \
  --policy-name TrafficDashboardDeployPolicy

aws iam delete-role \
  --role-name GitHubActions-TrafficDashboard
```

如果 OIDC Provider 不再使用，也可以刪除：

```bash
aws iam list-open-id-connect-providers
aws iam delete-open-id-connect-provider \
  --open-id-connect-provider-arn arn:aws:iam::<YOUR_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com
```

---

## 14. 期末專題說明重點

本專題使用 OIDC 的重點可以在報告中這樣說：

```text
本專題的 AWS 部署沒有使用長效 Access Key，而是透過 GitHub Actions OIDC 與 AWS IAM Role 建立信任關係。GitHub Actions 每次部署時會取得短期 token，AWS 只允許指定 repository 的 workflow assume role，並授予 S3 上傳與 CloudFront invalidation 的最小權限。這樣可以降低金鑰外洩風險，也符合雲端 CI/CD 的安全實務。
```

這段可以對應課程主題中的：

* AWS
* OAuth / OIDC
* 雲端平台安全部署
* CI/CD
* SaaS 服務正式部署架構

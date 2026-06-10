# 台灣交通事故資料分析 SaaS 平台 — 雲端部署架構說明

本專題以 **Docker、AWS、GitHub Actions CI/CD 與 SaaS Dashboard** 為核心，建立一個可自動化執行 ETL、產生交通事故分析結果、並部署到雲端的資料服務平台。

系統分為四層：

1. **Docker ETL Layer**：封裝 Python 資料處理、統計分析與視覺化流程。
2. **GitHub Actions CI/CD Layer**：自動測試、建置 Docker image、執行 ETL、驗證輸出檔案與部署網站。
3. **AWS Hosting Layer**：使用 S3 儲存靜態 Dashboard，並透過 CloudFront CDN 對外提供 HTTPS 網站。
4. **SaaS Frontend Layer**：提供會員登入、動態篩選、訂閱通知、通知中心、活動紀錄與 API Health Check 等互動服務。

本專題同時保留 **GitHub Pages** 作為備援展示環境，確保即使 AWS 尚未完整設定，也能展示 SaaS Dashboard 與資料分析結果。

---

## 1. 系統總覽

### 1.1 整體架構圖

```text
使用者瀏覽器
     │
     │ HTTPS
     ▼
┌──────────────────────────────────────────────┐
│ SaaS Dashboard Frontend                      │
│ - 會員登入 Demo                               │
│ - 動態資料篩選                                │
│ - 訂閱資料更新通知                             │
│ - Notification Center                        │
│ - Activity Log                               │
│ - API Health Check                           │
└───────────────────┬──────────────────────────┘
                    │
                    │ 靜態資源 / JSON 資料
                    ▼
┌──────────────────────────────────────────────┐
│ Hosting Layer                                │
│                                              │
│ Production: AWS CloudFront + S3              │
│ Backup: GitHub Pages                         │
└───────────────────┬──────────────────────────┘
                    │
                    │ 部署 artifact
                    ▼
┌──────────────────────────────────────────────┐
│ GitHub Actions CI/CD                         │
│ - pytest                                     │
│ - pip-audit                                  │
│ - docker build                               │
│ - docker run ETL                             │
│ - upload artifact                            │
│ - deploy AWS / GitHub Pages                  │
└───────────────────┬──────────────────────────┘
                    │
                    │ Docker container
                    ▼
┌──────────────────────────────────────────────┐
│ Docker ETL Layer                             │
│ - Python 3.11 runtime                         │
│ - 下載交通事故開放資料                        │
│ - 清洗 / 統計 / 視覺化                         │
│ - 輸出 HTML / JSON / CSS / JS                 │
└──────────────────────────────────────────────┘
```

---

## 2. Docker ETL Layer

### 2.1 設計目的

本專題使用 Docker 封裝 ETL Pipeline，讓資料處理流程可以在以下環境中保持一致：

* 本機開發環境
* GitHub Actions Runner
* 未來雲端 VM / Kubernetes / ECS 環境
* 課堂 Demo 環境

Docker image 內部包含 Python runtime、必要套件與 ETL 主程式。GitHub Actions 會先執行：

```bash
docker build -t traffic-etl:ci .
```

再執行：

```bash
docker run --rm \
  -e TARGET_YEAR=115 \
  -e OUTPUT_DIR=/app/output \
  -e GITHUB_SHA=<commit-sha> \
  -v <repo>/output:/app/output \
  traffic-etl:ci
```

ETL 完成後會在 `output/` 產生 Dashboard 所需的靜態檔案。

---

### 2.2 Docker 執行流程

```text
GitHub Actions Runner
        │
        ▼
docker build -t traffic-etl:ci .
        │
        ▼
Docker Image
        │
        ▼
docker run traffic-etl:ci
        │
        ▼
下載政府開放資料
        │
        ▼
資料清洗與統計分析
        │
        ▼
產生 output/
        │
        ├── index.html
        ├── app.js
        ├── style.css
        ├── dashboard_data.json
        ├── heatmap.html
        ├── age_distribution.html
        ├── pipeline_stats.html
        └── stats_table.html
```

---

### 2.3 Docker 多階段建置

Dockerfile 採用 multi-stage build 概念，將建置階段與 runtime 階段分離：

| 階段            | 目的                            |
| ------------- | ----------------------------- |
| builder stage | 安裝 Python dependencies、建置所需套件 |
| runtime stage | 僅保留執行 ETL 所需的 runtime 環境      |

優點：

| 面向     | 傳統單層 image         | Multi-stage image   |
| ------ | ------------------ | ------------------- |
| 映像大小   | 較大，可能保留編譯工具        | 較小，只複製 runtime 必要內容 |
| 安全性    | 可能包含 gcc、cache、暫存檔 | 減少攻擊面               |
| CI 穩定性 | 容易受本機環境影響          | 環境一致                |
| 部署彈性   | 依賴本機 Python        | 可直接在雲端執行            |

---

### 2.4 本機測試指令

```bash
# 使用 docker compose 建置並執行 ETL
docker compose up

# 啟動本機預覽伺服器
docker compose --profile preview up

# 只重跑 ETL，不重建 image
docker compose run --rm etl

# 手動指定年度
docker run --rm \
  -e TARGET_YEAR=114 \
  -e OUTPUT_DIR=/app/output \
  -v $(pwd)/output:/app/output \
  traffic-etl:local
```

---

## 3. GitHub Actions CI/CD Layer

### 3.1 自動化流程

本專題使用 `.github/workflows/deploy.yml` 建立 CI/CD 流程。

觸發方式：

| 觸發方式                | 說明                |
| ------------------- | ----------------- |
| `push` 到 `main`     | 每次更新主分支時自動執行      |
| `workflow_dispatch` | 手動觸發，可指定民國年份      |
| `schedule`          | 每日 UTC 08:00 自動執行 |

---

### 3.2 CI/CD Job 架構

```text
Traffic ETL — Docker Build → AWS S3 + GitHub Pages
│
├── Job 1: Build Docker & Run ETL
│   ├── Checkout repository
│   ├── Set up Python
│   ├── Install dependencies
│   ├── pip-audit security scan
│   ├── pytest tests/
│   ├── docker build
│   ├── docker run ETL
│   ├── verify output files
│   ├── verify SaaS dashboard features
│   └── upload dashboard artifact
│
├── Job 2: Deploy to AWS S3 + CloudFront
│   ├── Check AWS secrets
│   ├── Configure AWS credentials using OIDC
│   ├── aws s3 sync
│   ├── CloudFront invalidation
│   └── print AWS deployment URL
│
└── Job 3: Deploy to GitHub Pages
    ├── Download dashboard artifact
    ├── Configure GitHub Pages
    ├── Upload Pages artifact
    ├── Deploy Pages
    └── print GitHub Pages URL
```

---

### 3.3 為什麼不用 Buildx

本專題目前採用：

```bash
docker build -t traffic-etl:ci .
```

而不是：

```bash
docker buildx build ...
```

原因是本專題目前不需要 multi-platform image、不需要推送 Docker registry，也不需要進階 remote cache。使用原生 `docker build` 可以降低 Docker Hub timeout、Buildx driver cache export 等外部因素造成的 CI 失敗。

目前需求是：

* 確認 Docker image 可建置
* 在 Docker container 內執行 ETL
* 產生靜態 Dashboard
* 部署到 AWS / GitHub Pages

因此 `docker build` + `docker run` 已足以符合課程要求中的 Docker 雲端技術應用。

---

## 4. AWS Hosting Layer

### 4.1 AWS 架構

本專題正式部署環境採用：

* **Amazon S3**：儲存靜態 Dashboard 檔案
* **Amazon CloudFront**：作為 CDN 與 HTTPS 入口
* **CloudFront Origin Access Control (OAC)**：限制 S3 Bucket 只能由 CloudFront 存取
* **GitHub Actions OIDC**：讓 workflow 使用短期憑證部署 AWS，避免存放長效 Access Key
* **CloudFormation**：使用 IaC 建立 S3 / CloudFront 基礎設施

---

### 4.2 AWS 部署架構圖

```text
使用者
  │
  │ HTTPS
  ▼
┌──────────────────────────────────────┐
│ AWS CloudFront                       │
│ - HTTPS                              │
│ - CDN cache                          │
│ - Global edge locations              │
│ - Origin Access Control              │
└──────────────────┬───────────────────┘
                   │ OAC
                   ▼
┌──────────────────────────────────────┐
│ Amazon S3 Bucket                     │
│ - Block Public Access                │
│ - Static dashboard files             │
│ - index.html / app.js / style.css    │
│ - dashboard_data.json / heatmap.html │
└──────────────────▲───────────────────┘
                   │ aws s3 sync
                   │
┌──────────────────────────────────────┐
│ GitHub Actions                       │
│ - OIDC token                         │
│ - Assume AWS IAM Role                │
│ - Upload files                       │
│ - Create CloudFront invalidation     │
└──────────────────────────────────────┘
```

---

### 4.3 S3 + CloudFront 設計理由

| 設計                      | 原因                           |
| ----------------------- | ---------------------------- |
| S3 不開公開存取               | 避免使用者直接繞過 CloudFront 讀取檔案    |
| CloudFront 對外提供 HTTPS   | 使用 CDN 提升載入速度與安全性            |
| OAC 限制來源存取              | 只有 CloudFront 可以讀取 S3        |
| `index.html` 不快取        | 確保使用者能取得最新頁面                 |
| 靜態資源短期快取                | 加速 JS / CSS / HTML assets 載入 |
| CloudFront invalidation | 每次部署後清除 CDN 快取               |

---

### 4.4 GitHub Actions OIDC

傳統 AWS 部署常見做法是把以下憑證放進 GitHub Secrets：

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
```

但長效金鑰風險較高。本專題改採 GitHub Actions OIDC：

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
      ├── S3 PutObject / DeleteObject / ListBucket
      └── CloudFront CreateInvalidation
```

GitHub Repository Secrets 只需要保存：

```text
AWS_OIDC_ROLE_ARN
S3_BUCKET_NAME
CLOUDFRONT_DIST_ID
CLOUDFRONT_DOMAIN
```

其中真正的 AWS 權限由 IAM Role 與 trust policy 控制，不需要在 GitHub 保存長效 AWS Access Key。

---

## 5. GitHub Pages Backup Deployment

### 5.1 備援用途

除了 AWS S3 + CloudFront，本專題也部署到 GitHub Pages 作為備援展示環境。

用途：

* 老師可以直接打開 GitHub Pages URL 看 Demo
* AWS secrets 未設定時，仍可展示 Dashboard
* 作為開發 / 測試 / 備援環境
* 保留完整 CI/CD 展示效果

---

### 5.2 GitHub Pages Custom Workflow

GitHub Pages 部署流程：

```text
build-and-run job
      │
      │ upload dashboard-output artifact
      ▼
deploy-pages job
      │
      ├── download dashboard-output
      ├── actions/configure-pages
      ├── actions/upload-pages-artifact
      └── actions/deploy-pages
```

部署 job 使用：

```yaml
permissions:
  contents: read
  pages: write
  id-token: write

environment:
  name: github-pages
```

這樣 GitHub Actions 就可以把前一個 job 產出的 `output/` 內容部署為 GitHub Pages 網站。

---

## 6. SaaS Frontend Layer

### 6.1 SaaS Dashboard 功能

前端不只是靜態圖表，而是具備 SaaS 服務常見的動態行為：

| 功能                     | 說明                                             |
| ---------------------- | ---------------------------------------------- |
| 會員登入 Demo              | 使用 sessionStorage 模擬會員登入狀態                     |
| Premium Lock           | 未登入時鎖定會員分析區                                    |
| 動態條件查詢                 | 依月份與性別篩選 dashboard_data.json                   |
| SubscriptionService    | Demo 模式用 localStorage 模擬訂閱通知服務                 |
| NotificationService    | 記錄資料載入、訂閱、查詢、健康檢查等通知                           |
| ActivityLogService     | 記錄使用者操作行為                                      |
| API Health Check       | Demo 模式模擬 API 狀態，Production 模式預留 `/api/health` |
| Demo / Production Mode | 前端架構預留正式 API 串接點                               |

---

### 6.2 Demo Mode vs Production Mode

| 項目         | Demo Mode                     | Production Mode                  |
| ---------- | ----------------------------- | -------------------------------- |
| 會員登入       | sessionStorage 模擬             | AWS Cognito / OAuth              |
| 訂閱資料更新     | localStorage 模擬               | API Gateway + Lambda + SNS / SES |
| 通知中心       | 前端 state 模擬                   | DynamoDB / WebSocket / Email     |
| API Health | 前端 mock response              | `/api/health`                    |
| 資料來源       | `dashboard_data.json`         | 後端 API / S3 JSON                 |
| 部署環境       | GitHub Pages / CloudFront 靜態站 | AWS CloudFront + API Gateway     |

---

### 6.3 訂閱通知正式環境預留架構

目前 Demo 模式：

```text
使用者輸入 Email
      │
      ▼
SubscriptionService.subscribeDemo()
      │
      ▼
localStorage 儲存訂閱者
      │
      ▼
NotificationService 顯示訂閱成功
```

正式環境可擴充為：

```text
使用者輸入 Email
      │
      ▼
POST /api/subscribe
      │
      ▼
Amazon API Gateway
      │
      ▼
AWS Lambda
      │
      ├── DynamoDB：儲存 subscriber
      └── SNS / SES：寄送 Email 訂閱確認或更新通知
```

---

## 7. 資安設計

### 7.1 CI/CD 資安

| 項目              | 設計                                 |
| --------------- | ---------------------------------- |
| 依賴套件掃描          | `pip-audit` 檢查 Python dependencies |
| 單元測試            | `pytest tests/ -v`                 |
| AWS 憑證          | 使用 OIDC 短期憑證，不使用長效 Access Key      |
| AWS secrets 檢查  | workflow 先檢查 secrets 是否完整          |
| Docker 隔離       | ETL 在 container 中執行                |
| S3 存取控制         | 不開放公開存取，透過 CloudFront OAC 讀取       |
| CloudFront 快取更新 | 部署後執行 invalidation                 |

---

### 7.2 前端 Demo 資安限制

目前前端會員登入與訂閱功能是 Demo 模式，重點是展示 SaaS 動態行為，不應視為正式身份驗證。

Demo 限制：

* 密碼不驗證真實帳號
* sessionStorage 只保存 Demo token
* localStorage 只模擬訂閱資料
* 不處理敏感個資
* 不寄送真實 Email

正式環境建議：

* 使用 AWS Cognito 或 OAuth 2.0
* 使用 API Gateway + Lambda 驗證請求
* 使用 DynamoDB 儲存訂閱資料
* 使用 SNS / SES 寄送通知
* 使用 CloudWatch Logs 監控後端狀態

---

## 8. Course Requirement Mapping

期末專題要求：

> 以 Docker、Kubernetes、AWS、OpenStack、OAuth、SDN 其中一種雲端平台或雲端技術為基礎，開發應用服務，或使用雲端 SaaS 服務 API 開發服務。

本專題對應如下：

| 課程要求技術               | 本專題對應實作                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| Docker               | 使用 Dockerfile 封裝 ETL Pipeline；GitHub Actions 執行 `docker build` 與 `docker run` |
| AWS                  | 使用 S3 + CloudFront 部署正式靜態網站；使用 OIDC 免長效金鑰部署                                   |
| GitHub Actions CI/CD | 自動測試、安全掃描、建置 Docker image、執行 ETL、部署網站                                         |
| SaaS 服務概念            | 會員登入、訂閱通知、通知中心、活動紀錄、API Health Check、Demo / Production Mode                   |
| OAuth / OIDC 概念      | GitHub Actions 使用 OIDC 與 AWS IAM Role 建立信任關係；前端預留 Cognito / OAuth 擴充方向        |
| IaC                  | 使用 CloudFormation 建立 S3 / CloudFront 基礎設施                                     |
| 備援部署                 | GitHub Pages 作為 AWS 以外的備援展示站                                                  |

---

## 9. 專題亮點

1. **容器化資料處理**
   ETL Pipeline 不依賴本機 Python 環境，而是透過 Docker 統一執行環境。

2. **完整 CI/CD**
   從測試、資安掃描、Docker build、Docker run 到雲端部署全部自動化。

3. **AWS 正式部署架構**
   使用 S3 + CloudFront 作為 production hosting layer。

4. **OIDC 免長效金鑰**
   GitHub Actions 不保存 AWS Access Key，而是透過 OIDC 取得短期權限。

5. **SaaS Dashboard 動態行為**
   前端具備會員登入、訂閱通知、通知中心、活動紀錄與 API Health Check。

6. **Demo / Production 分離**
   Demo 模式可直接在靜態網站運作，Production 模式可擴充至 API Gateway、Lambda、SNS、SES、DynamoDB 與 Cognito。

7. **備援部署**
   同時支援 AWS CloudFront 與 GitHub Pages，確保展示穩定性。

---

## 10. 未來擴充方向

| 擴充方向                 | 說明                                        |
| -------------------- | ----------------------------------------- |
| AWS Cognito          | 實作正式會員登入與 OAuth 流程                        |
| API Gateway + Lambda | 提供 `/api/subscribe`、`/api/health` 等正式 API |
| SNS / SES            | 實作真正 Email 訂閱通知                           |
| DynamoDB             | 儲存會員、訂閱者與通知紀錄                             |
| CloudWatch           | 監控 Lambda、ETL 與部署狀態                       |
| Kubernetes / ECS     | 將 ETL container 排程化執行                     |
| Route 53 + ACM       | 綁定自訂網域與 TLS 憑證                            |
| WAF                  | 保護 CloudFront 入口                          |
| OpenSearch           | 提供交通事故查詢與全文搜尋                             |
| Athena / Glue        | 對大量事故資料進行雲端查詢分析                           |

---

## 11. 結論

本專題不只是靜態交通事故視覺化網頁，而是一個結合 **Docker、AWS、GitHub Actions CI/CD 與 SaaS Dashboard** 的雲端資料服務平台。

透過 Docker，ETL Pipeline 可以在一致的容器環境中執行；透過 GitHub Actions，系統可以自動測試、建置、執行與部署；透過 AWS S3 + CloudFront，分析成果可以以正式雲端網站方式提供服務；透過前端 SaaS Dashboard，使用者能登入會員、篩選資料、訂閱通知、查看通知中心與活動紀錄。

因此，本專題符合課程對 Docker / AWS / SaaS 雲端技術應用的要求，也具備作品集展示與未來正式產品化的擴充潛力。

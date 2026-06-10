# 台灣交通事故資料分析 SaaS 平台

本專題是一個以 **Docker、AWS、GitHub Actions CI/CD 與 SaaS Dashboard** 為核心的交通事故資料分析平台。系統會自動從政府開放資料來源下載 A1/A2 交通事故資料，透過 Docker 容器執行 ETL、資料清洗、統計分析與視覺化，最後將產出的 Dashboard 部署至 **AWS S3 + CloudFront** 與 **GitHub Pages**。

平台前端提供會員登入、動態篩選、訂閱資料更新通知、通知中心、活動紀錄、API Health Check 等 SaaS Dashboard 行為。Demo 模式使用 `localStorage` / `sessionStorage` 模擬會員、訂閱與通知服務；正式環境可延伸串接 AWS API Gateway、Lambda、SNS、SES、DynamoDB 與 Cognito。

---

## Live Demo

| 環境             | 說明                                           | 連結                                                   |
| -------------- | -------------------------------------------- | ---------------------------------------------------- |
| GitHub Pages   | 備援展示站，可直接展示 Dashboard                        | `https://iando0911.github.io/traffic-data-pipeline/` |
| AWS CloudFront | 正式雲端部署環境，需設定 CloudFormation 與 GitHub Secrets | `https://<CLOUDFRONT_DOMAIN>`                        |

---

## 為什麼這是雲端 / SaaS 專題？

本專題不是單純的靜態網頁，而是結合資料工程、容器化、CI/CD 與雲端部署的完整服務流程。

| 課程要求技術               | 本專題對應實作                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| Docker               | 使用 Dockerfile 封裝 Python ETL Pipeline，GitHub Actions 透過 `docker build` / `docker run` 執行 |
| AWS                  | 使用 S3 儲存 Dashboard 靜態檔案，使用 CloudFront 作為 CDN 與 HTTPS 入口                                 |
| GitHub Actions CI/CD | 自動測試、安全掃描、Docker 建置、ETL 執行、部署 AWS / GitHub Pages                                        |
| OIDC                 | GitHub Actions 透過 AWS IAM OIDC Role 取得短期憑證，不使用長效 Access Key                             |
| SaaS Dashboard       | 會員登入、訂閱通知、通知中心、活動紀錄、API Health Check                                                    |
| IaC                  | 使用 CloudFormation 建立 S3、CloudFront、OAC、Bucket Policy                                    |
| 備援部署                 | AWS CloudFront 為正式環境，GitHub Pages 為備援展示環境                                               |

---

## 系統架構

```text
使用者瀏覽器
     │
     │ HTTPS
     ▼
┌──────────────────────────────────────────────┐
│ SaaS Dashboard Frontend                      │
│ - 會員登入 Demo                              │
│ - 動態資料篩選                               │
│ - 訂閱通知                                   │
│ - Notification Center                        │
│ - Activity Log                               │
│ - API Health Check                           │
└───────────────────┬──────────────────────────┘
                    │
                    │ 靜態 HTML / CSS / JS / JSON
                    ▼
┌──────────────────────────────────────────────┐
│ Hosting Layer                                │
│ - AWS CloudFront + S3                        │
│ - GitHub Pages Backup                        │
└───────────────────┬──────────────────────────┘
                    │
                    │ GitHub Actions artifact
                    ▼
┌──────────────────────────────────────────────┐
│ GitHub Actions CI/CD                         │
│ - pytest                                     │
│ - pip-audit                                  │
│ - docker build                               │
│ - docker run ETL                             │
│ - deploy AWS                                 │
│ - deploy GitHub Pages                        │
└───────────────────┬──────────────────────────┘
                    │
                    │ Docker container
                    ▼
┌──────────────────────────────────────────────┐
│ Docker ETL Layer                             │
│ - Python 3.11 runtime                         │
│ - 下載交通事故資料                            │
│ - 資料清洗與統計分析                          │
│ - 產生 Dashboard 靜態檔案                     │
└──────────────────────────────────────────────┘
```

詳細雲端架構請參考：

```text
CLOUD_ARCHITECTURE.md
```

---

## 功能概覽

### 資料工程功能

* **自動化 ETL**：支援 GitHub Actions 排程與手動觸發。
* **Docker 容器化**：統一 ETL 執行環境，避免本機環境差異。
* **資料下載**：從政府開放資料來源取得 A1/A2 交通事故資料。
* **資料清洗**：處理 Big5 / UTF-8 編碼容錯、座標欄位、年齡、性別與第一當事者資料。
* **統計分析**：包含 Welch's T-test、Cohen's d、月份趨勢、年齡分布與主要肇因分析。
* **輸出產物**：產生 HTML、JSON、CSS、JS 與互動式圖表。

### SaaS Dashboard 功能

* **會員登入 Demo**：使用 `sessionStorage` 模擬會員登入狀態。
* **Premium Lock**：未登入時鎖定會員分析功能。
* **動態資料篩選**：依月份、性別等條件篩選 Dashboard 資料。
* **訂閱資料更新通知**：使用 `localStorage` 模擬訂閱者資料。
* **通知中心**：顯示資料載入、訂閱、查詢與健康檢查事件。
* **活動紀錄**：記錄使用者登入、查詢、訂閱等操作。
* **API Health Check**：Demo 模式模擬 API 狀態；Production 模式可串接正式 `/api/health`。
* **Demo / Production Mode**：前端架構預留正式 API 串接點。

---

## 輸出檔案

ETL 執行完成後，所有產出會放在：

```text
output/
```

| 檔案                       | 說明                   |
| ------------------------ | -------------------- |
| `index.html`             | SaaS Dashboard 主頁    |
| `app.js`                 | 前端互動邏輯與 SaaS 模擬服務    |
| `style.css`              | Dashboard UI 樣式      |
| `dashboard_data.json`    | 前端互動用資料              |
| `cause_analysis.html`    | 主要肇事原因 TOP 15        |
| `age_distribution.html`  | 肇事主因者年齡分布圖           |
| `heatmap_age_month.html` | 年齡組 × 月份事故件數熱圖       |
| `monthly_trend.html`     | 各月份肇事趨勢折線圖           |
| `heatmap.html`           | 全台空間熱力地圖             |
| `pipeline_stats.html`    | 管線效能指標摘要表            |
| `stats_table.html`       | Welch's T-Test 統計摘要表 |
| `stats_summary.json`     | 統計指標 JSON            |

---

## 技術架構

| 分類              | 技術                                         |
| --------------- | ------------------------------------------ |
| Language        | Python 3.11、JavaScript、HTML、CSS            |
| Data Processing | pandas、NumPy                               |
| Statistics      | SciPy、Welch's T-test、Cohen's d             |
| Visualization   | Plotly、Folium、ECharts                      |
| Frontend        | Vanilla JavaScript、Responsive Dashboard UI |
| SaaS State      | localStorage、sessionStorage、Reactive State |
| Container       | Docker、Docker Compose                      |
| CI/CD           | GitHub Actions                             |
| Security Scan   | pip-audit                                  |
| Testing         | pytest                                     |
| Cloud Hosting   | AWS S3、AWS CloudFront                      |
| Cloud Auth      | GitHub Actions OIDC + AWS IAM Role         |
| IaC             | AWS CloudFormation                         |
| Backup Hosting  | GitHub Pages                               |

---

## 本機快速開始

### 前置需求

請先安裝：

* Docker 24+
* Docker Compose v2
* Git

---

### 1. Clone 專案

```bash
git clone https://github.com/iando0911/traffic-data-pipeline.git
cd traffic-data-pipeline
```

---

### 2. 使用 Docker Compose 執行 ETL

```bash
docker compose up
```

執行完成後會產生：

```text
output/
```

---

### 3. 啟動本機預覽

```bash
docker compose --profile preview up
```

瀏覽器開啟：

```text
http://localhost:8080
```

---

### 4. 只重跑 ETL

```bash
docker compose run --rm etl
```

---

### 5. 使用 docker run 指定年度

```bash
docker build -t traffic-etl:local .

docker run --rm \
  -e TARGET_YEAR=114 \
  -e OUTPUT_DIR=/app/output \
  -v $(pwd)/output:/app/output \
  traffic-etl:local
```

---

## GitHub Actions CI/CD

本專題使用：

```text
.github/workflows/deploy.yml
```

自動化流程如下：

```text
git push / workflow_dispatch / schedule
       │
       ▼
GitHub Actions
       │
       ├── Job 1: Build Docker & Run ETL
       │     ├── 安裝 Python dependencies
       │     ├── pip-audit 安全掃描
       │     ├── pytest 單元測試
       │     ├── docker build
       │     ├── docker run ETL
       │     ├── 驗證 output/ 必要檔案
       │     └── upload dashboard artifact
       │
       ├── Job 2: Deploy to AWS S3 + CloudFront
       │     ├── GitHub OIDC 認證 AWS
       │     ├── aws s3 sync
       │     └── CloudFront invalidation
       │
       └── Job 3: Deploy to GitHub Pages
             ├── configure-pages
             ├── upload-pages-artifact
             └── deploy-pages
```

觸發方式：

| 觸發方式                | 說明                |
| ------------------- | ----------------- |
| `push` 到 `main`     | 每次更新主分支時自動部署      |
| `workflow_dispatch` | 手動觸發，可指定民國年份      |
| `schedule`          | 每日 UTC 08:00 自動執行 |

---

## AWS S3 + CloudFront 部署

本專題正式雲端部署使用：

```text
aws/cloudformation.yml
```

建立以下資源：

| AWS 資源                  | 用途                      |
| ----------------------- | ----------------------- |
| S3 Bucket               | 儲存 Dashboard 靜態檔案       |
| CloudFront Distribution | CDN、HTTPS 與公開入口         |
| Origin Access Control   | 讓 CloudFront 安全讀取私有 S3  |
| Bucket Policy           | 限制只有 CloudFront 可以讀取 S3 |
| Outputs                 | 輸出 GitHub Secrets 需要的值  |

---

### 1. 部署 CloudFormation

```bash
aws cloudformation deploy \
  --template-file aws/cloudformation.yml \
  --stack-name traffic-dashboard \
  --parameter-overrides ProjectName=traffic-dashboard \
  --region ap-northeast-1
```

---

### 2. 查詢 CloudFormation Outputs

```bash
aws cloudformation describe-stacks \
  --stack-name traffic-dashboard \
  --region ap-northeast-1 \
  --query "Stacks[0].Outputs"
```

記下：

| Output Key                 | 對應 GitHub Secret     |
| -------------------------- | -------------------- |
| `S3BucketName`             | `S3_BUCKET_NAME`     |
| `CloudFrontDistributionId` | `CLOUDFRONT_DIST_ID` |
| `CloudFrontDomain`         | `CLOUDFRONT_DOMAIN`  |

---

### 3. 設定 AWS OIDC

請參考：

```text
aws/iam-oidc-setup.md
```

需要建立：

* GitHub OIDC Provider
* AWS IAM Role
* Trust Policy
* S3 / CloudFront 最小權限 Policy

最後將 Role ARN 存入 GitHub Secret：

```text
AWS_OIDC_ROLE_ARN
```

---

### 4. 設定 GitHub Repository Secrets

進入：

```text
Settings → Secrets and variables → Actions → New repository secret
```

建立：

| Secret 名稱            | 值來源                                               |
| -------------------- | ------------------------------------------------- |
| `AWS_OIDC_ROLE_ARN`  | IAM Role ARN                                      |
| `S3_BUCKET_NAME`     | CloudFormation Output: `S3BucketName`             |
| `CLOUDFRONT_DIST_ID` | CloudFormation Output: `CloudFrontDistributionId` |
| `CLOUDFRONT_DOMAIN`  | CloudFormation Output: `CloudFrontDomain`         |

---

## GitHub Pages 備援部署

GitHub Pages 作為備援展示環境，即使 AWS Secrets 尚未設定，也可以展示 Dashboard。

請確認 repository 設定：

```text
Settings → Pages → Build and deployment → Source → GitHub Actions
```

以及：

```text
Settings → Actions → General → Workflow permissions → Read and write permissions
```

部署成功後可開啟：

```text
https://iando0911.github.io/traffic-data-pipeline/
```

---

## 測試方式

### 執行全部測試

```bash
PYTHONPATH=. pytest tests/ -v
```

或：

```bash
pytest tests/ -v
```

### 測試範圍

| 測試檔案                              | 內容                                       |
| --------------------------------- | ---------------------------------------- |
| `tests/test_utils.py`             | 工具函式、日期轉換、月份完整性、尖離峰分類                    |
| `tests/test_project_structure.py` | 專案結構、SaaS 前端元素、Docker / AWS / CI/CD 文件檢查 |

期望結果：

```text
67 passed
```

---

## 專案結構

```text
.
├── main.py                       # ETL 主程式
├── requirements.txt              # Python 依賴
├── Dockerfile                    # Docker image 定義
├── docker-compose.yml            # 本機開發與預覽
├── README.md                     # 專案首頁說明
├── CLOUD_ARCHITECTURE.md         # 雲端架構說明
├── .github/
│   ├── dependabot.yml            # Dependabot 套件更新設定
│   └── workflows/
│       └── deploy.yml            # GitHub Actions CI/CD
├── aws/
│   ├── cloudformation.yml        # AWS S3 + CloudFront IaC
│   └── iam-oidc-setup.md         # AWS OIDC 認證設定說明
├── tests/
│   ├── test_utils.py             # 工具函式測試
│   └── test_project_structure.py # 專案結構與雲端架構測試
├── web/
│   ├── index.html                # SaaS Dashboard HTML
│   ├── app.js                    # SaaS Dashboard JavaScript
│   └── style.css                 # SaaS Dashboard CSS
└── output/
    ├── index.html
    ├── app.js
    ├── style.css
    ├── dashboard_data.json
    ├── heatmap.html
    └── ...                       # ETL 動態產出檔案
```

> `output/` 為 ETL 產出目錄，通常不需要手動編輯。

---

## 資料來源

本專題使用政府開放資料中的交通事故 A1/A2 類資料作為分析來源。ETL Pipeline 會依指定民國年份下載資料，預設分析民國 115 年，並將資料轉換為 Dashboard 可使用的統計結果與互動資料。

---

## Demo Mode 與 Production Mode

| 模式              | 說明                                                  |
| --------------- | --------------------------------------------------- |
| Demo Mode       | 前端使用 `localStorage` / `sessionStorage` 模擬會員、訂閱與通知功能 |
| Production Mode | 可延伸串接 API Gateway、Lambda、DynamoDB、SNS、SES、Cognito   |

正式 SaaS 架構可擴充如下：

```text
使用者
  │
  ▼
CloudFront Dashboard
  │
  ▼
API Gateway
  │
  ▼
Lambda
  ├── DynamoDB：會員 / 訂閱 / 通知資料
  ├── SNS / SES：Email 通知
  └── CloudWatch：Log 與監控
```

---

## 期末專題評分對照

| 評分重點               | 本專題內容                                                  |
| ------------------ | ------------------------------------------------------ |
| 使用 Docker          | ETL Pipeline 完整容器化，CI 使用 `docker build` / `docker run` |
| 使用 AWS             | S3 + CloudFront 正式部署，CloudFormation 建立資源               |
| 使用 OAuth / OIDC 概念 | GitHub Actions OIDC 認證 AWS IAM Role                    |
| 使用 CI/CD           | GitHub Actions 自動測試、建置、部署                              |
| SaaS 服務特性          | 會員登入、訂閱通知、通知中心、活動紀錄、API Health Check                   |
| 資料分析價值             | 交通事故肇因、年齡、月份、地理熱點分析                                    |
| 工程完整度              | 測試、安全掃描、Docker、IaC、雙軌部署                                |
| 可展示性               | GitHub Pages 與 AWS CloudFront 皆可展示                     |

---

## 未來擴充方向

| 擴充方向                 | 說明                                                 |
| -------------------- | -------------------------------------------------- |
| AWS Cognito          | 實作正式會員登入與 OAuth 流程                                 |
| API Gateway + Lambda | 實作 `/api/subscribe`、`/api/health`、`/api/dashboard` |
| DynamoDB             | 儲存會員、訂閱者、通知與活動紀錄                                   |
| SNS / SES            | 寄送資料更新通知 Email                                     |
| CloudWatch           | 監控 Lambda、ETL 與部署狀態                                |
| EventBridge          | 排程觸發 ETL 或資料更新事件                                   |
| ECS / Kubernetes     | 將 Docker ETL container 部署為雲端排程任務                   |
| Route 53 + ACM       | 綁定自訂網域與 TLS 憑證                                     |
| AWS WAF              | 保護 CloudFront 入口                                   |
| Athena / Glue        | 對大量交通事故資料進行雲端查詢分析                                  |

---

## 專題結論

本專題以台灣交通事故資料為主題，結合 **Docker 容器化資料處理、GitHub Actions CI/CD、自動化測試、安全掃描、AWS S3 + CloudFront 雲端部署、GitHub Pages 備援展示與 SaaS Dashboard 前端互動功能**。

它不只是資料視覺化網頁，而是一個具備雲端部署流程、SaaS 產品雛形與未來正式服務擴充方向的完整雲端應用專題。

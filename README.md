# 台灣交通事故資料分析 SaaS 平台

本專題是一個以 Docker、AWS 與 GitHub Actions 為基礎的交通事故資料分析 SaaS 平台。系統會自動從內政部警政署開放資料下載 A1/A2 交通事故資料，透過 Docker 容器執行 ETL、統計分析與視覺化，並將產出的 Dashboard 部署至 AWS S3 + CloudFront 與 GitHub Pages。

平台前端提供會員登入、動態篩選、訂閱資料更新通知、通知中心、活動紀錄、API Health Check 等 SaaS Dashboard 行為。Demo 模式使用 localStorage 模擬訂閱與通知服務；正式環境可串接 AWS API Gateway、Lambda、SNS、SES 與 Cognito。

---

## 功能概覽

- **自動化 ETL**：每日 UTC 08:00 排程下載，支援 Big5/UTF-8 編碼容錯與記憶體解壓縮
- **資料清洗**：第一當事者純化、座標/年齡/性別缺失率統計
- **統計分析**：Welch's T-test、Cohen's d 效果量
- **視覺化輸出**：肇因排行、年齡小提琴圖、月份趨勢、熱力地圖（Folium + Plotly）
- **雙軌部署**：AWS S3 + CloudFront（正式）+ GitHub Pages（備援）
- **工程與資安**：內建單元測試 (`pytest`) 與依賴套件漏洞掃描 (`pip-audit`)

---

## 輸出檔案

| 檔案 | 說明 |
|---|---|
| `cause_analysis.html` | 主要肇事原因 TOP 15（依性別分色） |
| `age_distribution.html` | 肇事主因者年齡分布小提琴圖 |
| `heatmap_age_month.html` | 年齡組 × 月份事故件數熱圖 |
| `monthly_trend.html` | 各月份肇事趨勢折線圖 |
| `heatmap.html` | 全台空間熱力地圖（Folium） |
| `pipeline_stats.html` | 管線效能指標摘要表 |
| `stats_table.html` | Welch's T-Test 統計摘要表 |
| `stats_summary.json` | 所有統計指標（機器可讀） |
| `dashboard_data.json` | 前端互動用資料庫（CSR 架構） |

> **💡 提示：** 以上動態生成的檔案與前端靜態資源，於 ETL 執行完畢後皆會統一輸出至 `output/` 目錄。

---

## 本機快速開始

### 前置需求

- Docker 24+
- Docker Compose v2

### 執行 ETL

```bash
# 建置映像並執行（產出至 ./output/）
docker compose up

# 含本機預覽伺服器（http://localhost:8080）
docker compose --profile preview up

# 只重跑 ETL（不重建映像）
docker compose run --rm etl

# 指定民國年份（預設 115）
docker run --rm \
  -e TARGET_YEAR=114 \
  -v $(pwd)/output:/app/output \
  traffic-etl:local
雲端部署（AWS）第一步：用 CloudFormation 建立基礎設施Bashaws cloudformation deploy \
  --template-file cloudformation.yml \
  --stack-name traffic-dashboard \
  --capabilities CAPABILITY_IAM
部署完成後，從 CloudFormation Outputs 取得以下三個值：Output Key對應 GitHub SecretS3BucketNameS3_BUCKET_NAMECloudFrontDistributionIdCLOUDFRONT_DIST_IDCloudFrontDomainCLOUDFRONT_DOMAIN第二步：設定 GitHub OIDC 認證在 AWS IAM 建立 OIDC Identity Provider（token.actions.githubusercontent.com）與對應 Role，授予 S3 與 CloudFront 操作權限，並將 Role ARN 存入：GitHub Secret：AWS_OIDC_ROLE_ARN第三步：設定 GitHub Repository前往 Settings → Environments，建立 production 環境（可選：設定需要審核的 Protection Rules）。GitHub Actions 會在每次 push 到 main 或每日排程時自動執行三個 Job：Plaintext🐳 Build Docker & Run ETL
  ├─ ☁️  Deploy to AWS S3 + CloudFront
  └─ 📄 Deploy to GitHub Pages
目錄結構Plaintext.
├── main.py                  # ETL 主程式
├── requirements.txt         # Python 依賴
├── Dockerfile               # 多階段建置（builder + runtime）
├── docker-compose.yml       # 本機開發用
├── cloudformation.yml       # AWS 基礎設施（S3 + CloudFront）
├── .github/
│   ├── dependabot.yml       # 🤖 Dependabot 套件更新設定
│   └── workflows/
│       └── deploy.yml       # CI/CD 流水線
├── tests/                   # 🧪 單元測試目錄
│   └── test_utils.py        # 工具函式測試檔
├── web/                     # 🌐 前端靜態資源（僅放原始手寫檔）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── aws/
│   └── iam-oidc-setup.md    # AWS OIDC 認證設定說明
├── output/                  # 📂 ETL 產出（git ignored，含 HTML/JSON 與靜態檔）
└── CLOUD_ARCHITECTURE.md    # 雲端架構說明

資料來源
內政部警政署交通事故資料（A1/A2 類），透過政府資料開放平臺 API 取得。資料依民國年份篩選，預設分析最近一個完整年度（民國 115 年）。

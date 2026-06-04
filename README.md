# 台灣交通事故自動化分析管線

自動從內政部警政署開放資料下載 A1/A2 交通事故資料，執行統計分析與視覺化，並透過 Docker + GitHub Actions 部署至 AWS CloudFront 與 GitHub Pages。

---

## 功能概覽

- **自動化 ETL**：每日 UTC 08:00 排程下載，支援 Big5/UTF-8 編碼容錯與記憶體解壓縮
- **資料清洗**：第一當事者純化、座標/年齡/性別缺失率統計
- **統計分析**：Welch's T-test、Cohen's d 效果量
- **視覺化輸出**：肇因排行、年齡小提琴圖、月份趨勢、熱力地圖（Folium + Plotly）
- **雙軌部署**：AWS S3 + CloudFront（正式）+ GitHub Pages（備援）

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
```

---

## 雲端部署（AWS）

### 第一步：用 CloudFormation 建立基礎設施

```bash
aws cloudformation deploy \
  --template-file cloudformation.yml \
  --stack-name traffic-dashboard \
  --capabilities CAPABILITY_IAM
```

部署完成後，從 CloudFormation Outputs 取得以下三個值：

| Output Key | 對應 GitHub Secret |
|---|---|
| `S3BucketName` | `S3_BUCKET_NAME` |
| `CloudFrontDistributionId` | `CLOUDFRONT_DIST_ID` |
| `CloudFrontDomain` | `CLOUDFRONT_DOMAIN` |

### 第二步：設定 GitHub OIDC 認證

在 AWS IAM 建立 OIDC Identity Provider（`token.actions.githubusercontent.com`）與對應 Role，授予 S3 與 CloudFront 操作權限，並將 Role ARN 存入：

- GitHub Secret：`AWS_OIDC_ROLE_ARN`

### 第三步：設定 GitHub Repository

前往 `Settings → Environments`，建立 `production` 環境（可選：設定需要審核的 Protection Rules）。

GitHub Actions 會在每次 push 到 `main` 或每日排程時自動執行三個 Job：

```
🐳 Build Docker & Run ETL
  └─ ☁️  Deploy to AWS S3 + CloudFront
  └─ 📄 Deploy to GitHub Pages
```

---

## 目錄結構

```
.
├── main.py                  # ETL 主程式
├── requirements.txt         # Python 依賴
├── Dockerfile               # 多階段建置（builder + runtime）
├── docker-compose.yml       # 本機開發用
├── cloudformation.yml       # AWS 基礎設施（S3 + CloudFront）
├── .github/
│   └── workflows/
│       └── deploy.yml       # CI/CD 流水線
├── output/                  # ETL 產出（git ignored）
└── CLOUD_ARCHITECTURE.md    # 雲端架構說明
```

---

## 資料來源

內政部警政署交通事故資料（A1/A2 類），透過[政府資料開放平臺](https://data.gov.tw) API 取得。資料依民國年份篩選，預設分析最近一個完整年度（民國 115 年）。

---

## License

MIT

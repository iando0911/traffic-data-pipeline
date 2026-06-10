# 台灣交通事故資料分析 SaaS 平台 — 雲端部署架構說明

本專題以 Docker、AWS、GitHub Actions CI/CD 與 SaaS Dashboard 為核心，建立一個可自動化執行 ETL、產生交通事故分析結果、並部署到雲端的資料服務平台。

系統分為四層：

1. Docker ETL Layer：封裝 Python 資料處理與視覺化流程。
2. GitHub Actions CI/CD Layer：自動測試、建置 Docker image、執行 ETL、部署網站。
3. AWS Hosting Layer：使用 S3 儲存靜態 Dashboard，並透過 CloudFront CDN 對外提供 HTTPS 網站。
4. SaaS Frontend Layer：提供會員登入、動態篩選、訂閱通知、通知中心、活動紀錄與 API Health Check 等互動服務。

本專題同時保留 GitHub Pages 作為備援展示環境，確保即使 AWS 尚未完整設定，也能展示 SaaS Dashboard 與資料分析結果。

---

## 1. Docker 容器化（符合「Docker 雲端技術」要求）

### 架構說明

```
┌─────────────────────────────────────────┐
│          GitHub Actions Runner          │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │        Docker Container          │   │
│  │  ┌────────────────────────────┐  │   │
│  │  │  Python 3.11-slim (runtime)│  │   │
│  │  │                            │  │   │
│  │  │  ① requests → 警政署 API    │  │   │
│  │  │  ② BytesIO 記憶體解壓縮      │  │   │
│  │  │  ③ Big5/UTF-8 編碼容錯      │  │   │
│  │  │  ④ 第一當事者特徵純化        │  │   │
│  │  │  ⑤ Welch T + Cohen's d     │  │   │
│  │  │  ⑥ Folium + Plotly 渲染     │  │   │
│  │  └────────┬───────────────────┘  │   │
│  │           │ volume mount         │   │
│  └───────────┼──────────────────────┘   │
│              ▼                          │
│         ./output/*.html                 │
└─────────────────────────────────────────┘
```

### 多階段建置優點

| | 傳統單層 | 多階段 (multi-stage) |
|---|---|---|
| 映像大小 | ~1.2 GB | ~380 MB |
| 安全性 | 含 gcc 等編譯工具 | 僅 runtime 套件 |
| CI 速度 | 每次重新 pip install | 層快取，僅改動重建 |

### 本機測試指令

```bash
# 建置並執行 ETL
docker compose up

# 含本機預覽伺服器（http://localhost:8080）
docker compose --profile preview up

# 只重跑 ETL（不重建映像）
docker compose run --rm etl

# 指定年度
docker run --rm -e TARGET_YEAR=114 \
  -v $(pwd)/output:/app/output \
  traffic-etl:local
```

---

## 2. AWS S3 + CloudFront 靜態網站（符合「AWS 雲端平台」要求）

### 架構說明

```
使用者瀏覽器
     │
     │ HTTPS
     ▼
┌──────────────────────────────────────┐
│   AWS CloudFront (CDN)               │
│   - 全球邊緣節點（含亞太）             │
│   - 強制 HTTPS                       │
│   - HTTP/3 (QUIC) 支援               │
│   - Cache-Control 精細控制            │
└────────────────┬─────────────────────┘
                 │ Origin (OAC)
                 ▼
┌──────────────────────────────────────┐
│   AWS S3 Bucket                      │
│   - 不開放公開存取                    │
│   - 版本控制（支援回滾）              │
│   - 僅允許 CloudFront 讀取 (OAC)     │
└──────────────────────────────────────┘
         ▲
         │ aws s3 sync
         │
┌──────────────────────────────────────┐
│   GitHub Actions                     │
│   (OIDC 免金鑰認證)                  │
└──────────────────────────────────────┘
```

### 與 GitHub Pages 的比較

| 面向 | GitHub Pages | AWS S3 + CloudFront |
|---|---|---|
| 費用 | 免費 | S3 ~$0.023/GB；CF 免費層 1TB/月 |
| CDN 節點 | GitHub 全球 CDN | AWS 450+ 邊緣節點 |
| 自訂網域 | 支援 | 支援（可綁 Route 53） |
| HTTPS | 自動 | 自動（ACM 免費憑證） |
| 存取控制 | 公開或私人 repo | 可配合 CloudFront Functions 做 IP 白名單 |
| 適合場景 | 開發展示 | 正式生產環境 |

---

## 3. 完整 CI/CD 流程圖

```
git push / 每日排程
       │
       ▼
GitHub Actions
  ├─ Job 1: 🐳 Docker Build + ETL Run
  │    ├─ docker build（建置 ETL image）
  │    ├─ docker run（產生 output/）
  │    └─ upload artifact
  │
  ├─ Job 2: ☁️ AWS Deploy（需 Job 1 完成）
  │    ├─ OIDC 認證 AWS（無長效金鑰）
  │    ├─ aws s3 sync output/ → S3
  │    └─ CloudFront CreateInvalidation
  │
  └─ Job 3: 📄 GitHub Pages（需 Job 1 完成）
       └─ actions/deploy-pages
```

---

## 4. 所使用的雲端技術對照表（期末專題評分用）

| 課程要求技術 | 本專題對應實作 |
|---|---|
| **Docker** | Dockerfile 多階段建置；GitHub Actions 以 Docker container 執行 ETL |
| **AWS** | S3 靜態網站儲存；CloudFront CDN 全球分發；CloudFormation IaC 一鍵部署；IAM OIDC 無密鑰認證 |
| GitHub Actions（原有） | 排程觸發、自動化流水線 |
| GitHub Pages（原有） | 免費靜態網站托管（保留作備援） |

# ──────────────────────────────────────────────
# Stage 1: builder — install heavy deps once
# ──────────────────────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /app

# 系統相依套件（編譯 numpy/scipy 所需）
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip \
    && pip install --no-cache-dir --prefix=/install -r requirements.txt


# ──────────────────────────────────────────────
# Stage 2: runtime — 精簡映像
# ──────────────────────────────────────────────
FROM python:3.11-slim AS runtime

WORKDIR /app

# 從 builder 複製已安裝套件
COPY --from=builder /install /usr/local

# 複製專案原始碼
COPY . .

# 建立輸出目錄（GitHub Actions volume mount 用）
RUN mkdir -p /app/output

# 預設執行 ETL 主程式
# 可透過環境變數覆寫目標年度，例如：
#   docker run -e TARGET_YEAR=114 ...
ENV TARGET_YEAR=115
ENV OUTPUT_DIR=/app/output
ENV PYTHONUNBUFFERED=1

CMD ["python", "main.py"]

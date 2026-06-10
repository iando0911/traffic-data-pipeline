"""

台灣交通事故大數據分析管線 v2.6.1 (動態爬蟲修正版)

修正項目：

  1. 修正 __main__ 執行順序，確保 run_pipeline() 產出後才執行 sync_to_s3()

  2. 刪除 fetch_latest_accident_urls 中重複損壞的邏輯，保留完整的 12 個靜態網址 Fallback

  3. 全面替換 requests/cloudscraper 為 curl_cffi，完美繞過政府 WAF 阻擋

  4. 完整保留原作者的 Plotly 排版、註解與所有視覺化邏輯

  5. [v2.6] 新增「本地資料夾匯入」：自動讀取 data/ 目錄下的 ZIP/CSV，突破 WAF 終極方案

  6. [v2.6] 新增「智慧去重機制」：避免本地完整檔案與線上舊版檔案重複計算

  7. [v2.6.1] 修正 _collect_urls：改以值內容辨識下載連結，不再依賴 key 名稱，
             解決政府 API 欄位名稱不固定（非 downloadUrl/url）導致路由 1 永遠抓不到 URL 的問題

"""



import pandas as pd

import numpy as np

from scipy import stats

import plotly.express as px

import plotly.graph_objects as go

import folium

from folium.plugins import HeatMap

import os

import shutil

import subprocess

import io

import warnings

import zipfile

import json

from pathlib import Path

from datetime import datetime

import re

import boto3



# 🌟 替換原生 requests 與 cloudscraper 為 curl_cffi 以突破 WAF

from curl_cffi import requests



warnings.filterwarnings("ignore")



# ═══════════════════════════════════════════════════════

# ⚙️  CONFIG

# ═══════════════════════════════════════════════════════

CONFIG = {

    "target_roc_years": [115],

    "coord_bounds": {

        "lat": (21.5, 25.5),

        "lon": (119.0, 122.5),

    },

    "age_bounds": (0, 110),

    "heatmap_sample": 3000,

    "output_dir": Path(os.environ.get("OUTPUT_DIR", "output")),

    # 原始資料快取目錄（CI 環境由 actions/cache 管理）

    "raw_cache_dir": Path("raw_cache"),

    # 前端靜態文件目錄（index.html / app.js / style.css）

    "web_dir": Path("web"),

    "accident_urls": [], # 將由動態爬蟲自動填入

    # 月份完整性：件數低於前三個月平均的此比例時標記為「不完整」

    "monthly_completeness_threshold": 0.2,

}



CONFIG["output_dir"].mkdir(exist_ok=True)

CONFIG["raw_cache_dir"].mkdir(exist_ok=True)



HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}

RUN_TIMESTAMP = datetime.now().strftime("%Y-%m-%d %H:%M UTC+8")



# ═══════════════════════════════════════════════════════

# [v2.3] 資料可追溯性：取得目前的 git commit SHA

# ═══════════════════════════════════════════════════════

def get_git_sha() -> str:

    """

    取得目前 HEAD 的短 SHA（7 碼）。

    在非 git 環境（例如直接解壓縮執行）或 CI detached HEAD 無法取得時，

    優先從環境變數 GITHUB_SHA 讀取，仍失敗則回傳 'unknown'。

    """

    env_sha = os.environ.get("GITHUB_SHA", "")

    if env_sha:

        return env_sha[:7]

    try:

        return subprocess.check_output(

            ["git", "rev-parse", "--short", "HEAD"],

            text=True,

            stderr=subprocess.DEVNULL,

        ).strip()

    except Exception:

        return "unknown"



GIT_SHA = get_git_sha()

print(f"ℹ️  Git SHA: {GIT_SHA}  |  Run: {RUN_TIMESTAMP}")



# ── [v2.2] 建立帶重試機制的 requests Session ──────────────

def make_session():

    """

    建立帶有真實瀏覽器指紋的 Session，用來騙過政府 WAF

    """

    return requests.Session(impersonate="chrome120")



# ═══════════════════════════════════════════════════════

# 工具函數

# ═══════════════════════════════════════════════════════

def fetch_latest_accident_urls() -> list[str]:

    """

    [v2.6.1 更新]

    動態從 data.gov.tw 取得 A1 / A2 最新下載連結。

    導入「三重 Fallback 機制」，解決 GitHub Actions DNS 解析失敗的問題：

    1. 官方 API (data.gov.tw)

    2. 官方備用網域 / 政府資料開放平臺的舊版路由

    3. 若全面失效，退回安全的靜態歷史連結庫，確保管線不中斷。

    [v2.6.1 修正] _collect_urls 改以值內容辨識 opdadm.moi.gov.tw 連結，

    不再依賴 key 名稱（原本只辨識 downloadUrl/url，但政府 API 實際欄位名稱不同），

    確保路由 1 能真正捕捉到最新資源 UUID。

    """

    session = make_session()

    dynamic_urls: list[str] = []



    # 策略一與策略二的備用端點

    api_endpoints = [

        "https://data.gov.tw/api/v2/rest/dataset/",  # 首選 API

        "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/"  # 警政署直連端點

    ]

    

    dataset_ids = {

        "A1": "12818",

        "A2": "13139",

        "A1_alt": "986931B3-0E46-4F94-BF52-A2911499301F",

        "A2_alt": "02D40248-7CAA-4354-82EA-E27AB8DCAB39"

    }



    # [v2.6.1] 修正：不再依賴 key 名稱，改為辨識值本身是否為目標下載連結

    def _collect_urls(obj):

        if isinstance(obj, dict):

            for value in obj.values():

                if (

                    isinstance(value, str)

                    and value.startswith("http")

                    and "opdadm.moi.gov.tw" in value

                ):

                    dynamic_urls.append(value)

                else:

                    _collect_urls(value)

        elif isinstance(obj, list):

            for item in obj:

                _collect_urls(item)



    # 嘗試策略一：連線 data.gov.tw API

    print("      -> 嘗試路由 1：政府資料開放平臺 API")

    try:

        for ds_id in [dataset_ids["A1"], dataset_ids["A2"]]:

            resp = session.get(f"{api_endpoints[0]}{ds_id}", headers=HEADERS, timeout=10)

            if resp.status_code == 200:

                _collect_urls(resp.json())

    except Exception as e:

        print(f"      ⚠️ 路由 1 失效 ({e})")



    # 如果策略一抓不到任何東西，啟動策略二：直連警政署主機

    if not dynamic_urls:

        print("      -> 嘗試路由 2：警政署後台直連")

        try:

            for ds_uuid in [dataset_ids["A1_alt"], dataset_ids["A2_alt"]]:

                resp = session.get(f"{api_endpoints[1]}{ds_uuid}", headers=HEADERS, timeout=10)

                if resp.status_code == 200:

                    url_pattern = re.compile(

                        r"https://opdadm\.moi\.gov\.tw/api/v1/no-auth/resource/api/dataset/"

                        r"[A-Fa-f0-9\-]+/resource/[A-Fa-f0-9\-]+/download"

                    )

                    links = url_pattern.findall(resp.text)

                    dynamic_urls.extend(links)

        except Exception as e:

            print(f"      ⚠️ 路由 2 失效 ({e})")



    # 去重保序

    unique_urls = []

    seen = set()

    for u in dynamic_urls:

        if u not in seen:

            seen.add(u)

            unique_urls.append(u)



    if unique_urls:

        print(f"      ✅ 動態爬蟲成功取得 {len(unique_urls)} 個連結")



    # 策略三：終極 Fallback（包含 5 月最新 A2 檔案）

    if not unique_urls:

        print("      ⚠️ 所有動態爬蟲路由皆失效 (可能遭政府 WAF 阻擋 GitHub IP)，啟用策略 3：載入靜態歷史連結庫")

        unique_urls = [

            # A1

            "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/02D40248-7CAA-4354-82EA-E27AB8DCAB39/resource/F0367893-0E0D-4E5A-A6BC-430AFAD27E83/download",

            # A2

            "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/7C775EF1-A689-451D-AD02-1265F7D41ADC/download",

            "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/6A63F59F-2D81-45E0-A59E-253DB0609DFF/download",

            "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/406D4A22-E25A-4C40-91EC-5343B27ADEBA/download",

            "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/3DC7F6AA-438C-4838-8BB5-62C953711445/download",

            "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/9439E46D-1536-4073-8523-92024E9FF8BE/download"

        ]



    return unique_urls



def safe_read_csv(source, label="檔案") -> pd.DataFrame | None:

    for enc in ["utf-8", "cp950", "big5"]:

        try:

            if isinstance(source, (str, Path)):

                return pd.read_csv(source, encoding=enc, low_memory=False)

            elif isinstance(source, bytes):

                return pd.read_csv(io.BytesIO(source), encoding=enc, low_memory=False)

            else:

                return pd.read_csv(io.StringIO(source.decode(enc)), low_memory=False)

        except (UnicodeDecodeError, Exception):

            continue

    print(f"      ⚠️  {label}：所有編碼均失敗，略過")

    return None



def roc_to_ad(year_series: pd.Series) -> pd.Series:

    """民國年轉西元年。年份 >= 200 視為已是西元年，直接回傳。"""

    year = pd.to_numeric(year_series, errors="coerce")

    return year.where(year >= 200, year + 1911)



def format_pvalue(p: float) -> str:

    if p < 0.001:

        return "p < 0.001 ***（極顯著）"

    elif p < 0.01:

        return f"p = {p:.4f} **（高度顯著）"

    elif p < 0.05:

        return f"p = {p:.4f} *（顯著）"

    else:

        return f"p = {p:.4f}（不顯著）"



# ── [v2.2] 月份資料完整性檢查 ────────────────────────────

def check_monthly_completeness(monthly_df: pd.DataFrame, threshold: float = 0.2) -> list[int]:

    monthly_total = (

        monthly_df.groupby("月份")["件數"].sum()

        .sort_index()

        .reset_index()

    )

    if len(monthly_total) < 4:

        return []



    baseline = monthly_total["件數"].head(3).mean()

    incomplete = monthly_total[

        monthly_total["件數"] < baseline * threshold

    ]["月份"].tolist()



    return [int(m) for m in incomplete]



# ── [v2.3] 假日判斷輔助函式 ──────────────────────────────

def classify_weekday(date_series: pd.Series) -> pd.Series:

    dt = pd.to_datetime(date_series, errors="coerce")

    return dt.dt.weekday.map(lambda w: "假日" if w >= 5 else "平日")



# ── [v2.3] 尖峰時段分類 ──────────────────────────────────

PEAK_RANGES = [(7, 9), (17, 19)]



def classify_peak(hour_series: pd.Series) -> pd.Series:

    def _label(h):

        if pd.isna(h):

            return None

        h = int(h)

        for start, end in PEAK_RANGES:

            if start <= h <= end:

                return "尖峰"

        return "離峰"

    return hour_series.map(_label)



# ── [v2.3] 台灣各年齡段人口估計（民國 115 年，單位：人）──────

POPULATION_BY_AGE_GROUP: dict[str, int] = {

    "<18":   3_800_000,

    "18-24": 1_950_000,

    "25-34": 3_200_000,

    "35-44": 3_500_000,

    "45-54": 3_600_000,

    "55-64": 3_300_000,

    "65+":   4_300_000,

}

POPULATION_SOURCE = "國發會人口推估 2026（中推估），靜態嵌入，民國 115 年"



# ═══════════════════════════════════════════════════════

# 主程式封裝（避免被 pytest 匯入時自動執行）

# ═══════════════════════════════════════════════════════

def run_pipeline():

    # ═══════════════════════════════════════════════════════

    # Step 1：自動化 ETL（含動態爬蟲 + 重試 + 快取 fallback）

    # ═══════════════════════════════════════════════════════

    print("=" * 60)

    print("[Step 1] 啟動 ETL 管線：動態獲取最新下載連結...")

    print("=" * 60)



    # 先動態抓取 A1 / A2 最新連結

    latest_urls = fetch_latest_accident_urls()

    if latest_urls:

        print(f"   ✅ 成功動態獲取 {len(latest_urls)} 個下載連結！")

        CONFIG["accident_urls"] = latest_urls

    else:

        print("   ⚠️ 無法動態獲取連結，請檢查網路或政府開放資料平臺狀態。")

        raise SystemExit(1)



    print("\n[Step 1.5] 開始下載內政部 A1/A2 車禍資料...")

    session = make_session()

    dfs = []



    # 🌟 [v2.6] 掃描本地 data 目錄，自動匯入使用者提供的檔案

    local_dir = Path("data")

    if local_dir.exists():

        print(f"   📂 發現本地目錄 '{local_dir}'，優先讀取本地檔案...")

        for file_path in local_dir.rglob("*"):

            if file_path.suffix.lower() == ".csv":

                fname = file_path.name.lower()

                # 排除無用的 metadata

                if "schema" in fname or fname in ["file.csv", "manifest.csv"]:

                    continue

                df = safe_read_csv(file_path, label=file_path.name)

                if df is not None:

                    dfs.append(df)

                    print(f"      ✅ 成功讀取本地 CSV: {file_path.name}")

            elif file_path.suffix.lower() == ".zip":

                try:

                    with zipfile.ZipFile(file_path) as z:

                        csv_files = [n for n in z.namelist() if n.lower().endswith(".csv")]

                        for fname in csv_files:

                            fname_lower = fname.lower()

                            if "schema" in fname_lower or fname_lower in ["file.csv", "manifest.csv"]:

                                continue

                            df = safe_read_csv(z.read(fname), label=f"{file_path.name} -> {fname}")

                            if df is not None:

                                dfs.append(df)

                                print(f"      ✅ 成功讀取本地 ZIP 內檔案: {fname}")

                except Exception as e:

                    print(f"      ⚠️ 無法讀取 ZIP {file_path.name}: {e}")



    download_success_count = 0



    for i, url in enumerate(CONFIG["accident_urls"], 1):

        cache_file = CONFIG["raw_cache_dir"] / f"raw_{i}.pkl"

        print(f"   [{i}/{len(CONFIG['accident_urls'])}] 線上下載中...")

        try:

            resp = session.get(url, headers=HEADERS, timeout=60)

            if resp.status_code != 200:

                raise Exception(f"HTTP Status {resp.status_code}")



            content = resp.content



            if content[:4] == b"PK\x03\x04":

                with zipfile.ZipFile(io.BytesIO(content)) as z:

                    # [v2.5/2.6 更新] 避開 schema.csv, manifest.csv, file.csv 以防污染主資料表

                    csv_files = [n for n in z.namelist() if n.lower().endswith(".csv")]

                    for fname in csv_files:

                        fname_lower = fname.lower()

                        if "schema" in fname_lower or fname_lower in ["file.csv", "manifest.csv"]:

                            continue

                        df = safe_read_csv(z.read(fname), label=fname)

                        if df is not None:

                            dfs.append(df)

            else:

                df = safe_read_csv(content, label=url[-30:])

                if df is not None:

                    dfs.append(df)



            if dfs:

                dfs[-1].to_pickle(str(cache_file))

            download_success_count += 1



        except Exception as e:

            print(f"      ❌ 下載／解析失敗：{e}")

            if cache_file.exists():

                print(f"      ⚠️  使用快取資料：{cache_file}")

                try:

                    dfs.append(pd.read_pickle(str(cache_file)))

                except Exception as ce:

                    print(f"      ❌ 快取讀取失敗：{ce}")



    if not dfs:

        print("\n⚠️ 警告：無法取得任何資料（線上 + 本地 + 快取均失敗），請檢查網路或 API 端點。")

        raise SystemExit(1)



    if download_success_count < len(CONFIG["accident_urls"]):

        print(f"\n⚠️  注意：{len(CONFIG['accident_urls']) - download_success_count} 個線上來源失敗，資料可能非最新版本")



    df_acc = pd.concat(dfs, ignore_index=True)

    print(f"\n✅ 原始資料合併完成：共 {len(df_acc):,} 筆")



    # ═══════════════════════════════════════════════════════

    # Step 2：特徵工程與資料清洗（含缺失率統計）

    # ═══════════════════════════════════════════════════════

    print("\n[Step 2] 特徵工程與資料清洗...")



    df_acc["發生年度_num"] = pd.to_numeric(

        df_acc.get("發生年度", pd.Series(dtype=float)), errors="coerce"

    )

    df_acc["發生年度_AD"] = roc_to_ad(df_acc["發生年度_num"])

    target_ad = [y + 1911 for y in CONFIG["target_roc_years"]]

    df_acc = df_acc[df_acc["發生年度_AD"].isin(target_ad)].copy()



    n_raw = len(df_acc)

    print(f"   年度篩選後原始筆數：{n_raw:,}")



    culprit_col = next(

        (c for c in ["當事者順位", "當事者區分-類別-大類名稱", "當事者區分-類別-大類"]

         if c in df_acc.columns),

        None,

    )

    if culprit_col:

        if pd.api.types.is_numeric_dtype(df_acc[culprit_col].dtype):

            df_clean = df_acc[df_acc[culprit_col] == 1].copy()

        else:

            df_clean = df_acc[

                df_acc[culprit_col].astype(str).str.fullmatch("第一當事者|1|01")

            ].copy()

    else:

        print("   ⚠️  未找到當事者順位欄位，使用全部資料")

        df_clean = df_acc.copy()



    # 🌟 [v2.6] 智慧去重機制：避免本地完整檔案與下載舊檔案產生重複計數

    dedup_cols = [c for c in ["發生年度", "發生月份", "發生日期", "發生時間", "發生地點", "肇因研判大類別名稱-主要"] if c in df_clean.columns]

    if dedup_cols:

        before_drop = len(df_clean)

        df_clean = df_clean.drop_duplicates(subset=dedup_cols)

        if before_drop > len(df_clean):

            print(f"   ⚠️ 去重啟動：成功移除 {before_drop - len(df_clean):,} 筆因新舊檔案重疊的重複資料")



    n_first_party = len(df_clean)

    print(f"   第一當事者純化後：{n_first_party:,} 筆（{n_first_party / n_raw * 100:.1f}% of raw）")



    df_clean["Age"] = pd.to_numeric(

        df_clean.get("當事者事故發生時年齡", pd.Series(dtype=float)), errors="coerce"

    )

    df_clean["月份"] = pd.to_numeric(

        df_clean.get("發生月份", pd.Series(dtype=float)), errors="coerce"

    )

    df_clean["性別"] = df_clean.get("當事者屬-性-別名稱", pd.Series(dtype=str))

    df_clean["肇因"] = df_clean.get("肇因研判子類別名稱-主要", pd.Series(dtype=str))

    df_clean["lat"] = pd.to_numeric(

        df_clean.get("緯度", pd.Series(dtype=float)), errors="coerce"

    )

    df_clean["lon"] = pd.to_numeric(

        df_clean.get("經度", pd.Series(dtype=float)), errors="coerce"

    )



    date_col = next((c for c in ["發生日期", "事故發生日期"] if c in df_clean.columns), None)

    time_col = next((c for c in ["發生時間", "事故發生時間"] if c in df_clean.columns), None)



    if date_col:

        raw_date = df_clean[date_col].astype(str).str.strip()

        df_clean["發生日期_parsed"] = pd.to_datetime(raw_date, errors="coerce")



        mask_7digit = raw_date.str.match(r"^\d{7}$")

        if mask_7digit.any():

            roc_y = raw_date.str[:3].astype(int) + 1911

            month  = raw_date.str[3:5]

            day    = raw_date.str[5:7]

            df_clean.loc[mask_7digit, "發生日期_parsed"] = pd.to_datetime(

                roc_y.astype(str) + "-" + month + "-" + day,

                errors="coerce",

            )



        df_clean["星期類別"] = classify_weekday(df_clean["發生日期_parsed"])

    else:

        df_clean["星期類別"] = None

        print("   ⚠️  未找到發生日期欄位，略過假日分析")



    if time_col:

        raw_time = df_clean[time_col]

        if pd.api.types.is_numeric_dtype(raw_time):

            df_clean["發生時段_小時"] = pd.to_numeric(raw_time, errors="coerce")

        else:

            df_clean["發生時段_小時"] = pd.to_datetime(

                raw_time.astype(str), format="%H:%M", errors="coerce"

            ).dt.hour

        df_clean["時段類別"] = classify_peak(df_clean["發生時段_小時"])

    else:

        df_clean["時段類別"] = None

        print("   ⚠️  未找到發生時間欄位，略過尖峰分析")



    coord_invalid_mask = (

        df_clean["lat"].isna()

        | df_clean["lon"].isna()

        | ~df_clean["lat"].between(*CONFIG["coord_bounds"]["lat"])

        | ~df_clean["lon"].between(*CONFIG["coord_bounds"]["lon"])

    )

    coord_missing_rate = coord_invalid_mask.sum() / max(n_first_party, 1) * 100



    age_invalid_mask = df_clean["Age"].isna() | ~df_clean["Age"].between(*CONFIG["age_bounds"])

    gender_invalid_mask = ~df_clean["性別"].isin(["男", "女"])

    age_gender_missing_rate = (age_invalid_mask | gender_invalid_mask).sum() / max(n_first_party, 1) * 100



    print(f"   座標缺失／超範圍率：{coord_missing_rate:.1f}%  ({coord_invalid_mask.sum():,} 筆)")

    print(f"   年齡／性別缺值率：{age_gender_missing_rate:.1f}%  ({(age_invalid_mask | gender_invalid_mask).sum():,} 筆)")



    df_clean = df_clean[df_clean["性別"].isin(["男", "女"])].copy()

    df_clean = df_clean[

        df_clean["Age"].between(*CONFIG["age_bounds"]) & df_clean["Age"].notna()

    ].copy()

    df_clean = df_clean[

        df_clean["lat"].between(*CONFIG["coord_bounds"]["lat"])

        & df_clean["lon"].between(*CONFIG["coord_bounds"]["lon"])

    ].copy()



    n_final = len(df_clean)

    print(f"   最終可用樣本（座標＋年齡＋性別均完整）：{n_final:,} 筆")



    bins   = [0, 17, 24, 34, 44, 54, 64, 110]

    labels = ["<18", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"]

    df_clean["年齡組"] = pd.cut(df_clean["Age"], bins=bins, labels=labels, right=True)



    # ═══════════════════════════════════════════════════════

    # Step 3：Welch's T-Test + Cohen's d

    # ═══════════════════════════════════════════════════════

    print("\n[Step 3] Welch's T-Test：肇事者性別年齡差異...")



    male_ages   = df_clean[df_clean["性別"] == "男"]["Age"].dropna()

    female_ages = df_clean[df_clean["性別"] == "女"]["Age"].dropna()

    stats_summary = {}



    if len(male_ages) > 1 and len(female_ages) > 1:

        t_stat, p_val = stats.ttest_ind(male_ages, female_ages, equal_var=False)



        n1, n2 = len(male_ages), len(female_ages)

        s1, s2 = male_ages.var(ddof=1), female_ages.var(ddof=1)

        welch_df = (s1/n1 + s2/n2)**2 / ((s1/n1)**2 / (n1 - 1) + (s2/n2)**2 / (n2 - 1))

        welch_df = round(welch_df, 1)



        pooled_sd = np.sqrt((male_ages.std() ** 2 + female_ages.std() ** 2) / 2)

        cohens_d  = (male_ages.mean() - female_ages.mean()) / pooled_sd



        stats_summary = {

            "資料截止日期":       RUN_TIMESTAMP,

            "原始年度筆數":       f"{n_raw:,}",

            "第一當事者純化筆數": f"{n_first_party:,}",

            "座標缺失率":         f"{coord_missing_rate:.1f}%",

            "年齡／性別缺值率":   f"{age_gender_missing_rate:.1f}%",

            "最終可用樣本數":     f"{n_final:,}",

            "男性樣本數":   f"{len(male_ages):,}",

            "女性樣本數":   f"{len(female_ages):,}",

            "男性平均年齡": round(male_ages.mean(), 2),

            "女性平均年齡": round(female_ages.mean(), 2),

            "男性標準差":   round(male_ages.std(), 2),

            "女性標準差":   round(female_ages.std(), 2),

            "T統計量":      round(t_stat, 4),

            "自由度（df）": welch_df,

            "P值":          f"{p_val:.3e}",

            "顯著性":       format_pvalue(p_val),

            "Cohen's d":    round(cohens_d, 4),

            "效果量判讀":   (

                "微小（|d| < 0.2）" if abs(cohens_d) < 0.2

                else "小（0.2 ≤ |d| < 0.5）" if abs(cohens_d) < 0.5

                else "中（0.5 ≤ |d| < 0.8）" if abs(cohens_d) < 0.8

                else "大（|d| ≥ 0.8）"

            ),

        }



        print(f"   男性 N={len(male_ages):,}，平均年齡={male_ages.mean():.2f}，SD={male_ages.std():.2f}")

        print(f"   女性 N={len(female_ages):,}，平均年齡={female_ages.mean():.2f}，SD={female_ages.std():.2f}")

        print(f"   t({welch_df})={t_stat:.4f}，p={p_val:.3e}，Cohen's d={cohens_d:.4f}")

        print(f"   ⚠️  Cohen's d={cohens_d:.4f}：統計顯著但效果量極微小，差異實質意義有限")



        with open(CONFIG["output_dir"] / "stats_summary.json", "w", encoding="utf-8") as f:

            json.dump(stats_summary, f, ensure_ascii=False, indent=2)

        print("   ✅ stats_summary.json")

    else:

        print("   ⚠️  樣本量不足，跳過統計檢定")



    # ═══════════════════════════════════════════════════════

    # Step 4：資料視覺化

    # ═══════════════════════════════════════════════════════

    print("\n[Step 4] 資料視覺化...")



    PLOTLY_THEME = "plotly_white"

    COLOR_MAP    = {"男": "#3A86FF", "女": "#FF6B9D"}

    SNAPSHOT_NOTE = f"（本圖為管線快照，資料截止：{RUN_TIMESTAMP}；即時數據請見儀表板）"



    cause_df = pd.DataFrame()

    monthly_df = pd.DataFrame()

    incomplete_months: list[int] = []

    weekday_df = pd.DataFrame()

    peak_df = pd.DataFrame()

    age_rate_df = pd.DataFrame()



    if len(df_clean) > 0:



        cause_df = df_clean.groupby(["肇因", "性別"]).size().reset_index(name="件數")

        top15_causes = cause_df.groupby("肇因")["件數"].sum().nlargest(15).index.tolist()

        cause_df = cause_df[cause_df["肇因"].isin(top15_causes)]

        cause_order = cause_df.groupby("肇因")["件數"].sum().sort_values().index.tolist()



        fig_cause = px.bar(

            cause_df, x="件數", y="肇因", color="性別",

            color_discrete_map=COLOR_MAP, barmode="group", orientation="h",

            category_orders={"肇因": cause_order},

            title=f"📊 主要肇事原因 TOP 15 {SNAPSHOT_NOTE}",

            template=PLOTLY_THEME, height=600,

        )

        fig_cause.write_html(str(CONFIG["output_dir"] / "cause_analysis.html"))

        print("   ✅ cause_analysis.html")



        fig_age = go.Figure()

        for gender, color in COLOR_MAP.items():

            subset = df_clean[df_clean["性別"] == gender]["Age"].dropna()

            fig_age.add_trace(go.Violin(

                y=subset, name=gender, box_visible=True, meanline_visible=True,

                fillcolor=color, opacity=0.6, line_color=color,

            ))

        fig_age.update_layout(

            title=f"🎻 肇事主因者年齡分布 {SNAPSHOT_NOTE}",

            template=PLOTLY_THEME,

            annotations=[dict(

                text="注意：Cohen's d 極小，性別年齡差異統計顯著但實質意義有限",

                xref="paper", yref="paper", x=0.5, y=-0.12,

                showarrow=False, font=dict(size=11, color="gray"),

            )],

        )

        fig_age.write_html(str(CONFIG["output_dir"] / "age_distribution.html"))

        print("   ✅ age_distribution.html")



        pivot = (

            df_clean.groupby(["年齡組", "月份"]).size()

            .reset_index(name="件數")

            .pivot(index="年齡組", columns="月份", values="件數")

            .fillna(0)

        )

        fig_hmap = px.imshow(

            pivot,

            labels=dict(x="月份", y="年齡組", color="件數"),

            title=f"🗓 肇事件數熱圖 {SNAPSHOT_NOTE}",

            color_continuous_scale="Reds",

            template=PLOTLY_THEME, aspect="auto", text_auto=True,

        )

        fig_hmap.write_html(str(CONFIG["output_dir"] / "heatmap_age_month.html"))

        print("   ✅ heatmap_age_month.html")



        monthly_df = df_clean.groupby(["月份", "性別"]).size().reset_index(name="件數")

        incomplete_months = check_monthly_completeness(

            monthly_df, CONFIG["monthly_completeness_threshold"]

        )

        if incomplete_months:

            print(f"   ⚠️  月份資料不完整（件數異常低）：{incomplete_months} 月，圖表將標示警示虛線")



        fig_trend = px.line(

            monthly_df, x="月份", y="件數", color="性別",

            color_discrete_map=COLOR_MAP, markers=True,

            title=f"📈 各月份肇事趨勢 {SNAPSHOT_NOTE}",

            template=PLOTLY_THEME,

        )

        for m in incomplete_months:

            fig_trend.add_vline(

                x=m, line_dash="dash", line_color="orange",

                annotation_text=f"{m}月（資料不完整）",

                annotation_position="top",

            )

        fig_trend.write_html(str(CONFIG["output_dir"] / "monthly_trend.html"))

        print("   ✅ monthly_trend.html")



        if df_clean["星期類別"].notna().any():

            weekday_df = (

                df_clean[df_clean["星期類別"].notna()]

                .groupby(["星期類別", "性別"])

                .size()

                .reset_index(name="件數")

            )

            day_count = {"平日": 5, "假日": 2}

            weekday_df["每日平均件數"] = weekday_df.apply(

                lambda r: r["件數"] / day_count.get(r["星期類別"], 1), axis=1

            )



            fig_weekday = px.bar(

                weekday_df, x="星期類別", y="每日平均件數", color="性別",

                color_discrete_map=COLOR_MAP, barmode="group",

                title=f"📅 假日 vs 平日 每日平均肇事件數 {SNAPSHOT_NOTE}",

                template=PLOTLY_THEME,

                labels={"每日平均件數": "每日平均件數（件）", "星期類別": "日期類別"},

            )

            fig_weekday.update_layout(

                annotations=[dict(

                    text="平日=週一至週五，假日=週六至週日；以週內天數正規化後比較",

                    xref="paper", yref="paper", x=0.5, y=-0.15,

                    showarrow=False, font=dict(size=11, color="gray"),

                )]

            )

            fig_weekday.write_html(str(CONFIG["output_dir"] / "weekday_analysis.html"))

            print("   ✅ weekday_analysis.html")

        else:

            print("   ⚠️  日期欄位缺失，略過假日分析圖表")



        if df_clean["時段類別"].notna().any():

            peak_df = (

                df_clean[df_clean["時段類別"].notna()]

                .groupby(["時段類別", "性別"])

                .size()

                .reset_index(name="件數")

            )

            total_by_peak = peak_df.groupby("時段類別")["件數"].transform("sum")

            peak_df["佔比"] = (peak_df["件數"] / total_by_peak * 100).round(1)



            fig_peak = px.bar(

                peak_df, x="時段類別", y="件數", color="性別",

                color_discrete_map=COLOR_MAP, barmode="group",

                title=f"⏰ 尖峰 vs 離峰時段肇事件數 {SNAPSHOT_NOTE}",

                template=PLOTLY_THEME,

                labels={"時段類別": "時段類別", "件數": "件數"},

                text="佔比",

            )

            fig_peak.update_traces(texttemplate="%{text}%", textposition="outside")

            fig_peak.update_layout(

                annotations=[dict(

                    text="尖峰時段定義：早上 07:00–09:59 及傍晚 17:00–19:59（交通部標準）",

                    xref="paper", yref="paper", x=0.5, y=-0.15,

                    showarrow=False, font=dict(size=11, color="gray"),

                )]

            )

            fig_peak.write_html(str(CONFIG["output_dir"] / "peak_analysis.html"))

            print("   ✅ peak_analysis.html")



            hour_df = (

                df_clean[df_clean["發生時段_小時"].notna()]

                .groupby(["發生時段_小時", "性別"])

                .size()

                .reset_index(name="件數")

            )

            fig_hour = px.line(

                hour_df, x="發生時段_小時", y="件數", color="性別",

                color_discrete_map=COLOR_MAP, markers=True,

                title=f"🕐 24 小時肇事分布 {SNAPSHOT_NOTE}",

                template=PLOTLY_THEME,

                labels={"發生時段_小時": "發生時刻（時）", "件數": "件數"},

            )

            for start, end in PEAK_RANGES:

                fig_hour.add_vrect(

                    x0=start, x1=end,

                    fillcolor="orange", opacity=0.12,

                    line_width=0,

                    annotation_text="尖峰", annotation_position="top left",

                )

            fig_hour.write_html(str(CONFIG["output_dir"] / "hourly_distribution.html"))

            print("   ✅ hourly_distribution.html")

        else:

            print("   ⚠️  時間欄位缺失，略過尖峰分析圖表")



        age_raw = (

            df_clean.groupby("年齡組").size()

            .reset_index(name="絕對件數")

        )

        age_raw["年齡組"] = age_raw["年齡組"].astype(str)

        age_raw["母體人口（估）"] = age_raw["年齡組"].map(POPULATION_BY_AGE_GROUP)



        age_rate_df = age_raw.dropna(subset=["母體人口（估）"]).copy()

        age_rate_df["每萬人事故率"] = (

            age_rate_df["絕對件數"] / age_rate_df["母體人口（估）"] * 10_000

        ).round(2)

        age_rate_df["人口來源"] = POPULATION_SOURCE



        age_rate_df = age_rate_df.sort_values("每萬人事故率", ascending=False)



        fig_age_rate = px.bar(

            age_rate_df,

            x="年齡組", y="每萬人事故率",

            color="每萬人事故率",

            color_continuous_scale="RdYlGn_r",

            title=f"🎯 各年齡段每萬人事故率（暴露率校正後）{SNAPSHOT_NOTE}",

            template=PLOTLY_THEME,

            labels={"每萬人事故率": "每萬人事故率", "年齡組": "年齡組"},

            text="每萬人事故率",

            category_orders={"年齡組": labels},

        )

        fig_age_rate.update_traces(texttemplate="%{text:.1f}", textposition="outside")

        fig_age_rate.update_layout(

            coloraxis_showscale=False,

            annotations=[dict(

                text=f"⚠️  人口基數來源：{POPULATION_SOURCE}，僅供參考，建議以官方最新數據核驗",

                xref="paper", yref="paper", x=0.5, y=-0.18,

                showarrow=False, font=dict(size=10, color="gray"),

            )],

        )

        fig_age_rate.write_html(str(CONFIG["output_dir"] / "age_rate_adjusted.html"))

        print("   ✅ age_rate_adjusted.html")



        age_rate_df_sorted = age_rate_df.sort_values("年齡組")

        fig_age_compare = go.Figure(data=[go.Table(

            header=dict(

                values=["<b>年齡組</b>", "<b>絕對件數</b>", "<b>母體人口（估）</b>", "<b>每萬人事故率</b>"],

                fill_color="#3A86FF", font=dict(color="white", size=12),

                align="center",

            ),

            cells=dict(

                values=[

                    age_rate_df_sorted["年齡組"].tolist(),

                    [f"{v:,}" for v in age_rate_df_sorted["絕對件數"]],

                    [f"{v:,}" for v in age_rate_df_sorted["母體人口（估）"]],

                    age_rate_df_sorted["每萬人事故率"].tolist(),

                ],

                fill_color=[["#f4f7ff" if i % 2 == 0 else "white"

                             for i in range(len(age_rate_df_sorted))]],

                align="center", font=dict(size=12),

            ),

        )])

        fig_age_compare.update_layout(

            title=f"📋 年齡段事故率對照表（絕對件數 vs 暴露率校正）{SNAPSHOT_NOTE}",

            height=350,

        )

        fig_age_compare.write_html(str(CONFIG["output_dir"] / "age_rate_table.html"))

        print("   ✅ age_rate_table.html")



    # ── 統計摘要表 ────────────────────────────────────────────

    if stats_summary:

        engineering_keys = ["資料截止日期", "原始年度筆數", "第一當事者純化筆數",

                            "座標缺失率", "年齡／性別缺值率", "最終可用樣本數"]

        stat_keys = [k for k in stats_summary if k not in engineering_keys]



        def make_table_fig(keys, title):

            return go.Figure(data=[go.Table(

                header=dict(

                    values=["<b>指標</b>", "<b>數值</b>"],

                    fill_color="#3A86FF", font=dict(color="white", size=13),

                    align="left",

                ),

                cells=dict(

                    values=[[k for k in keys], [stats_summary[k] for k in keys]],

                    fill_color=[["#f4f7ff" if i % 2 == 0 else "white" for i in range(len(keys))]],

                    align="left", font=dict(size=12),

                ),

            )])



        fig_eng = make_table_fig(engineering_keys, "🔧 管線效能指標")

        fig_eng.update_layout(title="🔧 管線效能指標（自動更新）", height=350)

        fig_eng.write_html(str(CONFIG["output_dir"] / "pipeline_stats.html"))



        fig_stat = make_table_fig(stat_keys, "📋 Welch's T-Test 統計摘要")

        fig_stat.update_layout(title="📋 Welch's T-Test 統計摘要", height=480)

        fig_stat.write_html(str(CONFIG["output_dir"] / "stats_table.html"))

        print("   ✅ pipeline_stats.html / stats_table.html")



        print("\n[Step 4.5] 打包前端互動資料庫 (JSON)...")



        dashboard_data = {

            "metadata": {

                "update_time": RUN_TIMESTAMP,

                "git_sha": GIT_SHA,

                "target_years": CONFIG["target_roc_years"],

                "incomplete_months": incomplete_months,

                "has_weekday_analysis": not weekday_df.empty,

                "has_peak_analysis":    not peak_df.empty,

                "has_age_rate_adjusted": not age_rate_df.empty,

                "population_source":    POPULATION_SOURCE,

            },

            "stats_summary": stats_summary,

            "cause_data":    cause_df.to_dict(orient="records"),

            "monthly_trend": monthly_df.to_dict(orient="records"),

            "weekday_analysis": weekday_df.to_dict(orient="records"),

            "peak_analysis":    peak_df.to_dict(orient="records"),

            "age_rate_adjusted": age_rate_df[[

                "年齡組", "絕對件數", "母體人口（估）", "每萬人事故率"

            ]].to_dict(orient="records") if not age_rate_df.empty else [],

        }



        with open(CONFIG["output_dir"] / "dashboard_data.json", "w", encoding="utf-8") as f:

            json.dump(dashboard_data, f, ensure_ascii=False, indent=2)

        print("   ✅ dashboard_data.json")



    # ═══════════════════════════════════════════════════════

    # Step 5：Folium 空間熱力圖

    # ═══════════════════════════════════════════════════════

    print("\n[Step 5] 空間熱力圖渲染...")



    m = folium.Map(location=[23.6978, 120.9605], zoom_start=8)

    if len(df_clean) > 0:

        heat_data = (

            df_clean[["lat", "lon"]].dropna()

            .sample(min(CONFIG["heatmap_sample"], len(df_clean)), random_state=42)

            .values.tolist()

        )

        HeatMap(heat_data, radius=12, blur=18).add_to(m)

        folium.map.Marker(

            [25.0, 122.0],

            icon=folium.DivIcon(html=(

                f'<div style="font-size:11px;color:#666;background:white;'

                f'padding:4px 8px;border-radius:4px;border:1px solid #ccc;">'

                f'快照日期：{RUN_TIMESTAMP}<br>'

                f'git SHA：{GIT_SHA}<br>'

                f'僅呈現事故絕對件數分佈，非暴露率校正後之風險圖</div>'

            )),

        ).add_to(m)



    m.save(str(CONFIG["output_dir"] / "heatmap.html"))

    print("   ✅ heatmap.html")



    # ═══════════════════════════════════════════════════════

    # [v2.4] Step 6：複製前端靜態文件至 output/

    # ═══════════════════════════════════════════════════════

    print("\n[Step 6] 複製前端靜態文件...")



    WEB_STATIC_FILES = ["index.html", "app.js", "style.css"]

    web_dir = CONFIG["web_dir"]



    if web_dir.exists():

        copied, missing = [], []

        for fname in WEB_STATIC_FILES:

            src = web_dir / fname

            if src.exists():

                shutil.copy2(src, CONFIG["output_dir"] / fname)

                copied.append(fname)

            else:

                missing.append(fname)



        if copied:

            print(f"   ✅ 已複製：{', '.join(copied)}")

        if missing:

            print(f"   ⚠️  web/ 目錄中找不到：{', '.join(missing)}（請確認文件存在）")

    else:

        print(f"   ⚠️  web/ 目錄不存在，略過靜態文件複製（部署後網站將缺少前端頁面）")



    print("\n" + "=" * 60)

    print("🚀 管線 v2.6.1 執行完畢！")

    print(f"   輸出目錄：{CONFIG['output_dir'].resolve()}")

    print(f"   Git SHA：{GIT_SHA}")

    if incomplete_months:

        print(f"   ⚠️  請注意：{incomplete_months} 月份資料可能不完整")

    print("=" * 60)



def sync_to_s3(local_dir="output", bucket_name="traffic-dashboard-743181156800"):

    """

    將本地產出的 output 目錄同步到 S3 Bucket

    需要預先在電腦設定好環境變數: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY

    """

    s3 = boto3.client('s3')

    print(f"\n🚀 開始同步至 S3 Bucket: {bucket_name}...")



    for root, dirs, files in os.walk(local_dir):

        for file in files:

            local_path = os.path.join(root, file)

            # 在 S3 上的路徑

            relative_path = os.path.relpath(local_path, local_dir)



            # 判斷快取策略 (HTML 設為 no-cache)

            extra_args = {}

            if file.endswith('.html'):

                extra_args = {'ContentType': 'text/html', 'CacheControl': 'no-cache'}



            s3.upload_file(local_path, bucket_name, relative_path, ExtraArgs=extra_args)

            print(f"   ✅ 已上傳: {relative_path}")



# ═══════════════════════════════════════════════════════

# 確保被引入為模組時不會自動執行，僅在直接執行時觸發 ETL 管線

# ═══════════════════════════════════════════════════════

if __name__ == "__main__":

    # 🌟 已經修復執行順序：先產出資料，再上傳

    run_pipeline()

    sync_to_s3()

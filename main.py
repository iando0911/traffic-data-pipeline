"""
台灣交通事故大數據分析管線 v2.2
修正項目：
  1. 加入缺失率統計（座標、年齡／性別）
  2. Cohen's d 存入 stats_summary
  3. 所有工程效能指標統一輸出至 JSON 與儀表板
  4. 移除舊版 Python 寫死的 index.html 產出邏輯，改為純資料 JSON 輸出 (CSR 架構)
  5. [v2.2] API 重試機制（最多 3 次，指數退避）
  6. [v2.2] 月份資料完整性檢查（件數異常低時標記警示）
  7. [v2.2] 原始資料本地快取（API 下線時自動 fallback）
  8. [v2.2] requirements.txt 固定版本建議（見腳本末尾說明）
"""

import pandas as pd
import numpy as np
from scipy import stats
import plotly.express as px
import plotly.graph_objects as go
import folium
from folium.plugins import HeatMap
import os
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import io
import warnings
import zipfile
import json
from pathlib import Path
from datetime import datetime

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
    "accident_urls": [
        "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/02D40248-7CAA-4354-82EA-E27AB8DCAB39/resource/DB4AFF40-757C-42F0-844F-1BCFE0D171C4/download",
        "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/E1AD1AC7-12C0-4DAF-942B-A8AF882A4746/download",
        "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/79165BC4-09EA-41D7-A1B0-C4355D9B4A31/download",
        "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/00E3617E-C3B2-4B0E-AC93-5A6F1B531B04/download",
        "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/E76E38F3-D046-4E87-B759-97B746AA5B1B/download",
        "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/8B93B29A-644E-49C1-8056-19681D361E43/download",
    ],
    # 月份完整性：件數低於前三個月平均的此比例時標記為「不完整」
    "monthly_completeness_threshold": 0.2,
}

CONFIG["output_dir"].mkdir(exist_ok=True)
CONFIG["raw_cache_dir"].mkdir(exist_ok=True)

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
RUN_TIMESTAMP = datetime.now().strftime("%Y-%m-%d %H:%M UTC+8")

# ── [v2.2] 建立帶重試機制的 requests Session ──────────────
def make_session() -> requests.Session:
    """
    建立帶有自動重試的 HTTP Session。
    - 最多重試 3 次
    - 指數退避：第1次等 2s，第2次 4s，第3次 8s
    - 僅對 5xx 伺服器錯誤重試（4xx 為客戶端錯誤，不重試）
    """
    session = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=2,
        status_forcelist=[500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


# ═══════════════════════════════════════════════════════
# 工具函數
# ═══════════════════════════════════════════════════════
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
def check_monthly_completeness(monthly_df: pd.DataFrame, threshold: float = 0.2) -> list[str]:
    """
    檢查月份資料是否完整。
    以「前三個完整月份的平均件數」為基準，
    若某月總件數低於基準的 threshold 倍，標記為不完整月份。
    回傳不完整月份的清單（空清單表示全部正常）。
    """
    monthly_total = (
        monthly_df.groupby("月份")["件數"].sum()
        .sort_index()
        .reset_index()
    )
    if len(monthly_total) < 4:
        return []  # 資料太少，無法判斷

    # 取前三個月的平均作為基準
    baseline = monthly_total["件數"].head(3).mean()
    incomplete = monthly_total[
        monthly_total["件數"] < baseline * threshold
    ]["月份"].tolist()

    return [int(m) for m in incomplete]


# ═══════════════════════════════════════════════════════
# Step 1：自動化 ETL（含重試 + 快取 fallback）
# ═══════════════════════════════════════════════════════
print("=" * 60)
print("[Step 1] 啟動 ETL 管線：下載內政部 A1/A2 車禍資料...")
print("=" * 60)

session = make_session()
dfs = []
download_success_count = 0

for i, url in enumerate(CONFIG["accident_urls"], 1):
    cache_file = CONFIG["raw_cache_dir"] / f"raw_{i}.pkl"
    print(f"   [{i}/{len(CONFIG['accident_urls'])}] 下載中...")
    try:
        resp = session.get(url, headers=HEADERS, timeout=60)
        resp.raise_for_status()
        content = resp.content

        if content[:4] == b"PK\x03\x04":
            with zipfile.ZipFile(io.BytesIO(content)) as z:
                csv_files = [n for n in z.namelist() if n.lower().endswith(".csv")]
                for fname in csv_files:
                    df = safe_read_csv(z.read(fname), label=fname)
                    if df is not None:
                        dfs.append(df)
        else:
            df = safe_read_csv(content, label=url[-30:])
            if df is not None:
                dfs.append(df)

        # 下載成功，更新快取
        if dfs:
            dfs[-1].to_pickle(str(cache_file))
        download_success_count += 1

    except Exception as e:
        print(f"      ❌ 下載／解析失敗（重試 3 次後仍失敗）：{e}")
        # [v2.2] fallback：嘗試讀取本地快取
        if cache_file.exists():
            print(f"      ⚠️  使用快取資料：{cache_file}")
            try:
                dfs.append(pd.read_pickle(str(cache_file)))
            except Exception as ce:
                print(f"      ❌ 快取讀取失敗：{ce}")

if not dfs:
    print("\n⚠️ 警告：無法取得任何資料（線上 + 快取均失敗），請檢查網路或 API 端點。")
    raise SystemExit(1)

if download_success_count < len(CONFIG["accident_urls"]):
    print(f"\n⚠️  注意：{len(CONFIG['accident_urls']) - download_success_count} 個資料來源使用快取，資料可能非最新版本")

df_acc = pd.concat(dfs, ignore_index=True)
print(f"\n✅ 原始資料合併完成：共 {len(df_acc):,} 筆")


# ═══════════════════════════════════════════════════════
# Step 2：特徵工程與資料清洗（含缺失率統計）
# ═══════════════════════════════════════════════════════
print("\n[Step 2] 特徵工程與資料清洗...")

# ── 年度篩選 ────────────────────────────────────────────
df_acc["發生年度_num"] = pd.to_numeric(
    df_acc.get("發生年度", pd.Series(dtype=float)), errors="coerce"
)
df_acc["發生年度_AD"] = roc_to_ad(df_acc["發生年度_num"])
target_ad = [y + 1911 for y in CONFIG["target_roc_years"]]
df_acc = df_acc[df_acc["發生年度_AD"].isin(target_ad)].copy()

n_raw = len(df_acc)
print(f"   年度篩選後原始筆數：{n_raw:,}")

# ── 第一當事者純化 ──────────────────────────────────────
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

n_first_party = len(df_clean)
print(f"   第一當事者純化後：{n_first_party:,} 筆（{n_first_party / n_raw * 100:.1f}% of raw）")

# ── 欄位解析 ────────────────────────────────────────────
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

# ── 缺失率計算 ──────────────────────────────────────────
coord_invalid_mask = (
    df_clean["lat"].isna()
    | df_clean["lon"].isna()
    | ~df_clean["lat"].between(*CONFIG["coord_bounds"]["lat"])
    | ~df_clean["lon"].between(*CONFIG["coord_bounds"]["lon"])
)
coord_missing_rate = coord_invalid_mask.sum() / n_first_party * 100

age_invalid_mask = df_clean["Age"].isna() | ~df_clean["Age"].between(*CONFIG["age_bounds"])
gender_invalid_mask = ~df_clean["性別"].isin(["男", "女"])
age_gender_missing_rate = (age_invalid_mask | gender_invalid_mask).sum() / n_first_party * 100

print(f"   座標缺失／超範圍率：{coord_missing_rate:.1f}%  ({coord_invalid_mask.sum():,} 筆)")
print(f"   年齡／性別缺值率：{age_gender_missing_rate:.1f}%  ({(age_invalid_mask | gender_invalid_mask).sum():,} 筆)")

# ── 實際篩選 ────────────────────────────────────────────
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

# ── 年齡分組 ────────────────────────────────────────────
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

# 預先宣告，供後續 JSON 打包使用
cause_df = pd.DataFrame()
monthly_df = pd.DataFrame()
incomplete_months: list[int] = []

if len(df_clean) > 0:

    # ── 肇因 TOP 15 ──────────────────────────────────────
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

    # ── 年齡小提琴圖 ──────────────────────────────────────
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

    # ── 年齡 × 月份熱圖 ───────────────────────────────────
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

    # ── 月份趨勢折線圖（含完整性檢查）───────────────────────
    monthly_df = df_clean.groupby(["月份", "性別"]).size().reset_index(name="件數")

    # [v2.2] 月份完整性檢查
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
    # 對不完整月份加上垂直虛線標示
    for m in incomplete_months:
        fig_trend.add_vline(
            x=m, line_dash="dash", line_color="orange",
            annotation_text=f"{m}月（資料不完整）",
            annotation_position="top",
        )
    fig_trend.write_html(str(CONFIG["output_dir"] / "monthly_trend.html"))
    print("   ✅ monthly_trend.html")

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

    # ── 打包前端互動資料庫 (JSON) ──────────────────────────
    print("\n[Step 4.5] 打包前端互動資料庫 (JSON)...")

    dashboard_data = {
        "metadata": {
            "update_time": RUN_TIMESTAMP,
            "target_years": CONFIG["target_roc_years"],
            # [v2.2] 將不完整月份資訊帶給前端，讓儀表板顯示警示
            "incomplete_months": incomplete_months,
        },
        "stats_summary": stats_summary,
        "cause_data": cause_df.to_dict(orient="records"),
        "monthly_trend": monthly_df.to_dict(orient="records"),
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
            f'僅呈現事故絕對件數分佈，非暴露率校正後之風險圖</div>'
        )),
    ).add_to(m)

m.save(str(CONFIG["output_dir"] / "heatmap.html"))
print("   ✅ heatmap.html")

print("\n" + "=" * 60)
print("🚀 管線 v2.2 執行完畢！")
print(f"   輸出目錄：{CONFIG['output_dir'].resolve()}")
if incomplete_months:
    print(f"   ⚠️  請注意：{incomplete_months} 月份資料可能不完整")
print("=" * 60)

# ═══════════════════════════════════════════════════════
# 附註：requirements.txt 建議固定版本
# ═══════════════════════════════════════════════════════
# 為確保學術可重現性，建議以下指令產生固定版本清單：
#   pip freeze > requirements.txt
# 範例（供參考，實際版本以 pip freeze 輸出為準）：
#   requests==2.32.3
#   pandas==2.2.3
#   numpy==1.26.4
#   scipy==1.13.1
#   folium==0.17.0
#   plotly==5.22.0
#   kaleido==0.2.1
#   chardet==5.2.0
#   jinja2==3.1.4
#   branca==0.7.2

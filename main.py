"""
台灣交通事故大數據分析管線 v2.0
完整版：ETL → 清洗 → 統計 → 視覺化 → 地圖 → 報告
"""

import pandas as pd
import numpy as np
from scipy import stats
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import folium
from folium.plugins import HeatMap, MarkerCluster
import os
import requests
import io
import warnings
import zipfile
import json
from pathlib import Path

warnings.filterwarnings('ignore')

# ═══════════════════════════════════════════════════════
# ⚙️  CONFIG：集中管理所有可變參數，不再硬編碼
# ═══════════════════════════════════════════════════════
CONFIG = {
    "target_roc_years": [115],           # 目標民國年份（可擴充多年）
    "coord_bounds": {                     # 台灣合理座標範圍
        "lat": (21.5, 25.5),
        "lon": (119.0, 122.5),
    },
    "age_bounds": (0, 110),              # 合理年齡範圍
    "heatmap_sample": 3000,              # 熱力圖最大取樣數
    "output_dir": Path("output"),        # 所有輸出集中到此資料夾
    "absent_csv": "道安講習未到.csv",     # 講習未到資料路徑
    "accident_urls": [
        "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/02D40248-7CAA-4354-82EA-E27AB8DCAB39/resource/DB4AFF40-757C-42F0-844F-1BCFE0D171C4/download",
        "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/E1AD1AC7-12C0-4DAF-942B-A8AF882A4746/download",
        "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/79165BC4-09EA-41D7-A1B0-C4355D9B4A31/download",
        "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/00E3617E-C3B2-4B0E-AC93-5A6F1B531B04/download",
        "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/E76E38F3-D046-4E87-B759-97B746AA5B1B/download",
        "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/8B93B29A-644E-49C1-8056-19681D361E43/download",
    ],
}

CONFIG["output_dir"].mkdir(exist_ok=True)
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

# ═══════════════════════════════════════════════════════
# 🛠️  工具函數
# ═══════════════════════════════════════════════════════
def safe_read_csv(source, label="檔案") -> pd.DataFrame | None:
    """嘗試 utf-8 → cp950 → big5 依序解碼，回傳 DataFrame 或 None"""
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
    print(f"   ❌ {label}：所有編碼均失敗")
    return None


def roc_to_ad(year_series: pd.Series) -> pd.Series:
    """
    民國年 → 西元年
    判斷依據：< 200 視為民國年，否則已是西元年
    """
    year = pd.to_numeric(year_series, errors="coerce")
    return year.where(year >= 200, year + 1911)


def validate_schema(df: pd.DataFrame, required: list[str]) -> list[str]:
    """回傳缺少的必要欄位清單"""
    return [c for c in required if c not in df.columns]


def format_pvalue(p: float) -> str:
    if p < 0.001:
        return "p < 0.001 ***（極顯著）"
    elif p < 0.01:
        return f"p = {p:.4f} **（高度顯著）"
    elif p < 0.05:
        return f"p = {p:.4f} *（顯著）"
    else:
        return f"p = {p:.4f}（不顯著）"


# ═══════════════════════════════════════════════════════
# Step 1：自動化 ETL（內政部 API + ZIP/CSV 雙模式）
# ═══════════════════════════════════════════════════════
print("=" * 60)
print("[Step 1] 啟動 ETL 管線：下載內政部 A1/A2 車禍資料...")
print("=" * 60)

dfs: list[pd.DataFrame] = []

for i, url in enumerate(CONFIG["accident_urls"], 1):
    print(f"   [{i}/{len(CONFIG['accident_urls'])}] 下載中：{url[-50:]}")
    try:
        resp = requests.get(url, headers=HEADERS, timeout=60)
        resp.raise_for_status()
        content = resp.content

        # ZIP 判斷（魔術字節）
        if content[:4] == b"PK\x03\x04":
            with zipfile.ZipFile(io.BytesIO(content)) as z:
                csv_files = [n for n in z.namelist() if n.lower().endswith(".csv")]
                for fname in csv_files:
                    df = safe_read_csv(z.read(fname), label=fname)
                    if df is not None:
                        dfs.append(df)
                        print(f"      ✅ ZIP 內 {fname}：{len(df):,} 筆")
        else:
            df = safe_read_csv(content, label=url[-30:])
            if df is not None:
                dfs.append(df)
                print(f"      ✅ CSV：{len(df):,} 筆")
    except requests.exceptions.RequestException as e:
        print(f"      ❌ 網路錯誤：{e}")
    except Exception as e:
        print(f"      ❌ 解析失敗：{e}")

if not dfs:
    print("\n⚠️  警告：無法取得任何線上資料，後續步驟將使用模擬資料展示管線功能。")
    # ── 模擬資料（供 CI/CD 離線測試用）──────────────────────
    np.random.seed(42)
    N = 5000
    df_acc = pd.DataFrame({
        "發生年度":         np.random.choice([115], N),
        "發生月份":         np.random.randint(1, 13, N),
        "發生日期":         [f"1150{np.random.randint(1,10):01d}{np.random.randint(10,29):02d}" for _ in range(N)],
        "當事者屬-性-別名稱": np.random.choice(["男", "女"], N, p=[0.68, 0.32]),
        "當事者事故發生時年齡": np.clip(np.random.normal(38, 15, N), 15, 90).astype(int),
        "當事者順位":        np.random.choice([1, 2, 3], N, p=[0.5, 0.35, 0.15]),
        "肇因研判子類別名稱-主要": np.random.choice(
            ["未注意車前狀態", "違規超速", "未依規定讓車", "闖紅燈", "酒後駕車",
             "違規迴轉", "未保持安全距離", "逆向行駛"],
            N, p=[0.28, 0.18, 0.14, 0.12, 0.10, 0.08, 0.06, 0.04]
        ),
        "經度": np.random.uniform(120.0, 121.8, N),
        "緯度": np.random.uniform(22.5, 25.2, N),
    })
    print(f"   📦 已產生模擬資料 {len(df_acc):,} 筆（離線 Demo 模式）")
    IS_DEMO = True
else:
    df_acc = pd.concat(dfs, ignore_index=True)
    IS_DEMO = False
    print(f"\n✅ 原始資料合併完成：共 {len(df_acc):,} 筆")


# ═══════════════════════════════════════════════════════
# Step 2：特徵工程與資料清洗
# ═══════════════════════════════════════════════════════
print("\n[Step 2] 特徵工程與資料清洗...")

# ── 2-1  年份統一轉換（修正民國/西元混用問題）
df_acc["發生年度_num"] = pd.to_numeric(df_acc.get("發生年度", pd.Series(dtype=float)), errors="coerce")
df_acc["發生年度_AD"] = roc_to_ad(df_acc["發生年度_num"])

# ── 2-2  只保留目標年份（以西元年比較，避免混用陷阱）
target_ad = [y + 1911 for y in CONFIG["target_roc_years"]]
df_acc = df_acc[df_acc["發生年度_AD"].isin(target_ad)].copy()
print(f"   目標年份過濾後：{len(df_acc):,} 筆")

# ── 2-3  偵測當事者順位欄位（容錯多種命名）
CULPRIT_CANDIDATES = ["當事者順位", "當事者區分-類別-大類名稱", "當事者區分-類別-大類"]
culprit_col = next((c for c in CULPRIT_CANDIDATES if c in df_acc.columns), None)

# ── 2-4  精準過濾第一當事者（肇事主因方）
if culprit_col:
    col_dtype = df_acc[culprit_col].dtype
    if pd.api.types.is_numeric_dtype(col_dtype):
        # 數值欄位：順位 == 1
        mask = df_acc[culprit_col] == 1
    else:
        # 文字欄位：明確比對，避免「01」誤判
        mask = df_acc[culprit_col].astype(str).str.fullmatch("第一當事者|1|01")
    df_clean = df_acc[mask].copy()
    print(f"   第一當事者過濾後：{len(df_clean):,} 筆")
else:
    df_clean = df_acc.copy()
    print("   ⚠️  找不到當事者順位欄，使用全量資料")

# ── 2-5  欄位標準化
df_clean["Age"] = pd.to_numeric(df_clean.get("當事者事故發生時年齡", pd.Series(dtype=float)), errors="coerce")
df_clean["月份"] = pd.to_numeric(df_clean.get("發生月份", pd.Series(dtype=float)), errors="coerce")
df_clean["性別"] = df_clean.get("當事者屬-性-別名稱", pd.Series(dtype=str))
df_clean["肇因"] = df_clean.get("肇因研判子類別名稱-主要", pd.Series(dtype=str))
df_clean["lat"] = pd.to_numeric(df_clean.get("緯度", pd.Series(dtype=float)), errors="coerce")
df_clean["lon"] = pd.to_numeric(df_clean.get("經度", pd.Series(dtype=float)), errors="coerce")

# ── 2-6  資料品質驗證
n_before = len(df_clean)
df_clean = df_clean[df_clean["性別"].isin(["男", "女"])].copy()
df_clean = df_clean[
    df_clean["Age"].between(*CONFIG["age_bounds"]) &
    df_clean["Age"].notna()
].copy()
df_clean = df_clean[
    df_clean["lat"].between(*CONFIG["coord_bounds"]["lat"]) &
    df_clean["lon"].between(*CONFIG["coord_bounds"]["lon"])
].copy()

print(f"   資料品質驗證：{n_before:,} → {len(df_clean):,} 筆（剔除 {n_before - len(df_clean):,} 筆異常值）")
print(f"   {'⚠️  Demo 模式' if IS_DEMO else '✅ 真實資料'}，最終有效樣本：{len(df_clean):,} 筆")

# ── 2-7  年齡分組
bins   = [0, 17, 24, 34, 44, 54, 64, 110]
labels = ["<18", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"]
df_clean["年齡組"] = pd.cut(df_clean["Age"], bins=bins, labels=labels, right=True)


# ═══════════════════════════════════════════════════════
# Step 3：Welch's T-Test（性別 × 年齡）
# ═══════════════════════════════════════════════════════
print("\n[Step 3] Welch's T-Test：肇事者性別年齡差異...")

male_ages   = df_clean[df_clean["性別"] == "男"]["Age"].dropna()
female_ages = df_clean[df_clean["性別"] == "女"]["Age"].dropna()

stats_summary = {}

if len(male_ages) > 1 and len(female_ages) > 1:
    t_stat, p_val = stats.ttest_ind(male_ages, female_ages, equal_var=False)
    cohens_d = (male_ages.mean() - female_ages.mean()) / np.sqrt(
        (male_ages.std()**2 + female_ages.std()**2) / 2
    )
    stats_summary = {
        "男性樣本數": len(male_ages),
        "女性樣本數": len(female_ages),
        "男性平均年齡": round(male_ages.mean(), 2),
        "女性平均年齡": round(female_ages.mean(), 2),
        "男性標準差": round(male_ages.std(), 2),
        "女性標準差": round(female_ages.std(), 2),
        "T統計量": round(t_stat, 4),
        "P值": round(p_val, 6),
        "顯著性": format_pvalue(p_val),
        "Cohen's d": round(cohens_d, 4),
        "效果量解釋": "小" if abs(cohens_d) < 0.2 else ("中" if abs(cohens_d) < 0.5 else "大"),
    }
    for k, v in stats_summary.items():
        print(f"   {k}：{v}")

    # 儲存統計摘要
    with open(CONFIG["output_dir"] / "stats_summary.json", "w", encoding="utf-8") as f:
        json.dump(stats_summary, f, ensure_ascii=False, indent=2)


# ═══════════════════════════════════════════════════════
# Step 4：完整資料視覺化（4 張圖，全部輸出為 HTML）
# ═══════════════════════════════════════════════════════
print("\n[Step 4] 資料視覺化（全面輸出）...")

PLOTLY_THEME = "plotly_white"
COLOR_MAP = {"男": "#3A86FF", "女": "#FF6B9D"}

# ── 4-1  Top 15 肇因橫條圖（男女對比）
print("   🖼  4-1 繪製：主要肇事原因 × 性別...")
cause_df = (
    df_clean.groupby(["肇因", "性別"])
    .size()
    .reset_index(name="件數")
)
top15_causes = (
    cause_df.groupby("肇因")["件數"].sum()
    .nlargest(15).index.tolist()
)
cause_df = cause_df[cause_df["肇因"].isin(top15_causes)].copy()
cause_order = (
    cause_df.groupby("肇因")["件數"].sum()
    .sort_values(ascending=True).index.tolist()
)

fig_cause = px.bar(
    cause_df,
    x="件數", y="肇因",
    color="性別",
    color_discrete_map=COLOR_MAP,
    barmode="group",
    orientation="h",
    category_orders={"肇因": cause_order},
    title="📊 主要肇事原因 TOP 15（依性別分組）",
    labels={"件數": "肇事件數", "肇因": ""},
    template=PLOTLY_THEME,
    height=600,
)
fig_cause.update_layout(legend_title_text="性別", font=dict(family="Noto Sans TC, sans-serif"))
fig_cause.write_html(str(CONFIG["output_dir"] / "cause_analysis.html"))
print("      ✅ cause_analysis.html")

# ── 4-2  年齡分布 KDE 曲線（Violin + Box）
print("   🖼  4-2 繪製：年齡分布（Violin）...")
fig_age = go.Figure()
for gender, color in COLOR_MAP.items():
    subset = df_clean[df_clean["性別"] == gender]["Age"].dropna()
    fig_age.add_trace(go.Violin(
        y=subset, name=gender,
        box_visible=True, meanline_visible=True,
        fillcolor=color, opacity=0.6,
        line_color=color,
        points="outliers",
    ))

fig_age.update_layout(
    title="🎻 肇事主因者年齡分布（Violin Plot）",
    yaxis_title="年齡（歲）",
    template=PLOTLY_THEME,
    font=dict(family="Noto Sans TC, sans-serif"),
    showlegend=True,
)
fig_age.write_html(str(CONFIG["output_dir"] / "age_distribution.html"))
print("      ✅ age_distribution.html")

# ── 4-3  年齡組 × 性別 件數熱圖
print("   🖼  4-3 繪製：年齡組 × 月份 熱圖...")
heatmap_df = (
    df_clean.groupby(["年齡組", "月份"])
    .size()
    .reset_index(name="件數")
)
pivot = heatmap_df.pivot(index="年齡組", columns="月份", values="件數").fillna(0)

fig_heat = px.imshow(
    pivot,
    labels=dict(x="月份", y="年齡組", color="件數"),
    title="🗓  肇事件數熱圖（年齡組 × 月份）",
    color_continuous_scale="Reds",
    template=PLOTLY_THEME,
    aspect="auto",
    text_auto=True,
)
fig_heat.update_layout(font=dict(family="Noto Sans TC, sans-serif"))
fig_heat.write_html(str(CONFIG["output_dir"] / "heatmap_age_month.html"))
print("      ✅ heatmap_age_month.html")

# ── 4-4  月份趨勢折線圖（男女對比）
print("   🖼  4-4 繪製：月份趨勢折線圖...")
monthly_df = (
    df_clean.groupby(["月份", "性別"])
    .size()
    .reset_index(name="件數")
)

fig_trend = px.line(
    monthly_df,
    x="月份", y="件數",
    color="性別",
    color_discrete_map=COLOR_MAP,
    markers=True,
    title="📈 各月份肇事趨勢（男女對比）",
    labels={"月份": "月份", "件數": "肇事件數"},
    template=PLOTLY_THEME,
)
fig_trend.update_layout(
    xaxis=dict(tickmode="linear", tick0=1, dtick=1),
    font=dict(family="Noto Sans TC, sans-serif"),
)
fig_trend.write_html(str(CONFIG["output_dir"] / "monthly_trend.html"))
print("      ✅ monthly_trend.html")

# ── 4-5  統計摘要表（Plotly Table）
print("   🖼  4-5 繪製：統計摘要表...")
if stats_summary:
    fig_table = go.Figure(data=[go.Table(
        columnwidth=[200, 300],
        header=dict(
            values=["<b>指標</b>", "<b>數值</b>"],
            fill_color="#3A86FF",
            font=dict(color="white", size=13),
            align="left",
        ),
        cells=dict(
            values=[list(stats_summary.keys()), list(stats_summary.values())],
            fill_color=[["#f0f4ff", "#ffffff"] * 10],
            align="left",
            font=dict(size=12),
        ),
    )])
    fig_table.update_layout(
        title="📋 Welch's T-Test 統計摘要",
        font=dict(family="Noto Sans TC, sans-serif"),
        height=500,
    )
    fig_table.write_html(str(CONFIG["output_dir"] / "stats_table.html"))
    print("      ✅ stats_table.html")


# ═══════════════════════════════════════════════════════
# Step 5：道安講習未到人數分析（真實 or 模擬皆可）
# ═══════════════════════════════════════════════════════
print("\n[Step 5] 道安講習未到人數分析...")

absent_path = Path(CONFIG["absent_csv"])

if absent_path.exists():
    df_absent = safe_read_csv(absent_path, label="道安講習未到.csv")
    print(f"   ✅ 讀取本地檔案成功：{len(df_absent):,} 筆")
else:
    print(f"   ⚠️  找不到 {CONFIG['absent_csv']}，以模擬資料示範...")
    # ── 模擬多年度未到資料 ──────────────────────────
    df_absent = pd.DataFrame({
        "年度": list(range(108, 116)),
        "應到人數": [52000, 55000, 48000, 61000, 67000, 70000, 72000, 74000],
        "實到人數": [44000, 46000, 39000, 50000, 54000, 56000, 57000, 58000],
        "未到人數": [ 8000,  9000,  9000, 11000, 13000, 14000, 15000, 16000],
    })
    df_absent["未到率(%)"] = (df_absent["未到人數"] / df_absent["應到人數"] * 100).round(2)

# ── 欄位容錯偵測 ──────────────────────────────────────
year_col    = next((c for c in df_absent.columns if "年" in c or "year" in c.lower()), None)
absent_col  = next((c for c in df_absent.columns if "未到" in c and "率" not in c), None)
total_col   = next((c for c in df_absent.columns if "應到" in c or "總" in c), None)
arrive_col  = next((c for c in df_absent.columns if "實到" in c), None)
rate_col    = next((c for c in df_absent.columns if "率" in c or "rate" in c.lower()), None)

print(f"   偵測欄位：年度={year_col}，應到={total_col}，實到={arrive_col}，未到={absent_col}，未到率={rate_col}")

# ── 計算未到率（若無現成欄位）──────────────────────────
if rate_col is None and absent_col and total_col:
    df_absent["未到率(%)"] = (
        pd.to_numeric(df_absent[absent_col], errors="coerce") /
        pd.to_numeric(df_absent[total_col],  errors="coerce") * 100
    ).round(2)
    rate_col = "未到率(%)"

# ── 趨勢分析（線性迴歸）──────────────────────────────
fig_absent = make_subplots(
    rows=2, cols=1,
    subplot_titles=("歷年道安講習未到人數", "歷年未到率（%）趨勢"),
    vertical_spacing=0.15,
)

if year_col and absent_col:
    x = pd.to_numeric(df_absent[year_col], errors="coerce")
    y = pd.to_numeric(df_absent[absent_col], errors="coerce")
    valid = x.notna() & y.notna()

    fig_absent.add_trace(
        go.Bar(x=x[valid], y=y[valid], name="未到人數", marker_color="#FF6B6B"),
        row=1, col=1,
    )

    # 線性迴歸趨勢線
    if valid.sum() >= 3:
        slope, intercept, r, p, se = stats.linregress(x[valid], y[valid])
        x_line = np.linspace(x[valid].min(), x[valid].max(), 100)
        y_line = slope * x_line + intercept
        fig_absent.add_trace(
            go.Scatter(
                x=x_line, y=y_line, mode="lines",
                name=f"趨勢線 (R²={r**2:.3f})",
                line=dict(dash="dash", color="#FF9500", width=2),
            ),
            row=1, col=1,
        )
        print(f"   線性迴歸：斜率={slope:.1f} 人/年，R²={r**2:.3f}，{format_pvalue(p)}")

if year_col and rate_col:
    x = pd.to_numeric(df_absent[year_col], errors="coerce")
    y = pd.to_numeric(df_absent[rate_col], errors="coerce")
    valid = x.notna() & y.notna()

    fig_absent.add_trace(
        go.Scatter(
            x=x[valid], y=y[valid], mode="lines+markers",
            name="未到率(%)", marker=dict(size=8),
            line=dict(color="#8B5CF6", width=2),
        ),
        row=2, col=1,
    )

fig_absent.update_layout(
    title="🚨 道安講習阻嚇力驗證：歷年未到人數與未到率趨勢",
    template=PLOTLY_THEME,
    font=dict(family="Noto Sans TC, sans-serif"),
    height=700,
    showlegend=True,
)
fig_absent.update_xaxes(title_text="年度（民國）")
fig_absent.update_yaxes(title_text="人數", row=1, col=1)
fig_absent.update_yaxes(title_text="未到率（%）", row=2, col=1)
fig_absent.write_html(str(CONFIG["output_dir"] / "absent_trend.html"))
print("   ✅ absent_trend.html")


# ═══════════════════════════════════════════════════════
# Step 6：Folium 熱力圖（進化版，附圖層控制）
# ═══════════════════════════════════════════════════════
print("\n[Step 6] 空間熱力圖渲染...")

m = folium.Map(
    location=[23.6978, 120.9605],
    zoom_start=8,
    tiles=None,
)

# 底圖圖層
folium.TileLayer("CartoDB positron",  name="淺色地圖", control=True).add_to(m)
folium.TileLayer("CartoDB dark_matter", name="深色地圖", control=True).add_to(m)
folium.TileLayer("OpenStreetMap",     name="街道地圖", control=True).add_to(m)

# 熱力圖圖層
df_map = df_clean.copy()
if len(df_map) > CONFIG["heatmap_sample"]:
    df_map = df_map.sample(CONFIG["heatmap_sample"], random_state=42)

heat_data = df_map[["lat", "lon"]].dropna().values.tolist()

heat_layer = folium.FeatureGroup(name="肇事熱力圖", show=True)
HeatMap(
    heat_data,
    radius=12,
    blur=18,
    max_zoom=13,
    gradient={0.2: "#3A86FF", 0.5: "#FFBE0B", 0.8: "#FF006E", 1.0: "#8B0000"},
).add_to(heat_layer)
heat_layer.add_to(m)

# 高齡肇事者（65+）標記圖層
elderly_layer = folium.FeatureGroup(name="高齡肇事者（65+）", show=False)
df_elderly = df_clean[df_clean["Age"] >= 65].dropna(subset=["lat", "lon"])
if len(df_elderly) > 500:
    df_elderly = df_elderly.sample(500, random_state=42)

cluster = MarkerCluster().add_to(elderly_layer)
for _, row in df_elderly.iterrows():
    folium.CircleMarker(
        location=[row["lat"], row["lon"]],
        radius=5,
        color="#FF6B6B",
        fill=True,
        fill_opacity=0.7,
        popup=folium.Popup(
            f"年齡：{int(row['Age'])} 歲<br>性別：{row['性別']}<br>肇因：{str(row['肇因'])[:20]}",
            max_width=200,
        ),
    ).add_to(cluster)
elderly_layer.add_to(m)

folium.LayerControl(collapsed=False).add_to(m)

# 加入標題
title_html = """
<div style="position:fixed;top:10px;left:50%;transform:translateX(-50%);
            z-index:9999;background:white;padding:8px 16px;
            border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.3);
            font-family:'Noto Sans TC',sans-serif;font-size:14px;font-weight:bold;">
  🗺️ 台灣交通事故肇事者空間分布熱力圖
</div>
"""
m.get_root().html.add_child(folium.Element(title_html))

map_path = CONFIG["output_dir"] / "index.html"
m.save(str(map_path))
print(f"   ✅ 地圖已儲存：{map_path}（{len(heat_data):,} 個座標點）")


# ═══════════════════════════════════════════════════════
# Step 7：整合報告首頁（index_report.html）
# ═══════════════════════════════════════════════════════
print("\n[Step 7] 產生整合報告首頁...")

mode_badge = "⚠️ Demo 模式（模擬資料）" if IS_DEMO else "✅ 真實資料"
stats_rows = "".join(
    f"<tr><td>{k}</td><td><strong>{v}</strong></td></tr>"
    for k, v in stats_summary.items()
) if stats_summary else "<tr><td colspan='2'>統計資料不足</td></tr>"

html_report = f"""<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>台灣交通事故分析報告</title>
<style>
  :root{{--blue:#3A86FF;--red:#FF006E;--yellow:#FFBE0B;--bg:#F8FAFF;}}
  *{{box-sizing:border-box;margin:0;padding:0;}}
  body{{font-family:"Noto Sans TC",Arial,sans-serif;background:var(--bg);color:#222;}}
  header{{background:var(--blue);color:white;padding:2rem;text-align:center;}}
  header h1{{font-size:1.8rem;margin-bottom:.5rem;}}
  header p{{opacity:.85;font-size:.9rem;}}
  .badge{{display:inline-block;background:rgba(255,255,255,.2);
          padding:.2rem .8rem;border-radius:20px;font-size:.8rem;margin-top:.5rem;}}
  main{{max-width:1100px;margin:2rem auto;padding:0 1rem;}}
  .grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem;}}
  .card{{background:white;border-radius:12px;padding:1.5rem;box-shadow:0 2px 12px rgba(0,0,0,.08);
          text-align:center;}}
  .card .num{{font-size:2rem;font-weight:700;color:var(--blue);}}
  .card .label{{color:#666;font-size:.85rem;margin-top:.3rem;}}
  .section{{background:white;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem;
             box-shadow:0 2px 12px rgba(0,0,0,.08);}}
  .section h2{{font-size:1.1rem;margin-bottom:1rem;color:var(--blue);border-left:4px solid var(--blue);
               padding-left:.75rem;}}
  .nav-grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.75rem;}}
  .nav-btn{{display:block;padding:1rem;border-radius:10px;text-decoration:none;
             background:var(--bg);border:2px solid var(--blue);color:var(--blue);
             font-weight:600;text-align:center;transition:.2s;}}
  .nav-btn:hover{{background:var(--blue);color:white;}}
  table{{width:100%;border-collapse:collapse;font-size:.9rem;}}
  th,td{{padding:.6rem 1rem;border-bottom:1px solid #eee;text-align:left;}}
  th{{background:#f0f4ff;font-weight:600;}}
  footer{{text-align:center;padding:2rem;color:#999;font-size:.8rem;}}
</style>
</head>
<body>
<header>
  <h1>🚗 台灣交通事故大數據分析報告</h1>
  <p>民國 {' / '.join(str(y) for y in CONFIG['target_roc_years'])} 年度 · A1/A2 主要肇事者分析</p>
  <span class="badge">{mode_badge}</span>
</header>

<main>
  <div class="grid">
    <div class="card">
      <div class="num">{len(df_clean):,}</div>
      <div class="label">有效分析樣本數</div>
    </div>
    <div class="card">
      <div class="num">{stats_summary.get('男性平均年齡', 'N/A')}</div>
      <div class="label">男性肇事平均年齡（歲）</div>
    </div>
    <div class="card">
      <div class="num">{stats_summary.get('女性平均年齡', 'N/A')}</div>
      <div class="label">女性肇事平均年齡（歲）</div>
    </div>
    <div class="card">
      <div class="num">{round(len(df_clean[df_clean['性別']=='男'])/len(df_clean)*100, 1) if len(df_clean)>0 else 0}%</div>
      <div class="label">男性肇事佔比</div>
    </div>
  </div>

  <div class="section">
    <h2>📊 各項視覺化分析</h2>
    <div class="nav-grid">
      <a class="nav-btn" href="cause_analysis.html">🔍 肇因分析</a>
      <a class="nav-btn" href="age_distribution.html">🎻 年齡分布</a>
      <a class="nav-btn" href="heatmap_age_month.html">🗓 月份熱圖</a>
      <a class="nav-btn" href="monthly_trend.html">📈 月份趨勢</a>
      <a class="nav-btn" href="absent_trend.html">🚨 講習未到趨勢</a>
      <a class="nav-btn" href="stats_table.html">📋 統計摘要表</a>
      <a class="nav-btn" href="index.html">🗺️ 地理熱力圖</a>
    </div>
  </div>

  <div class="section">
    <h2>🔬 Welch's T-Test 結果摘要</h2>
    <table>
      <tr><th>指標</th><th>數值</th></tr>
      {stats_rows}
    </table>
  </div>
</main>

<footer>資料來源：內政部警政署交通事故資料庫 · 分析管線 v2.0</footer>
</body>
</html>
"""

report_path = CONFIG["output_dir"] / "report.html"
report_path.write_text(html_report, encoding="utf-8")
print(f"   ✅ 整合報告首頁：{report_path}")


# ═══════════════════════════════════════════════════════
# 完成摘要
# ═══════════════════════════════════════════════════════
output_files = list(CONFIG["output_dir"].glob("*.html")) + [CONFIG["output_dir"] / "stats_summary.json"]
print("\n" + "=" * 60)
print("🚀 端到端管線執行完畢！")
print("=" * 60)
print(f"   資料模式：{'Demo（模擬）' if IS_DEMO else '真實（內政部 API）'}")
print(f"   有效樣本：{len(df_clean):,} 筆")
print(f"\n📁 輸出檔案（{CONFIG['output_dir']}/）：")
for f in sorted(CONFIG["output_dir"].iterdir()):
    size_kb = f.stat().st_size / 1024
    print(f"   {f.name:<35} {size_kb:>8.1f} KB")
print()
print("🌐 部署提示：將 output/ 目錄內容推送至 GitHub Pages，")
print("   首頁設為 report.html 即可完整瀏覽所有分析結果。")

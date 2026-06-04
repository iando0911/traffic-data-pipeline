"""
台灣交通事故大數據分析管線 v2.1
修正項目：
  1. 加入缺失率統計（座標、年齡／性別）
  2. Cohen's d 存入 stats_summary
  3. 所有工程效能指標統一輸出至 JSON 與儀表板
  4. 移除舊版 Python 寫死的 index.html 產出邏輯，改為純資料 JSON 輸出 (CSR 架構)
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
    "output_dir": Path("output"),
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
RUN_TIMESTAMP = datetime.now().strftime("%Y-%m-%d %H:%M UTC+8")

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


# ═══════════════════════════════════════════════════════
# Step 1：自動化 ETL
# ═══════════════════════════════════════════════════════
print("=" * 60)
print("[Step 1] 啟動 ETL 管線：下載內政部 A1/A2 車禍資料...")
print("=" * 60)

dfs = []
for i, url in enumerate(CONFIG["accident_urls"], 1):
    print(f"   [{i}/{len(CONFIG['accident_urls'])}] 下載中...")
    try:
        resp = requests.get(url, headers=HEADERS, timeout=60)
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
    except Exception as e:
        print(f"      ❌ 下載／解析失敗：{e}")

if not dfs:
    print("\n⚠️ 警告：無法取得任何線上資料，請檢查網路或 API 端點。")
    raise SystemExit(1)

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

n_raw = len(df_acc)  # ① 年度篩選後原始筆數
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

n_first_party = len(df_clean)  # ② 第一當事者純化後筆數
print(f"   第一當事者純化後：{n_first_party:,} 筆（{n_first_party / n_raw * 100:.1f}% of raw）")

# ── 欄位解析（在過濾前先解析，以便計算缺失率）────────────
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

# ── ③ 缺失率計算（在篩選之前，基準為 n_first_party）──────
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

n_final = len(df_clean)  # ④ 最終完整可用樣本
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

    # Cohen's d（簡化 pooled SD）
    pooled_sd = np.sqrt((male_ages.std() ** 2 + female_ages.std() ** 2) / 2)
    cohens_d  = (male_ages.mean() - female_ages.mean()) / pooled_sd

    stats_summary = {
        # ── 工程效能指標 ─────────────────────────────────
        "資料截止日期":       RUN_TIMESTAMP,
        "原始年度筆數":       f"{n_raw:,}",
        "第一當事者純化筆數": f"{n_first_party:,}",
        "座標缺失率":         f"{coord_missing_rate:.1f}%",
        "年齡／性別缺值率":   f"{age_gender_missing_rate:.1f}%",
        "最終可用樣本數":     f"{n_final:,}",
        # ── 統計指標 ─────────────────────────────────────
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
            text="注意：本圖為特定執行週期之快照，不代表最新數據",
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

    # ── 月份趨勢折線圖 ────────────────────────────────────
    monthly_df = df_clean.groupby(["月份", "性別"]).size().reset_index(name="件數")
    fig_trend = px.line(
        monthly_df, x="月份", y="件數", color="性別",
        color_discrete_map=COLOR_MAP, markers=True,
        title=f"📈 各月份肇事趨勢 {SNAPSHOT_NOTE}",
        template=PLOTLY_THEME,
    )
    fig_trend.write_html(str(CONFIG["output_dir"] / "monthly_trend.html"))
    print("   ✅ monthly_trend.html")

# ── 統計摘要表 ────────────────────────────────────────────
if stats_summary:
    # 工程指標與統計指標分開顯示
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

# ── [新增] 匯出前端互動所需之純資料 (JSON) ──────────────────────
    print("\n[Step 4.5] 打包前端互動資料庫 (JSON)...")
    
    # 將 Pandas DataFrame 轉為前端好讀取的字典格式 (records)
    dashboard_data = {
        "metadata": {
            "update_time": RUN_TIMESTAMP,
            "target_years": CONFIG["target_roc_years"]
        },
        "stats_summary": stats_summary,
        "cause_data": cause_df.to_dict(orient="records"),       # 包含肇因、性別、件數
        "monthly_trend": monthly_df.to_dict(orient="records")   # 包含月份、性別、件數
    }

    # 存檔至 output 資料夾
    with open(CONFIG["output_dir"] / "dashboard_data.json", "w", encoding="utf-8") as f:
        json.dump(dashboard_data, f, ensure_ascii=False, indent=2)
    print("   ✅ dashboard_data.json (供前端 JS 抓取的資料庫！)")

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
print("🚀 管線 v2.1 執行完畢！")
print(f"   輸出目錄：{CONFIG['output_dir'].resolve()}")
print("=" * 60)

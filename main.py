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
# ⚙️  CONFIG：集中管理所有可變參數
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
    "absent_csv": "道安講習未到.csv",
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
    print(f"   ❌ {label}：所有編碼均失敗")
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

print("=" * 60)
print("[Step 1] 啟動 ETL 管線：下載內政部 A1/A2 車禍資料...")
print("=" * 60)

dfs = []
for i, url in enumerate(CONFIG["accident_urls"], 1):
    print(f"   [{i}/{len(CONFIG['accident_urls'])}] 下載中：{url[-50:]}")
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
                        print(f"      ✅ ZIP 內 {fname}：{len(df):,} 筆")
        else:
            df = safe_read_csv(content, label=url[-30:])
            if df is not None:
                dfs.append(df)
                print(f"      ✅ CSV：{len(df):,} 筆")
    except Exception as e:
        print(f"      ❌ 解析失敗：{e}")

if not dfs:
    print("\n⚠️  警告：無法取得資料，使用模擬資料。")
    np.random.seed(42)
    N = 5000
    df_acc = pd.DataFrame({
        "發生年度": np.random.choice([115], N),
        "發生月份": np.random.randint(1, 13, N),
        "發生日期": [f"1150{np.random.randint(1,10):01d}{np.random.randint(10,29):02d}" for _ in range(N)],
        "當事者屬-性-別名稱": np.random.choice(["男", "女"], N, p=[0.68, 0.32]),
        "當事者事故發生時年齡": np.clip(np.random.normal(38, 15, N), 15, 90).astype(int),
        "當事者順位": np.random.choice([1, 2, 3], N, p=[0.5, 0.35, 0.15]),
        "肇因研判子類別名稱-主要": np.random.choice(
            ["未注意車前狀態", "違規超速", "未依規定讓車", "闖紅燈", "酒後駕車", "違規迴轉"],
            N, p=[0.3, 0.2, 0.15, 0.15, 0.1, 0.1]
        ),
        "經度": np.random.uniform(120.0, 121.8, N),
        "緯度": np.random.uniform(22.5, 25.2, N),
    })
    IS_DEMO = True
else:
    df_acc = pd.concat(dfs, ignore_index=True)
    IS_DEMO = False
    print(f"\n✅ 原始資料合併完成：共 {len(df_acc):,} 筆")

print("\n[Step 2] 特徵工程與資料清洗...")
df_acc["發生年度_num"] = pd.to_numeric(df_acc.get("發生年度", pd.Series(dtype=float)), errors="coerce")
df_acc["發生年度_AD"] = roc_to_ad(df_acc["發生年度_num"])
target_ad = [y + 1911 for y in CONFIG["target_roc_years"]]
df_acc = df_acc[df_acc["發生年度_AD"].isin(target_ad)].copy()

culprit_col = next((c for c in ["當事者順位", "當事者區分-類別-大類名稱", "當事者區分-類別-大類"] if c in df_acc.columns), None)
if culprit_col:
    if pd.api.types.is_numeric_dtype(df_acc[culprit_col].dtype):
        df_clean = df_acc[df_acc[culprit_col] == 1].copy()
    else:
        df_clean = df_acc[df_acc[culprit_col].astype(str).str.fullmatch("第一當事者|1|01")].copy()
else:
    df_clean = df_acc.copy()

df_clean["Age"] = pd.to_numeric(df_clean.get("當事者事故發生時年齡", pd.Series(dtype=float)), errors="coerce")
df_clean["月份"] = pd.to_numeric(df_clean.get("發生月份", pd.Series(dtype=float)), errors="coerce")
df_clean["性別"] = df_clean.get("當事者屬-性-別名稱", pd.Series(dtype=str))
df_clean["肇因"] = df_clean.get("肇因研判子類別名稱-主要", pd.Series(dtype=str))
df_clean["lat"] = pd.to_numeric(df_clean.get("緯度", pd.Series(dtype=float)), errors="coerce")
df_clean["lon"] = pd.to_numeric(df_clean.get("經度", pd.Series(dtype=float)), errors="coerce")

df_clean = df_clean[df_clean["性別"].isin(["男", "女"])].copy()
df_clean = df_clean[df_clean["Age"].between(*CONFIG["age_bounds"]) & df_clean["Age"].notna()].copy()
df_clean = df_clean[df_clean["lat"].between(*CONFIG["coord_bounds"]["lat"]) & df_clean["lon"].between(*CONFIG["coord_bounds"]["lon"])].copy()

bins   = [0, 17, 24, 34, 44, 54, 64, 110]
labels = ["<18", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"]
df_clean["年齡組"] = pd.cut(df_clean["Age"], bins=bins, labels=labels, right=True)

print("\n[Step 3] Welch's T-Test：肇事者性別年齡差異...")
male_ages   = df_clean[df_clean["性別"] == "男"]["Age"].dropna()
female_ages = df_clean[df_clean["性別"] == "女"]["Age"].dropna()
stats_summary = {}

if len(male_ages) > 1 and len(female_ages) > 1:
    t_stat, p_val = stats.ttest_ind(male_ages, female_ages, equal_var=False)
    cohens_d = (male_ages.mean() - female_ages.mean()) / np.sqrt((male_ages.std()**2 + female_ages.std()**2) / 2)
    stats_summary = {
        "男性樣本數": len(male_ages),
        "女性樣本數": len(female_ages),
        "男性平均年齡": round(male_ages.mean(), 2),
        "女性平均年齡": round(female_ages.mean(), 2),
        "男性標準差": round(male_ages.std(), 2),
        "女性標準差": round(female_ages.std(), 2),
        "T統計量": round(t_stat, 4),
        "P值": f"{p_val:.3e}" if p_val < 0.0001 else round(p_val, 6),
        "顯著性": format_pvalue(p_val),
    }
    with open(CONFIG["output_dir"] / "stats_summary.json", "w", encoding="utf-8") as f:
        json.dump(stats_summary, f, ensure_ascii=False, indent=2)

print("\n[Step 4] 資料視覺化（全面輸出）...")
PLOTLY_THEME = "plotly_white"
COLOR_MAP = {"男": "#3A86FF", "女": "#FF6B9D"}

cause_df = df_clean.groupby(["肇因", "性別"]).size().reset_index(name="件數")
top15_causes = cause_df.groupby("肇因")["件數"].sum().nlargest(15).index.tolist()
cause_df = cause_df[cause_df["肇因"].isin(top15_causes)]
cause_order = cause_df.groupby("肇因")["件數"].sum().sort_values().index.tolist()
fig_cause = px.bar(cause_df, x="件數", y="肇因", color="性別", color_discrete_map=COLOR_MAP, barmode="group", orientation="h", category_orders={"肇因": cause_order}, title="📊 主要肇事原因 TOP 15", template=PLOTLY_THEME, height=600)
fig_cause.write_html(str(CONFIG["output_dir"] / "cause_analysis.html"))

fig_age = go.Figure()
for gender, color in COLOR_MAP.items():
    subset = df_clean[df_clean["性別"] == gender]["Age"].dropna()
    fig_age.add_trace(go.Violin(y=subset, name=gender, box_visible=True, meanline_visible=True, fillcolor=color, opacity=0.6, line_color=color, points="outliers"))
fig_age.update_layout(title="🎻 肇事主因者年齡分布", yaxis_title="年齡（歲）", template=PLOTLY_THEME)
fig_age.write_html(str(CONFIG["output_dir"] / "age_distribution.html"))

pivot = df_clean.groupby(["年齡組", "月份"]).size().reset_index(name="件數").pivot(index="年齡組", columns="月份", values="件數").fillna(0)
fig_heat = px.imshow(pivot, labels=dict(x="月份", y="年齡組", color="件數"), title="🗓  肇事件數熱圖", color_continuous_scale="Reds", template=PLOTLY_THEME, aspect="auto", text_auto=True)
fig_heat.write_html(str(CONFIG["output_dir"] / "heatmap_age_month.html"))

monthly_df = df_clean.groupby(["月份", "性別"]).size().reset_index(name="件數")
fig_trend = px.line(monthly_df, x="月份", y="件數", color="性別", color_discrete_map=COLOR_MAP, markers=True, title="📈 各月份肇事趨勢", template=PLOTLY_THEME)
fig_trend.update_layout(xaxis=dict(tickmode="linear", tick0=1, dtick=1))
fig_trend.write_html(str(CONFIG["output_dir"] / "monthly_trend.html"))

if stats_summary:
    fig_table = go.Figure(data=[go.Table(header=dict(values=["<b>指標</b>", "<b>數值</b>"], fill_color="#3A86FF", font=dict(color="white")), cells=dict(values=[list(stats_summary.keys()), list(stats_summary.values())]))])
    fig_table.update_layout(title="📋 Welch's T-Test 統計摘要", height=500)
    fig_table.write_html(str(CONFIG["output_dir"] / "stats_table.html"))

print("\n[Step 5] 道安講習未到人數分析...")
absent_path = Path(CONFIG["absent_csv"])
if absent_path.exists():
    df_absent = safe_read_csv(absent_path)
    year_col = next((c for c in df_absent.columns if "年" in c), None)
    if year_col:
        df_absent["年度_num"] = df_absent[year_col].astype(str).str.replace("年", "").pipe(pd.to_numeric, errors="coerce")
    numeric_cols = [c for c in df_absent.columns if c not in [year_col, "年度_num"] and pd.to_numeric(df_absent[c], errors="coerce").notna().sum() > 0]
    for col in numeric_cols: df_absent[col] = pd.to_numeric(df_absent[col], errors="coerce")
    df_absent["未到人數"] = df_absent[numeric_cols].sum(axis=1)
    absent_col = "未到人數"
else:
    df_absent = pd.DataFrame({
        "年度_num": list(range(103, 114)),
        "未到人數": [12507, 12701, 13724, 19047, 22251, 20157, 21263, 17614, 28272, 46318, 44800],
    })
    absent_col = "未到人數"

x_all = pd.to_numeric(df_absent["年度_num"], errors="coerce")
y_all = pd.to_numeric(df_absent[absent_col], errors="coerce")
valid = x_all.notna() & y_all.notna()

fig_absent = make_subplots(rows=1, cols=1, subplot_titles=("歷年道安講習未到人數",))
fig_absent.add_trace(go.Bar(x=x_all[valid], y=y_all[valid], name="未到人數", marker_color="#FF6B6B"))
fig_absent.update_layout(title="🚨 歷年未到人數趨勢", template=PLOTLY_THEME, height=500)
fig_absent.write_html(str(CONFIG["output_dir"] / "absent_trend.html"))

print("\n[Step 6] 空間熱力圖渲染...")
m = folium.Map(location=[23.6978, 120.9605], zoom_start=8)
heat_data = df_clean[["lat", "lon"]].dropna().values.tolist()
HeatMap(heat_data, radius=12, blur=18).add_to(m)
m.save(str(CONFIG["output_dir"] / "heatmap.html"))

print("\n[Step 7] 產生整合報告首頁...")
stats_rows = "".join(f"<tr><td>{k}</td><td><strong>{v}</strong></td></tr>" for k, v in stats_summary.items()) if stats_summary else "<tr><td colspan='2'>無數據</td></tr>"
html_report = f"""<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<title>台灣交通事故分析報告</title>
<style>
  body{{font-family:sans-serif;background:#F8FAFF;margin:0;}}
  header{{background:#3A86FF;color:white;padding:2rem;text-align:center;}}
  main{{max-width:1100px;margin:2rem auto;padding:1rem;}}
  .card{{background:white;padding:1.5rem;border-radius:12px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,0.1);margin-bottom:1rem;}}
  .nav-btn{{display:inline-block;padding:1rem;margin:0.5rem;background:white;border:2px solid #3A86FF;color:#3A86FF;text-decoration:none;border-radius:8px;}}
  .nav-btn:hover{{background:#3A86FF;color:white;}}
</style>
</head>
<body>
<header><h1>🚗 台灣交通事故大數據分析報告</h1><p>A1/A2 主要肇事者戰情儀表板</p></header>
<main>
  <div class="card">
    <h2>📊 各項視覺化儀表板 (點擊查看)</h2>
    <a class="nav-btn" href="cause_analysis.html">🔍 肇因分析</a>
    <a class="nav-btn" href="age_distribution.html">🎻 年齡分布</a>
    <a class="nav-btn" href="heatmap_age_month.html">🗓 月份熱圖</a>
    <a class="nav-btn" href="monthly_trend.html">📈 月份趨勢</a>
    <a class="nav-btn" href="absent_trend.html">🚨 講習未到</a>
    <a class="nav-btn" href="stats_table.html">📋 統計摘要表</a>
    <a class="nav-btn" href="heatmap.html">🗺️ 地理熱力圖</a>
  </div>
  <div class="card">
    <h2>🔬 肇事者性別年齡統計 (Welch's T-Test)</h2>
    <table style="width:100%;text-align:left;">{stats_rows}</table>
  </div>
</main>
</body>
</html>
"""
(CONFIG["output_dir"] / "index.html").write_text(html_report, encoding="utf-8")
print("🚀 執行完畢！")

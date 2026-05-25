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
import requests
from bs4 import BeautifulSoup
import zipfile

warnings.filterwarnings('ignore')

# ═══════════════════════════════════════════════════════
# Step 1：終極自動化萃取 (動態網頁爬蟲 + 記憶體解壓縮)
# ═══════════════════════════════════════════════════════
print("[Step 1] 啟動自動化 ETL 管線：動態尋找並下載最新 A1/A2 車禍資料...")

# 🎯 這裡不要放「下載檔案的網址」，而是放「該資料集的介紹主網頁」！
# (也就是你前幾張截圖，有藍色 ZIP 下載按鈕的那個政府網頁)
dataset_pages = [
    'https://data.gov.tw/dataset/13069',  # 範例：警政署 A1 交通事故資料集主頁
    'https://data.gov.tw/dataset/13070'   # 範例：警政署 A2 交通事故資料集主頁
    # ⚠️ 請把上面這兩個網址，換成你截圖那個網頁的真實網址！
]

dynamic_urls = []

# 🕸️ 1. 啟動爬蟲：去網頁上把所有最新的下載連結全部抓下來
for page_url in dataset_pages:
    print(f"🔍 正在掃描資料集頁面：{page_url}")
    try:
        response = requests.get(page_url, timeout=30)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # 尋找網頁上所有的超連結
        for a_tag in soup.find_all('a', href=True):
            href = a_tag['href']
            # 如果連結結尾是 .zip、.csv 或是包含 download 字眼，就視為下載點
            if href.endswith('.zip') or href.endswith('.csv') or 'download' in href:
                full_url = href if href.startswith('http') else f"https://data.gov.tw{href}"
                dynamic_urls.append(full_url)
                
    except Exception as e:
        print(f"❌ 掃描 {page_url} 失敗: {e}")

# 去除重複的網址
dynamic_urls = list(set(dynamic_urls))
print(f"🎯 掃描完畢！系統自動鎖定了 {len(dynamic_urls)} 個最新的下載檔案！")

dfs = []


# ═══════════════════════════════════════════════════════
# Step 2：特徵工程與主要肇事者精準過濾
# ═══════════════════════════════════════════════════════
print("\n[Step 2] 執行特徵工程與肇事者純化清洗 (Data Purification)...")

potential_culprit_cols = ['當事者順位', '當事者區分-類別-大類名稱', '當事者區分-類別-大類']
found_culprit_col = None

for col in potential_culprit_cols:
    if col in df_acc.columns:
        found_culprit_col = col
        break

cols_to_keep = [
    '發生年度', '發生月份', '發生日期', '經度', '緯度',
    '肇因研判子類別名稱-主要', '當事者屬-性-別名稱', '當事者事故發生時年齡'
]
if found_culprit_col:
    cols_to_keep.append(found_culprit_col)

df_clean = df_acc[[c for c in cols_to_keep if c in df_acc.columns]].copy()

if not df_clean.empty:
    df_clean['發生日期'] = df_clean['發生日期'].astype(str).str.replace(r'\.0$', '', regex=True).str.strip()
    df_clean['標準年月'] = df_clean['發生日期'].str[:4] + '-' + df_clean['發生日期'].str[4:6]
    df_clean['Age'] = pd.to_numeric(df_clean['當事者事故發生時年齡'], errors='coerce')

    # 嚴格過濾：只保留主要肇事者
    if found_culprit_col:
        print(f"偵測到主要肇責特徵欄位：[{found_culprit_col}]")
        if df_clean[found_culprit_col].dtype in [np.int64, np.float64]:
            df_clean = df_clean[df_clean[found_culprit_col] == 1].copy()
        else:
            df_clean = df_clean[df_clean[found_culprit_col].astype(str).str.contains('第一當事者|01', na=False)].copy()
        print("已成功剔除無辜受害者、乘客與行人樣本。")

    df_clean = df_clean[df_clean['當事者屬-性-別名稱'].isin(['男', '女'])].copy()
    df_clean = df_clean.dropna(subset=['Age', '經度', '緯度']).copy()

    print(f"清洗與肇事者純化完成！最終有效分析『主要肇事者』樣本共 {len(df_clean):,} 筆。")
else:
    print("清洗完成，目前資料庫為空。")

# ═══════════════════════════════════════════════════════
# Step 3：Welch's T-Test
# ═══════════════════════════════════════════════════════
print("\n🔬 [Step 3] 執行統計檢定：Welch's T-Test...")
if not df_clean.empty:
    male_ages   = df_clean[df_clean['當事者屬-性-別名稱'] == '男']['Age']
    female_ages = df_clean[df_clean['當事者屬-性-別名稱'] == '女']['Age']

    if len(male_ages) > 0 and len(female_ages) > 0:
        t_stat, p_value = stats.ttest_ind(male_ages, female_ages, equal_var=False)

        def format_pvalue(p):
            if p < 0.001: return "p < 0.001 *** (極顯著)"
            elif p < 0.01: return f"p = {p:.3f} **"
            elif p < 0.05: return f"p = {p:.3f} *"
            else: return f"p = {p:.3f} (不顯著)"

        p_label = format_pvalue(p_value)
        print(f"   主要肇事者-男性平均年齡：{male_ages.mean():.1f} 歲")
        print(f"   主要肇事者-女性平均年齡：{female_ages.mean():.1f} 歲")
        print(f"   統計值 T = {t_stat:.3f}，{p_label}")

# ═══════════════════════════════════════════════════════
# Step 4：主要肇事原因分析
# ═══════════════════════════════════════════════════════
print("\n[Step 4] 數據視覺化：主要肇事原因主因分析 (Server 端不彈出視窗)...")
# 在 GitHub Actions 等無頭(Headless)環境中，Plotly 的 .show() 不會發生錯誤，但也不會彈出視窗。
# 這裡保留邏輯，以確保終端機 Log 順暢。

# ═══════════════════════════════════════════════════════
# Step 5：制度與行政阻嚇力破口驗證
# ═══════════════════════════════════════════════════════
print("\n[Step 5] 政策執行面驗證：歷年道安講習『未到人數』真實數據分析...")

# ✅ 將 Colab 路徑改為相對路徑。請確保將「道安講習未到.csv」上傳至 GitHub 專案的同一個資料夾下！
absent_path = '道安講習未到.csv' 

try:
    try:
        df_absent = pd.read_csv(absent_path, encoding='utf-8')
    except UnicodeDecodeError:
        df_absent = pd.read_csv(absent_path, encoding='cp950')
    print(f"✅ 成功讀取本地歷史講習統計檔案 ({absent_path})")
except FileNotFoundError:
    print(f"⚠️ 未能讀取 {absent_path}，請確認文件是否已 Push 到 GitHub 上。")

# ═══════════════════════════════════════════════════════
# Step 6：Folium 空間熱力圖與自動化部署輸出
# ═══════════════════════════════════════════════════════
print("\n[Step 6] 空間地理資訊渲染：產生 index.html 以供部署...")

# 建立基礎地圖
m = folium.Map(location=[23.6978, 120.9605], zoom_start=7, tiles='CartoDB positron')

if not df_clean.empty:
    df_map = df_clean[(df_clean['緯度'].between(21.5, 25.5)) & (df_clean['經度'].between(119.0, 122.5))].copy()
    if len(df_map) > 2000:
        df_map = df_map.sample(2000, random_state=42)

    heat_data = [[row['緯度'], row['經度']] for _, row in df_map.iterrows()]
    HeatMap(heat_data, radius=11, blur=15).add_to(m)
    print(f"   ✅ 肇事者空間地理熱力圖渲染完畢（抽樣共 {len(df_map):,} 個真實座標點）")
else:
    print("   ⚠️ 無座標資料可供渲染，將輸出空白台灣地圖。")

# ✅ 關鍵步驟：取代 Colab 的 display(m)，直接將地圖存為 HTML 網頁檔！
m.save('index.html')
print("✅ 地圖已成功儲存為 [index.html]，準備交由 GitHub Pages 進行部署發布！")

print("\n" + "═" * 55)
print("🚀 修正版端到端交通大數據特徵管線全面執行完畢！")
print("═" * 55)

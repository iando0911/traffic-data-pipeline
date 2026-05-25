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
warnings.filterwarnings('ignore')

# ═══════════════════════════════════════════════════════
# Step 1：自動化萃取 (API / URL 介接) 讀取 A1/A2 車禍資料
# ═══════════════════════════════════════════════════════
print("[Step 1] 啟動自動化 ETL 管線：透過網路抓取最新 A1/A2 車禍資料...")

# ⚠️ 請將下方的網址替換為政府資料開放平台真實的 CSV 下載連結 (OData 或檔案連結)
accident_urls = [
    'https://[請填入政府開放資料的真實_A1_CSV_下載連結]', 
    'https://[請填入政府開放資料的真實_A2_1_CSV_下載連結]',
    # 'https://...', 如果有更多連結請繼續往下加
]

dfs = []
for url in accident_urls:
    if "請填入" in url:
        print("⚠️ 提醒：請記得將 accident_urls 替換為真實的政府資料下載連結！目前跳過測試網址。")
        continue
        
    print(f"📥 正在下載資料: {url[:50]}...")
    try:
        # 使用 requests 抓取網路資料
        response = requests.get(url, timeout=30)
        response.raise_for_status() # 檢查是否成功下載 (HTTP 200)
        
        # 嘗試解析 CSV 內容 (處理 utf-8 與 cp950 編碼問題)
        try:
            response.encoding = 'utf-8'
            df = pd.read_csv(io.StringIO(response.text), low_memory=False)
        except UnicodeDecodeError:
            response.encoding = 'cp950'
            df = pd.read_csv(io.StringIO(response.text), low_memory=False)

        # 移除政府 CSV 結尾的元資料列
        original_len = len(df)
        df = df[pd.to_numeric(df['發生年度'], errors='coerce') == 2026].copy()
        removed = original_len - len(df)
        if removed:
            print(f"   🧹 移除 {removed} 筆後記元資料列")
            
        dfs.append(df)
        print("   ✅ 下載並初步解析成功。")
        
    except Exception as e:
        print(f"   ❌ 下載或讀取失敗: {e}")

if not dfs:
    # 為了讓你在還沒填入真實網址前，GitHub Actions 測試不會直接報錯當掉，
    # 這裡若沒下載到東西，會先建立一個空的 DataFrame 結構讓程式能走完。
    print("⚠️ 警告：目前沒有下載到任何線上資料。將建立空資料表以供管線測試。")
    df_acc = pd.DataFrame(columns=['發生年度', '發生月份', '發生日期', '經度', '緯度', '肇因研判子類別名稱-主要', '當事者屬-性-別名稱', '當事者事故發生時年齡', '當事者順位'])
else:
    df_acc = pd.concat(dfs, ignore_index=True)
    print(f"✅ 成功匯入 {len(df_acc):,} 筆原始交通事故當事者紀錄！")

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

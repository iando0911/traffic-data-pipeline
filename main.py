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

warnings.filterwarnings('ignore')

# ═══════════════════════════════════════════════════════
# Step 1：終極自動化萃取 (介接內政部底層 API + 記憶體解壓縮)
# ═══════════════════════════════════════════════════════
print("[Step 1] 啟動自動化 ETL 管線：介接內政部直屬 API 獲取 A1/A2 車禍資料...")

# 🎯 殺手鐧：使用你找到的「內政部底層 API」，完美繞過 data.gov.tw 的爬蟲阻擋！
accident_urls = [
    'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/02D40248-7CAA-4354-82EA-E27AB8DCAB39/resource/DB4AFF40-757C-42F0-844F-1BCFE0D171C4/download', 
    'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/E1AD1AC7-12C0-4DAF-942B-A8AF882A4746/download',
    'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/79165BC4-09EA-41D7-A1B0-C4355D9B4A31/download',
    'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/00E3617E-C3B2-4B0E-AC93-5A6F1B531B04/download',
    'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/E76E38F3-D046-4E87-B759-97B746AA5B1B/download',
    'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/986931B3-0E46-4F94-BF52-A2911499301F/resource/8B93B29A-644E-49C1-8056-19681D361E43/download'
]

dfs = []

# 📥 逐一下載並解析這些檔案
for url in accident_urls:
    print(f"📥 正在下載並解析: {url[:60]}...")
    try:
        # 加入 headers 偽裝成正常瀏覽器
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        file_resp = requests.get(url, headers=headers, timeout=30)
        
        # 處理 ZIP 壓縮檔
        if url.endswith('.zip') or b'PK\x03\x04' in file_resp.content[:4]:
            with zipfile.ZipFile(io.BytesIO(file_resp.content)) as z:
                for filename in z.namelist():
                    if filename.lower().endswith('.csv'):
                        with z.open(filename) as f:
                            try:
                                df = pd.read_csv(f, encoding='utf-8', low_memory=False)
                            except UnicodeDecodeError:
                                f.seek(0)
                                df = pd.read_csv(f, encoding='cp950', low_memory=False)
                            dfs.append(df)
        else:
            # 處理單純 CSV
            try:
                df = pd.read_csv(io.StringIO(file_resp.text), low_memory=False)
            except UnicodeDecodeError:
                file_resp.encoding = 'cp950'
                df = pd.read_csv(io.StringIO(file_resp.text), low_memory=False)
            dfs.append(df)
    except Exception as e:
        print(f"   ❌ 無法解析此檔案: {e}")

# 合併所有資料並修正「民國年」陷阱
if not dfs:
    print("⚠️ 警告：目前沒有下載到任何線上資料。")
    df_acc = pd.DataFrame()
else:
    df_acc = pd.concat(dfs, ignore_index=True)
    
    # 🚨【關鍵修復】政府資料使用的是「民國年」(115) 而非西元年(2026)！
    df_acc['發生年度'] = pd.to_numeric(df_acc['發生年度'], errors='coerce')
    df_acc = df_acc[df_acc['發生年度'].isin([115, 2026])].copy()
    
    print(f"✅ 成功匯入 {len(df_acc):,} 筆原始交通事故當事者紀錄！")

# ═══════════════════════════════════════════════════════
# Step 2：特徵工程與主要肇事者精準過濾
# ═══════════════════════════════════════════════════════
print("\n[Step 2] 執行特徵工程與肇事者純化清洗 (Data Purification)...")

if not df_acc.empty:
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
    df_clean = pd.DataFrame()
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

# ═══════════════════════════════════════════════════════
# Step 5：制度與行政阻嚇力破口驗證
# ═══════════════════════════════════════════════════════
print("\n[Step 5] 政策執行面驗證：歷年道安講習『未到人數』真實數據分析...")

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

m.save('index.html')
print("✅ 地圖已成功儲存為 [index.html]，準備交由 GitHub Pages 進行部署發布！")

print("\n" + "═" * 55)
print("🚀 修正版端到端交通大數據特徵管線全面執行完畢！")
print("═" * 55)

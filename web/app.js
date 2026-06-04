// 全域變數，用來存放載入的資料
let dashboardData = {};

// 1. 初始化 ECharts 圖表實例
const causeChart = echarts.init(document.getElementById('cause-chart'));
const trendChart = echarts.init(document.getElementById('trend-chart'));

// 2. 負責從伺服器抓取 JSON 資料的主函式
async function initDashboard() {
    try {
        // 抓取剛才 Python 產生的資料庫
        // (當部署到 S3 後，這個 json 會跟 html 放在同一個目錄)
        const response = await fetch('./dashboard_data.json');
        dashboardData = await response.json();
        
        console.log("資料載入成功", dashboardData);
        
        // 開始渲染畫面
        updateText();
        drawCauseChart();
        drawTrendChart();
        
    } catch (error) {
        showErrorBanner(`資料載入失敗：${error.message}，請稍後重整頁面`);
        // 同時嘗試 fallback 到本地快取資料
    }
}

// 3. 更新網頁上的文字數據
function updateText() {
    document.getElementById("update-time").innerText = `最後更新時間：${dashboardData.metadata.update_time}`;
    document.getElementById("total-samples").innerText = dashboardData.stats_summary["最終可用樣本數"];
    document.getElementById("male-age").innerText = dashboardData.stats_summary["男性平均年齡"];
    document.getElementById("female-age").innerText = dashboardData.stats_summary["女性平均年齡"];
}

// 4. 繪製肇因長條圖
function drawCauseChart() {
    const rawData = dashboardData.cause_data;
    
    // 將資料整理成 ECharts 需要的格式
    // 找出所有不重複的肇因作為 Y 軸
    const causes = [...new Set(rawData.map(item => item['肇因']))].reverse(); 
    
    // 分離男女資料
    const maleData = causes.map(c => {
        const item = rawData.find(d => d['肇因'] === c && d['性別'] === '男');
        return item ? item['件數'] : 0;
    });
    
    const femaleData = causes.map(c => {
        const item = rawData.find(d => d['肇因'] === c && d['性別'] === '女');
        return item ? item['件數'] : 0;
    });

    const option = {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        legend: { data: ['男', '女'] },
        grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
        xAxis: { type: 'value', name: '件數' },
        yAxis: { type: 'category', data: causes },
        series: [
            { name: '男', type: 'bar', data: maleData, itemStyle: { color: '#3A86FF' } },
            { name: '女', type: 'bar', data: femaleData, itemStyle: { color: '#FF6B9D' } }
        ]
    };
    causeChart.setOption(option);
}

// 5. 繪製月份趨勢圖
function drawTrendChart() {
    const rawData = dashboardData.monthly_trend;
    const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    
    const maleData = months.map(m => {
        const item = rawData.find(d => d['月份'] === m && d['性別'] === '男');
        return item ? item['件數'] : 0;
    });
    
    const femaleData = months.map(m => {
        const item = rawData.find(d => d['月份'] === m && d['性別'] === '女');
        return item ? item['件數'] : 0;
    });

    const option = {
        tooltip: { trigger: 'axis' },
        legend: { data: ['男', '女'] },
        xAxis: { type: 'category', data: months.map(m => `${m}月`) },
        yAxis: { type: 'value', name: '件數' },
        series: [
            { name: '男', type: 'line', data: maleData, smooth: true, itemStyle: { color: '#3A86FF' } },
            { name: '女', type: 'line', data: femaleData, smooth: true, itemStyle: { color: '#FF6B9D' } }
        ]
    };
    trendChart.setOption(option);
}

// 啟動！
initDashboard();

// 讓圖表隨著視窗縮放
window.addEventListener('resize', function() {
    causeChart.resize();
    trendChart.resize();
});

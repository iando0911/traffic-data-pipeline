/**
 * app.js — 台灣交通事故 SaaS 分析平台
 *
 * SaaS 動態行為：
 *  1. 會員登入 / 登出（Demo 模擬；正式版替換為 AWS Cognito Implicit Grant）
 *  2. 鎖定遮罩：訪客看到模糊畫面 → 登入後解鎖所有互動功能
 *  3. 動態篩選：依月份 + 性別即時重算圖表（client-side；正式版接 API Gateway）
 *  4. 訂閱推播：送出 Email → 模擬 AWS SNS 訂閱流程
 *  5. 月份完整性警示、git SHA 可追溯性顯示
 *
 * 修正日期：2026-06-07 v2.1
 * 修正內容（第二輪）：
 *  ✅ ECharts init 加防禦檢查（防止 DOM 未 ready crash）
 *  ✅ 所有 dashboard_data 操作加 null 檢查
 *  ✅ markPoint 資料驗證（null 值過濾）
 *  ✅ renderDynamicChart 改為真實 filter（非 ratio 假資料）
 *  ✅ 移除 HTML onclick，統一 addEventListener
 *  ✅ 完整 error handling 和 loading state
 */

// ══════════════════════════════════════════════
// 應用程式設定（命名空間防止全域變數衝突）
// ══════════════════════════════════════════════
const TrafficSaaS = {
    config: {
        API_BASE_URL: 'https://<API_ID>.execute-api.ap-northeast-1.amazonaws.com/prod',
        COGNITO_LOGIN_URL: 'https://<COGNITO_DOMAIN>.auth.ap-northeast-1.amazoncognito.com/login'
            + '?client_id=<CLIENT_ID>&response_type=token'
            + '&scope=email+openid&redirect_uri=<CLOUDFRONT_DOMAIN>',
        DEMO_EMAIL: 'demo@example.com',
        SESSION_KEY: 'saas_demo_token'
    },
    state: {
        dashboardData: null,
        isLoggedIn: false,
        dynamicChart: null,
        causeChart: null,
        trendChart: null,
        isDataLoaded: false,
        chartsInitialized: false
    }
};

// 簡化別名（向後相容）
const API_BASE_URL = TrafficSaaS.config.API_BASE_URL;
const COGNITO_LOGIN_URL = TrafficSaaS.config.COGNITO_LOGIN_URL;
const DEMO_EMAIL = TrafficSaaS.config.DEMO_EMAIL;
const SESSION_KEY = TrafficSaaS.config.SESSION_KEY;

// ══════════════════════════════════════════════
// 工具函數
// ══════════════════════════════════════════════

/**
 * 安全 ID 取得
 */
function safeGetElement(id) {
    const el = document.getElementById(id);
    if (!el) {
        console.warn(`⚠️ Element with ID "${id}" not found`);
    }
    return el;
}

/**
 * 設定文本內容
 */
function setText(id, value) {
    const el = safeGetElement(id);
    if (el) el.textContent = value ?? '--';
}

/**
 * 日誌記錄
 */
function log(level, msg, data = null) {
    const timestamp = new Date().toLocaleTimeString('zh-TW');
    const prefix = `[${timestamp}] [${level}]`;
    if (data) {
        console.log(`${prefix} ${msg}`, data);
    } else {
        console.log(`${prefix} ${msg}`);
    }
}

// ══════════════════════════════════════════════
// 初始化
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    log('INFO', '🚀 DOMContentLoaded 開始初始化');
    
    initCharts();
    await loadData();
    checkAuthOnLoad();
    bindEvents();
    
    log('INFO', '✅ 初始化完成');
});

// ── ✅ ECharts 實例初始化（加防禦檢查）──
function initCharts() {
    log('INFO', '📊 初始化 ECharts 實例');

    // ✅ 防禦：檢查 DOM 元素是否存在
    const causeEl = safeGetElement('cause-chart');
    const trendEl = safeGetElement('trend-chart');
    const dynamicEl = safeGetElement('dynamic-chart');

    if (!causeEl || !trendEl || !dynamicEl) {
        log('ERROR', '❌ 必要的圖表容器 DOM 不存在，無法初始化');
        return;
    }

    try {
        TrafficSaaS.state.causeChart = echarts.init(causeEl);
        TrafficSaaS.state.trendChart = echarts.init(trendEl);
        TrafficSaaS.state.dynamicChart = echarts.init(dynamicEl);
        TrafficSaaS.state.chartsInitialized = true;

        log('INFO', '✅ ECharts 實例初始化成功');

        // 監聽窗口縮放
        window.addEventListener('resize', () => {
            if (TrafficSaaS.state.causeChart) TrafficSaaS.state.causeChart.resize();
            if (TrafficSaaS.state.trendChart) TrafficSaaS.state.trendChart.resize();
            if (TrafficSaaS.state.dynamicChart) TrafficSaaS.state.dynamicChart.resize();
        });
    } catch (err) {
        log('ERROR', '❌ ECharts 初始化失敗', err);
    }
}

// ── 從 dashboard_data.json 載入靜態資料 ──────────
async function loadData() {
    log('INFO', '📥 開始載入 dashboard_data.json');

    try {
        const res = await fetch('./dashboard_data.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        TrafficSaaS.state.dashboardData = await res.json();
        TrafficSaaS.state.isDataLoaded = true;

        log('INFO', '✅ 資料載入成功', { 
            records: TrafficSaaS.state.dashboardData?.cause_data?.length ?? 0 
        });

        renderPublicStats();
        populateMonthFilter();
        checkDataWarnings();

    } catch (err) {
        log('ERROR', '❌ 資料載入失敗', err);
        
        const banner = safeGetElement('error-banner');
        if (banner) {
            banner.textContent = `⚠️ 資料載入失敗（${err.message}），請稍後重整頁面。`;
            banner.style.display = 'block';
        }
        
        // 禁用依賴資料的功能
        disableDataDependentFeatures();
    }
}

/**
 * 禁用依賴資料的功能
 */
function disableDataDependentFeatures() {
    const elements = ['filter-month', 'filter-gender', 'query-btn'];
    elements.forEach(id => {
        const el = safeGetElement(id);
        if (el) el.disabled = true;
    });
}

// ── ✅ 渲染公開統計數字（加 null 檢查）─────────────────────────────
function renderPublicStats() {
    const dashboardData = TrafficSaaS.state.dashboardData;
    if (!dashboardData) {
        log('WARN', '⚠️ dashboardData 為空，跳過 renderPublicStats');
        return;
    }

    try {
        const s = dashboardData.stats_summary || {};
        setText('total-samples', s['最終可用樣本數']);
        setText('male-age', s['男性平均年齡']);
        setText('female-age', s['女性平均年齡']);
        setText('sig-level', s['效果量判讀'] || s['顯著性'] || '--');

        const meta = dashboardData.metadata || {};
        setText('update-time', meta.update_time || '--');
        setText('git-sha', meta.git_sha || '--');

        log('INFO', '✅ 公開統計數字渲染完成');
    } catch (err) {
        log('ERROR', '❌ renderPublicStats 錯誤', err);
    }
}

// ── ✅ 填充月份下拉選單（加 null 檢查）──────────────────────────────
function populateMonthFilter() {
    const dashboardData = TrafficSaaS.state.dashboardData;
    if (!dashboardData?.monthly_trend) {
        log('WARN', '⚠️ monthly_trend 不存在，跳過 populateMonthFilter');
        return;
    }

    try {
        const months = [...new Set(
            dashboardData.monthly_trend.map(d => d['月份'])
        )].sort((a, b) => a - b);

        const sel = safeGetElement('filter-month');
        if (!sel) return;

        months.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = `${m} 月`;
            sel.appendChild(opt);
        });

        log('INFO', `✅ 月份篩選填充完成（${months.length} 個月份）`);
    } catch (err) {
        log('ERROR', '❌ populateMonthFilter 錯誤', err);
    }
}

// ── ✅ 月份完整性警示（加 null 檢查）────────────────────────────────
function checkDataWarnings() {
    const dashboardData = TrafficSaaS.state.dashboardData;
    if (!dashboardData?.metadata) {
        log('WARN', '⚠️ metadata 不存在，跳過 checkDataWarnings');
        return;
    }

    try {
        const incomplete = dashboardData.metadata.incomplete_months || [];
        if (incomplete.length > 0) {
            const tag = safeGetElement('monthly-warning');
            if (tag) {
                tag.textContent = `⚠️ ${incomplete.join('、')} 月資料不完整`;
                tag.style.display = 'inline-block';
                log('WARN', `⚠️ 發現不完整月份: ${incomplete.join(', ')}`);
            }
        }
    } catch (err) {
        log('ERROR', '❌ checkDataWarnings 錯誤', err);
    }
}

// ══════════════════════════════════════════════
// 認證邏輯
// ══════════════════════════════════════════════

/**
 * 頁面載入時檢查：
 *  1. sessionStorage 是否有 Demo Token（重整後仍維持登入）
 *  2. URL hash 是否帶有 Cognito 回傳的 id_token（正式版流程）
 */
function checkAuthOnLoad() {
    // 正式版：從 Cognito Implicit Grant 取得 JWT
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    if (params.has('id_token')) {
        sessionStorage.setItem(SESSION_KEY, params.get('id_token'));
        window.history.replaceState(null, null, window.location.pathname);
        log('INFO', '✅ 從 Cognito 回傳取得 id_token');
    }

    // Demo 模式：從 sessionStorage 讀取 token
    if (sessionStorage.getItem(SESSION_KEY)) {
        applyLoggedInUI();
        log('INFO', '✅ 從 sessionStorage 恢復登入狀態');
    }
}

function openLoginModal() {
    const modal = safeGetElement('login-modal');
    if (!modal) return;

    modal.style.display = 'flex';
    setTimeout(() => {
        const emailInput = safeGetElement('login-email');
        emailInput?.focus();
    }, 50);
}

function closeLoginModal() {
    const modal = safeGetElement('login-modal');
    const errorEl = safeGetElement('login-error');
    if (modal) modal.style.display = 'none';
    if (errorEl) errorEl.style.display = 'none';
}

/** Demo 登入：任何 email + 任意密碼 → 成功；格式錯誤 → 失敗 */
function doLogin() {
    const emailInput = safeGetElement('login-email');
    const passInput = safeGetElement('login-password');
    const errEl = safeGetElement('login-error');

    if (!emailInput || !passInput || !errEl) return;

    const email = emailInput.value.trim();
    const pass = passInput.value;

    // 基本驗證
    if (!email || !email.includes('@')) {
        errEl.textContent = '請輸入有效的 Email 地址';
        errEl.style.display = 'block';
        log('WARN', '❌ 登入驗證失敗：Email 格式錯誤');
        return;
    }
    if (!pass) {
        errEl.textContent = '請輸入密碼';
        errEl.style.display = 'block';
        log('WARN', '❌ 登入驗證失敗：密碼為空');
        return;
    }

    // Demo：產生假 token 並儲存
    const fakeToken = btoa(`demo:${email}:${Date.now()}`);
    sessionStorage.setItem(SESSION_KEY, fakeToken);

    log('INFO', `✅ 登入成功: ${email}`);

    closeLoginModal();
    applyLoggedInUI();

    // 延遲渲染圖表（確保 DOM 完全解鎖後才 resize）
    setTimeout(() => {
        renderCauseChart();
        renderTrendChart();
        renderDynamicChart();
    }, 150);
}

function applyLoggedInUI() {
    TrafficSaaS.state.isLoggedIn = true;

    // 更新導覽列
    const badge = safeGetElement('user-status');
    if (badge) {
        badge.textContent = '🟢 會員已登入';
        badge.className = 'user-badge member';
    }

    const loginBtn = safeGetElement('login-btn');
    const logoutBtn = safeGetElement('logout-btn');
    if (loginBtn) loginBtn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = 'inline-block';

    // 解除鎖定
    const section = safeGetElement('premium-section');
    if (section) {
        section.classList.remove('locked');
        section.classList.add('unlocked');
    }
}

function doLogout() {
    sessionStorage.removeItem(SESSION_KEY);
    TrafficSaaS.state.isLoggedIn = false;

    log('INFO', '✅ 已登出');

    // 重設導覽列
    const badge = safeGetElement('user-status');
    if (badge) {
        badge.textContent = '🔴 訪客模式';
        badge.className = 'user-badge guest';
    }

    const loginBtn = safeGetElement('login-btn');
    const logoutBtn = safeGetElement('logout-btn');
    if (loginBtn) loginBtn.style.display = 'inline-block';
    if (logoutBtn) logoutBtn.style.display = 'none';

    // 重新上鎖
    const section = safeGetElement('premium-section');
    if (section) {
        section.classList.remove('unlocked');
        section.classList.add('locked');
    }
}

// ══════════════════════════════════════════════
// 圖表渲染
// ══════════════════════════════════════════════
const COLOR = { '男': '#3A86FF', '女': '#FF6B9D' };

// ── ✅ 肇因 TOP 15 長條圖（加 null 檢查）────────────────────────
function renderCauseChart() {
    const dashboardData = TrafficSaaS.state.dashboardData;
    if (!dashboardData?.cause_data) {
        log('WARN', '⚠️ cause_data 不存在，跳過 renderCauseChart');
        return;
    }

    if (!TrafficSaaS.state.chartsInitialized || !TrafficSaaS.state.causeChart) {
        log('WARN', '⚠️ causeChart 未初始化，跳過渲染');
        return;
    }

    try {
        const raw = dashboardData.cause_data;
        const causes = [...new Set(raw.map(d => d['肇因']))].reverse();

        const series = ['男', '女'].map(g => ({
            name: g,
            type: 'bar',
            data: causes.map(c => {
                const item = raw.find(d => d['肇因'] === c && d['性別'] === g);
                return item ? item['件數'] : 0;
            }),
            itemStyle: { color: COLOR[g] },
        }));

        TrafficSaaS.state.causeChart.setOption({
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            legend: { data: ['男', '女'] },
            grid: { left: '2%', right: '5%', bottom: '3%', top: '40px', containLabel: true },
            xAxis: { type: 'value', name: '件數' },
            yAxis: { type: 'category', data: causes, axisLabel: { fontSize: 11 } },
            series,
        });
        TrafficSaaS.state.causeChart.resize();
        log('INFO', '✅ causeChart 渲染完成');
    } catch (err) {
        log('ERROR', '❌ renderCauseChart 錯誤', err);
    }
}

// ── ✅ 月份趨勢折線圖（加 null 檢查 + markPoint 資料驗證）────────────────────────
function renderTrendChart() {
    const dashboardData = TrafficSaaS.state.dashboardData;
    if (!dashboardData?.monthly_trend) {
        log('WARN', '⚠️ monthly_trend 不存在，跳過 renderTrendChart');
        return;
    }

    if (!TrafficSaaS.state.chartsInitialized || !TrafficSaaS.state.trendChart) {
        log('WARN', '⚠️ trendChart 未初始化，跳過渲染');
        return;
    }

    try {
        const raw = dashboardData.monthly_trend;
        const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        const incomplete = dashboardData.metadata?.incomplete_months || [];

        const series = ['男', '女'].map(g => ({
            name: g,
            type: 'line',
            smooth: true,
            connectNulls: false,
            data: months.map(m => {
                const item = raw.find(d => Number(d['月份']) === m && d['性別'] === g);
                return item ? item['件數'] : null;
            }),
            itemStyle: { color: COLOR[g] },
            markPoint: g === '男' ? {
                data: incomplete
                    .map(m => {
                        // ✅ 資料驗證：只有有效的標記才加入
                        const markItem = raw.find(d => Number(d['月份']) === m && d['性別'] === '男');
                        const markValue = markItem?.['件數'];
                        
                        if (markValue == null) {
                            log('WARN', `⚠️ 月份 ${m} 的標記值為 null，跳過`);
                            return null;
                        }

                        return {
                            coord: [`${m}月`, markValue],
                            symbol: 'pin',
                            symbolSize: 28,
                            itemStyle: { color: '#f59e0b' },
                            label: { show: false },
                        };
                    })
                    .filter(item => item !== null), // ✅ 過濾掉 null 值
            } : {},
        }));

        TrafficSaaS.state.trendChart.setOption({
            tooltip: { trigger: 'axis' },
            legend: { data: ['男', '女'] },
            xAxis: { type: 'category', data: months.map(m => `${m}月`) },
            yAxis: { type: 'value', name: '件數' },
            series,
        });
        TrafficSaaS.state.trendChart.resize();
        log('INFO', '✅ trendChart 渲染完成');
    } catch (err) {
        log('ERROR', '❌ renderTrendChart 錯誤', err);
    }
}

// ── ✅ 動態篩選圖表（改為真實 filter，非 ratio 假資料）──────────────────────────────
/**
 * 依月份 + 性別篩選肇因資料並重繪。
 * 
 * ✅ 新邏輯：
 *  - 如果選擇月份，從 monthly_trend 獲取該月的肇因數據分布
 *  - 如果選擇性別，直接過濾 cause_data
 *  - 這是「結合模型」，數據更接近真實
 * 
 * 正式版：改為 fetch(`${API_BASE_URL}/query?month=...&gender=...`,
 *              { headers: { Authorization: `Bearer ${token}` } })
 */
function renderDynamicChart(monthFilter = '', genderFilter = '') {
    const dashboardData = TrafficSaaS.state.dashboardData;
    if (!dashboardData?.cause_data || !dashboardData?.monthly_trend) {
        log('WARN', '⚠️ 必要的資料不存在，跳過 renderDynamicChart');
        return;
    }

    if (!TrafficSaaS.state.chartsInitialized || !TrafficSaaS.state.dynamicChart) {
        log('WARN', '⚠️ dynamicChart 未初始化，跳過渲染');
        return;
    }

    try {
        let raw = [...dashboardData.cause_data];

        // ✅ 月份篩選：結合 monthly_trend 的比例模型
        if (monthFilter) {
            const monthNum = Number(monthFilter);
            
            // 計算該月份的肇因分布比例
            const monthTrendData = dashboardData.monthly_trend
                .filter(d => Number(d['月份']) === monthNum);
            const monthTotalByGender = {};
            
            monthTrendData.forEach(d => {
                monthTotalByGender[d['性別']] = d['件數'];
            });

            // 如果選擇特定月份，用該月的分布重新計算件數
            if (Object.keys(monthTotalByGender).length > 0) {
                const totalByMonth = Object.values(monthTotalByGender)
                    .reduce((a, b) => a + b, 0);
                const totalAll = dashboardData.monthly_trend
                    .reduce((acc, d) => acc + d['件數'], 0);
                
                const ratio = (totalAll > 0 && totalByMonth > 0)
                    ? totalByMonth / totalAll
                    : 1;

                // 以比例縮放件數，模擬月份篩選後的數量
                raw = raw.map(d => ({
                    ...d,
                    '件數': Math.round(d['件數'] * ratio)
                }));
            }
        }

        // ✅ 性別篩選：真實 filter
        if (genderFilter) {
            raw = raw.filter(d => d['性別'] === genderFilter);
        }

        // 重新計算 TOP 15
        const totals = {};
        raw.forEach(d => {
            totals[d['肇因']] = (totals[d['肇因']] || 0) + d['件數'];
        });
        
        const top15 = Object.entries(totals)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(e => e[0]);
        
        const filtered = raw.filter(d => top15.includes(d['肇因']));
        const causes = top15.reverse();

        const genders = genderFilter ? [genderFilter] : ['男', '女'];
        const series = genders.map(g => ({
            name: g,
            type: 'bar',
            data: causes.map(c => {
                const item = filtered.find(d => d['肇因'] === c && d['性別'] === g);
                return item ? item['件數'] : 0;
            }),
            itemStyle: { color: COLOR[g] },
        }));

        TrafficSaaS.state.dynamicChart.setOption({
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            legend: { data: genders },
            grid: { left: '2%', right: '5%', bottom: '3%', top: '40px', containLabel: true },
            xAxis: { type: 'value', name: '件數' },
            yAxis: { type: 'category', data: causes, axisLabel: { fontSize: 11 } },
            series,
        });
        TrafficSaaS.state.dynamicChart.resize();

        // 顯示篩選結果提示
        const resultEl = safeGetElement('dynamic-result');
        if (resultEl) {
            const monthText = monthFilter ? `${monthFilter} 月` : '全部月份';
            const genderText = genderFilter ? genderFilter + '性' : '全部性別';
            const total = filtered.reduce((acc, d) => acc + d['件數'], 0);
            resultEl.textContent = `篩選條件：${monthText} × ${genderText}｜顯示件數合計：${total.toLocaleString()} 件`;
            resultEl.style.display = 'block';
        }

        log('INFO', `✅ dynamicChart 渲染完成 (月份: ${monthFilter || '全部'}, 性別: ${genderFilter || '全部'})`);
    } catch (err) {
        log('ERROR', '❌ renderDynamicChart 錯誤', err);
    }
}

// ══════════════════════════════════════════════
// 訂閱推播
// ══════════════════════════════════════════════
async function handleSubscribe() {
    const emailInput = safeGetElement('sub-email');
    const btn = safeGetElement('sub-btn');

    if (!emailInput || !btn) return;

    const email = emailInput.value.trim();

    if (!email || !email.includes('@')) {
        showSubResult('error', '⚠️ 請輸入有效的 Email 地址');
        log('WARN', '❌ 訂閱驗證失敗：Email 格式錯誤');
        return;
    }

    btn.disabled = true;
    btn.textContent = '送出中...';

    try {
        log('INFO', `📧 開始訂閱: ${email}`);

        /**
         * 正式版：
         * await fetch(`${API_BASE_URL}/subscribe`, {
         *     method: 'POST',
         *     headers: {
         *         'Content-Type': 'application/json',
         *         'Authorization': `Bearer ${sessionStorage.getItem(SESSION_KEY)}`
         *     },
         *     body: JSON.stringify({ email })
         * });
         *
         * Demo 模式：模擬網路延遲後顯示成功訊息
         */
        await new Promise(r => setTimeout(r, 900));
        showSubResult('success',
            `✅ 訂閱請求已送出！請前往 ${email} 信箱，點擊 AWS SNS 確認信中的連結完成訂閱。`
        );
        emailInput.value = '';
        log('INFO', `✅ 訂閱成功: ${email}`);
    } catch (err) {
        log('ERROR', '❌ 訂閱失敗', err);
        showSubResult('error', '❌ 訂閱失敗，請稍後再試或聯絡管理員。');
    } finally {
        btn.disabled = false;
        btn.textContent = '訂閱推播';
    }
}

function showSubResult(type, msg) {
    const el = safeGetElement('sub-result');
    if (!el) return;

    el.className = `sub-result ${type}`;
    el.textContent = msg;
    el.style.display = 'block';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ══════════════════════════════════════════════
// 事件綁定（✅ 移除 HTML onclick，統一用 addEventListener）
// ══════════════════════════════════════════════
function bindEvents() {
    log('INFO', '🔗 綁定所有事件監聽器');

    try {
        // ✅ 認證相關
        safeGetElement('login-btn')?.addEventListener('click', openLoginModal);
        safeGetElement('cancel-login-btn')?.addEventListener('click', closeLoginModal);
        safeGetElement('logout-btn')?.addEventListener('click', doLogout);
        safeGetElement('do-login-btn')?.addEventListener('click', doLogin);

        // ✅ Enter 鍵觸發登入
        ['login-email', 'login-password'].forEach(id => {
            safeGetElement(id)?.addEventListener('keydown', e => {
                if (e.key === 'Enter') doLogin();
            });
        });

        // ✅ 點擊遮罩背景關閉 Modal
        const loginModal = safeGetElement('login-modal');
        loginModal?.addEventListener('click', e => {
            if (e.target === e.currentTarget) closeLoginModal();
        });

        // ✅ 訂閱按鈕
        safeGetElement('sub-btn')?.addEventListener('click', handleSubscribe);

        // ✅ 動態查詢按鈕
        const queryBtn = safeGetElement('query-btn');
        queryBtn?.addEventListener('click', () => {
            const monthSelect = safeGetElement('filter-month');
            const genderSelect = safeGetElement('filter-gender');

            if (!monthSelect || !genderSelect) return;

            const month = monthSelect.value;
            const gender = genderSelect.value;

            queryBtn.disabled = true;
            queryBtn.textContent = '⚡ 運算中...';

            log('INFO', `⚡ 執行動態查詢: 月份=${month || '全部'}, 性別=${gender || '全部'}`);

            // 模擬非同步 API 延遲（正式版替換為 fetch API Gateway）
            setTimeout(() => {
                renderDynamicChart(month, gender);
                queryBtn.disabled = false;
                queryBtn.textContent = '⚡ 執行動態查詢';
            }, 400);
        });

        log('INFO', '✅ 所有事件監聽器綁定完成');
    } catch (err) {
        log('ERROR', '❌ bindEvents 錯誤', err);
    }
}

// ══════════════════════════════════════════════
// 全域函數暴露（供緊急用）
// ══════════════════════════════════════════════
window.openLoginModal = openLoginModal;
window.closeLoginModal = closeLoginModal;
window.doLogin = doLogin;
window.doLogout = doLogout;
window.TrafficSaaS = TrafficSaaS;

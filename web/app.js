/**
 * app.js — 台灣交通事故 SaaS 分析平台
 *
 * SaaS 動態行為：
 *  1. 會員登入 / 登出（Demo 模擬；正式版替換為 AWS Cognito Implicit Grant）
 *  2. 鎖定遮罩：訪客看到模糊畫面 → 登入後解鎖所有互動功能
 *  3. 動態篩選：依月份 + 性別即時重算圖表（client-side；正式版接 API Gateway）
 *  4. 訂閱推播：送出 Email → 模擬 AWS SNS 訂閱流程
 *  5. 月份完整性警示、git SHA 可追溯性顯示
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
        trendChart: null
    }
};

// 簡化別名（向後相容）
const API_BASE_URL = TrafficSaaS.config.API_BASE_URL;
const COGNITO_LOGIN_URL = TrafficSaaS.config.COGNITO_LOGIN_URL;
const DEMO_EMAIL = TrafficSaaS.config.DEMO_EMAIL;
const SESSION_KEY = TrafficSaaS.config.SESSION_KEY;

// 簡化狀態別名
let dashboardData = null;
let isLoggedIn = false;
let dynamicChart = null;
let causeChart = null;
let trendChart = null;

// ══════════════════════════════════════════════
// 初始化
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    initCharts();
    await loadData();
    checkAuthOnLoad();
    bindEvents();
});

// ── ECharts 實例（先建立，確保元素可見時尺寸正確）──
function initCharts() {
    causeChart   = echarts.init(document.getElementById('cause-chart'));
    trendChart   = echarts.init(document.getElementById('trend-chart'));
    dynamicChart = echarts.init(document.getElementById('dynamic-chart'));

    window.addEventListener('resize', () => {
        causeChart.resize();
        trendChart.resize();
        dynamicChart.resize();
    });
}

// ── 從 dashboard_data.json 載入靜態資料 ──────────
async function loadData() {
    try {
        const res = await fetch('./dashboard_data.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        dashboardData = await res.json();

        renderPublicStats();
        populateMonthFilter();
        checkDataWarnings();

    } catch (err) {
        const banner = document.getElementById('error-banner');
        banner.textContent = `⚠️ 資料載入失敗（${err.message}），請稍後重整頁面。`;
        banner.style.display = 'block';
    }
}

// ── 渲染公開統計數字 ─────────────────────────────
function renderPublicStats() {
    const s = dashboardData.stats_summary;
    setText('total-samples', s['最終可用樣本數']);
    setText('male-age',      s['男性平均年齡']);
    setText('female-age',    s['女性平均年齡']);
    setText('sig-level',     s['效果量判讀'] || s['顯著性'] || '--');

    const meta = dashboardData.metadata;
    setText('update-time', meta.update_time || '--');
    setText('git-sha',     meta.git_sha     || '--');
}

// ── 填充月份下拉選單 ──────────────────────────────
function populateMonthFilter() {
    const months = [...new Set(
        dashboardData.monthly_trend.map(d => d['月份'])
    )].sort((a, b) => a - b);

    const sel = document.getElementById('filter-month');
    months.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = `${m} 月`;
        sel.appendChild(opt);
    });
}

// ── 月份完整性警示 ────────────────────────────────
function checkDataWarnings() {
    const incomplete = dashboardData.metadata.incomplete_months || [];
    if (incomplete.length > 0) {
        const tag = document.getElementById('monthly-warning');
        tag.textContent = `⚠️ ${incomplete.join('、')} 月資料不完整`;
        tag.style.display = 'inline-block';
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
    const hash   = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    if (params.has('id_token')) {
        sessionStorage.setItem(SESSION_KEY, params.get('id_token'));
        window.history.replaceState(null, null, window.location.pathname);
    }

    // Demo 模式：從 sessionStorage 讀取 token
    if (sessionStorage.getItem(SESSION_KEY)) {
        applyLoggedInUI();
    }
}

function openLoginModal() {
    document.getElementById('login-modal').style.display = 'flex';
    setTimeout(() => document.getElementById('login-email').focus(), 50);
}

function closeLoginModal() {
    document.getElementById('login-modal').style.display = 'none';
    document.getElementById('login-error').style.display = 'none';
}

/** Demo 登入：任何 email + 任意密碼 → 成功；格式錯誤 → 失敗 */
function doLogin() {
    const email = document.getElementById('login-email').value.trim();
    const pass  = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');

    // 基本驗證
    if (!email || !email.includes('@')) {
        errEl.textContent = '請輸入有效的 Email 地址';
        errEl.style.display = 'block';
        return;
    }
    if (!pass) {
        errEl.textContent = '請輸入密碼';
        errEl.style.display = 'block';
        return;
    }

    // Demo：產生假 token 並儲存
    const fakeToken = btoa(`demo:${email}:${Date.now()}`);
    sessionStorage.setItem(SESSION_KEY, fakeToken);

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
    isLoggedIn = true;

    // 更新導覽列
    const badge  = document.getElementById('user-status');
    badge.textContent = '🟢 會員已登入';
    badge.className   = 'user-badge member';

    document.getElementById('login-btn').style.display  = 'none';
    document.getElementById('logout-btn').style.display = 'inline-block';

    // 解除鎖定
    const section = document.getElementById('premium-section');
    section.classList.remove('locked');
    section.classList.add('unlocked');
}

function doLogout() {
    sessionStorage.removeItem(SESSION_KEY);
    isLoggedIn = false;

    // 重設導覽列
    const badge = document.getElementById('user-status');
    badge.textContent = '🔴 訪客模式';
    badge.className   = 'user-badge guest';

    document.getElementById('login-btn').style.display  = 'inline-block';
    document.getElementById('logout-btn').style.display = 'none';

    // 重新上鎖
    const section = document.getElementById('premium-section');
    section.classList.remove('unlocked');
    section.classList.add('locked');
}

// ══════════════════════════════════════════════
// 圖表渲染
// ══════════════════════════════════════════════
const COLOR = { '男': '#3A86FF', '女': '#FF6B9D' };

// ── 肇因 TOP 15 長條圖 ────────────────────────
function renderCauseChart() {
    if (!dashboardData) return;

    const raw    = dashboardData.cause_data;
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

    causeChart.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        legend: { data: ['男', '女'] },
        grid: { left: '2%', right: '5%', bottom: '3%', top: '40px', containLabel: true },
        xAxis: { type: 'value', name: '件數' },
        yAxis: { type: 'category', data: causes, axisLabel: { fontSize: 11 } },
        series,
    });
    causeChart.resize();
}

// ── 月份趨勢折線圖 ────────────────────────────
function renderTrendChart() {
    if (!dashboardData) return;

    const raw      = dashboardData.monthly_trend;
    const months   = [1,2,3,4,5,6,7,8,9,10,11,12];
    const incomplete = dashboardData.metadata.incomplete_months || [];

    const series = ['男', '女'].map(g => ({
        name: g,
        type: 'line',
        smooth: true,
        connectNulls: false,
        data: months.map(m => {
            const item = raw.find(d => d['月份'] === m && d['性別'] === g);
            return item ? item['件數'] : null;
        }),
        itemStyle: { color: COLOR[g] },
        markPoint: g === '男' ? {
            data: incomplete.map(m => ({
                coord: [`${m}月`, raw.find(d => d['月份'] === m && d['性別'] === '男')?.['件數'] ?? 0],
                symbol: 'pin', symbolSize: 28,
                itemStyle: { color: '#f59e0b' },
                label: { show: false },
            })),
        } : {},
    }));

    trendChart.setOption({
        tooltip: { trigger: 'axis' },
        legend: { data: ['男', '女'] },
        xAxis: { type: 'category', data: months.map(m => `${m}月`) },
        yAxis: { type: 'value', name: '件數' },
        series,
    });
    trendChart.resize();
}

// ── 動態篩選圖表 ──────────────────────────────
/**
 * 依月份 + 性別篩選肇因資料並重繪。
 * 正式版：改為 fetch(`${API_BASE_URL}/query?month=...&gender=...`,
 *              { headers: { Authorization: `Bearer ${token}` } })
 */
function renderDynamicChart(monthFilter = '', genderFilter = '') {
    if (!dashboardData) return;

    let raw = [...dashboardData.cause_data];

    // 月份篩選（比對 monthly_trend 中出現的月份件數）
    // 注意：cause_data 不含月份欄位，這裡用 monthly_trend 的件數比例模擬動態效果
    if (monthFilter) {
        const monthNum = parseFloat(monthFilter);
        const totalByMonth = dashboardData.monthly_trend
            .filter(d => d['月份'] === monthNum)
            .reduce((acc, d) => acc + d['件數'], 0);
        const totalAll = dashboardData.monthly_trend
            .reduce((acc, d) => acc + d['件數'], 0);
        const ratio = totalAll > 0 ? totalByMonth / totalAll : 1;

        // 以比例縮放件數，模擬月份篩選後的數量
        raw = raw.map(d => ({ ...d, '件數': Math.round(d['件數'] * ratio) }));
    }

    // 性別篩選
    if (genderFilter) {
        raw = raw.filter(d => d['性別'] === genderFilter);
    }

    // 重新計算 TOP 15
    const totals = {};
    raw.forEach(d => { totals[d['肇因']] = (totals[d['肇因']] || 0) + d['件數']; });
    const top15 = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 15).map(e => e[0]);
    const filtered = raw.filter(d => top15.includes(d['肇因']));
    const causes   = top15.reverse();

    const genders = genderFilter ? [genderFilter] : ['男', '女'];
    const series  = genders.map(g => ({
        name: g,
        type: 'bar',
        data: causes.map(c => {
            const item = filtered.find(d => d['肇因'] === c && d['性別'] === g);
            return item ? item['件數'] : 0;
        }),
        itemStyle: { color: COLOR[g] },
    }));

    dynamicChart.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        legend: { data: genders },
        grid: { left: '2%', right: '5%', bottom: '3%', top: '40px', containLabel: true },
        xAxis: { type: 'value', name: '件數' },
        yAxis: { type: 'category', data: causes, axisLabel: { fontSize: 11 } },
        series,
    });
    dynamicChart.resize();

    // 顯示篩選結果提示
    const resultEl  = document.getElementById('dynamic-result');
    const monthText  = monthFilter  ? `${monthFilter} 月` : '全部月份';
    const genderText = genderFilter ? genderFilter + '性' : '全部性別';
    const total      = filtered.reduce((acc, d) => acc + d['件數'], 0);
    resultEl.textContent = `篩選條件：${monthText} × ${genderText}｜顯示件數合計：${total.toLocaleString()} 件`;
    resultEl.style.display = 'block';
}

// ══════════════════════════════════════════════
// 訂閱推播
// ══════════════════════════════════════════════
async function handleSubscribe() {
    const email  = document.getElementById('sub-email').value.trim();
    const result = document.getElementById('sub-result');
    const btn    = document.getElementById('sub-btn');

    if (!email || !email.includes('@')) {
        showSubResult('error', '⚠️ 請輸入有效的 Email 地址');
        return;
    }

    btn.disabled    = true;
    btn.textContent = '送出中...';

    try {
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
        document.getElementById('sub-email').value = '';
    } catch {
        showSubResult('error', '❌ 訂閱失敗，請稍後再試或聯絡管理員。');
    } finally {
        btn.disabled    = false;
        btn.textContent = '訂閱推播';
    }
}

function showSubResult(type, msg) {
    const el = document.getElementById('sub-result');
    el.className    = `sub-result ${type}`;
    el.textContent  = msg;
    el.style.display = 'block';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ══════════════════════════════════════════════
// 事件綁定
// ══════════════════════════════════════════════
function bindEvents() {
    document.getElementById('login-btn').addEventListener('click', openLoginModal);
    document.getElementById('cancel-login-btn').addEventListener('click', closeLoginModal);
    document.getElementById('logout-btn').addEventListener('click', doLogout);
    document.getElementById('do-login-btn').addEventListener('click', doLogin);
    document.getElementById('sub-btn').addEventListener('click', handleSubscribe);

    // Enter 鍵觸發登入
    ['login-email', 'login-password'].forEach(id => {
        document.getElementById(id).addEventListener('keydown', e => {
            if (e.key === 'Enter') doLogin();
        });
    });

    // 點擊遮罩背景關閉 Modal
    document.getElementById('login-modal').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeLoginModal();
    });

    // 動態查詢按鈕
    document.getElementById('query-btn').addEventListener('click', () => {
        const month  = document.getElementById('filter-month').value;
        const gender = document.getElementById('filter-gender').value;
        const btn    = document.getElementById('query-btn');

        btn.disabled    = true;
        btn.textContent = '⚡ 運算中...';

        // 模擬非同步 API 延遲（正式版替換為 fetch API Gateway）
        setTimeout(() => {
            renderDynamicChart(month, gender);
            btn.disabled    = false;
            btn.textContent = '⚡ 執行動態查詢';
        }, 400);
    });
}

// ══════════════════════════════════════════════
// 工具函數
// ══════════════════════════════════════════════
function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value ?? '--';
}

window.openLoginModal = openLoginModal;
window.closeLoginModal = closeLoginModal;
window.doLogin = doLogin;
window.doLogout = doLogout;

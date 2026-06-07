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
 * 修正日期：2026-06-07
 * 修正內容：
 *  ✅ 統一狀態管理到 TrafficSaaS.state（移除重複的全域變數）
 *  ✅ 修復月份資料類型不一致導致的比對失敗
 *  ✅ bindEvents 加入可選鏈操作符防禦
 *  ✅ renderDynamicChart ratio 邏輯優化
 *  ✅ markPoint 值提取優化
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

// ✅ 移除重複的全域變數（統一使用 TrafficSaaS.state）
// 舊代碼已刪除：
// let dashboardData = null;
// let isLoggedIn = false;
// let dynamicChart = null;
// let causeChart = null;
// let trendChart = null;

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
    TrafficSaaS.state.causeChart   = echarts.init(document.getElementById('cause-chart'));
    TrafficSaaS.state.trendChart   = echarts.init(document.getElementById('trend-chart'));
    TrafficSaaS.state.dynamicChart = echarts.init(document.getElementById('dynamic-chart'));

    window.addEventListener('resize', () => {
        TrafficSaaS.state.causeChart?.resize();
        TrafficSaaS.state.trendChart?.resize();
        TrafficSaaS.state.dynamicChart?.resize();
    });
}

// ── 從 dashboard_data.json 載入靜態資料 ──────────
async function loadData() {
    try {
        const res = await fetch('./dashboard_data.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        TrafficSaaS.state.dashboardData = await res.json();

        renderPublicStats();
        populateMonthFilter();
        checkDataWarnings();

    } catch (err) {
        const banner = document.getElementById('error-banner');
        if (banner) {
            banner.textContent = `⚠️ 資料載入失敗（${err.message}），請稍後重整頁面。`;
            banner.style.display = 'block';
        }
    }
}

// ── 渲染公開統計數字 ─────────────────────────────
function renderPublicStats() {
    const dashboardData = TrafficSaaS.state.dashboardData;
    if (!dashboardData) return;

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
    const dashboardData = TrafficSaaS.state.dashboardData;
    if (!dashboardData) return;

    const months = [...new Set(
        dashboardData.monthly_trend.map(d => d['月份'])
    )].sort((a, b) => a - b);

    const sel = document.getElementById('filter-month');
    if (!sel) return;

    months.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = `${m} 月`;
        sel.appendChild(opt);
    });
}

// ── 月份完整性警示 ────────────────────────────────
function checkDataWarnings() {
    const dashboardData = TrafficSaaS.state.dashboardData;
    if (!dashboardData) return;

    const incomplete = dashboardData.metadata.incomplete_months || [];
    if (incomplete.length > 0) {
        const tag = document.getElementById('monthly-warning');
        if (tag) {
            tag.textContent = `⚠️ ${incomplete.join('、')} 月資料不完整`;
            tag.style.display = 'inline-block';
        }
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
    const modal = document.getElementById('login-modal');
    if (modal) {
        modal.style.display = 'flex';
        setTimeout(() => {
            const emailInput = document.getElementById('login-email');
            emailInput?.focus();
        }, 50);
    }
}

function closeLoginModal() {
    const modal = document.getElementById('login-modal');
    const errorEl = document.getElementById('login-error');
    if (modal) modal.style.display = 'none';
    if (errorEl) errorEl.style.display = 'none';
}

/** Demo 登入：任何 email + 任意密碼 → 成功；格式錯誤 → 失敗 */
function doLogin() {
    const emailInput = document.getElementById('login-email');
    const passInput = document.getElementById('login-password');
    const errEl = document.getElementById('login-error');

    if (!emailInput || !passInput || !errEl) return;

    const email = emailInput.value.trim();
    const pass  = passInput.value;

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
    TrafficSaaS.state.isLoggedIn = true;

    // 更新導覽列
    const badge  = document.getElementById('user-status');
    if (badge) {
        badge.textContent = '🟢 會員已登入';
        badge.className   = 'user-badge member';
    }

    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    if (loginBtn) loginBtn.style.display  = 'none';
    if (logoutBtn) logoutBtn.style.display = 'inline-block';

    // 解除鎖定
    const section = document.getElementById('premium-section');
    if (section) {
        section.classList.remove('locked');
        section.classList.add('unlocked');
    }
}

function doLogout() {
    sessionStorage.removeItem(SESSION_KEY);
    TrafficSaaS.state.isLoggedIn = false;

    // 重設導覽列
    const badge = document.getElementById('user-status');
    if (badge) {
        badge.textContent = '🔴 訪客模式';
        badge.className   = 'user-badge guest';
    }

    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    if (loginBtn) loginBtn.style.display  = 'inline-block';
    if (logoutBtn) logoutBtn.style.display = 'none';

    // 重新上鎖
    const section = document.getElementById('premium-section');
    if (section) {
        section.classList.remove('unlocked');
        section.classList.add('locked');
    }
}

// ══════════════════════════════════════════════
// 圖表渲染
// ══════════════════════════════════════════════
const COLOR = { '男': '#3A86FF', '女': '#FF6B9D' };

// ── 肇因 TOP 15 長條圖 ────────────────────────
function renderCauseChart() {
    const dashboardData = TrafficSaaS.state.dashboardData;
    if (!dashboardData || !TrafficSaaS.state.causeChart) return;

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

    TrafficSaaS.state.causeChart.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        legend: { data: ['男', '女'] },
        grid: { left: '2%', right: '5%', bottom: '3%', top: '40px', containLabel: true },
        xAxis: { type: 'value', name: '件數' },
        yAxis: { type: 'category', data: causes, axisLabel: { fontSize: 11 } },
        series,
    });
    TrafficSaaS.state.causeChart.resize();
}

// ── 月份趨勢折線圖 ────────────────────────────
function renderTrendChart() {
    const dashboardData = TrafficSaaS.state.dashboardData;
    if (!dashboardData || !TrafficSaaS.state.trendChart) return;

    const raw      = dashboardData.monthly_trend;
    const months   = [1,2,3,4,5,6,7,8,9,10,11,12];
    const incomplete = dashboardData.metadata.incomplete_months || [];

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
            data: incomplete.map(m => {
                // ✅ 修復：提取 markPoint 值，確保資料一致性
                const markItem = raw.find(d => Number(d['月份']) === m && d['性別'] === '男');
                const markValue = markItem?.['件數'] ?? 0;
                return {
                    coord: [`${m}月`, markValue],
                    symbol: 'pin',
                    symbolSize: 28,
                    itemStyle: { color: '#f59e0b' },
                    label: { show: false },
                };
            }),
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
}

// ── 動態篩選圖表 ──────────────────────────────
/**
 * 依月份 + 性別篩選肇因資料並重繪。
 * ✅ 修復：
 *  1. 月份資料類型轉換（Number 比對）
 *  2. ratio 邏輯優化（0 值保護）
 * 正式版：改為 fetch(`${API_BASE_URL}/query?month=...&gender=...`,
 *              { headers: { Authorization: `Bearer ${token}` } })
 */
function renderDynamicChart(monthFilter = '', genderFilter = '') {
    const dashboardData = TrafficSaaS.state.dashboardData;
    if (!dashboardData || !TrafficSaaS.state.dynamicChart) return;

    let raw = [...dashboardData.cause_data];

    // ✅ 月份篩選（修復：資料類型轉換）
    // 注意：cause_data 不含月份欄位，這裡用 monthly_trend 的件數比例模擬動態效果
    if (monthFilter) {
        const monthNum = Number(monthFilter);
        const totalByMonth = dashboardData.monthly_trend
            .filter(d => Number(d['月份']) === monthNum)
            .reduce((acc, d) => acc + d['件數'], 0);
        const totalAll = dashboardData.monthly_trend
            .reduce((acc, d) => acc + d['件數'], 0);

        // ✅ 修復：ratio 邏輯優化（0 值保護）
        const ratio = (totalAll > 0 && totalByMonth > 0)
            ? totalByMonth / totalAll
            : 1;

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
    const resultEl  = document.getElementById('dynamic-result');
    if (resultEl) {
        const monthText  = monthFilter  ? `${monthFilter} 月` : '全部月份';
        const genderText = genderFilter ? genderFilter + '性' : '全部性別';
        const total      = filtered.reduce((acc, d) => acc + d['件數'], 0);
        resultEl.textContent = `篩選條件：${monthText} × ${genderText}｜顯示件數合計：${total.toLocaleString()} 件`;
        resultEl.style.display = 'block';
    }
}

// ══════════════════════════════════════════════
// 訂閱推播
// ══════════════════════════════════════════════
async function handleSubscribe() {
    const emailInput = document.getElementById('sub-email');
    const btn = document.getElementById('sub-btn');

    if (!emailInput || !btn) return;

    const email = emailInput.value.trim();

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
        emailInput.value = '';
    } catch {
        showSubResult('error', '❌ 訂閱失敗，請稍後再試或聯絡管理員。');
    } finally {
        btn.disabled    = false;
        btn.textContent = '訂閱推播';
    }
}

function showSubResult(type, msg) {
    const el = document.getElementById('sub-result');
    if (!el) return;

    el.className    = `sub-result ${type}`;
    el.textContent  = msg;
    el.style.display = 'block';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ══════════════════════════════════════════════
// 事件綁定
// ══════════════════════════════════════════════
function bindEvents() {
    // ✅ 修復：加入可選鏈操作符（?.）防禦 null 錯誤
    document.getElementById('login-btn')?.addEventListener('click', openLoginModal);
    document.getElementById('cancel-login-btn')?.addEventListener('click', closeLoginModal);
    document.getElementById('logout-btn')?.addEventListener('click', doLogout);
    document.getElementById('do-login-btn')?.addEventListener('click', doLogin);
    document.getElementById('sub-btn')?.addEventListener('click', handleSubscribe);

    // Enter 鍵觸發登入
    ['login-email', 'login-password'].forEach(id => {
        document.getElementById(id)?.addEventListener('keydown', e => {
            if (e.key === 'Enter') doLogin();
        });
    });

    // 點擊遮罩背景關閉 Modal
    const loginModal = document.getElementById('login-modal');
    loginModal?.addEventListener('click', e => {
        if (e.target === e.currentTarget) closeLoginModal();
    });

    // 動態查詢按鈕
    const queryBtn = document.getElementById('query-btn');
    queryBtn?.addEventListener('click', () => {
        const monthSelect = document.getElementById('filter-month');
        const genderSelect = document.getElementById('filter-gender');

        if (!monthSelect || !genderSelect || !queryBtn) return;

        const month  = monthSelect.value;
        const gender = genderSelect.value;

        queryBtn.disabled    = true;
        queryBtn.textContent = '⚡ 運算中...';

        // 模擬非同步 API 延遲（正式版替換為 fetch API Gateway）
        setTimeout(() => {
            renderDynamicChart(month, gender);
            queryBtn.disabled    = false;
            queryBtn.textContent = '⚡ 執行動態查詢';
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

// 暴露全域函數（供 HTML 內嵌事件使用）
window.openLoginModal = openLoginModal;
window.closeLoginModal = closeLoginModal;
window.doLogin = doLogin;
window.doLogout = doLogout;

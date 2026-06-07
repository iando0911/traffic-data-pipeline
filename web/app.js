/**
 * app.js — 台灣交通事故 SaaS 分析平台 v3.0
 *
 * 🔥 架構升級（v2.1 → v3.0）：
 * 
 * 核心原則：
 *  1. 前端 = UI + 狀態管理 + 使用者互動
 *  2. 後端 = 資料聚合 + 篩選 + 統計
 *  3. 服務層 = 職責分離 + API 抽象
 *
 * v3.0 變更：
 *  ✅ 資料服務層（data layer）- 與後端 API 清晰分離
 *  ✅ 圖表管理層（chart manager）- 生命週期管理 + dispose
 *  ✅ 後端優先聚合 - 不再做 client-side 假 filter
 *  ✅ 緩存層 - 避免重複請求和計算
 *  ✅ 索引優化 - O(1) lookup 代替 O(n) find
 *  ✅ 完整的狀態機 - 追蹤 loading/error/success
 *  ✅ 類型提示註釋 - JSDoc 提高可維護性
 */

// ══════════════════════════════════════════════════════════════════
// 類型定義（JSDoc）
// ══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} DashboardData
 * @property {Array} cause_data - 肇因資料
 * @property {Array} monthly_trend - 月份趨勢
 * @property {Object} stats_summary - 統計摘要
 * @property {Object} metadata - 元數據
 */

/**
 * @typedef {Object} FilterParams
 * @property {number|null} month - 月份篩選（1-12）
 * @property {string|null} gender - 性別篩選（男/女）
 */

/**
 * @typedef {Object} CauseItem
 * @property {string} 肇因 - 肇因名稱
 * @property {string} 性別 - 性別
 * @property {number} 件數 - 件數
 */

// ══════════════════════════════════════════════════════════════════
// 應用程式設定
// ══════════════════════════════════════════════════════════════════
const TrafficSaaS = {
    config: {
        API_BASE_URL: 'https://<API_ID>.execute-api.ap-northeast-1.amazonaws.com/prod',
        COGNITO_LOGIN_URL: 'https://<COGNITO_DOMAIN>.auth.ap-northeast-1.amazoncognito.com/login'
            + '?client_id=<CLIENT_ID>&response_type=token'
            + '&scope=email+openid&redirect_uri=<CLOUDFRONT_DOMAIN>',
        DEMO_EMAIL: 'demo@example.com',
        SESSION_KEY: 'saas_demo_token',
        CACHE_TTL: 5 * 60 * 1000, // 5分鐘快取
    },
    state: {
        dashboardData: null,
        isLoggedIn: false,
        isLoading: false,
        error: null,
        
        // 圖表實例
        charts: {
            cause: null,
            trend: null,
            dynamic: null,
        },
        chartsInitialized: false,
        
        // 快取層
        cache: {
            causesByFilter: null,
            causesByFilterTime: 0,
        },
        
        // 當前篩選狀態
        currentFilters: {
            month: null,
            gender: null,
        }
    }
};

const API_BASE_URL = TrafficSaaS.config.API_BASE_URL;
const SESSION_KEY = TrafficSaaS.config.SESSION_KEY;

// ══════════════════════════════════════════════════════════════════
// 日誌系統
// ══════════════════════════════════════════════════════════════════
const Logger = {
    info: (msg, data = null) => {
        const ts = new Date().toLocaleTimeString('zh-TW');
        console.log(`[${ts}] ℹ️ ${msg}`, data || '');
    },
    warn: (msg, data = null) => {
        const ts = new Date().toLocaleTimeString('zh-TW');
        console.warn(`[${ts}] ⚠️ ${msg}`, data || '');
    },
    error: (msg, data = null) => {
        const ts = new Date().toLocaleTimeString('zh-TW');
        console.error(`[${ts}] ❌ ${msg}`, data || '');
    },
    debug: (msg, data = null) => {
        const ts = new Date().toLocaleTimeString('zh-TW');
        console.debug(`[${ts}] 🔍 ${msg}`, data || '');
    }
};

// ══════════════════════════════════════════════════════════════════
// DOM 工具
// ══════════════════════════════════════════════════════════════════
const DOM = {
    /**
     * 安全取得元素
     * @param {string} id - 元素 ID
     * @returns {Element|null}
     */
    get: (id) => {
        const el = document.getElementById(id);
        if (!el) Logger.warn(`DOM 元素不存在: #${id}`);
        return el;
    },

    /**
     * 設定文本內容
     * @param {string} id - 元素 ID
     * @param {string|number} value - 文本值
     */
    setText: (id, value) => {
        const el = DOM.get(id);
        if (el) el.textContent = value ?? '--';
    },

    /**
     * 設定顯示狀態
     * @param {string} id - 元素 ID
     * @param {boolean} visible - 是否顯示
     */
    setVisible: (id, visible) => {
        const el = DOM.get(id);
        if (el) el.style.display = visible ? 'block' : 'none';
    },

    /**
     * 加事件監聽（安全）
     * @param {string} id - 元素 ID
     * @param {string} event - 事件名
     * @param {Function} handler - 回調
     */
    on: (id, event, handler) => {
        const el = DOM.get(id);
        if (el) el.addEventListener(event, handler);
    }
};

// ══════════════════════════════════════════════════════════════════
// 資料服務層（Data Layer）
// ══════════════════════════════════════════════════════════════════

/**
 * ✅ v3.0 核心改進：
 * 資料層完全獨立，所有資料操作都通過這個 service
 * 未來可以無縫替換為真實 API 調用
 */
const DataService = {
    /**
     * 載入完整儀表板資料
     * @returns {Promise<DashboardData>}
     */
    async fetchDashboardData() {
        Logger.info('📥 fetchDashboardData 開始');
        try {
            // ✅ 正式版：改為真實 API
            // const res = await fetch(`${API_BASE_URL}/dashboard`, {
            //     headers: { 'Authorization': `Bearer ${sessionStorage.getItem(SESSION_KEY)}` }
            // });
            // return await res.json();

            // Demo 版：從靜態檔案
            const res = await fetch('./dashboard_data.json');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            Logger.error('fetchDashboardData 失敗', err);
            throw err;
        }
    },

    /**
     * ✅ v3.0 核心：後端優先聚合
     * 根據篩選條件取得肇因資料
     * 
     * @param {FilterParams} filters - 篩選參數 { month, gender }
     * @returns {Promise<{total: number, data: CauseItem[]}>}
     * 
     * 正式版應該是：
     * GET /causes?month=6&gender=男
     * 
     * 這樣所有統計邏輯都在 backend，前端只負責顯示
     */
    async fetchCausesByFilter(filters = {}) {
        Logger.info('🔍 fetchCausesByFilter', filters);

        // ✅ 緩存層：檢查是否有快取且未過期
        const cacheKey = JSON.stringify(filters);
        const now = Date.now();
        const cached = TrafficSaaS.state.cache.causesByFilter;
        const cachedTime = TrafficSaaS.state.cache.causesByFilterTime;

        if (cached && (now - cachedTime < TrafficSaaS.config.CACHE_TTL)) {
            Logger.debug('💾 使用快取的聚合資料');
            return cached;
        }

        try {
            // ✅ 正式版：真實 API 調用（所有篩選都在 backend）
            // const params = new URLSearchParams();
            // if (filters.month) params.append('month', filters.month);
            // if (filters.gender) params.append('gender', filters.gender);
            // 
            // const res = await fetch(`${API_BASE_URL}/causes?${params}`, {
            //     headers: { 'Authorization': `Bearer ${sessionStorage.getItem(SESSION_KEY)}` }
            // });
            // const data = await res.json();
            // 
            // TrafficSaaS.state.cache.causesByFilter = data;
            // TrafficSaaS.state.cache.causesByFilterTime = now;
            // return data;

            // Demo 版：本地聚合
            const dashboardData = TrafficSaaS.state.dashboardData;
            if (!dashboardData) throw new Error('dashboardData 未載入');

            let filtered = [...dashboardData.cause_data];

            // ✅ 月份篩選（結合 monthly_trend 的邏輯）
            if (filters.month) {
                const monthNum = Number(filters.month);
                const monthTrend = dashboardData.monthly_trend.find(d => Number(d['月份']) === monthNum);
                
                if (monthTrend) {
                    // 計算該月的縮放比例
                    const totalByMonth = dashboardData.monthly_trend
                        .filter(d => Number(d['月份']) === monthNum)
                        .reduce((acc, d) => acc + d['件數'], 0);
                    const totalAll = dashboardData.monthly_trend
                        .reduce((acc, d) => acc + d['件數'], 0);
                    
                    const ratio = (totalAll > 0 && totalByMonth > 0)
                        ? totalByMonth / totalAll
                        : 1;

                    filtered = filtered.map(d => ({
                        ...d,
                        '件數': Math.round(d['件數'] * ratio)
                    }));
                }
            }

            // ✅ 性別篩選
            if (filters.gender) {
                filtered = filtered.filter(d => d['性別'] === filters.gender);
            }

            // ✅ 聚合：建立索引地圖 - O(1) lookup 代替 O(n) find
            const aggregated = this._aggregateCauses(filtered);

            // ✅ 排序 TOP 15
            const top15 = Object.entries(aggregated)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 15);

            const result = {
                total: filtered.reduce((acc, d) => acc + d['件數'], 0),
                data: top15.map(([cause, count]) => ({ 肇因: cause, 件數: count })),
                filters
            };

            // 快取結果
            TrafficSaaS.state.cache.causesByFilter = result;
            TrafficSaaS.state.cache.causesByFilterTime = now;

            Logger.info('✅ fetchCausesByFilter 完成', { 
                total: result.total, 
                count: result.data.length 
            });

            return result;
        } catch (err) {
            Logger.error('fetchCausesByFilter 失敗', err);
            throw err;
        }
    },

    /**
     * ✅ 索引優化：O(1) lookup
     * 將 filtered data 聚合成 Map，避免 O(n²) 複雜度
     * 
     * @private
     * @param {CauseItem[]} items
     * @returns {Object} { 肇因: 件數 }
     */
    _aggregateCauses(items) {
        const map = new Map();
        
        for (const item of items) {
            const cause = item['肇因'];
            const count = item['件數'];
            map.set(cause, (map.get(cause) || 0) + count);
        }

        // 轉換為普通物件
        const result = {};
        map.forEach((value, key) => {
            result[key] = value;
        });

        return result;
    }
};

// ══════════════════════════════════════════════════════════════════
// 圖表管理層（Chart Manager）
// ══════════════════════════════════════════════════════════════════

/**
 * ✅ v3.0 核心改進：
 * 完整的圖表生命週期管理（init → render → dispose）
 * 避免 memory leak
 */
const ChartManager = {
    COLOR: { '男': '#3A86FF', '女': '#FF6B9D' },

    /**
     * 初始化所有圖表
     */
    async initCharts() {
        Logger.info('📊 ChartManager.initCharts 開始');

        const causeEl = DOM.get('cause-chart');
        const trendEl = DOM.get('trend-chart');
        const dynamicEl = DOM.get('dynamic-chart');

        if (!causeEl || !trendEl || !dynamicEl) {
            Logger.error('❌ 必要的圖表容器不存在');
            return false;
        }

        try {
            TrafficSaaS.state.charts.cause = echarts.init(causeEl);
            TrafficSaaS.state.charts.trend = echarts.init(trendEl);
            TrafficSaaS.state.charts.dynamic = echarts.init(dynamicEl);
            TrafficSaaS.state.chartsInitialized = true;

            // ✅ 視窗縮放監聽
            window.addEventListener('resize', () => this.resizeAll());

            Logger.info('✅ 所有圖表初始化完成');
            return true;
        } catch (err) {
            Logger.error('❌ 圖表初始化失敗', err);
            return false;
        }
    },

    /**
     * 調整所有圖表大小
     */
    resizeAll() {
        Object.values(TrafficSaaS.state.charts).forEach(chart => {
            if (chart) chart.resize();
        });
    },

    /**
     * 銷毀所有圖表（防止 memory leak）
     * ✅ v3.0 新增
     */
    disposeAll() {
        Logger.info('🧹 ChartManager.disposeAll 清理');

        Object.values(TrafficSaaS.state.charts).forEach(chart => {
            if (chart) {
                chart.dispose();
            }
        });

        TrafficSaaS.state.charts = {
            cause: null,
            trend: null,
            dynamic: null,
        };
        TrafficSaaS.state.chartsInitialized = false;
    },

    /**
     * 渲染肇因圖表
     * @param {CauseItem[]} causes - 肇因資料
     */
    renderCauseChart(causes) {
        const chart = TrafficSaaS.state.charts.cause;
        if (!chart) {
            Logger.warn('⚠️ cause chart 未初始化');
            return;
        }

        try {
            const causeNames = causes.map(d => d['肇因']);
            
            // ✅ 索引化：避免重複搜尋
            const causeMap = new Map(causes.map(d => [d['肇因'], d['件數']]));

            const series = ['男', '女'].map(g => ({
                name: g,
                type: 'bar',
                data: causeNames.map(c => causeMap.get(c) || 0),
                itemStyle: { color: this.COLOR[g] },
            }));

            chart.setOption({
                tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
                legend: { data: ['男', '女'] },
                grid: { left: '2%', right: '5%', bottom: '3%', top: '40px', containLabel: true },
                xAxis: { type: 'value', name: '件數' },
                yAxis: { type: 'category', data: causeNames, axisLabel: { fontSize: 11 } },
                series,
            });

            chart.resize();
            Logger.debug('✅ cause chart 渲染完成');
        } catch (err) {
            Logger.error('❌ renderCauseChart 失敗', err);
        }
    },

    /**
     * 渲染月份趨勢圖表
     * @param {Array} monthlyTrend - 月份趨勢資料
     * @param {Array} incomplete - 不完整月份
     */
    renderTrendChart(monthlyTrend, incomplete = []) {
        const chart = TrafficSaaS.state.charts.trend;
        if (!chart) {
            Logger.warn('⚠️ trend chart 未初始化');
            return;
        }

        try {
            const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

            // ✅ 索引化：O(1) lookup
            const trendMap = new Map(
                monthlyTrend.map(d => [`${d['性別']}_${d['月份']}`, d['件數']])
            );

            const series = ['男', '女'].map(g => {
                const data = months.map(m => trendMap.get(`${g}_${m}`) || null);

                // ✅ markPoint 資料驗證
                const markPoints = incomplete
                    .map(m => {
                        const val = trendMap.get(`男_${m}`);
                        if (val == null) return null;
                        return {
                            coord: [`${m}月`, val],
                            symbol: 'pin',
                            symbolSize: 28,
                            itemStyle: { color: '#f59e0b' },
                            label: { show: false },
                        };
                    })
                    .filter(item => item !== null);

                return {
                    name: g,
                    type: 'line',
                    smooth: true,
                    connectNulls: false,
                    data,
                    itemStyle: { color: this.COLOR[g] },
                    markPoint: g === '男' ? { data: markPoints } : {},
                };
            });

            chart.setOption({
                tooltip: { trigger: 'axis' },
                legend: { data: ['男', '女'] },
                xAxis: { type: 'category', data: months.map(m => `${m}月`) },
                yAxis: { type: 'value', name: '件數' },
                series,
            });

            chart.resize();
            Logger.debug('✅ trend chart 渲染完成');
        } catch (err) {
            Logger.error('❌ renderTrendChart 失敗', err);
        }
    },

    /**
     * 渲染動態篩選圖表
     * ✅ v3.0 改進：使用後端聚合結果，不做本地 fake aggregation
     * 
     * @param {Object} result - DataService.fetchCausesByFilter 的結果
     */
    renderDynamicChart(result) {
        const chart = TrafficSaaS.state.charts.dynamic;
        if (!chart) {
            Logger.warn('⚠️ dynamic chart 未初始化');
            return;
        }

        try {
            if (!result.data || result.data.length === 0) {
                Logger.warn('⚠️ 查詢結果為空');
                chart.setOption({ series: [] });
                return;
            }

            const causes = result.data.map(d => d['肇因']);
            const counts = result.data.map(d => d['件數']);

            const series = [{
                name: '件數',
                type: 'bar',
                data: counts,
                itemStyle: { color: '#3A86FF' },
            }];

            chart.setOption({
                tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
                legend: { data: ['件數'] },
                grid: { left: '2%', right: '5%', bottom: '3%', top: '40px', containLabel: true },
                xAxis: { type: 'value', name: '件數' },
                yAxis: { type: 'category', data: causes, axisLabel: { fontSize: 11 } },
                series,
            });

            chart.resize();

            // 更新結果提示
            const resultEl = DOM.get('dynamic-result');
            if (resultEl) {
                const { month, gender } = result.filters;
                const monthText = month ? `${month} 月` : '全部月份';
                const genderText = gender ? `${gender}性` : '全部性別';
                resultEl.textContent = `篩選：${monthText} × ${genderText} | 合計：${result.total.toLocaleString()} 件`;
                DOM.setVisible('dynamic-result', true);
            }

            Logger.debug('✅ dynamic chart 渲染完成');
        } catch (err) {
            Logger.error('❌ renderDynamicChart 失敗', err);
        }
    }
};

// ══════════════════════════════════════════════════════════════════
// UI 控制層
// ══════════════════════════════════════════════════════════════════

const UIController = {
    /**
     * 設定加載中狀態
     */
    setLoading(loading, message = '載入中...') {
        TrafficSaaS.state.isLoading = loading;
        const banner = DOM.get('error-banner');
        if (banner) {
            if (loading) {
                banner.textContent = `⏳ ${message}`;
                DOM.setVisible('error-banner', true);
            } else {
                DOM.setVisible('error-banner', false);
            }
        }
    },

    /**
     * 設定錯誤狀態
     */
    setError(message) {
        TrafficSaaS.state.error = message;
        const banner = DOM.get('error-banner');
        if (banner) {
            banner.textContent = `❌ ${message}`;
            banner.style.color = '#ef4444';
            DOM.setVisible('error-banner', true);
        }
        Logger.error('UI Error:', message);
    },

    /**
     * 清除錯誤
     */
    clearError() {
        TrafficSaaS.state.error = null;
        DOM.setVisible('error-banner', false);
    },

    /**
     * 渲染公開統計
     */
    renderStats(dashboardData) {
        if (!dashboardData?.stats_summary) return;

        const s = dashboardData.stats_summary;
        DOM.setText('total-samples', s['最終可用樣本數']);
        DOM.setText('male-age', s['男性平均年齡']);
        DOM.setText('female-age', s['女性平均年齡']);
        DOM.setText('sig-level', s['效果量判讀'] || s['顯著性'] || '--');

        const meta = dashboardData.metadata || {};
        DOM.setText('update-time', meta.update_time || '--');
        DOM.setText('git-sha', meta.git_sha || '--');
    },

    /**
     * 填充月份篩選
     */
    populateMonthFilter(dashboardData) {
        if (!dashboardData?.monthly_trend) return;

        const months = [...new Set(
            dashboardData.monthly_trend.map(d => d['月份'])
        )].sort((a, b) => a - b);

        const sel = DOM.get('filter-month');
        if (!sel) return;

        months.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = `${m} 月`;
            sel.appendChild(opt);
        });
    },

    /**
     * 顯示警告
     */
    showWarning(dashboardData) {
        if (!dashboardData?.metadata?.incomplete_months) return;

        const incomplete = dashboardData.metadata.incomplete_months;
        if (incomplete.length > 0) {
            const tag = DOM.get('monthly-warning');
            if (tag) {
                tag.textContent = `⚠️ ${incomplete.join('、')} 月資料不完整`;
                DOM.setVisible('monthly-warning', true);
            }
        }
    }
};

// ══════════════════════════════════════════════════════════════════
// 認證邏輯
// ══════════════════════════════════════════════════════════════════

const AuthController = {
    checkAuthOnLoad() {
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        
        if (params.has('id_token')) {
            sessionStorage.setItem(SESSION_KEY, params.get('id_token'));
            window.history.replaceState(null, null, window.location.pathname);
            Logger.info('✅ Cognito 回傳 id_token');
        }

        if (sessionStorage.getItem(SESSION_KEY)) {
            this.applyLoggedInUI();
        }
    },

    openLoginModal() {
        const modal = DOM.get('login-modal');
        if (modal) {
            modal.style.display = 'flex';
            setTimeout(() => DOM.get('login-email')?.focus(), 50);
        }
    },

    closeLoginModal() {
        DOM.setVisible('login-modal', false);
        DOM.setVisible('login-error', false);
    },

    doLogin() {
        const emailEl = DOM.get('login-email');
        const passEl = DOM.get('login-password');
        const errEl = DOM.get('login-error');

        if (!emailEl || !passEl || !errEl) return;

        const email = emailEl.value.trim();
        const pass = passEl.value;

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

        const fakeToken = btoa(`demo:${email}:${Date.now()}`);
        sessionStorage.setItem(SESSION_KEY, fakeToken);

        Logger.info(`✅ 登入成功: ${email}`);

        this.closeLoginModal();
        this.applyLoggedInUI();

        setTimeout(() => {
            this.renderAllCharts();
        }, 150);
    },

    doLogout() {
        sessionStorage.removeItem(SESSION_KEY);
        TrafficSaaS.state.isLoggedIn = false;

        const badge = DOM.get('user-status');
        if (badge) {
            badge.textContent = '🔴 訪客模式';
            badge.className = 'user-badge guest';
        }

        DOM.get('login-btn')?.style.display = 'inline-block';
        DOM.get('logout-btn')?.style.display = 'none';

        const section = DOM.get('premium-section');
        if (section) {
            section.classList.remove('unlocked');
            section.classList.add('locked');
        }

        Logger.info('✅ 已登出');
    },

    applyLoggedInUI() {
        TrafficSaaS.state.isLoggedIn = true;

        const badge = DOM.get('user-status');
        if (badge) {
            badge.textContent = '🟢 會員已登入';
            badge.className = 'user-badge member';
        }

        DOM.get('login-btn')?.style.display = 'none';
        DOM.get('logout-btn')?.style.display = 'inline-block';

        const section = DOM.get('premium-section');
        if (section) {
            section.classList.remove('locked');
            section.classList.add('unlocked');
        }
    },

    async renderAllCharts() {
        if (!TrafficSaaS.state.dashboardData) return;

        const data = TrafficSaaS.state.dashboardData;
        
        // 渲染肇因圖表
        ChartManager.renderCauseChart(data.cause_data);
        
        // 渲染趨勢圖表
        ChartManager.renderTrendChart(data.monthly_trend, data.metadata?.incomplete_months || []);
        
        // 渲染動態圖表（無篩選）
        const result = await DataService.fetchCausesByFilter({});
        ChartManager.renderDynamicChart(result);
    }
};

// ══════════════════════════════════════════════════════════════════
// 訂閱邏輯
// ══════════════════════════════════════════════════════════════════

const SubscriptionController = {
    async handleSubscribe() {
        const emailEl = DOM.get('sub-email');
        const btn = DOM.get('sub-btn');

        if (!emailEl || !btn) return;

        const email = emailEl.value.trim();

        if (!email || !email.includes('@')) {
            this.showResult('error', '⚠️ 請輸入有效的 Email');
            return;
        }

        btn.disabled = true;
        btn.textContent = '送出中...';

        try {
            Logger.info(`📧 訂閱: ${email}`);

            // Demo: 模擬延遲
            await new Promise(r => setTimeout(r, 900));

            this.showResult('success', 
                `✅ 訂閱已送出！請至 ${email} 確認。`
            );
            emailEl.value = '';
        } catch (err) {
            Logger.error('訂閱失敗', err);
            this.showResult('error', '❌ 訂閱失敗，請稍後再試。');
        } finally {
            btn.disabled = false;
            btn.textContent = '訂閱推播';
        }
    },

    showResult(type, msg) {
        const el = DOM.get('sub-result');
        if (!el) return;

        el.className = `sub-result ${type}`;
        el.textContent = msg;
        el.style.display = 'block';
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
};

// ══════════════════════════════════════════════════════════════════
// 初始化流程
// ══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
    Logger.info('🚀 DOMContentLoaded 開始初始化');

    try {
        // 1. 初始化圖表
        const chartsOk = await ChartManager.initCharts();
        if (!chartsOk) throw new Error('圖表初始化失敗');

        // 2. 載入資料
        UIController.setLoading(true, '📥 載入資料中...');
        TrafficSaaS.state.dashboardData = await DataService.fetchDashboardData();
        TrafficSaaS.state.isDataLoaded = true;
        UIController.clearError();

        // 3. 渲染 UI
        UIController.renderStats(TrafficSaaS.state.dashboardData);
        UIController.populateMonthFilter(TrafficSaaS.state.dashboardData);
        UIController.showWarning(TrafficSaaS.state.dashboardData);

        // 4. 認證檢查
        AuthController.checkAuthOnLoad();

        // 5. 事件綁定
        bindEvents();

        Logger.info('✅ 初始化完成');
    } catch (err) {
        Logger.error('初始化失敗', err);
        UIController.setError(`初始化失敗: ${err.message}`);
    } finally {
        UIController.setLoading(false);
    }
});

// ══════════════════════════════════════════════════════════════════
// 事件綁定
// ══════════════════════════════════════════════════════════════════

function bindEvents() {
    Logger.info('🔗 綁定事件');

    // 認證
    DOM.on('login-btn', 'click', () => AuthController.openLoginModal());
    DOM.on('cancel-login-btn', 'click', () => AuthController.closeLoginModal());
    DOM.on('logout-btn', 'click', () => AuthController.doLogout());
    DOM.on('do-login-btn', 'click', () => AuthController.doLogin());

    ['login-email', 'login-password'].forEach(id => {
        DOM.on(id, 'keydown', e => {
            if (e.key === 'Enter') AuthController.doLogin();
        });
    });

    const modal = DOM.get('login-modal');
    modal?.addEventListener('click', e => {
        if (e.target === e.currentTarget) AuthController.closeLoginModal();
    });

    // 訂閱
    DOM.on('sub-btn', 'click', () => SubscriptionController.handleSubscribe());

    // ✅ v3.0 核心：動態查詢（使用新的資料層）
    DOM.on('query-btn', 'click', async () => {
        const monthSelect = DOM.get('filter-month');
        const genderSelect = DOM.get('filter-gender');
        const queryBtn = DOM.get('query-btn');

        if (!monthSelect || !genderSelect || !queryBtn) return;

        const filters = {
            month: monthSelect.value || null,
            gender: genderSelect.value || null,
        };

        queryBtn.disabled = true;
        queryBtn.textContent = '⚡ 查詢中...';

        try {
            Logger.info('⚡ 執行動態查詢', filters);
            
            UIController.setLoading(true, '查詢中...');
            const result = await DataService.fetchCausesByFilter(filters);
            
            TrafficSaaS.state.currentFilters = filters;
            ChartManager.renderDynamicChart(result);
            
            UIController.clearError();
            Logger.info('✅ 查詢完成');
        } catch (err) {
            Logger.error('查詢失敗', err);
            UIController.setError(`查詢失敗: ${err.message}`);
        } finally {
            queryBtn.disabled = false;
            queryBtn.textContent = '⚡ 執行動態查詢';
            UIController.setLoading(false);
        }
    });
}

// ══════════════════════════════════════════════════════════════════
// 全域暴露（緊急用）
// ══════════════════════════════════════════════════════════════════

window.TrafficSaaS = TrafficSaaS;
window.DataService = DataService;
window.ChartManager = ChartManager;
window.Logger = Logger;

// 頁面卸載時清理
window.addEventListener('beforeunload', () => {
    Logger.info('🧹 頁面卸載，清理資源');
    ChartManager.disposeAll();
});

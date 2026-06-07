/**
 * app.js — 台灣交通事故 SaaS 分析平台 v3.2
 *
 * 🎯 最終架構升級（v3.1 → v3.2）：
 * 
 * 核心理念：
 *  ✅ 單一 State Source（TrafficSaaS.state）
 *  ✅ Reactive UI Binding（state change → auto UI update）
 *  ✅ Service 層拆分（減少 AppController 耦合）
 *  ✅ Stateless Renderer（ChartManager）
 *  ✅ Cache Key Normalize（避免 miss）
 *  ✅ Error Bus（集中式錯誤管理）
 * 
 * 設計原則：
 *  1. TrafficSaaS.state = 唯一 source of truth
 *  2. Service 層 = pure business logic（無副作用）
 *  3. AppController = 輕量 orchestrator（只做協調）
 *  4. Reactive 系統 = state change auto trigger UI
 */

// ══════════════════════════════════════════════════════════════════
// 類型定義
// ══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} AppState
 * @property {Object} data - 資料層
 * @property {Object} ui - UI 狀態
 * @property {Object} cache - 快取
 */

// ══════════════════════════════════════════════════════════════════
// ✅ 唯一 State Store（Single Source of Truth）
// ══════════════════════════════════════════════════════════════════

const TrafficSaaS = {
    config: {
        API_BASE_URL: 'https://<API_ID>.execute-api.ap-northeast-1.amazonaws.com/prod',
        SESSION_KEY: 'saas_demo_token',
        CACHE_TTL: 5 * 60 * 1000,
        MAX_RETRIES: 3,
        RETRY_DELAY: 1000,
    },

    /**
     * ✅ v3.2 核心：單一 state owner
     * 所有狀態都在這裡
     */
    state: {
        // 資料層
        data: {
            dashboard: null,
            isDataLoaded: false,
        },

        // 認證層
        auth: {
            isLoggedIn: false,
            token: null,
        },

        // UI 層
        ui: {
            loading: false,
            error: null,
            chartsInitialized: false,
            charts: { cause: null, trend: null, dynamic: null },
        },

        // 篩選層
        filters: {
            current: { month: null, gender: null },
            history: [],
        },

        // 快取層
        cache: new Map(),

        // 連接狀態
        connectivity: {
            isOnline: navigator.onLine,
            lastOnlineTime: Date.now(),
        },
    },

    // ✅ Reactive 訂閱系統
    subscribers: new Map(),

    /**
     * ✅ 訂閱狀態變化
     * @param {string} path - 狀態路徑 e.g., 'ui.error', 'filters.current'
     * @param {Function} callback - 回調函數
     * @returns {Function} 取消訂閱函數
     */
    subscribe(path, callback) {
        if (!this.subscribers.has(path)) {
            this.subscribers.set(path, []);
        }
        this.subscribers.get(path).push(callback);

        // 返回取消訂閱函數
        return () => {
            const callbacks = this.subscribers.get(path);
            const index = callbacks.indexOf(callback);
            if (index > -1) callbacks.splice(index, 1);
        };
    },

    /**
     * ✅ 發布狀態變化（自動觸發訂閱者）
     * @param {string} path - 狀態路徑
     * @param {*} value - 新值
     */
    publish(path, value) {
        // 更新狀態
        const keys = path.split('.');
        let current = this.state;
        for (let i = 0; i < keys.length - 1; i++) {
            current = current[keys[i]];
        }
        current[keys[keys.length - 1]] = value;

        // 通知訂閱者
        if (this.subscribers.has(path)) {
            this.subscribers.get(path).forEach(cb => {
                try {
                    cb(value);
                } catch (err) {
                    Logger.error(`訂閱回調錯誤 (${path})`, err);
                }
            });
        }

        Logger.debug(`📢 State Changed: ${path}`, value);
    }
};

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
// ✅ Error Bus（集中式錯誤管理）
// ══════════════════════════════════════════════════════════════════

const ErrorBus = {
    handlers: [],

    /**
     * 訂閱錯誤事件
     */
    on(handler) {
        this.handlers.push(handler);
        return () => {
            this.handlers = this.handlers.filter(h => h !== handler);
        };
    },

    /**
     * 發出錯誤
     */
    emit(error, options = {}) {
        const isCritical = options.critical || false;
        const duration = options.duration || 5000;

        Logger.error(error);

        const errorObj = {
            message: error,
            timestamp: Date.now(),
            critical: isCritical,
            duration,
        };

        // 發布到狀態系統
        TrafficSaaS.publish('ui.error', errorObj);

        // 通知所有 error handler
        this.handlers.forEach(handler => {
            try {
                handler(errorObj);
            } catch (err) {
                Logger.error('Error handler 失敗', err);
            }
        });

        // 非 critical 錯誤自動清除
        if (!isCritical && duration > 0) {
            setTimeout(() => {
                if (TrafficSaaS.state.ui.error === errorObj) {
                    TrafficSaaS.publish('ui.error', null);
                }
            }, duration);
        }
    }
};

// ══════════════════════════════════════════════════════════════════
// DOM 工具
// ══════════════════════════════════════════════════════════════════
const DOM = {
    get: (id) => {
        const el = document.getElementById(id);
        if (!el) Logger.warn(`DOM 元素不存在: #${id}`);
        return el;
    },

    setText: (id, value) => {
        const el = DOM.get(id);
        if (el) el.textContent = value ?? '--';
    },

    setVisible: (id, visible) => {
        const el = DOM.get(id);
        if (el) el.style.display = visible ? 'block' : 'none';
    },

    on: (id, event, handler) => {
        const el = DOM.get(id);
        if (el) {
            el.addEventListener(event, handler);
            return () => el.removeEventListener(event, handler);
        }
        return () => {};
    },

    batch: (updates) => {
        requestAnimationFrame(() => {
            updates.forEach(({ id, text }) => DOM.setText(id, text));
        });
    }
};

// ══════════════════════════════════════════════════════════════════
// ✅ API Client（純 API 層，無 state）
// ══════════════════════════════════════════════════════════════════

const APIClient = {
    async request(endpoint, options = {}, retries = 0) {
        try {
            if (!navigator.onLine) {
                throw new Error('❌ 離線狀態');
            }

            const url = `${TrafficSaaS.config.API_BASE_URL}${endpoint}`;
            const token = sessionStorage.getItem(TrafficSaaS.config.SESSION_KEY);

            const res = await fetch(url, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...(token && { 'Authorization': `Bearer ${token}` }),
                    ...options.headers,
                }
            });

            if (!res.ok) {
                if (res.status === 401) {
                    ErrorBus.emit('登入已過期，請重新登入', { critical: true });
                }
                throw new Error(`HTTP ${res.status}`);
            }

            return await res.json();
        } catch (err) {
            if (retries < TrafficSaaS.config.MAX_RETRIES) {
                Logger.warn(`🔄 重試 (${retries + 1}/${TrafficSaaS.config.MAX_RETRIES})`);
                await new Promise(r => setTimeout(r, TrafficSaaS.config.RETRY_DELAY));
                return this.request(endpoint, options, retries + 1);
            }

            throw err;
        }
    },

    async getDashboard() {
        // ✅ 正式版：return this.request('/dashboard');
        const res = await fetch('./dashboard_data.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    },

    async getCausesByFilter(filters = {}) {
        // ✅ 正式版：
        // const params = new URLSearchParams();
        // if (filters.month) params.append('month', filters.month);
        // if (filters.gender) params.append('gender', filters.gender);
        // return this.request(`/causes?${params}`);

        // Demo 版本地聚合
        const dashboardData = TrafficSaaS.state.data.dashboard;
        if (!dashboardData) throw new Error('dashboardData 未載入');

        let filtered = [...dashboardData.cause_data];

        if (filters.month) {
            const monthNum = Number(filters.month);
            const totalByMonth = dashboardData.monthly_trend
                .filter(d => Number(d['月份']) === monthNum)
                .reduce((acc, d) => acc + d['件數'], 0);
            const totalAll = dashboardData.monthly_trend.reduce((acc, d) => acc + d['件數'], 0);
            const ratio = (totalAll > 0 && totalByMonth > 0) ? totalByMonth / totalAll : 1;
            filtered = filtered.map(d => ({ ...d, '件數': Math.round(d['件數'] * ratio) }));
        }

        if (filters.gender) {
            filtered = filtered.filter(d => d['性別'] === filters.gender);
        }

        const aggregated = this._aggregate(filtered);
        const top15 = Object.entries(aggregated).sort((a, b) => b[1] - a[1]).slice(0, 15);

        return {
            total: filtered.reduce((acc, d) => acc + d['件數'], 0),
            data: top15.map(([cause, count]) => ({ 肇因: cause, 件數: count })),
            filters
        };
    },

    async subscribe(email) {
        // ✅ 正式版：return this.request('/subscribe', { method: 'POST', body: JSON.stringify({ email }) });
        await new Promise(r => setTimeout(r, 900));
        return { success: true };
    },

    _aggregate(items) {
        const map = new Map();
        for (const item of items) {
            map.set(item['肇因'], (map.get(item['肇因']) || 0) + item['件數']);
        }
        const result = {};
        map.forEach((value, key) => { result[key] = value; });
        return result;
    }
};

// ══════════════════════════════════════════════════════════════════
// ✅ Service 層拆分（減少 AppController 耦合）
// ══════════════════════════════════════════════════════════════════

/**
 * ✅ 認證服務
 */
const AuthService = {
    async login(email, password) {
        Logger.info('🔐 登入中', { email });

        // 驗證
        if (!email || !email.includes('@') || !password) {
            throw new Error('Email 或密碼無效');
        }

        // Demo：生成 token
        const fakeToken = btoa(`demo:${email}:${Date.now()}`);
        sessionStorage.setItem(TrafficSaaS.config.SESSION_KEY, fakeToken);

        TrafficSaaS.publish('auth.token', fakeToken);
        TrafficSaaS.publish('auth.isLoggedIn', true);

        Logger.info('✅ 登入成功');
    },

    async logout() {
        Logger.info('🚪 登出中');

        sessionStorage.removeItem(TrafficSaaS.config.SESSION_KEY);

        TrafficSaaS.publish('auth.token', null);
        TrafficSaaS.publish('auth.isLoggedIn', false);

        Logger.info('✅ 已登出');
    },

    checkAuthOnLoad() {
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);

        if (params.has('id_token')) {
            sessionStorage.setItem(TrafficSaaS.config.SESSION_KEY, params.get('id_token'));
            window.history.replaceState(null, null, window.location.pathname);
        }

        if (sessionStorage.getItem(TrafficSaaS.config.SESSION_KEY)) {
            TrafficSaaS.publish('auth.isLoggedIn', true);
        }
    }
};

/**
 * ✅ 儀表板服務
 */
const DashboardService = {
    async loadDashboard() {
        Logger.info('📥 載入儀表板');

        TrafficSaaS.publish('ui.loading', true);

        try {
            const data = await APIClient.getDashboard();
            TrafficSaaS.publish('data.dashboard', data);
            TrafficSaaS.publish('data.isDataLoaded', true);
            Logger.info('✅ 儀表板載入完成');
        } catch (err) {
            ErrorBus.emit(`儀表板載入失敗: ${err.message}`);
            throw err;
        } finally {
            TrafficSaaS.publish('ui.loading', false);
        }
    },

    /**
     * ✅ 改進的快取機制（normalize key）
     */
    async applyFilters(month = null, gender = null) {
        Logger.info('⚡ 執行查詢', { month, gender });

        TrafficSaaS.publish('ui.loading', true);

        try {
            const filters = { month, gender };

            // ✅ Normalize cache key
            const cacheKey = `m:${filters.month ?? 'all'}|g:${filters.gender ?? 'all'}`;
            const now = Date.now();
            const cached = TrafficSaaS.state.cache.get(cacheKey);

            if (cached && (now - cached.time < TrafficSaaS.config.CACHE_TTL)) {
                Logger.debug('💾 使用快取');
                TrafficSaaS.publish('filters.current', filters);
                return cached.data;
            }

            // 取得新資料
            const result = await APIClient.getCausesByFilter(filters);

            // 存入快取
            TrafficSaaS.state.cache.set(cacheKey, { data: result, time: now });

            TrafficSaaS.publish('filters.current', filters);

            return result;
        } catch (err) {
            ErrorBus.emit(`查詢失敗: ${err.message}`);
            throw err;
        } finally {
            TrafficSaaS.publish('ui.loading', false);
        }
    }
};

/**
 * ✅ UI 服務
 */
const UIService = {
    renderStats(dashboardData) {
        if (!dashboardData?.stats_summary) return;

        const s = dashboardData.stats_summary;
        DOM.batch([
            { id: 'total-samples', text: s['最終可用樣本數'] },
            { id: 'male-age', text: s['男性平均年齡'] },
            { id: 'female-age', text: s['女性平均年齡'] },
            { id: 'update-time', text: dashboardData.metadata?.update_time || '--' },
            { id: 'git-sha', text: dashboardData.metadata?.git_sha || '--' },
        ]);
    },

    populateMonthFilter(dashboardData) {
        if (!dashboardData?.monthly_trend) return;

        const months = [...new Set(dashboardData.monthly_trend.map(d => d['月份']))]
            .sort((a, b) => a - b);

        const sel = DOM.get('filter-month');
        if (!sel) return;

        months.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = `${m} 月`;
            sel.appendChild(opt);
        });
    },

    showWarnings(dashboardData) {
        if (!dashboardData?.metadata?.incomplete_months) return;

        const incomplete = dashboardData.metadata.incomplete_months;
        if (incomplete.length > 0) {
            const tag = DOM.get('monthly-warning');
            if (tag) {
                tag.textContent = `⚠️ ${incomplete.join('、')} 月資料不完整`;
                DOM.setVisible('monthly-warning', true);
            }
        }
    },

    updateFilterResult(result) {
        const { month, gender } = result.filters;
        const monthText = month ? `${month} 月` : '全部月份';
        const genderText = gender ? `${gender}性` : '全部性別';

        const resultEl = DOM.get('dynamic-result');
        if (resultEl) {
            resultEl.textContent = `篩選：${monthText} × ${genderText} | 合計：${result.total.toLocaleString()} 件`;
            DOM.setVisible('dynamic-result', true);
        }
    }
};

// ══════════════════════════════════════════════════════════════════
// ✅ Stateless Chart Manager（純 renderer）
// ══════════════════════════════════════════════════════════════════

const ChartManager = {
    COLOR: { '男': '#3A86FF', '女': '#FF6B9D' },
    _resizeHandler: null,

    /**
     * 初始化圖表實例
     */
    async initCharts() {
        Logger.info('📊 初始化圖表');

        const causeEl = DOM.get('cause-chart');
        const trendEl = DOM.get('trend-chart');
        const dynamicEl = DOM.get('dynamic-chart');

        if (!causeEl || !trendEl || !dynamicEl) {
            throw new Error('圖表容器不存在');
        }

        TrafficSaaS.state.ui.charts.cause = echarts.init(causeEl);
        TrafficSaaS.state.ui.charts.trend = echarts.init(trendEl);
        TrafficSaaS.state.ui.charts.dynamic = echarts.init(dynamicEl);

        this._resizeHandler = () => this.resizeAll();
        window.addEventListener('resize', this._resizeHandler);

        TrafficSaaS.publish('ui.chartsInitialized', true);

        Logger.info('✅ 圖表初始化完成');
    },

    resizeAll() {
        Object.values(TrafficSaaS.state.ui.charts).forEach(chart => {
            if (chart) chart.resize();
        });
    },

    /**
     * 完整清理
     */
    disposeAll() {
        Logger.info('🧹 清理圖表');

        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
        }

        Object.values(TrafficSaaS.state.ui.charts).forEach(chart => {
            if (chart) chart.dispose();
        });

        TrafficSaaS.publish('ui.charts', { cause: null, trend: null, dynamic: null });
        TrafficSaaS.publish('ui.chartsInitialized', false);
    },

    /**
     * ✅ Stateless render：接收 data，無副作用
     */
    renderCauseChart(causes) {
        const chart = TrafficSaaS.state.ui.charts.cause;
        if (!chart) return;

        const causeNames = causes.map(d => d['肇因']);
        const causeMap = new Map(causes.map(d => [d['肇因'], d['件數']]));

        chart.setOption({
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            legend: { data: ['男', '女'] },
            grid: { left: '2%', right: '5%', bottom: '3%', top: '40px', containLabel: true },
            xAxis: { type: 'value', name: '件數' },
            yAxis: { type: 'category', data: causeNames, axisLabel: { fontSize: 11 } },
            series: ['男', '女'].map(g => ({
                name: g,
                type: 'bar',
                data: causeNames.map(c => causeMap.get(c) || 0),
                itemStyle: { color: this.COLOR[g] },
            })),
        });

        chart.resize();
    },

    renderTrendChart(monthlyTrend, incomplete = []) {
        const chart = TrafficSaaS.state.ui.charts.trend;
        if (!chart) return;

        const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        const trendMap = new Map(
            monthlyTrend.map(d => [`${d['性別']}_${d['月份']}`, d['件數']])
        );

        chart.setOption({
            tooltip: { trigger: 'axis' },
            legend: { data: ['男', '女'] },
            xAxis: { type: 'category', data: months.map(m => `${m}月`) },
            yAxis: { type: 'value', name: '件數' },
            series: ['男', '女'].map(g => {
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
                    data: months.map(m => trendMap.get(`${g}_${m}`) || null),
                    itemStyle: { color: this.COLOR[g] },
                    markPoint: g === '男' ? { data: markPoints } : {},
                };
            }),
        });

        chart.resize();
    },

    renderDynamicChart(result) {
        const chart = TrafficSaaS.state.ui.charts.dynamic;
        if (!chart) return;

        if (!result.data || result.data.length === 0) {
            chart.setOption({ series: [] });
            return;
        }

        const causes = result.data.map(d => d['肇因']);
        const counts = result.data.map(d => d['件數']);

        chart.setOption({
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            grid: { left: '2%', right: '5%', bottom: '3%', top: '40px', containLabel: true },
            xAxis: { type: 'value', name: '件數' },
            yAxis: { type: 'category', data: causes, axisLabel: { fontSize: 11 } },
            series: [{
                name: '件數',
                type: 'bar',
                data: counts,
                itemStyle: { color: '#3A86FF' },
            }],
        });

        chart.resize();
    }
};

// ══════════════════════════════════════════════════════════════════
// ✅ 輕量 AppController（純 orchestrator）
// ══════════════════════════════════════════════════════════════════

const AppController = {
    _eventListeners: [],

    /**
     * 應用初始化
     */
    async init() {
        Logger.info('🚀 應用初始化');

        try {
            // 1. 初始化圖表
            await ChartManager.initCharts();

            // 2. 載入資料
            await DashboardService.loadDashboard();

            // 3. 檢查認證
            AuthService.checkAuthOnLoad();

            // 4. 綁定事件
            this.bindEvents();

            // 5. 線上狀態監聽
            this.setupConnectivityListeners();

            // 6. 設置 reactive 訂閱
            this.setupReactiveBindings();

            Logger.info('✅ 應用初始化完成');
        } catch (err) {
            ErrorBus.emit(`初始化失敗: ${err.message}`, { critical: true });
        }
    },

    /**
     * ✅ Reactive UI Binding（state change auto update）
     */
    setupReactiveBindings() {
        Logger.info('📡 設置 reactive 綁定');

        // 資料變化 → 更新 UI
        TrafficSaaS.subscribe('data.dashboard', (data) => {
            if (data) {
                UIService.renderStats(data);
                UIService.populateMonthFilter(data);
                UIService.showWarnings(data);

                // 重新渲染圖表
                ChartManager.renderCauseChart(data.cause_data);
                ChartManager.renderTrendChart(data.monthly_trend, data.metadata?.incomplete_months || []);
            }
        });

        // UI 狀態變化 → 更新 loading 指示器
        TrafficSaaS.subscribe('ui.loading', (loading) => {
            if (loading) {
                const banner = DOM.get('error-banner');
                if (banner) {
                    banner.textContent = '⏳ 載入中...';
                    banner.style.color = '#3b82f6';
                    DOM.setVisible('error-banner', true);
                }
            }
        });

        // 錯誤狀態變化 → 顯示錯誤
        TrafficSaaS.subscribe('ui.error', (error) => {
            if (error) {
                const banner = DOM.get('error-banner');
                if (banner) {
                    banner.textContent = `❌ ${error.message}`;
                    banner.style.color = error.critical ? '#dc2626' : '#ef4444';
                    DOM.setVisible('error-banner', true);
                }
            } else {
                DOM.setVisible('error-banner', false);
            }
        });

        // 認證狀態變化 → 更新 UI
        TrafficSaaS.subscribe('auth.isLoggedIn', (isLoggedIn) => {
            const badge = DOM.get('user-status');
            if (badge) {
                if (isLoggedIn) {
                    badge.textContent = '🟢 會員已登入';
                    badge.className = 'user-badge member';
                    DOM.setVisible('login-btn', false);
                    DOM.setVisible('logout-btn', true);

                    const section = DOM.get('premium-section');
                    if (section) {
                        section.classList.remove('locked');
                        section.classList.add('unlocked');
                    }
                } else {
                    badge.textContent = '🔴 訪客模式';
                    badge.className = 'user-badge guest';
                    DOM.setVisible('login-btn', true);
                    DOM.setVisible('logout-btn', false);

                    const section = DOM.get('premium-section');
                    if (section) {
                        section.classList.remove('unlocked');
                        section.classList.add('locked');
                    }
                }
            }
        });

        // 篩選變化 → 重新渲染動態圖表
        TrafficSaaS.subscribe('filters.current', async (filters) => {
            if (TrafficSaaS.state.auth.isLoggedIn) {
                try {
                    const result = await DashboardService.applyFilters(filters.month, filters.gender);
                    ChartManager.renderDynamicChart(result);
                    UIService.updateFilterResult(result);
                } catch (err) {
                    Logger.error('篩選渲染失敗', err);
                }
            }
        });
    },

    /**
     * 綁定事件
     */
    bindEvents() {
        Logger.info('🔗 綁定事件');

        // 登入
        this._eventListeners.push(
            DOM.on('do-login-btn', 'click', async () => {
                const email = DOM.get('login-email')?.value.trim() || '';
                const password = DOM.get('login-password')?.value || '';

                try {
                    await AuthService.login(email, password);
                    DOM.setVisible('login-modal', false);
                } catch (err) {
                    const errEl = DOM.get('login-error');
                    if (errEl) {
                        errEl.textContent = err.message;
                        errEl.style.display = 'block';
                    }
                }
            })
        );

        this._eventListeners.push(
            DOM.on('logout-btn', 'click', async () => {
                await AuthService.logout();
            })
        );

        // Modal
        this._eventListeners.push(
            DOM.on('login-btn', 'click', () => DOM.setVisible('login-modal', true))
        );
        this._eventListeners.push(
            DOM.on('cancel-login-btn', 'click', () => DOM.setVisible('login-modal', false))
        );

        // Enter 鍵登入
        ['login-email', 'login-password'].forEach(id => {
            this._eventListeners.push(
                DOM.on(id, 'keydown', e => {
                    if (e.key === 'Enter') DOM.get('do-login-btn')?.click();
                })
            );
        });

        // 訂閱
        this._eventListeners.push(
            DOM.on('sub-btn', 'click', async () => {
                const email = DOM.get('sub-email')?.value.trim() || '';

                if (!email || !email.includes('@')) {
                    ErrorBus.emit('請輸入有效的 Email');
                    return;
                }

                const btn = DOM.get('sub-btn');
                if (btn) btn.disabled = true;

                try {
                    await APIClient.subscribe(email);
                    const result = DOM.get('sub-result');
                    if (result) {
                        result.textContent = `✅ 訂閱成功！請至 ${email} 確認`;
                        result.className = 'sub-result success';
                        result.style.display = 'block';
                    }
                    if (DOM.get('sub-email')) DOM.get('sub-email').value = '';
                } catch (err) {
                    ErrorBus.emit(`訂閱失敗: ${err.message}`);
                } finally {
                    if (btn) btn.disabled = false;
                }
            })
        );

        // 動態查詢
        this._eventListeners.push(
            DOM.on('query-btn', 'click', async () => {
                const month = DOM.get('filter-month')?.value || null;
                const gender = DOM.get('filter-gender')?.value || null;

                const btn = DOM.get('query-btn');
                if (btn) btn.disabled = true;

                try {
                    const result = await DashboardService.applyFilters(month, gender);
                    TrafficSaaS.publish('filters.current', { month, gender });
                    ChartManager.renderDynamicChart(result);
                    UIService.updateFilterResult(result);
                } finally {
                    if (btn) btn.disabled = false;
                }
            })
        );
    },

    /**
     * 線上狀態監聽
     */
    setupConnectivityListeners() {
        window.addEventListener('online', () => {
            Logger.info('🌐 恢復線上');
            TrafficSaaS.publish('connectivity.isOnline', true);
        });

        window.addEventListener('offline', () => {
            Logger.warn('📴 進入離線');
            TrafficSaaS.publish('connectivity.isOnline', false);
            ErrorBus.emit('離線狀態 - 部分功能不可用');
        });
    },

    /**
     * 清理
     */
    cleanup() {
        Logger.info('🧹 清理資源');

        this._eventListeners.forEach(unsub => {
            if (typeof unsub === 'function') unsub();
        });

        ChartManager.disposeAll();
        TrafficSaaS.state.cache.clear();
    }
};

// ══════════════════════════════════════════════════════════════════
// 初始化
// ══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    AppController.init();
});

window.addEventListener('beforeunload', () => {
    AppController.cleanup();
});

// ══════════════════════════════════════════════════════════════════
// 全域暴露
// ══════════════════════════════════════════════════════════════════

window.TrafficSaaS = TrafficSaaS;
window.AppController = AppController;
window.Logger = Logger;
window.ErrorBus = ErrorBus;
window.DashboardService = DashboardService;
window.AuthService = AuthService;

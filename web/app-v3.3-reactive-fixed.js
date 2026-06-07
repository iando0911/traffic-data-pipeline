/**
 * app-v3.3-reactive-fixed.js — 台灣交通事故 SaaS 分析平台（修正版）
 *
 * 【修正重點】
 * ✅ WeakMap 替代 __isProxy，避免污染資料
 * ✅ pathRelates 精確判斷路徑相關性（祖先、後代、精確匹配）
 * ✅ batch 完整 flush：subscribers + effects + computed cache
 * ✅ Effect 依賴系統使用 pathRelates 提高準確性
 * ✅ 環境檢查（DOM/window guard）
 * ✅ 完整的 month/gender 篩選邏輯
 * ✅ 去除資料污染（不再使用 __isProxy）
 */

// ══════════════════════════════════════════════
// Core helpers
// ══════════════════════════════════════════════

const queueMicrotaskSafe =
    typeof queueMicrotask === 'function'
        ? queueMicrotask
        : (cb) => Promise.resolve().then(cb);

function safeGet(obj, path) {
    return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

/**
 * 判斷兩個路徑是否相關
 * - 精確匹配：a === b
 * - 祖先匹配：a.user.name 關於 a.user
 * - 後代匹配：a.user 關於 a.user.name
 */
function pathRelates(a, b) {
    return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

// ══════════════════════════════════════════════
// 【核心 1】Reactive State Engine（修正版）
// ══════════════════════════════════════════════

class ReactiveState {
    constructor(initialState = {}) {
        this.subscribers = new Map(); // path -> Set<callback>
        this.effects = new Set(); // { fn, deps, cleanup }
        this.computedCache = new Map(); // key -> value
        this.computedDeps = new Map(); // key -> Set<depPath>

        // ✅ 使用 WeakMap 避免污染資料結構
        this.rawToProxy = new WeakMap(); // raw object -> proxy
        this.proxyToRaw = new WeakMap(); // proxy -> raw object

        this.pendingChanges = new Map(); // path -> { newValue, oldValue }
        this.flushScheduled = false;
        this.batchDepth = 0;

        // 正確把 state 接成 Proxy
        this.state = this._createReactiveProxy(initialState);
    }

    /**
     * 建立深層代理，支援嵌套物件追蹤
     * ✅ 使用 WeakMap 快取，不污染原物件
     */
    _createReactiveProxy(obj, basePath = '') {
        if (!obj || typeof obj !== 'object') return obj;

        // 檢查是否已代理
        if (this.rawToProxy.has(obj)) {
            return this.rawToProxy.get(obj);
        }

        const proxy = new Proxy(obj, {
            get: (target, key, receiver) => {
                const value = Reflect.get(target, key, receiver);

                // 基本型別直接回傳
                if (value === null || typeof value !== 'object') {
                    return value;
                }

                // 遞迴代理嵌套物件
                const childPath = basePath ? `${basePath}.${String(key)}` : String(key);
                return this._createReactiveProxy(value, childPath);
            },

            set: (target, key, value, receiver) => {
                const fullPath = basePath ? `${basePath}.${String(key)}` : String(key);
                const oldValue = target[key];

                // 物件值遞迴代理
                const nextValue =
                    value && typeof value === 'object'
                        ? this._createReactiveProxy(value, fullPath)
                        : value;

                // 值未變，直接返回
                if (Object.is(oldValue, nextValue)) return true;

                const ok = Reflect.set(target, key, nextValue, receiver);
                if (ok) {
                    this._queueChange(fullPath, nextValue, oldValue);
                }
                return ok;
            },

            deleteProperty: (target, key) => {
                if (!Object.prototype.hasOwnProperty.call(target, key)) return true;

                const fullPath = basePath ? `${basePath}.${String(key)}` : String(key);
                const oldValue = target[key];
                const ok = Reflect.deleteProperty(target, key);

                if (ok) {
                    this._queueChange(fullPath, undefined, oldValue);
                }
                return ok;
            }
        });

        this.rawToProxy.set(obj, proxy);
        this.proxyToRaw.set(proxy, obj);
        return proxy;
    }

    /**
     * 將變更排入隊列，在 batchDepth 為 0 時 flush
     */
    _queueChange(path, newValue, oldValue) {
        if (!this.pendingChanges.has(path)) {
            this.pendingChanges.set(path, { newValue, oldValue });
        } else {
            // 保留最早的 oldValue，更新為最新 newValue
            const prev = this.pendingChanges.get(path);
            this.pendingChanges.set(path, { newValue, oldValue: prev.oldValue });
        }

        if (this.batchDepth > 0) return;

        if (!this.flushScheduled) {
            this.flushScheduled = true;
            queueMicrotaskSafe(() => this._flush());
        }
    }

    /**
     * 完整 flush：invalidate computed → notify subscribers → run effects
     */
    _flush() {
        this.flushScheduled = false;
        if (this.pendingChanges.size === 0) return;

        const changes = new Map(this.pendingChanges);
        this.pendingChanges.clear();

        // 1) invalidate computed cache
        for (const changedPath of changes.keys()) {
            this._invalidateComputedDeps(changedPath);
        }

        // 2) notify subscribers
        this._notifySubscribers(changes);

        // 3) run matched effects
        this._runEffects(changes);
    }

    /**
     * ✅ 使用 pathRelates 精確通知訂閱者
     */
    _notifySubscribers(changes) {
        const notifiedCallbacks = new Set();

        for (const [subPath, callbacks] of this.subscribers.entries()) {
            let matchedChange = null;

            // 找出與訂閱路徑相關的變更
            for (const [changedPath, change] of changes.entries()) {
                if (pathRelates(subPath, changedPath)) {
                    matchedChange = { path: changedPath, ...change };
                }
            }

            if (!matchedChange) continue;

            // 執行回調（防重複）
            for (const cb of callbacks) {
                if (notifiedCallbacks.has(cb)) continue;
                notifiedCallbacks.add(cb);

                try {
                    cb(matchedChange.newValue, matchedChange.oldValue, matchedChange.path);
                } catch (err) {
                    console.error(`Subscriber error at ${subPath}:`, err);
                }
            }
        }
    }

    /**
     * ✅ 使用 pathRelates 精確失效 computed cache
     */
    _invalidateComputedDeps(changedPath) {
        for (const [computedKey, deps] of this.computedDeps.entries()) {
            for (const dep of deps) {
                if (pathRelates(dep, changedPath)) {
                    this.computedCache.delete(computedKey);
                    break;
                }
            }
        }
    }

    /**
     * ✅ 使用 pathRelates 精確匹配 Effect 依賴
     */
    _runEffects(changes) {
        for (const effect of this.effects) {
            // deps.size === 0 表示 mount-only，不在後續變動時重跑
            if (effect.deps.size === 0) continue;

            let shouldRun = false;
            for (const dep of effect.deps) {
                for (const changedPath of changes.keys()) {
                    if (pathRelates(dep, changedPath)) {
                        shouldRun = true;
                        break;
                    }
                }
                if (shouldRun) break;
            }

            if (!shouldRun) continue;

            try {
                if (typeof effect.cleanup === 'function') {
                    effect.cleanup();
                }
                effect.cleanup = effect.fn() || null;
            } catch (err) {
                console.error('Effect error:', err);
            }
        }
    }

    /**
     * 訂閱特定路徑的變化
     */
    subscribe(path, callback) {
        if (!this.subscribers.has(path)) {
            this.subscribers.set(path, new Set());
        }
        this.subscribers.get(path).add(callback);

        return () => {
            const set = this.subscribers.get(path);
            if (!set) return;
            set.delete(callback);
            if (set.size === 0) this.subscribers.delete(path);
        };
    }

    /**
     * 定義 computed state（衍生狀態）
     */
    defineComputed(key, computeFn, dependencies = []) {
        this.computedDeps.set(key, new Set(dependencies));

        return {
            get: () => {
                if (this.computedCache.has(key)) {
                    return this.computedCache.get(key);
                }
                const value = computeFn(this.state);
                this.computedCache.set(key, value);
                return value;
            }
        };
    }

    /**
     * 註冊 effect，立即執行一次
     * deps.size === 0 → 只在掛載時執行
     * deps.size > 0 → 依賴變化時執行
     */
    effect(fn, dependencies = []) {
        const effect = {
            fn,
            deps: new Set(dependencies),
            cleanup: null
        };

        this.effects.add(effect);

        // 立即執行一次
        try {
            effect.cleanup = effect.fn() || null;
        } catch (err) {
            console.error('Effect init error:', err);
        }

        return () => {
            if (typeof effect.cleanup === 'function') {
                try {
                    effect.cleanup();
                } catch (err) {
                    console.error('Effect cleanup error:', err);
                }
            }
            this.effects.delete(effect);
        };
    }

    /**
     * ✅ 完整批量更新：計數 + 統一 flush
     */
    batch(updateFn) {
        this.batchDepth++;
        try {
            updateFn(this.state);
        } finally {
            this.batchDepth--;
            if (this.batchDepth === 0 && this.pendingChanges.size > 0) {
                this._flush();
            }
        }
    }

    /**
     * 取得深層路徑值
     */
    getPath(path) {
        return safeGet(this.state, path);
    }

    /**
     * 設置深層路徑值
     */
    setPath(path, value) {
        const keys = path.split('.');
        const lastKey = keys.pop();
        let obj = this.state;

        for (const key of keys) {
            if (!(key in obj) || obj[key] == null || typeof obj[key] !== 'object') {
                obj[key] = {};
            }
            obj = obj[key];
        }

        obj[lastKey] = value;
    }
}

// ══════════════════════════════════════════════
// 【核心 2】初始化 Global Reactive State
// ══════════════════════════════════════════════

const reactiveState = new ReactiveState({
    data: {
        dashboard: null,
        isDataLoaded: false
    },
    auth: {
        isLoggedIn: false,
        token: null,
        email: null
    },
    ui: {
        loading: false,
        error: null,
        charts: {
            cause: null,
            trend: null,
            dynamic: null
        }
    },
    filters: {
        current: {
            month: '',
            gender: ''
        },
        history: []
    },
    cache: new Map(),
    connectivity: {
        isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true
    }
});

// ✅ 環境檢查：DOM/window guard
if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
        reactiveState.state.connectivity.isOnline = true;
    });
    window.addEventListener('offline', () => {
        reactiveState.state.connectivity.isOnline = false;
    });
}

// ══════════════════════════════════════════════
// 【核心 3】Computed State
// ══════════════════════════════════════════════

const computedState = {
    userStatusBadge: reactiveState.defineComputed(
        'userStatusBadge',
        (state) =>
            state.auth.isLoggedIn
                ? { text: '🟢 會員已登入', className: 'member' }
                : { text: '🔴 訪客模式', className: 'guest' },
        ['auth.isLoggedIn']
    ),

    dynamicChartTitle: reactiveState.defineComputed(
        'dynamicChartTitle',
        (state) => {
            const { month, gender } = state.filters.current;
            const monthText = month ? `${month} 月` : '全部月份';
            const genderText = gender ? `${gender}性` : '全部性別';
            return `${monthText} × ${genderText}`;
        },
        ['filters.current.month', 'filters.current.gender']
    ),

    filteredCauseData: reactiveState.defineComputed(
        'filteredCauseData',
        (state) => {
            if (!state.data.dashboard) return [];
            return DashboardService.applyFilters(
                state.data.dashboard.cause_data,
                state.filters.current
            );
        },
        ['data.dashboard', 'filters.current.month', 'filters.current.gender']
    )
};

// ══════════════════════════════════════════════
// 【核心 4】Pure Service Layer
// ══════════════════════════════════════════════

const APIClient = {
    async fetch(url, options = {}) {
        const res = await fetch(url, options);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    }
};

const AuthService = {
    validateEmail(email) {
        return typeof email === 'string' && email.includes('@');
    },

    generateDemoToken(email) {
        // 非 pure function：含 Date.now()
        return btoa(`demo:${email}:${Date.now()}`);
    },

    parseToken(token) {
        try {
            const decoded = atob(token);
            const [, email] = decoded.split(':');
            return email || null;
        } catch {
            return null;
        }
    },

    async login(email, password) {
        if (!this.validateEmail(email)) {
            throw new Error('Invalid email format');
        }
        if (!password) {
            throw new Error('Password required');
        }

        const token = this.generateDemoToken(email);

        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem('saas_demo_token', token);
        }

        reactiveState.batch((state) => {
            state.auth.isLoggedIn = true;
            state.auth.token = token;
            state.auth.email = email;
            state.ui.error = null;
        });
    },

    logout() {
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.removeItem('saas_demo_token');
        }

        reactiveState.batch((state) => {
            state.auth.isLoggedIn = false;
            state.auth.token = null;
            state.auth.email = null;
        });
    }
};

const DashboardService = {
    async loadDashboard() {
        try {
            return await APIClient.fetch('./dashboard_data.json');
        } catch (err) {
            throw new Error(`Failed to load dashboard: ${err.message}`);
        }
    },

    /**
     * ✅ 完整的 month/gender 篩選邏輯
     */
    applyFilters(causeData, filters) {
        if (!Array.isArray(causeData)) return [];

        let filtered = [...causeData];

        // 月份篩選（支援多種欄位名稱）
        if (filters.month) {
            filtered = filtered.filter((d) => {
                const monthValue = d['月份'] ?? d['月'] ?? d.month ?? '';
                return String(monthValue) === String(filters.month);
            });
        }

        // 性別篩選
        if (filters.gender) {
            filtered = filtered.filter((d) => d['性別'] === filters.gender);
        }

        return filtered;
    },

    getTopCauses(causeData, n = 15) {
        if (!Array.isArray(causeData)) return [];

        const totals = {};
        for (const d of causeData) {
            const cause = d['肇因'];
            const count = toNumber(d['件數']);
            totals[cause] = (totals[cause] || 0) + count;
        }

        return Object.entries(totals)
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([cause]) => cause);
    }
};

const SubscriptionService = {
    validateEmail(email) {
        return typeof email === 'string' && email.includes('@');
    },

    async subscribe(email) {
        if (!this.validateEmail(email)) {
            throw new Error('Invalid email');
        }

        await new Promise((r) => setTimeout(r, 900));

        return {
            success: true,
            message: `✅ 訂閱請求已送出！請前往 ${email} 信箱確認。`
        };
    }
};

// ══════════════════════════════════════════════
// 【核心 5】UI Service
// ══════════════════════════════════════════════

const UIService = {
    renderStats(statsData) {
        if (!statsData || typeof document === 'undefined') return;

        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value ?? '--';
        };

        setText('total-samples', statsData['最終可用樣本數']);
        setText('male-age', statsData['男性平均年齡']);
        setText('female-age', statsData['女性平均年齡']);
        setText('sig-level', statsData['效果量判讀'] || statsData['顯著性'] || '--');
    },

    renderCauseChart(causeData) {
        if (!causeData || !window.echarts || typeof document === 'undefined') return;

        const el = document.getElementById('cause-chart');
        if (!el) return;

        const chart = echarts.getInstanceByDom(el) || echarts.init(el);

        const causes = [...new Set(causeData.map((d) => d['肇因']))].reverse();
        const COLOR = { '男': '#3A86FF', '女': '#FF6B9D' };

        const series = ['男', '女'].map((g) => ({
            name: g,
            type: 'bar',
            data: causes.map((c) => {
                const item = causeData.find((d) => d['肇因'] === c && d['性別'] === g);
                return item ? toNumber(item['件數']) : 0;
            }),
            itemStyle: { color: COLOR[g] }
        }));

        chart.setOption({
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            legend: { data: ['男', '女'] },
            xAxis: { type: 'value', name: '件數' },
            yAxis: { type: 'category', data: causes, axisLabel: { fontSize: 11 } },
            series
        });

        chart.resize();
    },

    showError(message) {
        if (typeof document === 'undefined') return;

        const el = document.getElementById('error-banner');
        if (el) {
            el.textContent = `⚠️ ${message}`;
            el.style.display = 'block';
        }
    },

    clearError() {
        if (typeof document === 'undefined') return;

        const el = document.getElementById('error-banner');
        if (el) {
            el.style.display = 'none';
        }
    }
};

// ══════════════════════════════════════════════
// 【核心 6】Effects
// ══════════════════════════════════════════════

function setupReactiveEffects() {
    // Effect 1: 初次載入資料
    reactiveState.effect(
        () => {
            if (reactiveState.state.data.isDataLoaded || reactiveState.state.ui.loading) return;

            (async () => {
                try {
                    reactiveState.state.ui.loading = true;

                    const data = await DashboardService.loadDashboard();

                    reactiveState.batch((state) => {
                        state.data.dashboard = data;
                        state.data.isDataLoaded = true;
                        state.ui.loading = false;
                        state.ui.error = null;
                    });
                } catch (err) {
                    reactiveState.batch((state) => {
                        state.ui.error = err.message;
                        state.ui.loading = false;
                    });
                }
            })();
        },
        [] // 只在初始化跑一次
    );

    // Effect 2: 渲染統計數字
    reactiveState.effect(
        () => {
            const dashboard = reactiveState.state.data.dashboard;
            if (dashboard?.stats_summary) {
                UIService.renderStats(dashboard.stats_summary);
            }
        },
        ['data.dashboard']
    );

    // Effect 3: 認證狀態變化
    reactiveState.effect(
        () => {
            if (typeof document === 'undefined') return;

            const badge = computedState.userStatusBadge.get();
            const badgeEl = document.getElementById('user-status');

            if (badgeEl) {
                badgeEl.textContent = badge.text;
                badgeEl.className = `user-badge ${badge.className}`;
            }

            const loginBtn = document.getElementById('login-btn');
            const logoutBtn = document.getElementById('logout-btn');

            if (loginBtn) loginBtn.style.display = reactiveState.state.auth.isLoggedIn ? 'none' : 'inline-block';
            if (logoutBtn) logoutBtn.style.display = reactiveState.state.auth.isLoggedIn ? 'inline-block' : 'none';

            const section = document.getElementById('premium-section');
            if (section) {
                if (reactiveState.state.auth.isLoggedIn) {
                    section.classList.remove('locked');
                    section.classList.add('unlocked');
                } else {
                    section.classList.remove('unlocked');
                    section.classList.add('locked');
                }
            }
        },
        ['auth.isLoggedIn']
    );

    // Effect 4: 錯誤提示
    reactiveState.effect(
        () => {
            const error = reactiveState.state.ui.error;
            if (error) UIService.showError(error);
            else UIService.clearError();
        },
        ['ui.error']
    );

    // Effect 5: 篩選變化 → 重繪圖表
    reactiveState.effect(
        () => {
            const dashboard = reactiveState.state.data.dashboard;
            if (dashboard?.cause_data) {
                const filtered = computedState.filteredCauseData.get();
                UIService.renderCauseChart(filtered);
            }
        },
        ['data.dashboard', 'filters.current.month', 'filters.current.gender']
    );

    // Effect 6: loading 狀態
    reactiveState.effect(
        () => {
            if (typeof document === 'undefined') return;

            const loaderEl = document.getElementById('loader');
            if (loaderEl) {
                loaderEl.style.display = reactiveState.state.ui.loading ? 'block' : 'none';
            }
        },
        ['ui.loading']
    );
}

// ══════════════════════════════════════════════
// 【核心 7】Events
// ══════════════════════════════════════════════

function bindEvents() {
    if (typeof document === 'undefined') return;

    document.getElementById('login-btn')?.addEventListener('click', () => {
        const modal = document.getElementById('login-modal');
        if (modal) modal.style.display = 'flex';

        setTimeout(() => document.getElementById('login-email')?.focus(), 50);
    });

    document.getElementById('cancel-login-btn')?.addEventListener('click', () => {
        const modal = document.getElementById('login-modal');
        const err = document.getElementById('login-error');

        if (modal) modal.style.display = 'none';
        if (err) err.style.display = 'none';
    });

    document.getElementById('do-login-btn')?.addEventListener('click', async () => {
        const email = document.getElementById('login-email')?.value.trim() ?? '';
        const password = document.getElementById('login-password')?.value ?? '';
        const errEl = document.getElementById('login-error');

        try {
            await AuthService.login(email, password);

            const modal = document.getElementById('login-modal');
            if (modal) modal.style.display = 'none';
            if (errEl) errEl.style.display = 'none';

            setTimeout(() => {
                const dashboard = reactiveState.state.data.dashboard;
                if (dashboard?.cause_data) {
                    UIService.renderCauseChart(computedState.filteredCauseData.get());
                }
            }, 100);
        } catch (err) {
            if (errEl) {
                errEl.textContent = err.message;
                errEl.style.display = 'block';
            }
        }
    });

    document.getElementById('logout-btn')?.addEventListener('click', () => {
        AuthService.logout();
    });

    ['login-email', 'login-password'].forEach((id) => {
        document.getElementById(id)?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('do-login-btn')?.click();
        });
    });

    document.getElementById('login-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            e.currentTarget.style.display = 'none';
        }
    });

    document.getElementById('sub-btn')?.addEventListener('click', async () => {
        const email = document.getElementById('sub-email')?.value.trim() ?? '';
        const btn = document.getElementById('sub-btn');
        const resultEl = document.getElementById('sub-result');

        try {
            if (btn) {
                btn.disabled = true;
                btn.textContent = '送出中...';
            }

            const result = await SubscriptionService.subscribe(email);

            if (resultEl) {
                resultEl.textContent = result.message;
                resultEl.className = 'sub-result success';
                resultEl.style.display = 'block';
            }

            const input = document.getElementById('sub-email');
            if (input) input.value = '';
        } catch (err) {
            if (resultEl) {
                resultEl.textContent = `❌ ${err.message}`;
                resultEl.className = 'sub-result error';
                resultEl.style.display = 'block';
            }
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '訂閱推播';
            }
        }
    });

    document.getElementById('query-btn')?.addEventListener('click', () => {
        const month = document.getElementById('filter-month')?.value ?? '';
        const gender = document.getElementById('filter-gender')?.value ?? '';

        reactiveState.state.filters.current = { month, gender };
    });
}

// ══════════════════════════════════════════════
// Init
// ══════════════════════════════════════════════

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        setupReactiveEffects();
        bindEvents();

        if (typeof window !== 'undefined' && window.echarts) {
            const causeEl = document.getElementById('cause-chart');
            const trendEl = document.getElementById('trend-chart');
            const dynamicEl = document.getElementById('dynamic-chart');

            if (causeEl) reactiveState.state.ui.charts.cause = echarts.init(causeEl);
            if (trendEl) reactiveState.state.ui.charts.trend = echarts.init(trendEl);
            if (dynamicEl) reactiveState.state.ui.charts.dynamic = echarts.init(dynamicEl);

            window.addEventListener('resize', () => {
                Object.values(reactiveState.state.ui.charts).forEach((chart) => chart?.resize?.());
            });
        }

        // 觸發初始載入
        reactiveState.state.data.isDataLoaded = false;
    });
}

// 暴露全域方法（向後相容）
if (typeof window !== 'undefined') {
    window.reactiveState = reactiveState;
    window.AuthService = AuthService;
    window.DashboardService = DashboardService;
    window.SubscriptionService = SubscriptionService;
}

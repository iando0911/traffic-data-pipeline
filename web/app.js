/**
 * app-v3.3.fixed.js — 台灣交通事故 SaaS 分析平台
 * v3.3 修正版
 *
 * 修正重點：
 * - this.state 正確接到 Proxy
 * - 深層物件使用 WeakMap 快取，避免重複代理
 * - 不再使用 __isProxy 汙染資料
 * - effect 只在依賴變動時執行
 * - batch 真的會合併 flush
 * - computed cache 會正確失效
 * - month / gender 篩選補齊
 * - 加入 DOM / browser guard，避免環境錯誤
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

function pathRelates(a, b) {
    // a 與 b 只要是同一路徑、祖先、或子孫，都視為相關
    return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

// ══════════════════════════════════════════════
// 【核心 1】Reactive State Engine
// ══════════════════════════════════════════════

class ReactiveState {
    constructor(initialState = {}) {
        this.subscribers = new Map(); // path -> Set<callback>
        this.effects = new Set(); // { fn, deps, cleanup, initialRun }
        this.computedCache = new Map(); // key -> value
        this.computedDeps = new Map(); // key -> Set<depPath>

        this.rawToProxy = new WeakMap(); // raw object -> proxy
        this.proxyToRaw = new WeakMap(); // proxy -> raw object

        this.pendingChanges = new Map(); // path -> { newValue, oldValue }
        this.flushScheduled = false;
        this.batchDepth = 0;

        // ✅ 正確把 state 接成 Proxy
        this.state = this._createReactiveProxy(initialState);
    }

    _createReactiveProxy(obj, basePath = '') {
        if (!obj || typeof obj !== 'object') return obj;

        if (this.rawToProxy.has(obj)) {
            return this.rawToProxy.get(obj);
        }

        const proxy = new Proxy(obj, {
            get: (target, key, receiver) => {
                const value = Reflect.get(target, key, receiver);

                // 直接回傳原始內建值
                if (value === null || typeof value !== 'object') {
                    return value;
                }

                const childPath = basePath ? `${basePath}.${String(key)}` : String(key);
                return this._createReactiveProxy(value, childPath);
            },

            set: (target, key, value, receiver) => {
                const fullPath = basePath ? `${basePath}.${String(key)}` : String(key);
                const oldValue = target[key];

                const nextValue =
                    value && typeof value === 'object'
                        ? this._createReactiveProxy(value, fullPath)
                        : value;

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

    _queueChange(path, newValue, oldValue) {
        if (!this.pendingChanges.has(path)) {
            this.pendingChanges.set(path, { newValue, oldValue });
        } else {
            // 保留最早 oldValue，更新 latest newValue
            const prev = this.pendingChanges.get(path);
            this.pendingChanges.set(path, { newValue, oldValue: prev.oldValue });
        }

        if (this.batchDepth > 0) return;

        if (!this.flushScheduled) {
            this.flushScheduled = true;
            queueMicrotaskSafe(() => this._flush());
        }
    }

    _flush() {
        this.flushScheduled = false;
        if (this.pendingChanges.size === 0) return;

        const changes = new Map(this.pendingChanges);
        this.pendingChanges.clear();

        // 1) invalidate computed cache
        for (const changedPath of changes.keys()) {
            this._invalidateComputedDeps(changedPath);
        }

        // 2) notify subscribers once per flush
        this._notifySubscribers(changes);

        // 3) run matched effects
        this._runEffects(changes);
    }

    _notifySubscribers(changes) {
        const notifiedCallbacks = new Set();

        for (const [subPath, callbacks] of this.subscribers.entries()) {
            let matchedChange = null;

            for (const [changedPath, change] of changes.entries()) {
                if (pathRelates(subPath, changedPath)) {
                    matchedChange = { path: changedPath, ...change };
                }
            }

            if (!matchedChange) continue;

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

    _runEffects(changes) {
        for (const effect of this.effects) {
            // deps=[] 只在註冊時跑一次，不在每次變動時重跑
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

    getPath(path) {
        return safeGet(this.state, path);
    }

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
        // 嚴格來說這不是 pure，因為含 Date.now()
        // 這裡保留 demo token 行為，但不要再宣稱是 pure function
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

    applyFilters(causeData, filters) {
        if (!Array.isArray(causeData)) return [];

        let filtered = [...causeData];

        if (filters.month) {
            filtered = filtered.filter((d) => {
                const monthValue = d['月份'] ?? d['月'] ?? d.month ?? '';
                return String(monthValue) === String(filters.month);
            });
        }

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

            // 如需登入後強制重繪，可保留這段
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

document.addEventListener('DOMContentLoaded', () => {
    setupReactiveEffects();
    bindEvents();

    if (window.echarts && typeof document !== 'undefined') {
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

// 暴露全域方法（向後相容）
if (typeof window !== 'undefined') {
    window.reactiveState = reactiveState;
    window.AuthService = AuthService;
}

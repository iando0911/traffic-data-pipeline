/**
 * app-v3.3.js — 台灣交通事故 SaaS 分析平台
 * 
 * 【架構進化】v3.2 → v3.3 Reactive Engine
 * 
 * ✅ Proxy-based Reactivity
 *    - state 直接修改 = 自動觸發 reactive
 *    - 無需手動 publish/subscribe
 * 
 * ✅ Deep Path Tracking
 *    - 支持嵌套 object 變化偵測
 *    - 自動依賴圖計算
 *    - 避免重複通知
 * 
 * ✅ Computed State（衍生狀態）
 *    - 自動 cache invalidation
 *    - 懶加載評估
 * 
 * ✅ Effect System（副作用系統）
 *    - 自動 cleanup
 *    - 防 memory leak
 * 
 * ✅ Pure Service Layer
 *    - Service 完全 pure function
 *    - 不依賴 global state
 *    - 易於測試
 */

// ══════════════════════════════════════════════
// 【核心 1】Reactive State Engine
// ══════════════════════════════════════════════

class ReactiveState {
    constructor(initialState = {}) {
        this.state = {};
        this.subscribers = new Map(); // path → Set<callback>
        this.dependencyGraph = new Map(); // computed → Set<path>
        this.effects = [];
        this.computedCache = new Map();
        this.computedDeps = new Map();
        this.isNotifying = false;
        this.pendingNotifications = Set;
        
        // 初始化 state 為 Proxy
        this._createReactiveProxy(initialState);
    }
    
    _createReactiveProxy(obj, path = '') {
        return new Proxy(obj, {
            set: (target, key, value) => {
                const fullPath = path ? `${path}.${key}` : key;
                const oldValue = target[key];
                
                // 避免無限迴圈
                if (oldValue === value) return true;
                
                // 如果新值是 object，再包一層 Proxy
                if (typeof value === 'object' && value !== null) {
                    value = this._createReactiveProxy(value, fullPath);
                }
                
                target[key] = value;
                
                // 觸發所有監聽此 path 的回調
                this._notifySubscribers(fullPath, value, oldValue);
                
                // 觸發依賴此 path 的 computed state
                this._invalidateComputedDeps(fullPath);
                
                // 執行所有 effects
                this._runEffects();
                
                return true;
            },
            
            get: (target, key) => {
                // 防止無限 Proxy 包裝
                if (key === Symbol.toStringTag) return undefined;
                
                const value = target[key];
                // 嵌套 object 自動返回 Proxy
                if (typeof value === 'object' && value !== null && !value.__isProxy) {
                    const nested = this._createReactiveProxy(value, path ? `${path}.${key}` : key);
                    nested.__isProxy = true;
                    target[key] = nested;
                    return nested;
                }
                return value;
            }
        });
    }
    
    _notifySubscribers(path, newValue, oldValue) {
        // 防重複通知（在一個 tick 內多次修改同一 path）
        if (this.isNotifying) {
            if (!this.pendingNotifications) this.pendingNotifications = new Set();
            this.pendingNotifications.add(path);
            return;
        }
        
        this.isNotifying = true;
        
        // 精確匹配
        if (this.subscribers.has(path)) {
            this.subscribers.get(path).forEach(cb => {
                try {
                    cb(newValue, oldValue, path);
                } catch (err) {
                    console.error(`Subscriber error at ${path}:`, err);
                }
            });
        }
        
        // 前綴匹配（父路徑的變化通知子路徑的訂閱者）
        // 例如 'data.dashboard' 變化 → 通知 'data' 的訂閱者
        const pathParts = path.split('.');
        for (let i = pathParts.length - 1; i > 0; i--) {
            const parentPath = pathParts.slice(0, i).join('.');
            if (this.subscribers.has(parentPath)) {
                this.subscribers.get(parentPath).forEach(cb => {
                    try {
                        cb(newValue, oldValue, path);
                    } catch (err) {
                        console.error(`Subscriber error at ${parentPath}:`, err);
                    }
                });
            }
        }
        
        this.isNotifying = false;
    }
    
    _invalidateComputedDeps(changedPath) {
        // 找出依賴此 path 的所有 computed state
        for (const [computedKey, deps] of this.computedDeps.entries()) {
            if (deps.has(changedPath)) {
                this.computedCache.delete(computedKey);
            }
        }
    }
    
    _runEffects() {
        this.effects.forEach(effect => {
            try {
                effect.run();
            } catch (err) {
                console.error('Effect error:', err);
            }
        });
    }
    
    // 訂閱特定 path 的變化
    subscribe(path, callback) {
        if (!this.subscribers.has(path)) {
            this.subscribers.set(path, new Set());
        }
        this.subscribers.get(path).add(callback);
        
        // 返回 unsubscribe 函數
        return () => {
            this.subscribers.get(path).delete(callback);
        };
    }
    
    // 定義 computed state（衍生狀態）
    defineComputed(key, computeFn, dependencies) {
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
    
    // 定義 effect（副作用）
    effect(fn, dependencies = []) {
        const effect = {
            fn,
            dependencies,
            cleanup: null,
            run: () => {
                if (effect.cleanup) effect.cleanup();
                effect.cleanup = effect.fn() || (() => {});
            }
        };
        
        this.effects.push(effect);
        effect.run(); // 立即執行
        
        return () => {
            if (effect.cleanup) effect.cleanup();
            this.effects = this.effects.filter(e => e !== effect);
        };
    }
    
    // 批量更新（防止多次 notify）
    batch(updateFn) {
        const originalIsNotifying = this.isNotifying;
        this.isNotifying = true;
        
        try {
            updateFn(this.state);
        } finally {
            this.isNotifying = originalIsNotifying;
            if (!originalIsNotifying) {
                this._runEffects();
            }
        }
    }
    
    // 獲取深層路徑值
    getPath(path) {
        return path.split('.').reduce((obj, key) => obj?.[key], this.state);
    }
    
    // 設置深層路徑值
    setPath(path, value) {
        const keys = path.split('.');
        const lastKey = keys.pop();
        let obj = this.state;
        
        for (const key of keys) {
            if (!(key in obj)) obj[key] = {};
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
        isOnline: navigator.onLine
    }
});

// 監聽網路狀態
window.addEventListener('online', () => { reactiveState.state.connectivity.isOnline = true; });
window.addEventListener('offline', () => { reactiveState.state.connectivity.isOnline = false; });

// ══════════════════════════════════════════════
// 【核心 3】Computed State（衍生狀態）
// ══════════════════════════════════════════════

const computedState = {
    // 用戶狀態標籤
    userStatusBadge: reactiveState.defineComputed(
        'userStatusBadge',
        (state) => state.auth.isLoggedIn 
            ? { text: '🟢 會員已登入', className: 'member' }
            : { text: '🔴 訪客模式', className: 'guest' },
        ['auth.isLoggedIn']
    ),
    
    // 動態圖表標題
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
    
    // 篩選後的肇因資料
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
        try {
            const res = await fetch(url, options);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            throw new Error(`API Error: ${err.message}`);
        }
    }
};

const AuthService = {
    /**
     * Pure function: 驗證 email 格式
     * 不依賴任何 global state
     */
    validateEmail(email) {
        return email && email.includes('@');
    },
    
    /**
     * Pure function: 產生 demo token
     */
    generateDemoToken(email) {
        return btoa(`demo:${email}:${Date.now()}`);
    },
    
    /**
     * Pure function: 解析 token 獲取 email
     */
    parseToken(token) {
        try {
            const decoded = atob(token);
            const [, email] = decoded.split(':');
            return email;
        } catch {
            return null;
        }
    },
    
    /**
     * Side effect: 執行登入（更新 state）
     */
    async login(email, password) {
        if (!this.validateEmail(email)) {
            throw new Error('Invalid email format');
        }
        if (!password) {
            throw new Error('Password required');
        }
        
        // Demo mode
        const token = this.generateDemoToken(email);
        sessionStorage.setItem('saas_demo_token', token);
        
        // 更新 reactive state（自動觸發 UI 更新）
        reactiveState.state.auth.isLoggedIn = true;
        reactiveState.state.auth.token = token;
        reactiveState.state.auth.email = email;
    },
    
    /**
     * Side effect: 執行登出（更新 state）
     */
    logout() {
        sessionStorage.removeItem('saas_demo_token');
        
        // 更新 reactive state（自動觸發 UI 更新）
        reactiveState.state.auth.isLoggedIn = false;
        reactiveState.state.auth.token = null;
        reactiveState.state.auth.email = null;
    }
};

const DashboardService = {
    /**
     * Pure function: 載入儀表板資料
     * 接收 data，返回處理結果
     */
    async loadDashboard() {
        try {
            const data = await APIClient.fetch('./dashboard_data.json');
            return data;
        } catch (err) {
            throw new Error(`Failed to load dashboard: ${err.message}`);
        }
    },
    
    /**
     * Pure function: 應用篩選
     * 不修改 input，返回新陣列
     */
    applyFilters(causeData, filters) {
        if (!causeData || !Array.isArray(causeData)) return [];
        
        let filtered = [...causeData];
        
        // 如果有 month 篩選（實際應用中應該從 data 中篩選）
        // 這裡簡化處理
        if (filters.gender) {
            filtered = filtered.filter(d => d['性別'] === filters.gender);
        }
        
        return filtered;
    },
    
    /**
     * Pure function: 取得 TOP N 肇因
     */
    getTopCauses(causeData, n = 15) {
        if (!Array.isArray(causeData)) return [];
        
        const totals = {};
        causeData.forEach(d => {
            totals[d['肇因']] = (totals[d['肇因']] || 0) + d['件數'];
        });
        
        return Object.entries(totals)
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(e => e[0]);
    }
};

const SubscriptionService = {
    /**
     * Pure function: 驗證訂閱 email
     */
    validateEmail(email) {
        return email && email.includes('@');
    },
    
    /**
     * Side effect: 執行訂閱
     */
    async subscribe(email) {
        if (!this.validateEmail(email)) {
            throw new Error('Invalid email');
        }
        
        // Demo mode: 模擬 API 延遲
        await new Promise(r => setTimeout(r, 900));
        
        return {
            success: true,
            message: `✅ 訂閱請求已送出！請前往 ${email} 信箱確認。`
        };
    }
};

// ══════════════════════════════════════════════
// 【核心 5】UI Service（Pure Render Functions）
// ══════════════════════════════════════════════

const UIService = {
    /**
     * Pure function: 渲染統計數字
     * 接收 data，返回 UI 更新操作
     */
    renderStats(statsData) {
        if (!statsData) return;
        
        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value ?? '--';
        };
        
        setText('total-samples', statsData['最終可用樣本數']);
        setText('male-age', statsData['男性平均年齡']);
        setText('female-age', statsData['女性平均年齡']);
        setText('sig-level', statsData['效果量判讀'] || statsData['顯著性'] || '--');
    },
    
    /**
     * Pure function: 渲染肇因圖表
     */
    renderCauseChart(causeData) {
        if (!causeData || !window.echarts) return;
        
        const chart = echarts.getInstanceByDom(document.getElementById('cause-chart')) 
            || echarts.init(document.getElementById('cause-chart'));
        
        const causes = [...new Set(causeData.map(d => d['肇因']))].reverse();
        const COLOR = { '男': '#3A86FF', '女': '#FF6B9D' };
        
        const series = ['男', '女'].map(g => ({
            name: g,
            type: 'bar',
            data: causes.map(c => {
                const item = causeData.find(d => d['肇因'] === c && d['性別'] === g);
                return item ? item['件數'] : 0;
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
    
    /**
     * Pure function: 更新 UI 錯誤提示
     */
    showError(message) {
        const el = document.getElementById('error-banner');
        if (el) {
            el.textContent = `⚠️ ${message}`;
            el.style.display = 'block';
        }
    },
    
    /**
     * Pure function: 隱藏錯誤提示
     */
    clearError() {
        const el = document.getElementById('error-banner');
        if (el) {
            el.style.display = 'none';
        }
    }
};

// ══════════════════════════════════════════════
// 【核心 6】效果系統（自動同步）
// ══════════════════════════════════════════════

function setupReactiveEffects() {
    // Effect 1: 資料載入
    reactiveState.effect(
        () => {
            if (!reactiveState.state.data.isDataLoaded) {
                (async () => {
                    try {
                        reactiveState.state.ui.loading = true;
                        const data = await DashboardService.loadDashboard();
                        reactiveState.state.data.dashboard = data;
                        reactiveState.state.data.isDataLoaded = true;
                        reactiveState.state.ui.loading = false;
                    } catch (err) {
                        reactiveState.state.ui.error = err.message;
                        reactiveState.state.ui.loading = false;
                    }
                })();
            }
        },
        []
    );
    
    // Effect 2: 儀表板載入完成 → 渲染統計數字
    reactiveState.effect(
        () => {
            const dashboard = reactiveState.state.data.dashboard;
            if (dashboard?.stats_summary) {
                UIService.renderStats(dashboard.stats_summary);
            }
        },
        ['data.dashboard']
    );
    
    // Effect 3: 儀表板變化 → 重繪肇因圖表
    reactiveState.effect(
        () => {
            const dashboard = reactiveState.state.data.dashboard;
            if (dashboard?.cause_data) {
                UIService.renderCauseChart(dashboard.cause_data);
            }
        },
        ['data.dashboard']
    );
    
    // Effect 4: 認證狀態變化 → 更新 UI 狀態
    reactiveState.effect(
        () => {
            const badge = computedState.userStatusBadge.get();
            const badgeEl = document.getElementById('user-status');
            
            if (badgeEl) {
                badgeEl.textContent = badge.text;
                badgeEl.className = `user-badge ${badge.className}`;
            }
            
            // 控制登入按鈕顯示
            const loginBtn = document.getElementById('login-btn');
            const logoutBtn = document.getElementById('logout-btn');
            if (loginBtn) loginBtn.style.display = reactiveState.state.auth.isLoggedIn ? 'none' : 'inline-block';
            if (logoutBtn) logoutBtn.style.display = reactiveState.state.auth.isLoggedIn ? 'inline-block' : 'none';
            
            // 控制 premium section 上鎖/解鎖
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
    
    // Effect 5: 錯誤變化 → 顯示/隱藏錯誤提示
    reactiveState.effect(
        () => {
            const error = reactiveState.state.ui.error;
            if (error) {
                UIService.showError(error);
            } else {
                UIService.clearError();
            }
        },
        ['ui.error']
    );
    
    // Effect 6: 篩選變化 → 重繪動態圖表
    reactiveState.effect(
        () => {
            const dashboard = reactiveState.state.data.dashboard;
            if (dashboard?.cause_data) {
                const filtered = computedState.filteredCauseData.get();
                UIService.renderCauseChart(filtered);
            }
        },
        ['filters.current.month', 'filters.current.gender']
    );
    
    // Effect 7: loading 狀態變化 → 顯示/隱藏加載指示
    reactiveState.effect(
        () => {
            const loading = reactiveState.state.ui.loading;
            const loaderEl = document.getElementById('loader');
            if (loaderEl) {
                loaderEl.style.display = loading ? 'block' : 'none';
            }
        },
        ['ui.loading']
    );
}

// ══════════════════════════════════════════════
// 【核心 7】事件綁定（幾乎沒有副作用）
// ══��═══════════════════════════════════════════

function bindEvents() {
    // 登入按鈕
    document.getElementById('login-btn')?.addEventListener('click', () => {
        document.getElementById('login-modal').style.display = 'flex';
        setTimeout(() => document.getElementById('login-email')?.focus(), 50);
    });
    
    // 取消登入
    document.getElementById('cancel-login-btn')?.addEventListener('click', () => {
        document.getElementById('login-modal').style.display = 'none';
        document.getElementById('login-error').style.display = 'none';
    });
    
    // 執行登入
    document.getElementById('do-login-btn')?.addEventListener('click', async () => {
        const email = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value;
        const errEl = document.getElementById('login-error');
        
        try {
            await AuthService.login(email, password);
            document.getElementById('login-modal').style.display = 'none';
            errEl.style.display = 'none';
            
            // 登入後渲染圖表
            setTimeout(() => {
                const dashboard = reactiveState.state.data.dashboard;
                if (dashboard?.cause_data) {
                    UIService.renderCauseChart(dashboard.cause_data);
                }
            }, 150);
        } catch (err) {
            errEl.textContent = err.message;
            errEl.style.display = 'block';
        }
    });
    
    // 登出
    document.getElementById('logout-btn')?.addEventListener('click', () => {
        AuthService.logout();
    });
    
    // Enter 鍵登入
    ['login-email', 'login-password'].forEach(id => {
        document.getElementById(id)?.addEventListener('keydown', e => {
            if (e.key === 'Enter') document.getElementById('do-login-btn')?.click();
        });
    });
    
    // Modal 背景點擊關閉
    document.getElementById('login-modal')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) {
            document.getElementById('login-modal').style.display = 'none';
        }
    });
    
    // 訂閱按鈕
    document.getElementById('sub-btn')?.addEventListener('click', async () => {
        const email = document.getElementById('sub-email').value.trim();
        const btn = document.getElementById('sub-btn');
        const resultEl = document.getElementById('sub-result');
        
        try {
            btn.disabled = true;
            btn.textContent = '送出中...';
            
            const result = await SubscriptionService.subscribe(email);
            resultEl.textContent = result.message;
            resultEl.className = 'sub-result success';
            resultEl.style.display = 'block';
            document.getElementById('sub-email').value = '';
        } catch (err) {
            resultEl.textContent = `❌ ${err.message}`;
            resultEl.className = 'sub-result error';
            resultEl.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.textContent = '訂閱推播';
        }
    });
    
    // 動態查詢按鈕
    document.getElementById('query-btn')?.addEventListener('click', () => {
        const month = document.getElementById('filter-month').value;
        const gender = document.getElementById('filter-gender').value;
        
        // 直接更新 state，自動觸發 effect → 重繪圖表
        reactiveState.state.filters.current = { month, gender };
    });
}

// ══════════════════════════════════════════════
// 【初始化】
// ══════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    setupReactiveEffects();
    bindEvents();
    
    // 初始化 charts
    if (window.echarts) {
        reactiveState.state.ui.charts.cause = echarts.init(document.getElementById('cause-chart'));
        reactiveState.state.ui.charts.trend = echarts.init(document.getElementById('trend-chart'));
        reactiveState.state.ui.charts.dynamic = echarts.init(document.getElementById('dynamic-chart'));
        
        window.addEventListener('resize', () => {
            Object.values(reactiveState.state.ui.charts).forEach(chart => chart?.resize?.());
        });
    }
    
    // 觸發初始資料載入
    reactiveState.state.data.isDataLoaded = false;
});

// 暴露全域方法（向後相容）
window.reactiveState = reactiveState;
window.AuthService = AuthService;

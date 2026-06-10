"use strict";

/**
 * web/app.js
 * Taiwan Traffic Accident SaaS Dashboard
 *
 * v4.0 SaaS Enhancement
 * ------------------------------------------------------------
 * 保留原本功能：
 * - ReactiveState
 * - Dashboard data loading
 * - Filter query
 * - ECharts cause / trend chart
 * - Demo member login
 * - Premium locked/unlocked section
 *
 * 新增 SaaS 動態行為：
 * - CONFIG Demo / Production Mode
 * - SubscriptionService
 * - NotificationService
 * - ActivityLogService
 * - StorageService
 * - Subscriber count
 * - Subscription status
 * - Notification center
 * - Recent activity log
 * - API health / connectivity status
 *
 * Production mode 預留：
 * - POST /api/subscribe
 * - GET /api/health
 * - AWS API Gateway + Lambda + SNS / SES / DynamoDB
 */

// ============================================================
// Runtime helpers
// ============================================================

let queueTask;
if (typeof queueMicrotask === "function") {
    queueTask = queueMicrotask;
} else {
    queueTask = (callback) => Promise.resolve().then(callback);
}

function pathRelates(a, b) {
    return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowISO() {
    return new Date().toISOString();
}

function formatDateTime(value = Date.now()) {
    try {
        return new Date(value).toLocaleString("zh-TW");
    } catch {
        return new Date().toLocaleString("zh-TW");
    }
}

function createId(prefix = "id") {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

// ============================================================
// App config
// ============================================================

const CONFIG = {
    /**
     * "demo":
     * - localStorage 模擬訂閱服務
     * - 適合課堂 Demo、GitHub Pages、靜態網頁展示
     *
     * "production":
     * - 呼叫後端 API
     * - 預期架構：API Gateway -> Lambda -> SNS / SES / DynamoDB
     */
    MODE: "demo",

    APP_NAME: "Traffic Data Pipeline SaaS",

    STORAGE_KEYS: {
        subscribers: "traffic_saas_subscribers",
        notifications: "traffic_saas_notifications",
        activities: "traffic_saas_activities",
        subscriptionStatus: "traffic_saas_subscription_status"
    },

    ENDPOINTS: {
        dashboard: "./dashboard_data.json",
        subscribe: "/api/subscribe",
        health: "/api/health"
    },

    DEMO: {
        subscribeDelayMs: 700,
        healthDelayMs: 300,
        maxNotifications: 8,
        maxActivities: 10,
        baseSubscriberCount: 128
    }
};

// ============================================================
// Reactive state
// ============================================================

class ReactiveState {
    constructor(initialState = {}) {
        this.subscribers = new Map();
        this.effects = new Set();
        this.computedCache = new Map();
        this.computedDeps = new Map();
        this.rawToProxy = new WeakMap();
        this.pendingChanges = new Map();
        this.batchDepth = 0;
        this.flushScheduled = false;
        this.state = this.createProxy(initialState);
    }

    createProxy(obj, basePath = "") {
        if (!obj || typeof obj !== "object") return obj;
        if (this.rawToProxy.has(obj)) return this.rawToProxy.get(obj);

        const proxy = new Proxy(obj, {
            get: (target, key, receiver) => {
                const value = Reflect.get(target, key, receiver);
                if (!value || typeof value !== "object") return value;

                const childPath = basePath
                    ? `${basePath}.${String(key)}`
                    : String(key);

                return this.createProxy(value, childPath);
            },

            set: (target, key, value, receiver) => {
                const fullPath = basePath
                    ? `${basePath}.${String(key)}`
                    : String(key);

                const oldValue = target[key];

                const nextValue = value && typeof value === "object"
                    ? this.createProxy(value, fullPath)
                    : value;

                if (Object.is(oldValue, nextValue)) return true;

                const ok = Reflect.set(target, key, nextValue, receiver);

                if (ok) {
                    this.queueChange(fullPath, nextValue, oldValue);
                }

                return ok;
            },

            deleteProperty: (target, key) => {
                if (!Object.prototype.hasOwnProperty.call(target, key)) {
                    return true;
                }

                const fullPath = basePath
                    ? `${basePath}.${String(key)}`
                    : String(key);

                const oldValue = target[key];
                const ok = Reflect.deleteProperty(target, key);

                if (ok) {
                    this.queueChange(fullPath, undefined, oldValue);
                }

                return ok;
            }
        });

        this.rawToProxy.set(obj, proxy);
        return proxy;
    }

    queueChange(path, newValue, oldValue) {
        const previous = this.pendingChanges.get(path);

        this.pendingChanges.set(path, {
            newValue,
            oldValue: previous ? previous.oldValue : oldValue
        });

        if (this.batchDepth > 0 || this.flushScheduled) return;

        this.flushScheduled = true;
        queueTask(() => this.flush());
    }

    flush() {
        this.flushScheduled = false;

        if (this.pendingChanges.size === 0) return;

        const changes = new Map(this.pendingChanges);
        this.pendingChanges.clear();

        for (const changedPath of changes.keys()) {
            this.invalidateComputed(changedPath);
        }

        this.notifySubscribers(changes);
        this.runEffects(changes);
    }

    notifySubscribers(changes) {
        for (const [subPath, callbacks] of this.subscribers.entries()) {
            const matched = [...changes.entries()].find(([changedPath]) =>
                pathRelates(subPath, changedPath)
            );

            if (!matched) continue;

            const [changedPath, change] = matched;

            for (const callback of callbacks) {
                try {
                    callback(change.newValue, change.oldValue, changedPath);
                } catch (error) {
                    console.error(`Subscriber error at ${subPath}:`, error);
                }
            }
        }
    }

    invalidateComputed(changedPath) {
        for (const [key, deps] of this.computedDeps.entries()) {
            const shouldInvalidate = [...deps].some((dep) =>
                pathRelates(dep, changedPath)
            );

            if (shouldInvalidate) {
                this.computedCache.delete(key);
            }
        }
    }

    runEffects(changes) {
        for (const effect of this.effects) {
            if (effect.deps.size === 0) continue;

            const shouldRun = [...effect.deps].some((dep) =>
                [...changes.keys()].some((changedPath) =>
                    pathRelates(dep, changedPath)
                )
            );

            if (!shouldRun) continue;

            try {
                if (typeof effect.cleanup === "function") {
                    effect.cleanup();
                }

                effect.cleanup = effect.fn() || null;
            } catch (error) {
                console.error("Effect error:", error);
            }
        }
    }

    subscribe(path, callback) {
        if (!this.subscribers.has(path)) {
            this.subscribers.set(path, new Set());
        }

        this.subscribers.get(path).add(callback);

        return () => this.subscribers.get(path)?.delete(callback);
    }

    defineComputed(key, computeFn, dependencies = []) {
        this.computedDeps.set(key, new Set(dependencies));

        return {
            get: () => {
                if (!this.computedCache.has(key)) {
                    this.computedCache.set(key, computeFn(this.state));
                }

                return this.computedCache.get(key);
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

        try {
            effect.cleanup = effect.fn() || null;
        } catch (error) {
            console.error("Effect init error:", error);
        }

        return () => {
            if (typeof effect.cleanup === "function") {
                effect.cleanup();
            }

            this.effects.delete(effect);
        };
    }

    batch(updateFn) {
        this.batchDepth += 1;

        try {
            updateFn(this.state);
        } finally {
            this.batchDepth -= 1;

            if (this.batchDepth === 0) {
                this.flush();
            }
        }
    }
}

const store = new ReactiveState({
    data: {
        dashboard: null,
        isDataLoaded: false,
        lastLoadedAt: null
    },

    auth: {
        isLoggedIn: false,
        token: null,
        email: null
    },

    ui: {
        loading: false,
        error: null,
        charts: {},
        toast: null
    },

    filters: {
        current: {
            month: "",
            gender: ""
        }
    },

    connectivity: {
        isOnline: navigator.onLine
    },

    system: {
        mode: CONFIG.MODE,
        apiStatus: "checking",
        apiMessage: "Checking service health...",
        lastHealthCheckAt: null
    },

    subscription: {
        status: "idle",
        email: null,
        subscribers: [],
        totalSubscribers: CONFIG.DEMO.baseSubscriberCount,
        todayDelta: 0,
        lastSubscribedAt: null,
        lastError: null
    },

    notifications: [],

    activities: []
});

// ============================================================
// Data field helpers
// ============================================================

const FIELD_CANDIDATES = {
    cause: [
        "肇因",
        "事故原因",
        "原因",
        "肇因研判子類別名稱-主要",
        "cause",
        "Cause",
        "category",
        "name"
    ],

    gender: [
        "性別",
        "gender",
        "Gender",
        "sex",
        "Sex"
    ],

    count: [
        "數量",
        "件數",
        "人數",
        "事故數",
        "count",
        "Count",
        "value",
        "Value"
    ],

    month: [
        "月份",
        "月",
        "month",
        "Month"
    ],

    total: [
        "最終可用樣本數",
        "樣本總數",
        "總樣本數",
        "total_samples",
        "total",
        "Total"
    ],

    maleAge: [
        "男性平均年齡",
        "男平均年齡",
        "male_age",
        "male_avg_age"
    ],

    femaleAge: [
        "女性平均年齡",
        "女平均年齡",
        "female_age",
        "female_avg_age"
    ],

    sig: [
        "統計顯著性",
        "顯著性",
        "significance",
        "p_value"
    ]
};

function pickField(obj, candidates) {
    if (!obj) return undefined;

    const key = candidates.find((candidate) =>
        Object.prototype.hasOwnProperty.call(obj, candidate)
    );

    return key ? obj[key] : undefined;
}

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function formatValue(value) {
    return value === undefined || value === null || value === ""
        ? "--"
        : String(value);
}

function getCauseData(dashboard) {
    if (!dashboard) return [];
    if (Array.isArray(dashboard.cause_data)) return dashboard.cause_data;
    if (Array.isArray(dashboard.causes)) return dashboard.causes;
    if (Array.isArray(dashboard.data)) return dashboard.data;
    return [];
}

// ============================================================
// Storage service
// ============================================================

const StorageService = {
    isAvailable() {
        try {
            const key = "__traffic_saas_storage_test__";
            localStorage.setItem(key, "1");
            localStorage.removeItem(key);
            return true;
        } catch {
            return false;
        }
    },

    getJson(key, fallback) {
        if (!this.isAvailable()) return fallback;

        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (error) {
            console.warn(`Storage read failed: ${key}`, error);
            return fallback;
        }
    },

    setJson(key, value) {
        if (!this.isAvailable()) return false;

        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            console.warn(`Storage write failed: ${key}`, error);
            return false;
        }
    },

    remove(key) {
        if (!this.isAvailable()) return false;

        try {
            localStorage.removeItem(key);
            return true;
        } catch (error) {
            console.warn(`Storage remove failed: ${key}`, error);
            return false;
        }
    }
};

// ============================================================
// API client
// ============================================================

const APIClient = {
    async fetchJson(url, options = {}) {
        const response = await fetch(url, {
            cache: "no-store",
            ...options
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return response.json();
    },

    async postJson(url, payload, options = {}) {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(options.headers || {})
            },
            body: JSON.stringify(payload),
            ...options
        });

        if (!response.ok) {
            let message = `HTTP ${response.status}`;

            try {
                const errorBody = await response.json();
                message = errorBody.message || errorBody.error || message;
            } catch {
                // Ignore non-JSON error response.
            }

            throw new Error(message);
        }

        return response.json();
    }
};

// ============================================================
// Notification service
// ============================================================

const NotificationService = {
    load() {
        const notifications = StorageService.getJson(
            CONFIG.STORAGE_KEYS.notifications,
            []
        );

        store.state.notifications = Array.isArray(notifications)
            ? notifications.slice(0, CONFIG.DEMO.maxNotifications)
            : [];
    },

    persist() {
        StorageService.setJson(
            CONFIG.STORAGE_KEYS.notifications,
            [...store.state.notifications]
        );
    },

    push({
        type = "info",
        title = "系統通知",
        message = "",
        meta = null
    }) {
        const notification = {
            id: createId("noti"),
            type,
            title,
            message,
            meta,
            createdAt: nowISO(),
            read: false
        };

        const next = [
            notification,
            ...store.state.notifications
        ].slice(0, CONFIG.DEMO.maxNotifications);

        store.state.notifications = next;
        this.persist();
        UI.showToast(notification);

        return notification;
    },

    markAllRead() {
        store.state.notifications = store.state.notifications.map((item) => ({
            ...item,
            read: true
        }));

        this.persist();
    },

    clear() {
        store.state.notifications = [];
        this.persist();
    }
};

// ============================================================
// Activity log service
// ============================================================

const ActivityLogService = {
    load() {
        const activities = StorageService.getJson(
            CONFIG.STORAGE_KEYS.activities,
            []
        );

        store.state.activities = Array.isArray(activities)
            ? activities.slice(0, CONFIG.DEMO.maxActivities)
            : [];
    },

    persist() {
        StorageService.setJson(
            CONFIG.STORAGE_KEYS.activities,
            [...store.state.activities]
        );
    },

    log(action, detail = "", meta = null) {
        const activity = {
            id: createId("act"),
            action,
            detail,
            meta,
            createdAt: nowISO()
        };

        const next = [
            activity,
            ...store.state.activities
        ].slice(0, CONFIG.DEMO.maxActivities);

        store.state.activities = next;
        this.persist();

        return activity;
    },

    clear() {
        store.state.activities = [];
        this.persist();
    }
};

// ============================================================
// Auth service
// ============================================================

const AuthService = {
    validateEmail(email) {
        return typeof email === "string"
            && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    },

    login(email, password) {
        if (!this.validateEmail(email)) {
            throw new Error("請輸入有效的 Email");
        }

        if (!password) {
            throw new Error("請輸入密碼");
        }

        const token = btoa(`demo:${email}:${Date.now()}`);

        sessionStorage.setItem("saas_demo_token", token);

        store.batch((state) => {
            state.auth.isLoggedIn = true;
            state.auth.token = token;
            state.auth.email = email;
            state.ui.error = null;
        });

        ActivityLogService.log("會員登入", `登入帳號：${email}`);

        NotificationService.push({
            type: "success",
            title: "會員登入成功",
            message: `歡迎回來，${email}`
        });
    },

    logout() {
        const email = store.state.auth.email;

        sessionStorage.removeItem("saas_demo_token");

        store.batch((state) => {
            state.auth.isLoggedIn = false;
            state.auth.token = null;
            state.auth.email = null;
        });

        ActivityLogService.log("會員登出", email ? `登出帳號：${email}` : "使用者已登出");

        NotificationService.push({
            type: "info",
            title: "已登出",
            message: "目前已切換回訪客模式"
        });
    },

    restoreSession() {
        const token = sessionStorage.getItem("saas_demo_token");

        if (!token) return;

        try {
            const email = atob(token).split(":")[1] || null;

            store.batch((state) => {
                state.auth.isLoggedIn = Boolean(email);
                state.auth.email = email;
                state.auth.token = token;
            });

            if (email) {
                ActivityLogService.log("自動恢復登入", `目前會員：${email}`);
            }
        } catch {
            sessionStorage.removeItem("saas_demo_token");
        }
    }
};

// ============================================================
// Subscription service
// ============================================================

const SubscriptionService = {
    load() {
        const subscribers = StorageService.getJson(
            CONFIG.STORAGE_KEYS.subscribers,
            []
        );

        const subscriptionStatus = StorageService.getJson(
            CONFIG.STORAGE_KEYS.subscriptionStatus,
            null
        );

        const safeSubscribers = Array.isArray(subscribers)
            ? subscribers
            : [];

        store.batch((state) => {
            state.subscription.subscribers = safeSubscribers;
            state.subscription.totalSubscribers =
                CONFIG.DEMO.baseSubscriberCount + safeSubscribers.length;
            state.subscription.todayDelta =
                this.countTodaySubscribers(safeSubscribers);

            if (subscriptionStatus) {
                state.subscription.status = subscriptionStatus.status || "idle";
                state.subscription.email = subscriptionStatus.email || null;
                state.subscription.lastSubscribedAt =
                    subscriptionStatus.lastSubscribedAt || null;
            }
        });
    },

    persist() {
        StorageService.setJson(
            CONFIG.STORAGE_KEYS.subscribers,
            [...store.state.subscription.subscribers]
        );

        StorageService.setJson(
            CONFIG.STORAGE_KEYS.subscriptionStatus,
            {
                status: store.state.subscription.status,
                email: store.state.subscription.email,
                lastSubscribedAt: store.state.subscription.lastSubscribedAt
            }
        );
    },

    countTodaySubscribers(subscribers) {
        const today = new Date().toISOString().slice(0, 10);

        return subscribers.filter((subscriber) =>
            String(subscriber.createdAt || "").slice(0, 10) === today
        ).length;
    },

    hasSubscribed(email) {
        return store.state.subscription.subscribers.some((subscriber) =>
            String(subscriber.email).toLowerCase() === String(email).toLowerCase()
        );
    },

    async subscribe(email) {
        if (!AuthService.validateEmail(email)) {
            throw new Error("請輸入有效的 Email");
        }

        store.batch((state) => {
            state.subscription.status = "pending";
            state.subscription.email = email;
            state.subscription.lastError = null;
        });

        ActivityLogService.log("建立訂閱請求", `送出訂閱 Email：${email}`);

        if (CONFIG.MODE === "production") {
            return this.subscribeProduction(email);
        }

        return this.subscribeDemo(email);
    },

    async subscribeDemo(email) {
        await sleep(CONFIG.DEMO.subscribeDelayMs);

        const alreadySubscribed = this.hasSubscribed(email);

        let nextSubscribers = [...store.state.subscription.subscribers];

        if (!alreadySubscribed) {
            nextSubscribers = [
                {
                    id: createId("sub"),
                    email,
                    status: "active",
                    source: "demo",
                    createdAt: nowISO()
                },
                ...nextSubscribers
            ];
        }

        store.batch((state) => {
            state.subscription.subscribers = nextSubscribers;
            state.subscription.status = alreadySubscribed ? "active" : "active";
            state.subscription.email = email;
            state.subscription.totalSubscribers =
                CONFIG.DEMO.baseSubscriberCount + nextSubscribers.length;
            state.subscription.todayDelta =
                this.countTodaySubscribers(nextSubscribers);
            state.subscription.lastSubscribedAt = nowISO();
            state.subscription.lastError = null;
        });

        this.persist();

        const message = alreadySubscribed
            ? `${email} 已經在訂閱名單中`
            : `已建立 Demo 訂閱：${email}`;

        ActivityLogService.log("訂閱成功", message);

        NotificationService.push({
            type: "success",
            title: "訂閱成功",
            message: CONFIG.MODE === "demo"
                ? `Demo 模式：${email} 已加入資料更新通知`
                : `已送出訂閱確認信到 ${email}`
        });

        return {
            ok: true,
            mode: "demo",
            email,
            alreadySubscribed,
            status: "active"
        };
    },

    async subscribeProduction(email) {
        try {
            const result = await APIClient.postJson(
                CONFIG.ENDPOINTS.subscribe,
                {
                    email,
                    source: "web-dashboard",
                    requestedAt: nowISO()
                }
            );

            store.batch((state) => {
                state.subscription.status = result.status || "pending";
                state.subscription.email = email;
                state.subscription.lastSubscribedAt = nowISO();
                state.subscription.lastError = null;
            });

            this.persist();

            ActivityLogService.log(
                "正式環境訂閱請求成功",
                `已呼叫後端 API：${email}`
            );

            NotificationService.push({
                type: "success",
                title: "訂閱請求已送出",
                message: `正式環境：請到 ${email} 信箱確認訂閱`
            });

            return {
                ok: true,
                mode: "production",
                email,
                status: result.status || "pending",
                result
            };
        } catch (error) {
            store.batch((state) => {
                state.subscription.status = "error";
                state.subscription.lastError = error.message;
            });

            ActivityLogService.log(
                "正式環境訂閱失敗",
                error.message,
                { email }
            );

            NotificationService.push({
                type: "error",
                title: "訂閱失敗",
                message: error.message
            });

            throw error;
        }
    },

    unsubscribeDemo(email) {
        const nextSubscribers = store.state.subscription.subscribers.filter(
            (subscriber) =>
                String(subscriber.email).toLowerCase() !== String(email).toLowerCase()
        );

        store.batch((state) => {
            state.subscription.subscribers = nextSubscribers;
            state.subscription.totalSubscribers =
                CONFIG.DEMO.baseSubscriberCount + nextSubscribers.length;
            state.subscription.todayDelta =
                this.countTodaySubscribers(nextSubscribers);

            if (state.subscription.email === email) {
                state.subscription.status = "idle";
                state.subscription.email = null;
            }
        });

        this.persist();

        ActivityLogService.log("取消訂閱", `已移除 Demo 訂閱：${email}`);

        NotificationService.push({
            type: "info",
            title: "取消訂閱",
            message: `${email} 已從 Demo 訂閱名單移除`
        });
    }
};

// ============================================================
// Dashboard service
// ============================================================

const DashboardService = {
    async loadDashboard() {
        return APIClient.fetchJson(CONFIG.ENDPOINTS.dashboard);
    },

    applyFilters(rows, filters) {
        if (!Array.isArray(rows)) return [];

        return rows.filter((row) => {
            const month = pickField(row, FIELD_CANDIDATES.month);
            const gender = pickField(row, FIELD_CANDIDATES.gender);

            const monthOk = !filters.month || String(month) === String(filters.month);
            const genderOk = !filters.gender || String(gender) === String(filters.gender);

            return monthOk && genderOk;
        });
    },

    groupByCause(rows, limit = 15) {
        const totals = new Map();

        for (const row of rows) {
            const cause = formatValue(pickField(row, FIELD_CANDIDATES.cause));
            const count = toNumber(pickField(row, FIELD_CANDIDATES.count));

            totals.set(cause, (totals.get(cause) || 0) + count);
        }

        return [...totals.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit);
    },

    groupByMonth(rows) {
        const totals = new Map();

        for (const row of rows) {
            const month = formatValue(pickField(row, FIELD_CANDIDATES.month));
            const count = toNumber(pickField(row, FIELD_CANDIDATES.count));

            totals.set(month, (totals.get(month) || 0) + count);
        }

        return [...totals.entries()].sort((a, b) =>
            String(a[0]).localeCompare(String(b[0]), "zh-Hant")
        );
    },

    uniqueValues(rows, candidates) {
        return [
            ...new Set(
                rows
                    .map((row) => pickField(row, candidates))
                    .filter(Boolean)
            )
        ].sort((a, b) => String(a).localeCompare(String(b), "zh-Hant"));
    }
};

// ============================================================
// System service
// ============================================================

const SystemService = {
    async checkHealth() {
        store.state.system.apiStatus = "checking";
        store.state.system.apiMessage = "Checking service health...";

        if (CONFIG.MODE === "demo") {
            await sleep(CONFIG.DEMO.healthDelayMs);

            store.batch((state) => {
                state.system.mode = "demo";
                state.system.apiStatus = "healthy";
                state.system.apiMessage = "Demo service is running locally";
                state.system.lastHealthCheckAt = nowISO();
            });

            return {
                ok: true,
                mode: "demo"
            };
        }

        try {
            const result = await APIClient.fetchJson(CONFIG.ENDPOINTS.health);

            store.batch((state) => {
                state.system.mode = "production";
                state.system.apiStatus = result.status || "healthy";
                state.system.apiMessage = result.message || "Production API is healthy";
                state.system.lastHealthCheckAt = nowISO();
            });

            return result;
        } catch (error) {
            store.batch((state) => {
                state.system.mode = "production";
                state.system.apiStatus = "error";
                state.system.apiMessage = error.message;
                state.system.lastHealthCheckAt = nowISO();
            });

            NotificationService.push({
                type: "error",
                title: "API Health Check Failed",
                message: error.message
            });

            throw error;
        }
    }
};

// ============================================================
// Computed values
// ============================================================

const computed = {
    filteredRows: store.defineComputed(
        "filteredRows",
        (state) =>
            DashboardService.applyFilters(
                getCauseData(state.data.dashboard),
                state.filters.current
            ),
        [
            "data.dashboard",
            "filters.current.month",
            "filters.current.gender"
        ]
    ),

    unreadNotifications: store.defineComputed(
        "unreadNotifications",
        (state) => state.notifications.filter((item) => !item.read).length,
        ["notifications"]
    )
};

// ============================================================
// UI service
// ============================================================

const UI = {
    setHidden(id, hidden) {
        const el = document.getElementById(id);
        if (el) el.hidden = hidden;
    },

    setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = formatValue(value);
    },

    setHTML(id, html) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    },

    showError(message) {
        const el = document.getElementById("error-banner");
        if (!el) return;

        el.textContent = message;
        el.hidden = !message;
    },

    showToast(notification) {
        const existing = document.getElementById("toast-container");

        const container = existing || document.createElement("div");
        container.id = "toast-container";
        container.className = "toast-container";

        if (!existing) {
            document.body.appendChild(container);
        }

        const toast = document.createElement("div");
        toast.className = `toast toast-${notification.type || "info"}`;

        toast.innerHTML = `
            <strong>${formatValue(notification.title)}</strong>
            <span>${formatValue(notification.message)}</span>
        `;

        container.appendChild(toast);

        window.setTimeout(() => {
            toast.classList.add("leaving");

            window.setTimeout(() => {
                toast.remove();

                if (!container.children.length) {
                    container.remove();
                }
            }, 250);
        }, 3000);
    },

    renderStats(dashboard) {
        const stats = dashboard?.stats_summary || dashboard?.stats || {};

        UI.setText("total-samples", pickField(stats, FIELD_CANDIDATES.total));
        UI.setText("male-age", pickField(stats, FIELD_CANDIDATES.maleAge));
        UI.setText("female-age", pickField(stats, FIELD_CANDIDATES.femaleAge));
        UI.setText("sig-level", pickField(stats, FIELD_CANDIDATES.sig));
    },

    populateFilters(rows) {
        const monthSelect = document.getElementById("filter-month");
        const genderSelect = document.getElementById("filter-gender");

        if (!monthSelect || !genderSelect) return;

        const currentMonth = monthSelect.value;
        const currentGender = genderSelect.value;

        monthSelect.innerHTML = `<option value="">全部月份</option>`;
        genderSelect.innerHTML = `<option value="">全部性別</option>`;

        for (const month of DashboardService.uniqueValues(rows, FIELD_CANDIDATES.month)) {
            monthSelect.add(new Option(String(month), String(month)));
        }

        for (const gender of DashboardService.uniqueValues(rows, FIELD_CANDIDATES.gender)) {
            genderSelect.add(new Option(String(gender), String(gender)));
        }

        monthSelect.value = currentMonth;
        genderSelect.value = currentGender;
    },

    renderCauseChart(rows, targetId = "cause-chart") {
        const el = document.getElementById(targetId);

        if (!el || !window.echarts) return;

        const grouped = DashboardService.groupByCause(rows);
        const chart = echarts.getInstanceByDom(el) || echarts.init(el);

        chart.setOption({
            tooltip: {
                trigger: "axis",
                axisPointer: {
                    type: "shadow"
                }
            },

            grid: {
                left: 140,
                right: 28,
                top: 24,
                bottom: 36
            },

            xAxis: {
                type: "value",
                name: "數量"
            },

            yAxis: {
                type: "category",
                data: grouped.map(([cause]) => cause).reverse(),
                axisLabel: {
                    width: 125,
                    overflow: "truncate"
                }
            },

            series: [
                {
                    name: "事故數",
                    type: "bar",
                    data: grouped.map(([, count]) => count).reverse(),
                    itemStyle: {
                        color: "#2563eb",
                        borderRadius: [0, 4, 4, 0]
                    }
                }
            ]
        });

        chart.resize();
    },

    renderTrendChart(rows) {
        const el = document.getElementById("trend-chart");

        if (!el || !window.echarts) return;

        const grouped = DashboardService.groupByMonth(rows);
        const chart = echarts.getInstanceByDom(el) || echarts.init(el);

        chart.setOption({
            tooltip: {
                trigger: "axis"
            },

            grid: {
                left: 56,
                right: 24,
                top: 28,
                bottom: 44
            },

            xAxis: {
                type: "category",
                data: grouped.map(([month]) => month)
            },

            yAxis: {
                type: "value",
                name: "數量"
            },

            series: [
                {
                    name: "事故數",
                    type: "line",
                    smooth: true,
                    data: grouped.map(([, count]) => count),
                    areaStyle: {
                        color: "rgba(15, 118, 110, 0.12)"
                    },
                    lineStyle: {
                        color: "#0f766e",
                        width: 3
                    },
                    itemStyle: {
                        color: "#0f766e"
                    }
                }
            ]
        });

        chart.resize();
    },

    renderAuth() {
        const loggedIn = store.state.auth.isLoggedIn;

        const badge = document.getElementById("user-status");
        const loginBtn = document.getElementById("login-btn");
        const logoutBtn = document.getElementById("logout-btn");
        const premium = document.getElementById("premium-section");
        const lockOverlay = document.getElementById("lock-overlay");

        if (badge) {
            badge.textContent = loggedIn
                ? `會員：${store.state.auth.email}`
                : "訪客模式";

            badge.className = `user-badge ${loggedIn ? "member" : "guest"}`;
        }

        if (loginBtn) loginBtn.hidden = loggedIn;
        if (logoutBtn) logoutBtn.hidden = !loggedIn;

        if (premium) {
            premium.classList.toggle("locked", !loggedIn);
            premium.classList.toggle("unlocked", loggedIn);
        }

        if (lockOverlay) {
            lockOverlay.hidden = loggedIn;
        }
    },

    renderFilteredResult(rows) {
        const result = document.getElementById("dynamic-result");

        if (!result) return;

        result.textContent = `目前篩選出 ${rows.length} 筆資料`;
        result.hidden = false;
    },

    renderSubscription() {
        const subscription = store.state.subscription;

        UI.setText("subscriber-count", subscription.totalSubscribers);
        UI.setText("subscriber-delta", `今日 +${subscription.todayDelta}`);
        UI.setText("subscription-email", subscription.email || "尚未訂閱");
        UI.setText("subscription-updated-at", subscription.lastSubscribedAt
            ? formatDateTime(subscription.lastSubscribedAt)
            : "--"
        );

        const statusTextMap = {
            idle: "尚未訂閱",
            pending: "訂閱處理中",
            active: "已訂閱",
            error: "訂閱失敗"
        };

        const statusEl = document.getElementById("subscription-status");

        if (statusEl) {
            statusEl.textContent = statusTextMap[subscription.status] || subscription.status;
            statusEl.className = `status-pill status-${subscription.status}`;
        }

        const list = document.getElementById("subscriber-list");

        if (list) {
            if (!subscription.subscribers.length) {
                list.innerHTML = `<li class="empty">目前尚無 Demo 訂閱資料</li>`;
                return;
            }

            list.innerHTML = subscription.subscribers
                .slice(0, 5)
                .map((subscriber) => `
                    <li>
                        <span>${formatValue(subscriber.email)}</span>
                        <small>${formatDateTime(subscriber.createdAt)}</small>
                    </li>
                `)
                .join("");
        }
    },

    renderNotifications() {
        const list = document.getElementById("notification-list");
        const count = document.getElementById("notification-count");

        const unread = computed.unreadNotifications.get();

        if (count) {
            count.textContent = String(unread);
            count.hidden = unread === 0;
        }

        if (!list) return;

        if (!store.state.notifications.length) {
            list.innerHTML = `<li class="empty">目前沒有通知</li>`;
            return;
        }

        list.innerHTML = store.state.notifications
            .map((notification) => `
                <li class="${notification.read ? "read" : "unread"}">
                    <div>
                        <strong>${formatValue(notification.title)}</strong>
                        <p>${formatValue(notification.message)}</p>
                    </div>
                    <time>${formatDateTime(notification.createdAt)}</time>
                </li>
            `)
            .join("");
    },

    renderActivities() {
        const list = document.getElementById("activity-list");

        if (!list) return;

        if (!store.state.activities.length) {
            list.innerHTML = `<li class="empty">尚無活動紀錄</li>`;
            return;
        }

        list.innerHTML = store.state.activities
            .map((activity) => `
                <li>
                    <div>
                        <strong>${formatValue(activity.action)}</strong>
                        <p>${formatValue(activity.detail)}</p>
                    </div>
                    <time>${formatDateTime(activity.createdAt)}</time>
                </li>
            `)
            .join("");
    },

    renderConnectivity() {
        const isOnline = store.state.connectivity.isOnline;
        const el = document.getElementById("connectivity-status");

        if (!el) return;

        el.textContent = isOnline ? "Online" : "Offline";
        el.className = `connectivity ${isOnline ? "online" : "offline"}`;
    },

    renderSystemStatus() {
        const system = store.state.system;

        UI.setText("app-mode", system.mode === "production" ? "Production" : "Demo");
        UI.setText("api-message", system.apiMessage);
        UI.setText("api-health-time", system.lastHealthCheckAt
            ? formatDateTime(system.lastHealthCheckAt)
            : "--"
        );

        const status = document.getElementById("api-status");

        if (status) {
            const labelMap = {
                checking: "Checking",
                healthy: "Healthy",
                error: "Error"
            };

            status.textContent = labelMap[system.apiStatus] || system.apiStatus;
            status.className = `status-pill status-${system.apiStatus}`;
        }
    }
};

// ============================================================
// Modal helpers
// ============================================================

function openLoginModal() {
    const modal = document.getElementById("login-modal");

    if (modal) {
        modal.hidden = false;
    }

    setTimeout(() => {
        document.getElementById("login-email")?.focus();
    }, 50);
}

function closeLoginModal() {
    const modal = document.getElementById("login-modal");
    const error = document.getElementById("login-error");

    if (modal) modal.hidden = true;
    if (error) error.hidden = true;
}

// ============================================================
// Effects
// ============================================================

function setupEffects() {
    store.effect(
        () => UI.setHidden("loader", !store.state.ui.loading),
        ["ui.loading"]
    );

    store.effect(
        () => UI.showError(store.state.ui.error),
        ["ui.error"]
    );

    store.effect(
        () => UI.renderAuth(),
        ["auth.isLoggedIn", "auth.email"]
    );

    store.effect(
        () => {
            const dashboard = store.state.data.dashboard;
            const rows = getCauseData(dashboard);

            UI.renderStats(dashboard);
            UI.populateFilters(rows);
        },
        ["data.dashboard"]
    );

    store.effect(
        () => {
            const rows = computed.filteredRows.get();

            UI.renderFilteredResult(rows);
            UI.renderCauseChart(rows, "dynamic-chart");
            UI.renderCauseChart(rows, "cause-chart");
            UI.renderTrendChart(rows);
        },
        [
            "data.dashboard",
            "filters.current.month",
            "filters.current.gender"
        ]
    );

    store.effect(
        () => UI.renderSubscription(),
        [
            "subscription.status",
            "subscription.email",
            "subscription.subscribers",
            "subscription.totalSubscribers",
            "subscription.todayDelta",
            "subscription.lastSubscribedAt"
        ]
    );

    store.effect(
        () => UI.renderNotifications(),
        ["notifications"]
    );

    store.effect(
        () => UI.renderActivities(),
        ["activities"]
    );

    store.effect(
        () => UI.renderConnectivity(),
        ["connectivity.isOnline"]
    );

    store.effect(
        () => UI.renderSystemStatus(),
        [
            "system.mode",
            "system.apiStatus",
            "system.apiMessage",
            "system.lastHealthCheckAt"
        ]
    );
}

// ============================================================
// Events
// ============================================================

function bindEvents() {
    document.getElementById("login-btn")
        ?.addEventListener("click", openLoginModal);

    document.getElementById("overlay-login-btn")
        ?.addEventListener("click", openLoginModal);

    document.getElementById("cancel-login-btn")
        ?.addEventListener("click", closeLoginModal);

    document.getElementById("logout-btn")
        ?.addEventListener("click", () => AuthService.logout());

    document.getElementById("login-modal")
        ?.addEventListener("click", (event) => {
            if (event.target === event.currentTarget) {
                closeLoginModal();
            }
        });

    document.getElementById("do-login-btn")
        ?.addEventListener("click", () => {
            const email = document.getElementById("login-email")?.value.trim() || "";
            const password = document.getElementById("login-password")?.value || "";
            const error = document.getElementById("login-error");

            try {
                AuthService.login(email, password);
                closeLoginModal();
            } catch (err) {
                if (error) {
                    error.textContent = err.message;
                    error.hidden = false;
                }
            }
        });

    ["login-email", "login-password"].forEach((id) => {
        document.getElementById(id)
            ?.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    document.getElementById("do-login-btn")?.click();
                }
            });
    });

    document.getElementById("query-btn")
        ?.addEventListener("click", () => {
            const month = document.getElementById("filter-month")?.value || "";
            const gender = document.getElementById("filter-gender")?.value || "";

            store.state.filters.current = {
                month,
                gender
            };

            const detail = [
                month ? `月份=${month}` : "月份=全部",
                gender ? `性別=${gender}` : "性別=全部"
            ].join("，");

            ActivityLogService.log("資料篩選", detail);

            NotificationService.push({
                type: "info",
                title: "查詢條件已套用",
                message: detail
            });
        });

    document.getElementById("sub-btn")
        ?.addEventListener("click", async () => {
            const email = document.getElementById("sub-email")?.value.trim() || "";
            const button = document.getElementById("sub-btn");
            const result = document.getElementById("sub-result");
            const input = document.getElementById("sub-email");

            if (!AuthService.validateEmail(email)) {
                if (result) {
                    result.textContent = "請輸入有效的 Email";
                    result.className = "sub-result error";
                    result.hidden = false;
                }

                NotificationService.push({
                    type: "error",
                    title: "Email 格式錯誤",
                    message: "請輸入有效的訂閱 Email"
                });

                return;
            }

            if (button) {
                button.disabled = true;
                button.textContent = "訂閱中...";
            }

            if (result) {
                result.textContent = "正在建立訂閱，請稍候...";
                result.className = "sub-result pending";
                result.hidden = false;
            }

            try {
                const response = await SubscriptionService.subscribe(email);

                if (result) {
                    result.textContent = response.alreadySubscribed
                        ? `${email} 已經訂閱過資料更新通知`
                        : CONFIG.MODE === "demo"
                            ? `Demo 模式：${email} 已成功訂閱資料更新通知`
                            : `已送出訂閱確認信到 ${email}`;

                    result.className = "sub-result success";
                    result.hidden = false;
                }

                if (input && !response.alreadySubscribed) {
                    input.value = "";
                }
            } catch (error) {
                if (result) {
                    result.textContent = `訂閱失敗：${error.message}`;
                    result.className = "sub-result error";
                    result.hidden = false;
                }
            } finally {
                if (button) {
                    button.disabled = false;
                    button.textContent = "訂閱通知";
                }
            }
        });

    document.getElementById("mark-notifications-read-btn")
        ?.addEventListener("click", () => {
            NotificationService.markAllRead();
            ActivityLogService.log("通知中心", "已將所有通知標記為已讀");
        });

    document.getElementById("clear-activity-btn")
        ?.addEventListener("click", () => {
            ActivityLogService.clear();

            NotificationService.push({
                type: "info",
                title: "活動紀錄已清除",
                message: "Recent Activity 已重置"
            });
        });

    document.getElementById("health-check-btn")
        ?.addEventListener("click", async () => {
            try {
                await SystemService.checkHealth();

                ActivityLogService.log(
                    "系統健康檢查",
                    store.state.system.apiMessage
                );

                NotificationService.push({
                    type: "success",
                    title: "系統狀態正常",
                    message: store.state.system.apiMessage
                });
            } catch (error) {
                ActivityLogService.log(
                    "系統健康檢查失敗",
                    error.message
                );
            }
        });

    window.addEventListener("resize", () => {
        document.querySelectorAll(".chart").forEach((el) => {
            if (window.echarts) {
                echarts.getInstanceByDom(el)?.resize();
            }
        });
    });

    window.addEventListener("online", () => {
        store.state.connectivity.isOnline = true;

        ActivityLogService.log("網路狀態", "Browser is online");

        NotificationService.push({
            type: "success",
            title: "網路已恢復",
            message: "Browser is online"
        });
    });

    window.addEventListener("offline", () => {
        store.state.connectivity.isOnline = false;

        ActivityLogService.log("網路狀態", "Browser is offline");

        NotificationService.push({
            type: "warning",
            title: "網路中斷",
            message: "目前瀏覽器處於離線狀態"
        });
    });
}

// ============================================================
// App lifecycle
// ============================================================

async function loadDashboard() {
    store.state.ui.loading = true;

    try {
        const data = await DashboardService.loadDashboard();

        store.batch((state) => {
            state.data.dashboard = data;
            state.data.isDataLoaded = true;
            state.data.lastLoadedAt = nowISO();
            state.ui.error = null;
            state.ui.loading = false;
        });

        ActivityLogService.log(
            "Dashboard 載入完成",
            "dashboard_data.json 已成功載入"
        );

        NotificationService.push({
            type: "success",
            title: "資料載入完成",
            message: "交通事故 Dashboard 資料已更新"
        });
    } catch (error) {
        store.batch((state) => {
            state.ui.error = `dashboard_data.json 載入失敗：${error.message}`;
            state.ui.loading = false;
        });

        ActivityLogService.log(
            "Dashboard 載入失敗",
            error.message
        );

        NotificationService.push({
            type: "error",
            title: "資料載入失敗",
            message: error.message
        });
    }
}

function bootstrapStoredState() {
    NotificationService.load();
    ActivityLogService.load();
    SubscriptionService.load();
}

function renderInitialStaticInfo() {
    const updateTime = document.getElementById("update-time");

    if (updateTime) {
        updateTime.textContent = new Date().toLocaleString("zh-TW");
    }

    UI.renderSubscription();
    UI.renderNotifications();
    UI.renderActivities();
    UI.renderConnectivity();
    UI.renderSystemStatus();
}

document.addEventListener("DOMContentLoaded", async () => {
    bootstrapStoredState();
    setupEffects();
    bindEvents();

    renderInitialStaticInfo();

    AuthService.restoreSession();

    ActivityLogService.log(
        "App Started",
        `${CONFIG.APP_NAME} initialized in ${CONFIG.MODE} mode`
    );

    try {
        await SystemService.checkHealth();
    } catch {
        // Health check error already handled in SystemService.
    }

    await loadDashboard();
});

// ============================================================
// Debug exports
// ============================================================

window.reactiveState = store;
window.CONFIG = CONFIG;
window.AuthService = AuthService;
window.SubscriptionService = SubscriptionService;
window.NotificationService = NotificationService;
window.ActivityLogService = ActivityLogService;
window.SystemService = SystemService;
window.openLoginModal = openLoginModal;

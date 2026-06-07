"use strict";

let queueTask;
if (typeof queueMicrotask === "function") {
    queueTask = queueMicrotask;
} else {
    queueTask = (callback) => Promise.resolve().then(callback);
}

function pathRelates(a, b) {
    return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

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
                const childPath = basePath ? `${basePath}.${String(key)}` : String(key);
                return this.createProxy(value, childPath);
            },
            set: (target, key, value, receiver) => {
                const fullPath = basePath ? `${basePath}.${String(key)}` : String(key);
                const oldValue = target[key];
                const nextValue = value && typeof value === "object"
                    ? this.createProxy(value, fullPath)
                    : value;

                if (Object.is(oldValue, nextValue)) return true;
                const ok = Reflect.set(target, key, nextValue, receiver);
                if (ok) this.queueChange(fullPath, nextValue, oldValue);
                return ok;
            },
            deleteProperty: (target, key) => {
                if (!Object.prototype.hasOwnProperty.call(target, key)) return true;
                const fullPath = basePath ? `${basePath}.${String(key)}` : String(key);
                const oldValue = target[key];
                const ok = Reflect.deleteProperty(target, key);
                if (ok) this.queueChange(fullPath, undefined, oldValue);
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
            const matched = [...changes.entries()].find(([changedPath]) => pathRelates(subPath, changedPath));
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
            if ([...deps].some((dep) => pathRelates(dep, changedPath))) {
                this.computedCache.delete(key);
            }
        }
    }

    runEffects(changes) {
        for (const effect of this.effects) {
            if (effect.deps.size === 0) continue;
            const shouldRun = [...effect.deps].some((dep) =>
                [...changes.keys()].some((changedPath) => pathRelates(dep, changedPath))
            );
            if (!shouldRun) continue;

            try {
                if (typeof effect.cleanup === "function") effect.cleanup();
                effect.cleanup = effect.fn() || null;
            } catch (error) {
                console.error("Effect error:", error);
            }
        }
    }

    subscribe(path, callback) {
        if (!this.subscribers.has(path)) this.subscribers.set(path, new Set());
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
        const effect = { fn, deps: new Set(dependencies), cleanup: null };
        this.effects.add(effect);
        try {
            effect.cleanup = effect.fn() || null;
        } catch (error) {
            console.error("Effect init error:", error);
        }
        return () => {
            if (typeof effect.cleanup === "function") effect.cleanup();
            this.effects.delete(effect);
        };
    }

    batch(updateFn) {
        this.batchDepth += 1;
        try {
            updateFn(this.state);
        } finally {
            this.batchDepth -= 1;
            if (this.batchDepth === 0) this.flush();
        }
    }
}

const store = new ReactiveState({
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
        charts: {}
    },
    filters: {
        current: {
            month: "",
            gender: ""
        }
    },
    connectivity: {
        isOnline: navigator.onLine
    }
});

const FIELD_CANDIDATES = {
    cause: ["事故原因", "原因", "cause", "Cause", "category", "name"],
    gender: ["性別", "gender", "Gender", "sex", "Sex"],
    count: ["數量", "件數", "人數", "事故數", "count", "Count", "value", "Value"],
    month: ["月份", "月", "month", "Month"],
    total: ["樣本總數", "總樣本數", "total_samples", "total", "Total"],
    maleAge: ["男性平均年齡", "男平均年齡", "male_age", "male_avg_age"],
    femaleAge: ["女性平均年齡", "女平均年齡", "female_age", "female_avg_age"],
    sig: ["統計顯著性", "顯著性", "significance", "p_value"]
};

function pickField(obj, candidates) {
    if (!obj) return undefined;
    const key = candidates.find((candidate) => Object.prototype.hasOwnProperty.call(obj, candidate));
    return key ? obj[key] : undefined;
}

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function formatValue(value) {
    return value === undefined || value === null || value === "" ? "--" : String(value);
}

function getCauseData(dashboard) {
    if (!dashboard) return [];
    if (Array.isArray(dashboard.cause_data)) return dashboard.cause_data;
    if (Array.isArray(dashboard.causes)) return dashboard.causes;
    if (Array.isArray(dashboard.data)) return dashboard.data;
    return [];
}

const APIClient = {
    async fetchJson(url) {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }
};

const AuthService = {
    validateEmail(email) {
        return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    },
    login(email, password) {
        if (!this.validateEmail(email)) throw new Error("請輸入有效的 Email");
        if (!password) throw new Error("請輸入密碼");

        const token = btoa(`demo:${email}:${Date.now()}`);
        sessionStorage.setItem("saas_demo_token", token);
        store.batch((state) => {
            state.auth.isLoggedIn = true;
            state.auth.token = token;
            state.auth.email = email;
            state.ui.error = null;
        });
    },
    logout() {
        sessionStorage.removeItem("saas_demo_token");
        store.batch((state) => {
            state.auth.isLoggedIn = false;
            state.auth.token = null;
            state.auth.email = null;
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
        } catch {
            sessionStorage.removeItem("saas_demo_token");
        }
    }
};

const DashboardService = {
    async loadDashboard() {
        return APIClient.fetchJson("./dashboard_data.json");
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
        return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    },
    groupByMonth(rows) {
        const totals = new Map();
        for (const row of rows) {
            const month = formatValue(pickField(row, FIELD_CANDIDATES.month));
            const count = toNumber(pickField(row, FIELD_CANDIDATES.count));
            totals.set(month, (totals.get(month) || 0) + count);
        }
        return [...totals.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "zh-Hant"));
    },
    uniqueValues(rows, candidates) {
        return [...new Set(rows.map((row) => pickField(row, candidates)).filter(Boolean))]
            .sort((a, b) => String(a).localeCompare(String(b), "zh-Hant"));
    }
};

const computed = {
    filteredRows: store.defineComputed(
        "filteredRows",
        (state) => DashboardService.applyFilters(getCauseData(state.data.dashboard), state.filters.current),
        ["data.dashboard", "filters.current.month", "filters.current.gender"]
    )
};

const UI = {
    setHidden(id, hidden) {
        const el = document.getElementById(id);
        if (el) el.hidden = hidden;
    },
    setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = formatValue(value);
    },
    showError(message) {
        const el = document.getElementById("error-banner");
        if (!el) return;
        el.textContent = message;
        el.hidden = !message;
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
            tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
            grid: { left: 140, right: 28, top: 24, bottom: 36 },
            xAxis: { type: "value", name: "數量" },
            yAxis: {
                type: "category",
                data: grouped.map(([cause]) => cause).reverse(),
                axisLabel: { width: 125, overflow: "truncate" }
            },
            series: [{
                name: "事故數",
                type: "bar",
                data: grouped.map(([, count]) => count).reverse(),
                itemStyle: { color: "#2563eb", borderRadius: [0, 4, 4, 0] }
            }]
        });
        chart.resize();
    },
    renderTrendChart(rows) {
        const el = document.getElementById("trend-chart");
        if (!el || !window.echarts) return;

        const grouped = DashboardService.groupByMonth(rows);
        const chart = echarts.getInstanceByDom(el) || echarts.init(el);
        chart.setOption({
            tooltip: { trigger: "axis" },
            grid: { left: 56, right: 24, top: 28, bottom: 44 },
            xAxis: { type: "category", data: grouped.map(([month]) => month) },
            yAxis: { type: "value", name: "數量" },
            series: [{
                name: "事故數",
                type: "line",
                smooth: true,
                data: grouped.map(([, count]) => count),
                areaStyle: { color: "rgba(15, 118, 110, 0.12)" },
                lineStyle: { color: "#0f766e", width: 3 },
                itemStyle: { color: "#0f766e" }
            }]
        });
        chart.resize();
    },
    renderAuth() {
        const loggedIn = store.state.auth.isLoggedIn;
        const badge = document.getElementById("user-status");
        const loginBtn = document.getElementById("login-btn");
        const logoutBtn = document.getElementById("logout-btn");
        const premium = document.getElementById("premium-section");

        if (badge) {
            badge.textContent = loggedIn ? `會員：${store.state.auth.email}` : "訪客模式";
            badge.className = `user-badge ${loggedIn ? "member" : "guest"}`;
        }
        if (loginBtn) loginBtn.hidden = loggedIn;
        if (logoutBtn) logoutBtn.hidden = !loggedIn;
        if (premium) {
            premium.classList.toggle("locked", !loggedIn);
            premium.classList.toggle("unlocked", loggedIn);
        }
    },
    renderFilteredResult(rows) {
        const result = document.getElementById("dynamic-result");
        if (!result) return;
        result.textContent = `目前篩選出 ${rows.length} 筆資料`;
        result.hidden = false;
    }
};

function openLoginModal() {
    const modal = document.getElementById("login-modal");
    if (modal) modal.hidden = false;
    setTimeout(() => document.getElementById("login-email")?.focus(), 50);
}

function closeLoginModal() {
    const modal = document.getElementById("login-modal");
    const error = document.getElementById("login-error");
    if (modal) modal.hidden = true;
    if (error) error.hidden = true;
}

function setupEffects() {
    store.effect(() => UI.setHidden("loader", !store.state.ui.loading), ["ui.loading"]);
    store.effect(() => UI.showError(store.state.ui.error), ["ui.error"]);
    store.effect(() => UI.renderAuth(), ["auth.isLoggedIn", "auth.email"]);
    store.effect(() => {
        const dashboard = store.state.data.dashboard;
        const rows = getCauseData(dashboard);
        UI.renderStats(dashboard);
        UI.populateFilters(rows);
        UI.renderCauseChart(rows);
        UI.renderTrendChart(rows);
    }, ["data.dashboard"]);
    store.effect(() => {
        const rows = computed.filteredRows.get();
        UI.renderFilteredResult(rows);
        UI.renderCauseChart(rows, "dynamic-chart");
    }, ["data.dashboard", "filters.current.month", "filters.current.gender"]);
}

function bindEvents() {
    document.getElementById("login-btn")?.addEventListener("click", openLoginModal);
    document.getElementById("overlay-login-btn")?.addEventListener("click", openLoginModal);
    document.getElementById("cancel-login-btn")?.addEventListener("click", closeLoginModal);
    document.getElementById("logout-btn")?.addEventListener("click", () => AuthService.logout());

    document.getElementById("login-modal")?.addEventListener("click", (event) => {
        if (event.target === event.currentTarget) closeLoginModal();
    });

    document.getElementById("do-login-btn")?.addEventListener("click", () => {
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
        document.getElementById(id)?.addEventListener("keydown", (event) => {
            if (event.key === "Enter") document.getElementById("do-login-btn")?.click();
        });
    });

    document.getElementById("query-btn")?.addEventListener("click", () => {
        const month = document.getElementById("filter-month")?.value || "";
        const gender = document.getElementById("filter-gender")?.value || "";
        store.state.filters.current = { month, gender };
    });

    document.getElementById("sub-btn")?.addEventListener("click", async () => {
        const email = document.getElementById("sub-email")?.value.trim() || "";
        const button = document.getElementById("sub-btn");
        const result = document.getElementById("sub-result");

        if (!AuthService.validateEmail(email)) {
            if (result) {
                result.textContent = "請輸入有效的 Email";
                result.className = "sub-result error";
                result.hidden = false;
            }
            return;
        }

        if (button) {
            button.disabled = true;
            button.textContent = "訂閱中...";
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
        if (result) {
            result.textContent = `已送出訂閱確認信到 ${email}`;
            result.className = "sub-result success";
            result.hidden = false;
        }
        const input = document.getElementById("sub-email");
        if (input) input.value = "";
        if (button) {
            button.disabled = false;
            button.textContent = "訂閱通知";
        }
    });

    window.addEventListener("resize", () => {
        document.querySelectorAll(".chart").forEach((el) => echarts.getInstanceByDom(el)?.resize());
    });
    window.addEventListener("online", () => { store.state.connectivity.isOnline = true; });
    window.addEventListener("offline", () => { store.state.connectivity.isOnline = false; });
}

async function loadDashboard() {
    store.state.ui.loading = true;
    try {
        const data = await DashboardService.loadDashboard();
        store.batch((state) => {
            state.data.dashboard = data;
            state.data.isDataLoaded = true;
            state.ui.error = null;
            state.ui.loading = false;
        });
    } catch (error) {
        store.batch((state) => {
            state.ui.error = `dashboard_data.json 載入失敗：${error.message}`;
            state.ui.loading = false;
        });
    }
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("update-time").textContent = new Date().toLocaleString("zh-TW");
    setupEffects();
    bindEvents();
    AuthService.restoreSession();
    loadDashboard();
});

window.reactiveState = store;
window.AuthService = AuthService;
window.openLoginModal = openLoginModal;

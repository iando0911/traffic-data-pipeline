
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

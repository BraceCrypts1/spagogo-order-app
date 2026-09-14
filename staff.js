// staff.js — the kitchen's orders board (staff.html).
//
// The browser never touches the `orders` table here. It logs in with Supabase
// Auth like a customer would, then sends its access token to
// /.netlify/functions/staff-orders, which checks the staff list on the server
// and does the reads/writes with the secret key. A customer who logs in on this
// page simply gets "This account is not staff".

(function () {
    var API = "/.netlify/functions/staff-orders";
    var REFRESH_MS = 30000;

    var statusEl  = document.getElementById("staffStatus");
    var loginForm = document.getElementById("staffLoginForm");
    var loginMsg  = document.getElementById("staffLoginMessage");
    var loginBtn  = document.getElementById("staffLoginBtn");
    var board     = document.getElementById("staffBoard");
    var listEl    = document.getElementById("staffList");
    var countEl   = document.getElementById("staffCount");
    var msgEl     = document.getElementById("staffMessage");
    var onlyOpen  = document.getElementById("staffOnlyOpen");

    var range = "today";
    var session = null;
    var timer = null;
    var orders = [];

    var KITCHEN = {
        new:              { label: "New",              next: "preparing",        nextLabel: "Start preparing" },
        preparing:        { label: "Preparing",        next: "out_for_delivery", nextLabel: "Out for delivery" },
        out_for_delivery: { label: "Out for delivery", next: "delivered",        nextLabel: "Delivered" },
        delivered:        { label: "Delivered",        next: null },
        cancelled:        { label: "Cancelled",        next: "new",              nextLabel: "Restore" }
    };
    var PAYMENT = { approved: "Paid", pending: "Unpaid", rejected: "Payment failed", error: "Payment problem" };

    // ---------- auth ----------
    supabaseClient.auth.onAuthStateChange(function (event, s) {
        session = s;
        if (s) {
            showBoard();
        } else {
            showLogin();
        }
    });

    loginForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        loginMsg.textContent = "";
        loginBtn.disabled = true;
        var res = await supabaseClient.auth.signInWithPassword({
            email: document.getElementById("staffEmail").value.trim(),
            password: document.getElementById("staffPassword").value
        });
        loginBtn.disabled = false;
        if (res.error) {
            loginMsg.textContent = res.error.message;
            loginMsg.className = "error";
        }
        // success: onAuthStateChange fires with the session
    });

    document.getElementById("staffLogoutBtn").addEventListener("click", async function () {
        await supabaseClient.auth.signOut();
    });

    function showLogin() {
        stopTimer();
        board.classList.add("hidden");
        loginForm.classList.remove("hidden");
        statusEl.textContent = "Staff log in";
    }

    function showBoard() {
        loginForm.classList.add("hidden");
        statusEl.textContent = "Logged in as " + session.user.email;
        load();
        startTimer();
    }

    // ---------- toolbar ----------
    Array.prototype.forEach.call(document.querySelectorAll(".staffFilter"), function (btn) {
        btn.addEventListener("click", function () {
            range = btn.getAttribute("data-range");
            Array.prototype.forEach.call(document.querySelectorAll(".staffFilter"), function (b) {
                b.classList.toggle("isActive", b === btn);
            });
            load();
        });
    });
    onlyOpen.addEventListener("change", render);
    document.getElementById("staffRefreshBtn").addEventListener("click", load);
    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible" && session) load();
    });

    function startTimer() { stopTimer(); timer = setInterval(load, REFRESH_MS); }
    function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

    // ---------- data ----------
    async function api(method, query, body) {
        var headers = { "Authorization": "Bearer " + session.access_token };
        if (body) headers["Content-Type"] = "application/json";
        var res = await fetch(API + (query || ""), {
            method: method,
            headers: headers,
            body: body ? JSON.stringify(body) : undefined
        });
        var data = null;
        try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
        return { ok: res.ok, status: res.status, data: data || {} };
    }

    async function load() {
        if (!session) return;
        var res = await api("GET", "?range=" + range);
        if (res.status === 403) {
            stopTimer();
            board.classList.add("hidden");
            statusEl.textContent = "This account (" + session.user.email + ") is not on the staff list.";
            loginForm.classList.remove("hidden");
            loginMsg.textContent = "Log in with a staff account, or ask the owner to add you.";
            loginMsg.className = "error";
            return;
        }
        if (res.status === 401) { await supabaseClient.auth.signOut(); return; }
        if (!res.ok) { setMsg(res.data.error || "Could not load orders", true); return; }
        orders = res.data.orders || [];
        board.classList.remove("hidden");
        setMsg("");
        render();
    }

    function render() {
        var open = onlyOpen.checked;
        var shown = orders.filter(function (o) {
            return !open || (o.kitchen_status !== "delivered" && o.kitchen_status !== "cancelled");
        });
        countEl.textContent = shown.length + (shown.length === 1 ? " order" : " orders") +
            (range === "today" ? " today" : "") + (open && shown.length !== orders.length ? " (" + (orders.length - shown.length) + " closed hidden)" : "");
        listEl.textContent = "";
        if (shown.length === 0) {
            var empty = el("li", "staffEmpty", range === "today" ? "No orders yet today." : "No orders.");
            listEl.appendChild(empty);
            return;
        }
        shown.forEach(function (o) { listEl.appendChild(renderOrder(o)); });
    }

    function renderOrder(o) {
        var k = KITCHEN[o.kitchen_status] || KITCHEN.new;
        var li = el("li", "staffOrder k-" + o.kitchen_status + " p-" + o.status);

        var top = el("div", "staffOrderTop");
        top.appendChild(el("span", "staffOrderId", "#" + o.id));
        top.appendChild(el("span", "staffOrderTime", formatTime(o.created_at)));
        top.appendChild(el("span", "staffPay p-" + o.status, PAYMENT[o.status] || o.status));
        top.appendChild(el("span", "staffKitchen k-" + o.kitchen_status, k.label));
        li.appendChild(top);

        var parts = splitItem(o.item || "");
        li.appendChild(el("div", "staffItem", (o.quantity || 1) + " × " + parts.name +
            (o.amount ? " — " + naira(o.amount / 100) : "")));

        var who = el("div", "staffWho");
        who.appendChild(el("strong", null, o.customer_name || "No name"));
        if (o.phone) {
            var digits = String(o.phone).replace(/\D/g, "");
            var intl = digits.replace(/^0/, "234");
            who.appendChild(document.createTextNode(" · "));
            var tel = el("a", null, o.phone); tel.href = "tel:" + digits; who.appendChild(tel);
            who.appendChild(document.createTextNode(" · "));
            var wa = el("a", null, "WhatsApp"); wa.href = "https://wa.me/" + intl; wa.target = "_blank"; wa.rel = "noopener";
            who.appendChild(wa);
        }
        li.appendChild(who);
        li.appendChild(el("div", "staffAddress", (o.address || "No address") + " (" + zoneName(o.zone) + ")"));

        var actions = el("div", "staffActions");
        if (k.next) {
            var nextBtn = el("button", "staffNextBtn", k.nextLabel);
            nextBtn.type = "button";
            if (o.kitchen_status === "new" && o.status !== "approved") {
                nextBtn.disabled = true;
                nextBtn.title = "Not paid yet";
            }
            nextBtn.addEventListener("click", function () { move(o, k.next, nextBtn); });
            actions.appendChild(nextBtn);
        }
        if (o.kitchen_status !== "delivered" && o.kitchen_status !== "cancelled") {
            var cancelBtn = el("button", "staffCancelBtn linkBtn", "Cancel order");
            cancelBtn.type = "button";
            cancelBtn.addEventListener("click", function () {
                if (window.confirm("Cancel order #" + o.id + "?")) move(o, "cancelled", cancelBtn);
            });
            actions.appendChild(cancelBtn);
        }
        if (o.kitchen_status === "new" && o.status !== "approved") {
            actions.appendChild(el("span", "staffNote", "Waiting for payment — do not cook yet."));
        }
        li.appendChild(actions);
        return li;
    }

    async function move(o, next, btn) {
        btn.disabled = true;
        var res = await api("PATCH", "", { id: o.id, kitchen_status: next });
        if (!res.ok) {
            setMsg(res.data.error || "Could not update order #" + o.id, true);
            btn.disabled = false;
            if (res.status === 409) load();
            return;
        }
        var i = orders.findIndex(function (x) { return x.id === o.id; });
        if (i >= 0) orders[i] = res.data.order;
        setMsg("Order #" + o.id + " → " + KITCHEN[next].label);
        render();
    }

    // ---------- helpers ----------
    function setMsg(text, isError) {
        msgEl.textContent = text;
        msgEl.className = "staffMessage" + (isError ? " error" : "");
    }
    function el(tag, className, text) {
        var e = document.createElement(tag);
        if (className) e.className = className;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
    }
    function splitItem(item) {
        var m = item.match(/^(.*?)\s*-\s*(₦[\d,]+)\s*$/);
        return m ? { name: m[1], price: m[2] } : { name: item, price: "" };
    }
    function naira(n) { return "₦" + Number(n).toLocaleString("en-NG"); }
    function zoneName(z) { return z === "Mowe" ? "Mowe" : z === "ibafo" ? "Ibafo" : (z || "?"); }
    function formatTime(iso) {
        var d = new Date(iso);
        var today = new Date();
        var sameDay = d.toDateString() === today.toDateString();
        var time = d.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" });
        return sameDay ? time : d.toLocaleDateString("en-NG", { day: "numeric", month: "short" }) + " " + time;
    }
})();

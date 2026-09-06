// orders.js — "My Orders" page.
//
// Reads the logged-in customer's order history. Security is enforced by the
// database, not here: the SELECT policy on `orders` only returns rows where
// auth.uid() = user_id, so this query cannot see anyone else's orders even if
// the code were changed. `points_earned` is computed by a database trigger;
// this page only displays it.

(function () {
    var statusEl = document.getElementById("ordersStatus");
    var panelEl  = document.getElementById("ordersPanel");
    var listEl   = document.getElementById("ordersList");
    var totalEl  = document.getElementById("pointsTotal");

    // The status enum in Postgres: pending / approved / rejected / error.
    var STATUS = {
        approved: { mark: "✓", label: "Approved" },
        rejected: { mark: "✗", label: "Rejected" },
        pending:  { mark: "●", label: "Pending" },
        error:    { mark: "!", label: "Needs attention" }
    };

    // Turn "Spicy Spaghetti + Beef + Egg - ₦1,500" into
    // { name: "Spicy Spaghetti + Beef + Egg", price: "₦1,500" }.
    function splitItem(item) {
        var m = /^(.*?)\s*-\s*(₦[\d,]+)\s*$/.exec(item || "");
        return m ? { name: m[1], price: m[2] } : { name: item || "Unknown item", price: "" };
    }

    function formatDate(iso) {
        var d = new Date(iso);
        if (isNaN(d)) return "";
        return d.toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" }) +
               ", " + d.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" });
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function renderOrder(order) {
        var s = STATUS[order.status] || STATUS.error;
        var parts = splitItem(order.item);

        var li = el("li", "orderCard status-" + (STATUS[order.status] ? order.status : "error"));

        var mark = el("span", "statusMark", s.mark);
        mark.setAttribute("title", s.label);
        mark.setAttribute("aria-label", s.label);

        var body = el("div", "orderBody");
        body.appendChild(el("div", "orderItem", parts.name));
        body.appendChild(el("div", "orderMeta",
            "Qty " + order.quantity + (parts.price ? " · " + parts.price + " each" : "") +
            (order.zone ? " · " + order.zone : "")));
        body.appendChild(el("div", "orderMeta", formatDate(order.created_at) + " · " + s.label));

        var pts = el("div", "orderPoints");
        pts.appendChild(el("span", "orderPointsNum", String(order.points_earned || 0)));
        pts.appendChild(el("span", "orderPointsLabel", "pts"));

        li.appendChild(mark);
        li.appendChild(body);
        li.appendChild(pts);
        return li;
    }

    async function loadOrders(session) {
        statusEl.textContent = "Logged in as " + session.user.email;

        var res = await supabaseClient
            .from("orders")
            .select("id, created_at, item, quantity, zone, status, points_earned")
            .order("created_at", { ascending: false });

        if (res.error) {
            console.error("Could not load orders:", res.error);
            statusEl.textContent = "Sorry, we couldn't load your orders. Please refresh to try again.";
            return;
        }

        var orders = res.data || [];
        listEl.textContent = "";
        var total = 0;
        orders.forEach(function (order) {
            total += order.points_earned || 0;
            listEl.appendChild(renderOrder(order));
        });
        totalEl.textContent = String(total);

        if (orders.length === 0) {
            listEl.appendChild(el("li", "ordersEmpty",
                "No orders yet. Orders you place while logged in will show up here."));
        }
        panelEl.classList.remove("hidden");
    }

    function showLoggedOut() {
        panelEl.classList.add("hidden");
        statusEl.textContent = "";
        var link = document.createElement("a");
        link.href = "index.html";
        link.textContent = "log in on the ordering page";
        statusEl.appendChild(document.createTextNode("Please "));
        statusEl.appendChild(link);
        statusEl.appendChild(document.createTextNode(" to see your orders."));
    }

    // INITIAL_SESSION fires once on load with the stored session (or null),
    // then SIGNED_OUT if the user logs out in another tab.
    supabaseClient.auth.onAuthStateChange(function (event, session) {
        if (session) {
            if (event === "INITIAL_SESSION" || event === "SIGNED_IN") loadOrders(session);
        } else {
            showLoggedOut();
        }
    });
})();

// Netlify/functions/staff-orders.mjs
//
// The kitchen's view of the orders. Everything a staff member sees or changes
// goes through here, never straight to the database from the browser.
//
//   GET  /.netlify/functions/staff-orders?range=today|all[&status=new,preparing]
//        -> { orders: [...], count }
//   PATCH /.netlify/functions/staff-orders   body { id, kitchen_status }
//        -> { order }
//
// Both need  Authorization: Bearer <Supabase access token>  of a logged-in user.
// The function asks Supabase Auth who the token belongs to, then checks that
// user id against public.staff using the secret key (the table has no browser
// access at all). A customer with a valid login therefore gets 403 here, and
// nothing in the browser can grant staff rights.
//
// Payment status (`status`, set by Paystack's webhook) is read-only from here;
// staff only move the separate `kitchen_status` column.
//
// REQUIRED Netlify environment variable: SUPABASE_SECRET_KEY (already set for pay.mjs).

const SUPABASE_URL = "https://secpyyvdokaidzkstbqm.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_8tDy1gTILSX3CVCNTcyF1g_toSX7sr8";

// Legal moves. "cancelled" is allowed from anywhere except "delivered".
const NEXT = {
    new:              ["preparing", "cancelled"],
    preparing:        ["out_for_delivery", "cancelled"],
    out_for_delivery: ["delivered", "cancelled"],
    delivered:        [],
    cancelled:        ["new"]           // undo a mistaken cancel
};
const PAYMENT_STATUSES = ["pending", "approved", "rejected", "error"];
const ORDER_FIELDS = "id,created_at,customer_name,phone,address,zone,item,quantity,amount,status," +
                     "kitchen_status,kitchen_updated_at,paystack_reference,user_id";

export default async (req) => {
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    if (!secretKey) {
        console.error("staff-orders: SUPABASE_SECRET_KEY is not set");
        return json(500, { error: "Server is not configured" });
    }
    if (req.method !== "GET" && req.method !== "PATCH") {
        return json(405, { error: "Method not allowed" });
    }

    // 1. Who is asking?
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
        return json(401, { error: "Please log in" });
    }
    const user = await getUser(authHeader.slice(7));
    if (!user) {
        return json(401, { error: "Your login has expired. Please log in again." });
    }

    // 2. Are they staff? (server-side lookup; the browser cannot read this table)
    const staff = await supabaseRest(secretKey, "GET",
        "/rest/v1/staff?select=user_id&user_id=eq." + encodeURIComponent(user.id) + "&limit=1");
    if (!staff.ok) {
        console.error("staff-orders: staff lookup failed", staff.status, staff.text);
        return json(500, { error: "Could not check staff access" });
    }
    if (!Array.isArray(staff.data) || staff.data.length === 0) {
        return json(403, { error: "This account is not staff" });
    }

    if (req.method === "GET") return listOrders(req, secretKey);
    return updateOrder(req, secretKey, user);
};

async function listOrders(req, secretKey) {
    const url = new URL(req.url);
    const range = url.searchParams.get("range") === "all" ? "all" : "today";
    const statusParam = (url.searchParams.get("status") || "").trim();

    const filters = ["select=" + ORDER_FIELDS, "order=created_at.desc", "limit=200"];
    if (range === "today") {
        // "Today" in Lagos (UTC+1, no DST). Kitchen hours are 6am-4pm so midnight-based is fine.
        const now = new Date(Date.now() + 60 * 60 * 1000);
        const start = now.toISOString().slice(0, 10) + "T00:00:00+01:00";
        filters.push("created_at=gte." + encodeURIComponent(start));
    }
    if (statusParam) {
        const wanted = statusParam.split(",").map(s => s.trim()).filter(s => s in NEXT);
        if (wanted.length) filters.push("kitchen_status=in.(" + wanted.join(",") + ")");
    }
    const res = await supabaseRest(secretKey, "GET", "/rest/v1/orders?" + filters.join("&"));
    if (!res.ok) {
        console.error("staff-orders: list failed", res.status, res.text);
        return json(502, { error: "Could not load orders" });
    }
    return json(200, { orders: res.data, count: res.data.length, range: range });
}

async function updateOrder(req, secretKey, user) {
    let body;
    try { body = await req.json(); } catch { return json(400, { error: "Invalid JSON body" }); }

    const id = Number(body.id);
    const next = String(body.kitchen_status || "");
    if (!Number.isInteger(id) || id <= 0) return json(400, { error: "Missing order id" });
    if (!(next in NEXT)) return json(400, { error: "Unknown kitchen status" });

    // Read the current row so the move can be validated (and so we can say what went wrong).
    const cur = await supabaseRest(secretKey, "GET",
        "/rest/v1/orders?select=id,kitchen_status,status&id=eq." + id + "&limit=1");
    if (!cur.ok || !Array.isArray(cur.data)) {
        console.error("staff-orders: read before update failed", cur.status, cur.text);
        return json(502, { error: "Could not read the order" });
    }
    if (cur.data.length === 0) return json(404, { error: "Order not found" });
    const from = cur.data[0].kitchen_status;
    if (!NEXT[from].includes(next)) {
        return json(409, { error: "Cannot go from '" + from + "' to '" + next + "'", kitchen_status: from });
    }
    if (next === "preparing" && cur.data[0].status !== "approved") {
        return json(409, { error: "This order is not paid yet (payment status: " + cur.data[0].status + ")",
                           kitchen_status: from });
    }

    // Conditional update: only if the row is still in the state we just read
    // (two staff phones tapping at once cannot both "win").
    const upd = await supabaseRest(secretKey, "PATCH",
        "/rest/v1/orders?id=eq." + id + "&kitchen_status=eq." + from,
        { kitchen_status: next, kitchen_updated_at: new Date().toISOString() },
        "return=representation");
    if (!upd.ok) {
        console.error("staff-orders: update failed", upd.status, upd.text);
        return json(502, { error: "Could not update the order" });
    }
    if (!Array.isArray(upd.data) || upd.data.length === 0) {
        return json(409, { error: "Someone else changed this order a moment ago. Refresh." });
    }
    console.log("staff-orders: order", id, from, "->", next, "by", user.email);
    return json(200, { order: pick(upd.data[0]) });
}

function pick(row) {
    const out = {};
    for (const k of ORDER_FIELDS.split(",")) out[k] = row[k];
    return out;
}

async function getUser(token) {
    try {
        const res = await fetch(SUPABASE_URL + "/auth/v1/user", {
            headers: { "apikey": SUPABASE_PUBLISHABLE_KEY, "Authorization": "Bearer " + token }
        });
        if (!res.ok) return null;
        const user = await res.json();
        return user && user.id ? { id: user.id, email: user.email } : null;
    } catch {
        return null;
    }
}

async function supabaseRest(secretKey, method, path, body, prefer) {
    const headers = {
        "apikey": secretKey,
        "Authorization": "Bearer " + secretKey,
        "Content-Type": "application/json",
        // Supabase refuses secret keys that arrive with a browser User-Agent.
        "User-Agent": "spagogo-netlify-function"
    };
    if (prefer) headers["Prefer"] = prefer;
    const res = await fetch(SUPABASE_URL + path, {
        method: method,
        headers: headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep raw text for the log */ }
    return { ok: res.ok, status: res.status, data: data, text: text };
}

function json(status, body) {
    return new Response(JSON.stringify(body), {
        status: status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
}

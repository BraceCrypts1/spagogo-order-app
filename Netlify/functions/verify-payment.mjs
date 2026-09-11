// Netlify/functions/verify-payment.mjs
//
// The browser calls this when the customer lands back on the site after Paystack:
//   GET /.netlify/functions/verify-payment?reference=SPG-42-ABC123
// It answers "is this order paid?" so the page can show a confirmation and hand the
// order to the kitchen on WhatsApp. It also covers the gap when Paystack's webhook is
// a few seconds behind: it asks Paystack directly (server-to-server, secret key) and
// applies the same rules as the webhook before approving anything.
//
// JSON responses:
//   { status: "paid",    order }           paid in full -> order is 'approved'
//   { status: "failed",  order, reason }   card declined etc. -> order is 'rejected'
//   { status: "pending", order }           not paid (yet): abandoned / ongoing / unknown
//   { status: "error",   order }           amount or currency mismatch -> order is 'error'
//   4xx / 5xx { error }
// `order` is { id, amount, item, quantity, zone } only. Name, phone and address are
// never returned: the reference sits in a URL and could be shared or guessed.
//
// Env vars (same two as pay.mjs and the webhook): PAYSTACK_SECRET_KEY, SUPABASE_SECRET_KEY

const SUPABASE_URL = "https://secpyyvdokaidzkstbqm.supabase.co";

export default async (req) => {
    if (req.method !== "GET") return json(405, { error: "Method not allowed" });
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;
    if (!paystackKey || !supabaseKey) {
        console.error("verify: missing environment variable(s):",
            [!paystackKey && "PAYSTACK_SECRET_KEY", !supabaseKey && "SUPABASE_SECRET_KEY"].filter(Boolean).join(", "));
        return json(500, { error: "Server not configured" });
    }

    const reference = new URL(req.url).searchParams.get("reference") || "";
    if (!/^[A-Za-z0-9\-.=]{1,100}$/.test(reference)) {
        return json(400, { error: "Missing or invalid reference" });
    }

    // 1. Our order for this reference.
    const found = await supabaseRest(supabaseKey, "GET",
        "/rest/v1/orders?select=id,status,amount,item,quantity,zone&paystack_reference=eq." + encodeURIComponent(reference));
    if (!found.ok || !Array.isArray(found.data)) {
        console.error("verify: order lookup failed for", reference, found.status, found.text);
        return json(500, { error: "Lookup failed" });
    }
    const order = found.data[0];
    if (!order) return json(404, { error: "No order with that reference" });
    const pub = { id: order.id, amount: order.amount, item: order.item, quantity: order.quantity, zone: order.zone };

    // 2. Already settled by the webhook (or an earlier visit)? No need to ask Paystack.
    if (order.status === "approved") return json(200, { status: "paid", order: pub });
    if (order.status === "error") return json(200, { status: "error", order: pub });

    // 3. Ask Paystack what happened to this transaction.
    let ps = null;
    try {
        const res = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference), {
            headers: { "Authorization": "Bearer " + paystackKey }
        });
        ps = await res.json();
    } catch (err) {
        console.error("verify: Paystack unreachable for", reference, String(err));
    }
    if (!ps || ps.status !== true || !ps.data || typeof ps.data !== "object") {
        console.warn("verify: Paystack gave no usable answer for", reference, "-", ps && ps.message);
        return json(200, { status: order.status === "rejected" ? "failed" : "pending", order: pub });
    }
    const d = ps.data;

    if (d.status === "success") {
        // Same rule as the webhook: the money must match to the kobo, in naira.
        if (Number.isInteger(d.amount) && d.amount === order.amount && d.currency === "NGN") {
            const upd = await supabaseRest(supabaseKey, "PATCH",
                "/rest/v1/orders?id=eq." + order.id + "&status=in.(pending,rejected)&select=id,status",
                { status: "approved" }, "return=representation");
            if (!upd.ok) {
                console.error("verify: could not approve order", order.id, upd.status, upd.text);
                return json(500, { error: "Update failed" });
            }
            console.log("verify: order", order.id, "APPROVED via verify (" + reference + ")");
            return json(200, { status: "paid", order: pub });
        }
        console.error("verify: MISMATCH on order", order.id, "- paid", d.amount, d.currency,
            "expected", order.amount, "NGN. Marking error.");
        await supabaseRest(supabaseKey, "PATCH",
            "/rest/v1/orders?id=eq." + order.id + "&status=in.(pending,rejected)",
            { status: "error" }, "return=minimal");
        return json(200, { status: "error", order: pub });
    }

    if (d.status === "failed") {
        // Only a pending order becomes rejected; an approved one is never downgraded.
        await supabaseRest(supabaseKey, "PATCH",
            "/rest/v1/orders?id=eq." + order.id + "&status=eq.pending",
            { status: "rejected" }, "return=minimal");
        const reason = typeof d.gateway_response === "string" ? d.gateway_response.slice(0, 80) : "";
        console.log("verify: order", order.id, "payment FAILED (" + reason + ")");
        return json(200, { status: "failed", order: pub, reason: reason });
    }

    // abandoned / ongoing / pending / anything else: nothing has been paid (yet).
    console.log("verify: order", order.id, "Paystack status", d.status, "- leaving as", order.status);
    return json(200, { status: order.status === "rejected" ? "failed" : "pending", order: pub });
};

// ---- helpers -----------------------------------------------------------------

function json(status, body) {
    return new Response(JSON.stringify(body), {
        status: status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
}

// Supabase Data API call with the secret key (service role: bypasses RLS).
async function supabaseRest(secretKey, method, path, body, prefer) {
    const headers = {
        "apikey": secretKey,
        "Authorization": "Bearer " + secretKey,
        // Supabase refuses secret keys that arrive with a browser User-Agent.
        "User-Agent": "spagogo-netlify-function"
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
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

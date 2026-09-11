// Netlify/functions/paystack-webhook.mjs
//
// Paystack calls this URL after a successful payment (event "charge.success").
// It is the only thing that turns an order from 'pending' into 'approved' - the
// browser never gets to do that.
//
// Register it once in the Paystack dashboard (test mode):
//   Settings > API Keys & Webhooks > Test Webhook URL
//   https://lustrous-meerkat-6dc043.netlify.app/.netlify/functions/paystack-webhook
//
// Every delivery goes through these checks, in order. Any failure = NOT approved.
//   1. x-paystack-signature equals HMAC-SHA512(raw request body, PAYSTACK_SECRET_KEY)
//   2. event is "charge.success" and data.status is "success"
//   3. an order with that paystack_reference exists
//   4. data.amount (kobo) and data.currency match what we charged for that order
// Then status 'pending' (or 'rejected') becomes 'approved' and the Postgres trigger
// awards the loyalty points. A mismatched amount marks the order 'error' for a human
// to look at. Paystack re-sends events it thinks failed, so repeats must be harmless:
// an already-approved order is left exactly as it is.
//
// Responses: 200 = "got it, don't send again"; 401 = bad signature (Paystack will
// retry, which helps if the key was pasted wrong); 500 = our database hiccuped, retry.
//
// Env vars (the same two pay.mjs uses): PAYSTACK_SECRET_KEY, SUPABASE_SECRET_KEY

import { createHmac, timingSafeEqual } from "node:crypto";

const SUPABASE_URL = "https://secpyyvdokaidzkstbqm.supabase.co";

export default async (req) => {
    if (req.method !== "POST") return reply(405, "Method not allowed");
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;
    if (!paystackKey || !supabaseKey) {
        console.error("webhook: missing environment variable(s):",
            [!paystackKey && "PAYSTACK_SECRET_KEY", !supabaseKey && "SUPABASE_SECRET_KEY"].filter(Boolean).join(", "));
        return reply(500, "Server not configured");
    }

    // 1. Signature. Computed over the raw bytes exactly as Paystack sent them; parsing
    //    and re-serialising the JSON first would change the bytes and never match.
    const raw = Buffer.from(await req.arrayBuffer());
    const expected = createHmac("sha512", paystackKey).update(raw).digest("hex");
    const given = req.headers.get("x-paystack-signature") || "";
    if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
        console.warn("webhook: rejected - bad signature. from ip", req.headers.get("x-nf-client-connection-ip"));
        return reply(401, "Invalid signature");
    }

    let event;
    try {
        event = JSON.parse(raw.toString("utf8"));
    } catch {
        return reply(400, "Invalid JSON");
    }
    const data = event && typeof event.data === "object" && event.data ? event.data : {};

    // 2. Only successful charges are interesting. Anything else is acknowledged and ignored.
    if (!event || event.event !== "charge.success" || data.status !== "success") {
        console.log("webhook: ignoring event", event && event.event, "status", data.status);
        return reply(200, "Ignored");
    }
    const reference = typeof data.reference === "string" ? data.reference : "";
    if (!/^[A-Za-z0-9\-.=]{1,100}$/.test(reference)) {
        console.warn("webhook: ignoring charge.success with unusable reference");
        return reply(200, "Ignored");
    }

    // 3. Find our order for this reference.
    const found = await supabaseRest(supabaseKey, "GET",
        "/rest/v1/orders?select=id,status,amount&paystack_reference=eq." + encodeURIComponent(reference));
    if (!found.ok || !Array.isArray(found.data)) {
        console.error("webhook: order lookup failed for", reference, found.status, found.text);
        return reply(500, "Lookup failed");
    }
    const order = found.data[0];
    if (!order) {
        console.warn("webhook: no order with reference", reference, "- nothing to do");
        return reply(200, "Unknown reference");
    }

    // 4. The money must match what we asked for, to the kobo, in naira.
    const amountOk = Number.isInteger(data.amount) && data.amount === order.amount;
    const currencyOk = data.currency === "NGN";
    if (!amountOk || !currencyOk) {
        console.error("webhook: MISMATCH on order", order.id, "- paid", data.amount, data.currency,
            "expected", order.amount, "NGN. Marking error.");
        if (order.status !== "approved") {
            await supabaseRest(supabaseKey, "PATCH", "/rest/v1/orders?id=eq." + order.id,
                { status: "error" }, "return=minimal");
        }
        return reply(200, "Mismatch recorded");
    }

    // 5. Approve. The status filter makes this safe to run twice and leaves 'error'
    //    orders alone: only a pending (or previously rejected) order can become approved.
    if (order.status === "approved") {
        console.log("webhook: order", order.id, "already approved - repeat delivery ignored");
        return reply(200, "Already approved");
    }
    const updated = await supabaseRest(supabaseKey, "PATCH",
        "/rest/v1/orders?id=eq." + order.id + "&status=in.(pending,rejected)&select=id,status,points_earned",
        { status: "approved" }, "return=representation");
    if (!updated.ok || !Array.isArray(updated.data)) {
        console.error("webhook: could not approve order", order.id, updated.status, updated.text);
        return reply(500, "Update failed");
    }
    if (updated.data.length === 0) {
        console.warn("webhook: order", order.id, "not changed (status was", order.status + ")");
        return reply(200, "No change");
    }
    console.log("webhook: order", order.id, "APPROVED via", reference, "- points awarded:", updated.data[0].points_earned);
    return reply(200, "OK");
};

// ---- helpers -----------------------------------------------------------------

function reply(status, message) {
    return new Response(message, { status: status, headers: { "Content-Type": "text/plain" } });
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

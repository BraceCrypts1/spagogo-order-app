// Netlify/functions/pay.mjs
//
// Creates an order AND starts a Paystack payment for it - all on the server,
// so the browser never decides the price.
//
//   browser  --POST /.netlify/functions/pay-->  this function
//     1. validates the order details
//     2. works out the total in kobo from the fixed menu + delivery fee
//     3. inserts the order in Supabase (status 'pending') with that amount
//     4. asks Paystack for a checkout link (POST /transaction/initialize)
//     5. stores the Paystack reference on the order
//     6. returns { url } and the browser sends the customer to Paystack
//
// The order stays 'pending' until Paystack's webhook (next step) confirms the
// charge. Only then does status become 'approved' and points get awarded.
//
// REQUIRED Netlify environment variables (Site configuration > Environment variables):
//   PAYSTACK_SECRET_KEY  Paystack > Settings > API Keys & Webhooks > Test secret key (sk_test_...)
//   SUPABASE_SECRET_KEY  Supabase > Project Settings > API Keys > Secret key (sb_secret_...)
//                        It bypasses Row Level Security: server-side only, never in the browser.
//
// Modern Netlify function format (web Request in, Response out). No npm dependencies.

import { randomUUID } from "node:crypto";

const SUPABASE_URL = "https://secpyyvdokaidzkstbqm.supabase.co";
// Public key, same one index.html uses. Only needed to ask Supabase Auth who a token belongs to.
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_8tDy1gTILSX3CVCNTcyF1g_toSX7sr8";

// Prices live here, on the server. `name` must match the option text in index.html
// exactly, because the points trigger reads the "₦" price out of the saved item text.
const MENU = {
    item1: { name: "Spicy Spaghetti + Beef + Egg - ₦1,500", price: 1500 },
    item2: { name: "Spicy Spaghetti + Peppered stir-Fry Chicken(meduim) + Egg - ₦2,000", price: 2000 },
    item3: { name: "Spicy Spaghetti + Peppered stir-Fry Chicken(Big) + Egg - ₦2,500", price: 2500 }
};
// Delivery fee in naira. Mowe is a ₦500 minimum; any extra distance is settled on WhatsApp.
const DELIVERY_FEE = { ibafo: 0, Mowe: 500 };
const MAX_QUANTITY = 20;

export default async (req) => {
    if (req.method !== "POST") {
        return json(405, { error: "Method not allowed" });
    }
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;
    if (!paystackKey || !supabaseKey) {
        console.error("pay: missing environment variable(s):",
            [!paystackKey && "PAYSTACK_SECRET_KEY", !supabaseKey && "SUPABASE_SECRET_KEY"].filter(Boolean).join(", "));
        return json(500, { error: "Payment is not set up on the server yet" });
    }

    let body;
    try {
        body = await req.json();
    } catch {
        return json(400, { error: "Invalid JSON body" });
    }
    const order = validate(body);
    if (order.error) {
        return json(400, { error: order.error });
    }

    // Logged-in customer? The browser forwards its Supabase access token and we ask
    // Supabase Auth who it belongs to. We never trust a user id sent by the browser.
    let userId = null;
    const authHeader = req.headers.get("authorization") || "";
    if (authHeader.startsWith("Bearer ")) {
        const user = await getUser(authHeader.slice(7));
        if (!user) {
            return json(401, { error: "Your login has expired. Please log in again, or log out to order as a guest." });
        }
        userId = user.id;
        if (!order.email) order.email = user.email || "";
    }
    if (!order.email) {
        return json(400, { error: "An email address is needed for your payment receipt" });
    }

    // Total in kobo (₦1 = 100 kobo), computed here and only here.
    const amount = (order.item.price * order.quantity + DELIVERY_FEE[order.zone]) * 100;

    // 1. Save the order as 'pending' (the points trigger sets points_earned = 0).
    const inserted = await supabaseRest(supabaseKey, "POST", "/rest/v1/orders?select=id", {
        customer_name: order.name,
        phone: order.phone,
        address: order.address,
        zone: order.zone,
        item: order.item.name,
        quantity: order.quantity,
        user_id: userId,
        amount: amount
    }, "return=representation");
    if (!inserted.ok || !inserted.data || !inserted.data[0] || inserted.data[0].id == null) {
        console.error("pay: could not insert order:", inserted.status, inserted.text);
        return json(502, { error: "We couldn't save your order" });
    }
    const orderId = inserted.data[0].id;

    // 2. Ask Paystack for a checkout link. Reference must be unique per attempt and may
    //    only contain letters, digits, "-", "." and "=".
    const origin = new URL(req.url).origin;
    const reference = "SPG-" + orderId + "-" + randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
    let paystack;
    try {
        const res = await fetch("https://api.paystack.co/transaction/initialize", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + paystackKey,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email: order.email,
                amount: amount,
                currency: "NGN",
                reference: reference,
                // Paystack sends the customer back here with ?trxref=...&reference=... appended.
                callback_url: origin + "/",
                metadata: {
                    order_id: orderId,
                    cancel_action: origin + "/",
                    custom_fields: [
                        { display_name: "Order", variable_name: "order",
                          value: "#" + orderId + ": " + order.quantity + " x " + order.item.name },
                        { display_name: "Delivery", variable_name: "delivery",
                          value: order.zone + " - " + order.address },
                        { display_name: "Customer", variable_name: "customer",
                          value: order.name + " (" + order.phone + ")" }
                    ]
                }
            })
        });
        paystack = await res.json();
    } catch (err) {
        paystack = { status: false, message: String(err) };
    }
    if (!paystack || paystack.status !== true || !paystack.data || !paystack.data.authorization_url) {
        console.error("pay: Paystack initialize failed for order", orderId, "-", paystack && paystack.message);
        await supabaseRest(supabaseKey, "PATCH", "/rest/v1/orders?id=eq." + orderId, { status: "error" }, "return=minimal");
        return json(502, { error: "We couldn't start the payment" });
    }

    // 3. Remember which Paystack transaction belongs to this order (the webhook matches on it).
    const saved = await supabaseRest(supabaseKey, "PATCH", "/rest/v1/orders?id=eq." + orderId,
        { paystack_reference: reference }, "return=minimal");
    if (!saved.ok) {
        console.error("pay: could not save reference for order", orderId, saved.status, saved.text);
        await supabaseRest(supabaseKey, "PATCH", "/rest/v1/orders?id=eq." + orderId, { status: "error" }, "return=minimal");
        return json(502, { error: "We couldn't start the payment" });
    }

    console.log("pay: order", orderId, "->", reference, "for", amount, "kobo");
    return json(200, { url: paystack.data.authorization_url, reference: reference, amount: amount, orderId: orderId });
};

// ---- helpers -----------------------------------------------------------------

function json(status, body) {
    return new Response(JSON.stringify(body), {
        status: status,
        headers: { "Content-Type": "application/json" }
    });
}

// Checks the order details from the browser. Returns { error } or the clean fields.
function validate(b) {
    if (!b || typeof b !== "object") return { error: "Missing order details" };
    const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const name = text(b.name, 80);
    const phone = typeof b.phone === "string" ? b.phone.trim() : "";
    const email = text(b.email, 254);
    const address = text(b.address, 200);
    const zone = typeof b.zone === "string" ? b.zone : "";
    const itemKey = typeof b.item === "string" ? b.item : "";
    const quantity = Number(b.quantity);

    if (!name || !phone || !address) return { error: "Name, phone number and address are required" };
    if (!/^[0-9]{10,11}$/.test(phone)) return { error: "Phone number must be 10-11 digits" };
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "That email address doesn't look right" };
    if (!Object.hasOwn(DELIVERY_FEE, zone)) return { error: "Unknown delivery zone" };
    if (!Object.hasOwn(MENU, itemKey)) return { error: "Unknown menu item" };
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
        return { error: "Quantity must be between 1 and " + MAX_QUANTITY };
    }
    return { name, phone, email, address, zone, item: MENU[itemKey], quantity };
}

// Who does this access token belong to? null if invalid/expired.
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

// Supabase Data API call with the secret key (service role: bypasses RLS).
async function supabaseRest(secretKey, method, path, body, prefer) {
    const res = await fetch(SUPABASE_URL + path, {
        method: method,
        headers: {
            "apikey": secretKey,
            "Authorization": "Bearer " + secretKey,
            "Content-Type": "application/json",
            "Prefer": prefer,
            // Supabase refuses secret keys that arrive with a browser User-Agent.
            "User-Agent": "spagogo-netlify-function"
        },
        body: JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep raw text for the log */ }
    return { ok: res.ok, status: res.status, data: data, text: text };
}

// netlify/functions/chat.js
//
// FAQ chatbot backend for Fatima Spagogo.
// Keeps the Gemini API key server-side — never expose it in front-end JS.
//
// REQUIRED SETUP:
// 1. In the Netlify dashboard: Site settings > Environment variables
//    Add GEMINI_API_KEY = <your key>  (do NOT put it in this file or commit it to git)
// 2. Confirm the model name below is still active in Google AI Studio before deploying —
//    Gemini model names get renamed/deprecated more often than you'd expect.
 
const SYSTEM_CONTEXT = `You are the FAQ assistant for Fatima Spagogo, a local food delivery service in the Ibafo area of Ogun State, Nigeria.
 
FACTS YOU MUST STICK TO — do not invent anything beyond this list:
- Menu:
  • Spicy Spaghetti + Beef + Egg — ₦1,500
  • Spicy Spaghetti + Peppered Stir-Fry Chicken (Medium) + Egg — ₦2,000
  • Spicy Spaghetti + Peppered Stir-Fry Chicken (Big) + Egg — ₦2,500
- Delivery is free, but ONLY within the Ibafo axis. No delivery outside that area.
- Orders and delivery run Monday–Friday, 6am–4pm only. Orders outside this window are not accepted.
- The site has a quick order form above this chat. When someone wants to order, their selection gets pre-filled into that form — they still confirm and complete via WhatsApp for payment, same as before.
- Payment is required upfront. An order is only recorded/confirmed once payment is confirmed.
- If a delivery does not happen, a refund is issued along with the reason.
 
RULES:
- If asked about anything not covered above (other delivery zones, card payment, bulk/event orders, etc.), say you're not sure and tell them to confirm directly on WhatsApp.
- Keep every answer to 2–3 sentences. This is a quick FAQ chat, not a conversation.
- When asked about hours, days, or availability, always state the exact days and time window from the FACTS section above, word for word. Never answer vaguely.
- Never make up a price, menu item, or delivery zone that isn't listed above.

ORDER INTENT:
- Set orderIntent to true ONLY when the person is clearly trying to place an order right now (e.g. "I want the beef one", "let's order 2 of the big chicken", "can I get one spaghetti and egg"). Questions about the menu, prices, or hours are NOT order intent.
- If orderIntent is true, map what they asked for to item1 (Beef), item2 (Medium Chicken), or item3 (Big Chicken). If it's ambiguous which item, use "unknown" and ask them to clarify in the reply text instead of guessing.
- If orderIntent is true and no quantity was stated, default quantity to 1.
- If orderIntent is false, item must be "unknown" and quantity must be 1.
- When orderIntent is true and item is known, mention in the reply that you've filled in the order form for them and they just need to check the details and confirm.`;
 
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*", // tighten to your actual domain once live
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
 
  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
 
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }
 
  // Parse and validate input
  let userMessage;
  try {
    const body = JSON.parse(event.body || "{}");
    userMessage = body.message;
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }
 
  if (!userMessage || typeof userMessage !== "string" || userMessage.trim().length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing 'message'" }) };
  }
  if (userMessage.length > 500) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Message too long" }) };
  }
 
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY not set in environment");
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server misconfigured" }) };
  }
 
  // Verify this model ID is current before you deploy — check Google AI Studio.
     const MODEL = "gemini-3.5-flash";
 
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_CONTEXT }] },
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
          generationConfig: {
    maxOutputTokens: 4096,
    temperature: 0.4,
    thinkingConfig: { thinkingLevel: "low" },
    responseMimeType: "application/json",
    responseSchema: {
      type: "object",
      properties: {
        reply: { type: "string", description: "2-3 sentence chat reply shown to the user." },
        orderIntent: { type: "boolean", description: "True only if the user is trying to place an order right now." },
        item: { type: "string", enum: ["item1", "item2", "item3", "unknown"], description: "item1=Beef, item2=Medium Chicken, item3=Big Chicken. unknown if orderIntent is false or unclear." },
        quantity: { type: "integer", description: "Quantity requested. 1 if unclear or orderIntent is false." }
      },
      required: ["reply", "orderIntent", "item", "quantity"]
    }
},
        }),
      }
    );
 
    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini API error:", response.status, errText);
      // 429 here means you've hit the free-tier rate limit
      return { statusCode: 502, headers, body: JSON.stringify({ error: "Upstream API error" }) };
    }
 
    const data = await response.json();
    console.log("finishReason:", data?.candidates?.[0]?.finishReason);
console.log("usageMetadata:", JSON.stringify(data?.usageMetadata));
    const parts = data?.candidates?.[0]?.content?.parts || [];
const rawText = parts
    .filter(function (p) { return p.text && !p.thought; })
    .map(function (p) { return p.text; })
    .join("");

    var reply = "Sorry, I couldn't generate a response. Please try WhatsApp instead.";
    var orderIntent = false;
    var item = "unknown";
    var quantity = 1;

    if (rawText) {
      try {
        var parsed = JSON.parse(rawText);
        reply = parsed.reply || reply;
        orderIntent = parsed.orderIntent === true;
        item = ["item1", "item2", "item3"].indexOf(parsed.item) !== -1 ? parsed.item : "unknown";
        quantity = Number.isInteger(parsed.quantity) && parsed.quantity > 0 ? parsed.quantity : 1;
      } catch (parseErr) {
        console.error("Failed to parse structured Gemini response:", parseErr, rawText);
        reply = rawText; // fall back to showing the raw text rather than losing the reply entirely
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ reply: reply, orderIntent: orderIntent, item: item, quantity: quantity }) };
  } catch (err) {
    console.error("Function error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Internal error" }) };
  }
};
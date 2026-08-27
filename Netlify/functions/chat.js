
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
- Orders are placed via WhatsApp only. There is no online checkout on the site.
- Payment is required upfront. An order is only recorded/confirmed once payment is confirmed.
- If a delivery does not happen, a refund is issued along with the reason.
 
RULES:
- If asked about anything not covered above (other delivery zones, card payment, bulk/event orders, etc.), say you're not sure and tell them to confirm directly on WhatsApp.
- Keep every answer to 2–3 sentences. This is a quick FAQ chat, not a conversation.
- Never make up a price, menu item, or delivery zone that isn't listed above.`;
 
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
  const MODEL = "gemini-2.5-flash";
 
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
          generationConfig: { maxOutputTokens: 200, temperature: 0.4 },
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
    const reply =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ??
      "Sorry, I couldn't generate a response. Please try WhatsApp instead.";
 
    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
  } catch (err) {
    console.error("Function error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Internal error" }) };
  }
};
 

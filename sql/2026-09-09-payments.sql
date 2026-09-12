-- ============================================================
-- Paystack payments: what the order was charged and which
-- Paystack transaction paid for it.
-- Already applied to the live project (run once via the SQL Editor).
-- Safe to run again: "if not exists" / the constraint add fails
-- harmlessly if it is already there.
-- ============================================================

alter table public.orders
  add column if not exists amount integer,              -- total in kobo (₦1 = 100 kobo); set only by pay.mjs
  add column if not exists paystack_reference text;     -- our own reference, e.g. SPG-42-1A2B3C

alter table public.orders
  add constraint orders_paystack_reference_key unique (paystack_reference);

comment on column public.orders.amount is
  'Total charged, in kobo (₦1 = 100 kobo). Set by the pay function, never by the browser.';

-- How status moves (all server-side, never from the browser):
--   pending  -> approved   paystack-webhook.mjs / verify-payment.mjs after signature + amount checks
--   pending  -> rejected   verify-payment.mjs when Paystack reports the charge failed
--   pending  -> error      amount/currency mismatch, or Paystack initialize failed (needs a human)
-- The trigger in 2026-09-06-points-earned.sql awards points on 'approved'.

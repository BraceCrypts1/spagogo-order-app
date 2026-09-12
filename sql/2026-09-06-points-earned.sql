-- ============================================================
-- Loyalty points: 1 point per ₦100, earned only on approval.
-- Computed by a trigger inside Postgres; the browser never sets it.
-- Safe to run more than once.
-- ============================================================

-- 1. The column. Default 0, so existing rows and new orders start at zero.
alter table public.orders
  add column if not exists points_earned integer not null default 0;

-- 2. The function. Runs BEFORE every insert/update and overwrites
--    points_earned from status + item + quantity. Price is read from the
--    item text, e.g. '... - ₦2,500' -> 2500. No price found -> 0 points.
create or replace function public.set_order_points()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  price_text text;
begin
  if new.status = 'approved' then
    price_text := substring(new.item from '₦\s*([0-9][0-9,]*)');
    if price_text is null then
      new.points_earned := 0;
    else
      new.points_earned := (replace(price_text, ',', '')::integer / 100)
                           * coalesce(new.quantity, 1);
    end if;
  else
    new.points_earned := 0;
  end if;
  return new;
end;
$$;

-- 3. Attach it. Fires on EVERY insert/update (not just status changes), so
--    even a direct write to points_earned gets recalculated and overwritten.
drop trigger if exists trg_set_order_points on public.orders;
create trigger trg_set_order_points
  before insert or update on public.orders
  for each row execute function public.set_order_points();

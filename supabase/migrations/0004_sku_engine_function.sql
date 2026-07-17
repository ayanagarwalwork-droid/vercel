-- AOBA PMOS — SKU Engine: server-side, race-condition-safe style code generation.
--
-- Style code = {CATEGORY}-{N}, where N = count of existing styles in that
-- category's group + 1 (or in the standalone category alone). This can't be a
-- bare SEQUENCE because N must track a live *count*, matching the prototype's
-- `STYLES_DATA.filter(...).length + 1` — a sequence would drift from that
-- count if a style were ever deleted. Instead: an UPDATE on a per-group
-- counter row, which Postgres locks for the duration of the transaction, so
-- two concurrent creates in the same group can never receive the same number.
create or replace function create_style_with_code(
  p_category    text,
  p_name        text,
  p_status      style_status,
  p_colors      text[],
  p_sizes       text[],
  p_mrp         numeric,
  p_cost_price  numeric,
  p_hsn_code    text,
  p_description text,
  p_images      text[],
  p_created_by  uuid
) returns styles
language plpgsql
as $func$
declare
  v_group       int;
  v_counter_key text;
  v_next_num    int;
  v_code        text;
  v_row         styles;
begin
  select group_number into v_group from categories where code = p_category;
  if not found then
    raise exception 'Unknown category: %', p_category;
  end if;

  v_counter_key := case when v_group is not null then 'group:' || v_group else 'cat:' || p_category end;

  -- The UPDATE locks this one counter row for the rest of the transaction, so
  -- a second concurrent call targeting the same key blocks here until the
  -- first commits and releases it.
  update style_number_counters
     set next_number = next_number + 1
   where counter_key = v_counter_key
   returning next_number - 1 into v_next_num;

  if not found then
    raise exception 'No counter row for %', v_counter_key;
  end if;

  v_code := p_category || '-' || v_next_num;

  insert into styles (code, name, category, status, colors, sizes, mrp, cost_price,
                       hsn_code, description, images, created_by)
  values (v_code, p_name, p_category, p_status, p_colors, p_sizes, p_mrp, p_cost_price,
          p_hsn_code, p_description, coalesce(p_images, '{}'), p_created_by)
  returning * into v_row;

  return v_row;
end;
$func$;

-- create_style_with_code is called via supabase.rpc(...) using the service-role
-- client, which already bypasses RLS/grants entirely (see 0001's revoke
-- statement) — no separate grant needed here.

-- AOBA PMOS — seed categories + their SKU-group counters.
-- Exact codes/names/groups read directly from prototype-3.html's CATEGORIES array.

insert into categories (code, name, group_number) values
  -- Group 1 — shared running counter
  ('AILW','Loungewear',1),
  ('AINW','Night Wear',1),
  ('AIBW','Beach Wear',1),
  ('AISW','Swim Wear',1),
  ('AIBS','Bodysuit',1),
  ('AIWW','Winter Wear',1),
  ('AIBL','Bralette',1),
  -- Group 2 — shared running counter
  ('AOD','Dress',2),
  ('AOT','Tops',2),
  ('AOP','Pants',2),
  ('AOS','Skirt',2),
  ('AOCS','Co-ord Set',2),
  -- Group 3 — shared running counter
  ('AK','Aakar',3),
  -- Group 4 — shared running counter
  ('AIMS','Mask Silk',4),
  ('AIMP','Mask Printed',4),
  ('OMNI','Mask Multi',4),
  ('AISH','Scrunchies',4),
  ('AISF','Scarfs',4),
  -- Group 5 — shared running counter
  ('AIT','Turban',5),
  -- Standalone — own counter each
  ('AILS','Shapewear',null),
  ('AIB','Bra',null),
  ('AIP','Panty',null),
  ('AIS','Shapewear',null),
  ('PO','Pack of Panty',null),
  ('POB','Pack of Bra',null);

-- One counter row per group, plus one per standalone category.
insert into style_number_counters (counter_key, next_number)
  select distinct 'group:' || group_number, 1
  from categories where group_number is not null
  union all
  select 'cat:' || code, 1
  from categories where group_number is null;

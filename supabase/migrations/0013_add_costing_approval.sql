-- AOBA PMOS — Costing approval workflow: anyone with edit access to Costing
-- can update the breakdown, but it's only ever 'draft' until a Founder
-- explicitly approves it. Any subsequent edit (by anyone, Founder included)
-- reverts it to 'draft' again — approval is a deliberate, one-time-per-
-- version action, not implied by saving.
alter table styles add column costing_status text not null default 'draft'
  check (costing_status in ('draft', 'approved'));

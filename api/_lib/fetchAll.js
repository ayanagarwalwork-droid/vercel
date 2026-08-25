// Supabase's REST layer (PostgREST) caps any single request at a max-rows
// default (1000) regardless of whether the query itself calls .limit() —
// there is no "give me everything" request once a table crosses that line.
// This loops with .range() until a page comes back short of a full page,
// so callers always get the true complete result no matter how large the
// table grows, without needing any Supabase project setting changed.
//
// `queryFactory` must be a function that returns a *fresh* Supabase query
// each call (e.g. () => supabaseAdmin.from('styles').select('*').order(...))
// — a query builder can't be re-used after .range() runs once.
const PAGE_SIZE = 1000;

async function fetchAll(queryFactory) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await queryFactory().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

module.exports = { fetchAll };

// Thin fetch wrapper shared by every migrated function in desktop.html.
// Attaches the current Supabase session's access token and throws a plain
// Error with the server's message on any non-2xx response, so callers can
// just `catch (e) { err.textContent = e.message }` like the prototype
// already does for validation errors.
const api = {
  async _request(method, path, body) {
    const token = await getAccessToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let payload = null;
    try { payload = await res.json(); } catch (e) { /* empty body is fine */ }

    if (!res.ok) {
      throw new Error(payload?.error || `Request failed (${res.status})`);
    }
    return payload;
  },
  get(path) { return api._request('GET', path); },
  post(path, body) { return api._request('POST', path, body); },
  patch(path, body) { return api._request('PATCH', path, body); },
  delete(path) { return api._request('DELETE', path); },
};

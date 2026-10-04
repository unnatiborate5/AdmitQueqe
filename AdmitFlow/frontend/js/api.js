/* Thin fetch wrapper for the AdmitFlow API. Exposes window.Api. */
(function () {
  class ApiError extends Error {
    constructor(message, status, errors, code) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.errors = errors || {};
      this.code = code || null;
    }
  }

  async function request(method, url, body) {
    const options = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, options);
    } catch (_) {
      throw new ApiError('Cannot reach the server. Check that it is running and try again.', 0);
    }

    let payload = null;
    try { payload = await res.json(); } catch (_) { /* non-JSON response */ }

    if (!res.ok || !payload || payload.success === false) {
      throw new ApiError(
        (payload && payload.message) || 'Something went wrong. Please try again.',
        res.status,
        payload && payload.errors,
        payload && payload.code
      );
    }
    return payload;
  }

  window.Api = {
    ApiError,
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body === undefined ? {} : body),
    put: (url, body) => request('PUT', url, body),
    patch: (url, body) => request('PATCH', url, body),
  };
})();

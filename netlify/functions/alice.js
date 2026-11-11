// Netlify Function: тот же обработчик навыка Алисы, что и в api/index.js.
// Netlify отдаёт запрос в формате (event) и ждёт { statusCode, headers, body }.

let handlerPromise = null;
function getHandler() {
  if (!handlerPromise) {
    handlerPromise = import("../../api/index.js").then(m => m.default);
  }
  return handlerPromise;
}

export async function handler(event) {
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    body = {};
  }

  const req = { method: event.httpMethod, body };
  let result;

  const res = {
    status(code) {
      result = { ...(result || {}), statusCode: code };
      return this;
    },
    json(value) {
      result = {
        statusCode: result?.statusCode || 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(value),
      };
      return result;
    },
    setHeader(name, value) {
      result = result || { statusCode: 200, headers: {} };
      result.headers = { ...(result.headers || {}), [name]: value };
    },
  };

  const run = await getHandler();
  await run(req, res);

  return result || {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ok: true, service: "alice-gemini-netlify" }),
  };
}

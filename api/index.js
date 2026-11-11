const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const FALLBACK_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"];

// Яндекс Диалоги ждут ответ ~4.5 секунды. Бюджет — 3.65 с на всё про всё.
const TOTAL_BUDGET_MS = 3650;
const HARD_STOP_MS = 3600;
const GEMINI_TIMEOUT_MS = 2900;
const MAX_TOKENS = 220;
const MAX_ALICE_TEXT = 1024;
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS = 1200;

const SYSTEM_PROMPT = [
  "Ты — голосовой помощник в навыке Яндекс Алисы.",
  "Говори по-русски, как живой человек в разговоре: коротко, 1–3 предложения, без Markdown, таблиц, эмодзи и списков.",
  "Не начинай каждый ответ одинаково и не повторяй вопрос собеседника.",
  "Если данных для точного ответа нет — честно скажи это в одну фразу, без выдуманных фактов, дат и цифр.",
  "Если пользователь шутит или беседует — поддержи разговор, а не читай лекцию.",
  "Числа и даты называй так, как их удобно произнести вслух."
].join(" ");

const SEARCH_INTENT =
  /сегодня|сейчас|последн|новост|погод|курс|актуальн|свеж|сколько стоит|кто выиграл|что случилось|найди|поищи|как прош|latest|today|current|news|weather|price|exchange|score|recent/i;

// «Кто ты / что умеешь» — отвечаем локально, экономя квоту и время.
const CAPABILITY =
  /(кто|что) ты|как тебя зовут|что ты (умеешь|можешь)|тво[иё] (возможности|умения)|help|помощь/i;

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[*`#>|~]+/g, " ")
    .replace(/(^|\s)_+|_+(?=\s|$)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!text) return "Не получилось ответить. Спроси ещё раз.";
  if (text.length <= MAX_ALICE_TEXT) return text;
  const cut = text.slice(0, MAX_ALICE_TEXT - 1);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end >= 300) return cut.slice(0, end + 1).trim();
  const space = cut.lastIndexOf(" ");
  return (space > 200 ? cut.slice(0, space) : cut).trim() + "…";
}

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: { text: fitAliceText(text), end_session: Boolean(endSession) },
    session_state: { history: safeHistory(history) }
  };
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_CHARS) }));
}

function isSearchIntent(text) {
  return SEARCH_INTENT.test(String(text || ""));
}

function isCapabilityQuestion(text) {
  return CAPABILITY.test(String(text || ""));
}

/**
 * Модель выбирается так: GEMINI_MODEL → DEFAULT_MODEL → первый опубликованный
 * в /v1beta/models доступный флеш-вариант. Результат кэшируется в памяти инстанса.
 */
let resolvedModel = null;
let resolvePromise = null;

async function resolveModelFor(key, timeoutMs) {
  if (resolvedModel) return resolvedModel;
  const preferred = [String(process.env.GEMINI_MODEL || "").trim(), DEFAULT_MODEL].filter(Boolean);
  let candidates = [...new Set([...preferred, ...FALLBACK_MODELS])];
  let published = null;

  if (timeoutMs > 400) {
    try {
      const { response, data } = await fetchJson(
        "https://generativelanguage.googleapis.com/v1beta/models",
        { method: "GET", headers: { "x-goog-api-key": key } },
        Math.min(1200, timeoutMs - 300)
      );
      if (response.ok && Array.isArray(data?.models)) {
        published = data.models
          .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
          .map(m => String(m.name || "").replace(/^models\//, ""))
          .filter(Boolean);
      }
    } catch {
      /* нет сети к Google или исчерпан бюджет — берём порядок по умолчанию */
    }
  }

  if (published && published.length) {
    const ordered = candidates.filter(m => published.includes(m));
    const flash = published.filter(m => /flash/i.test(m) && !/embed|image|tts|audio|lite-0/i.test(m));
    candidates = [...new Set([...ordered, ...flash, ...published])];
  }
  return candidates[0] || DEFAULT_MODEL;
}

async function getModel(key, timeoutMs) {
  if (resolvedModel) return resolvedModel;
  if (!resolvePromise) {
    resolvePromise = resolveModelFor(key, timeoutMs)
      .then(model => {
        resolvedModel = model;
        return model;
      })
      .finally(() => {
        resolvePromise = null;
      });
  }
  return resolvePromise;
}

function invalidateModel() {
  resolvedModel = null;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(80, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

function buildContents(history, text) {
  const contents = safeHistory(history).map(item => ({ role: item.role, parts: [{ text: item.text }] }));
  contents.push({ role: "user", parts: [{ text }] });
  return contents;
}

function extractText(data) {
  const candidate = data?.candidates?.[0];
  return (candidate?.content?.parts || [])
    .map(part => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

/**
 * Поиск в интернете средствами самого Gemini (grounding).
 * Включается по переменной GEMINI_SEARCH=on и только для явно «свежих» запросов:
 * поиск заметно замедляет ответ, а у Диалогов жёсткий лимит времени.
 */
async function askGemini(text, history, timeoutMs, useSearch) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 300) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = await getModel(key, timeoutMs);
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: buildContents(history, text),
    generationConfig: { temperature: 0.6, maxOutputTokens: MAX_TOKENS }
  };
  if (useSearch) body.tools = [{ google_search: {} }];

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body)
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const raw = data?.error?.message || "";
    const status = Number(response.status);
    console.error(`Gemini HTTP ${status} (${model}): ${raw.slice(0, 300)}`);
    if (status === 400 && /api key not valid/i.test(raw)) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 404 || /not found|not supported for generateContent/i.test(raw)) {
      throw new Error("GEMINI_MODEL_UNAVAILABLE");
    }
    if (status === 429) {
      const retry = Number(data?.error?.details?.find?.(d => d?.retryDelay)?.retryDelay?.replace?.(/\D+/g, "")) || 0;
      const error = new Error("GEMINI_QUOTA");
      error.retryAfter = retry;
      throw error;
    }
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const answer = extractText(data);
  if (!answer) {
    const blocked = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
    if (blocked) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  return answer;
}

function errorForUser(error, model) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер настроен не до конца. Администратору нужно добавить GEMINI_API_KEY в переменные на сервере.";
    case "GEMINI_KEY_REJECTED":
      return "Ключ Gemini не подошёл. Проверь его в переменных на сервере.";
    case "GEMINI_MODEL_UNAVAILABLE":
      return "Модель недоступна. Укажи в GEMINI_MODEL другую модель Gemini.";
    case "GEMINI_QUOTA":
      return error?.retryAfter > 0 ? `Лимит запросов исчерпан, побеседуем через ${error.retryAfter} секунд.` : "Упёрлась в лимит запросов к Gemini. Попробуй чуть позже.";
    case "GEMINI_BLOCKED":
      return "Такой запрос я обработать не могу. Спроси иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Спроси покороче ещё раз.";
    default:
      return "Не получила ответ от нейросети. Попробуй ещё раз чуть позже.";
  }
}

function greeting(history) {
  return "Привет! Спрашивай что угодно — отвечу коротко и по делу. Что тебя интересует?";
}

function capabilityAnswer() {
  return "Я отвечаю на вопросы через нейросеть Gemini. Могу объяснить, перевести, посчитать, поддержать беседу. Поиск в интернете умею включать по настройке. Что тебя интересует?";
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper-template",
      searchMode: String(process.env.GEMINI_SEARCH || "off").toLowerCase(),
      message: "Webhook is ready. Yandex Dialogs sends POST to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remaining = () => Math.min(HARD_STOP_MS - (Date.now() - startedAt), TOTAL_BUDGET_MS - (Date.now() - startedAt));
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(greeting(oldHistory), false, oldHistory));
  }

  if (isCapabilityQuestion(text)) {
    return res.status(200).json(aliceResponse(capabilityAnswer(), false, oldHistory));
  }

  try {
    const searchMode = String(process.env.GEMINI_SEARCH || "off").toLowerCase();
    const useSearch = searchMode === "on" && isSearchIntent(text);
    const answer = await askGemini(text, oldHistory, Math.max(0, remaining()), useSearch);

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    if (error?.message === "GEMINI_MODEL_UNAVAILABLE") invalidateModel();
    console.warn("Alice webhook fallback:", error?.message || "unknown");
    return res.status(200).json(aliceResponse(errorForUser(error), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, isCapabilityQuestion, safeHistory };

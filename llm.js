// Model calls, prompts and answer parsing. No chrome.* here, so the service worker
// (importScripts) and the Node tests (require) share this one file.

// Tried in order. The first one that has a key and answers wins.
const PROVIDERS = [
  // gemini-3.8-flash also works on a free key but took about two minutes per reply when tested, so the faster one is used.
  // The free key allows this model only 20 requests a day; after that Groq does the work.
  { name: 'Gemini', key: 'GEMINI_KEY', model: 'gemini-3.5-flash',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
  // Groq's free tier allows about 8K tokens a minute, reply budget included, so the reply is capped.
  { name: 'Groq', key: 'GROQ_KEY', model: 'openai/gpt-oss-120b',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    extra: { max_completion_tokens: 4096, include_reasoning: false } },
  // Slow (over a minute on a coding task when tested) but got the pattern question right first time.
  { name: 'NVIDIA', key: 'NVIDIA_KEY', model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions' },
  // Last resort with its own daily quota, for when the two above are rate limited.
  { name: 'Gemini Lite', key: 'GEMINI_KEY', model: 'gemini-3.5-flash-lite',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
];

const wait = ms => new Promise(r => setTimeout(r, ms));

// keys.txt is NAME=value lines.
function parseKeys(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(\S+)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// Joins the text pieces of a streamed (server-sent events) chat reply.
function sseText(raw) {
  let out = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { out += JSON.parse(line.slice(5)).choices?.[0]?.delta?.content || ''; } catch { /* [DONE] and keep-alive lines */ }
  }
  return out;
}

async function chat(p, key, messages, fetchImpl) {
  // stream:true makes the response headers arrive at once; a service worker fetch that
  // stays silent for 30 seconds gets killed by the browser.
  const res = await fetchImpl(p.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: p.model, messages, stream: true, ...p.extra }),
  });
  if (!res.ok) {
    const err = new Error(`${p.name} ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 160)}`);
    err.retryAfter = res.status === 429 ? Number(res.headers.get('retry-after')) : 0;
    throw err;
  }
  const text = sseText(await res.text());
  if (!text.trim()) throw new Error(`${p.name} sent an empty answer`);
  return text;
}

async function ask(keys, messages, fetchImpl = fetch) {
  const errors = [];
  for (const p of PROVIDERS) {
    const key = keys[p.key];
    if (!key) continue;
    try {
      return { provider: p.name, text: await chat(p, key, messages, fetchImpl) };
    } catch (e) {
      // A short rate-limit pause gets one retry before moving to the next provider.
      if (e.retryAfter > 0 && e.retryAfter <= 60) {
        await wait(e.retryAfter * 1000);
        try { return { provider: p.name, text: await chat(p, key, messages, fetchImpl) }; } catch (e2) { e = e2; }
      }
      errors.push(e.message);
    }
  }
  throw new Error(errors.join(' | ') || 'No API key found. Paste one into keys.txt in the extension folder.');
}

const QUIZ_RULES = `You answer first-year university quiz questions in maths, Python programming and computer systems.
First work through each question briefly. Then finish with one line per question, exactly in this form:
ANSWER <question number>: <answer>
Rules for the answer:
- Choice question: only the letter of the correct option.
- Typed question: the exact text to type. It is graded by exact, case-sensitive match, so follow any format note in the question literally (lowercase, UPPERCASE, number of letters, true or false). No extra words, no quotes, no full stop.
- If you cannot answer, for example because the question needs a picture you cannot see, write SKIP.`;

function quizMessages(questions) {
  const body = questions.map(q =>
    `Question ${q.n} (${q.options ? 'choice' : 'typed'})\n${q.text}` +
    (q.options ? '\n' + q.options.map(o => `${o.letter}) ${o.text}`).join('\n') : '')).join('\n\n');
  return [{ role: 'system', content: QUIZ_RULES }, { role: 'user', content: body }];
}

// { questionNumber: answer string, or null for SKIP }. A later line for the same question wins.
function parseAnswers(text) {
  const out = {};
  for (const m of text.matchAll(/^\W*ANSWER\s+(\d+)\W*?:\s*(.*)$/gim)) {
    const a = m[2].trim().replace(/^\*+|\*+$/g, '').replace(/^(["'`])(.*)\1$/, '$2').trim();
    out[m[1]] = !a || /^skip$/i.test(a) ? null : a;
  }
  return out;
}

const STYLE = {
  python: `Write Python 3 the way a good first-year student would: simple and readable. Stick to the basics: input(), int(), print(), variables, if/elif/else, for and while loops, lists, strings and plain functions. Use recursion only when the task asks for it. No classes, lambda, list comprehensions, type hints, try/except or imports unless the task cannot be done without them. Read the input exactly as the task describes and print exactly the required output, nothing else.`,
  shell: `Write a plain bash script with the basic commands of an introductory course: cd, ls, cat, echo, touch, mkdir, cp, mv, rm, chmod with numeric modes, and simple git commands. One command per line, in the order the task lists them. Nothing interactive. Use the exact file names, messages and values from the task.`,
};

function codeMessages({ lang, label, statement }) {
  const style = STYLE[lang] || `Write simple, readable ${label} code the way a good first-year student would, with basic features only.`;
  return [
    { role: 'system', content: `You solve programming exercises for a first-year course.\n${style}\nIf the task says a function, keyword or approach is not allowed, do not use it, and solve it with simpler code instead. Keep comments to a minimum. Reply with the code only: no explanation and no markdown fences.` },
    { role: 'user', content: `Language: ${label}\n\n${statement}` },
  ];
}

function stripFences(text) {
  const m = text.match(/```[^\n]*\n([\s\S]*?)```/);
  return (m ? m[1] : text).trim() + '\n';
}

async function solve(keys, msg, fetchImpl) {
  if (msg.kind === 'quiz') {
    const r = await ask(keys, quizMessages(msg.questions), fetchImpl);
    return { provider: r.provider, answers: parseAnswers(r.text) };
  }
  if (msg.kind === 'code') {
    const r = await ask(keys, codeMessages(msg), fetchImpl);
    return { provider: r.provider, code: stripFences(r.text) };
  }
  throw new Error('Unknown request');
}

if (typeof module !== 'undefined') module.exports = { PROVIDERS, parseKeys, sseText, ask, quizMessages, parseAnswers, codeMessages, stripFences, solve };

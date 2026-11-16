// Run with: node --test
const test = require('node:test');
const assert = require('node:assert');
const { parseKeys, sseText, ask, parseAnswers, stripFences, quizMessages } = require('./llm.js');

const stream = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
const reply = (status, body, headers = {}) => ({ ok: status < 300, status, text: async () => body, headers: { get: h => headers[h] ?? null } });

test('keys file', () => {
  assert.deepStrictEqual(parseKeys('GEMINI_KEY= abc-1_2 \nGROQ_KEY=\n\njunk\n'), { GEMINI_KEY: 'abc-1_2' });
});

test('streamed reply is joined', () => {
  assert.strictEqual(sseText(stream('ANS') + stream('WER')), 'ANSWER');
});

test('answers: letters, typed text, quotes, skip, last line wins', () => {
  const text = 'Working: $\\frac{1}{2}$ so ANSWER 1 is B\nANSWER 1: A\n**ANSWER 1: B**\nAnswer 2: "false"\nANSWER 3: SKIP\nANSWER 4: motherboard';
  assert.deepStrictEqual(parseAnswers(text), { 1: 'B', 2: 'false', 3: null, 4: 'motherboard' });
});

test('code fences are removed', () => {
  assert.strictEqual(stripFences('Here:\n```python\nprint(1)\n```\n'), 'print(1)\n');
  assert.strictEqual(stripFences('echo hi'), 'echo hi\n');
});

test('quiz prompt lists options and marks typed questions', () => {
  const body = quizMessages([{ n: 3, text: 'Pick', options: [{ letter: 'A', text: 'x' }] }, { n: 4, text: 'Type it' }])[1].content;
  assert.match(body, /Question 3 \(choice\)\nPick\nA\) x/);
  assert.match(body, /Question 4 \(typed\)\nType it/);
});

test('falls back to the next provider when one fails', async () => {
  const calls = [];
  const fetchImpl = async url => { calls.push(url); return url.includes('groq') ? reply(200, stream('hi')) : reply(503, 'busy'); };
  const r = await ask({ GEMINI_KEY: 'g', GROQ_KEY: 'q' }, [], fetchImpl);
  assert.strictEqual(r.provider, 'Groq');
  assert.strictEqual(calls.length, 2); // Gemini, then Groq
});

test('rate limit with a short wait is retried once', async () => {
  let n = 0;
  const fetchImpl = async () => (n++ ? reply(200, stream('ok')) : reply(429, 'slow down', { 'retry-after': '0.01' }));
  assert.strictEqual((await ask({ GEMINI_KEY: 'g' }, [], fetchImpl)).text, 'ok');
});

test('no key and all-failed give readable errors', async () => {
  await assert.rejects(ask({}, [], async () => reply(200, '')), /No API key found/);
  await assert.rejects(ask({ GROQ_KEY: 'q' }, [], async () => reply(401, 'bad key')), /Groq 401: bad key/);
  await assert.rejects(ask({ GROQ_KEY: 'q' }, [], async () => reply(200, 'data: [DONE]\n')), /empty answer/);
});

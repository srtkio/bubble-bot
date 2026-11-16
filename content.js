// Reads the portal page, asks the service worker for answers, and puts them in.
// "Fill this page" presses only Next, Previous and answer options and never submits.
// "Auto submit" is the one path that presses Submit, and only on coding questions.
(() => {
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const EXAM = /\b(mid|end)[\s-]*(sem|term)|\bexam(s|ination)?\b/i;
  const BATCH = 6; // questions per model request: small enough for free-tier token limits

  // Text of a node as a person reads it: formulas as their LaTeX source, blocks on their own lines.
  function readText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.classList.contains('katex')) {
      const tex = node.querySelector('annotation');
      return tex ? `$${tex.textContent}$` : node.textContent;
    }
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'IMG') return '[image]';
    const display = getComputedStyle(node).display;
    if (display === 'none') return '';
    let text = '';
    for (const child of node.childNodes) text += readText(child);
    return /^(inline|contents)/.test(display) ? text : `\n${text}\n`;
  }
  // The portal draws every line as its own block and indents with non-breaking spaces. Blank lines go and
  // indents become plain spaces, so a printed pattern reads back exactly as shown.
  const tidy = s => s.replace(/\u00a0/g, ' ').split('\n').filter(l => l.trim()).join('\n');

  const send = msg => chrome.runtime.sendMessage(msg).then(res => {
    if (!res || res.error) throw new Error(res ? res.error : 'No reply from the extension. Reload it, then this page.');
    return res;
  });

  // ---- Quizzes ----

  // One entry per question on screen. A live attempt shows one, a revision page shows all.
  function readQuestions() {
    const all = $$('.text-span-question-renderer');
    return all.map(span => {
      let block = span;
      while (block !== document.body && $$('.text-span-question-renderer', block.parentElement).length === 1) block = block.parentElement;
      const text = tidy(readText(span));
      const input = block.querySelector('input[data-puzzle-answer]');
      const radios = $$('input[type=radio]', block);
      if (input) return { id: input.id, text, input, answered: input.value !== '' };
      if (!radios.length) return { text, skip: 'question type not supported' };
      const options = radios.map(r => ({
        letter: r.value,
        text: tidy(readText(r.closest('label') || r.parentElement)).replace(/^[A-Z]\s*\n/, ''),
      }));
      return { id: radios[0].name, text, radios, options, answered: radios.some(r => r.checked) };
    }).map(q => (!q.skip && /\[image\]/.test(q.text + (q.options || []).map(o => o.text).join()) ? { ...q, skip: 'has a picture' } : q));
  }

  const button = label => $$('button').find(b => b.innerText.trim() === label);
  const position = () => {
    const m = document.body.innerText.match(/question\s+(\d+)\s*\/\s*(\d+)/i);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };

  async function step(label) { // label is only ever 'Next' or 'Previous'
    const from = position()[0];
    const b = button(label);
    if (!b || b.disabled) throw new Error(`Could not find a "${label}" button to press.`);
    b.click();
    for (let i = 0; i < 50 && position()?.[0] === from; i++) await sleep(100);
    if (position()?.[0] === from) throw new Error(`The quiz did not move after "${label}".`);
    await sleep(250); // let the new question finish drawing
  }

  // React ignores a plain .value write, so the value goes in through the native setter plus an input event.
  function typeInto(input, value) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  }

  // Puts one answer in. Returns nothing on success, or the reason it was left alone.
  function place(q, answer) {
    if (answer == null) return 'the model had no answer';
    if (q.input) {
      if (answer.length > q.input.maxLength && q.input.maxLength > 0) return 'answer too long for the box';
      typeInto(q.input, answer);
      return q.input.value === answer ? undefined : 'the page did not accept the text';
    }
    const letter = (answer.match(/^(?:option\s+)?\(?([a-z])\)?(?![a-z])/i) || [])[1];
    const radio = letter && q.radios.find(r => r.value === letter.toUpperCase());
    if (!radio) return `the model answered "${answer.slice(0, 20)}", which is not an option`;
    radio.click();
  }

  async function fillQuiz(ui) {
    const header = document.body.innerText.split(/question\s+\d+\s*\/\s*\d+/i)[0];
    if (EXAM.test(header)) throw new Error('This looks like an exam, going by its title. The bot only fills practice sets.');

    const paged = Boolean(button('Next') && position());
    const seen = [];
    if (paged) {
      while (position()[0] > 1) await step('Previous');
      const total = position()[1];
      for (let n = 1; n <= total; n++) {
        ui.status(`Reading question ${n} of ${total}`);
        const q = readQuestions()[0] || { skip: 'could not read the question' };
        seen.push({ ...q, n });
        if (n < total) await step('Next');
      }
    } else {
      readQuestions().forEach((q, i) => seen.push({ ...q, n: i + 1 }));
    }
    seen.forEach(q => { q.state = q.skip ? 'skipped' : q.answered ? 'kept' : 'pending'; q.why = q.skip || (q.answered ? 'already answered, left as it was' : ''); });
    ui.bubbles(seen);

    const todo = seen.filter(q => q.state === 'pending');
    const answers = {};
    let provider = '';
    for (let i = 0; i < todo.length; i += BATCH) {
      ui.status(`Working out answers ${i + 1} to ${Math.min(i + BATCH, todo.length)} of ${todo.length}`);
      const res = await send({ kind: 'quiz', questions: todo.slice(i, i + BATCH).map(({ n, text, options }) => ({ n, text, options })) });
      Object.assign(answers, res.answers);
      provider = res.provider;
    }

    // Elements read earlier are gone once the quiz moves on, so each question is read again before filling.
    for (let i = seen.length - 1; i >= 0; i--) {
      const q = seen[i];
      const live = paged ? readQuestions()[0] : q;
      if (q.state === 'pending') {
        ui.status(`Filling question ${q.n}`);
        const problem = !live || live.id !== q.id ? 'the question on screen changed' : place(live, answers[q.n] ?? null);
        q.state = problem ? 'skipped' : 'filled';
        q.why = problem || `filled with: ${answers[q.n]}`;
        ui.bubbles(seen);
        if (paged) await sleep(400); // give the portal time to save before moving on
      }
      if (paged && i > 0) await step('Previous');
    }

    const count = s => seen.filter(q => q.state === s).length;
    const left = seen.filter(q => q.state === 'skipped').map(q => q.n);
    ui.status(
      `Filled ${count('filled')} of ${seen.length}${provider ? ` with ${provider}` : ''}.` +
      (count('kept') ? ` ${count('kept')} already had an answer and were left alone.` : '') +
      (left.length ? ` Left for you: ${left.join(', ')}. Hover a hollow bubble for the reason.` : '') +
      ' Check the answers, then submit yourself.');
  }

  // ---- Coding questions ----

  // Synchronous call into page.js, which lives in the page's own world next to the Monaco editors.
  function page(request) {
    const root = document.documentElement;
    root.dataset.bubbleBot = JSON.stringify(request);
    document.dispatchEvent(new Event('bubble-bot'));
    const reply = JSON.parse(root.dataset.bubbleBot);
    delete root.dataset.bubbleBot;
    if (reply.error) throw new Error(reply.error);
    if (!('lang' in reply) && !('text' in reply)) throw new Error('The editor link is not loaded. Reload this page.');
    return reply;
  }

  function readTask() {
    const { lang } = page({});
    const limit = $$('body *').find(e => !e.childElementCount && /^Time Limit:/.test(e.textContent.trim()));
    const panel = limit ? limit.parentElement.parentElement : document.querySelector('.split-view-view') || document.body;
    return {
      lang,
      label: (document.body.innerText.match(/^(.+ \(\d[\d.]*\))$/m) || [])[1] || lang,
      statement: tidy(readText(panel)).split(/\n\s*Generated Expected Output/)[0].slice(0, 12000),
    };
  }

  // retry: { code, verdict, detail } from an attempt that failed, so the model fixes that instead of guessing.
  async function writeCode(ui, task, retry) {
    ui.status(`Writing ${task.label} code`);
    const fix = retry ? `\n\nThis earlier attempt failed: ${retry.verdict}.\n${retry.detail}\n` +
      'Find the mistake and write a corrected solution. Keep the same simple first-year style: fix what is wrong, do not switch to advanced features. ' +
      `If a message says something is not allowed, do not use it.\n\nFailed code:\n${retry.code}` : '';
    const res = await send({ kind: 'code', ...task, statement: task.statement + fix });
    page({ code: res.code });
    return res;
  }

  async function fillCode(ui) {
    const task = readTask();
    const res = await writeCode(ui, task);
    ui.status(`Wrote ${task.label} code with ${res.provider}. Press Run to try it, then submit yourself. Undo in the editor brings back what was there.`);
  }

  // ---- Auto submit (coding sets) ----

  const until = async (test, seconds) => {
    for (let i = 0; i < seconds * 5; i++) { if (test()) return true; await sleep(200); }
    return false;
  };

  // Presses Submit and reads the judge's verdict. The button stays disabled while the judge runs.
  async function submitCode() {
    const submit = button('Submit');
    if (!submit) throw new Error('No Submit button on this page.');
    submit.click();
    await until(() => button('Submit')?.disabled, 5);
    if (!await until(() => button('Submit') && !button('Submit').disabled, 120)) throw new Error('The judge did not answer in two minutes.');
    await sleep(300);
    const page = document.body.innerText;
    const m = page.match(/(\d+)\/(\d+)\s*\n\s*Test Cases Passes/);
    const status = (page.match(/STATUS\s*\n\s*([^\n]+)/) || [])[1] || 'no verdict shown';
    return { ok: Boolean(m) && m[1] === m[2] && m[2] !== '0', verdict: `${status}${m ? `, ${m[1]} of ${m[2]} test cases passed` : ''}` };
  }

  // The first worked example of a task: its input, and the output it should give.
  function sample(statement) {
    const examples = statement.slice(Math.max(0, statement.search(/^\s*(Example|Sample)/mi)));
    // Leading spaces of the first output line belong to the output (patterns), so only [ \t] is skipped before the newline.
    const m = examples.match(/Input(?:[ \t]*\d+)?[ \t]*:?[ \t]*\n([\s\S]*?)\n[ \t]*(?:Sample[ \t]+)?Output(?:[ \t]*\d+)?[ \t]*:?[ \t]*\n([\s\S]*?)(?=\n[ \t]*(?:Explanation|Example|Sample|Input|Note)\b|$)/i);
    const clean = s => (/^(NA|N\/A|none)$/i.test(s.trim()) ? '' : lines(s));
    return m ? { input: clean(m[1]), output: clean(m[2]) } : { input: '', output: '' };
  }
  const lines = s => s.split('\n').map(l => l.trimEnd()).filter(Boolean).join('\n');

  // The box under the editor has input, output and error tabs sharing one text area.
  const panelTab = name => $$('div').find(e => !e.childElementCount && e.textContent.trim() === name);
  function panelNow() {
    const tabs = ['input', 'output', 'error'].map(panelTab).filter(Boolean);
    const active = tabs.find(t => tabs.filter(o => o.className === t.className).length === 1); // the lit one is styled differently
    return { tab: active ? active.textContent.trim() : '', text: page({ panel: true }).text };
  }

  // Presses Run with the given input, the way a person tries code before submitting.
  // Returns null when the page has no Run box, else { failed, text }.
  async function runCode(input) {
    const run = button('Run');
    if (!run || !panelTab('input')) return null;
    panelTab('input').click();
    await sleep(400);
    page({ panel: true, input }); // without input a program that reads would die with an EOF error
    await sleep(200);
    run.click();
    await until(() => run.disabled, 5);
    if (!await until(() => !run.disabled, 60)) return { failed: true, text: 'The run did not finish in a minute: an endless loop, or the program waits for more input than it should.' };
    await sleep(300);
    const now = panelNow(); // the portal jumps to the error tab when the run failed
    return { failed: now.tab === 'error', text: now.text.slice(0, 1500) };
  }

  // Submits the first answer straight away. Only after a rejection does it run the code on the
  // sample to see what went wrong, and later answers must pass that run before they are submitted.
  // Returns true once the judge accepts.
  async function solveAndSubmit(ui, name) {
    if (!await until(() => { try { return page({}) && /Time Limit:/.test(document.body.innerText); } catch { return false; } }, 20)) throw new Error('The code editor did not load.');
    const task = readTask();
    const example = sample(task.statement);

    // Runs the code on the sample. Returns what to tell the model when it fails there, else nothing.
    const trial = async code => {
      const run = await runCode(example.input);
      if (!run) return null;
      if (run.failed) return { code, verdict: 'it gave an error when run on the sample input', detail: `Sample input:\n${example.input}\nError shown:\n${run.text}` };
      if (example.output && lines(run.text) !== lines(example.output)) return { code, verdict: 'wrong output on the sample input', detail: `Sample input:\n${example.input}\nExpected output:\n${example.output}\nIts output:\n${run.text}` };
      return null;
    };

    let retry, held = 0, submits = 0;
    while (submits < 3) {
      const { code } = await writeCode(ui, task, retry);
      if (submits > 0 && held < 2) { // a fix is tried on the sample first; held back at most twice, since the sample reading can be off
        ui.status(`${name}: trying the fix on the sample`);
        const problem = await trial(code);
        if (problem) { held++; retry = problem; continue; }
      }
      ui.status(`${name}: submitting, try ${++submits} of 3`);
      const result = await submitCode();
      if (result.ok) return true;
      ui.status(`${name}: rejected (${result.verdict}), running it to see why`);
      panelTab('error')?.click();
      await sleep(400);
      const shown = panelTab('error') ? page({ panel: true }).text.trim().slice(0, 1500) : '';
      retry = await trial(code) || { code, verdict: 'it passes the sample but the judge rejected it', detail: shown ? `Error tab after submitting:\n${shown}` : 'Think about edge cases: smallest and largest inputs, and the exact output format.' };
      retry.verdict += ` (judge: ${result.verdict})`;
    }
    return false;
  }

  // On a set's question list: opens each unsolved question in turn, solves it, comes back.
  async function autoSubmit(ui, limit) {
    if (location.pathname.startsWith('/playground/')) {
      const ok = await solveAndSubmit(ui, 'This question');
      return ui.status(ok ? 'Accepted.' : 'Still rejected after 3 attempts. The last code is in the editor.', !ok);
    }
    if (!/\/assignment\//.test(location.pathname)) {
      if (!await until(() => document.querySelector(ICONS), 5)) return ui.status('Open the Assignments tab, a coding set, or one coding question first.');
      saveRun({ list: location.href, left: limit, tried: [], accepted: 0, failed: [], errors: 0 });
      return listStep(ui);
    }
    if (EXAM.test(document.body.innerText.split(/\bQ1\./)[0])) throw new Error('This looks like an exam, going by its title. The bot only does practice sets.');

    const listPath = location.pathname;
    // A question card shows "x/y earned"; it is unsolved while x is 0.
    const cards = () => $$('button').filter(b => /^(Attempt Now|View Submission)$/.test(b.innerText.trim())).map((open, i) => {
      let card = open;
      while (card.parentElement && !/\d+\/\d+\s*earned/.test(card.innerText)) card = card.parentElement;
      const [, got, of] = card.innerText.match(/(\d+)\/(\d+)\s*earned/) || [];
      return { n: i + 1, open, solved: Number(got) > 0 }; // a late solve keeps a partial score, so any score counts
    });
    const tried = new Map(); // question number -> accepted?
    for (;;) {
      if (!await until(() => cards().length, 20)) throw new Error('Could not find the question list.');
      const all = cards();
      ui.bubbles(all.map(c => ({ n: c.n, state: tried.get(c.n) === false ? 'skipped' : c.solved ? (tried.has(c.n) ? 'filled' : 'kept') : 'pending',
        why: tried.get(c.n) === false ? 'rejected 3 times, left for you' : c.solved ? 'accepted' : '' })));
      const next = all.find(c => !c.solved && !tried.has(c.n));
      if (!next || (limit && tried.size >= limit)) break;
      next.open.click();
      if (!await until(() => location.pathname.startsWith('/playground/'), 20)) throw new Error(`Question ${next.n} did not open.`);
      tried.set(next.n, await solveAndSubmit(ui, `Question ${next.n}`));
      const back = $$('body *').filter(e => e.innerText?.trim() === 'Back').pop(); // the innermost one; on the portal it is a plain div
      back ? back.click() : history.back();
      if (!await until(() => location.pathname === listPath, 20)) throw new Error('Could not get back to the question list.');
      await sleep(1500); // the list reloads its scores
    }
    const failed = [...tried].filter(([, ok]) => !ok).map(([n]) => n);
    ui.status(`Done. Accepted ${tried.size - failed.length} of ${tried.size} tried.` + (failed.length ? ` Left for you: ${failed.join(', ')}.` : ''), failed.length > 0);
  }

  // ---- Auto submit from the Assignments tab ----
  // The tab opens each question as a fresh page, so the run lives in this tab's sessionStorage and this
  // script picks it up again on every page load: list -> question -> list -> ...

  const RUN = 'bubble-bot-run';
  const saveRun = run => sessionStorage.setItem(RUN, JSON.stringify({ ...run, at: Date.now() }));
  const loadRun = () => {
    const run = JSON.parse(sessionStorage.getItem(RUN) || 'null');
    return run && Date.now() - run.at < 30 * 60 * 1000 ? run : null; // an abandoned run must not wake up later
  };

  // Every question row of the list. Each row starts with the portal's own status icon:
  // verified = solved, tick = tried but not accepted, dash = never tried. The score is no guide,
  // since a question solved late keeps a partial score.
  const ICONS = 'img[src*="file-verified"], img[src*="questionStatus"]';
  function listRows() {
    return $$(ICONS).map(icon => {
      let row = icon.parentElement; // the smallest box around the icon that also holds the score
      while (row.parentElement && !/\d+\/\d+/.test(row.textContent)) row = row.parentElement;
      let setTitle = ''; // the nearest set heading above the row
      for (let e = row; e && e !== document.body && !setTitle; e = e.parentElement)
        for (let s = e.previousElementSibling; s && !setTitle; s = s.previousElementSibling)
          if (/Release -/.test(s.textContent) && !s.querySelector(ICONS)) setTitle = s.textContent;
      const src = icon.getAttribute('src');
      const state = /file-verified/.test(src) ? 'solved' : /tick/.test(src) ? 'tried' : 'fresh';
      return { row, title: row.innerText.split('\n')[0].trim(), state, exam: EXAM.test(setTitle), coding: /^(easy|medium|hard)$/m.test(row.innerText) };
    }).filter(r => r.coding);
  }

  function endRun(ui, run, note) {
    sessionStorage.removeItem(RUN);
    const done = run.accepted + run.failed.length;
    ui.status(`${note} Accepted ${run.accepted} of ${done} tried.` + (run.failed.length ? ` Left for you: ${run.failed.join(', ')}.` : ''), run.failed.length > 0);
  }

  async function listStep(ui) {
    const run = loadRun();
    if (!await until(() => document.querySelector(ICONS), 20)) return endRun(ui, run, 'Could not find the question list.');
    await sleep(1000); // scores arrive a moment after the rows
    if (run.left === 0) return endRun(ui, run, 'Reached the number you set.');
    // The list loads more rows as it is scrolled, so keep scrolling until a never-tried question shows up or the list ends.
    let todo;
    for (;;) {
      todo = listRows().filter(r => r.state !== 'solved' && !r.exam && !run.tried.includes(r.title));
      if (todo.some(r => r.state === 'fresh')) break;
      const icons = $$(ICONS);
      ui.status(`Looking further down the list (${icons.length} questions checked)`);
      scrollTo(0, document.documentElement.scrollHeight);
      for (let e = icons.at(-1); e; e = e.parentElement) // the list scrolls inside its own box
        if (e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight;
      if (!await until(() => $$(ICONS).length > icons.length, 4)) break;
    }
    if (!todo.length) return endRun(ui, run, 'No unsolved questions left.');
    // Never-tried questions come first; ones tried before and not accepted wait until those run out.
    const next = todo.find(r => r.state === 'fresh') || todo[0];
    ui.status(`Opening "${next.title}"`);
    // Click the title itself, the same thing a person clicks.
    const target = $$('*', next.row).find(e => !e.childElementCount && e.textContent.trim() === next.title) || next.row;
    target.dataset.bubbleBotRow = '';
    const root = document.documentElement;
    root.dataset.bubbleBot = JSON.stringify({ openRow: true });
    document.dispatchEvent(new Event('bubble-bot'));
    delete root.dataset.bubbleBot;
    await until(() => root.dataset.bubbleBotUrl, 4);
    const url = root.dataset.bubbleBotUrl;
    delete root.dataset.bubbleBotUrl;
    delete target.dataset.bubbleBotRow;
    if (!url || !url.includes('/playground/')) return endRun(ui, run, `"${next.title}" did not open as a coding question.`);
    saveRun({ ...run, tried: [...run.tried, next.title], current: next.title });
    location.assign(url);
  }

  async function questionStep(ui) {
    const run = loadRun();
    let ok = false;
    try {
      ok = await solveAndSubmit(ui, run.current);
      run.errors = 0;
    } catch (e) {
      ui.status(e.message, true);
      if (++run.errors >= 2) return endRun(ui, { ...run, failed: [...run.failed, run.current] }, `Stopped after two errors in a row: ${e.message}`);
    }
    if (!loadRun()) return; // stopped meanwhile
    if (ok) run.accepted++; else run.failed.push(run.current);
    if (run.left != null) run.left--;
    saveRun(run);
    location.assign(run.list);
  }

  // ---- Panel ----

  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      details { position: fixed; right: 16px; bottom: 88px; z-index: 2147483647; color: #1a237e;
        font: 14px/1.4 "Avenir Next Condensed", "Avenir Next", "Segoe UI", system-ui, sans-serif; }
      summary { list-style: none; margin-left: auto; width: 44px; height: 44px; border-radius: 50%; cursor: pointer; }
      summary::-webkit-details-marker { display: none; }
      summary img { width: 44px; height: 44px; display: block; }
      .slip { position: absolute; right: 0; bottom: 56px; width: 264px; box-sizing: border-box; padding: 12px 14px 14px;
        background: #fff; border: 1.5px solid #c2185b; border-radius: 4px; box-shadow: 4px 4px 0 #fce4ec; }
      h2 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
      ol { display: flex; flex-wrap: wrap; gap: 5px; margin: 0 0 10px; padding: 0; list-style: none; }
      ol:empty { display: none; }
      li { width: 19px; height: 19px; box-sizing: border-box; border-radius: 50%; border: 1.5px solid #c2185b;
        display: grid; place-items: center; font-size: 10px; font-variant-numeric: tabular-nums; color: #c2185b; cursor: default; }
      li.filled { background: #1a237e; border-color: #1a237e; color: #fff; }
      li.kept { background: #c5cae9; border-color: #c5cae9; color: #1a237e; }
      li.skipped { border-width: 2.5px; font-weight: 700; text-decoration: line-through; }
      p { margin: 0 0 10px; color: #5f6368; overflow-wrap: anywhere; }
      p.error { color: #c2185b; }
      button + label, button + button, label + button { margin-top: 6px; }
      button ~ button { background: #fff; color: #1a237e; box-shadow: inset 0 0 0 1.5px #1a237e; }
      button.stop { box-shadow: inset 0 0 0 1.5px #c2185b; color: #c2185b; }
      label { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #5f6368; }
      input { width: 76px; padding: 5px 6px; border: 1.5px solid #c2185b; border-radius: 3px; font: inherit; color: #1a237e; }
      [hidden] { display: none; }
      button { width: 100%; padding: 8px 10px; border: 0; border-radius: 3px; background: #1a237e; color: #fff;
        font: inherit; font-weight: 600; cursor: pointer; }
      button:disabled { background: #c5cae9; cursor: progress; }
      summary:focus-visible, button:focus-visible { outline: 3px solid #c2185b; outline-offset: 2px; }
    </style>
    <details>
      <summary aria-label="Bubble"><img alt=""></summary>
      <div class="slip">
        <h2>Bubble</h2>
        <ol aria-label="Questions"></ol>
        <p role="status">Open a quiz or a coding question, then fill it. Nothing gets submitted.</p>
        <button type="button">Fill this page</button>
        <label>Stop after this many <input type="number" min="1" placeholder="all"></label>
        <button type="button">Auto submit coding questions</button>
        <button type="button" class="stop" hidden>Stop</button>
      </div>
    </details>`;
  shadow.querySelector('summary img').src = chrome.runtime.getURL('icons/icon-128.png');
  const statusLine = shadow.querySelector('p');
  const strip = shadow.querySelector('ol');
  const [fill, auto, stop] = shadow.querySelectorAll('button');
  const howMany = shadow.querySelector('input');
  const ui = {
    status(text, isError) { statusLine.textContent = text; statusLine.className = isError ? 'error' : ''; },
    bubbles(questions) {
      strip.replaceChildren(...questions.map(q => {
        const li = document.createElement('li');
        li.textContent = q.n;
        li.className = q.state;
        li.title = `Question ${q.n}${q.why ? ': ' + q.why : ''}`;
        return li;
      }));
    },
  };

  const run = job => async () => {
    fill.disabled = auto.disabled = true;
    stop.hidden = false;
    strip.replaceChildren();
    try { await job(); } catch (e) { ui.status(e.message, true); }
    fill.disabled = auto.disabled = false;
    stop.hidden = true;
  };
  // A reload is the one stop that works wherever the bot is in its loop.
  stop.addEventListener('click', () => { sessionStorage.removeItem(RUN); location.reload(); });
  fill.addEventListener('click', run(async () => {
    if (location.pathname.startsWith('/playground/')) await fillCode(ui);
    else if (document.querySelector('.text-span-question-renderer')) await fillQuiz(ui);
    else ui.status('Open a quiz or a coding question first.');
  }));
  auto.addEventListener('click', run(() => autoSubmit(ui, Math.floor(Number(howMany.value)) > 0 ? Math.floor(Number(howMany.value)) : null)));

  document.documentElement.append(host);

  // A run started on the Assignments tab continues here after each page load.
  const resumed = loadRun();
  if (resumed) {
    const onList = location.href === resumed.list;
    if (onList || location.pathname.startsWith('/playground/')) {
      shadow.querySelector('details').open = true;
      run(() => (onList ? listStep(ui) : questionStep(ui)))();
    } else sessionStorage.removeItem(RUN);
  }
})();

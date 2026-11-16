// Runs in the page's own JavaScript world, the only place the portal's Monaco editor is reachable.
// content.js calls it synchronously: it writes a request on <html>, fires this event, then reads the reply back.
document.addEventListener('bubble-bot', () => {
  const root = document.documentElement;
  const req = JSON.parse(root.dataset.bubbleBot || '{}');
  if (req.openRow) {
    // The portal opens a listed question with window.open in a new tab. Catching that call
    // gives the question's address without opening anything; content.js then goes there itself.
    const real = window.open;
    const restore = () => { window.open = real; };
    window.open = url => { root.dataset.bubbleBotUrl = String(url); restore(); return null; };
    setTimeout(restore, 3000);
    document.querySelector('[data-bubble-bot-row]')?.click();
    return;
  }
  const m = window.monaco;
  const readOnly = e => e.getOption(m.editor.EditorOption.readOnly);
  const editor = m && m.editor.getEditors().find(e =>
    e.getModel() && e.getModel().getLanguageId() !== 'plaintext' && !readOnly(e));
  if (req.panel) {
    // The text area under the code editor, shared by its input / output / error tabs.
    let box = [...document.querySelectorAll('div')].find(e => !e.childElementCount && e.textContent.trim() === 'output');
    while (box && !box.querySelector('.monaco-editor')) box = box.parentElement;
    const panel = box && m && m.editor.getEditors().find(e => e !== editor && box.contains(e.getDomNode()));
    if (panel && typeof req.input === 'string' && !readOnly(panel)) panel.executeEdits('bubble-bot', [{ range: panel.getModel().getFullModelRange(), text: req.input }]);
    root.dataset.bubbleBot = JSON.stringify(panel ? { text: panel.getModel().getValue() } : { error: 'No run box found on this page.' });
    return;
  }
  if (!editor) {
    root.dataset.bubbleBot = JSON.stringify({ error: 'No code editor found on this page.' });
    return;
  }
  const model = editor.getModel();
  if (typeof req.code === 'string') {
    // An edit, not setValue, so Cmd+Z in the editor brings the old code back.
    editor.pushUndoStop();
    editor.executeEdits('bubble-bot', [{ range: model.getFullModelRange(), text: req.code }]);
    editor.pushUndoStop();
  }
  root.dataset.bubbleBot = JSON.stringify({ lang: model.getLanguageId(), code: model.getValue() });
});

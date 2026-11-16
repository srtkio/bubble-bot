<p align="center"><img src="icons/logo.svg" width="112" alt="Bubble logo"></p>

# Bubble

A browser extension that works through practice sets on the Newton School portal (`my.newtonschool.co`). It fills quiz answers, writes code for coding questions, and can submit coding questions one after another. It runs on free AI model keys.

Use it only on practice work you are allowed to automate. It refuses any set with mid sem, end sem or exam in its title.

## What it does

- **Quizzes:** reads every question, picks the option or types the blank, and stops. You check and submit. Typed answers follow the format note in the question, such as lowercase.
- **Coding questions:** writes Python or Bash in a plain first-year style, straight into the editor.
- **Auto submit:** opens each never-tried coding question, submits, and moves on. When the judge rejects an answer, it runs the code on the sample input, reads the error, and fixes it before trying again.

## Install

Works in Brave, Chrome and Edge.

1. Download this repository: press **Code**, then **Download ZIP**, and unzip it. Or clone it:
   ```
   git clone https://github.com/srtkio/bubble-bot.git
   ```
2. In the folder, make a copy of `keys.example.txt` and name the copy `keys.txt`.
3. Get at least one free key and paste it into `keys.txt`, right after the `=` on its line. Save the file.

   | Line in `keys.txt` | Where to get the key | Role |
   |---|---|---|
   | `GEMINI_KEY` | https://aistudio.google.com/apikey | Tried first. Best answers, but only about 20 requests a day on a free key. |
   | `GROQ_KEY` | https://console.groq.com/keys | Does most of the work. Fast, about 1,000 requests a day. |
   | `NVIDIA_KEY` | https://build.nvidia.com/settings/api-keys | Backup. Slow but accurate. |

4. Open `brave://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
5. Press **Load unpacked** and pick the folder.
6. Open the portal. A round face appears at the bottom right. That is Bubble.

Edits to `keys.txt` apply at once. After changing any other file, press the reload arrow on the extension card and reload the portal tab.

## Use

Click the face to open the panel.

**Fill this page**

- On a quiz: fills every unanswered question and ends on question 1. Questions you answered yourself are left alone. The row of bubbles shows what happened to each question: filled, already yours, or skipped. Hover a hollow bubble for the reason.
- On a coding question: writes the code and stops. You press Run and Submit. Undo in the editor brings back what was there.

**Auto submit coding questions**

Where you press it decides how far it goes:

- **My Assignments, or a subject's Assignments tab:** it finds the never-tried questions by the portal's status icon and does them one by one in the same tab. It stops when none are left, when you press **Stop**, or when it reaches the number in **Stop after this many**.
- **One set's question list:** the unsolved questions of that set.
- **One coding question:** just that question.

Each question gets at most 3 submits. Quizzes are never auto submitted.

Set a number the first time. Left blank, it keeps going through every never-tried question.

## Good to know

- Try it first on a finished quiz in revision mode. Nothing there is saved or scored.
- Questions with pictures, match the columns and comprehension passages are skipped and left for you.
- Choice questions on revision pages are skipped. Typed blanks work there.
- Every auto submit is a real submission on your account, wrong attempts included.
- Your keys stay on your computer in `keys.txt`. That file is ignored by git, so it is never committed. Do not share it.
- Free keys have limits. When one provider runs out, Bubble moves to the next by itself.

## How it is built

| File | Job |
|---|---|
| `content.js` | The panel, reading questions, filling answers, the auto submit loop |
| `page.js` | Talks to the portal's code editor |
| `background.js` | Sends requests to the AI providers |
| `llm.js` | Prompts, provider fallback, answer parsing |
| `test.js` | Tests for `llm.js`. Run with `node --test` |

## License

MIT

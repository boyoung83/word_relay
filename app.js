/* ================================================================
   🎤 말로 하는 끝말잇기 — 게임 로직
   ================================================================ */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

/* ---------------- 설정 ---------------- */
const settings = {
  starter: "player",     // player | computer
  difficulty: "easy",    // easy | normal | hard
  timer: 0,              // 0 | 10 | 20 | 30 (초)
  strict: false,         // 사전에 있는 단어만 인정
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("kkm_settings") || "{}");
    Object.assign(settings, saved);
  } catch (e) { /* 무시 */ }
}
function saveSettings() {
  try { localStorage.setItem("kkm_settings", JSON.stringify(settings)); } catch (e) { /* 무시 */ }
}

/* ---------------- 점수 ---------------- */
const score = { player: 0, computer: 0 };
function loadScore() {
  try {
    const saved = JSON.parse(localStorage.getItem("kkm_score") || "{}");
    Object.assign(score, saved);
  } catch (e) { /* 무시 */ }
}
function saveScore() {
  try { localStorage.setItem("kkm_score", JSON.stringify(score)); } catch (e) { /* 무시 */ }
}
function renderScore() {
  $("#score-player").textContent = score.player;
  $("#score-computer").textContent = score.computer;
}

/* ---------------- 한글 유틸 ---------------- */
const HANGUL_RE = /[가-힣]/g;

function onlyHangul(str) {
  return (str.match(HANGUL_RE) || []).join("");
}

// 두음법칙: 력→역, 라→나, 뇨→요 ...
// 종성 있는 음절도 처리 (초성/중성만 바꾸고 종성 유지)
const IY_JUNG = new Set([2, 3, 6, 7, 12, 17, 20]); // ㅑㅒㅕㅖㅛㅠㅣ
function dueum(ch) {
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return null;
  const cho = Math.floor(code / 588);
  const jung = Math.floor((code % 588) / 28);
  const jong = code % 28;
  if (cho === 5) { // ㄹ → ㅇ(이중모음/ㅣ) 또는 ㄴ
    const newCho = IY_JUNG.has(jung) ? 11 : 2;
    return String.fromCharCode(0xac00 + (newCho * 21 + jung) * 28 + jong);
  }
  if (cho === 2 && IY_JUNG.has(jung)) { // ㄴ + ㅕㅛㅠㅣ… → ㅇ
    return String.fromCharCode(0xac00 + (11 * 21 + jung) * 28 + jong);
  }
  return null;
}

// 단어의 끝 글자로 시작 가능한 음절들 (두음법칙 포함)
function allowedStartsFor(word) {
  const last = word[word.length - 1];
  const starts = [last];
  const alt = dueum(last);
  if (alt && alt !== last) starts.push(alt);
  return starts;
}

function startsLabel(starts) {
  return starts.length > 1
    ? `'${starts[0]}' 또는 '${starts[1]}'`
    : `'${starts[0]}'`;
}

/* ---------------- 사전 색인 ---------------- */
const wordSet = new Set(WORDS);
const wordsByFirst = new Map();
for (const w of WORDS) {
  const f = w[0];
  if (!wordsByFirst.has(f)) wordsByFirst.set(f, []);
  wordsByFirst.get(f).push(w);
}

function candidatesFor(starts, used) {
  const out = [];
  for (const s of starts) {
    for (const w of wordsByFirst.get(s) || []) {
      if (!used.has(w)) out.push(w);
    }
  }
  return out;
}

// 이 단어 다음에 이을 수 있는 사전 단어 개수 (상대가 얼마나 쉬운가)
function contCount(word, used) {
  return candidatesFor(allowedStartsFor(word), used).length;
}

/* ---------------- 게임 상태 ---------------- */
const game = {
  chain: [],           // {word, by: 'player'|'computer'}
  used: new Set(),
  turn: null,          // 'player' | 'computer'
  playing: false,
  requiredStarts: null, // 첫 단어면 null
  timerId: null,
  timeLeft: 0,
};

/* ---------------- 효과음 (WebAudio) ---------------- */
let audioCtx = null;
function getAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* 무시 */ }
  }
  return audioCtx;
}
function tone(freq, start, dur, type = "sine", gain = 0.15) {
  const ctx = getAudio();
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(gain, ctx.currentTime + start);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
  o.connect(g).connect(ctx.destination);
  o.start(ctx.currentTime + start);
  o.stop(ctx.currentTime + start + dur + 0.05);
}
const sfx = {
  good() { tone(660, 0, 0.12); tone(880, 0.1, 0.18); },
  bad() { tone(220, 0, 0.25, "square", 0.08); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.13, 0.22, "triangle", 0.18)); },
  lose() { [440, 392, 330].forEach((f, i) => tone(f, i * 0.18, 0.25, "triangle", 0.12)); },
};

/* ---------------- 음성 합성 (TTS) ---------------- */
let koVoice = null;
function pickVoice() {
  const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  koVoice =
    voices.find((v) => v.lang === "ko-KR" && /Google|Yuna|Heami/i.test(v.name)) ||
    voices.find((v) => v.lang && v.lang.startsWith("ko")) ||
    null;
}
if (window.speechSynthesis) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}
function speak(text, { rate = 0.95, pitch = 1.15 } = {}) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ko-KR";
    if (koVoice) u.voice = koVoice;
    u.rate = rate;
    u.pitch = pitch;
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
    // 일부 브라우저에서 onend가 안 오는 경우 대비
    setTimeout(resolve, 1000 + text.length * 350);
  });
}

/* ---------------- 음성 인식 (STT) ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const sttSupported = !!SR;
let recognizing = false;
let recognition = null;

function startListening() {
  if (!sttSupported || recognizing || game.turn !== "player" || !game.playing) return;
  if (window.speechSynthesis) speechSynthesis.cancel(); // 컴퓨터 목소리가 마이크에 들어가지 않게
  recognition = new SR();
  recognition.lang = "ko-KR";
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;
  recognizing = true;
  setMicState("listening");

  let finalText = "";
  recognition.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) finalText += t;
      else interim += t;
    }
    setStatus(`👂 "${onlyHangul(finalText + interim) || "..."}"`);
  };
  recognition.onerror = (ev) => {
    recognizing = false;
    setMicState("idle");
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      setStatus("🚫 마이크를 사용할 수 없어요. 브라우저에서 마이크를 허용해 주세요!");
      showKeyboard(true);
    } else if (game.playing && game.turn === "player") {
      setStatus("🙉 잘 안 들렸어요. 마이크를 누르고 다시 말해 줄래요?");
    }
  };
  recognition.onend = () => {
    recognizing = false;
    setMicState("idle");
    const word = onlyHangul(finalText);
    if (word && game.playing && game.turn === "player") {
      handlePlayerWord(word);
    }
  };
  try { recognition.start(); } catch (e) { recognizing = false; setMicState("idle"); }
}

function stopListening() {
  if (recognition && recognizing) {
    try { recognition.stop(); } catch (e) { /* 무시 */ }
  }
}

function setMicState(state) {
  const btn = $("#mic-btn");
  btn.classList.toggle("listening", state === "listening");
  btn.classList.toggle("disabled", state === "disabled");
  $("#mic-label").textContent =
    state === "listening" ? "듣는 중..." : state === "disabled" ? "기다려요" : "말하기";
}

/* ---------------- UI 헬퍼 ---------------- */
function setStatus(html) {
  $("#status").innerHTML = html;
}

function highlightLast(word) {
  return `${word.slice(0, -1)}<span class="last-char">${word[word.length - 1]}</span>`;
}

function addBubble(word, by, extraClass = "") {
  const row = document.createElement("div");
  row.className = `bubble-row ${by} ${extraClass}`;
  row.innerHTML = `
    <div class="avatar">${by === "computer" ? "🤖" : "🦁"}</div>
    <div class="bubble">${highlightLast(word)}</div>`;
  $("#chat").appendChild(row);
  $("#chat").scrollTop = $("#chat").scrollHeight;
  return row;
}

function addNote(text) {
  const div = document.createElement("div");
  div.className = "note";
  div.textContent = text;
  $("#chat").appendChild(div);
  $("#chat").scrollTop = $("#chat").scrollHeight;
}

function clearChat() {
  $("#chat").innerHTML = "";
}

function showKeyboard(show) {
  $("#type-form").classList.toggle("hidden", !show);
  if (show) $("#type-input").focus();
}

/* ---------------- 타이머 ---------------- */
function startTimer() {
  stopTimer();
  if (!settings.timer) return;
  game.timeLeft = settings.timer;
  renderTimer();
  game.timerId = setInterval(() => {
    game.timeLeft--;
    renderTimer();
    if (game.timeLeft <= 0) {
      stopTimer();
      stopListening();
      onTimeout();
    }
  }, 1000);
}
function stopTimer() {
  if (game.timerId) clearInterval(game.timerId);
  game.timerId = null;
  $("#timer").textContent = "";
}
function renderTimer() {
  const t = $("#timer");
  t.textContent = `⏰ ${game.timeLeft}초`;
  t.classList.toggle("urgent", game.timeLeft <= 5);
}

function onTimeout() {
  if (!game.playing || game.turn !== "player") return;
  addNote("⏰ 시간이 다 됐어요!");
  endRound("computer", "시간이 다 지나갔어요!");
}

/* ---------------- 칭찬 멘트 ---------------- */
const PRAISES = ["우와, 잘한다!", "멋진 단어야!", "오, 대단한걸?", "정말 잘하네!", "좋았어!"];
function randomPraise() {
  return PRAISES[Math.floor(Math.random() * PRAISES.length)];
}

/* ---------------- 게임 진행 ---------------- */
function newRound() {
  game.chain = [];
  game.used = new Set();
  game.requiredStarts = null;
  game.playing = true;
  stopTimer();
  clearChat();
  $("#end-overlay").classList.add("hidden");
  $("#start-overlay").classList.add("hidden");
  renderScore();

  if (settings.starter === "computer") {
    computerFirstWord();
  } else {
    game.turn = "player";
    setMicState("idle");
    setStatus("🌟 아무 단어나 말해 봐! (두 글자 이상)");
    speak("아무 단어나 말해 봐!");
    startTimer();
  }
}

async function computerFirstWord() {
  game.turn = "computer";
  setMicState("disabled");
  setStatus("🤖 컴퓨터가 생각하고 있어요...");
  await delay(900);
  // 이어가기 쉬운 단어로 시작
  const nice = WORDS.filter((w) => contCount(w, game.used) >= 4);
  const word = pick(nice.length ? nice : WORDS);
  await playComputerWord(word);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function playComputerWord(word) {
  game.chain.push({ word, by: "computer" });
  game.used.add(word);
  addBubble(word, "computer");
  await speak(word);
  game.requiredStarts = allowedStartsFor(word);
  game.turn = "player";
  setMicState("idle");
  setStatus(`🔤 ${startsLabel(game.requiredStarts)}(으)로 시작하는 단어를 말해 봐!`);
  startTimer();
}

// 사용자의 단어 검사
function validatePlayerWord(word) {
  if (word.length < 2) return { ok: false, msg: "한 글자는 안 돼요! 두 글자 이상 말해 줘." };
  if (game.requiredStarts && !game.requiredStarts.includes(word[0])) {
    return { ok: false, msg: `${startsLabel(game.requiredStarts)}(으)로 시작해야 해요!` };
  }
  if (game.used.has(word)) return { ok: false, msg: `앗! '${word}'는 벌써 나왔어요!` };
  if (settings.strict && !wordSet.has(word)) {
    return { ok: false, msg: `'${word}'는 사전에 없는 단어예요. 다른 단어 어때요?` };
  }
  return { ok: true };
}

async function handlePlayerWord(raw) {
  if (!game.playing || game.turn !== "player") return;
  let word = raw;
  let check = validatePlayerWord(word);

  // "사과요" 처럼 '요'를 붙여 말했을 때 한 번 더 시도
  if (!check.ok && word.length > 2 && word.endsWith("요")) {
    const trimmed = word.endsWith("이요") ? word.slice(0, -2) : word.slice(0, -1);
    if (trimmed.length >= 2 && validatePlayerWord(trimmed).ok) {
      word = trimmed;
      check = { ok: true };
    }
  }

  if (!check.ok) {
    sfx.bad();
    setStatus(`❌ ${check.msg}`);
    speak(check.msg);
    return; // 다시 기회!
  }

  stopTimer();
  game.chain.push({ word, by: "player" });
  game.used.add(word);
  addBubble(word, "player");
  sfx.good();

  game.turn = "computer";
  setMicState("disabled");
  await computerMove(word);
}

async function computerMove(playerWord) {
  const starts = allowedStartsFor(playerWord);
  setStatus("🤖 컴퓨터가 생각하고 있어요...");
  const thinking = addBubble("· · ·", "computer", "thinking");
  await delay(900 + Math.random() * 800);

  let candidates = candidatesFor(starts, game.used);
  if (!candidates.length) {
    thinking.remove();
    await speak(`${startsLabel(starts).replace(/'/g, "")}... 으로 시작하는 단어를 모르겠어! 내가 졌다!`);
    endRound("player", `컴퓨터가 ${startsLabel(starts)}(으)로 시작하는 단어를 몰라요!`);
    return;
  }

  // 난이도: 상대가 이어가기 쉬운/어려운 단어 고르기
  candidates.sort((a, b) => contCount(b, game.used) - contCount(a, game.used));
  let word;
  if (settings.difficulty === "easy") {
    word = pick(candidates.slice(0, Math.min(5, candidates.length)));
  } else if (settings.difficulty === "hard") {
    word = pick(candidates.slice(-Math.min(3, candidates.length)));
  } else {
    word = pick(candidates);
  }

  thinking.remove();
  await playComputerWord(word);
}

/* ---------------- 힌트 / 몰라요 ---------------- */
function giveHint() {
  if (!game.playing || game.turn !== "player") return;
  const starts = game.requiredStarts;
  if (!starts) {
    const w = pick(WORDS);
    addNote(`💡 힌트: '${w}' 어때요?`);
    speak(`${w} 어때?`);
    return;
  }
  const candidates = candidatesFor(starts, game.used);
  if (!candidates.length) {
    addNote("💡 음... 나도 떠오르는 단어가 없어요!");
    speak("음... 나도 떠오르는 단어가 없어!");
    return;
  }
  candidates.sort((a, b) => contCount(b, game.used) - contCount(a, game.used));
  const w = pick(candidates.slice(0, Math.min(5, candidates.length)));
  addNote(`💡 힌트: '${w}' 어때요?`);
  speak(`${w} 어때?`);
}

function giveUp() {
  if (!game.playing || game.turn !== "player") return;
  stopTimer();
  stopListening();
  const starts = game.requiredStarts;
  if (!starts) { // 첫 단어부터 포기하면 그냥 다시
    setStatus("괜찮아요! 아무 단어나 좋아요. 예를 들면 '사과'!");
    speak("괜찮아! 아무 단어나 좋아. 예를 들면 사과!");
    return;
  }
  const candidates = candidatesFor(starts, game.used);
  if (!candidates.length) {
    addNote("🤝 사실 나도 몰라요! 이번 판은 비겼어요!");
    speak("사실 나도 몰라! 비겼다!");
    endRound(null, "둘 다 모르는 글자였어요! 무승부!");
  } else {
    const examples = candidates.slice(0, 3).join(", ");
    addNote(`이런 단어도 있었어요: ${examples}`);
    endRound("computer", `이런 단어도 있었어요: ${examples}`);
  }
}

function replayLastWord() {
  const lastComputer = [...game.chain].reverse().find((c) => c.by === "computer");
  if (lastComputer) speak(lastComputer.word);
}

/* ---------------- 라운드 종료 ---------------- */
function endRound(winner, reason) {
  game.playing = false;
  game.turn = null;
  stopTimer();
  setMicState("disabled");

  const count = game.chain.length;
  let title, emoji;
  if (winner === "player") {
    score.player++;
    title = "네가 이겼어! 🎉";
    emoji = "🏆";
    sfx.win();
    confetti();
    speak("네가 이겼어! 축하해!");
  } else if (winner === "computer") {
    score.computer++;
    title = "컴퓨터가 이겼어요";
    emoji = "🤖";
    sfx.lose();
    speak("아쉽다! 다음엔 꼭 이길 수 있을 거야!");
  } else {
    title = "무승부!";
    emoji = "🤝";
  }
  saveScore();
  renderScore();

  $("#end-emoji").textContent = emoji;
  $("#end-title").textContent = title;
  $("#end-reason").textContent = reason;
  $("#end-count").textContent = count > 0 ? `단어를 ${count}개나 이었어요!` : "";
  setTimeout(() => $("#end-overlay").classList.remove("hidden"), winner === "player" ? 1200 : 600);
}

/* ---------------- 색종이 (confetti) ---------------- */
function confetti() {
  const canvas = $("#confetti");
  const ctx = canvas.getContext("2d");
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  canvas.classList.remove("hidden");
  const colors = ["#ff6b6b", "#feca57", "#48dbfb", "#1dd1a1", "#ff9ff3", "#f368e0"];
  const parts = Array.from({ length: 120 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.5,
    r: 4 + Math.random() * 6,
    c: colors[Math.floor(Math.random() * colors.length)],
    vy: 2 + Math.random() * 3,
    vx: -1.5 + Math.random() * 3,
    rot: Math.random() * Math.PI,
    vr: -0.1 + Math.random() * 0.2,
  }));
  let frames = 0;
  (function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6);
      ctx.restore();
    }
    if (++frames < 200) requestAnimationFrame(draw);
    else canvas.classList.add("hidden");
  })();
}

/* ---------------- 설정 UI ---------------- */
function bindSegmented(groupSel, key, parse = (v) => v) {
  $$(groupSel + " button").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(groupSel + " button").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      settings[key] = parse(btn.dataset.value);
      saveSettings();
    });
  });
}
function reflectSettings() {
  const map = {
    "#opt-starter": String(settings.starter),
    "#opt-difficulty": String(settings.difficulty),
    "#opt-timer": String(settings.timer),
    "#opt-strict": String(settings.strict),
  };
  for (const [sel, val] of Object.entries(map)) {
    $$(sel + " button").forEach((b) => b.classList.toggle("on", b.dataset.value === val));
  }
}

/* ---------------- 초기화 ---------------- */
function init() {
  loadSettings();
  loadScore();
  renderScore();
  reflectSettings();

  bindSegmented("#opt-starter", "starter");
  bindSegmented("#opt-difficulty", "difficulty");
  bindSegmented("#opt-timer", "timer", (v) => parseInt(v, 10));
  bindSegmented("#opt-strict", "strict", (v) => v === "true");

  $("#start-btn").addEventListener("click", () => {
    getAudio(); // 사용자 제스처로 오디오 활성화
    newRound();
  });
  $("#again-btn").addEventListener("click", newRound);
  $("#home-btn").addEventListener("click", () => {
    $("#end-overlay").classList.add("hidden");
    $("#start-overlay").classList.remove("hidden");
  });
  $("#settings-btn").addEventListener("click", () => {
    game.playing = false;
    stopTimer();
    stopListening();
    if (window.speechSynthesis) speechSynthesis.cancel();
    $("#start-overlay").classList.remove("hidden");
  });

  $("#mic-btn").addEventListener("click", () => {
    if (recognizing) stopListening();
    else startListening();
  });
  $("#hint-btn").addEventListener("click", giveHint);
  $("#giveup-btn").addEventListener("click", giveUp);
  $("#replay-btn").addEventListener("click", replayLastWord);
  $("#kb-btn").addEventListener("click", () => {
    showKeyboard($("#type-form").classList.contains("hidden"));
  });
  $("#type-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const word = onlyHangul($("#type-input").value.trim());
    $("#type-input").value = "";
    if (word) handlePlayerWord(word);
  });

  if (!sttSupported) {
    $("#stt-warning").classList.remove("hidden");
    showKeyboard(true);
  }

  setMicState("disabled");
  setStatus("▶️ 시작 버튼을 눌러 주세요!");
}

document.addEventListener("DOMContentLoaded", init);

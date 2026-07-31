/* ===================================================================
   VEKTER — studieverktøy
   Neo-brutalistisk, statisk (ingen server / ingen fetch), bygget rundt
   spaced repetition. Datafilene lastes lokalt som vanlige scriptfiler.
   =================================================================== */

// Ingen ES-moduler: datafilene lastes som vanlige <script> før denne,
// og deler global scope (QUESTIONS, MODULES, FORKLARINGER, nyeFlashcards,
// LAEREBOK, getQuestionsForModule). Da kjører appen rett fra file://.

/* ---------------- Hjelpere ---------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad2 = (n) => String(n).padStart(2, "0");
const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const DAY = 86_400_000;
const todayKey = () => new Date().toISOString().slice(0, 10);

/* ===================================================================
   1) LAGRING — én ren nøkkel. Vi lagrer mestring per spørsmål
      (intervaller), leste kapitler og streak. Det er dette som gjør
      pugging effektiv: appen henter tilbake det du er i ferd med å glemme.
   =================================================================== */
const KEY = "vekter";
const store = loadStore();

function loadStore() {
  let s = {}; try { s = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
  return {
    q: s.q || {},
    read: s.read || {},
    streak: s.streak || { count: 0, last: null },
    exams: s.exams || [],
    lastStudy: s.lastStudy || null,
    reading: s.reading || {},
    bookmarks: s.bookmarks || {},
    completed: s.completed || {},
    attempted: s.attempted || {},
    activeExam: s.activeExam || null,
    sectionLinks: s.sectionLinks || {},
  };
}
const save = () => localStorage.setItem(KEY, JSON.stringify(store));
const qstat = (id) => {
  const s = store.q[id] || (store.q[id] = {});
  // Migrerer tidligere Leitner-data uten å miste fremgang.
  if (s.reps == null) s.reps = Math.max(0, (s.box || 0) - 1);
  if (s.interval == null) s.interval = [0, 1, 3, 7, 16][Math.max(0, (s.box || 1) - 1)] || 0;
  if (s.ease == null) s.ease = 2.5;
  if (s.lapses == null) s.lapses = s.wrong || 0;
  if (s.seen == null) s.seen = 0;
  if (s.correct == null) s.correct = 0;
  if (s.wrong == null) s.wrong = 0;
  if (s.due == null) s.due = 0;
  if (s.starred == null) s.starred = false;
  return s;
};
const isDue = (id) => { const s = store.q[id]; return !s || !s.seen || s.due <= Date.now(); };
const isMastered = (id) => {
  const s = store.q[id];
  return !!s && (s.reps || 0) >= 3 && (s.interval || 0) >= 7;
};

function scheduleReview(id, rating) {
  const s = qstat(id); s.seen++;
  if (rating === "again") {
    s.wrong++; s.last = "wrong"; s.lapses++; s.reps = 0; s.interval = 0;
    s.ease = Math.max(1.3, s.ease - 0.2);
    s.due = Date.now() + 10 * 60_000;
  } else {
    s.correct++; s.last = "right"; s.reps++;
    if (s.reps === 1) s.interval = rating === "easy" ? 3 : 1;
    else if (s.reps === 2) s.interval = rating === "hard" ? 2 : rating === "easy" ? 7 : 3;
    else {
      const factor = rating === "hard" ? 1.2 : rating === "easy" ? s.ease + 0.35 : s.ease;
      s.interval = Math.max(s.interval + 1, Math.round(s.interval * factor));
    }
    s.ease = clamp(s.ease + (rating === "hard" ? -0.15 : rating === "easy" ? 0.15 : 0), 1.3, 3.2);
    s.due = Date.now() + s.interval * DAY;
  }
  bumpStreak(); save();
}
const recordAnswer = (id, correct) => scheduleReview(id, correct ? "good" : "again");
const rateCard = (id, rating) => scheduleReview(id, rating);
function bumpStreak() {
  const t = todayKey(), st = store.streak; if (st.last === t) return;
  const yest = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  st.count = st.last === yest ? st.count + 1 : 1; st.last = t;
}

/* ---------------- Mestring ---------------- */
const masteryOf = (id) => {
  const s = store.q[id]; if (!s?.seen) return 0;
  const stability = Math.min(1, (s.interval || 0) / 21);
  const accuracy = s.correct / Math.max(1, s.correct + s.wrong);
  return clamp(stability * .7 + accuracy * .3, 0, 1);
};
const poolMastery = (list) => list.length ? Math.round(list.reduce((a, q) => a + masteryOf(q.id), 0) / list.length * 100) : 0;
const seenCount = () => QUESTIONS.filter((q) => store.q[q.id]?.seen).length;
const masteredCount = () => QUESTIONS.filter((q) => isMastered(q.id)).length;
const dueList = () => QUESTIONS.filter((q) => store.q[q.id]?.seen && isDue(q.id));
const dueFlashcards = () => nyeFlashcards.filter((q) => store.q[q.id]?.seen && isDue(q.id));
const wrongList = () => QUESTIONS.filter((q) => store.q[q.id]?.last === "wrong");
const starredList = () => QUESTIONS.filter((q) => store.q[q.id]?.starred);

/* ---------------- Tilstand ---------------- */
const book = LAEREBOK;
let session = null;
let fc = null;
let examTimer = null;
let readerSaveTimer = null;
const RING = 2 * Math.PI * 52;
const setRing = (el, pct) => { el.style.strokeDasharray = RING; el.style.strokeDashoffset = RING * (1 - pct / 100); };

/* ===================================================================
   2) OVERSIKT (slank: status + mine feil + stjernemerkede)
   =================================================================== */
function renderDashboard() {
  const mastery = poolMastery(QUESTIONS);
  $("#readiness").textContent = `${mastery}%`;
  $("#readiness-bar").style.width = `${mastery}%`;
  $("#stat-readiness").textContent = `${mastery}%`;
  $("#stat-mastered").textContent = masteredCount();
  $("#stat-seen").textContent = seenCount();
  $("#stat-streak").textContent = store.streak.count || 0;
  $("#streak-num").textContent = store.streak.count || 0;
  $("#wrong-count").textContent = wrongList().length;
  $("#starred-count").textContent = starredList().length;

  const h = new Date().getHours();
  $("#hero-greeting").textContent = h < 6 ? "Nattpugging?" : h < 11 ? "God morgen." : h < 18 ? "Klar for en økt?" : "Kveldsøkt?";
  const due = dueList().length + dueFlashcards().length, unseen = QUESTIONS.length - seenCount();
  $("#hero-sub").textContent = due ? `${due} elementer er klare for repetisjon.` : unseen ? `${unseen} spørsmål du ikke har sett ennå.` : "Alt er ferskt — bra jobba!";
  $("#review-cta").textContent = due ? `Repeter ${due} elementer som forfaller nå` : "Start smart repetisjon";
  renderContinueCard();
  renderExamHistory();
}

function renderContinueCard() {
  const card = $("#continue-card"), last = store.activeExam ? { type: "exam", ...store.activeExam } : store.lastStudy;
  card.classList.toggle("hidden", !last);
  if (!last) return;
  if (last.type === "exam") {
    $("#continue-title").textContent = "Pågående eksamen";
    $("#continue-sub").textContent = `${Math.max(0, Math.ceil((last.endAt - Date.now()) / 60000))} minutter igjen · spørsmål ${(last.i || 0) + 1} av ${last.ids?.length || 80}`;
  } else if (last.type === "reading") {
    const ch = book[last.chapter];
    $("#continue-title").textContent = ch ? `${ch.nummer}. ${ch.tittel}` : "Fortsett å lese";
    $("#continue-sub").textContent = "Fortsett i læreboka fra sist lagrede posisjon.";
  } else {
    $("#continue-title").textContent = last.title || "Fortsett økten";
    $("#continue-sub").textContent = `${last.index || 0} av ${last.total || 0} fullført`;
  }
}

function renderExamHistory() {
  const rows = (store.exams || []).slice(0, 5);
  $("#exam-history").innerHTML = rows.length ? rows.map((x) => `
    <button class="card card-hover flex items-center gap-4 p-4 text-left" data-exam-history="${x.id || x.date}">
      <span class="grid h-12 w-12 place-items-center border-2 border-ink ${x.passed ? "bg-lime" : "bg-bad text-white"} font-display text-lg font-700">${x.pct}%</span>
      <span class="min-w-0 flex-1"><b class="block font-display">${x.passed ? "Bestått" : "Ikke bestått"}</b>
      <small class="text-ink/55">${new Date(x.date).toLocaleDateString("nb-NO")} · ${x.correct}/${x.total} riktig · ${formatDuration(x.elapsed)}</small></span>
      <small class="text-right text-ink/55">${(x.weak || []).slice(0, 2).join("<br>")}</small>
    </button>`).join("") : `<p class="border-2 border-dashed border-ink/30 p-4 text-sm text-ink/55">Ingen fullførte eksamener ennå.</p>`;
}

function openExamHistory(id) {
  const exam = (store.exams || []).find((x) => String(x.id || x.date) === String(id));
  if (!exam) return;
  $("#history-detail-title").textContent = `${exam.passed ? "Bestått" : "Ikke bestått"} · ${exam.pct}%`;
  $("#history-detail-summary").innerHTML = `<b>${new Date(exam.date).toLocaleString("nb-NO")}</b><span class="ml-3 text-sm text-ink/60">${exam.correct}/${exam.total} riktig · ${formatDuration(exam.elapsed)}</span>`;
  const byId = new Map(QUESTIONS.map((q) => [String(q.id), q]));
  $("#history-detail-list").innerHTML = (exam.ids || []).map((id, index) => {
    const source = byId.get(String(id)); if (!source) return "";
    const q = orderedQuestion(source, exam.orders?.[index]);
    const chosen = exam.answers?.[q.id], correct = chosen === q.ans;
    return `<article class="border-2 border-ink p-4 ${correct ? "bg-lime/20" : "bg-bad/10"}">
      <b class="font-display">${index + 1}. ${q.q}</b>
      <p class="mt-2 text-sm ${correct ? "text-ok" : "text-bad"}">${chosen == null ? "Ikke besvart" : `Ditt svar: ${q.opts[chosen]}`}</p>
      <p class="mt-1 text-sm"><b>Riktig:</b> ${q.opts[q.ans]}</p>
    </article>`;
  }).join("") || `<p class="text-sm text-ink/60">Denne eldre eksamenen har ikke detaljert svarhistorikk.</p>`;
  $("#exam-history-detail").showModal();
}

const formatDuration = (seconds) => {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return h ? `${h} t ${m} min` : `${m} min ${s} sek`;
};

/* ===================================================================
   3) ØV — moduler (kategori-basert) og kapitler (pensum), atskilt
   =================================================================== */
const barHTML = (pct) => `<span class="mt-1 block h-2 w-full border-2 border-ink bg-white"><span class="block h-full bg-ink" style="width:${pct}%"></span></span>`;

function practiceCard({ badge, title, sub, count, pct, startAttr, wrongAttr, wrongCount }) {
  return `<article class="card p-4 text-left">
    <span class="flex items-start gap-3">
      <span class="grid h-11 w-11 shrink-0 place-items-center border-2 border-ink bg-lime font-display text-lg font-700">${badge}</span>
      <span class="min-w-0">
        <span class="block font-display font-700 leading-tight">${title}</span>
        ${sub ? `<span class="block truncate text-xs text-ink/55">${sub}</span>` : ""}
        ${wrongCount ? `<button class="mt-1 block text-xs font-bold text-bad hover:underline" ${wrongAttr}>Repeter feil · ${wrongCount}</button>` : ""}
      </span>
    </span>
    ${barHTML(pct)}
    <span class="mt-2 flex items-center justify-between gap-4 text-xs font-bold">
      <span class="text-ink/55">${count} spm · ${pct}%</span>
      <button class="text-brand hover:underline" ${startAttr}>Start →</button>
    </span>
  </article>`;
}

function questionsForModule(m) {
  let qs = getQuestionsForModule(m.id, QUESTIONS).filter((q) => !q.kapittel);
  if (m.num === 1) qs = qs.filter((q) => !/service|kunde|kvalitet|tilbakemelding/i.test(`${q.q} ${q.opts.join(" ")}`));
  if (m.num === 5) qs = getQuestionsForModule("modul_1", QUESTIONS).filter((q) => /service|kunde|kvalitet|tilbakemelding/i.test(`${q.q} ${q.opts.join(" ")}`));
  if (m.num === 8) qs = qs.filter((q) => q.cat !== "Personvern");
  return qs;
}

function renderPractice() {
  $("#practice-list").innerHTML = MODULES.map((m) => {
    const qs = questionsForModule(m);
    const pct = store.completed[`module:${m.id}`] ? 100 : poolMastery(qs);
    const wrongCount = qs.filter((q) => store.q[q.id]?.last === "wrong").length;
    return practiceCard({ badge: moduleIcon(m.num), title: m.name, count: qs.length, pct, wrongCount, startAttr: `data-module="${m.id}"`, wrongAttr: `data-module-wrong="${m.id}"` });
  }).join("");
}

function moduleIcon(num) {
  const paths = {
    1: '<path d="M4 20v-8l8-5 8 5v8M8 20v-5h8v5M9 7V4h6v3"/>',
    2: '<path d="M12 3 4 7v5c0 5 3.4 8 8 10 4.6-2 8-5 8-10V7l-8-4Z"/><path d="m9 12 2 2 4-4"/>',
    3: '<path d="M4 19h16M6 17V8l6-4 6 4v9M9 17v-5h6v5"/>',
    4: '<circle cx="12" cy="8" r="4"/><path d="M5 21c.8-5 3-7 7-7s6.2 2 7 7"/>',
    5: '<path d="M4 5h16v11H8l-4 4V5Z"/><path d="M8 9h8M8 12h5"/>',
    6: '<path d="M12 3v18M5 7h14M7 7l-3 6h6L7 7Zm10 0-3 6h6l-3-6Z"/>',
    7: '<path d="M5 20V8l7-5 7 5v12M9 20v-7h6v7"/><path d="M3 20h18"/>',
    8: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/>',
    9: '<path d="M12 3 4 7v6c0 4 3 7 8 9 5-2 8-5 8-9V7l-8-4Z"/><path d="M12 8v5M12 17h.01"/>',
    10: '<path d="M4 19h16M6 19V9h12v10M9 9V5h6v4M9 13h6"/>',
    11: '<path d="M3 12h18M12 3v18"/><circle cx="12" cy="12" r="8"/>',
    12: '<path d="M12 22s7-3 7-10V5l-7-3-7 3v7c0 7 7 10 7 10Z"/><path d="M9 12h6M12 9v6"/>',
    13: '<path d="M4 17h16M7 17V7h10v10M9 7V4h6v3"/><path d="M10 11h4"/>',
    14: '<path d="M4 18h16M6 18V8h12v10"/><path d="m9 13 2 2 4-5"/>',
    15: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'
  };
  return `<svg aria-hidden="true" class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[num] || paths[1]}</svg>`;
}

/* ===================================================================
   4) LES — læreboka
   =================================================================== */
function renderChapters() {
  const read = book.filter((c) => store.read[c.nummer]).length;
  $("#read-progress").textContent = `${read}/${book.length} lest`;
  $("#chapter-list").innerHTML = book.map((ch, index) => {
    const done = store.read[ch.nummer];
    const chapterQuestions = QUESTIONS.filter((q) => q.kapittel === ch.nummer);
    const pct = poolMastery(chapterQuestions);
    const wrongCount = chapterQuestions.filter((q) => store.q[q.id]?.last === "wrong").length;
    const attempted = !!store.attempted[`chapter:${ch.nummer}`];
    const hasQuiz = chapterQuestions.length > 0;
    return `<article class="card card-hover flex items-center gap-3 p-4 ${done ? "!bg-lime/40" : ""}">
      <button class="flex min-w-0 flex-1 items-center gap-4 text-left" data-chapter="${index}">
        <span class="grid h-11 w-11 shrink-0 place-items-center border-2 border-ink bg-white">${moduleIcon(ch.nummer)}</span>
        <span class="min-w-0 flex-1">
          <span class="block font-display font-700 leading-tight">${ch.tittel}</span>
          <span class="block text-xs text-ink/55">Kapittel ${ch.nummer} · ${ch.timer || 1} t · ${pct}% mestret</span>
        </span>
      </button>
      <span class="flex min-w-[9.5rem] shrink-0 flex-col items-end gap-1.5">
        <button class="text-sm font-bold underline underline-offset-4 ${done ? "text-ok" : "text-brand"}" data-chapter="${index}">${done ? "✓ Lest" : "Les →"}</button>
        ${hasQuiz ? `<span class="flex w-full items-center ${attempted && wrongCount ? "justify-between" : "justify-end"} gap-3">
          ${attempted && wrongCount ? `<button class="text-xs font-bold text-bad underline underline-offset-4" data-chapter-wrong="${ch.nummer}">Repeter feil · ${wrongCount}</button>` : ""}
          <button class="bg-lime px-1 text-sm font-bold text-ink underline underline-offset-4" data-chapter-quiz="${ch.nummer}">Øv →</button>
        </span>` : ""}
      </span>
    </article>`;
  }).join("");
}

function flattenContent(items = []) {
  return items.map((item) => {
    if (Array.isArray(item)) return flattenContent(item);
    if (item.type === "h2") return `<h2>${item.tittel || ""}</h2>${flattenContent(item.innhold)}`;
    if (item.type === "h3") return `<h3>${item.tittel || ""}</h3>${flattenContent(item.innhold)}`;
    if (item.type === "tekst") return readerTextBlock(item.tekst || "");
    if (item.type === "nummerert") return `<ol>${(item.items || []).map((li) => `<li>${typeof li === "string" ? li : li.tekst || ""}</li>`).join("")}</ol>`;
    if (item.type === "punktliste" || Array.isArray(item.items)) return `<ul>${(item.items || []).map((li) => `<li>${typeof li === "string" ? li : li.tekst || ""}</li>`).join("")}</ul>`;
    if (item.tittel || item.tekst) return `${item.tittel ? `<h3>${item.tittel}</h3>` : ""}${item.tekst ? `<p>${item.tekst}</p>` : ""}${flattenContent(item.innhold)}`;
    return flattenContent(item.innhold);
  }).join("");
}

// Beholder ordlyden urørt, men løfter ekte læreboksignaler til callouts.
// (Ingen «keyline» lenger — den traff halvparten av avsnittene og ble støy.)
function readerTextBlock(text) {
  const trimmed = text.trim();
  let kind = "";
  if (/^(📌|viktig[^:]{0,20}:|kjerneprinsipp\s*:|definisjon\s*:|merk\s*:|nb\s*:)/i.test(trimmed)) kind = "important";
  else if (/^(⚠️|lovkrav\s*:|advarsel\s*:)/i.test(trimmed)) kind = "warning";
  else if (/^(📋|eksempel\b|svar\s*:)/i.test(trimmed)) kind = "example";
  else if (/^(husk(?:eregel)?\s*:|praktisk (?:tips|råd)\s*:|refleksjon\s*:|tips\s*:)/i.test(trimmed)) kind = "remember";
  return kind ? `<aside class="reader-callout reader-callout--${kind}"><p>${text}</p></aside>` : `<p>${text}</p>`;
}

// Bygger kapittelinnhold med innholdsfortegnelse (hopp til hver hovedseksjon).
function readerHTML(ch) {
  const toc = [];
  const body = (ch.seksjoner || []).map((sec) => {
    if (sec && sec.type === "h2") {
      const id = `sec-${toc.length + 1}`;
      toc.push({ id, t: sec.tittel || "" });
      const key = `${ch.nummer}:${id}`, saved = !!store.bookmarks[key];
      return `<div class="reader-section-title"><h2 id="${id}">${sec.tittel || ""}</h2><button class="reader-section-bookmark ${saved ? "active" : ""}" data-bookmark-section="${key}" title="Bokmerk seksjon">${saved ? "★" : "☆"}</button></div>${flattenContent(sec.innhold)}`;
    }
    return flattenContent([sec]);
  }).join("");
  const toc_html = toc.length > 1
    ? `<nav class="reader-toc">
         <p class="mb-3 font-display text-xs font-700 uppercase tracking-wider">I dette kapittelet</p>
         <ol class="list-none">${toc.map((s) => `<li><a data-toc="${s.id}" href="#${s.id}">${s.t}</a></li>`).join("")}</ol>
       </nav>`
    : "";
  return { toc: toc_html, body };
}

let readerIndex = null;
function openChapter(index) {
  const ch = book[index]; if (!ch) return;
  readerIndex = index;
  store.lastStudy = { type: "reading", chapter: index };
  save();
  $("#reader-title").textContent = `${ch.nummer}. ${ch.tittel}`;
  const rendered = readerHTML(ch);
  $("#reader-sidebar").innerHTML = rendered.toc;
  $("#reader-sidebar").style.display = rendered.toc ? "" : "none";
  $("#reader-sidebar").classList.remove("open");
  const tocToggle = $("#reader-toc-toggle");
  tocToggle.hidden = !rendered.toc;
  tocToggle.setAttribute("aria-expanded", "false");
  $("#reader-content").innerHTML = rendered.body;
  $("#reader").scrollTop = 0;
  updateReadButton();
  const rp = $("#reader-practice");
  rp.dataset.chapterQuiz = ch.nummer;
  rp.style.display = QUESTIONS.some((q) => q.kapittel === ch.nummer) ? "" : "none";
  $("[data-reader-prev]").disabled = index === 0;
  $("[data-reader-next]").disabled = index === book.length - 1;
  if (!$("#reader").open) $("#reader").showModal();
  const savedTop = store.reading[ch.nummer] || 0;
  requestAnimationFrame(() => { $("#reader").scrollTop = savedTop; syncReaderToc(); updateReaderProgress(); });
  updateReaderTools();
  syncReaderToc();
}

function openChapterAtText(index, text) {
  openChapter(index);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const wanted = String(text || "").trim();
    const candidates = $$("h2, h3, p, li", $("#reader-content"));
    const target = candidates.find((el) => el.textContent.trim() === wanted)
      || candidates.find((el) => el.textContent.includes(wanted));
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("reader-jump-target");
    setTimeout(() => target.classList.remove("reader-jump-target"), 1800);
  }));
}
const stepChapter = (d) => { if (readerIndex != null) openChapter(clamp(readerIndex + d, 0, book.length - 1)); };

function updateReaderProgress() {
  const r = $("#reader"), bar = $("#reader-progress > span");
  if (!r || !bar) return;
  const max = r.scrollHeight - r.clientHeight;
  bar.style.width = `${max > 0 ? clamp((r.scrollTop / max) * 100, 0, 100) : 0}%`;
}

function syncReaderToc() {
  const headings = $$("[id^='sec-']", $("#reader-content"));
  if (!headings.length) return;
  const readerTop = $("#reader").getBoundingClientRect().top;
  let current = headings[0].id;
  for (const heading of headings) {
    if (heading.getBoundingClientRect().top <= readerTop + 150) current = heading.id;
    else break;
  }
  $$("[data-toc]", $("#reader-sidebar")).forEach((link) => {
    link.classList.toggle("active", link.dataset.toc === current);
  });
}

function updateReadButton() {
  const done = store.read[book[readerIndex].nummer];
  const btn = $("[data-toggle-read]");
  btn.textContent = done ? "✓ Lest" : "Marker lest";
  btn.classList.toggle("btn-brand", !!done);
  btn.classList.toggle("text-white", !!done);
  btn.classList.toggle("bg-[#BFE4FF]", !done);
}

function updateReaderTools() {
  const ch = book[readerIndex]; if (!ch) return;
  const saved = !!store.bookmarks[`chapter:${ch.nummer}`];
  const btn = $("[data-bookmark-chapter]");
  btn.textContent = saved ? "★" : "☆";
  btn.title = saved ? "Fjern bokmerke" : "Bokmerk kapittel";
  btn.setAttribute("aria-label", btn.title);
  btn.classList.toggle("active", saved);
}

function toggleChapterBookmark() {
  const ch = book[readerIndex]; if (!ch) return;
  const key = `chapter:${ch.nummer}`;
  store.bookmarks[key] = store.bookmarks[key] ? undefined : { chapter: ch.nummer, title: ch.tittel };
  if (!store.bookmarks[key]) delete store.bookmarks[key];
  save(); updateReaderTools(); renderBookmarks();
}

function toggleSectionBookmark(key) {
  const [chapter, section] = key.split(":");
  const ch = book.find((x) => x.nummer === Number(chapter));
  const heading = $("#" + section)?.textContent || "Seksjon";
  store.bookmarks[key] = store.bookmarks[key] ? undefined : { chapter: Number(chapter), section, title: heading };
  if (!store.bookmarks[key]) delete store.bookmarks[key];
  save();
  const btn = $(`[data-bookmark-section="${key}"]`);
  if (btn) { btn.classList.toggle("active", !!store.bookmarks[key]); btn.textContent = store.bookmarks[key] ? "★" : "☆"; }
  renderBookmarks();
}

function setReaderList(name) {
  $("#chapter-list").hidden = name !== "chapters";
  $("#bookmark-list").hidden = name !== "bookmarks";
  $("#glossary-list").hidden = name !== "glossary";
  $$(".reader-list-tab").forEach((b) => {
    const on = b.dataset.readerList === name;
    b.classList.toggle("btn-brand", on); b.classList.toggle("text-white", on); b.classList.toggle("btn-white", !on);
  });
  if (name === "bookmarks") renderBookmarks();
  if (name === "glossary") renderGlossary();
}

function renderBookmarks() {
  const rows = Object.entries(store.bookmarks).filter(([, x]) => x);
  $("#bookmark-list").innerHTML = rows.length ? rows.map(([key, x]) => `
    <button class="card card-hover flex items-center gap-3 p-4 text-left" data-open-bookmark="${key}">
      <span class="text-xl text-brand">★</span><span class="flex-1"><b class="block font-display">${x.title}</b><small class="text-ink/55">Kapittel ${x.chapter}</small></span><span>→</span>
    </button>`).join("") : `<p class="border-2 border-dashed border-ink/30 p-5 text-sm text-ink/55">Ingen bokmerker ennå.</p>`;
}

function collectBookText(items = [], chapter, rows = []) {
  items.forEach((item) => {
    if (Array.isArray(item)) return collectBookText(item, chapter, rows);
    if (item?.tittel) rows.push({ chapter, type: "heading", text: item.tittel });
    if (item?.tekst) rows.push({ chapter, type: "text", text: item.tekst });
    // Listepunkter er søkbare, men holdes utenfor ordlisten (de er sjekkliste-
    // etiketter som «Klær: farge, type», ikke ekte definisjoner).
    (item?.items || []).forEach((x) => rows.push({ chapter, type: "listitem", text: typeof x === "string" ? x : x.tekst || "" }));
    if (item?.innhold) collectBookText(item.innhold, chapter, rows);
  });
  return rows;
}

const BOOK_INDEX = book.flatMap((ch, index) => collectBookText(ch.seksjoner, index));
const GLOSSARY = BOOK_INDEX.filter((x) => x.type === "text" && /^[^:]{2,32}:/.test(x.text)).map((x) => {
  const idx = x.text.indexOf(":");
  return { ...x, term: x.text.slice(0, idx).trim(), definition: x.text.slice(idx + 1).trim() };
}).filter((x, i, arr) =>
  /^[A-ZÆØÅ]/.test(x.term) &&                    // begrep starter med stor forbokstav
  x.term.split(/\s+/).length <= 3 &&              // maks 3 ord — ekte term, ikke setning
  x.term.length <= 32 &&
  !/[.,;!?]/.test(x.term) &&                      // ingen setningstegn i selve begrepet
  x.definition.length >= 20 &&
  !/^(?:\d|📋|⚠️|📌|eksempel|svar|lovdata|neste kapittel|kilde|husk|tips|merk|nb|viktig)/i.test(x.term) &&
  arr.findIndex((y) => y.term.toLowerCase() === x.term.toLowerCase()) === i
).sort((a, b) => a.term.localeCompare(b.term, "nb"));

function renderGlossary(filter = "") {
  const q = filter.trim().toLowerCase();
  const rows = GLOSSARY.filter((x) => !q || `${x.term} ${x.definition}`.toLowerCase().includes(q)).slice(0, 200);
  $("#glossary-list").innerHTML = rows.map((x) => `<button class="card card-hover p-4 text-left" data-search-chapter="${x.chapter}" data-search-text="${encodeURIComponent(x.text)}"><b class="font-display text-brand">${x.term}</b><span class="mt-1 block text-sm leading-6 text-ink/75">${x.definition}</span></button>`).join("");
}

function runSearch() {
  const q = $("#global-search").value.trim().toLowerCase(), out = $("#search-results");
  if (q.length < 2) { out.hidden = true; return toast("Skriv minst to tegn."); }
  const bookHits = BOOK_INDEX.filter((x) => x.text.toLowerCase().includes(q)).slice(0, 8);
  const questionHits = QUESTIONS.filter((x) => `${x.q} ${x.opts.join(" ")}`.toLowerCase().includes(q)).slice(0, 6);
  const termHits = GLOSSARY.filter((x) => `${x.term} ${x.definition}`.toLowerCase().includes(q)).slice(0, 5);
  const rows = [
    ...termHits.map((x) => ({ label: "Begrep", title: x.term, sub: x.definition, chapter: x.chapter, text: x.text })),
    ...bookHits.map((x) => ({ label: "Lærebok", title: book[x.chapter].tittel, sub: x.text, chapter: x.chapter, text: x.text })),
    ...questionHits.map((x) => ({ label: "Spørsmål", title: x.q, sub: x.cat, question: x.id })),
  ];
  out.hidden = false;
  out.innerHTML = rows.length ? rows.map((x) => `<button class="border-2 border-ink bg-white p-3 text-left" ${x.chapter != null ? `data-search-chapter="${x.chapter}" data-search-text="${encodeURIComponent(x.text || x.sub)}"` : `data-search-question="${x.question}"`}><span class="tag bg-lime">${x.label}</span><b class="mt-2 block font-display">${x.title}</b><small class="mt-1 block line-clamp-2 text-ink/60">${x.sub}</small></button>`).join("") : `<p class="text-sm text-ink/55">Ingen treff.</p>`;
}

/* ===================================================================
   5) FORKLARINGER
   =================================================================== */
function buildExplanation(q, chosen, correct) {
  const rich = FORKLARINGER[q.id]; let body = "", src = "";
  if (rich) {
    if (correct) body = rich.riktig || "";
    else {
      const originalChoice = q.optionOrder?.[chosen] ?? chosen;
      const why = rich.feil && rich.feil[originalChoice];
      body = why ? `${why}<br><br><b class="text-ok">Riktig:</b> ${rich.riktig || ""}` : (rich.riktig || "");
    }
    src = rich.kilde || "";
  } else if (q.forklaring) {
    body = correct ? q.forklaring : `<b class="text-ok">Riktig svar:</b> ${q.opts[q.ans]}<br><br>${q.forklaring}`;
  } else body = `Riktig svar er: ${q.opts[q.ans]}`;
  return { body, src };
}

/* ===================================================================
   6) QUIZ-MOTOR
   =================================================================== */
function shuffledOptions(q) {
  const optionOrder = shuffle(q.opts.map((_, index) => index));
  return { ...q, opts: optionOrder.map((index) => q.opts[index]), ans: optionOrder.indexOf(q.ans), optionOrder };
}

function startSession({ mode, title, list, isExam = false, examFeedback = false, restart, next, progressKey, compact = false }) {
  if (!list?.length) return;
  list = list.map(shuffledOptions);
  session = { mode, title, list, i: 0, correct: 0, wrong: [], answers: {}, isExam, examFeedback, restart, next, progressKey, startedAt: Date.now(), maxVisited: 0, flagged: new Set() };
  $("#quiz-mode").textContent = mode;
  $("#quiz-title").textContent = title;
  $("#quiz-question-panel").hidden = false;
  $("#quiz-result-panel").hidden = true;
  $("#exam-overview-panel").hidden = true;
  $("#exam-timer").hidden = !isExam;
  $("#exam-review-toggle-wrap").hidden = true;
  $("#exam-review-list").hidden = true;
  $("#exam-review-toggle").checked = false;
  $("#quiz").classList.toggle("chapter-quiz", compact);
  if (!$("#quiz").open) $("#quiz").showModal();
  if (!isExam) store.lastStudy = { type: "quiz", title, mode, progressKey, ids: list.map((q) => q.id), index: 0, total: list.length, answers: {}, correct: 0, wrongIds: [] };
  save();
  showQuestion();
}
function startModule(id) {
  const m = MODULES.find((x) => x.id === id); if (!m) return;
  const nextModule = MODULES[MODULES.indexOf(m) + 1];
  startSession({ mode: "Moduløkt", title: m.name, list: shuffle(questionsForModule(m)), progressKey: `module:${id}`, restart: () => startModule(id), next: nextModule ? () => startModule(nextModule.id) : null });
}
function startChapterQuiz(num) {
  num = Number(num); const ch = book.find((c) => c.nummer === num);
  const nextChapter = book.find((c) => c.nummer > num && QUESTIONS.some((q) => q.kapittel === c.nummer));
  startSession({ mode: "Kapitteløkt", title: ch ? ch.tittel : `Kapittel ${num}`, list: shuffle(QUESTIONS.filter((q) => q.kapittel === num)), progressKey: `chapter:${num}`, restart: () => startChapterQuiz(num), next: nextChapter ? () => startChapterQuiz(nextChapter.nummer) : null, compact: true });
}
function startChapterWrong(num) {
  num = Number(num);
  const list = shuffle(QUESTIONS.filter((q) => q.kapittel === num && store.q[q.id]?.last === "wrong"));
  if (!list.length) return toast("Ingen feil i dette kapittelet.");
  startSession({ mode: "Repeter feil", title: `${chapterName(num)} · feil`, list, restart: () => startChapterWrong(num), compact: true });
}
function startMixedQuiz() {
  const list = [];
  for (let chapter = 1; chapter <= 15; chapter++) {
    list.push(...shuffle(QUESTIONS.filter((q) => q.kapittel === chapter)).slice(0, 2));
  }
  startSession({ mode: "Blandet quiz", title: "30 spørsmål · hele pensum", list: shuffle(list), restart: startMixedQuiz });
}
function startPoolWrong(list, title) {
  const wrong = shuffle(list.filter((q) => store.q[q.id]?.last === "wrong"));
  if (!wrong.length) return toast("Ingen feil i denne bunken ennå.");
  startSession({ mode: "Repeter feil", title, list: wrong, restart: () => startPoolWrong(list, title) });
}
function startReview(type) {
  const due = dueList();
  const dueCards = dueFlashcards();
  if (type === "cards") {
    const cards = dueCards.length
      ? dueCards
      : shuffle(nyeFlashcards.filter((card) => !store.q[card.id]?.seen)).slice(0, 5);
    if (!cards.length) return toast("Ingen flashcards er klare akkurat nå.");
    return openFlashcards(null, dueCards.length > 0, null, cards);
  }
  return startReviewQuestions(due);
}
function startReviewQuestions(due) {
  const pool = due.length ? due : (seenCount() < QUESTIONS.length ? QUESTIONS.filter((q) => !store.q[q.id]?.seen) : QUESTIONS);
  const list = shuffle(pool).sort((a, b) => (store.q[a.id]?.due || 0) - (store.q[b.id]?.due || 0)).slice(0, 20);
  startSession({ mode: "Repetisjon", title: "Smart repetisjon", list, restart: startReview });
}
function startWrong() {
  const list = shuffle(wrongList()).slice(0, 25);
  if (!list.length) return toast("Ingen feil å repetere — bra jobba! 🎉");
  startSession({ mode: "Mine feil", title: "Repeter feilene dine", list, restart: startWrong });
}
function startStarred() {
  const list = shuffle(starredList()).slice(0, 25);
  if (!list.length) return toast("Ingen stjernemerkede ennå — trykk ☆ i en økt.");
  startSession({ mode: "Stjernemerkede", title: "Dine lagrede spørsmål", list, restart: startStarred });
}
/** Prøveeksamen: minimum 3 spørsmål fra HVERT kapittel — ikke helt tilfeldig. */
function openExamSetup() {
  if (store.activeExam) return resumeExam();
  if (!$("#exam-setup").open) $("#exam-setup").showModal();
}

function startExam() {
  const PER = 3, TARGET = 80, picks = [], seen = new Set();
  for (let ch = 1; ch <= 15; ch++)
    for (const q of shuffle(QUESTIONS.filter((x) => x.kapittel === ch)).slice(0, PER)) { picks.push(q); seen.add(q.id); }
  const rest = shuffle(QUESTIONS.filter((q) => !seen.has(q.id)));
  while (picks.length < TARGET && rest.length) picks.push(rest.pop());
  $("#exam-setup").close();
  const examFeedback = document.querySelector('input[name="exam-mode"]:checked')?.value === "feedback";
  startSession({ mode: examFeedback ? "Eksamen med fasit" : "Prøveeksamen", title: "80 spørsmål · min. 3 fra hvert kapittel", list: shuffle(picks).slice(0, TARGET), isExam: true, examFeedback, restart: openExamSetup });
  session.duration = 4 * 60 * 60;
  session.endAt = Date.now() + session.duration * 1000;
  session.remaining = session.duration;
  persistActiveExam();
  startExamClock();
}

function updateExamTimer() {
  if (session?.endAt) session.remaining = Math.max(0, Math.ceil((session.endAt - Date.now()) / 1000));
  const sec = Math.max(0, session?.remaining || 0), h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  $("#exam-timer").textContent = `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  $("#exam-timer").classList.toggle("bg-bad", sec <= 300);
  $("#exam-timer").classList.toggle("text-white", sec <= 300);
}

function startExamClock() {
  clearInterval(examTimer);
  updateExamTimer();
  if (session.remaining <= 0) return showResult(true);
  examTimer = setInterval(() => {
    if (!session?.isExam) return;
    updateExamTimer();
    if (session.remaining <= 0) { clearInterval(examTimer); showResult(true); }
  }, 1000);
}

function persistActiveExam() {
  if (!session?.isExam) return;
  store.activeExam = {
    ids: session.list.map((q) => q.id),
    orders: session.list.map((q) => q.optionOrder),
    answers: { ...session.answers },
    i: session.i,
    correct: session.correct,
    wrongIds: session.wrong.map((q) => q.id),
    examFeedback: session.examFeedback,
    endAt: session.endAt,
    startedAt: session.startedAt,
    flagged: [...session.flagged],
    maxVisited: session.maxVisited,
  };
  save();
}

function orderedQuestion(q, order) {
  if (!Array.isArray(order) || order.length !== q.opts.length) return shuffledOptions(q);
  return { ...q, opts: order.map((index) => q.opts[index]), ans: order.indexOf(q.ans), optionOrder: order };
}

function resumeExam() {
  const saved = store.activeExam;
  if (!saved?.ids?.length) return;
  $("#quiz").classList.remove("chapter-quiz");
  const byId = new Map(QUESTIONS.map((q) => [String(q.id), q]));
  const list = saved.ids.map((id, index) => {
    const q = byId.get(String(id));
    return q ? orderedQuestion(q, saved.orders?.[index]) : null;
  }).filter(Boolean);
  session = {
    mode: saved.examFeedback ? "Eksamen med fasit" : "Prøveeksamen",
    title: "80 spørsmål · min. 3 fra hvert kapittel",
    list, i: clamp(saved.i || 0, 0, list.length - 1), correct: saved.correct || 0,
    wrong: (saved.wrongIds || []).map((id) => list.find((q) => String(q.id) === String(id))).filter(Boolean),
    answers: saved.answers || {}, isExam: true, examFeedback: !!saved.examFeedback,
    startedAt: saved.startedAt || Date.now(), duration: 4 * 60 * 60, endAt: saved.endAt,
    remaining: Math.ceil((saved.endAt - Date.now()) / 1000),
    flagged: new Set(saved.flagged || []), maxVisited: saved.maxVisited || saved.i || 0,
    restart: openExamSetup,
  };
  $("#quiz-mode").textContent = session.mode;
  $("#quiz-title").textContent = session.title;
  $("#quiz-question-panel").hidden = false;
  $("#quiz-result-panel").hidden = true;
  $("#exam-overview-panel").hidden = true;
  $("#exam-timer").hidden = false;
  if (!$("#quiz").open) $("#quiz").showModal();
  showQuestion();
  startExamClock();
}

function showQuestion() {
  const q = session.list[session.i];
  if (session.isExam) session.maxVisited = Math.max(session.maxVisited || 0, session.i);
  $("#quiz-count").textContent = `Spørsmål ${session.i + 1} av ${session.list.length}`;
  $("#quiz-live-score").textContent = session.i > 0 && (!session.isExam || session.examFeedback) ? `${session.correct} riktige` : "";
  $("#quiz-bar").style.width = `${(session.i / session.list.length) * 100}%`;
  $("#question").textContent = q.q;
  $("#answers").innerHTML = q.opts.map((a, i) =>
    `<button class="answer card flex w-full items-center gap-3 p-3.5 text-left" data-answer="${i}">
      <span class="grid h-7 w-7 shrink-0 place-items-center border-2 border-ink bg-white font-display text-sm font-700 !text-ink">${String.fromCharCode(65 + i)}</span>
      <span>${a}</span></button>`).join("");
  const chosen = session.answers[q.id];
  if (chosen != null) {
    $$(".answer").forEach((btn, i) => {
      if (session.examFeedback) {
        btn.disabled = true;
        if (i === q.ans) btn.classList.add("!bg-ok", "!text-white");
        if (i === chosen && chosen !== q.ans) btn.classList.add("!bg-bad", "!text-white");
      } else if (session.isExam && i === chosen) btn.classList.add("!bg-brand", "!text-white");
    });
  }
  const exp = $("#explanation"); exp.hidden = true; exp.removeAttribute("data-kind");
  $("#question-book-link").hidden = true;
  $("#question-book-excerpt").hidden = true;
  $("#next-question").hidden = session.isExam || chosen == null;
  $("#next-question").textContent = session.i + 1 === session.list.length ? "Lever eksamen →" : "Neste →";
  $("#exam-question-tools").hidden = !session.isExam;
  $("[data-exam-next]").disabled = chosen == null;
  $("[data-exam-next]").textContent = session.i + 1 === session.list.length ? "Lever →" : "Neste →";
  $("[data-exam-prev]").disabled = !session.isExam || session.i === 0;
  $("[data-exam-flag]").textContent = session.flagged?.has(q.id) ? "Fjern flagg" : "Flagg spørsmål";
  updateStar();
  session.answered = chosen != null;
  if (session.isExam) persistActiveExam();
}
function updateStar() {
  const on = !!store.q[session.list[session.i].id]?.starred;
  const b = $("[data-star]"); b.textContent = on ? "★" : "☆"; b.classList.toggle("text-brand", on); b.classList.toggle("text-ink/40", !on);
}
function answerQuestion(index) {
  if (session.answered && (!session.isExam || session.examFeedback)) return;
  session.answered = true;
  const q = session.list[session.i], correct = index === q.ans;
  const previous = session.answers[q.id];
  session.answers[q.id] = index;
  if (!session.isExam) {
    recordAnswer(q.id, correct);
    if (correct) session.correct++; else session.wrong.push(q);
  } else {
    session.correct = session.list.filter((item) => session.answers[item.id] === item.ans).length;
    session.wrong = session.list.filter((item) => session.answers[item.id] != null && session.answers[item.id] !== item.ans);
  }
  const showFeedback = !session.isExam || session.examFeedback;
  $$(".answer").forEach((btn, i) => {
    btn.disabled = !session.isExam || session.examFeedback;
    btn.classList.remove("!bg-ok", "!bg-bad", "!bg-brand", "!text-white");
    if (showFeedback && i === q.ans) btn.classList.add("!bg-ok", "!text-white");
    if (showFeedback && i === index && !correct) btn.classList.add("!bg-bad", "!text-white");
    if (session.isExam && !session.examFeedback && i === index) btn.classList.add("!bg-brand", "!text-white");
  });
  if (!session.isExam || session.examFeedback) {
    const { body, src } = buildExplanation(q, index, correct);
    const compactBody = body.replace(/(?:<br\s*\/?>\s*){2,}/gi, "<br>");
    const exp = $("#explanation");
    exp.className = `mt-3 border-2 border-ink p-3 text-sm leading-6 ${correct ? "bg-lime/50" : "bg-bad/15"}`;
    exp.innerHTML = `<b class="font-display ${correct ? "text-ok" : "text-bad"}">${correct ? "✓ Riktig" : "✗ Feil"}</b><p class="mt-1">${compactBody}</p>${src ? `<span class="mt-1 block text-[11px] text-ink/55">Kilde: ${src}</span>` : ""}`;
    exp.hidden = false;
    $("#question-book-link").hidden = questionChapter(q) == null;
  }
  const last = session.i + 1 === session.list.length;
  const next = $("#next-question");
  next.textContent = last ? "Se resultat →" : "Neste →";
  next.hidden = session.isExam;
  const examNext = $("[data-exam-next]");
  examNext.textContent = last ? "Lever →" : "Neste →";
  examNext.disabled = false;
  (session.isExam ? examNext : next).focus();
  if (session.isExam) persistActiveExam();
  if (!session.isExam && store.lastStudy?.type === "quiz") {
    store.lastStudy.index = session.i + 1;
    store.lastStudy.answers = { ...session.answers };
    store.lastStudy.correct = session.correct;
    store.lastStudy.wrongIds = session.wrong.map((x) => x.id);
    save();
  }
}
function nextQuestion() {
  if (!session?.answered) return toast("Velg et svar før du går videre.");
  if (session.i + 1 >= session.list.length) return showResult();
  session.i++; showQuestion();
}

function previousExamQuestion() {
  if (!session?.isExam || session.i === 0) return;
  session.i--; showQuestion();
}

function toggleExamFlag() {
  if (!session?.isExam) return;
  const id = session.list[session.i].id;
  session.flagged.has(id) ? session.flagged.delete(id) : session.flagged.add(id);
  $("[data-exam-flag]").textContent = session.flagged.has(id) ? "Fjern flagg" : "Flagg spørsmål";
  persistActiveExam();
}

function renderExamOverview() {
  if (!session?.isExam) return;
  $("#quiz-question-panel").hidden = true;
  $("#exam-overview-panel").hidden = false;
  $("#exam-overview-grid").innerHTML = session.list.map((q, index) => {
    const visited = index <= (session.maxVisited || 0);
    const answered = session.answers[q.id] != null;
    const flagged = session.flagged.has(q.id);
    const stateClass = index === session.i ? "bg-[#BFE4FF]" : flagged ? "bg-warn" : answered ? "bg-lime" : "bg-white";
    return `<button class="grid aspect-square place-items-center border-2 border-ink font-display font-bold ${stateClass}" data-exam-jump="${index}" ${visited ? "" : "disabled"}>${index + 1}</button>`;
  }).join("");
}

function closeExamOverview() {
  $("#exam-overview-panel").hidden = true;
  $("#quiz-question-panel").hidden = false;
}

function showResult(timedOut = false) {
  clearInterval(examTimer);
  if (session.isExam) {
    session.list.filter((q) => session.answers[q.id] == null && !session.wrong.includes(q)).forEach((q) => session.wrong.push(q));
  }
  const total = session.list.length, pct = Math.round(session.correct / total * 100), passed = pct >= 80;
  $("#quiz-bar").style.width = "100%";
  $("#quiz-question-panel").hidden = true;
  $("#exam-overview-panel").hidden = true;
  $("#quiz-result-panel").hidden = false;
  $("#result-pct").textContent = `${pct}%`;
  $("#result-verdict").textContent = session.isExam ? (passed ? "Bestått ✓" : "Ikke bestått") : `${session.correct}/${total} riktig`;
  const fill = $("#result-ring-fill"); fill.style.stroke = passed ? "#0F9D6E" : "#E0485F"; setRing(fill, pct);
  $("#result-summary").textContent = session.isExam
    ? (timedOut ? "Tiden gikk ut. Ubesvarte spørsmål er regnet som feil." : passed ? "Sterkt! Du er over beståttgrensen på 80 %." : "Beståttgrensen er 80 %. Se gjennom feilene og prøv igjen.")
    : (session.wrong.length ? `Du bommet på ${session.wrong.length}. De er lagt i «Mine feil».` : "Full pott! 🎉");
  const unanswered = session.list.filter((q) => session.answers[q.id] == null).length;
  const answeredWrong = session.wrong.length - unanswered;
  $("#result-stats").innerHTML = `
    <div class="border-2 border-ink bg-white p-3"><b class="block font-display text-xl text-ok">${session.correct}</b><small>riktig</small></div>
    <div class="border-2 border-ink bg-white p-3"><b class="block font-display text-xl text-bad">${answeredWrong}</b><small>feil</small></div>
    <div class="border-2 border-ink bg-white p-3"><b class="block font-display text-xl">${unanswered}</b><small>ubesvart</small></div>
    <div class="border-2 border-ink bg-white p-3"><b class="block font-display text-xl">${formatDuration(Math.round((Date.now() - session.startedAt) / 1000))}</b><small>tid</small></div>`;
  const byCat = {}; session.wrong.forEach((q) => { const k = catLabel(q); byCat[k] = (byCat[k] || 0) + 1; });
  const chips = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  $("#result-breakdown").innerHTML = chips.length
    ? `<span class="text-xs font-bold uppercase text-ink/50">Svakest:</span>` + chips.map(([k, n]) => `<span class="tag bg-bad/15 text-bad">${k} · ${n}</span>`).join("")
    : "";
  $("#result-review-wrong").hidden = session.wrong.length === 0;
  $("#result-next").hidden = session.isExam || !session.next;
  $("#exam-review-toggle-wrap").hidden = !session.isExam;
  if (session.isExam) {
    // Eksamen mater nå læringssløyfen: hvert svar oppdaterer repetisjon,
    // og feil (inkl. ubesvarte) havner i «Mine feil».
    session.list.forEach((q) => {
      const chosen = session.answers[q.id];
      recordAnswer(q.id, chosen != null && chosen === q.ans);
    });
    const weak = chips.map(([k]) => k);
    const date = new Date().toISOString();
    store.exams.unshift({
      id: `${date}-${Math.random().toString(36).slice(2, 7)}`, date, pct, passed, correct: session.correct, total,
      elapsed: Math.max(0, session.duration - session.remaining), weak,
      ids: session.list.map((q) => q.id), orders: session.list.map((q) => q.optionOrder), answers: { ...session.answers },
    });
    store.exams = store.exams.slice(0, 20);
    store.activeExam = null;
    renderExamReview();
  } else {
    if (session.progressKey) store.attempted[session.progressKey] = true;
    if (session.progressKey && pct === 100) store.completed[session.progressKey] = true;
    store.lastStudy = null;
  }
  save();
  renderAll();
}

function renderExamReview() {
  $("#exam-review-list").innerHTML = session.list.map((q, i) => {
    const chosen = session.answers[q.id], correct = chosen === q.ans;
    const detail = buildExplanation(q, chosen, correct);
    return `<article class="border-2 border-ink p-4 ${correct ? "bg-lime/20" : "bg-bad/10"}">
      <b class="font-display">${i + 1}. ${q.q}</b>
      <p class="mt-2 text-sm ${correct ? "text-ok" : "text-bad"}">${chosen == null ? "Ikke besvart" : `Ditt svar: ${q.opts[chosen]}`}</p>
      <p class="mt-1 text-sm"><b>Riktig:</b> ${q.opts[q.ans]}</p>
      ${detail.body ? `<p class="mt-2 text-sm leading-6 text-ink/70">${detail.body}</p>` : ""}
    </article>`;
  }).join("");
}

function questionChapter(q) {
  if (q.kapittel) return q.kapittel;
  const matches = MODULES.filter((m) => m.kategorier.includes(q.cat));
  if (q.cat === "Uniform & Regler") return /service|kunde|kvalitet|tilbakemelding/i.test(`${q.q} ${q.opts.join(" ")}`) ? 5 : 1;
  if (q.cat === "Personvern") return 15;
  return matches[0]?.num || null;
}

function showRelevantExcerpt() {
  const q = session?.list[session.i], chapterNumber = q && questionChapter(q);
  if (!q || !chapterNumber) return;
  const savedLink = store.sectionLinks[q.id];
  if (savedLink?.text) {
    $("#question-book-heading").textContent = savedLink.heading || `Kapittel ${savedLink.chapter + 1}`;
    $("#question-book-text").innerHTML = `<p>${savedLink.text}</p>`;
    $("#question-book-excerpt").hidden = false;
    $("#question-book-link").hidden = true;
    $("#question-book-excerpt").scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  const stop = new Set(["hvilken","hvilke","hvordan","hvorfor","dette","disse","riktig","påstand","betyr","innebærer","vekter","vekteren","skal","ikke","eller","etter","under","være","kan","hva","med","for","som","til","har","den","det"]);
  const chosen = session.answers[q.id];
  const explanation = buildExplanation(q, chosen, chosen === q.ans).body.replace(/<[^>]+>/g, " ");
  const tokens = `${q.q} ${q.forklaring || ""} ${explanation}`.toLowerCase().replace(/[^\p{L}\p{N}§]+/gu, " ").split(/\s+/).filter((x) => x.length > 3 && !stop.has(x));
  const rankedAll = BOOK_INDEX.map((x) => ({
    ...x,
    score: tokens.reduce((sum, token) => sum + (x.text.toLowerCase().includes(token) ? 1 : 0), 0) + (x.chapter === chapterNumber - 1 ? .25 : 0),
  })).filter((x) => x.type === "text" && x.score > 0 && !/^(?:neste kapittel|dette kapittelet er basert)/i.test(x.text))
    .sort((a, b) => b.score - a.score);
  const winningChapter = rankedAll[0]?.chapter ?? chapterNumber - 1;
  const rows = BOOK_INDEX.filter((x) => x.chapter === winningChapter);
  const ranked = rows.map((x, index) => ({ ...x, index, score: rankedAll.find((y) => y.chapter === x.chapter && y.text === x.text)?.score || 0 }))
    .filter((x) => x.type === "text" && x.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = ranked[0] || rows.map((x, index) => ({ ...x, index })).find((x) => x.type === "text");
  if (!best) return;
  const heading = rows.slice(0, best.index + 1).reverse().find((x) => x.type === "heading")?.text || book[winningChapter]?.tittel || `Kapittel ${chapterNumber}`;
  store.sectionLinks[q.id] = { chapter: winningChapter, heading, text: best.text };
  save();
  const excerpts = [best, ...ranked.filter((x) => x.index !== best.index && Math.abs(x.index - best.index) <= 3)].slice(0, 2);
  $("#question-book-heading").textContent = heading;
  $("#question-book-text").innerHTML = excerpts.map((x) => `<p>${x.text}</p>`).join("");
  $("#question-book-excerpt").hidden = false;
  $("#question-book-link").hidden = true;
  $("#question-book-excerpt").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
const catLabel = (q) => q.kapittel ? (book.find((b) => b.nummer === q.kapittel)?.tittel || `Kapittel ${q.kapittel}`) : (q.cat || "Annet");

/* ===================================================================
   7) FLASHCARDS — Tinder-swipe (drag), mater samme SRS
   =================================================================== */
function renderFlashcardDecks() {
  const byCh = {}; nyeFlashcards.forEach((c) => (byCh[c.kapittel] ||= []).push(c));
  const nums = Object.keys(byCh).map(Number).sort((a, b) => a - b);
  $("#flashcard-list").innerHTML = nums.map((num) => {
    const cards = byCh[num], pct = poolMastery(cards.map((c) => ({ id: c.id })));
    const wrongCount = cards.filter((card) => store.q[card.id]?.last === "wrong").length;
    return `<article class="card p-4 text-left">
      <span class="flex items-center gap-3">
        <span class="grid h-11 w-11 shrink-0 place-items-center border-2 border-ink bg-brand font-display text-lg font-700 text-white">${pad2(num)}</span>
        <span class="min-w-0">
          <span class="block font-display font-700 leading-tight">${chapterName(num)}</span>
          ${wrongCount ? `<button class="mt-1 block text-xs font-bold text-bad hover:underline" data-fc-wrong="${num}">Repeter feil · ${wrongCount}</button>` : ""}
        </span>
      </span>
      ${barHTML(pct)}
      <span class="mt-2 flex items-center justify-between gap-4 text-xs font-bold">
        <span class="text-ink/55">${cards.length} kort · ${pct}%</span>
        <button class="text-brand hover:underline" data-fc-deck="${num}">Start →</button>
      </span>
    </article>`;
  }).join("");
}
const chapterName = (num) => book.find((b) => b.nummer === num)?.tittel || `Kapittel ${num}`;

function openFlashcards(num, dueOnly = false, onComplete = null, suppliedList = null) {
  const list = suppliedList ? [...suppliedList] : shuffle(nyeFlashcards.filter((c) => (num == null || c.kapittel === Number(num)) && (!dueOnly || isDue(c.id))));
  if (!list.length) return;
  fc = { list, i: 0, flipped: false, onComplete };
  const title = num == null ? "Smart repetisjon · kort" : chapterName(Number(num));
  $("#flash-title").textContent = title;
  store.lastStudy = { type: "flash", title, ids: list.map((card) => card.id), index: 0, total: list.length };
  save();
  if (!$("#flash").open) $("#flash").showModal();
  renderFlashcard();
}
function renderFlashcard() {
  const card = fc.list[fc.i], el = $("#flashcard");
  fc.flipped = false; el.classList.remove("flipped");
  el.style.transition = ""; el.style.transform = ""; el.style.opacity = "1";
  $("#fc-front-text").textContent = card.forside;
  $("#fc-back-text").textContent = card.bakside;
  $(".fc-front").setAttribute("aria-hidden", "false");
  $(".fc-back").setAttribute("aria-hidden", "true");
  $$("[data-swipe]").forEach((b) => { b.disabled = true; });
  $("#flash-progress").textContent = `Kort ${fc.i + 1} av ${fc.list.length}`;
  $("#flash-bar").style.width = `${(fc.i / fc.list.length) * 100}%`;
  $("#badge-yes").style.opacity = "0"; $("#badge-no").style.opacity = "0";
}
const flipCard = () => {
  fc.flipped = !fc.flipped;
  $("#flashcard").classList.toggle("flipped", fc.flipped);
  $(".fc-front").setAttribute("aria-hidden", String(fc.flipped));
  $(".fc-back").setAttribute("aria-hidden", String(!fc.flipped));
  $$("[data-swipe]").forEach((b) => { b.disabled = !fc.flipped; });
};
function swipeCard(dir) {              // dir: "yes" | "no"
  if (!fc?.flipped) return toast("Snu kortet og vurder svaret først.");
  rateCard(fc.list[fc.i].id, dir === "yes" ? "good" : "again");
  const el = $("#flashcard");
  el.classList.add("animate");
  el.style.transform = `translateX(${dir === "yes" ? 140 : -140}%) rotate(${dir === "yes" ? 18 : -18}deg)`;
  el.style.opacity = "0";
  setTimeout(() => {
    el.classList.remove("animate");
    if (fc.i + 1 >= fc.list.length) {
      const next = fc.onComplete;
      $("#flash").close();
      fc = null;
      store.lastStudy = null;
      save();
      renderAll();
      if (next) next(); else toast("Bunke ferdig ⭐");
    }
    else {
      fc.i++;
      if (store.lastStudy?.type === "flash") { store.lastStudy.index = fc.i; save(); }
      renderFlashcard();
    }
  }, 260);
}

/* ---- drag/swipe med peker ---- */
(function enableSwipe() {
  const card = $("#flashcard"); let sx = 0, sy = 0, dx = 0, dragging = false, moved = false;
  const down = (e) => { if (!fc) return; dragging = true; moved = false; card.classList.add("dragging"); sx = e.clientX; sy = e.clientY; };
  const move = (e) => {
    if (!dragging) return; dx = e.clientX - sx; const dy = e.clientY - sy;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 22}deg)`;
    $("#badge-yes").style.opacity = String(clamp(dx / 90, 0, 1));
    $("#badge-no").style.opacity = String(clamp(-dx / 90, 0, 1));
  };
  const up = () => {
    if (!dragging) return; dragging = false; card.classList.remove("dragging");
    if (Math.abs(dx) > 90) swipeCard(dx > 0 ? "yes" : "no");
    else if (!moved) flipCard();                       // tap = snu
    else { card.style.transform = ""; $("#badge-yes").style.opacity = "0"; $("#badge-no").style.opacity = "0"; }
    dx = 0;
  };
  card.addEventListener("pointerdown", down);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
})();

/* ===================================================================
   8) NAV + UI
   =================================================================== */
function switchView(name) {
  $$(".view").forEach((v) => v.classList.toggle("hidden", v.id !== name));
  $$(".nav-link").forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle("bg-ink", on); b.classList.toggle("text-paper", on);
  });
  $("#reset-wrap").classList.toggle("hidden", name !== "dash");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
let toastTimer;
function toast(msg) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite"); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
let pendingConfirm = null;
function askConfirm({ title = "Er du sikker?", message, confirmText = "Fortsett", onConfirm }) {
  pendingConfirm = onConfirm;
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  $("#confirm-action").textContent = confirmText;
  $("#confirm-dialog").showModal();
}
function closeConfirm() {
  pendingConfirm = null;
  $("#confirm-dialog").close();
}
function runConfirm() {
  const action = pendingConfirm;
  pendingConfirm = null;
  $("#confirm-dialog").close();
  action?.();
}
function resetProgress() {
  askConfirm({
    title: "Nullstill fremgang?",
    message: "Mestring, dager på rad og leste kapitler slettes.",
    confirmText: "Nullstill",
    onConfirm: () => {
      localStorage.removeItem(KEY);
      store.q = {}; store.read = {}; store.streak = { count: 0, last: null }; store.exams = [];
      store.lastStudy = null; store.reading = {}; store.bookmarks = {}; store.completed = {}; store.attempted = {};
      store.activeExam = null; store.sectionLinks = {};
      renderAll(); toast("Fremgang nullstilt.");
    },
  });
}
function exportProgress() {
  const payload = {
    app: "VEKTER",
    version: 1,
    exportedAt: new Date().toISOString(),
    data: store,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `vekter-progresjon-${todayKey()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast("Progresjonen er eksportert.");
}
async function importProgress(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const data = parsed?.data || parsed;
    if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.q !== "object") throw new Error("invalid");
    askConfirm({
      title: "Importer progresjon?",
      message: "Nåværende progresjon på denne enheten blir erstattet.",
      confirmText: "Importer",
      onConfirm: () => {
        localStorage.setItem(KEY, JSON.stringify(data));
        window.location.reload();
      },
    });
  } catch {
    toast("Filen er ikke en gyldig VEKTER-eksport.");
  }
}
function renderAll() { renderDashboard(); renderPractice(); renderChapters(); renderFlashcardDecks(); renderBookmarks(); }

function closeQuizWithGuard() {
  const finished = !$("#quiz-result-panel").hidden;
  if (!finished && session) {
    askConfirm({
      title: session.isExam ? "Avslutt eksamen?" : "Avslutt økten?",
      message: session.isExam ? "Besvarelsen blir ikke lagret i historikken." : "Du kan fortsette fra oversikten senere.",
      confirmText: "Avslutt",
      onConfirm: () => finishCloseQuiz(false),
    });
    return;
  }
  finishCloseQuiz(finished);
}
function finishCloseQuiz(finished) {
  clearInterval(examTimer);
  $("#quiz").close();
  if (session?.isExam && !finished) { session = null; store.activeExam = null; save(); }
  renderDashboard();
}

function continueStudy() {
  if (store.activeExam) return resumeExam();
  const last = store.lastStudy; if (!last) return;
  if (last.type === "reading") {
    switchView("les"); return openChapter(last.chapter);
  }
  if (last.type === "flash") {
    const byId = new Map(nyeFlashcards.map((card) => [String(card.id), card]));
    const list = (last.ids || []).map((id) => byId.get(String(id))).filter(Boolean);
    if (!list.length) { store.lastStudy = null; save(); return renderDashboard(); }
    const snapshot = JSON.parse(JSON.stringify(last));
    openFlashcards(null, false, null, list);
    fc.i = clamp(snapshot.index || 0, 0, list.length - 1);
    $("#flash-title").textContent = snapshot.title || "Flashcards";
    store.lastStudy = snapshot;
    save();
    renderFlashcard();
    return;
  }
  if (last.type === "quiz") {
    const byId = new Map(QUESTIONS.map((q) => [String(q.id), q]));
    const fullList = (last.ids || []).map((id) => byId.get(String(id))).filter(Boolean);
    if (!fullList.length || (last.index || 0) >= fullList.length) { store.lastStudy = null; save(); return renderDashboard(); }
    const snapshot = JSON.parse(JSON.stringify(last));
    startSession({ mode: last.mode || "Økt", title: last.title || "Fortsett økten", list: fullList, progressKey: last.progressKey, compact: String(last.progressKey || "").startsWith("chapter:") });
    session.i = clamp(snapshot.index || 0, 0, fullList.length - 1);
    session.answers = snapshot.answers || {};
    session.correct = snapshot.correct || 0;
    session.wrong = (snapshot.wrongIds || []).map((id) => byId.get(String(id))).filter(Boolean);
    store.lastStudy = snapshot;
    save();
    showQuestion();
  }
}

function dismissContinue() {
  if (store.activeExam) {
    askConfirm({
      title: "Fjern lagret eksamen?",
      message: "Besvarelsen kan ikke gjenopprettes.",
      confirmText: "Fjern",
      onConfirm: performDismissContinue,
    });
    return;
  }
  performDismissContinue();
}
function performDismissContinue() {
  store.activeExam = null;
  store.lastStudy = null;
  save();
  renderDashboard();
  toast("«Fortsett» er fjernet.");
}

/* ===================================================================
   9) HENDELSER
   =================================================================== */
document.addEventListener("click", (e) => {
  const t = e.target;
  const view = t.closest("[data-view]");        if (view) return switchView(view.dataset.view);
  const mod  = t.closest("[data-module]");        if (mod)  return startModule(mod.dataset.module);
  const modWrong = t.closest("[data-module-wrong]"); if (modWrong) {
    const m = MODULES.find((x) => x.id === modWrong.dataset.moduleWrong);
    return m && startPoolWrong(questionsForModule(m), `${m.name} · feil`);
  }
  const chQ  = t.closest("[data-chapter-quiz]");  if (chQ)  { if ($("#reader").open) $("#reader").close(); return startChapterQuiz(chQ.dataset.chapterQuiz); }
  const chWrong = t.closest("[data-chapter-wrong]"); if (chWrong) {
    return startChapterWrong(chWrong.dataset.chapterWrong);
  }
  const deck = t.closest("[data-fc-deck]");       if (deck) return openFlashcards(deck.dataset.fcDeck);
  const fcWrong = t.closest("[data-fc-wrong]"); if (fcWrong) {
    const num = Number(fcWrong.dataset.fcWrong);
    const wrong = nyeFlashcards.filter((card) => card.kapittel === num && store.q[card.id]?.last === "wrong");
    if (!wrong.length) return toast("Ingen feil i denne kortbunken ennå.");
    return openFlashcards(num, false, null, wrong);
  }
  const chap = t.closest("[data-chapter]");       if (chap) return openChapter(Number(chap.dataset.chapter));
  const toc  = t.closest("[data-toc]");            if (toc)  {
    e.preventDefault();
    $("#" + toc.dataset.toc)?.scrollIntoView({ behavior: "smooth", block: "start" });
    $("#reader-sidebar").classList.remove("open");
    $("#reader-toc-toggle").setAttribute("aria-expanded", "false");
    return;
  }
  const examHistory = t.closest("[data-exam-history]"); if (examHistory) return openExamHistory(examHistory.dataset.examHistory);
  const examJump = t.closest("[data-exam-jump]"); if (examJump && !examJump.disabled) {
    session.i = Number(examJump.dataset.examJump); closeExamOverview(); showQuestion(); return;
  }

  if (t.closest("[data-start-exam]"))    return openExamSetup();
  if (t.closest("[data-open-review-choice]")) return $("#review-choice").showModal();
  const reviewType = t.closest("[data-start-review-type]"); if (reviewType) {
    $("#review-choice").close();
    return startReview(reviewType.dataset.startReviewType);
  }
  if (t.closest("[data-close-review-choice]")) return $("#review-choice").close();
  if (t.closest("[data-start-mixed]")) return startMixedQuiz();
  if (t.closest("[data-start-wrong]"))   return startWrong();
  if (t.closest("[data-start-starred]")) return startStarred();
  if (t.closest("[data-close-reader]"))  return $("#reader").close();
  if (t.closest("[data-toggle-reader-toc]")) {
    const sidebar = $("#reader-sidebar");
    const open = sidebar.classList.toggle("open");
    $("#reader-toc-toggle").setAttribute("aria-expanded", String(open));
    return;
  }
  if (t.closest("[data-close-quiz]"))    return closeQuizWithGuard();
  if (t.closest("[data-close-flash]"))   return $("#flash").close();
  if (t.closest("[data-close-exam-setup]")) return $("#exam-setup").close();
  if (t.closest("[data-close-history-detail]")) return $("#exam-history-detail").close();
  if (t.closest("[data-confirm-cancel]")) return closeConfirm();
  if (t.closest("[data-confirm-action]")) return runConfirm();
  if (t.closest("[data-confirm-exam]"))  return startExam();
  if (t.closest("[data-exam-prev]")) return previousExamQuestion();
  if (t.closest("[data-exam-next]")) return nextQuestion();
  if (t.closest("[data-exam-flag]")) return toggleExamFlag();
  if (t.closest("[data-exam-overview]")) return renderExamOverview();
  if (t.closest("[data-close-exam-overview]")) return closeExamOverview();
  if (t.closest("[data-reader-prev]"))   return stepChapter(-1);
  if (t.closest("[data-reader-next]"))   return stepChapter(1);
  if (t.closest("[data-reset]"))         return resetProgress();
  if (t.closest("[data-export-progress]")) return exportProgress();
  if (t.closest("[data-import-progress]")) return $("#progress-import-file").click();
  if (t.closest("[data-flip]"))          return flipCard();
  if (t.closest("[data-continue-study]")) return continueStudy();
  if (t.closest("[data-dismiss-continue]")) return dismissContinue();
  if (t.closest("[data-run-search]"))     return runSearch();
  if (t.closest("[data-bookmark-chapter]")) return toggleChapterBookmark();
  const rlist = t.closest("[data-reader-list]"); if (rlist) return setReaderList(rlist.dataset.readerList);
  const secmark = t.closest("[data-bookmark-section]"); if (secmark) return toggleSectionBookmark(secmark.dataset.bookmarkSection);
  const savedmark = t.closest("[data-open-bookmark]"); if (savedmark) {
    const x = store.bookmarks[savedmark.dataset.openBookmark]; if (!x) return;
    openChapter(book.findIndex((ch) => ch.nummer === x.chapter));
    if (x.section) requestAnimationFrame(() => $("#" + x.section)?.scrollIntoView({ block: "start" }));
    return;
  }
  const searchChapter = t.closest("[data-search-chapter]"); if (searchChapter) {
    const index = Number(searchChapter.dataset.searchChapter);
    const text = decodeURIComponent(searchChapter.dataset.searchText || "");
    return text ? openChapterAtText(index, text) : openChapter(index);
  }
  const searchQuestion = t.closest("[data-search-question]"); if (searchQuestion) {
    const q = QUESTIONS.find((x) => String(x.id) === searchQuestion.dataset.searchQuestion);
    if (q) startSession({ mode: "Søketreff", title: "Ett spørsmål", list: [q] });
    return;
  }
  if (t.closest("[data-open-question-book]")) {
    return showRelevantExcerpt();
  }
  if (t.closest("[data-close-question-book]")) {
    $("#question-book-excerpt").hidden = true;
    $("#question-book-link").hidden = false;
    return;
  }
  const sw = t.closest("[data-swipe]");  if (sw) return swipeCard(sw.dataset.swipe);

  if (t.closest("[data-star]")) { const s = qstat(session.list[session.i].id); s.starred = !s.starred; save(); updateStar(); renderDashboard(); return; }
  if (t.closest("[data-toggle-read]")) { const n = book[readerIndex].nummer; store.read[n] = !store.read[n]; save(); updateReadButton(); renderChapters(); renderDashboard(); return; }
  const ans = t.closest("[data-answer]"); if (ans) return answerQuestion(Number(ans.dataset.answer));
});

$("#next-question").addEventListener("click", nextQuestion);
$("#result-retry").addEventListener("click", () => {
  if (session?.isExam) { $("#quiz").close(); return openExamSetup(); }
  session?.restart?.();
});
$("#result-next").addEventListener("click", () => session?.next?.());
$("#result-review-wrong").addEventListener("click", () => {
  const list = shuffle(session.wrong);
  startSession({ mode: "Repeter feil", title: "Feilene fra økten", list, restart: () => startSession({ mode: "Repeter feil", title: "Feilene fra økten", list }) });
});
$("#flash").addEventListener("close", () => { fc = null; });
$("#reader").addEventListener("close", () => {
  $("#reader-sidebar").classList.remove("open");
  $("#reader-toc-toggle").setAttribute("aria-expanded", "false");
});
$("#reader").addEventListener("scroll", () => {
  syncReaderToc();
  updateReaderProgress();
  clearTimeout(readerSaveTimer);
  readerSaveTimer = setTimeout(() => {
    const ch = book[readerIndex]; if (!ch) return;
    store.reading[ch.nummer] = $("#reader").scrollTop;
    store.lastStudy = { type: "reading", chapter: readerIndex };
    save();
  }, 180);
}, { passive: true });
$("#exam-review-toggle").addEventListener("change", (e) => { $("#exam-review-list").hidden = !e.target.checked; });
$("#progress-import-file").addEventListener("change", (e) => {
  importProgress(e.target.files?.[0]);
  e.target.value = "";
});
$$('input[name="exam-mode"]').forEach((input) => input.addEventListener("change", () => {
  const feedback = document.querySelector('input[name="exam-mode"]:checked')?.value === "feedback";
  $("#exam-mode-note").textContent = feedback
    ? "Fasit, forklaring og relevant pensum vises etter hvert svar."
    : "Fasit og resultat vises først etter levering.";
}));
$("#global-search").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
$("#quiz").addEventListener("cancel", (e) => { e.preventDefault(); closeQuizWithGuard(); });
$("#confirm-dialog").addEventListener("cancel", (e) => { e.preventDefault(); closeConfirm(); });

document.addEventListener("keydown", (e) => {
  if ($("#flash").open) {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); flipCard(); }
    else if (e.key === "ArrowRight") swipeCard("yes");
    else if (e.key === "ArrowLeft") swipeCard("no");
    return;
  }
  if ($("#quiz").open && !$("#quiz-question-panel").hidden) {
    if (["1", "2", "3", "4", "5"].includes(e.key)) { const b = $$(".answer")[+e.key - 1]; if (b && !b.disabled) b.click(); }
    else if (e.key === "Enter") {
      const next = session?.isExam ? $("[data-exam-next]") : $("#next-question");
      if (next && !next.hidden && !next.disabled) next.click();
    }
    else if (e.key.toLowerCase() === "s") $("[data-star]").click();
  }
});

/* ===================================================================
   10) INIT
   =================================================================== */
renderAll();
setReaderList("chapters");
switchView("dash");

// Service worker: ekte offline (kun over http/https — hoppes over på file://).
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

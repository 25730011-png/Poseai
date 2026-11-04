// ===== PoseAi app.js =====
// 화면 하나(index.html)에서 쓰는 JavaScript를 전부 이 파일에 모음
// 순서: 1 공통(기준표·점수·기록 저장) → 2 측정 → 3 리포트 → 4 기록·그래프 → 5 교정 가이드 → 6 화면 전환
// 데이터는 data/ 폴더의 JSON (criteria.json, guide.json, faq.json)

import {
  PoseLandmarker,
  FilesetResolver,
  DrawingUtils
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';


/* =====================================================================
   1. 공통: 판단 기준표(data/criteria.json), 점수 계산, LocalStorage 기록
   ===================================================================== */
// ===== 공통: 판단 기준표, 점수 계산, 기록 저장 =====
// 모든 화면에서 같이 씀

// ----- 판단 기준표 -----
// 기준값은 코드가 아니라 data/criteria.json에 따로 적어 둠
// (사용자 테스트 후 기준 조정할 때 JSON만 고치면 됨)
//   good: 이 각도 미만이면 양호
//   warn: 이 각도 미만이면 주의, 이상이면 확인 권장
//   penalty: 점수 계산할 때 1도당 깎는 점수
let CRITERIA = null;

const criteriaReady = fetch('data/criteria.json')
  .then(res => res.json())
  .then(data => { CRITERIA = data; })
  .catch(err => {
    console.error('criteria.json을 불러오지 못했어요. Live Server나 배포 주소로 열었는지 확인하세요.', err);
  });

// 단계 판단: 양호 / 주의 / 확인 권장
function getLevel(key, angle) {
  const c = CRITERIA[key];
  const a = Math.abs(angle);
  if (a < c.good) return { text: '양호', cls: 'good' };
  if (a < c.warn) return { text: '주의', cls: 'warn' };
  return { text: '확인 권장', cls: 'check' };
}

// 항목 점수 = 100 - 측정값 × 감점 계수 (0~100)
function getItemScore(key, angle) {
  const score = 100 - Math.abs(angle) * CRITERIA[key].penalty;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// 종합 점수 = 3개 항목 평균
function getTotalScore(result) {
  const keys = Object.keys(CRITERIA);
  const sum = keys.reduce((acc, k) => acc + getItemScore(k, result[k]), 0);
  return Math.round(sum / keys.length);
}

// ===== LocalStorage =====
// 기록 형식: { date: '2026-11-03', neck: 18.4, shoulder: -2.7, pelvis: 1.9, score: 82 }
// shoulder, pelvis는 + 면 오른쪽 낮음, - 면 왼쪽 낮음
const RECORD_KEY = 'poseai_records';
const LATEST_KEY = 'poseai_latest';

// 측정 직후 결과 (측정 → 리포트로 넘길 때)
function saveLatest(result) {
  localStorage.setItem(LATEST_KEY, JSON.stringify(result));
}
function getLatest() {
  return JSON.parse(localStorage.getItem(LATEST_KEY) || 'null');
}

// 날짜별 기록
function getRecords() {
  return JSON.parse(localStorage.getItem(RECORD_KEY) || '[]');
}
function saveRecord(record) {
  const records = getRecords();
  records.push(record);
  localStorage.setItem(RECORD_KEY, JSON.stringify(records));
}


/* =====================================================================
   2. 촬영·측정 (#measure)
   ===================================================================== */
// ===== ② 촬영·측정 (#measure) =====
// 1. 웹캠 켜고 MediaPipe 좌표를 점·선으로 표시, 실시간 각도 표시
// 2. [정면 측정 시작] → 3초 카운트다운 → 5초 동안 어깨·골반 각도 평균
// 3. [측면 측정 시작] → 3초 카운트다운 → 5초 동안 거북목 각도 평균
// 4. 종합 점수 계산 → saveLatest() → #report 로 이동


const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// 랜드마크 번호 (Google AI Edge 문서 기준)
const P = {
  L_EAR: 7, R_EAR: 8,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_HIP: 23, R_HIP: 24
};
const MIN_VIS = 0.5;      // 이보다 낮으면 신뢰도 낮은 좌표로 보고 제외
const MIN_FRAMES = 30;    // 5초 동안 유효한 프레임이 이보다 적으면 다시 측정

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const guideEl = document.getElementById('guide-text');
const countdownEl = document.getElementById('countdown');
const startBtn = document.getElementById('start-btn');
const stepFront = document.getElementById('step-front');
const stepSide = document.getElementById('step-side');

let landmarker = null;
let drawer = null;
let stream = null;
let running = false;
let lastTime = -1;
let current = null;      // 지금 프레임 각도
let samples = null;      // 5초 측정 중일 때 모으는 값
let phase = 'front';     // 'front' → 'side'
let frontResult = null;  // 정면 측정 결과 { shoulder, pelvis }

// ---------- 각도 계산 ----------
// 좌표는 0~1 비율이라 화면 가로세로 비율을 곱해서 계산

// 좌우 두 점의 기울기 (+ 면 오른쪽 낮음, - 면 왼쪽 낮음)
function tiltAngle(left, right) {
  const w = video.videoWidth, h = video.videoHeight;
  const dx = (left.x - right.x) * w;
  const dy = (right.y - left.y) * h;
  return Math.atan2(dy, dx) * 180 / Math.PI;
}

// 어깨→귀 선이 수직선과 이루는 각도 (측면용)
function neckAngle(ear, shoulder) {
  const w = video.videoWidth, h = video.videoHeight;
  const dx = Math.abs(ear.x - shoulder.x) * w;
  const dy = Math.abs(ear.y - shoulder.y) * h;
  return Math.atan2(dx, dy) * 180 / Math.PI;
}

function visible(...points) {
  return points.every(p => p && p.visibility > MIN_VIS);
}

function calcAngles(lm) {
  const result = { shoulder: null, pelvis: null, neck: null };

  if (visible(lm[P.L_SHOULDER], lm[P.R_SHOULDER])) {
    result.shoulder = tiltAngle(lm[P.L_SHOULDER], lm[P.R_SHOULDER]);
  }
  if (visible(lm[P.L_HIP], lm[P.R_HIP])) {
    result.pelvis = tiltAngle(lm[P.L_HIP], lm[P.R_HIP]);
  }

  // 측면: 왼쪽·오른쪽 중 더 잘 보이는 쪽 사용
  const leftVis = Math.min(lm[P.L_EAR].visibility, lm[P.L_SHOULDER].visibility);
  const rightVis = Math.min(lm[P.R_EAR].visibility, lm[P.R_SHOULDER].visibility);
  const [ear, sh] = leftVis >= rightVis
    ? [lm[P.L_EAR], lm[P.L_SHOULDER]]
    : [lm[P.R_EAR], lm[P.R_SHOULDER]];
  if (visible(ear, sh)) {
    result.neck = neckAngle(ear, sh);
  }

  return result;
}

const fmt = v => (v === null || v === undefined ? '--°' : v.toFixed(1) + '°');

// ---------- 화면 상태 ----------
function setPhase(next) {
  phase = next;
  stepFront.classList.toggle('active', phase === 'front');
  stepSide.classList.toggle('active', phase === 'side');
  if (phase === 'front') {
    startBtn.textContent = '정면 측정 시작';
    guideEl.textContent = '정면을 바라보고 평소처럼 서 주세요. 머리부터 골반까지 보이게요.';
  } else {
    startBtn.textContent = '측면 측정 시작';
    guideEl.textContent = '옆으로 돌아서 평소처럼 서 주세요. 귀와 어깨가 잘 보이게요.';
  }
}

function resetMeasure() {
  frontResult = null;
  samples = null;
  countdownEl.textContent = '';
  startBtn.disabled = false;
  setPhase('front');
}

// ---------- 모델·웹캠 ----------
async function loadModel() {
  if (landmarker) return;
  statusEl.textContent = 'AI 모델 불러오는 중...';
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = delegate => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1
  });
  try {
    landmarker = await PoseLandmarker.createFromOptions(vision, options('GPU'));
  } catch (err) {
    // 일부 패드·폰은 GPU 모드가 안 돼서 CPU로 다시 시도
    console.warn('GPU 실패, CPU로 전환', err);
    landmarker = await PoseLandmarker.createFromOptions(vision, options('CPU'));
  }
  drawer = new DrawingUtils(ctx);
}

async function startCamera() {
  if (running) return;
  try {
    await loadModel();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, // 패드·폰은 전면 카메라
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    running = true;
    statusEl.textContent = '몸 전체가 보이게 서 주세요';
    loop();
  } catch (err) {
    console.error(err);
    statusEl.textContent = err.name === 'NotAllowedError'
      ? '카메라 권한을 허용해 주세요 (주소창 왼쪽 아이콘)'
      : '카메라를 켤 수 없어요 (localhost 또는 https에서 열었는지 확인)';
  }
}

function stopCamera() {
  running = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ---------- 매 프레임 ----------
function loop() {
  if (!running) return;

  if (video.currentTime !== lastTime) {
    lastTime = video.currentTime;
    const res = landmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const lm = res.landmarks[0];
    if (lm) {
      drawer.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: '#FFFFFF', lineWidth: 3 });
      drawer.drawLandmarks(lm, { color: '#FFFFFF', fillColor: '#555555', radius: 4 });

      current = calcAngles(lm);
      if (samples) samples.push(current);

      // 오른쪽 '실시간 값' 칸
      document.getElementById('live-shoulder').textContent = fmt(current.shoulder);
      document.getElementById('live-pelvis').textContent = fmt(current.pelvis);
      document.getElementById('live-neck').textContent = fmt(current.neck);

      if (!samples) statusEl.textContent = '잘 인식되고 있어요';
    } else {
      current = null;
      if (!samples) statusEl.textContent = '사람이 보이지 않아요. 카메라에서 조금 떨어져 주세요';
    }
  }

  requestAnimationFrame(loop);
}

// ---------- 5초 평균 측정 ----------
const wait = ms => new Promise(r => setTimeout(r, ms));

// 값이 있는 프레임만 평균, 너무 적으면 null
function average(list, key) {
  const vals = list.map(s => s[key]).filter(v => v !== null);
  if (vals.length < MIN_FRAMES) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

async function collect5s() {
  startBtn.disabled = true;
  for (let i = 3; i > 0; i--) {
    countdownEl.textContent = i;
    await wait(1000);
  }
  countdownEl.textContent = '';
  statusEl.textContent = '측정 중... 5초 동안 움직이지 마세요';
  samples = [];
  await wait(5000);
  const list = samples;
  samples = null;
  startBtn.disabled = false;
  return list;
}

const round1 = v => Math.round(v * 10) / 10;

async function onStart() {
  if (!running || samples) return;

  if (phase === 'front') {
    const list = await collect5s();
    const shoulder = average(list, 'shoulder');
    const pelvis = average(list, 'pelvis');
    if (shoulder === null || pelvis === null) {
      statusEl.textContent = '어깨나 골반이 잘 안 보였어요. 한 걸음 뒤로 가서 다시 해 주세요';
      return;
    }
    frontResult = { shoulder: round1(shoulder), pelvis: round1(pelvis) };
    statusEl.textContent = `정면 완료 · 어깨 ${fmt(shoulder)} · 골반 ${fmt(pelvis)}`;
    setPhase('side');
    return;
  }

  // 측면
  const list = await collect5s();
  const neck = average(list, 'neck');
  if (neck === null) {
    statusEl.textContent = '귀와 어깨가 잘 안 보였어요. 옆으로 서서 다시 해 주세요';
    return;
  }

  const result = {
    date: new Date().toISOString().slice(0, 10),
    neck: round1(neck),
    shoulder: frontResult.shoulder,
    pelvis: frontResult.pelvis
  };
  result.score = getTotalScore(result);   // common.js
  saveLatest(result);                      // common.js
  statusEl.textContent = '측정 완료! 리포트로 이동해요';
  location.hash = '#report';
}

startBtn.addEventListener('click', onStart);

// ---------- 화면 전환 ----------
// #measure 들어오면 켜고 처음부터, 다른 화면 가면 끄기
document.addEventListener('pagechange', e => {
  if (e.detail === 'measure') {
    resetMeasure();
    startCamera();
  } else {
    stopCamera();
  }
});


/* =====================================================================
   3. 체형 리포트 (#report)
   ===================================================================== */
// ===== ③ 체형 리포트 (#report) =====
// getLatest()로 방금 측정한 결과를 불러와서
// 종합 점수, 지난번과 비교, 항목별 각도·단계를 보여주고 [기록 저장]으로 saveRecord()

(function () {
  const KEYS = ['neck', 'shoulder', 'pelvis'];   // 이름·설명은 data/criteria.json

  const $ = id => document.getElementById(id);
  const saveBtn = $('save-btn');

  // 어깨·골반 기울어진 방향 (+ 오른쪽 낮음, - 왼쪽 낮음)
  function direction(key, v) {
    if (key === 'neck') return '';
    if (Math.abs(v) < 0.5) return '거의 수평';
    return v > 0 ? '오른쪽 낮음' : '왼쪽 낮음';
  }

  function cardHTML(key, value) {
    const c = CRITERIA[key];
    const level = getLevel(key, value);
    const dir = direction(key, value);
    const rest = Math.max(2, c.warn - c.good);
    return `
      <article class="card result-card">
        <div class="row-between"><h2 class="card-title">${c.name}</h2><i class="badge ${level.cls}">${level.text}</i></div>
        <strong class="result-value">${Math.abs(value).toFixed(1)}°${dir ? ` <small>${dir}</small>` : ''}</strong>
        <div class="level-bar"><span style="flex:${c.good}" class="g"></span><span style="flex:${c.warn - c.good}" class="w"></span><span style="flex:${rest}" class="c"></span></div>
        <div class="row-between muted-sm"><span>0°</span><span>${c.good}°</span><span>${c.warn}°</span></div>
        <p class="muted-sm">${c.view} · ${c.desc}</p>
      </article>`;
  }

  function render() {
    const latest = getLatest();

    if (!latest) {
      $('report-date').textContent = '아직 측정 결과가 없어요';
      $('total-score').textContent = '--점';
      $('score-diff').innerHTML = '<a href="#measure">측정하러 가기 →</a>';
      $('level-count').innerHTML = '';
      saveBtn.disabled = true;
      saveBtn.textContent = '기록 저장';
      return;
    }

    $('report-date').textContent = `${latest.date} · 정면·측면 각 5초 평균`;
    $('total-score').textContent = `${latest.score}점`;

    // 지난번(저장된 기록 중 가장 최근)과 비교
    const same = r => r.date === latest.date && r.score === latest.score && r.neck === latest.neck;
    const prev = getRecords()
      .sort((a, b) => a.date < b.date ? 1 : -1)
      .find(r => !same(r) && r.date <= latest.date);
    if (prev) {
      const diff = latest.score - prev.score;
      $('score-diff').textContent = diff === 0 ? '지난번과 같아요'
        : `지난번보다 ${diff > 0 ? '+' : ''}${diff}점`;
    } else {
      $('score-diff').textContent = '첫 측정이에요';
    }

    // 단계별 개수
    const count = { good: 0, warn: 0, check: 0 };
    KEYS.forEach(k => count[getLevel(k, latest[k]).cls]++);
    $('level-count').innerHTML =
      `<i class="badge good">양호 ${count.good}</i><i class="badge warn">주의 ${count.warn}</i><i class="badge check">확인 권장 ${count.check}</i>`;

    $('result-list').innerHTML = KEYS.map(k => cardHTML(k, latest[k])).join('');

    saveBtn.disabled = !!latest.saved;
    saveBtn.textContent = latest.saved ? '저장 완료' : '기록 저장';
  }

  saveBtn.addEventListener('click', () => {
    const latest = getLatest();
    if (!latest || latest.saved) return;
    const { saved, ...record } = latest;
    saveRecord(record);
    saveLatest({ ...latest, saved: true });
    saveBtn.disabled = true;
    saveBtn.textContent = '저장 완료';
  });

  document.addEventListener('pagechange', e => {
    if (e.detail === 'report') render();
  });
})();


/* =====================================================================
   4. 기록·그래프 (#history)
   ===================================================================== */
// ===== ④ 기록·그래프 (#history) =====
// getRecords()로 저장된 기록을 불러와서
// - 탭(거북목·어깨·골반)에 따라 Chart.js 선 그래프
// - 날짜순 / 점수순 정렬 목록
// - 목록 클릭하면 그날 리포트 상세보기

(function () {
  let key = 'neck';
  let chart = null;

  const listEl = document.getElementById('record-list');
  const sortEl = document.getElementById('sort-select');
  const titleEl = document.getElementById('chart-title');

  function drawChart(records) {
    if (typeof Chart === 'undefined') return;   // Chart.js 못 불러왔을 때
    const byDate = [...records].sort((a, b) => a.date < b.date ? -1 : 1);
    const labels = byDate.map(r => r.date.slice(5).replace('-', '/'));
    const values = byDate.map(r => Math.abs(r[key]));
    const good = CRITERIA[key].good;

    if (chart) chart.destroy();
    document.querySelector('.chart-wrap').classList.add('has-chart');
    chart = new Chart(document.getElementById('chart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: `${CRITERIA[key].name} 각도`, data: values, borderColor: '#333333', backgroundColor: '#333333', tension: 0.3, pointRadius: 5 },
          { label: `양호 기준 ${good}°`, data: labels.map(() => good), borderColor: '#9E9E9E', borderDash: [6, 6], pointRadius: 0 }
        ]
      },
      options: {
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true, title: { display: true, text: '각도(°)' } } },
        plugins: { legend: { position: 'bottom' } }
      }
    });
  }

  function render() {
    const records = getRecords();
    titleEl.textContent = `${CRITERIA[key].name} 각도 변화`;

    if (records.length === 0) {
      if (chart) { chart.destroy(); chart = null; }
      document.querySelector('.chart-wrap').classList.remove('has-chart');
      listEl.innerHTML = '<li class="empty">아직 기록이 없어요</li>';
      return;
    }

    drawChart(records);

    const sorted = [...records].sort((a, b) =>
      sortEl.value === 'score' ? b.score - a.score : (a.date < b.date ? 1 : -1));

    listEl.innerHTML = '';
    sorted.forEach(r => {
      const li = document.createElement('li');
      li.style.cursor = 'pointer';
      li.innerHTML = `
        <b style="min-width:110px">${r.date}</b>
        <span class="muted" style="flex:1">거북목 ${Math.abs(r.neck).toFixed(1)}° · 어깨 ${Math.abs(r.shoulder).toFixed(1)}° · 골반 ${Math.abs(r.pelvis).toFixed(1)}°</span>
        <b style="font-size:20px">${r.score}점</b><span aria-hidden="true">›</span>`;
      // 상세보기: 그 기록을 리포트로 보여주기
      li.addEventListener('click', () => {
        saveLatest({ ...r, saved: true });
        location.hash = '#report';
      });
      listEl.appendChild(li);
    });
  }

  document.querySelectorAll('#history .tab, [data-page="history"] .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-page="history"] .tab').forEach(t => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', t === tab);
      });
      key = tab.dataset.key;
      render();
    });
  });
  sortEl.addEventListener('change', render);

  document.addEventListener('pagechange', e => {
    if (e.detail === 'history') render();
  });
})();


/* =====================================================================
   5. 교정 가이드 (#guide): FAQ 챗봇
   ===================================================================== */
// ===== ⑤ 교정 가이드 (#guide) =====
// 지금 된 것: FAQ 챗봇 (data/faq.json → 질문 버튼 → 답변 말풍선)
// 할 일
// 1. data/guide.json 불러와서 '주의' 이상 항목 스트레칭 카드 표시
// 2. AI 자세 코치 (Gemini, 중계 서버 거쳐서 호출) - 선택
// 3. 오픈API(건강보험심사평가원 병원정보서비스)로 지역별 병원 조회

(function () {
  const chatBox = document.getElementById('chat-box');
  const faqButtons = document.getElementById('faq-buttons');
  const aiForm = document.getElementById('ai-form');

  function addBubble(text, who) {
    const p = document.createElement('p');
    p.className = 'bubble ' + who;
    p.textContent = text;
    chatBox.appendChild(p);
  }

  fetch('data/faq.json')
    .then(res => res.json())
    .then(list => {
      list.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item.q;
        btn.addEventListener('click', () => {
          addBubble(item.q, 'user');
          addBubble(item.a, 'bot');
        });
        faqButtons.appendChild(btn);
      });
    })
    .catch(() => {
      faqButtons.textContent = 'FAQ를 불러오지 못했어요. (Live Server나 배포 주소로 열었는지 확인)';
    });

  // AI 자세 코치는 아직 연결 전
  aiForm.addEventListener('submit', e => {
    e.preventDefault();
    const input = document.getElementById('ai-q');
    if (!input.value.trim()) return;
    addBubble(input.value, 'user');
    addBubble('AI 자세 코치는 준비 중이에요. 지금은 위의 질문 버튼을 눌러 보세요.', 'bot');
    input.value = '';
  });
})();


/* =====================================================================
   6. 화면 전환: 주소 끝 #이름에 맞는 화면만 보여주기
   ===================================================================== */
// ===== 화면 전환 =====
// 주소 끝의 #이름(#measure, #report ...)에 맞는 section만 보여줌
// 화면이 바뀌면 'pagechange' 이벤트를 보내서 각 화면 JS가 필요할 때 실행되게 함
//   예) document.addEventListener('pagechange', e => { if (e.detail === 'report') { ... } });

const PAGES = ['home', 'measure', 'report', 'history', 'guide', 'login', 'signup'];

function showPage() {
  const id = location.hash.replace('#', '');
  const page = PAGES.includes(id) ? id : 'home';

  document.querySelectorAll('.page').forEach(sec => {
    sec.classList.toggle('active', sec.dataset.page === page);
  });
  document.querySelectorAll('.nav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === '#' + page);
  });

  // 화면 바뀌면 맨 위로 (section은 id 대신 data-page를 써서 브라우저가 중간으로 점프하지 않게 함)
  setTimeout(() => window.scrollTo(0, 0), 0);
  document.dispatchEvent(new CustomEvent('pagechange', { detail: page }));
}

window.addEventListener('hashchange', showPage);
// 판단 기준표(criteria.json)를 불러온 다음 첫 화면 보여주기
window.addEventListener('DOMContentLoaded', () => criteriaReady.finally(showPage));

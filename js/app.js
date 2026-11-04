// ===== PoseAi app.js =====
// 화면 하나(index.html)에서 쓰는 JavaScript를 전부 이 파일에 모음
// 순서: 1 공통(기준표·점수·기록 저장) → 2 측정 → 3 리포트 → 4 기록·그래프 → 5 교정 가이드 → 6 화면 전환
// 데이터는 data/ 폴더의 JSON (criteria.json, guide.json, faq.json)

// MediaPipe는 측정 화면에 들어갈 때만 불러옴 (못 불러와도 다른 화면은 정상 작동)
const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
let PoseLandmarker = null, FilesetResolver = null, DrawingUtils = null;


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
  ({ PoseLandmarker, FilesetResolver, DrawingUtils } = await import(VISION_URL));
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
      : 'AI 모델이나 카메라를 불러오지 못했어요. 인터넷 연결과 주소(https)를 확인해 주세요';
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
      drawer.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: '#38BDF8', lineWidth: 3 });
      drawer.drawLandmarks(lm, { color: '#FFFFFF', fillColor: '#1D5FD1', radius: 4 });

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
          { label: `${CRITERIA[key].name} 각도`, data: values, borderColor: '#1D5FD1', backgroundColor: '#1D5FD1', tension: 0.3, pointRadius: 5 },
          { label: `양호 기준 ${good}°`, data: labels.map(() => good), borderColor: '#0E7C86', borderDash: [6, 6], pointRadius: 0 }
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
// 된 것: 맞춤 스트레칭(data/guide.json), FAQ 챗봇(data/faq.json)
// 할 일
// 1. (이미지) guide.json의 image에 asset/ 그림 경로 넣기
// 2. (완료) AI 자세 코치 Gemini 연결 - 키는 브라우저에만 저장, 중계 서버는 선택
// 3. 오픈API(건강보험심사평가원 병원정보서비스)로 지역별 병원 조회

// ----- 맞춤 스트레칭 (data/guide.json) -----
// 최근 측정에서 '주의' 이상 나온 항목의 스트레칭만 보여줌
// 측정 기록이 없으면 전체를 보여줌
(function () {
  const listEl = document.getElementById('guide-list');
  const descEl = document.getElementById('guide-desc');
  let guides = null;

  function cardHTML(g, level) {
    const c = CRITERIA[g.key];
    const badge = level ? `<i class="badge ${level.cls}">${c.name} · ${level.text}</i>` : `<i class="badge good">${c.name}</i>`;
    const img = g.image ? `<img class="stretch-img" src="${g.image}" alt="${g.title} 동작">` : `<div class="stretch-img">동작 그림</div>`;
    return `
      <article class="card stretch-card">
        ${img}
        <div class="stack-8">
          ${badge}
          <h3>${g.title}</h3>
          <p>${g.how}</p>
          <span class="muted-sm">${g.count}${g.caution ? ' · ' + g.caution : ''}</span>
          ${g.source ? `<span class="muted-sm">출처: ${g.source}</span>` : ''}
        </div>
      </article>`;
  }

  function render() {
    if (!guides || !CRITERIA) return;
    const latest = getLatest();

    if (!latest) {
      descEl.textContent = '아직 측정 결과가 없어서 전체 스트레칭을 보여 드려요. 측정하면 내 결과에 맞는 것만 골라 드려요.';
      listEl.innerHTML = guides.map(g => cardHTML(g, null)).join('');
      return;
    }

    // 주의 이상인 항목만
    const levels = {};
    Object.keys(CRITERIA).forEach(k => { levels[k] = getLevel(k, latest[k]); });
    const need = guides.filter(g => levels[g.key].cls !== 'good');

    if (need.length === 0) {
      descEl.textContent = '최근 측정에서 모두 양호했어요. 지금 자세를 유지하는 데 도움이 되는 스트레칭이에요.';
      listEl.innerHTML = guides.map(g => cardHTML(g, levels[g.key])).join('');
    } else {
      descEl.textContent = `최근 측정(${latest.date})에서 주의 이상이 나온 항목만 보여 드려요.`;
      listEl.innerHTML = need.map(g => cardHTML(g, levels[g.key])).join('');
    }
  }

  // 기준표(criteria.json)까지 불러온 다음 그리기
  Promise.all([fetch('data/guide.json').then(res => res.json()), criteriaReady])
    .then(([data]) => { guides = data; render(); })
    .catch(() => { descEl.textContent = '스트레칭 데이터를 불러오지 못했어요.'; });

  document.addEventListener('pagechange', e => {
    if (e.detail === 'guide') render();
  });
})();

// ----- 병원 찾기 (공공데이터포털 건강보험심사평가원 병원정보서비스) -----
// 요청 주소 (공공데이터포털 활용신청 상세의 End Point)
const HOSP_URL = 'https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList';
// 공공데이터포털 인증키 (Decoding 키)
// ※ 이 파일은 GitHub에 공개돼서 키도 보여요. 중계 서버를 쓰게 되면 여기 키는 지우기
const API_KEY = 'bf491d13d08c86e8c2ee3c1079cc574e5ef83f36cb47563d8e3798672e0e1192';
// 중계 서버(Cloudflare Workers) 주소. 넣으면 키 대신 중계 서버로 요청함
const RELAY_URL = '';   // 예: 'https://poseai-relay.내아이디.workers.dev'

(function () {
  const regionEl = document.getElementById('region-select');
  const deptEl = document.getElementById('dept-select');
  const btn = document.getElementById('hospital-btn');
  const listEl = document.getElementById('hospital-list');

  // 지역·진료과목 코드는 data/hospital-codes.json
  fetch('data/hospital-codes.json')
    .then(res => res.json())
    .then(codes => {
      regionEl.innerHTML = codes.regions.map(r => `<option value="${r.code}">${r.name}</option>`).join('');
      deptEl.innerHTML = codes.departments.map(d => `<option value="${d.code}">${d.name}</option>`).join('');
    });

  function message(text) {
    listEl.innerHTML = `<li class="empty">${text}</li>`;
  }

  // 요청 주소 만들기: 중계 서버가 있으면 중계 서버로, 없으면 공공데이터 API로 바로
  function requestUrl() {
    const q = { sidoCd: regionEl.value, dgsbjtCd: deptEl.value };
    if (RELAY_URL) return `${RELAY_URL}/hospitals?${new URLSearchParams(q)}`;
    return `${HOSP_URL}?${new URLSearchParams({ ServiceKey: API_KEY, pageNo: '1', numOfRows: '10', _type: 'json', ...q })}`;
  }

  btn.addEventListener('click', async () => {
    message('병원을 찾는 중이에요...');
    btn.disabled = true;
    try {
      const res = await fetch(requestUrl());
      const text = await res.text();

      // 인증키 오류 등은 JSON이 아니라 XML로 오는 경우가 있음
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const msg = (text.match(/<returnAuthMsg>(.*?)<\/returnAuthMsg>/) || text.match(/<resultMsg>(.*?)<\/resultMsg>/) || [])[1];
        message(msg === 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR'
          ? '인증키가 아직 등록 중이에요. 몇 시간 뒤 다시 해 주세요.'
          : `조회 실패: ${msg || '응답을 읽지 못했어요'}`);
        return;
      }
      const header = data.response && data.response.header;
      if (header && header.resultCode !== '00') {
        message(`조회 실패: ${header.resultMsg}`);
        return;
      }
      let items = data.response && data.response.body && data.response.body.items && data.response.body.items.item;
      if (!items) { message('조건에 맞는 병원이 없어요.'); return; }
      if (!Array.isArray(items)) items = [items];   // 1개면 배열이 아니라 객체로 옴

      listEl.innerHTML = '';
      items.forEach(h => {
        const li = document.createElement('li');
        li.innerHTML = `
          <div class="stack-8" style="flex:1">
            <b>${h.yadmNm || ''}</b>
            <span class="muted">${h.addr || ''}</span>
          </div>
          <span class="muted">${h.clCdNm || ''}</span>
          ${h.telno ? `<a href="tel:${h.telno}">${h.telno}</a>` : ''}`;
        listEl.appendChild(li);
      });
    } catch (err) {
      // 브라우저가 공공데이터 서버를 바로 부르는 걸 막으면(CORS) 여기로 옴 → 중계 서버 필요
      console.error(err);
      message(RELAY_URL
        ? '병원 정보를 불러오지 못했어요. 잠시 후 다시 해 주세요.'
        : '브라우저에서 바로 불러오는 게 막혔어요. 중계 서버(RELAY_URL)를 연결해야 해요.');
    } finally {
      btn.disabled = false;
    }
  });
})();

// ----- FAQ 챗봇 (data/faq.json) -----
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

  // ----- AI 자세 코치 (Gemini API) -----
  // 키는 코드에 넣지 않고 사용자가 화면에서 한 번 입력 → 이 브라우저(LocalStorage)에만 저장
  // (공개 GitHub에 키가 올라가면 다른 사람이 쓰거나 구글이 키를 막을 수 있어서)
  // 나중에 중계 서버(AI_RELAY_URL)를 만들면 키 입력 없이 누구나 쓸 수 있음
  const GEMINI_MODEL = 'gemini-2.5-flash';
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const VERTEX_URL = `https://aiplatform.googleapis.com/v1/publishers/google/models/${GEMINI_MODEL}:generateContent`;
  const AI_RELAY_URL = '';   // 예: 'https://poseai-relay.내아이디.workers.dev/ai'
  const KEY_STORE = 'poseai_gemini_key';

  const keyRow = document.getElementById('ai-key-row');
  const keyInput = document.getElementById('ai-key');
  document.getElementById('ai-key-toggle').addEventListener('click', () => { keyRow.hidden = !keyRow.hidden; });
  document.getElementById('ai-key-save').addEventListener('click', () => {
    const v = keyInput.value.trim();
    if (!v) return;
    localStorage.setItem(KEY_STORE, v);
    keyInput.value = '';
    keyRow.hidden = true;
    addBubble('AI 키를 저장했어요. 이제 질문해 보세요.', 'bot');
  });

  // AI에게 주는 규칙 (진단처럼 말하지 않게)
  const RULES = [
    '너는 PoseAi의 자세 코치야. 한국어 해요체로 3~5문장 안으로 짧게 답해.',
    '다루는 건 거북목, 어깨 수평, 골반 수평, 앉은 자세, 스트레칭, 생활 습관뿐이야. 다른 주제는 정중히 거절해.',
    '의학적 진단, 병명 추정, 약, 치료법은 말하지 마. 측정값은 참고용이라고 말해.',
    '통증, 저림, 두통이 있거나 오래가면 재활의학과·정형외과 같은 전문가 상담을 권해.',
    '스트레칭은 무리하지 말고 아프면 멈추라고 알려 줘.'
  ].join('\n');

  // 최근 측정 결과를 문장으로
  function measureContext() {
    const latest = getLatest();
    if (!latest || !CRITERIA) return '사용자는 아직 측정하지 않았어.';
    const parts = Object.keys(CRITERIA).map(k => {
      const v = latest[k];
      const lv = getLevel(k, v).text;
      const dir = k === 'neck' ? '' : (v > 0 ? ', 오른쪽 낮음' : v < 0 ? ', 왼쪽 낮음' : '');
      return `${CRITERIA[k].name} ${Math.abs(v).toFixed(1)}°(${lv}${dir})`;
    });
    return `사용자의 최근 측정(${latest.date}): ${parts.join(', ')}, 종합 점수 ${latest.score}점.`;
  }

  async function askGemini(question) {
    const body = {
      systemInstruction: { parts: [{ text: RULES }] },
      contents: [{ role: 'user', parts: [{ text: `${measureContext()}\n질문: ${question}` }] }],
      generationConfig: { temperature: 0.6, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } }
    };
    let res;
    if (AI_RELAY_URL) {
      res = await fetch(AI_RELAY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } else {
      const key = localStorage.getItem(KEY_STORE);
      if (!key) return null;
      const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
      if (key.startsWith('AQ.')) {
        // AQ.로 시작하는 키 = Google Cloud(Vertex AI) 키 → Vertex 주소로 먼저 보내고, 안 되면 기본 주소로
        res = await fetch(`${VERTEX_URL}?key=${encodeURIComponent(key)}`, opts);
        if (!res.ok) res = await fetch(GEMINI_URL, { ...opts, headers: { ...opts.headers, 'x-goog-api-key': key } });
      } else {
        res = await fetch(GEMINI_URL, { ...opts, headers: { ...opts.headers, 'x-goog-api-key': key } });
      }
    }
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || res.status);
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    return parts ? parts.map(p => p.text).join('').trim() : '';
  }

  aiForm.addEventListener('submit', async e => {
    e.preventDefault();
    const input = document.getElementById('ai-q');
    const q = input.value.trim();
    if (!q) return;
    addBubble(q, 'user');
    input.value = '';

    const thinking = document.createElement('p');
    thinking.className = 'bubble bot';
    thinking.textContent = '생각 중이에요...';
    chatBox.appendChild(thinking);

    try {
      const answer = await askGemini(q);
      if (answer === null) {
        thinking.textContent = 'AI 키가 아직 없어요. 아래 "AI 키 설정"에서 키를 넣어 주세요. 그동안은 위의 질문 버튼을 눌러 보세요.';
        keyRow.hidden = false;
      } else {
        thinking.textContent = answer || '답을 만들지 못했어요. 질문을 조금 바꿔서 다시 해 주세요.';
      }
    } catch (err) {
      console.error(err);
      thinking.textContent = `AI 답변을 불러오지 못했어요. (${err.message}) 키가 맞는지 확인하거나 위의 질문 버튼을 이용해 주세요.`;
    }
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

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

// 값이 있는지 (예전 기록이나 인식 안 된 항목은 null)
const hasValue = v => v !== null && v !== undefined && !Number.isNaN(v);

// 단계 판단: 양호 / 주의 / 확인 권장
function getLevel(key, angle) {
  if (!hasValue(angle)) return { text: '측정 안 됨', cls: 'none' };
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

// 종합 점수 = 측정된 항목 평균 (criteria.json 항목 수만큼)
function getTotalScore(result) {
  const keys = Object.keys(CRITERIA).filter(k => hasValue(result[k]));
  if (keys.length === 0) return 0;
  const sum = keys.reduce((acc, k) => acc + getItemScore(k, result[k]), 0);
  return Math.round(sum / keys.length);
}

// ===== LocalStorage =====
// 기록 형식: { date: '2026-11-09', neck: 18.4, shoulder: -2.7, trunk: 1.2, pelvis: 1.9, knee: 4.0, score: 82 }
// shoulder, pelvis: + 오른쪽 낮음, - 왼쪽 낮음 / trunk: + 오른쪽으로 쏠림 / knee: + O다리 경향(무릎이 바깥), - X다리 경향(안쪽)
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
  const rec = { ...record, savedAt: record.savedAt || new Date().toISOString() };
  records.push(rec);
  localStorage.setItem(RECORD_KEY, JSON.stringify(records));
  // 로그인 중이면 구글 시트에도 저장 (8. 계정 부분에서 받음)
  document.dispatchEvent(new CustomEvent('recordsaved', { detail: rec }));
}


/* =====================================================================
   2. 촬영·측정 (#measure)
   ===================================================================== */
// ===== ② 촬영·측정 (#measure) =====
// 1. 웹캠 켜고 MediaPipe 좌표를 점·선으로 표시, 실시간 각도 표시
// 2. [정면 측정 시작] → 3초 카운트다운 → 5초 동안 어깨·상체 쏠림·골반·무릎 각도 평균
// 3. [측면 측정 시작] → 3초 카운트다운 → 5초 동안 거북목 각도 평균
// 4. 종합 점수 계산 → saveLatest() → #report 로 이동


const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// 랜드마크 번호 (Google AI Edge 문서 기준)
const P = {
  L_EAR: 7, R_EAR: 8,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28
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
let frontResult = null;  // 정면 측정 결과 { shoulder, trunk, pelvis, knee }

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

// 상체 쏠림 (정면용): 골반 가운데 → 어깨 가운데 선이 수직선과 이루는 각도
// + 면 사용자 기준 오른쪽으로 쏠림
function trunkAngle(lSh, rSh, lHip, rHip) {
  const w = video.videoWidth, h = video.videoHeight;
  const toRight = Math.sign(rSh.x - lSh.x) || 1;          // 화면에서 사용자 오른쪽 방향
  const shX = (lSh.x + rSh.x) / 2, shY = (lSh.y + rSh.y) / 2;
  const hipX = (lHip.x + rHip.x) / 2, hipY = (lHip.y + rHip.y) / 2;
  const dx = (shX - hipX) * w * toRight;
  const dy = Math.abs(hipY - shY) * h;
  return Math.atan2(dx, dy) * 180 / Math.PI;
}

// 무릎 정렬 (정면용, 다리 하나): 엉덩이→발목 직선에서 무릎이 벗어난 각도
// + 면 무릎이 바깥(O다리 경향), - 면 안쪽(X다리 경향)
function kneeAngle(hip, knee, ankle, midX) {
  const w = video.videoWidth, h = video.videoHeight;
  const t = (knee.y - hip.y) / ((ankle.y - hip.y) || 1e-6);
  const lineX = hip.x + t * (ankle.x - hip.x);              // 무릎 높이에서 엉덩이→발목 선의 x
  const outward = Math.sign(hip.x - midX) || 1;             // 몸 바깥쪽 방향
  const off = (knee.x - lineX) * w * outward;
  const upper = Math.hypot((knee.x - hip.x) * w, (knee.y - hip.y) * h);
  const lower = Math.hypot((ankle.x - knee.x) * w, (ankle.y - knee.y) * h);
  // 바깥으로 벗어난 거리로 위·아래 다리 각각 꺾인 각도를 구해 더함
  return (Math.asin(Math.max(-1, Math.min(1, off / upper))) + Math.asin(Math.max(-1, Math.min(1, off / lower)))) * 180 / Math.PI;
}

function visible(...points) {
  return points.every(p => p && p.visibility > MIN_VIS);
}

function calcAngles(lm) {
  const result = { shoulder: null, trunk: null, pelvis: null, knee: null, neck: null };

  if (visible(lm[P.L_SHOULDER], lm[P.R_SHOULDER])) {
    result.shoulder = tiltAngle(lm[P.L_SHOULDER], lm[P.R_SHOULDER]);
  }
  if (visible(lm[P.L_HIP], lm[P.R_HIP])) {
    result.pelvis = tiltAngle(lm[P.L_HIP], lm[P.R_HIP]);
  }
  if (visible(lm[P.L_SHOULDER], lm[P.R_SHOULDER], lm[P.L_HIP], lm[P.R_HIP])) {
    result.trunk = trunkAngle(lm[P.L_SHOULDER], lm[P.R_SHOULDER], lm[P.L_HIP], lm[P.R_HIP]);
  }
  // 무릎: 두 다리 중 보이는 다리만 평균
  const midX = (lm[P.L_HIP].x + lm[P.R_HIP].x) / 2;
  const legs = [[P.L_HIP, P.L_KNEE, P.L_ANKLE], [P.R_HIP, P.R_KNEE, P.R_ANKLE]]
    .filter(([a, b, c]) => visible(lm[a], lm[b], lm[c]))
    .map(([a, b, c]) => kneeAngle(lm[a], lm[b], lm[c], midX));
  if (legs.length) result.knee = legs.reduce((x, y) => x + y, 0) / legs.length;

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
    guideEl.textContent = '정면을 바라보고 평소처럼 서 주세요. 머리부터 발목까지 다 보이게요. (어깨·상체·골반·무릎)';
  } else {
    startBtn.textContent = '측면 측정 시작';
    guideEl.textContent = '옆으로 돌아서 평소처럼 서 주세요. 귀와 어깨가 잘 보이게요. (거북목)';
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
      document.getElementById('live-trunk').textContent = fmt(current.trunk);
      document.getElementById('live-knee').textContent = fmt(current.knee);

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
    const trunk = average(list, 'trunk');
    const knee = average(list, 'knee');    // 발목이 화면에 안 나오면 null일 수 있음
    frontResult = {
      shoulder: round1(shoulder),
      trunk: trunk === null ? null : round1(trunk),
      pelvis: round1(pelvis),
      knee: knee === null ? null : round1(knee)
    };
    statusEl.textContent = `정면 완료 · 어깨 ${fmt(shoulder)} · 상체 ${fmt(trunk)} · 골반 ${fmt(pelvis)} · 무릎 ${fmt(knee)}`;
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
    ...frontResult
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
  const KEYS = () => Object.keys(CRITERIA);   // 항목·이름·설명은 data/criteria.json

  const $ = id => document.getElementById(id);
  const saveBtn = $('save-btn');

  // 기울어진 방향 (+ 오른쪽 낮음, - 왼쪽 낮음)
  function direction(key, v) {
    if (key === 'neck') return '';
    if (Math.abs(v) < 0.5) return key === 'knee' ? '거의 일직선' : '거의 수평';
    if (key === 'trunk') return v > 0 ? '오른쪽으로 쏠림' : '왼쪽으로 쏠림';
    if (key === 'knee') return v > 0 ? 'O다리 경향' : 'X다리 경향';
    return v > 0 ? '오른쪽 낮음' : '왼쪽 낮음';
  }

  function cardHTML(key, value) {
    const c = CRITERIA[key];
    if (!hasValue(value)) {
      return `
      <article class="card result-card">
        <div class="row-between"><h2 class="card-title">${c.name}</h2><i class="badge none">측정 안 됨</i></div>
        <strong class="result-value">--°</strong>
        <p class="muted-sm">${c.view} · ${c.desc}<br>${key === 'knee' ? '무릎·발목이 화면에 안 나오면 측정되지 않아요. 2.5~3m 떨어져 서 주세요.' : '몸이 화면에 다 안 나오면 측정되지 않아요.'}</p>
      </article>`;
    }
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
    KEYS().filter(k => hasValue(latest[k])).forEach(k => count[getLevel(k, latest[k]).cls]++);
    $('level-count').innerHTML =
      `<i class="badge good">양호 ${count.good}</i><i class="badge warn">주의 ${count.warn}</i><i class="badge check">확인 권장 ${count.check}</i>`;

    $('result-list').innerHTML = KEYS().map(k => cardHTML(k, latest[k])).join('');

    renderCombos(latest);

    saveBtn.disabled = !!latest.saved;
    saveBtn.textContent = latest.saved ? '저장 완료' : '기록 저장';
  }

  // ----- 같이 나타난 패턴: 주의 이상인 항목끼리 묶어서 설명 -----
  let combos = null;
  fetch('data/combos.json').then(r => r.json()).then(d => { combos = d; if (location.hash === '#report') render(); }).catch(() => {});

  function renderCombos(latest) {
    const box = $('combo-list');
    const wrap = $('combo-section');
    if (!box || !combos || !latest) { if (wrap) wrap.hidden = true; return; }
    const bad = k => hasValue(latest[k]) && ['warn', 'check'].includes(getLevel(k, latest[k]).cls);
    const hits = combos.rules.filter(r => r.keys.every(bad));
    const badCount = KEYS().filter(bad).length;

    const cards = hits.map(r => `
      <article class="card combo-card">
        <div class="combo-keys">${r.keys.map(k => `<i class="badge ${getLevel(k, latest[k]).cls}">${CRITERIA[k].name} ${Math.abs(latest[k]).toFixed(1)}°</i>`).join('<span aria-hidden="true">+</span>')}</div>
        <h3>${r.title}</h3>
        <p><b>왜 같이 보나요?</b> ${r.why}</p>
        <p class="muted">${r.habit}</p>
        <ul class="part-list">${r.care.map(t => `<li>${t}</li>`).join('')}</ul>
      </article>`);
    if (badCount >= combos.many.min) {
      cards.push(`
      <article class="card combo-card combo-many">
        <h3>${combos.many.title}</h3>
        <p>${combos.many.why}</p>
        <ul class="part-list">${combos.many.care.map(t => `<li>${t}</li>`).join('')}</ul>
      </article>`);
    }
    wrap.hidden = cards.length === 0;
    $('combo-notice').textContent = combos.notice;
    box.innerHTML = cards.join('');
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
    const values = byDate.map(r => hasValue(r[key]) ? Math.abs(r[key]) : null);   // 예전 기록은 빈칸
    const good = CRITERIA[key].good;

    if (chart) chart.destroy();
    document.querySelector('.chart-wrap').classList.add('has-chart');
    chart = new Chart(document.getElementById('chart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: `${CRITERIA[key].name} 각도`, data: values, borderColor: '#1D5FD1', backgroundColor: '#1D5FD1', tension: 0.3, pointRadius: 5, spanGaps: true },
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
        <span class="muted" style="flex:1">${Object.keys(CRITERIA).filter(k => hasValue(r[k])).map(k => `${CRITERIA[k].name} ${Math.abs(r[k]).toFixed(1)}°`).join(' · ')}</span>
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

  // 스트레칭 하나가 여러 항목(keys)에 도움 → 그중 가장 안 좋은 항목을 배지로
  const RANK = { check: 3, warn: 2, good: 1, none: 0 };
  function worstKey(g, levels) {
    return g.keys.reduce((a, b) => (RANK[levels[b].cls] > RANK[levels[a].cls] ? b : a));
  }

  function cardHTML(g, levels) {
    const key = levels ? worstKey(g, levels) : g.keys[0];
    const c = CRITERIA[key];
    const level = levels ? levels[key] : null;
    const badge = level && level.cls !== 'none'
      ? `<i class="badge ${level.cls}">${c.name} · ${level.text}</i>`
      : `<i class="badge good">${g.keys.map(k => CRITERIA[k].name).join(' · ')}</i>`;
    const img = g.image ? `<img class="stretch-img" src="${g.image}" alt="${g.title} 동작">` : `<div class="stretch-img">동작 그림</div>`;
    return `
      <article class="card stretch-card">
        ${img}
        <div class="stack-8">
          ${badge}
          <h3>${g.title}</h3>
          <p>${g.how}</p>
          <span class="muted-sm">${g.count}${g.caution ? ' · ' + g.caution : ''}</span>
          ${g.source ? `<span class="muted-sm">출처: ${g.sourceUrl ? `<a href="${g.sourceUrl}" target="_blank" rel="noopener">${g.source}</a>` : g.source}</span>` : ''}
          ${g.video ? `<a class="video-btn" href="${g.video.url}" target="_blank" rel="noopener">▶ 관련 영상 보기</a>` : ''}
        </div>
      </article>`;
  }

  // ----- 불편한 부위 체크 (data/body-parts.json) -----
  // 부위를 고르면: 관련 있을 수 있는 자세 → 내 측정값 → 생활 습관 → 스트레칭 → 병원 찾기
  // 병명이나 원인은 말하지 않고 "자세와의 관련성"만 안내
  let parts = null;
  let selectedPart = null;
  const partBtns = document.getElementById('part-buttons');
  const partBox = document.getElementById('part-result');

  function renderParts() {
    if (!parts || !partBtns) return;
    partBtns.innerHTML = parts.parts.map(p => `
      <button type="button" class="part-btn${p.id === selectedPart ? ' active' : ''}" data-id="${p.id}" aria-pressed="${p.id === selectedPart}">
        <b>${p.name}</b><span>${p.feel}</span>
      </button>`).join('');
    partBtns.querySelectorAll('.part-btn').forEach(b => b.addEventListener('click', () => {
      selectedPart = selectedPart === b.dataset.id ? null : b.dataset.id;
      renderParts();
    }));

    const p = parts.parts.find(x => x.id === selectedPart);
    if (!p) { partBox.hidden = true; return; }
    partBox.hidden = false;

    const latest = getLatest();
    const mine = p.keys.map(k => {
      const c = CRITERIA[k];
      if (!latest || !hasValue(latest[k])) return `<li><span>${c.name}</span><span class="muted-sm">아직 측정 안 됨</span></li>`;
      const lv = getLevel(k, latest[k]);
      return `<li><span>${c.name}</span><span><b>${Math.abs(latest[k]).toFixed(1)}°</b> <i class="badge ${lv.cls}">${lv.text}</i></span></li>`;
    }).join('');
    const stretches = guides.filter(g => g.keys.some(k => p.keys.includes(k))).map(g => `<li>${g.title}</li>`).join('');

    partBox.innerHTML = `
      <div class="part-grid">
        <div class="stack-8">
          <h3>${p.name}: ${p.feel}</h3>
          <p>${p.relation}</p>
          <p class="muted-sm">${parts.notice}</p>
          <h4>내 측정 결과 중 관련 항목</h4>
          <ul class="part-mine">${mine}</ul>
          ${latest ? '' : '<a href="#measure" class="btn btn-outline">측정하고 내 결과 보기</a>'}
        </div>
        <div class="stack-8">
          <h4>생활 습관 팁</h4>
          <ul class="part-list">${p.tips.map(t => `<li>${t}</li>`).join('')}</ul>
          <h4>도움 되는 스트레칭</h4>
          <ul class="part-list">${stretches}</ul>
        </div>
      </div>
      <div class="part-alert">
        <b>이럴 땐 측정보다 진료가 먼저예요</b>
        <ul>${parts.redFlags.map(t => `<li>${t}</li>`).join('')}</ul>
        <button type="button" class="btn btn-primary" id="part-hosp">${p.deptName} 병원 찾기</button>
      </div>`;

    document.getElementById('part-hosp').addEventListener('click', () => {
      const dept = document.getElementById('dept-select');
      if (dept) dept.value = p.dept;
      document.getElementById('hospital')?.scrollIntoView({ behavior: 'smooth' });
    });
  }

  fetch('data/body-parts.json').then(r => r.json()).then(d => { parts = d; render(); }).catch(() => {});

  // 추천 영상: 지금 보여주는 스트레칭과 관련된 영상만 (같은 영상은 한 번만)
  function renderVideos(shown) {
    const box = document.getElementById('video-list');
    if (!box) return;
    const seen = new Set();
    const vids = shown.filter(g => g.video && !seen.has(g.video.url) && seen.add(g.video.url)).map(g => ({ ...g.video, keys: g.keys }));
    box.innerHTML = vids.map(v => `
      <a class="card video-card" href="${v.url}" target="_blank" rel="noopener">
        <span class="video-thumb" aria-hidden="true">▶</span>
        <span class="stack-8">
          <i class="badge good">${v.keys.map(k => CRITERIA[k].name).join(' · ')}</i>
          <b>${v.title}</b>
          <span class="muted-sm">${v.covers}</span>
          <span class="muted-sm">${v.by} · 서울아산병원 건강TV</span>
        </span>
      </a>`).join('');
  }

  function render() {
    if (!guides || !CRITERIA) return;
    const latest = getLatest();
    renderParts();

    if (!latest) {
      descEl.textContent = '아직 측정 결과가 없어서 전체 스트레칭을 보여 드려요. 측정하면 내 결과에 맞는 것만 골라 드려요.';
      listEl.innerHTML = guides.map(g => cardHTML(g, null)).join('');
      renderVideos(guides);
      return;
    }

    // 주의 이상인 항목만
    const levels = {};
    Object.keys(CRITERIA).forEach(k => { levels[k] = getLevel(k, latest[k]); });
    const bad = k => levels[k].cls === 'warn' || levels[k].cls === 'check';
    const need = guides.filter(g => g.keys.some(bad));

    if (need.length === 0) {
      descEl.textContent = '최근 측정에서 모두 양호했어요. 지금 자세를 유지하는 데 도움이 되는 스트레칭이에요.';
      listEl.innerHTML = guides.map(g => cardHTML(g, levels)).join('');
      renderVideos(guides);
    } else {
      descEl.textContent = `최근 측정(${latest.date})에서 주의 이상이 나온 항목만 보여 드려요.`;
      listEl.innerHTML = need.map(g => cardHTML(g, levels)).join('');
      renderVideos(need);
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
const API_KEY = '';   // 키는 중계 서버(Cloudflare)에만 있음
// 중계 서버(Cloudflare Workers) 주소. 넣으면 키 대신 중계 서버로 요청함
const RELAY_URL = 'https://poseai-relay.ikongjyj11.workers.dev';

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
  // 키는 사이트에 두지 않고 중계 서버(Cloudflare Worker)에만 숨겨 둠
  // → 사이트 사용자는 키 입력 없이 바로 질문 가능
  // 사이트 → 중계 서버(/ai) → Gemini → 답변
  const AI_RELAY_URL = 'https://poseai-relay.ikongjyj11.workers.dev/ai';

  // 최근 측정 결과를 문장으로 (AI가 내 결과를 보고 답하게)
  function measureContext() {
    const latest = getLatest();
    if (!latest || !CRITERIA) return '사용자는 아직 측정하지 않았어.';
    const parts = Object.keys(CRITERIA).filter(k => hasValue(latest[k])).map(k => {
      const v = latest[k];
      const lv = getLevel(k, v).text;
      const dir = k === 'neck' ? '' : k === 'trunk' ? (v > 0 ? ', 오른쪽으로 쏠림' : ', 왼쪽으로 쏠림')
        : k === 'knee' ? (v > 0 ? ', O다리 경향' : ', X다리 경향') : (v > 0 ? ', 오른쪽 낮음' : v < 0 ? ', 왼쪽 낮음' : '');
      return `${CRITERIA[k].name} ${Math.abs(v).toFixed(1)}°(${lv}${dir})`;
    });
    return `사용자의 최근 측정(${latest.date}): ${parts.join(', ')}, 종합 점수 ${latest.score}점.`;
  }

  // AI 모델 목록 (worker.js의 MODELS와 id가 같아야 함)
  const AI_MODELS = [
    { group: 'Google Gemini' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', desc: '가장 빨라요' },
    { id: 'gemini-2.5-flash',      name: 'Gemini 2.5 Flash',      desc: '속도와 답변 품질 중간' },
    { id: 'gemini-2.5-pro',        name: 'Gemini 2.5 Pro',        desc: '가장 꼼꼼하지만 느려요' },
    { group: 'OpenAI ChatGPT' },
    { id: 'gpt-4o-mini',           name: 'GPT-4o mini',           desc: '빠르고 가벼워요' },
    { id: 'gpt-4.1-mini',          name: 'GPT-4.1 mini',          desc: '속도와 답변 품질 중간' }
  ];
  const MODEL_STORE = 'poseai_ai_model';
  const modelBtn = document.getElementById('model-btn');
  const modelMenu = document.getElementById('model-menu');
  const modelName = document.getElementById('model-name');
  const findModel = id => AI_MODELS.find(m => m.id === id);
  let currentModel = findModel(localStorage.getItem(MODEL_STORE)) ? localStorage.getItem(MODEL_STORE) : 'gemini-2.5-flash';

  function renderModelMenu() {
    modelName.textContent = findModel(currentModel).name;
    modelMenu.innerHTML = '';
    AI_MODELS.forEach(m => {
      const li = document.createElement('li');
      if (m.group) {
        li.className = 'group';
        li.textContent = m.group;
      } else {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', m.id === currentModel);
        b.innerHTML = `<span><span class="m-name">${m.name}</span><span class="m-desc">${m.desc}</span></span><span class="check">✓</span>`;
        b.addEventListener('click', () => {
          currentModel = m.id;
          localStorage.setItem(MODEL_STORE, m.id);
          closeModelMenu();
          renderModelMenu();
        });
        li.appendChild(b);
      }
      modelMenu.appendChild(li);
    });
  }
  function closeModelMenu() {
    modelMenu.hidden = true;
    modelBtn.setAttribute('aria-expanded', 'false');
  }
  modelBtn.addEventListener('click', e => {
    e.stopPropagation();
    modelMenu.hidden = !modelMenu.hidden;
    modelBtn.setAttribute('aria-expanded', String(!modelMenu.hidden));
  });
  document.addEventListener('click', e => { if (!modelMenu.contains(e.target)) closeModelMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModelMenu(); });
  renderModelMenu();

  async function askAI(question) {
    if (!AI_RELAY_URL) return null;
    const res = await fetch(AI_RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, context: measureContext(), model: currentModel })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    return data;   // { answer, model }
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
    thinking.textContent = `${findModel(currentModel).name}이(가) 생각 중이에요...`;
    chatBox.appendChild(thinking);
    chatBox.scrollTop = chatBox.scrollHeight;

    const t0 = performance.now();
    try {
      const data = await askAI(q);
      if (data === null) {
        thinking.textContent = 'AI 코치는 준비 중이에요. 그동안은 위의 질문 버튼을 눌러 보세요.';
      } else {
        thinking.textContent = data.answer || '답을 만들지 못했어요. 질문을 조금 바꿔서 다시 해 주세요.';
        // 답변 아래 작게: 어떤 AI가 몇 초 걸렸는지
        const used = findModel(data.model);
        const meta = document.createElement('span');
        meta.className = 'ans-meta';
        meta.textContent = `${used ? used.name : data.model} · ${((performance.now() - t0) / 1000).toFixed(1)}초`
          + (data.model !== currentModel ? ' (선택한 모델이 응답하지 않아 대신 답했어요)' : '');
        thinking.appendChild(meta);
      }
    } catch (err) {
      console.error(err);
      thinking.textContent = '지금은 AI 답변을 불러오지 못했어요. 다른 모델을 골라 보거나 위의 질문 버튼을 이용해 주세요.';
    }
    chatBox.scrollTop = chatBox.scrollHeight;
  });
})();


/* =====================================================================
   6. 화면 전환: 주소 끝 #이름에 맞는 화면만 보여주기
   ===================================================================== */
// ===== 화면 전환 =====
// 주소 끝의 #이름(#measure, #report ...)에 맞는 section만 보여줌
// 화면이 바뀌면 'pagechange' 이벤트를 보내서 각 화면 JS가 필요할 때 실행되게 함
//   예) document.addEventListener('pagechange', e => { if (e.detail === 'report') { ... } });

const PAGES = ['home', 'measure', 'report', 'history', 'guide', 'faq', 'login', 'signup'];

function showPage() {
  const id = location.hash.replace('#', '');
  const page = PAGES.includes(id) ? id : 'home';

  document.querySelectorAll('.page').forEach(sec => {
    sec.classList.toggle('active', sec.dataset.page === page);
  });
  document.querySelectorAll('.nav a, .sidebar-nav a:not([data-scroll])').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === '#' + page);
  });

  // 화면 바뀌면 맨 위로 (section은 id 대신 data-page를 써서 브라우저가 중간으로 점프하지 않게 함)
  setTimeout(() => window.scrollTo(0, 0), 0);
  document.dispatchEvent(new CustomEvent('pagechange', { detail: page }));
}

window.addEventListener('hashchange', showPage);
// 판단 기준표(criteria.json)를 불러온 다음 첫 화면 보여주기
window.addEventListener('DOMContentLoaded', () => criteriaReady.finally(showPage));


/* =====================================================================
   7. 사이드바 + 로그인 안내
   ===================================================================== */
(() => {
  const sidebar = document.getElementById('sidebar');
  const dim = document.getElementById('sidebar-dim');
  const btn = document.getElementById('menu-btn');

  function openSidebar() {
    sidebar.classList.add('open');
    sidebar.setAttribute('aria-hidden', 'false');
    dim.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.body.classList.add('no-scroll');
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebar.setAttribute('aria-hidden', 'true');
    dim.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('no-scroll');
  }
  btn.addEventListener('click', openSidebar);
  dim.addEventListener('click', closeSidebar);
  document.getElementById('sidebar-close').addEventListener('click', closeSidebar);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });

  // 메뉴 누르면 닫기 (병원 찾기는 가이드 화면으로 간 뒤 그 위치로 스크롤)
  sidebar.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
    closeSidebar();
    if (a.dataset.scroll) {
      setTimeout(() => document.getElementById(a.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' }), 150);
    }
  }));

})();


/* =====================================================================
   8. 회원가입·로그인 (아이디 + 닉네임) → 기록은 구글 시트에 저장
   - 구글 시트에 붙인 Apps Script(apps-script/Code.gs)가 저장소 역할
   - 비밀번호 없이 아이디로만 로그인 (과제용 간단 버전)
   - 로그인 안 해도 측정·기록은 이 브라우저(LocalStorage)에 그대로 저장됨
   ===================================================================== */
const SHEET_URL = '';   // Apps Script 웹 앱 URL 넣기. 예: 'https://script.google.com/macros/s/xxxx/exec'
const USER_KEY = 'poseai_user';

function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; }
}

// Apps Script는 Content-Type을 text/plain으로 보내야 브라우저가 막지 않음(CORS 사전 요청 없음)
async function sheetApi(action, data = {}) {
  if (!SHEET_URL) throw new Error('아직 구글 시트가 연결되지 않았어요');
  const res = await fetch(SHEET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...data })
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || '요청에 실패했어요');
  return json;
}

(() => {
  const $ = id => document.getElementById(id);

  // ----- 화면 표시: 헤더, 사이드바, 홈 미리보기, 기록 안내 -----
  function updateUI() {
    const user = getUser();
    const loginLink = $('login-link');
    loginLink.textContent = user ? `${user.nickname}님` : '로그인';
    loginLink.href = user ? '#history' : '#login';

    $('sidebar-avatar').textContent = user ? user.nickname.slice(0, 1) : '?';
    $('sidebar-name').textContent = user ? `${user.nickname}님` : '로그인이 필요해요';
    $('sidebar-sub').textContent = user ? `아이디 ${user.id} · 기록이 구글 시트에 저장돼요` : '지금은 게스트로 이용 중이에요';
    $('sidebar-login').hidden = !!user;
    $('sidebar-logout').hidden = !user;

    $('sync-title').textContent = user ? `${user.nickname}님의 기록은 구글 시트에 저장돼요` : '기록 동기화는 로그인이 필요해요';
    $('sync-text').textContent = user
      ? '같은 아이디로 로그인하면 노트북·폰 어디서든 같은 기록을 볼 수 있어요.'
      : '지금 기록은 이 브라우저에만 임시로 저장돼요. 로그인하면 노트북·폰 어디서든 같은 기록을 볼 수 있어요.';
    $('sync-btn').hidden = !!user;

    renderPreview(user);
  }

  // 홈 리포트 카드: 로그인하면 내 최근 결과, 아니면 잠금
  function renderPreview(user) {
    const card = $('preview-card');
    if (!card || !CRITERIA) return;
    const latest = getLatest();
    if (!user) return;   // 잠금 화면(HTML 기본)을 그대로 둠
    card.classList.remove('locked');
    if (!latest) {
      card.innerHTML = `
        <div class="row-between"><span class="muted-sm">${user.nickname}님의 체형 리포트</span></div>
        <div class="lock-msg"><b>아직 측정 기록이 없어요</b><a href="#measure" class="btn btn-primary btn-block">첫 측정 하기</a></div>`;
      return;
    }
    const rows = Object.keys(CRITERIA).map(k => {
      const v = latest[k];
      if (!hasValue(v)) return `<div class="preview-row"><span>${CRITERIA[k].name}</span><span class="muted-sm">측정 안 됨</span></div>`;
      const lv = getLevel(k, v);
      return `<div class="preview-row"><span>${CRITERIA[k].name}</span><span><b>${Math.abs(v).toFixed(1)}°</b> <i class="badge ${lv.cls}">${lv.text}</i></span></div>`;
    }).join('');
    card.innerHTML = `
      <div class="row-between"><span class="muted-sm">${user.nickname}님의 체형 리포트</span><span class="muted-sm">${latest.date}</span></div>
      <div class="preview-score"><strong>${latest.score}</strong><span>점</span></div>
      ${rows}
      <a href="#report" class="btn btn-outline btn-block">리포트 자세히 보기</a>`;
  }

  // ----- 동기화: 이 브라우저 기록 ↔ 구글 시트 -----
  async function sync(user) {
    // 1) 이 브라우저에만 있던 기록을 시트로 올리기 (예전 기록엔 savedAt이 없어서 만들어 줌)
    const local = getRecords().map((r, i) => ({ ...r, savedAt: r.savedAt || `${r.date}T00:00:0${i % 10}.local${i}` }));
    if (local.length) await sheetApi('saveRecords', { id: user.id, records: local });
    // 2) 시트에 있는 내 기록 전부 받아서 이 브라우저와 합치기 (savedAt 기준 중복 제거)
    const { records } = await sheetApi('getRecords', { id: user.id });
    const map = new Map();
    [...local, ...records].forEach(r => map.set(String(r.savedAt), r));
    const merged = [...map.values()].sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
    localStorage.setItem(RECORD_KEY, JSON.stringify(merged));
    // 최근 결과가 없으면 시트의 마지막 기록으로
    if (!getLatest() && merged.length) saveLatest({ ...merged[merged.length - 1], saved: true });
  }

  function refreshPage() {
    const page = location.hash.replace('#', '') || 'home';
    document.dispatchEvent(new CustomEvent('pagechange', { detail: page }));
  }

  async function afterLogin(user, msgEl) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    msgEl.textContent = '기록을 불러오는 중이에요...';
    try {
      await sync(user);
    } catch (err) {
      console.error(err);
    }
    updateUI();
    location.hash = '#history';
  }

  // ----- 회원가입 -----
  const signupForm = $('signup-form');
  signupForm.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = signupForm.querySelector('.form-msg');
    const id = $('signup-id').value.trim().toLowerCase();
    const nickname = $('signup-nick').value.trim();
    if (!/^[a-z0-9_]{3,20}$/.test(id)) { msg.textContent = '아이디는 영문·숫자·_ 3~20자로 써 주세요.'; return; }
    if (!nickname) { msg.textContent = '닉네임을 입력해 주세요.'; return; }
    msg.textContent = '가입하는 중이에요...';
    try {
      const { user } = await sheetApi('signup', { id, nickname });
      await afterLogin(user, msg);
      signupForm.reset();
      msg.textContent = '';
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  // ----- 로그인 -----
  const loginForm = $('login-form');
  loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = loginForm.querySelector('.form-msg');
    const id = $('login-id').value.trim().toLowerCase();
    if (!id) { msg.textContent = '아이디를 입력해 주세요.'; return; }
    msg.textContent = '로그인하는 중이에요...';
    try {
      const { user } = await sheetApi('login', { id });
      await afterLogin(user, msg);
      loginForm.reset();
      msg.textContent = '';
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  // ----- 로그아웃: 이 브라우저에 있던 내 기록도 지움 (기록은 구글 시트에 남아 있음) -----
  $('sidebar-logout').addEventListener('click', () => {
    if (!getUser()) return;
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(RECORD_KEY);
    localStorage.removeItem(LATEST_KEY);
    location.hash = '#home';
    location.reload();
  });

  // ----- 기록 저장할 때 로그인 중이면 시트에도 저장 -----
  document.addEventListener('recordsaved', e => {
    const user = getUser();
    if (!user || !SHEET_URL) return;
    sheetApi('saveRecords', { id: user.id, records: [e.detail] }).catch(err => console.error('시트 저장 실패', err));
  });

  // 화면 바뀔 때마다 표시 갱신 (홈 카드 등)
  document.addEventListener('pagechange', updateUI);

  // 처음 들어왔을 때 로그인 상태면 시트에서 최신 기록 받아오기
  criteriaReady.finally(() => {
    updateUI();
    const user = getUser();
    if (user && SHEET_URL) sync(user).then(refreshPage).catch(err => console.error(err));
  });
})();

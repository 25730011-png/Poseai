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

// 단계: 좋다/나쁘다 판정이 아니라 지금 상태를 설명하는 말
// (몇 도부터 문제인지 정해진 기준이 없어서, 참고 범위로만 나눔)
const LEVEL_WORDS = {
  neck:     ['바른 편', '앞으로 나온 편', '많이 나온 편'],
  shoulder: ['거의 수평', '조금 기운 편', '많이 기운 편'],
  pelvis:   ['거의 수평', '조금 기운 편', '많이 기운 편']
};
// 리포트 위쪽 한 줄 설명
const LEVEL_SENTENCE = {
  neck:     ['머리 위치가 바른 편이에요', '머리가 앞으로 나온 편이에요', '머리가 앞으로 많이 나온 편이에요'],
  shoulder: ['어깨가 거의 수평이에요', '어깨가 한쪽으로 조금 기운 편이에요', '어깨가 한쪽으로 많이 기운 편이에요'],
  pelvis:   ['골반이 거의 수평이에요', '골반이 한쪽으로 조금 기운 편이에요', '골반이 한쪽으로 많이 기운 편이에요']
};
function getLevel(key, angle) {
  if (!hasValue(angle)) return { text: '측정 안 됨', cls: 'none', i: -1 };
  const c = CRITERIA[key];
  const a = Math.abs(angle);
  const i = a < c.good ? 0 : a < c.warn ? 1 : 2;
  const words = LEVEL_WORDS[key] || ['참고 범위 안', '조금 벗어남', '많이 벗어남'];
  return { text: words[i], cls: ['good', 'warn', 'check'][i], i };
}

// 같은 날 여러 번 잰 기록은 평균 (하루 사이 차이는 대부분 오차라서)
function groupByDate(records) {
  const map = new Map();
  records.forEach(r => {
    const g = map.get(r.date) || { date: r.date, n: 0, list: [] };
    g.n++; g.list.push(r); map.set(r.date, g);
  });
  return [...map.values()].map(g => {
    const out = { date: g.date, count: g.n, savedAt: g.list[g.list.length - 1].savedAt };
    ['neck', 'shoulder', 'pelvis'].forEach(k => {
      const vals = g.list.map(r => r[k]).filter(hasValue);
      out[k] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
    });
    out.score = getTotalScore(out);
    return out;
  }).sort((a, b) => a.date < b.date ? -1 : 1);
}
// 오늘 날짜 (한국 시간 기준, toISOString은 UTC라 새벽에 하루 전으로 나옴)
function localDate(t = new Date()) {
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
// 스트레칭 날짜별 상태: full(다 함) / part(일부) / miss(안 함) / '' (기록 시작 전·미래)
// poseai_done: { 날짜: [한 동작 이름] }, poseai_plan: { 날짜: 그날 추천 동작 개수 }
function stretchStatus() {
  const read = k => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return {}; } };
  const done = read('poseai_done'), plan = read('poseai_plan');
  const today = localDate();
  const started = [...Object.keys(done).filter(d => (done[d] || []).length), ...Object.keys(plan)].sort()[0] || today;
  return d => {
    const n = (done[d] || []).length, total = plan[d] || n;
    if (n && n >= total) return { cls: 'full', n, total };
    if (n) return { cls: 'part', n, total };
    if (d < today && d >= started) return { cls: 'miss', n, total };
    return { cls: '', n, total };
  };
}
// 다음 측정일: 마지막 측정 4주(28일) 뒤
// 연구에서도 교정 운동을 4주 한 뒤 각도 변화를 재는 경우가 많아서 4주로 잡음
const REMEASURE_DAYS = 28;
function nextMeasure() {
  const latest = getLatest();
  if (!latest) return null;
  const today = localDate();
  const date = addDays(latest.date, REMEASURE_DAYS);
  const dayMs = 86400000;
  const left = Math.round((new Date(date + 'T00:00:00') - new Date(today + 'T00:00:00')) / dayMs);
  const since = Math.round((new Date(today + 'T00:00:00') - new Date(latest.date + 'T00:00:00')) / dayMs);
  // 마지막 측정 이후 스트레칭 한 날 수
  let done = {}; try { done = JSON.parse(localStorage.getItem('poseai_done') || '{}'); } catch (e) {}
  const stretched = Object.keys(done).filter(d => d > latest.date && d <= today && (done[d] || []).length).length;
  return { date, left, since, stretched, last: latest.date };
}
const dday = n => n > 0 ? `D-${n}` : n === 0 ? 'D-DAY' : `D+${-n}`;
const shortDate = d => `${+d.slice(5, 7)}.${+d.slice(8, 10)}`;
function addDays(d, n) {
  const t = new Date(d + 'T00:00:00'); t.setDate(t.getDate() + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
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
// 기록 형식: { date: '2026-11-09', neck: 18.4, shoulder: -2.7, pelvis: 1.9, score: 82 }
// shoulder, pelvis: + 오른쪽 낮음, - 왼쪽 낮음
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
let seenAt = 0;          // 마지막으로 사람이 보인 시각

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
const camMsgEl = document.getElementById('cam-msg');
let runId = 0;            // 자동 측정 순서 번호 (화면을 나가거나 다시 시작하면 바뀜 → 이전 순서는 멈춤)
let auto = false;         // 자동 측정 진행 중이면 true

// 카메라 안 위쪽 안내 (큰 제목 + 작은 설명)
function camMsg(title, sub = '') {
  camMsgEl.innerHTML = title ? `<b>${title}</b>${sub ? `<span>${sub}</span>` : ''}` : '';
}

function setPhase(next) {
  phase = next;
  stepFront.classList.toggle('active', phase === 'front');
  stepSide.classList.toggle('active', phase === 'side');
  guideEl.textContent = phase === 'front'
    ? '정면을 보고 머리부터 골반까지 보이게 서 주세요'
    : '옆으로 돌아서 귀와 어깨가 보이게 서 주세요';
}

function resetMeasure() {
  runId++;
  auto = false;
  frontResult = null;
  samples = null;
  countdownEl.textContent = '';
  countdownEl.classList.remove('rec');
  camMsg('');
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
      ['neck', 'shoulder', 'pelvis'].forEach(k => {
        document.getElementById('live-' + k).textContent = fmt(current[k]);
        const lvEl = document.getElementById('live-' + k + '-lv');
        const lv = current[k] === null || !CRITERIA ? null : getLevel(k, current[k]);
        lvEl.textContent = lv ? lv.text : '';
        lvEl.className = lv ? lv.cls : '';
      });

      if (!samples) statusEl.textContent = '잘 인식되고 있어요';
      seenAt = performance.now();
    } else {
      current = null;
      if (!samples) statusEl.textContent = '사람이 보이지 않아요. 카메라에서 조금 떨어져 주세요';
    }
  }

  requestAnimationFrame(loop);
}

// ---------- 자동 측정: 정면 5초 → 측면 5초 ----------
// 버튼을 누르지 않아도
//  1) 사람이 보이면 "5초 뒤 정면 측정" 카운트다운 → 정면 5초 측정
//  2) 자동으로 측면 단계로 넘어가 "5초 뒤 측면 측정" 카운트다운 → 측면 5초 측정
//  3) 끝나면 리포트로 이동
// 안내 문구는 모두 카메라 화면 안에 띄움
const wait = ms => new Promise(r => setTimeout(r, ms));
const PREP_SEC = 5;      // 측정 전 준비 시간
const MEASURE_SEC = 5;   // 측정 시간

// 값이 있는 프레임만 평균, 너무 적으면 null
function average(list, key) {
  const vals = list.map(s => s[key]).filter(v => v !== null);
  if (vals.length < MIN_FRAMES) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

const round1 = v => Math.round(v * 10) / 10;

class Stop extends Error {}
function check(id) { if (id !== runId || !running) throw new Stop(); }

// 사람이 화면에 보일 때까지 기다림
async function waitPerson(id, title) {
  while (performance.now() - seenAt > 400) {
    camMsg(title, '몸이 화면에 다 보이게 서 주세요');
    await wait(200); check(id);
  }
}

// 준비 카운트다운 (중간에 사람이 사라지면 처음부터)
async function prepCountdown(id, title, sub) {
  for (;;) {
    let ok = true;
    for (let i = PREP_SEC; i > 0; i--) {
      camMsg(title(i), sub);
      countdownEl.textContent = i;
      for (let t = 0; t < 5; t++) {
        await wait(200); check(id);
        if (performance.now() - seenAt > 1200) { ok = false; break; }
      }
      if (!ok) break;
    }
    countdownEl.textContent = '';
    if (ok) return;
    await waitPerson(id, '사람이 보이지 않아요');
  }
}

// 5초 동안 값 모으기
async function collect(id, title) {
  samples = [];
  countdownEl.classList.add('rec');
  try {
    for (let i = MEASURE_SEC; i > 0; i--) {
      camMsg(title, '움직이지 말고 그대로 있어 주세요');
      countdownEl.textContent = i;
      await wait(1000); check(id);
    }
    return samples;
  } finally {
    samples = null;
    countdownEl.textContent = '';
    countdownEl.classList.remove('rec');
  }
}

async function runPhase(id, kind) {
  const front = kind === 'front';
  const name = front ? '정면' : '측면';
  setPhase(kind);
  for (;;) {
    await waitPerson(id, front ? '정면을 보고 서 주세요' : '옆으로 돌아서 주세요');
    await prepCountdown(id, i => `${i}초 뒤 ${name} 측정을 시작해요`,
      front ? '정면을 보고 편하게 서 주세요' : '옆으로 돌아서 귀와 어깨가 보이게 해 주세요');
    const list = await collect(id, `${name} ${MEASURE_SEC}초 측정 중`);
    if (front) {
      const shoulder = average(list, 'shoulder');
      const pelvis = average(list, 'pelvis');
      if (shoulder !== null && pelvis !== null) {
        frontResult = { shoulder: round1(shoulder), pelvis: round1(pelvis) };
        return;
      }
      camMsg('어깨나 골반이 잘 안 보였어요', '한 걸음 뒤로 가 주세요. 곧 다시 측정해요');
    } else {
      const neck = average(list, 'neck');
      if (neck !== null) return round1(neck);
      camMsg('귀와 어깨가 잘 안 보였어요', '옆으로 서 주세요. 곧 다시 측정해요');
    }
    await wait(3000); check(id);
  }
}

async function autoMeasure() {
  const id = ++runId;
  auto = true;
  try {
    await runPhase(id, 'front');
    camMsg('정면 측정 완료!', `어깨 ${fmt(frontResult.shoulder)} · 골반 ${fmt(frontResult.pelvis)} · 이제 옆으로 돌아서 주세요`);
    await wait(2000); check(id);
    const neck = await runPhase(id, 'side');

    const result = { date: localDate(), neck, ...frontResult };
    result.score = getTotalScore(result);
    saveLatest(result);
    camMsg('측정 완료!', '리포트로 이동해요');
    await wait(1200); check(id);
    location.hash = '#report';
  } catch (err) {
    if (!(err instanceof Stop)) console.error(err);
  } finally {
    if (id === runId) auto = false;
  }
}

// 버튼: 처음부터 다시 측정
startBtn.addEventListener('click', () => {
  if (!running) { startCamera().then(() => running && autoMeasure()); return; }
  resetMeasure();
  autoMeasure();
});

// ---------- 화면 전환 ----------
// #measure 들어오면 켜고 처음부터, 다른 화면 가면 끄기
document.addEventListener('pagechange', e => {
  if (e.detail === 'measure') {
    resetMeasure();
    startCamera().then(() => {
      if (location.hash !== '#measure') { stopCamera(); return; }   // 카메라 켜지는 동안 다른 화면으로 갔으면 끄기
      if (running) autoMeasure();
    });
  } else {
    resetMeasure();   // 진행 중이던 자동 측정 멈춤
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
    if (Math.abs(v) < 0.5) return '거의 수평';
    return v > 0 ? '오른쪽 낮음' : '왼쪽 낮음';
  }

  function cardHTML(key, value) {
    const c = CRITERIA[key];
    if (!hasValue(value)) {
      return `
      <article class="result-card">
        <div class="result-top"><h2>${c.name}</h2><i class="badge none">측정 안 됨</i></div>
        <div class="result-mid"><strong class="result-value">--°</strong><span>참고 범위 ${c.good}° 미만</span></div>
        <p>몸이 화면에 다 안 나오면 측정되지 않아요.</p>
      </article>`;
    }
    const level = getLevel(key, value);
    const dir = direction(key, value);
    const rest = Math.max(2, c.warn - c.good);
    const max = c.warn + rest;
    const pos = Math.min(100, Math.abs(value) / max * 100);
    return `
      <article class="result-card">
        <div class="result-top"><h2>${c.name}</h2><i class="badge ${level.cls}">${level.text}</i></div>
        <div class="result-mid"><strong class="result-value">${Math.abs(value).toFixed(1)}°${dir ? `<small>${dir}</small>` : ''}</strong><span>참고 범위 ${c.good}° 미만</span></div>
        <div class="level-bar"><span style="flex:${c.good}" class="g"></span><span style="flex:${c.warn - c.good}" class="w"></span><span style="flex:${rest}" class="c"></span><i style="left:${pos}%"></i></div>
        <p>${c.view} · ${c.desc}</p>
        ${c.source ? `<details class="src"><summary>이 기준은 어디서 왔나요?</summary><p>${c.source.text}</p><a href="${c.source.url}" target="_blank" rel="noopener">출처: ${c.source.name}</a></details>` : ''}
      </article>`;
  }

  // 가장 신경 쓸 항목을 한 줄로
  function summary(latest) {
    const keys = KEYS().filter(k => hasValue(latest[k]));
    if (!keys.length) return '측정된 항목이 없어요';
    const worst = keys.reduce((a, b) => getLevel(b, latest[b]).i > getLevel(a, latest[a]).i ? b : a);
    const lv = getLevel(worst, latest[worst]);
    if (lv.i === 0) return '세 항목 모두 참고 범위 안이에요';
    return (LEVEL_SENTENCE[worst] || [])[lv.i] || `${CRITERIA[worst].name}: ${lv.text}`;
  }

  // 항목별 결과 접기·펼치기
  const foldBtn = $('fold-btn');
  foldBtn.addEventListener('click', () => {
    const open = foldBtn.getAttribute('aria-expanded') !== 'true';
    foldBtn.setAttribute('aria-expanded', String(open));
    $('result-list').hidden = !open;
  });

  function render() {
    const latest = getLatest();

    if (!latest) {
      $('report-date').textContent = '아직 측정 결과가 없어요';
      $('score-msg').textContent = '측정하고 내 자세를 확인해요';
      $('sum-cells').innerHTML = '';
      $('score-diff').innerHTML = '<a href="#measure">측정하러 가기 →</a>';
      $('result-list').innerHTML = '';
      saveBtn.disabled = true;
      saveBtn.textContent = '측정하면 기록할 수 있어요';
      return;
    }

    $('report-date').textContent = `${shortDate(latest.date)} · 정면·측면 각 5초 평균`;
    $('score-msg').textContent = summary(latest);

    // 지난번(다른 날 기록)과 각도 비교
    const prev = groupByDate(getRecords()).filter(g => g.date < latest.date).pop();
    const short = { neck: '거북목', shoulder: '어깨', pelvis: '골반' };
    $('sum-cells').innerHTML = KEYS().map(k => {
      const v = latest[k];
      let diff = '';
      if (prev && hasValue(v) && hasValue(prev[k])) {
        const d = Math.abs(v) - Math.abs(prev[k]);
        diff = Math.abs(d) < 0.5 ? '<em>비슷해요</em>' : `<em class="${d < 0 ? 'down' : 'up'}">${d < 0 ? '▼' : '▲'} ${Math.abs(d).toFixed(1)}°</em>`;
      }
      return `<div><span>${short[k] || CRITERIA[k].name}</span><b>${hasValue(v) ? Math.abs(v).toFixed(1) + '°' : '--'}</b>${diff}</div>`;
    }).join('');

    const next = shortDate(addDays(latest.date, REMEASURE_DAYS));
    $('score-diff').textContent = prev
      ? `${shortDate(prev.date)} 측정과 비교했어요 · 다음 측정은 4주 뒤 ${next}쯤 추천`
      : `첫 측정이에요 · 4주 동안 스트레칭하고 ${next}쯤 다시 재서 비교해 보세요`;

    $('result-list').innerHTML = KEYS().map(k => cardHTML(k, latest[k])).join('');

    renderCombos(latest);

    const sameDay = getRecords().filter(r => r.date === latest.date).length;
    saveBtn.disabled = false;
    saveBtn.textContent = latest.saved ? '내 기록 보기 →'
      : sameDay ? '오늘 기록에 합쳐 저장하고 보기 →' : '저장하고 기록 보기 →';
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
      <article class="combo-card">
        <div class="combo-keys">${r.keys.map(k => `<i class="badge ${getLevel(k, latest[k]).cls}">${CRITERIA[k].name} ${Math.abs(latest[k]).toFixed(1)}°</i>`).join('<span aria-hidden="true">+</span>')}</div>
        <h3>${r.title}</h3>
        <p><b>왜 같이 보나요?</b> ${r.why}</p>
        <p class="muted">${r.habit}</p>
        <ul class="dot-list">${r.care.map(t => `<li>${t}</li>`).join('')}</ul>
      </article>`);
    if (badCount >= combos.many.min) {
      cards.push(`
      <article class="combo-card combo-many">
        <h3>${combos.many.title}</h3>
        <p>${combos.many.why}</p>
        <ul class="dot-list">${combos.many.care.map(t => `<li>${t}</li>`).join('')}</ul>
      </article>`);
    }
    wrap.hidden = cards.length === 0;
    $('combo-notice').textContent = combos.notice;
    box.innerHTML = cards.join('');
  }

  saveBtn.addEventListener('click', () => {
    const latest = getLatest();
    if (!latest) return;
    if (!latest.saved) {
      const { saved, ...record } = latest;
      saveRecord(record);
      saveLatest({ ...latest, saved: true });
    }
    location.hash = '#history';
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

  // 양호 범위(0~기준값)를 연한 초록으로 칠하고, 마지막 값을 말풍선으로
  const goodBand = {
    id: 'goodBand',
    beforeDatasetsDraw(c) {
      const { ctx, chartArea: a, scales: { y } } = c;
      const good = CRITERIA[key].good;
      const top = Math.max(a.top, y.getPixelForValue(good));
      ctx.save();
      ctx.fillStyle = '#EFF9F5';
      ctx.fillRect(a.left, top, a.right - a.left, a.bottom - top);
      ctx.fillStyle = '#368872';
      ctx.font = '11px "Noto Sans KR", sans-serif';
      ctx.fillText(`참고 범위 ${good}° 미만`, a.left + 6, a.bottom - 6);
      ctx.restore();
    },
    afterDatasetsDraw(c) {
      const meta = c.getDatasetMeta(0);
      const data = c.data.datasets[0].data;
      let i = data.length - 1;
      while (i >= 0 && data[i] === null) i--;
      if (i < 0) return;
      const pt = meta.data[i];
      const text = `${data[i].toFixed(1)}°`;
      const { ctx } = c;
      ctx.save();
      ctx.font = 'bold 13px "Noto Sans KR", sans-serif';
      const w = ctx.measureText(text).width + 24, h = 26;
      const x = Math.min(c.chartArea.right - w, pt.x - w / 2), y = Math.max(c.chartArea.top, pt.y - h - 12);
      ctx.fillStyle = '#1D5FD1';
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 9); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
      ctx.fillText(text, x + 12, y + h / 2 + 1);
      ctx.restore();
    }
  };

  const md = d => `${+d.slice(5, 7)}.${+d.slice(8, 10)}`;

  function drawChart(records) {
    if (typeof Chart === 'undefined') return;   // Chart.js 못 불러왔을 때
    const byDate = groupByDate(records).slice(-7);
    const labels = byDate.map(r => String(+r.date.slice(8, 10)));
    const values = byDate.map(r => hasValue(r[key]) ? Math.abs(r[key]) : null);   // 예전 기록은 빈칸
    const last = values.length - 1;
    document.getElementById('chart-range').textContent =
      byDate.length > 1 ? `${md(byDate[0].date)} – ${md(byDate[last].date)} · 최근 ${byDate.length}회` : `${md(byDate[0].date)} · 1회`;

    if (chart) chart.destroy();
    document.querySelector('.chart-wrap').classList.add('has-chart');
    chart = new Chart(document.getElementById('chart'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values, borderColor: '#1D5FD1', borderWidth: 2.5, tension: 0.25, spanGaps: true,
          pointRadius: values.map((_, i) => i === last ? 5 : 3.5),
          pointBackgroundColor: values.map((_, i) => i === last ? '#1D5FD1' : '#fff'),
          pointBorderColor: '#1D5FD1', pointBorderWidth: 2,
          fill: true, backgroundColor: 'rgba(29,95,209,.06)'
        }]
      },
      options: {
        maintainAspectRatio: false,
        layout: { padding: { top: 30 } },
        scales: {
          y: { beginAtZero: true, grace: '15%', border: { display: false }, grid: { color: '#E8EFF7' },
               ticks: { color: '#8C9CB1', font: { size: 11 }, maxTicksLimit: 5, callback: v => `${v}°` } },
          x: { border: { display: false }, grid: { display: false },
               ticks: { color: ctx => ctx.index === last ? '#1D5FD1' : '#8C9CB1', font: ctx => ({ size: 11, weight: ctx.index === last ? 'bold' : 'normal' }) } }
        },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.parsed.y.toFixed(1)}°` } } }
      },
      plugins: [goodBand]
    });

    // 지난번과 비교
    const trend = document.getElementById('trend');
    const vals = values.filter(v => v !== null);
    if (vals.length >= 2) {
      const d = vals[vals.length - 1] - vals[vals.length - 2];
      trend.hidden = false;
      trend.textContent = Math.abs(d) < 0.5 ? '→  지난번과 거의 같아요 (0.5° 이내는 측정 오차일 수 있어요)'
        : d < 0 ? `↘  지난번보다 ${Math.abs(d).toFixed(1)}° 줄었어요` : `↗  지난번보다 ${d.toFixed(1)}° 늘었어요`;
    } else {
      trend.hidden = false;
      trend.textContent = '4주 동안 스트레칭하고 다시 재면 변화가 보여요';
    }
  }

  function render() {
    const records = getRecords();
    titleEl.textContent = `${CRITERIA[key].name} 각도`;

    if (records.length === 0) {
      if (chart) { chart.destroy(); chart = null; }
      document.querySelector('.chart-wrap').classList.remove('has-chart');
      document.getElementById('chart-range').textContent = '기록이 쌓이면 그래프가 그려져요';
      document.getElementById('trend').hidden = true;
      listEl.innerHTML = '<li class="empty">아직 기록이 없어요. 측정하고 리포트에서 <b>기록 저장</b>을 눌러 보세요.</li>';
      return;
    }

    drawChart(records);

    const days = groupByDate(records);
    const sorted = sortEl.value === 'old' ? days : [...days].reverse();

    listEl.innerHTML = '';
    sorted.forEach(r => {
      const li = document.createElement('li');
      const others = Object.keys(CRITERIA).filter(k => k !== key && hasValue(r[k]))
        .map(k => `${{ neck: '거북목', shoulder: '어깨', pelvis: '골반' }[k] || CRITERIA[k].name} ${Math.abs(r[k]).toFixed(1)}°`).join(' · ');
      const lv = getLevel(key, r[key]);
      li.innerHTML = `
        <div class="rec-main"><b>${+r.date.slice(5, 7)}월 ${+r.date.slice(8, 10)}일${r.count > 1 ? ` <small>${r.count}회 평균</small>` : ''}</b><span>${others || '다른 항목 없음'}</span></div>
        <div class="rec-val"><b>${hasValue(r[key]) ? Math.abs(r[key]).toFixed(1) + '°' : '--'}</b><span class="lv-${lv.cls}">${lv.text}</span></div>
        <i class="ico i-chev-right" aria-hidden="true"></i>`;
      // 상세보기: 그 기록을 리포트로 보여주기
      li.addEventListener('click', () => {
        const { count, ...day } = r;
        saveLatest({ ...day, saved: true });
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
// 1. (이미지) guide.json의 image에 pages/asset/ 그림 경로 넣기
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

  function cardHTML(g, levels, i, total) {
    const key = levels ? worstKey(g, levels) : g.keys[0];
    const c = CRITERIA[key];
    const level = levels ? levels[key] : null;
    const badge = level && level.cls !== 'none'
      ? `<i class="badge ${level.cls}">${c.name} · ${level.text}</i>`
      : `<i class="badge good">${g.keys.map(k => CRITERIA[k].name).join(' · ')}</i>`;
    const img = g.image ? `<img src="${g.image}" alt="${g.title} 동작" loading="lazy">` : '동작 그림';
    return `
      <article class="stretch-card">
        <div class="stretch-fig">${img}${badge}</div>
        ${g.video ? `<div class="stretch-video" hidden></div>` : ''}
        <div class="stretch-body">
          <h3><span class="order">${i + 1}</span>${g.title}<small>${i + 1} / ${total}</small></h3>
          <p>${g.how}</p>
          ${g.caution ? `<p>${g.caution}</p>` : ''}
          <p class="stretch-count"><span>횟수</span>${g.count}</p>
          <div class="stretch-actions">
            ${g.video
              ? `<button type="button" class="video-btn" data-inline-yt="${g.video.youtube}" data-title="${g.video.title}" data-by="${g.video.by}${g.video.year ? ' · ' + g.video.year + '년' : ''}">▶ 관련 영상 보기</button>`
              : `<button type="button" class="video-btn" disabled>영상 준비 중</button>`}
            <button type="button" class="done-btn${doneToday().includes(g.title) ? ' on' : ''}" data-done="${g.title}" aria-pressed="${doneToday().includes(g.title)}">${doneToday().includes(g.title) ? '✓ 오늘 했어요' : '오늘 했어요'}</button>
          </div>
          ${g.source ? `<span class="stretch-src">출처: ${g.sourceUrl ? `<a href="${g.sourceUrl}" target="_blank" rel="noopener">${g.source}</a>` : g.source}</span>` : ''}
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
        <i class="ico i-part-${p.id}" aria-hidden="true"></i>${p.name}${p.id === selectedPart ? '<i class="ico i-check" aria-hidden="true"></i>' : ''}
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
      if (!latest || !hasValue(latest[k])) return `<li><span>${c.name}</span><span class="note">아직 측정 안 됨</span></li>`;
      const lv = getLevel(k, latest[k]);
      return `<li><span>${c.name}</span><span><b>${Math.abs(latest[k]).toFixed(1)}°</b> <i class="badge ${lv.cls}">${lv.text}</i></span></li>`;
    }).join('');

    partBox.innerHTML = `
      <h3>${p.name} · ${p.feel}</h3>
      <p>${p.relation}</p>
      <p class="note">${parts.notice}</p>
      <h4>내 측정 결과 중 관련 항목</h4>
      <ul class="part-mine">${mine}</ul>
      ${latest ? '' : '<a href="#measure" class="btn btn-soft">측정하고 내 결과 보기</a>'}
      <h4>생활 습관 팁</h4>
      <ul class="dot-list">${p.tips.map(t => `<li>${t}</li>`).join('')}</ul>

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
  // 홈 슬라이드에서 부위를 누르면 그 부위가 선택된 채로 가이드가 열림
  document.addEventListener('selectpart', e => { selectedPart = e.detail; });

  // 스트레칭 목록: 번호(1, 2, 3…)와 전체 개수
  let shown = [];
  function showList(list, levels) {
    shown = list;
    try {   // 오늘 추천 개수 저장 → 달력에서 '일부만 함' 판단
      const plan = JSON.parse(localStorage.getItem('poseai_plan') || '{}');
      plan[todayStr()] = list.length;
      localStorage.setItem('poseai_plan', JSON.stringify(plan));
    } catch (e) {}
    listEl.innerHTML = list.map((g, i) => cardHTML(g, levels, i, list.length)).join('');
    document.getElementById('stretch-count').textContent = `${list.length}개`;
    renderToday();
  }

  // ----- 오늘의 스트레칭 체크 (매일 들어올 이유) -----
  // 측정은 4주에 한 번, 스트레칭은 매일 → 한 동작이라도 하면 그날은 '한 날'
  const DONE_KEY = 'poseai_done';
  const todayStr = () => localDate();
  function doneMap() { try { return JSON.parse(localStorage.getItem(DONE_KEY) || '{}'); } catch (e) { return {}; } }
  function doneToday() { return doneMap()[todayStr()] || []; }
  function streak() {
    const m = doneMap();
    let d = todayStr(), n = 0;
    if (!(m[d] || []).length) d = addDays(d, -1);   // 오늘 아직 안 했으면 어제부터 셈
    while ((m[d] || []).length) { n++; d = addDays(d, -1); }
    return n;
  }
  function renderToday() {
    const box = document.getElementById('stretch-today');
    if (!box || !shown.length) return;
    const done = shown.filter(g => doneToday().includes(g.title)).length;
    const st = streak();
    // 이번 주(월~일) 한 날 표시
    const t = todayStr(), status = stretchStatus();
    const now = new Date(t + 'T00:00:00');
    const mon = addDays(t, -((now.getDay() + 6) % 7));
    const week = ['월', '화', '수', '목', '금', '토', '일'].map((w, i) => {
      const d = addDays(mon, i);
      const stt = status(d).cls;
      const cls = d > t ? 'future' : stt;
      return `<span class="${cls}${d === t ? ' today' : ''}"><i>${+d.slice(8, 10)}</i>${w}</span>`;
    }).join('');
    box.innerHTML = `<div><b>오늘 ${done} / ${shown.length} 완료</b><span>${st ? `${st}일 연속으로 하고 있어요` : '오늘 첫 스트레칭을 해 보세요'}</span></div>
      <i class="bar"><i style="width:${done / shown.length * 100}%"></i></i>
      <div class="week">${week}</div>
      ${(() => { const nm = nextMeasure(); return nm ? `<p class="next-m">다음 측정까지 <b>${dday(nm.left)}</b> · ${shortDate(nm.date)}${nm.left <= 0 ? ' · <a href="#measure">지금 측정하기 →</a>' : ''}</p>` : ''; })()}
      <a href="#history" class="cal-link">스트레칭 달력 보기 →</a>`;
    box.classList.toggle('all', done === shown.length);
  }
  listEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-done]');
    if (!btn) return;
    const m = doneMap(), t = todayStr(), list = m[t] || [];
    const on = !list.includes(btn.dataset.done);
    m[t] = on ? [...list, btn.dataset.done] : list.filter(x => x !== btn.dataset.done);
    try { localStorage.setItem(DONE_KEY, JSON.stringify(m)); } catch (err) {}
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on);
    btn.textContent = on ? '✓ 오늘 했어요' : '오늘 했어요';
    renderToday();
  });

  // 카드 안에서 바로 영상 재생 (스크롤 안 내려도 됨)
  listEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-inline-yt]');
    if (!btn) return;
    const box = btn.closest('.stretch-card').querySelector('.stretch-video');
    if (!box.hidden) {                       // 다시 누르면 닫기
      box.hidden = true; box.innerHTML = '';
      btn.textContent = '▶ 관련 영상 보기';
      btn.classList.remove('on');
      return;
    }
    box.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${btn.dataset.inlineYt}?autoplay=1&rel=0" title="${btn.dataset.title}"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
      <p>${btn.dataset.title} · ${btn.dataset.by || ''} · <a href="https://www.youtube.com/watch?v=${btn.dataset.inlineYt}" target="_blank" rel="noopener">유튜브에서 보기</a></p>`;
    box.hidden = false;
    btn.textContent = '영상 닫기 ✕';
    btn.classList.add('on');
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  function render() {
    if (!guides || !CRITERIA) return;
    const latest = getLatest();
    renderParts();

    if (!latest) {
      descEl.textContent = '아직 측정 결과가 없어서 전체 스트레칭을 보여 드려요. 측정하면 내 결과에 맞는 것만 골라 드려요.';
      showList(guides, null);
      return;
    }

    // 주의 이상인 항목만
    const levels = {};
    Object.keys(CRITERIA).forEach(k => { levels[k] = getLevel(k, latest[k]); });
    const bad = k => levels[k].cls === 'warn' || levels[k].cls === 'check';
    const need = guides.filter(g => g.keys.some(bad));

    if (need.length === 0) {
      descEl.textContent = '최근 측정에서 모두 참고 범위 안이었어요. 지금 자세를 유지하는 데 도움이 되는 스트레칭이에요.';
      showList(guides, levels);
    } else {
      descEl.textContent = `최근 측정(${shortDate(latest.date)})에서 참고 범위를 벗어난 항목에 맞춘 스트레칭이에요. 위에서부터 순서대로 해 보세요.`;
      showList(need, levels);
    }
  }

  // 기준표(criteria.json)까지 불러온 다음 그리기
  Promise.all([fetch('data/guide.json').then(res => res.json()), criteriaReady])
    .then(([data]) => { guides = data; render(); })
    .catch(() => { descEl.textContent = '스트레칭 데이터를 불러오지 못했어요.'; });

  document.addEventListener('pagechange', e => {
    if (e.detail === 'guide') render();
  });
  document.querySelectorAll('[data-jump]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
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
          <div>
            <b>${h.yadmNm || ''}</b>
            <span>${h.clCdNm ? h.clCdNm + ' · ' : ''}${h.addr || ''}</span>
          </div>
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
      const dir = k === 'neck' ? '' : (v > 0 ? ', 오른쪽 낮음' : v < 0 ? ', 왼쪽 낮음' : '');
      return `${CRITERIA[k].name} ${Math.abs(v).toFixed(1)}°(${lv}${dir})`;
    });
    return `사용자의 최근 측정(${latest.date}): ${parts.join(', ')}. 판정이 아니라 참고 범위 기준의 상태 설명이야.`;
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
    let res;
    try {
      res = await fetch(AI_RELAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, context: measureContext(), model: currentModel })
      });
    } catch (e) {
      throw Object.assign(new Error('network'), { detail: '중계 서버에 연결하지 못했어요.' });
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* JSON이 아니면 서버 코드 오류 */ }
    if (!data) throw Object.assign(new Error('bad'), { detail: `중계 서버가 오류를 냈어요 (${res.status}).` });
    if (!res.ok) throw Object.assign(new Error('api'), { detail: String(data.error || res.status) });
    return data;   // { answer, model }
  }

  // 오류 내용을 알기 쉬운 말로 (원인 찾기용)
  function explainAIError(err) {
    const d = String(err.detail || err.message || '');
    const low = d.toLowerCase();
    if (err.message === 'network') return ['인터넷이나 중계 서버(Cloudflare) 연결 문제예요.', 'Cloudflare 주소가 맞는지, ALLOW_ORIGIN이 내 사이트 주소인지 확인해 주세요.'];
    if (err.message === 'bad') return ['중계 서버 코드에서 오류가 났어요.', 'Cloudflare에 최신 worker.js를 붙여넣고 배포했는지 확인해 주세요.'];
    if (low.includes('key 없음') || low.includes('키가 설정')) return ['중계 서버에 AI 키가 없어요.', 'Cloudflare 설정 → 변수 및 비밀에 GEMINI_KEY / OPENAI_KEY를 넣어 주세요.'];
    if (low.includes('api key') || low.includes('api_key') || low.includes('invalid') || low.includes('unauthenticated') || low.includes('401')) return ['AI 키가 맞지 않아요.', '키를 다시 복사해서 넣거나, 키를 준 곳에 사용 가능한지 물어봐 주세요.'];
    if (low.includes('quota') || low.includes('insufficient') || low.includes('billing') || low.includes('429') || low.includes('rate')) return ['AI 사용량 한도를 넘었거나 결제가 필요한 상태예요.', '잠시 뒤 다시 하거나 다른 모델을 골라 주세요.'];
    if (low.includes('permission') || low.includes('403') || low.includes('denied')) return ['이 키로는 이 모델을 쓸 권한이 없어요.', '다른 모델(예: GPT-4o mini)을 골라 보세요.'];
    if (low.includes('not found') || low.includes('404') || low.includes('does not exist')) return ['고른 모델을 찾을 수 없어요.', '다른 모델을 골라 보세요.'];
    return ['AI 답변을 불러오지 못했어요.', '잠시 후 다시 해 보거나 다른 모델을 골라 주세요.'];
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
      const [why, how] = explainAIError(err);
      thinking.textContent = `${why} ${how}`;
      // 실제 오류 문장 (캡처해서 원인 찾을 때 쓰기)
      const meta = document.createElement('span');
      meta.className = 'ans-meta';
      meta.textContent = `오류: ${String(err.detail || err.message).slice(0, 160)}`;
      thinking.appendChild(meta);
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

const PAGES = ['home', 'measure', 'report', 'history', 'guide', 'focus', 'faq', 'login', 'signup'];

function showPage() {
  const id = location.hash.replace('#', '');
  const page = PAGES.includes(id) ? id : 'home';

  document.body.dataset.page = page;
  document.querySelectorAll('.page').forEach(sec => {
    sec.classList.toggle('active', sec.dataset.page === page);
  });
  document.querySelectorAll('.sidebar-nav a:not([data-scroll])').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === '#' + page);
  });
  // 모바일 아래 탭바 (리포트는 '측정', 로그인·회원가입은 '기록' 탭에 불 켜기)
  const tabPage = { report: 'measure', login: 'history', signup: 'history', faq: 'home', focus: 'home' }[page] || page;
  document.querySelectorAll('.tabbar a').forEach(a => {
    const on = a.getAttribute('href') === '#' + tabPage;
    a.classList.toggle('active', on);
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
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
   8. 회원가입·로그인 (Firebase)
   - Authentication: 아이디 + 비밀번호 (안에서는 아이디@poseai.app 이메일로 처리, 사용자에겐 아이디만 보임)
   - Firestore: users/{uid} 에 아이디·닉네임, users/{uid}/records/{저장 시각} 에 측정 기록
   - 보안 규칙으로 로그인한 본인만 자기 기록을 읽고 쓸 수 있음
   - 로그인 안 해도 측정·기록은 이 브라우저(LocalStorage)에 저장되고, 로그인하면 계정으로 옮겨짐
   ===================================================================== */
// Firebase 콘솔 → 프로젝트 설정 → 내 앱 → SDK 설정 및 구성 에 나오는 값 (사이트에 공개돼도 되는 값)
const firebaseConfig = {
  apiKey: 'AIzaSyDjQKjiMjGZZlr8iO7NsO7_4W1rlVOob98',
  authDomain: 'poseai-facc5.firebaseapp.com',
  projectId: 'poseai-facc5',
  storageBucket: 'poseai-facc5.firebasestorage.app',
  messagingSenderId: '517420913046',
  appId: '1:517420913046:web:2a68f951c7535ceba38db7'
};

const FB_VER = '10.12.2';
const ID_DOMAIN = '@poseai.app';
const USER_KEY = 'poseai_user';

function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; }
}

// Firebase는 필요할 때 불러옴 (CDN이 안 돼도 나머지 기능은 그대로 동작)
let fb = null;
async function loadFirebase() {
  if (fb) return fb;
  if (!firebaseConfig) throw new Error('아직 Firebase가 연결되지 않았어요');
  const base = `https://www.gstatic.com/firebasejs/${FB_VER}`;
  const [appMod, authMod, dbMod] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`)
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  fb = { auth: authMod.getAuth(app), db: dbMod.getFirestore(app), A: authMod, D: dbMod };
  return fb;
}

// Firebase 오류 → 알기 쉬운 말
function authMessage(err) {
  const code = err && err.code || '';
  if (code.includes('email-already-in-use')) return '이미 있는 아이디예요. 다른 아이디를 써 주세요.';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return '아이디나 비밀번호가 맞지 않아요.';
  if (code.includes('weak-password')) return '비밀번호는 6자 이상으로 써 주세요.';
  if (code.includes('too-many-requests')) return '시도가 너무 많아요. 잠시 후 다시 해 주세요.';
  if (code.includes('network')) return '인터넷 연결을 확인해 주세요.';
  return err.message || '잠시 후 다시 시도해 주세요.';
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
    $('sidebar-sub').textContent = user ? `아이디 ${user.id} · 기록이 계정에 저장돼요` : '지금은 게스트로 이용 중이에요';
    $('sidebar-login').hidden = !!user;
    $('sidebar-logout').hidden = !user;

    $('sync-title').textContent = user ? `${user.nickname}님의 기록은 계정에 저장돼요` : '기록 동기화는 로그인이 필요해요';
    $('sync-text').textContent = user
      ? '같은 아이디로 로그인하면 노트북·폰 어디서든 같은 기록을 볼 수 있어요.'
      : '지금 기록은 이 브라우저에만 임시로 저장돼요. 로그인하면 노트북·폰 어디서든 같은 기록을 볼 수 있어요.';
    $('sync-btn').hidden = !!user;

    renderPreview(user);
  }

  // 홈 리포트 카드: 로그인하면 내 최근 결과, 아니면 잠금
  function renderPreview(user) {
    const card = $('preview-card');
    if (!card || !CRITERIA) return;   // 홈 '내 기록' 카드는 히어로 버튼과 겹쳐서 뺌
    const latest = getLatest();
    if (!user && !latest) {   // 로그인 전 + 측정 전: 로그인 안내
      card.href = '#login';
      card.innerHTML = `<span><b>내 기록</b><small>로그인하고 최근 결과를 확인해요</small></span><em>로그인 →</em>`;
      return;
    }
    if (!latest) {
      card.href = '#measure';
      card.innerHTML = `<span><b>${user.nickname}님의 기록</b><small>아직 측정 기록이 없어요</small></span><em>첫 측정 →</em>`;
      return;
    }
    const short = { neck: '거북목', shoulder: '어깨', pelvis: '골반' };
    const line = Object.keys(CRITERIA).filter(k => hasValue(latest[k])).map(k => `${short[k] || CRITERIA[k].name} ${Math.abs(latest[k]).toFixed(1)}°`).join(' · ');
    card.href = '#report';
    card.innerHTML = `<span><b>${user ? user.nickname + '님의 최근 기록' : '최근 기록'} · ${md2(latest.date)}</b><small>${line}</small></span>
      <span class="score">${latest.score}<small>점</small></span>`;
  }
  const md2 = d => `${+d.slice(5, 7)}.${+d.slice(8, 10)}`;

  // ----- Firestore 저장 -----
  // 문서 이름 = 저장 시각 → 같은 기록을 여러 번 올려도 하나만 남음
  async function putRecords(uid, records) {
    const { db, D } = await loadFirebase();
    await Promise.all(records.map(r => {
      const { saved, ...rec } = r;
      return D.setDoc(D.doc(db, 'users', uid, 'records', String(rec.savedAt).replace(/\//g, '-')), rec);
    }));
  }

  // 이 브라우저 기록 ↔ 계정 기록 합치기
  async function sync(uid) {
    const { db, D } = await loadFirebase();
    const local = getRecords().map((r, i) => ({ ...r, savedAt: r.savedAt || `${r.date}T00:00:0${i % 10}.local${i}` }));
    if (local.length) await putRecords(uid, local);
    const snap = await D.getDocs(D.collection(db, 'users', uid, 'records'));
    const map = new Map();
    local.forEach(r => map.set(String(r.savedAt), r));
    snap.forEach(d => map.set(String(d.data().savedAt), d.data()));
    const merged = [...map.values()].sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
    localStorage.setItem(RECORD_KEY, JSON.stringify(merged));
    if (!getLatest() && merged.length) saveLatest({ ...merged[merged.length - 1], saved: true });
  }

  function refreshPage() {
    const page = location.hash.replace('#', '') || 'home';
    document.dispatchEvent(new CustomEvent('pagechange', { detail: page }));
  }

  // ----- 회원가입 -----
  const signupForm = $('signup-form');
  signupForm.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = signupForm.querySelector('.form-msg');
    const id = $('signup-id').value.trim().toLowerCase();
    const nickname = $('signup-nick').value.trim().slice(0, 12);
    const pw = $('signup-pw').value;
    if (!/^[a-z0-9_]{3,20}$/.test(id)) { msg.textContent = '아이디는 영문·숫자·_ 3~20자로 써 주세요.'; return; }
    if (!nickname) { msg.textContent = '닉네임을 입력해 주세요.'; return; }
    if (pw.length < 6) { msg.textContent = '비밀번호는 6자 이상으로 써 주세요.'; return; }
    if (pw !== $('signup-pw2').value) { msg.textContent = '비밀번호 확인이 달라요.'; return; }
    msg.textContent = '가입하는 중이에요...';
    try {
      const { auth, db, A, D } = await loadFirebase();
      const cred = await A.createUserWithEmailAndPassword(auth, id + ID_DOMAIN, pw);
      await A.updateProfile(cred.user, { displayName: nickname });
      await D.setDoc(D.doc(db, 'users', cred.user.uid), { id, nickname, createdAt: D.serverTimestamp() });
      localStorage.setItem(USER_KEY, JSON.stringify({ uid: cred.user.uid, id, nickname }));
      await sync(cred.user.uid).catch(console.error);
      signupForm.reset();
      msg.textContent = '';
      updateUI();
      location.hash = '#history';
    } catch (err) {
      console.error(err);
      msg.textContent = authMessage(err);
    }
  });

  // ----- 로그인 -----
  const loginForm = $('login-form');
  loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = loginForm.querySelector('.form-msg');
    const id = $('login-id').value.trim().toLowerCase();
    const pw = $('login-pw').value;
    if (!id || !pw) { msg.textContent = '아이디와 비밀번호를 입력해 주세요.'; return; }
    msg.textContent = '로그인하는 중이에요...';
    try {
      const { auth, A } = await loadFirebase();
      const cred = await A.signInWithEmailAndPassword(auth, id + ID_DOMAIN, pw);
      localStorage.setItem(USER_KEY, JSON.stringify({ uid: cred.user.uid, id, nickname: cred.user.displayName || id }));
      await sync(cred.user.uid).catch(console.error);
      loginForm.reset();
      msg.textContent = '';
      updateUI();
      location.hash = '#history';
    } catch (err) {
      console.error(err);
      msg.textContent = authMessage(err);
    }
  });

  // ----- 로그아웃: 이 브라우저에 있던 내 기록도 지움 (계정에는 그대로 남아 있음) -----
  $('sidebar-logout').addEventListener('click', async () => {
    try { const { auth, A } = await loadFirebase(); await A.signOut(auth); } catch (e) { /* 연결 전이어도 로그아웃 처리 */ }
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(RECORD_KEY);
    localStorage.removeItem(LATEST_KEY);
    location.hash = '#home';
    location.reload();
  });

  // ----- 기록 저장할 때 로그인 중이면 계정에도 저장 -----
  document.addEventListener('recordsaved', e => {
    const user = getUser();
    if (!user || !firebaseConfig) return;
    putRecords(user.uid, [e.detail]).catch(err => console.error('계정 저장 실패', err));
  });

  document.addEventListener('pagechange', updateUI);

  // 처음 들어왔을 때: 로그인 상태 확인 → 계정 기록 받아오기
  criteriaReady.finally(async () => {
    updateUI();
    if (!firebaseConfig || !getUser()) return;
    try {
      const { auth, A } = await loadFirebase();
      A.onAuthStateChanged(auth, fbUser => {
        if (!fbUser) {                       // 다른 곳에서 로그아웃됐거나 만료됨
          localStorage.removeItem(USER_KEY);
          updateUI();
          return;
        }
        sync(fbUser.uid).then(refreshPage).catch(console.error);
      });
    } catch (err) {
      console.error(err);
    }
  });
})();


/* =====================================================================
   10. 맨 위로 / 맨 아래로 버튼
   - 페이지가 길면 보이고, 맨 위면 ↑, 맨 아래면 ↓가 흐려짐
   ===================================================================== */
(() => {
  const nav = document.getElementById('scroll-nav');
  const up = document.getElementById('to-top');
  const down = document.getElementById('to-bottom');
  if (!nav) return;
  const header = document.querySelector('.header');
  const update = () => {
    const y = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    header?.classList.toggle('scrolled', y > 8);   // 내리면 헤더 반투명 (자리는 그대로 고정)
    nav.classList.toggle('show', max > 200);
    up.disabled = y < 10;
    down.disabled = y > max - 10;
  };
  up.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  down.addEventListener('click', () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }));
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  document.addEventListener('pagechange', () => setTimeout(update, 80));
  new ResizeObserver(update).observe(document.body);
  update();
})();


/* =====================================================================
   11. FAQ · AI 코치 떠 있는 버튼 (포즈봇)
   - 끌어서 화면 어디로든 옮길 수 있음 (위치는 이 브라우저에 기억)
   - 누르면 채팅 창이 버튼 옆에 열림 (FAQ 화면의 채팅을 그대로 옮겨 와서 씀)
   ===================================================================== */
(() => {
  const fab = document.getElementById('faq-fab');
  const pop = document.getElementById('chat-pop');
  const popBody = document.getElementById('chat-pop-body');
  const card = document.getElementById('chat-card');
  const home = document.getElementById('chat-home');
  if (!fab || !pop || !card) return;
  const POS_KEY = 'poseai_fab_pos';
  const isMobile = () => true;   // 모바일 전용 화면

  // ----- 위치 -----
  function place(x, y) {
    const w = fab.offsetWidth, h = fab.offsetHeight;
    const bottomGap = isMobile() ? 72 : 8;                // 폰에서는 아래 탭바를 가리지 않게
    const col = document.body.getBoundingClientRect();   // 폰 폭(430px) 안에서만 움직이게
    x = Math.min(Math.max(col.left + 8, x), col.right - w - 8);
    y = Math.min(Math.max(8, y), window.innerHeight - h - bottomGap);
    fab.style.left = x + 'px'; fab.style.top = y + 'px';
    fab.style.right = 'auto'; fab.style.bottom = 'auto';
    fab.classList.toggle('tip-right', x < window.innerWidth / 2);   // 왼쪽에 있으면 말풍선을 오른쪽에
  }
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (saved) place(saved.x * window.innerWidth, saved.y * window.innerHeight);
  } catch (e) { /* 저장 안 돼도 기본 위치 */ }

  // ----- 끌기 (마우스·터치 같이) -----
  let start = null, moved = false;
  fab.addEventListener('pointerdown', e => {
    const r = fab.getBoundingClientRect();
    start = { px: e.clientX, py: e.clientY, x: r.left, y: r.top };
    moved = false;
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener('pointermove', e => {
    if (!start) return;
    const dx = e.clientX - start.px, dy = e.clientY - start.py;
    if (!moved && Math.hypot(dx, dy) < 6) return;   // 조금 움직인 건 클릭으로
    moved = true;
    fab.classList.add('dragging');
    place(start.x + dx, start.y + dy);
    if (!pop.hidden) placePop();
  });
  fab.addEventListener('pointerup', () => {
    if (!start) return;
    start = null;
    fab.classList.remove('dragging');
    if (moved) {
      const r = fab.getBoundingClientRect();
      try { localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left / window.innerWidth, y: r.top / window.innerHeight })); } catch (e) {}
    } else {
      toggle();
    }
  });
  // 키보드(Enter·Space)로도 열기
  fab.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  window.addEventListener('resize', () => {
    const r = fab.getBoundingClientRect();
    if (fab.style.left) place(r.left, r.top);
    if (!pop.hidden) placePop();
  });

  // ----- 채팅 창 -----
  function placePop() {
    if (isMobile()) { pop.style.left = ''; pop.style.top = ''; return; }   // 폰에서는 CSS로 아래에서 올라오는 창
    const r = fab.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight, W = window.innerWidth, H = window.innerHeight;
    let x, y;
    if (r.top - ph - 12 >= 12) {                          // 1) 버튼 위에 자리가 있으면 위로
      y = r.top - ph - 12;
      x = r.right - pw;
    } else if (r.bottom + 12 + ph <= H - 12) {            // 2) 아래에 자리가 있으면 아래로
      y = r.bottom + 12;
      x = r.right - pw;
    } else {                                              // 3) 둘 다 없으면 버튼 옆으로 (버튼을 가리지 않게)
      y = r.bottom - ph;
      x = r.left - pw - 12 >= 12 ? r.left - pw - 12 : r.right + 12;
    }
    pop.style.left = Math.min(Math.max(12, x), W - pw - 12) + 'px';
    pop.style.top = Math.min(Math.max(12, y), H - ph - 12) + 'px';
  }
  function open() {
    // FAQ 화면에 있으면 창 대신 채팅 위치로 스크롤
    if (location.hash === '#faq') { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    popBody.appendChild(card);
    pop.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    placePop();
    document.getElementById('ai-q')?.focus({ preventScroll: true });
  }
  new ResizeObserver(() => { if (!pop.hidden) placePop(); }).observe(pop);
  function close() {
    pop.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
    home.after(card);                                     // 채팅을 FAQ 화면 원래 자리로
  }
  function toggle() { pop.hidden ? open() : close(); }
  document.getElementById('chat-pop-close').addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) close(); });
  // FAQ 화면으로 가면 창을 닫고 채팅을 화면에 돌려놓음
  document.addEventListener('pagechange', e => { if (e.detail === 'faq' && !pop.hidden) close(); });
})();


/* =====================================================================
   12. 홈 탭 메뉴 (측정하기 / 내 기록 / 맞춤 가이드 / 도움말)
   - 버튼을 주제별로 묶어서 한 번에 한 탭만 보여 줌
   ===================================================================== */
(() => {
  const tabs = document.querySelectorAll('.home-tabs [data-tab]');
  if (!tabs.length) return;
  tabs.forEach(t => t.addEventListener('click', () => {
    tabs.forEach(x => {
      const on = x === t;
      x.classList.toggle('active', on);
      x.setAttribute('aria-selected', on);
      document.getElementById(x.dataset.tab).hidden = !on;
    });
  }));

  // 병원 찾기 타일 → 가이드로 가서 병원 카드까지 내려감
  document.querySelectorAll('[data-go]').forEach(a => a.addEventListener('click', () => {
    setTimeout(() => document.getElementById(a.dataset.go)?.scrollIntoView({ behavior: 'smooth' }), 400);
  }));

  const day = d => `${+d.slice(5, 7)}.${+d.slice(8, 10)}`;
  function render() {
    // 내 기록 카드: 최근 측정값
    const latest = getLatest();
    const rec = document.getElementById('home-record');
    if (latest && CRITERIA) {
      const short = { neck: '거북목', shoulder: '어깨', pelvis: '골반' };
      const line = Object.keys(CRITERIA).filter(k => hasValue(latest[k]))
        .map(k => `${short[k] || CRITERIA[k].name} ${Math.abs(latest[k]).toFixed(1)}°`).join(' · ');
      rec.innerHTML = `<b>최근 측정 · ${day(latest.date)}</b><small>${line}</small><em>기록 보기 →</em>`;
    }
    // 오늘의 스트레칭: 체크한 개수와 연속 일수
    let m = {};
    try { m = JSON.parse(localStorage.getItem('poseai_done') || '{}'); } catch (e) {}
    const iso = t => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    const today = localDate();
    const n = (m[today] || []).length;
    let d = new Date(today + 'T00:00:00'), st = 0;
    if (!n) d.setDate(d.getDate() - 1);
    while ((m[iso(d)] || []).length) { st++; d.setDate(d.getDate() - 1); }
    document.getElementById('home-today').innerHTML =
      `<b>오늘의 스트레칭</b><small>${n ? `오늘 ${n}개 했어요` : '오늘 첫 스트레칭을 해 보세요'}${st ? ` · ${st}일 연속` : ''}</small><em>하러 가기 →</em>`;
  }
  document.addEventListener('pagechange', e => { if (e.detail === 'home') render(); });
  criteriaReady.then(render);
})();


/* =====================================================================
   13. 스트레칭 달력 (기록 화면)
   - 스트레칭만 색으로: 다 함(파랑) / 일부(노랑) / 안 함(빨강)
   - 측정 일정은 '다음 측정 D-day' 카드가 따로 보여 줌
   ===================================================================== */
(() => {
  const box = document.getElementById('cal');
  if (!box) return;
  let view = new Date(); view.setDate(1);
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function render() {
    const status = stretchStatus();
    const latest = getLatest();
    const today = iso(new Date());
    // 다음 측정 추천: 마지막 측정 7~14일 뒤

    const y = view.getFullYear(), mo = view.getMonth();
    const first = (new Date(y, mo, 1).getDay() + 6) % 7;     // 월요일 시작
    const days = new Date(y, mo + 1, 0).getDate();
    let cells = '', cnt = { full: 0, part: 0, miss: 0 };
    for (let i = 0; i < first; i++) cells += '<span class="empty"></span>';
    for (let d = 1; d <= days; d++) {
      const key = iso(new Date(y, mo, d));
      const st = status(key);
      if (st.cls) cnt[st.cls]++;
      const cls = [st.cls, key === today ? 'today' : '', key > today ? 'future' : ''].join(' ');
      const tip = { full: `스트레칭 ${st.n}개 다 함`, part: `스트레칭 ${st.n} / ${st.total}개`, miss: '스트레칭 안 함' }[st.cls] || '';
      cells += `<span class="${cls}" title="${key}${tip ? ' · ' + tip : ''}"><i>${d}</i></span>`;
    }
    box.innerHTML = `
      <div class="cal-head">
        <button type="button" data-m="-1" aria-label="이전 달">‹</button>
        <b>${y}년 ${mo + 1}월</b>
        <button type="button" data-m="1" aria-label="다음 달">›</button>
      </div>
      <p class="cal-sum"><b class="s-full">다 함 ${cnt.full}일</b> · <b class="s-part">일부 ${cnt.part}일</b> · <b class="s-miss">안 함 ${cnt.miss}일</b></p>
      <div class="cal-grid">${['월', '화', '수', '목', '금', '토', '일'].map(w => `<em>${w}</em>`).join('')}${cells}</div>
      <div class="cal-legend"><span class="l-full">다 함</span><span class="l-part">일부</span><span class="l-miss">안 함</span></div>`;
  }
  box.addEventListener('click', e => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    view.setMonth(view.getMonth() + +b.dataset.m);
    render();
  });
  document.addEventListener('pagechange', e => { if (e.detail === 'history') render(); });
  render();
})();


/* =====================================================================
   14. 다음 측정 안내
   - 홈 '내 기록' 탭 카드 + 측정 화면 위 안내
   - 4주가 안 됐으면 막지는 않고 "지금 재면 변화가 잘 안 보일 수 있어요"만 알려 줌
   ===================================================================== */
(() => {
  function card() {
    const box = document.getElementById('home-next');
    if (!box) return;
    const nm = nextMeasure();
    if (!nm) { box.innerHTML = '<b>다음 측정</b><small>첫 측정을 하면 다음 측정일을 알려 드려요</small>'; return; }
    const pct = Math.min(100, Math.max(0, nm.since / REMEASURE_DAYS * 100));
    box.innerHTML = `<div class="nm-top"><b>다음 측정 ${dday(nm.left)}</b><span>${shortDate(nm.date)}</span></div>
      <i class="bar"><i style="width:${pct}%"></i></i>
      <small>${nm.left > 0 ? `마지막 측정 후 ${nm.since}일 · 그동안 스트레칭 ${nm.stretched}일 했어요` : `4주가 지났어요. 지금 재면 변화를 볼 수 있어요`}</small>`;
    box.classList.toggle('ready', nm.left <= 0);
    box.href = nm.left <= 0 ? '#measure' : '#guide';
  }
  function notice() {
    const el = document.getElementById('measure-notice');
    if (!el) return;
    const nm = nextMeasure();
    if (!nm || nm.left <= 0) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<b>마지막 측정 후 ${nm.since}일 지났어요</b>
      <span>자세는 스트레칭을 4주쯤 꾸준히 해야 변해요. ${shortDate(nm.date)}(${dday(nm.left)})에 재면 변화가 더 잘 보여요. 지금 재도 괜찮아요.</span>`;
  }
  document.addEventListener('pagechange', e => {
    if (e.detail === 'home') card();
    if (e.detail === 'measure') notice();
  });
  criteriaReady.then(() => { card(); notice(); });
})();


/* =====================================================================
   15. 공부 타이머 · 자세 지킴이 (#focus)
   - 측정은 '그 순간'만 보지만, 공부하는 동안 나도 모르게 하는 자세를 봄
   - 노트북 웹캠(정면)으로: 처음 3초 바른 자세를 기준으로 기억하고
     · 코~어깨 높이가 줄어들면(고개 숙임·목 내밈) 또는
     · 어깨 폭이 커지면(화면 쪽으로 몸이 다가감)
     5초 이상 이어질 때 "거북이 됐어요" 알림
   - 끝나면 바른 자세 유지율, 경고 횟수, 가장 오래 유지한 시간 저장
   ===================================================================== */
(() => {
  const $ = id => document.getElementById(id);
  const setupEl = $('focus-setup'), runEl = $('focus-run'), resultEl = $('focus-result');
  if (!setupEl) return;
  const fVideo = $('focus-video'), fCanvas = $('focus-canvas'), fCtx = fCanvas.getContext('2d');
  const KEY = 'poseai_focus';
  const NOSE = 0;
  const BAD_HOLD = 5000;          // 이만큼(ms) 나쁜 자세가 이어지면 경고
  const RING = 2 * Math.PI * 54;

  let minutes = 25, fStream = null, timer = null, fDrawer = null;
  let base = null, calib = [], state = 'good', badSince = 0, warned = false;
  let startAt = 0, endAt = 0, goodMs = 0, seenMs = 0, lastTick = 0, alerts = 0, streak = 0, best = 0;

  // 포즈 캐릭터 (좋을 때 바로 선 모습, 나쁠 때 목 쭉 나온 거북이 모습)
  const BUDDY = `<svg viewBox="0 0 120 120"><ellipse class="shadow" cx="60" cy="110" rx="30" ry="5"/>
    <g class="body"><rect x="38" y="62" width="44" height="40" rx="20"/><path class="shell" d="M40 84c4-16 36-16 40 0"/></g>
    <g class="head"><line class="neck" x1="60" y1="66" x2="60" y2="48"/><circle cx="60" cy="38" r="20"/>
      <circle class="eye" cx="53" cy="36" r="2.6"/><circle class="eye" cx="67" cy="36" r="2.6"/><path class="mouth" d="M53 45q7 5 14 0"/></g></svg>`;
  document.querySelectorAll('.pose-buddy').forEach(el => { el.innerHTML = BUDDY; });

  // 시간 고르기
  setupEl.querySelectorAll('[data-min]').forEach(b => b.addEventListener('click', () => {
    setupEl.querySelectorAll('[data-min]').forEach(x => x.classList.toggle('active', x === b));
    minutes = +b.dataset.min;
  }));

  // 알림 소리 (짧은 삑)
  let actx = null;
  function beep() {
    if (!$('focus-sound').checked) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = 660; g.gain.value = 0.08;
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + 0.18);
    } catch (e) {}
  }

  const fmtTime = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const fmtMin = ms => ms >= 60000 ? `${Math.floor(ms / 60000)}분` : `${Math.round(ms / 1000)}초`;

  function setState(next, msg) {
    state = next;
    document.querySelectorAll('#buddy, .focus-tile .pose-buddy').forEach(el => { el.dataset.state = next; });
    $('focus-state').textContent = msg;
    runEl.classList.toggle('bad', next === 'bad');
  }

  // 정면 웹캠에서 자세 숫자 2개 뽑기
  function features(lm) {
    const n = lm[NOSE], l = lm[P.L_SHOULDER], r = lm[P.R_SHOULDER];
    if (!visible(n, l, r)) return null;
    const width = Math.hypot(l.x - r.x, l.y - r.y);
    const midY = (l.y + r.y) / 2;
    return { height: (midY - n.y) / width, width, tilt: Math.abs(tiltAngle(l, r)) };
  }

  async function start() {
    setupEl.hidden = true; resultEl.hidden = true; runEl.hidden = false;
    $('focus-msg').textContent = '카메라를 켜는 중이에요';
    setState('good', '기준 자세 기억 중');
    try {
      await loadModel();
      fStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      fVideo.srcObject = fStream;
      await fVideo.play();
      fCanvas.width = fVideo.videoWidth; fCanvas.height = fVideo.videoHeight;
      fDrawer = new DrawingUtils(fCtx);
    } catch (err) {
      console.error(err);
      $('focus-msg').textContent = err.name === 'NotAllowedError' ? '카메라 권한을 허용해 주세요' : '카메라나 AI 모델을 불러오지 못했어요';
      return;
    }
    base = null; calib = []; badSince = 0; warned = false;
    goodMs = seenMs = alerts = streak = best = 0;
    startAt = Date.now(); endAt = startAt + minutes * 60000; lastTick = startAt;
    $('focus-msg').textContent = '바른 자세로 3초만 있어 주세요';
    // 화면을 다른 탭으로 옮겨도 돌아가게 rAF 대신 setInterval (백그라운드는 1초마다)
    timer = setInterval(tick, 200);
  }

  function tick() {
    const now = Date.now();
    const dt = now - lastTick; lastTick = now;
    const left = endAt - now;
    $('focus-time').textContent = fmtTime(left);
    $('focus-bar').style.strokeDashoffset = RING * (1 - Math.min(1, (now - startAt) / (endAt - startAt)));
    if (left <= 0) return finish(true);

    if (fVideo.readyState < 2) return;
    const res = landmarker.detectForVideo(fVideo, performance.now());
    fCtx.clearRect(0, 0, fCanvas.width, fCanvas.height);
    const lm = res.landmarks[0];
    const f = lm && features(lm);
    if (lm) fDrawer.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: state === 'bad' ? '#F59E0B' : '#38BDF8', lineWidth: 3 });

    if (!f) { $('focus-msg').textContent = '얼굴과 양쪽 어깨가 보이게 앉아 주세요'; return; }

    // 처음 3초: 기준 자세 기억
    if (!base) {
      calib.push(f);
      if (calib.length >= 15) {
        const avg = k => calib.reduce((a, c) => a + c[k], 0) / calib.length;
        base = { height: avg('height'), width: avg('width') };
        $('focus-msg').textContent = '기준 자세를 기억했어요. 공부 시작!';
        setState('good', '바른 자세');
      }
      return;
    }

    seenMs += dt;
    const drop = 1 - f.height / base.height;      // 고개 숙임·목 내밈
    const closer = f.width / base.width - 1;       // 화면 쪽으로 다가감
    const isBad = drop > 0.18 || closer > 0.15 || f.tilt > 6;

    if (!isBad) {
      goodMs += dt; streak += dt; best = Math.max(best, streak);
      badSince = 0; warned = false;
      if (state !== 'good') { setState('good', '바른 자세'); document.title = 'PoseAi | 공부 타이머'; }
      $('focus-msg').textContent = '잘하고 있어요';
    } else {
      streak = 0;
      if (!badSince) badSince = now;
      if (now - badSince > BAD_HOLD && !warned) {
        warned = true; alerts++;
        const why = f.tilt > 6 ? '어깨가 한쪽으로 기울었어요' : closer > 0.15 ? '화면에 너무 가까워요' : '목이 앞으로 나왔어요';
        setState('bad', '거북이 됐어요 🐢');
        $('focus-msg').textContent = `${why} · 허리 펴고 턱을 살짝 당겨요`;
        document.title = '🐢 자세! | PoseAi';
        beep();
      }
    }
    $('focus-good').textContent = `${Math.round(goodMs / Math.max(1, seenMs) * 100)}%`;
    $('focus-alerts').textContent = `${alerts}회`;
    $('focus-best').textContent = fmtMin(best);
  }

  function stopCam() {
    clearInterval(timer); timer = null;
    if (fStream) fStream.getTracks().forEach(t => t.stop());
    fStream = null; fVideo.srcObject = null;
    document.title = 'PoseAi | 웹캠으로 보는 나의 체형';
  }

  function finish(done) {
    stopCam();
    runEl.hidden = true; setupEl.hidden = false;
    const studied = Math.min(Date.now(), endAt) - startAt;
    if (seenMs < 10000) { resultEl.hidden = true; return; }    // 10초도 안 봤으면 기록 안 함
    const pct = Math.round(goodMs / seenMs * 100);
    const rec = { date: localDate(), at: new Date().toTimeString().slice(0, 5), min: Math.round(studied / 60000), pct, alerts, best: Math.round(best / 1000) };
    let list = []; try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) {}
    list.push(rec);
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(-60))); } catch (e) {}

    const mood = pct >= 80 ? ['good', '바른 자세 장인이에요!'] : pct >= 50 ? ['mid', '절반 넘게 잘 버텼어요'] : ['bad', '거북이가 자주 나타났어요'];
    resultEl.innerHTML = `
      <div class="pose-buddy big" data-state="${mood[0] === 'bad' ? 'bad' : 'good'}" aria-hidden="true">${BUDDY}</div>
      <b class="fr-title">${done ? '타이머 완료!' : '수고했어요'} ${mood[1]}</b>
      <div class="focus-stats">
        <div><span>공부 시간</span><b>${fmtMin(studied)}</b></div>
        <div><span>바른 자세</span><b>${pct}%</b></div>
        <div><span>거북이 경고</span><b>${alerts}회</b></div>
      </div>
      <p class="note">${pct < 50 ? '목이 자주 나왔다면 맞춤 스트레칭을 해 보세요.' : '이 자세 그대로 계속 가 봐요.'}</p>
      <a href="#guide" class="btn btn-soft btn-block">스트레칭 하러 가기 →</a>`;
    resultEl.hidden = false;
    renderHistory();
  }

  function renderHistory() {
    let list = []; try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) {}
    const ul = $('focus-history');
    if (!list.length) { ul.innerHTML = '<li class="empty">아직 기록이 없어요</li>'; return; }
    ul.innerHTML = list.slice(-7).reverse().map(r => `
      <li><div class="rec-main"><b>${+r.date.slice(5, 7)}월 ${+r.date.slice(8, 10)}일 ${r.at}</b><span>${r.min}분 공부 · 경고 ${r.alerts}회</span></div>
      <div class="rec-val"><b>${r.pct}%</b><span class="lv-${r.pct >= 80 ? 'good' : r.pct >= 50 ? 'warn' : 'check'}">바른 자세</span></div></li>`).join('');
  }

  $('focus-start').addEventListener('click', () => {
    // 소리는 사용자가 누른 순간에만 켤 수 있어서 여기서 미리 준비
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    start();
  });
  $('focus-stop').addEventListener('click', () => finish(false));
  $('focus-recal').addEventListener('click', () => { base = null; calib = []; setState('good', '기준 자세 기억 중'); $('focus-msg').textContent = '바른 자세로 3초만 있어 주세요'; });
  document.addEventListener('pagechange', e => {
    if (e.detail === 'focus') renderHistory();
    else if (timer) finish(false);     // 다른 화면으로 가면 타이머 끝
  });
  renderHistory();
})();

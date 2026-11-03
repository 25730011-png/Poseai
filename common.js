// ===== 공통: 판단 기준표, 점수 계산, 기록 저장 =====
// 모든 화면에서 같이 씀 (기준값은 사용자 테스트 후 조정)

// 판단 기준 (각도, 단위: 도)
const CRITERIA = {
  neck:     { name: '거북목',    good: 15, warn: 25, penalty: 2 },
  shoulder: { name: '어깨 수평', good: 2,  warn: 5,  penalty: 8 },
  pelvis:   { name: '골반 수평', good: 3,  warn: 6,  penalty: 6 }
};

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

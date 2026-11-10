// ===== PoseAi 구글 시트 저장 (Google Apps Script) =====
// 구글 시트 → 확장 프로그램 → Apps Script 에 이 코드를 통째로 붙여넣고
// 배포 → 새 배포 → 웹 앱 (실행: 나 / 액세스: 모든 사용자) 로 배포
// 나온 웹 앱 URL을 js/app.js 의 SHEET_URL 에 넣기
//
// 시트 탭 2개가 자동으로 생김
//   users   : 아이디 | 닉네임 | 가입일
//   records : 아이디 | 날짜 | 거북목 | 어깨 수평 | 상체 쏠림 | 골반 수평 | 무릎 정렬 | 점수 | 저장 시각

const USERS = ['아이디', '닉네임', '가입일'];
const RECORDS = ['아이디', '날짜', '거북목', '어깨 수평', '상체 쏠림', '골반 수평', '무릎 정렬', '점수', '저장 시각'];
const KEYS = ['neck', 'shoulder', 'trunk', 'pelvis', 'knee'];   // RECORDS 3~7번째 칸 순서와 같게

function getSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let s = ss.getSheetByName(name);
  if (!s) {
    s = ss.insertSheet(name);
    s.appendRow(headers);
    s.setFrozenRows(1);
    s.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return s;
}

// 사이트 주소를 브라우저로 열었을 때 확인용
function doGet() {
  return ContentService.createTextOutput('PoseAi sheet OK');
}

// 사이트에서 보내는 요청: { action: 'signup' | 'login' | 'saveRecords' | 'getRecords', ... }
function doPost(e) {
  let out;
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);   // 여러 명이 동시에 저장해도 줄이 섞이지 않게
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = handle(body);
  } catch (err) {
    out = { ok: false, error: String(err.message || err) };
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle(b) {
  switch (b.action) {
    case 'signup': {
      const id = cleanId(b.id);
      const nickname = String(b.nickname || '').trim().slice(0, 12);
      if (!nickname) return { ok: false, error: '닉네임을 입력해 주세요' };
      if (findUser(id)) return { ok: false, error: '이미 있는 아이디예요. 다른 아이디를 써 주세요' };
      getSheet('users', USERS).appendRow([id, nickname, new Date()]);
      return { ok: true, user: { id, nickname } };
    }
    case 'login': {
      const id = cleanId(b.id);
      const u = findUser(id);
      if (!u) return { ok: false, error: '없는 아이디예요. 회원가입을 먼저 해 주세요' };
      return { ok: true, user: { id, nickname: u.nickname } };
    }
    case 'saveRecords': {
      const id = cleanId(b.id);
      if (!findUser(id)) return { ok: false, error: '없는 아이디예요' };
      const have = readRecords(id).map(r => r.savedAt);           // 이미 있는 기록은 건너뛰기
      const rows = (b.records || [])
        .filter(r => r && r.savedAt && have.indexOf(String(r.savedAt)) === -1)
        .map(r => [id, "'" + String(r.date || ''),
          ...KEYS.map(k => (r[k] === null || r[k] === undefined || r[k] === '') ? '' : Number(r[k])),
          Number(r.score) || 0, String(r.savedAt)]);
      if (rows.length) {
        const s = getSheet('records', RECORDS);
        s.getRange(s.getLastRow() + 1, 1, rows.length, RECORDS.length).setValues(rows);
      }
      return { ok: true, added: rows.length };
    }
    case 'getRecords': {
      const id = cleanId(b.id);
      return { ok: true, records: readRecords(id) };
    }
    default:
      return { ok: false, error: '알 수 없는 요청이에요' };
  }
}

// 아이디: 영문 소문자·숫자·_ 3~20자
function cleanId(id) {
  id = String(id || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(id)) throw new Error('아이디는 영문·숫자·_ 3~20자로 써 주세요');
  return id;
}

function findUser(id) {
  const v = getSheet('users', USERS).getDataRange().getValues();
  for (let i = 1; i < v.length; i++) {
    if (String(v[i][0]) === id) return { nickname: String(v[i][1]) };
  }
  return null;
}

function readRecords(id) {
  const v = getSheet('records', RECORDS).getDataRange().getValues();
  return v.slice(1).filter(r => String(r[0]) === id).map(r => {
    const d = r[1] instanceof Date ? Utilities.formatDate(r[1], 'Asia/Seoul', 'yyyy-MM-dd') : String(r[1]);
    const rec = { date: d, score: Number(r[7]), savedAt: String(r[8]) };
    KEYS.forEach((k, i) => { rec[k] = r[2 + i] === '' ? null : Number(r[2 + i]); });
    return rec;
  });
}

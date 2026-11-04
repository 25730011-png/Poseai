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

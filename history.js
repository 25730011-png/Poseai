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

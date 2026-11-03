// ===== ② 촬영·측정 (#measure) =====
// 할 일
// 1. #measure 화면 들어오면 웹캠 켜기 (getUserMedia), 다른 화면 가면 끄기
// 2. MediaPipe PoseLandmarker로 좌표 추출 → canvas에 점 그리기
// 3. 정면 5초: 어깨(11·12), 엉덩이(23·24) 각도 평균
// 4. 측면 5초: 귀(7·8)-어깨(11·12) 각도 평균 (visibility 높은 쪽 사용)
// 5. saveLatest({ date, neck, shoulder, pelvis, score }) 후 location.hash = '#report'

# PoseAi

웹캠으로 보는 나의 체형, 진단부터 교정까지
AI 체형 진단 및 모니터링 서비스

## 소개
설치·가입·별도 장비 없이 노트북 웹캠과 브라우저만으로 거북목·어깨 수평·골반 수평 3가지를 측정하고,
날짜별 기록과 교정 가이드까지 한 흐름으로 제공하는 웹서비스입니다.

- 영상·사진은 저장·전송하지 않고 브라우저 안에서만 처리
- 의학적 진단이 아닌 참고용 분석

## 화면 구성
index.html 하나에 5개 화면을 section으로 넣고, 주소 끝 #이름으로 전환해요. (js/app.js)

| 주소 | 화면 | 내용 | 스크립트 |
|---|---|---|---|
| #home | 메인 | 서비스 소개, 모드 선택, 참고용 안내 | - |
| #measure | 촬영·측정 | 정면·측면 각 5초 측정 | js/measure.js |
| #report | 체형 리포트 | 항목별 값·단계, 종합 점수(100점) | js/report.js |
| #history | 기록·그래프 | 날짜별 기록, 변화 그래프 | js/history.js |
| #guide | 교정 가이드 | 스트레칭 안내, FAQ 챗봇, 주변 병원 찾기 | js/guide.js |

## 사용 기술
- HTML, CSS, JavaScript
- MediaPipe Pose (웹캠 자세 인식)
- LocalStorage (기록 저장), Chart.js (변화 그래프)
- 건강보험심사평가원 병원정보서비스 오픈API
- GitHub Pages 배포

## 폴더 구조
```
├── index.html        5개 화면
├── css/style.css     공통 디자인
├── js/
│   ├── app.js        화면 전환
│   ├── common.js     판단 기준표, 점수 계산, 기록 저장
│   └── measure.js / report.js / history.js / guide.js
└── data/             criteria.json(판단 기준표), guide.json(스트레칭), faq.json(FAQ)
```

## 팀원
- 임서연 (25730035) 팀장: 기획, 자료조사, 교정 가이드·FAQ 데이터, 오픈API 연동
- 정유진 (25730011) 팀원: UI/UX 설계, 화면·기능 구현, 통합·배포

## 배포
https://25730011-png.github.io/poseai

## 지금 버전
- 와이어프레임(흑백) 버전으로 기능부터 개발 중
- 디자인 입힐 때: `css/style-design.css` 내용을 `css/style.css`에 덮어쓰고, `index.html`의 웹폰트 주석 풀기

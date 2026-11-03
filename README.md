# PoseAi

웹캠으로 보는 나의 체형, 진단부터 교정까지
AI 체형 진단 및 모니터링 서비스

## 소개
설치·가입·별도 장비 없이 노트북 웹캠과 브라우저만으로 거북목·어깨 수평·골반 수평 3가지를 측정하고,
날짜별 기록과 교정 가이드까지 한 흐름으로 제공하는 웹서비스입니다.

- 영상·사진은 저장·전송하지 않고 브라우저 안에서만 처리
- 의학적 진단이 아닌 참고용 분석

## 화면 구성
| 파일 | 화면 | 내용 |
|---|---|---|
| index.html | 메인 | 서비스 소개, 모드 선택, 참고용 안내 |
| measure.html | 촬영·측정 | 정면·측면 각 5초 측정 |
| report.html | 체형 리포트 | 항목별 값·단계, 종합 점수(100점) |
| history.html | 기록·그래프 | 날짜별 기록, 변화 그래프 |
| guide.html | 교정 가이드 | 스트레칭 안내, FAQ 챗봇, 주변 병원 찾기 |

## 사용 기술
- HTML, CSS, JavaScript
- MediaPipe Pose (웹캠 자세 인식)
- LocalStorage (기록 저장), Chart.js (변화 그래프)
- 건강보험심사평가원 병원정보서비스 오픈API
- GitHub Pages 배포

## 폴더 구조
```
poseai/
├── index.html / measure.html / report.html / history.html / guide.html
├── css/style.css     공통 디자인
├── js/               화면별 스크립트, common.js(기준표·기록 저장)
└── data/             교정 가이드·FAQ JSON
```

## 팀원
- 임서연 (25730035) 팀장: 기획, 자료조사, 교정 가이드·FAQ 데이터, 오픈API 연동
- 정유진 (25730011) 팀원: UI/UX 설계, 화면·기능 구현, 통합·배포

## 배포
https://25730011-png.github.io/poseai

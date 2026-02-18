---
title: "커넥션풀을 늘렸는데 왜 적용이 안 됐을까: Hikari 섀도잉 버그와 스레드풀 튜닝 근거"
date: 2026-02-18 14:15:00 +0900
categories: [tech]
tags: [spring-boot, hikari, tomcat, thread-pool, connection-pool, kotlin, tuning]
toc: true
toc_sticky: true
---

> 설정값을 바꿨는데도 체감이 달라지지 않는다면, 튜닝 이전에 "설정 반영 경로"부터 검증해야 했습니다.

---

## 문제 상황

저희는 트래픽 피크 구간 안정성을 높이기 위해 App/Backoffice의 커넥션풀과 Tomcat 스레드 설정을 조정했습니다.
운영 프로필 기준으로 풀 크기, `minimumIdle`, `leakDetectionThreshold`, 스레드 상한을 명시적으로 다루는 방향이었습니다.
그런데 설정을 조정한 이후에도 일부 구간은 기대한 만큼 안정화되지 않았습니다.

즉,
**튜닝 수치 자체보다 설정 반영 신뢰성이 먼저 문제**
였습니다.

---

## 증상과 분석

초기 분석에서 저희는 두 가지 가능성을 동시에 봤습니다.
첫째는 "튜닝 수치가 부족했을 가능성", 둘째는 "설정이 코드 경로에서 누락됐을 가능성"입니다.

`ReplicationDataSourceProperties.toHikariConfig()`를 추적해 보니, 두 번째 가능성이 실제 원인 후보로 떠올랐습니다.
코드상 `with(...)` 블록에서 리시버가 겹치면서, 의도한 대상(`HikariConfig`)이 아닌 프로퍼티 객체에 값이 할당되는 구간이 있었습니다.

---

## 원인 파악

핵심은 Kotlin 스코프 함수 리시버 섀도잉이었습니다.
구성상 "Hikari 설정을 Config 객체로 복사"해야 하는데, 일부 필드는 복사가 아니라 자기 자신 대입처럼 동작할 여지가 있었습니다.

그 결과,
`minimumIdle`, `leakDetectionThreshold` 같은 운영 안정성 관련 설정이
"YAML에 정의되어도 실제 풀 설정에 일관되게 반영되지 않을 수 있는 상태"가 됐습니다.

---

## 해결 방법

### 1) 설정 반영 경로를 명시적으로 변경

`with(...)` 스코프 대신 로컬 변수(`h`)를 사용해 `HikariConfig` 필드에 직접 대입하도록 수정했습니다.
이 방식으로 리시버 섀도잉 가능성을 제거했습니다.

```kotlin
val h = this.hikari
return HikariConfig().apply {
    maximumPoolSize = h.maximumPoolSize
    minimumIdle = h.minimumIdle
    leakDetectionThreshold = h.leakDetectionThreshold
}
```

### 2) 설정 모델과 테스트 보강

`HikariProperties`에 `minimumIdle`, `leakDetectionThreshold`를 명시적으로 추가했습니다.
동시에 `HikariConfigConversionTest`를 만들어 "YAML 값이 최종 Config에 반영되는지"를 테스트로 고정했습니다.

### 3) 런타임 튜닝과 연결

이후 App/Backoffice의 Tomcat 스레드와 Hikari 풀 설정을 실제 운영 프로필 기준으로 조정했습니다.
포인트는 "크게 올린다"가 아니라, DB 여유·요청 패턴·운영 리스크를 같이 보면서 단계적으로 조정하는 방식이었습니다.

---

## 트레이드오프

스레드/풀을 키우면 순간 처리량은 좋아질 수 있지만, DB 연결 경쟁과 메모리 압박이 커질 수 있습니다.
반대로 보수적으로 잡으면 안정성은 높지만 피크 응답 지연이 커질 수 있습니다.

그래서 저희는 단일 숫자 최적화보다 아래 순서를 고정했습니다.

1. 설정 반영 경로 검증
2. 누수 탐지/관측 포인트 추가
3. 단계적 튜닝
4. 운영 지표 재검증

---

## 근거

- 커밋 `e7eb420e6` (`perf(hikari): App/Backoffice 커넥션풀 및 Tomcat 스레드 증설`)
- 커밋 `57e2b62f7` (`fix(hikari): with 스코프 섀도잉 버그 수정...`)
- 파일 `domain/src/main/kotlin/com/deartail/domain/config/ReplicationDataSourceProperties.kt`
- 파일 `domain/src/test/kotlin/com/deartail/domain/HikariConfigConversionTest.kt`
- 파일 `apis/app/src/main/resources/application.yml`
- 파일 `apis/app/src/main/resources/db.yml`
- 파일 `apis/backoffice/src/main/resources/application.yml`
- 파일 `apis/backoffice/src/main/resources/db.yml`

---

## 정리

- 튜닝에서 가장 먼저 고정해야 하는 것은 "설정값"이 아니라 "설정 반영 경로"였습니다.
- Hikari/Tomcat 튜닝은 수치 조정과 함께 검증 테스트를 붙일 때 운영 신뢰도가 올라갔습니다.
- 풀/스레드 설정은 한 번에 끝나는 작업이 아니라, 관측 기반으로 계속 다듬는 운영 과제였습니다.

여러분은 커넥션풀/스레드풀 튜닝 시 설정 반영 검증을 어떤 방식으로 자동화하고 계신가요?

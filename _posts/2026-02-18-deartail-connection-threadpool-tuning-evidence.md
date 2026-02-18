---
title: "커넥션풀을 늘렸는데 왜 적용이 안 됐을까: Hikari 섀도잉 버그와 스레드풀 튜닝 근거"
date: 2026-02-18 14:15:00 +0900
categories: [tech]
tags: [spring-boot, hikari, tomcat, thread-pool, connection-pool, kotlin, tuning]
toc: true
toc_sticky: true
---

> 설정값을 올렸는데 효과가 약했다면, 수치보다 먼저 "설정이 실제 런타임에 반영되는 경로"를 검증해야 했다.

---

## 문제 상황

피크 트래픽 구간 안정성을 높이기 위해 App/Backoffice의 커넥션풀과 Tomcat 스레드 수를 조정했다.
운영에서는 `maximumPoolSize`, `minimumIdle`, `leakDetectionThreshold`, Tomcat `max/min-spare`를 명시적으로 관리했다.

문제는 "값을 바꿨는데 체감이 약한 구간"이 존재했다는 점이다.
이 시점의 핵심 질문은 두 가지였다.

1. 튜닝 값이 충분하지 않았나?
2. 튜닝 값이 코드 경로에서 누락됐나?

---

## 측정 조건

이 글의 수치는 작성자 공개 승인 후 공유한 운영 계측값이다.
절대값 자체보다 "변화 방향"과 "설정 반영 여부" 확인에 초점을 두었다.

| 항목 | 기준 |
|------|------|
| 대상 서비스 | App API, Backoffice API |
| 관측 구간 | 피크 트래픽 시간대 |
| 관측 지표 | DB pool 사용률, connection wait, API 응답 지연 |
| 변경 방식 | 1차(반영 경로 수정) -> 2차(운영 수치 튜닝) |
| 실패 판단 | 설정값이 YAML에 있어도 런타임에 동일값으로 반영되지 않으면 실패 |

---

## 원인 파악: 수치 이전에 반영 경로가 깨져 있었다

핵심 이슈는 Kotlin 스코프 함수 리시버 섀도잉이었다.
의도는 "HikariProperties -> HikariConfig 복사"였지만, 일부 구간에서 대입 대상이 혼동될 수 있는 구조였다.

즉, YAML에 값이 있어도 다음 필드가 런타임에 일관되게 반영되지 않을 위험이 있었다.

- `minimumIdle`
- `leakDetectionThreshold`

이 상태에서 풀 크기만 크게 조정하면, 지표상 개선이 불안정하게 나타날 수 있다.

---

## 해결 방법

### 1) 1차: 설정 반영 경로를 명시적으로 수정

`with(...)` 기반 복사 대신 로컬 변수로 읽어 `HikariConfig` 필드에 직접 대입했다.
포인트는 "누가 리시버인지"를 추측하지 않는 구조로 바꾼 것이다.

```kotlin
val h = this.hikari
return HikariConfig().apply {
    maximumPoolSize = h.maximumPoolSize
    minimumIdle = h.minimumIdle
    leakDetectionThreshold = h.leakDetectionThreshold
}
```

이 변경으로 "값이 선언됨"이 아니라 "값이 적용됨"을 보장하는 방향으로 전환했다.

### 2) 1차 검증: 변환 테스트를 추가해 회귀를 차단

설정 반영을 테스트로 고정했다.
아래 항목이 통과해야 튜닝 수치 변경을 진행하도록 순서를 분리했다.

| 검증 항목 | 기대값 |
|-----------|--------|
| `minimumIdle` 반영 | 입력값과 동일 |
| `maximumPoolSize` 반영 | 입력값과 동일 |
| `leakDetectionThreshold` 반영 | 입력값과 동일 |
| Slave readOnly | 항상 `true` |

### 3) 2차: 런타임 수치 튜닝

반영 경로를 고정한 뒤에만 수치를 조정했다.

#### App 조정

| 항목 | 조정 전 | 조정 후 |
|------|--------|--------|
| Master `maximumPoolSize` | 15 | 25 |
| Master `minimumIdle` | 기본값 의존 | 10 |
| Slave `maximumPoolSize` | 40 | 40 |
| Slave `minimumIdle` | 기본값 의존 | 10 |
| Leak Detection | 미설정 | 10초 |
| Tomcat threads | 기본값 의존 | max 200 / min-spare 20 |

#### Backoffice 조정

| 단계 | 커넥션풀 | Tomcat threads |
|------|----------|----------------|
| 1차 안정화 | max 10 / minIdle 2 / leak 10초 | max 50 / min-spare 5 |
| 2차 확장 | max 20 / minIdle 5 | max 100 / min-spare 10 |

이 순서의 목적은 단순하다.
"반영 불확실 상태에서 공격적 튜닝"을 피하고, 단계별로 병목이 어디서 줄었는지 관측 가능하게 만드는 것이다.

---

## 왜 이 순서가 중요했나

스레드/풀 증설은 처리량 개선에 유리하지만, 동시에 부작용도 만든다.

- DB 연결 경쟁 증가
- 메모리 사용량 증가
- 잘못된 `minimumIdle`은 비어 있는 연결 유지 비용 증가
- 과도한 스레드 확장은 context switch 비용 증가

그래서 실제 운영 순서는 다음으로 고정했다.

1. 설정 반영 경로 검증
2. 테스트로 반영 보장
3. 단계적 증설
4. 운영 지표 재검증

---

## 운영에서 바로 쓸 체크리스트

1. YAML 변경 전에 "런타임 반영 테스트"가 있는지 먼저 확인한다.
2. `minimumIdle`, `maximumPoolSize`, leak detection은 항상 세트로 본다.
3. DB 풀과 Tomcat 스레드는 같이 조정하고, 한 번에 크게 올리지 않는다.
4. 조정 후에는 p95/p99 지연과 connection wait을 함께 본다.
5. 수치가 맞아도 개선이 없으면 SQL 병목/외부 I/O 병목으로 축을 전환한다.

---

## 정리

이번 케이스의 핵심은 "튜닝 숫자"가 아니라 "튜닝 숫자가 적용되는 경로"였다.
설정 반영이 불명확한 상태에서는 고급 튜닝도 의미가 약해진다.

먼저 반영 경로를 고정하고, 그다음 수치를 단계적으로 조정하면 운영에서의 설명 가능성과 재현성이 함께 올라간다.

---

## 참고 자료

- HikariCP Configuration: https://github.com/brettwooldridge/HikariCP#configuration-knobs-baby
- Apache Tomcat HTTP Connector: https://tomcat.apache.org/tomcat-10.1-doc/config/http.html
- Spring Boot Externalized Configuration: https://docs.spring.io/spring-boot/reference/features/external-config.html
- Spring Boot Testing: https://docs.spring.io/spring-boot/reference/testing/index.html

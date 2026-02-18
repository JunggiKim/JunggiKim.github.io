---
title: "우리 서비스에 맞는 커넥션풀/스레드풀 수를 구해서 설정하기: Hikari 반영 경로 검증부터 단계별 튜닝까지"
date: 2026-02-18 14:15:00 +0900
categories: [tech]
tags: [spring-boot, hikari, tomcat, thread-pool, connection-pool, kotlin, tuning]
toc: true
toc_sticky: true
---

> 이번 작업의 핵심은 숫자를 크게 넣는 게 아니라, 설정이 런타임에 정확히 적용되는지 먼저 고정한 뒤 우리 서비스 트래픽에 맞춰 계산하는 것이었다.

---

## 문제를 다시 봤다

피크 시간대 안정성을 위해 App/Backoffice의 커넥션풀과 Tomcat 스레드 수를 조정했다.
그런데 값을 올렸는데도 일부 구간 체감이 약했다.

이때 질문은 둘이었다.

1. 수치가 부족한가?
2. 수치가 적용되지 않은 건가?

실제 원인은 2번이 먼저였다.

---

## 첫 원인: "튜닝값이 적용되는 경로"가 불안정했다

문제는 Hikari 설정 변환 코드의 대입 경로였다.
의도는 `HikariProperties` 값을 `HikariConfig`로 정확히 복사하는 것이었지만,
리시버가 혼동될 수 있는 구조에서는 일부 필드 반영 누락 위험이 생긴다.

실제 영향 후보는 아래 두 필드였다.

- `minimumIdle`
- `leakDetectionThreshold`

이 두 값이 흔들리면, 풀 크기(`maximumPoolSize`)만 올려도 체감 개선이 일관되지 않다.

---

## 1차 조치: 반영 경로를 명시 대입으로 고정

리시버 추론에 기대지 않고, 로컬 변수에서 `HikariConfig`로 직접 대입하도록 수정했다.

```kotlin
val h = this.hikari
return HikariConfig().apply {
    maximumPoolSize = h.maximumPoolSize
    minimumIdle = h.minimumIdle
    leakDetectionThreshold = h.leakDetectionThreshold
}
```

같은 방식으로 Master/Slave 모두를 고정했다.
핵심은 "설정이 선언돼 있다"가 아니라 "런타임 객체에 실제로 들어갔다"를 보장하는 것이다.

---

## 1차 검증: 변환 테스트로 회귀를 막았다

수치 튜닝 전에 설정 반영을 테스트로 먼저 고정했다.

| 검증 항목 | 기대값 |
|-----------|--------|
| `minimumIdle` 반영 | 입력값과 동일 |
| `maximumPoolSize` 반영 | 입력값과 동일 |
| `leakDetectionThreshold` 반영 | 입력값과 동일 |
| Slave `readOnly` | 항상 `true` |

이 검증이 없으면, 이후 수치 변경 결과를 해석할 수 없다.
개선이 안 나와도 값 부족인지 반영 누락인지 구분이 불가능하기 때문이다.

---

## 2차 조치: 우리 서비스 기준으로 커넥션 수를 계산했다

이번 튜닝에서 먼저 정한 원칙은 다음이다.

1. DB 한도에서 서비스별 예산을 먼저 나눈다.
2. 피크 구간 동시성으로 필요한 연결 수를 계산한다.
3. 계산값보다 조금 크게 두되, "과잉 여유"는 두지 않는다.
4. 커넥션풀과 Tomcat 스레드풀을 따로 보지 않고 같이 맞춘다.

### 계산식(실무형)

커넥션 계산은 아래 식으로 시작했다.

```text
필요 동시 DB 연결 수 ~= 피크 RPS x 요청당 DB 점유 시간(초)
목표 풀 크기 ~= 필요 동시 연결 수 / 목표 사용률(0.6~0.7)
```

여기서 목표 사용률을 100%로 두지 않는 이유는 여유 버퍼 때문이다.
풀 사용률이 상시 90%를 넘기면 작은 스파이크에서도 대기열이 급격히 늘어난다.

### App API 산정 예시

- Master 경로(쓰기 중심):
  - 피크 RPS x DB 점유 시간 추정 동시성 ≈ 16
  - 목표 사용률 65% 적용 -> `16 / 0.65 ≈ 24.6`
  - 최종 `maximumPoolSize = 25`
- Slave 경로(읽기 중심):
  - 추정 동시성 ≈ 26
  - 목표 사용률 65% 적용 -> `26 / 0.65 = 40`
  - 최종 `maximumPoolSize = 40`

이 계산으로 "왜 25/40인가"를 설명 가능하게 만들었다.

### Backoffice API 산정 예시

Backoffice는 피크 트래픽과 동시성 패턴이 App보다 낮아 2단계로 올렸다.

- 1차 안정화: `max 10 / minIdle 2`
- 2차 확장: `max 20 / minIdle 5`

처음부터 20으로 가지 않은 이유는 단순하다.
먼저 대기/지연 지표가 어떻게 바뀌는지 확인해야 병목 위치를 정확히 잡을 수 있기 때문이다.

---

## 스레드풀은 커넥션풀과 함께 계산했다

Tomcat `maxThreads`를 독립 숫자로 보지 않았다.
요청 처리 스레드가 늘어나도 DB 커넥션이 받쳐주지 않으면 connection wait만 늘어난다.

이번 조정은 다음 원칙으로 진행했다.

1. 커넥션풀 계산을 먼저 확정한다.
2. 비DB 작업 비중(직렬화/외부 I/O)을 반영해 스레드 수를 설정한다.
3. 스레드 수를 한 번에 크게 올리지 않고 단계적으로 조정한다.

### 최종 적용값

#### App

| 항목 | 조정 전 | 조정 후 |
|------|--------|--------|
| Master `maximumPoolSize` | 15 | 25 |
| Master `minimumIdle` | 기본값 의존 | 10 |
| Slave `maximumPoolSize` | 40 | 40 |
| Slave `minimumIdle` | 기본값 의존 | 10 |
| Leak Detection | 미설정 | 10초 |
| Tomcat threads | 기본값 의존 | max 200 / min-spare 20 |

#### Backoffice

| 단계 | 커넥션풀 | Tomcat threads |
|------|----------|----------------|
| 1차 안정화 | max 10 / minIdle 2 / leak 10초 | max 50 / min-spare 5 |
| 2차 확장 | max 20 / minIdle 5 | max 100 / min-spare 10 |

---

## 왜 이 순서를 강제했나

"값 먼저 크게 올리기"는 빠르지만 실패 원인을 흐린다.
이번에는 순서를 고정해 해석 가능성을 확보했다.

1. 반영 경로 수정
2. 변환 테스트 추가
3. 단계별 증설
4. 운영 지표 재검증

이 순서를 지키면 실패 시 원인 축이 명확하다.

- 반영 실패인가?
- 풀 부족인가?
- SQL/인덱스 병목인가?
- 외부 I/O 병목인가?

---

## 튜닝 후에 실제로 본 지표

튜닝 직후에는 아래 지표를 세트로 본다.

| 지표 | 확인 목적 |
|------|-----------|
| Hikari active/idle/pending | 풀 고갈 여부, 과잉 확보 여부 |
| connection wait | 풀 부족으로 인한 대기 확인 |
| API p95/p99 | 사용자 체감 지연 확인 |
| DB CPU/lock/wait | 병목이 DB로 이동했는지 확인 |
| Tomcat busy/current threads | 스레드 대기/과다 여부 확인 |

이 중 하나만 보면 오판이 쉽다.
예를 들어 p95만 내려가고 DB wait가 오르면 병목 위치가 옮겨진 것일 수 있다.

---

## 자주 하는 실수

1. YAML 숫자만 바꾸고 런타임 반영 검증을 생략한다.
2. 커넥션풀만 올리고 스레드풀은 그대로 둔다.
3. 스레드풀을 과도하게 키워 context switch 비용을 키운다.
4. `minimumIdle`을 과대 설정해 유휴 연결 유지 비용을 키운다.
5. SQL/인덱스 병목을 풀 튜닝으로 해결하려고 한다.

---

## 운영 체크리스트

1. 설정 반영 테스트가 없으면 수치 튜닝을 시작하지 않는다.
2. `maximumPoolSize`, `minimumIdle`, `leakDetectionThreshold`를 세트로 다룬다.
3. DB 한도 -> 서비스 예산 -> 인스턴스별 풀 크기 순서로 계산한다.
4. Tomcat 스레드는 커넥션풀과 함께 조정한다.
5. 조정 후 p95/p99 + connection wait + DB wait를 같이 본다.
6. 개선이 약하면 SQL/인덱스/외부 I/O 축으로 원인 분석을 전환한다.

---

## 정리

이번 튜닝의 본질은 숫자 놀이가 아니었다.
"우리 서비스 트래픽에서 필요한 동시 연결 수"를 계산하고,
그 값이 런타임에 실제 반영된다는 증거를 먼저 고정한 뒤 단계적으로 확장한 작업이었다.

설정 반영 경로가 불안정한 상태에서는 어떤 고급 튜닝도 재현성이 떨어진다.
먼저 반영 경로를 테스트로 잠그고, 그 다음에 계산 기반으로 수치를 올리는 접근이 운영에서는 가장 안전했다.

---

## 참고 자료

- HikariCP Configuration: https://github.com/brettwooldridge/HikariCP#configuration-knobs-baby
- Apache Tomcat HTTP Connector: https://tomcat.apache.org/tomcat-10.1-doc/config/http.html
- Spring Boot Externalized Configuration: https://docs.spring.io/spring-boot/reference/features/external-config.html
- Spring Boot Testing: https://docs.spring.io/spring-boot/reference/testing/index.html

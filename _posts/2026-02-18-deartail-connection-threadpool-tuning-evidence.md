---
title: "우리 서비스에 맞는 커넥션풀/스레드풀 수를 구해서 설정하기: 계산 기반 단계별 튜닝"
date: 2026-02-18 14:15:00 +0900
categories: [tech]
tags: [spring-boot, hikari, tomcat, thread-pool, connection-pool, kotlin, tuning]
toc: true
toc_sticky: true
---

> 이번 작업의 핵심은 숫자를 크게 넣는 게 아니라, 우리 서비스 트래픽에서 필요한 동시 연결 수를 계산하고 단계적으로 확장하는 것이었다.

---

## 이전 설정과 문제

피크 시간대 안정성을 위해 App/Backoffice의 커넥션풀과 Tomcat 스레드 수를 조정했다.

조정 전 설정은 아래와 같았다.

| 항목 | App Master | App Slave | Backoffice |
|------|-----------|-----------|------------|
| `maximumPoolSize` | 15 | 40 | 10 |
| `minimumIdle` | 기본값 의존 | 기본값 의존 | 2 |
| `leakDetectionThreshold` | 미설정 | 미설정 | 미설정 |
| Tomcat `maxThreads` | 기본값 의존 | — | 기본값 의존 |

문제는 두 가지였다.

1. **풀 크기 부족**: 피크 시간대에 App Master의 active 연결이 15개 상한에 근접하면서 connection wait가 간헐적으로 발생했다.
2. **누수 감지 부재**: `leakDetectionThreshold`가 없어서 커넥션 누수가 발생해도 풀 고갈 시점까지 감지할 수 없었다.

---

## HikariCP 풀 관리는 어떻게 동작하는가

커넥션풀 튜닝에 쓰인 세 설정이 내부에서 어떤 역할을 하는지 짚고 넘어간다.

**커넥션 생명주기.** 애플리케이션이 `getConnection()`을 호출하면 풀에서 idle 상태의 커넥션을 하나 꺼내 active로 전환한다. 비즈니스 로직이 끝나고 `close()`가 호출되면 커넥션은 실제로 닫히지 않고 idle 상태로 풀에 반환된다. 이 사이클이 풀 관리의 기본 단위다.

**minimumIdle.** idle 커넥션을 최소 N개 유지하라는 설정이다. 이 값이 `maximumPoolSize`와 같으면 항상 최대 커넥션을 유지하는 고정 풀이 된다. 다르면 트래픽이 줄 때 idle 커넥션을 줄여 DB 리소스를 절약한다. 너무 낮게 설정하면 트래픽 스파이크 때 커넥션을 새로 생성하느라 지연이 생긴다.

**leakDetectionThreshold.** `getConnection()` 후 설정 시간(ms) 내에 `close()`가 호출되지 않으면 경고 로그를 남긴다. 커넥션 누수(반환되지 않은 커넥션)를 조기에 발견하는 장치다. 이 설정이 없으면 누수가 풀 고갈로 이어질 때까지 알 수 없다.

---

## 우리 서비스 기준으로 커넥션 수를 계산했다

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
  - 피크 RPS × 요청당 평균 DB 점유 시간 → 추정 동시성 ≈ 16
  - 목표 사용률 65% 적용 → `16 / 0.65 ≈ 24.6`
  - 최종 `maximumPoolSize = 25`
- Slave 경로(읽기 중심):
  - 피크 RPS × 요청당 평균 DB 점유 시간 → 추정 동시성 ≈ 26
  - 목표 사용률 65% 적용 → `26 / 0.65 = 40`
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

그 이유는 구조에 있다. 요청이 들어오면 Tomcat은 스레드풀에서 스레드 하나를 할당한다. 해당 스레드가 DB 쿼리를 실행하려면 HikariCP 풀에서 커넥션을 `getConnection()`으로 가져와야 한다. `maxThreads=200`인데 `maximumPoolSize=15`이면, 동시에 DB 작업을 수행할 수 있는 스레드는 최대 15개다. 나머지 185개는 커넥션을 받을 때까지 `connectionTimeout`(기본 30초) 동안 대기하거나, timeout이 나면 예외가 터진다. 그래서 `maxThreads`를 올리기 전에 `maximumPoolSize`를 먼저 확보해야 한다.

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

## 왜 단계적으로 올렸나

"값 먼저 크게 올리기"는 빠르지만 실패 원인을 흐린다.
이번에는 순서를 고정해 해석 가능성을 확보했다.

1. 이전 설정 문제 진단
2. DB 한도 기준 커넥션 계산
3. 단계별 증설
4. 운영 지표 검증

이 순서를 지키면 개선이 안 나왔을 때 원인 축이 명확하다.

- 풀 부족인가?
- SQL/인덱스 병목인가?
- 외부 I/O 병목인가?
- 스레드풀 불균형인가?

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

### 실측 결과

| 지표 | 튜닝 전 | 튜닝 후 | 변화 |
|------|---------|---------|------|
| ALB Target Response p95 | — | 76~111ms | — |
| ALB Target Response p99 | — | 131~292ms | — |
| App Master 풀 사용률 (active/max) | ~14/15 (93%) | ~18/25 (72%) | 여유 확보 |
| RDS 평균 커넥션 수 (Master) | — | ~37 | 안정 |
| RDS 피크 커넥션 수 (Master) | — | ~45 | 상한 내 |
| ECS 메모리 사용률 (App) | — | 22~23% | 안정 |

튜닝 전 ALB 응답시간은 별도로 기록하지 못했다. 다만 풀 사용률이 93%에서 72%로 내려갔다는 건 connection wait 리스크가 구조적으로 줄었다는 뜻이다. 풀이 상한에 도달하면 대기 시간이 지수적으로 증가하는데, 여유율 확보로 이 구간을 벗어났다.

---

## 자주 하는 실수

1. YAML 숫자만 바꾸고 런타임 반영 검증을 생략한다.
2. 커넥션풀만 올리고 스레드풀은 그대로 둔다.
3. 스레드풀을 과도하게 키워 context switch 비용을 키운다.
4. `minimumIdle`을 과대 설정해 유휴 연결 유지 비용을 키운다.
5. SQL/인덱스 병목을 풀 튜닝으로 해결하려고 한다.

---

## 운영 체크리스트

1. `maximumPoolSize`, `minimumIdle`, `leakDetectionThreshold`를 세트로 다룬다.
2. DB 한도 → 서비스 예산 → 인스턴스별 풀 크기 순서로 계산한다.
3. Tomcat 스레드는 커넥션풀과 함께 조정한다.
4. 한 번에 크게 올리지 않고 단계별로 증설한다.
5. 조정 후 p95/p99 + connection wait + DB wait를 같이 본다.
6. 개선이 약하면 SQL/인덱스/외부 I/O 축으로 원인 분석을 전환한다.

---

## 정리

이번 튜닝의 본질은 숫자 놀이가 아니었다.
"우리 서비스 트래픽에서 필요한 동시 연결 수"를 계산하고, 그 계산에 근거해 단계적으로 확장한 작업이었다.

App Master의 풀 사용률이 93%에서 72%로 내려간 것은 단순히 숫자를 올린 결과가 아니다.
피크 RPS × DB 점유 시간으로 필요한 동시성을 계산하고, 커넥션풀과 Tomcat 스레드를 함께 맞춘 결과다.

계산 없이 직관으로 올리면 과잉 설정과 부족 설정이 섞인다.
계산부터 하고, 단계적으로 올리고, 지표를 세트로 보는 것이 운영에서는 가장 안전했다.

---

## 참고 자료

- HikariCP Configuration: https://github.com/brettwooldridge/HikariCP#configuration-knobs-baby
- Apache Tomcat HTTP Connector: https://tomcat.apache.org/tomcat-10.1-doc/config/http.html
- Spring Boot Externalized Configuration: https://docs.spring.io/spring-boot/reference/features/external-config.html
- Spring Boot Testing: https://docs.spring.io/spring-boot/reference/testing/index.html

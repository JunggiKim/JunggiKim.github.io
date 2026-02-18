---
title: "Spring Boot Docker 최적화 기록: Layered JAR와 AppCDS를 어디까지 적용할 것인가"
date: 2026-02-14 11:00:00 +0900
categories: [tech]
tags: [docker, spring-boot, jvm, appcds, layered-jar]
toc: true
toc_sticky: true
---

> 코드 변경 배포에서 전송량이 커지는 문제를 Layered JAR로 줄이고, AppCDS는 환경 조건에 따라 어느 수준까지 유효한지 측정 결과로 정리한다.

---

## 문제 상황

코드 변경은 작았는데 Docker push/pull 전송량은 매번 크게 나왔다. 원인은 fat JAR 단일 복사 구조였다. 파일 한 바이트가 바뀌어도 JAR 전체가 새 레이어로 인식됐다. 이 구조에서는 코드 변경 배포가 반복될수록 네트워크 낭비가 커진다.

```dockerfile
RUN cp /workspace-src/apis/backoffice/build/libs/*.jar ./backoffice.jar
ENTRYPOINT ["sh", "-c", "exec java -server -jar backoffice.jar"]
```

이 글은 두 가지를 답한다. 첫째, Layered JAR가 전송량을 줄이는 동작 원리는 무엇인가. 둘째, AppCDS가 실제 운영 조건에서 얼마나 유효한가. 결론은 "둘 다 쓰자"가 아니라 "조건별로 분리 판단하자"에 가깝다.

---

## 측정 조건

결과를 해석하려면 측정 조건을 먼저 고정해야 한다. 같은 옵션이라도 OS, 가상화, javaagent 유무에 따라 숫자가 달라진다. 아래 표를 기준으로 Baseline과 Optimized를 비교했다. 재현 시에도 같은 축을 맞추는 것이 좋다.

| 항목 | 값 |
|------|----|
| 런타임 JDK | Temurin 21 |
| 이미지 빌드 방식 | multi-stage Docker |
| Baseline | fat JAR 단일 COPY |
| Optimized | Layered JAR + AppCDS trainer |
| 관측 지표 | 이미지 크기, 코드 변경 전송량, 기동 시간 |
| 환경 분기 | Dev(no agent), Staging/Prod(OTEL javaagent) |

---

## 동작 방식 1: Layered JAR

Layered JAR는 fat JAR 내부를 변경 빈도 기준으로 나눈다. 의존 레이어와 애플리케이션 레이어를 분리하면, 코드 변경 시 상단 레이어만 교체된다. 그래서 전송량이 코드 변경 크기에 더 가까워진다. 이 방식의 핵심은 JAR 분리 자체보다 Docker 레이어 매핑이다.

| 레이어 | 크기 | 변경 빈도 |
|--------|------|-----------|
| dependencies | 185MB | 낮음 |
| spring-boot-loader | 688KB | 매우 낮음 |
| snapshot-dependencies | 4.1KB | 낮음 |
| application | 21.2MB | 높음 |

아래 코드는 레이어 분리와 레이어별 COPY를 수행한다. 목적은 레이어 경계를 변경 빈도와 맞추는 것이다. 이 원칙이 지켜지면 코드 변경 배포에서 전송량이 줄어든다.

```dockerfile
FROM eclipse-temurin:21-jre-jammy AS extractor
WORKDIR /extract

RUN --mount=from=builder,source=/workspace,target=/workspace-src \
    cp /workspace-src/apis/app/build/libs/*.jar app.jar

RUN java -Djarmode=tools -jar app.jar extract --layers --launcher

COPY --from=extractor /extract/app/dependencies/ ./
COPY --from=extractor /extract/app/spring-boot-loader/ ./
COPY --from=extractor /extract/app/snapshot-dependencies/ ./
COPY --from=extractor /extract/app/application/ ./
```

이 구성은 코드 변경 배포에서 `application` 레이어만 교체되게 만든다. 반대로 의존 라이브러리를 바꾸면 `dependencies` 레이어가 다시 만들어진다. 즉, 이득 조건과 비이득 조건이 명확히 갈린다. 그래서 배포 유형별로 기대치를 다르게 두는 편이 맞다.

---

## 동작 방식 2: AppCDS

AppCDS는 클래스 로딩 결과를 아카이브로 저장하고 재사용한다. 목표는 런타임 파싱/검증 비용 일부를 줄이는 것이다. 다만 효과는 classpath 일치 조건에 민감하다. 같은 옵션이어도 agent 유무가 달라지면 적중 범위가 달라질 수 있다.

```text
.class 읽기 -> 바이트코드 파싱/검증 -> 내부 메타데이터 생성
```

아래 trainer 예시는 빌드 단계에서 `.jsa`를 생성하는 방식이다. 이 단계는 런타임 최적화 후보를 미리 준비하는 역할을 한다. 실제 효과는 런타임 classpath 조건에서 다시 확인해야 한다.

```dockerfile
FROM eclipse-temurin:21-jre-jammy AS trainer
WORKDIR /app

COPY --from=extractor /extract/app/dependencies/ ./
COPY --from=extractor /extract/app/spring-boot-loader/ ./
COPY --from=extractor /extract/app/snapshot-dependencies/ ./
COPY --from=extractor /extract/app/application/ ./

RUN java \
    -XX:ArchiveClassesAtExit=/app/app.jsa \
    -Dspring.context.exit=onRefresh \
    -Dspring.main.lazy-initialization=true \
    -Dspring.main.web-application-type=none \
    -Dserver.port=0 \
    -Dspring.data.redis.host=localhost \
    -Dspring.autoconfigure.exclude=\
org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration,\
...10개 AutoConfiguration exclude... \
    org.springframework.boot.loader.launch.JarLauncher || true
```

런타임에는 `-Xshare:auto -XX:SharedArchiveFile=/app/app.jsa`를 사용했다. `-Xshare:auto`를 선택한 이유는 캐시 불일치 시 안전하게 fallback하기 위해서다. 이 선택은 성능보다 안정성 우선 정책에 맞췄다. 운영에서는 이 보수적 설정이 더 다루기 쉬웠다.

---

## 선택 과정

두 기능을 함께 도입할지 여부를 아래 기준으로 비교했다. 기준은 "즉시 이득", "운영 복잡도", "환경 의존성"이었다. 이 표가 실제 도입 순서를 정하는 데 가장 도움이 됐다. 결론은 Layered JAR 선적용, AppCDS 조건부 적용이었다.

| 대안 | 장점 | 단점 | 채택 여부 |
|------|------|------|-----------|
| fat JAR 유지 | 구조 단순 | 코드 변경마다 대용량 전송 | 미채택 |
| Layered JAR만 적용 | 전송량 절감 효과가 빠르게 확인됨 | 기동 최적화는 별도 검토 필요 | 채택 |
| AppCDS만 적용 | 클래스 로딩 최적화 가능성 | 배포 전송량 문제는 남음 | 단독 미채택 |
| Layered JAR + AppCDS | 배포/기동 두 축 동시 개선 시도 가능 | 환경 차이에 따른 편차 관리 필요 | 조건부 채택 |

최종 의사결정은 "문제 크기가 큰 항목부터"였다. 전송량 이슈는 배포마다 반복돼 비용 영향이 컸다. 그래서 Layered JAR를 먼저 고정했다. AppCDS는 환경별 검증을 통과한 범위만 적용하기로 했다.

---

## 결과

먼저 이미지 크기는 아래처럼 줄었다. 감소분에는 레이어 분리 효과와 파일 중복 감소가 함께 반영됐다. 다만 이 수치만으로 배포 시간을 판단하면 부족하다. 코드 변경 배포에서 실제 전송량을 같이 봐야 한다.

| 항목 | Baseline | Optimized | 변화 |
|------|----------|-----------|------|
| 전체 이미지 크기 | 1.69GB | 1.52GB | -170MB |

코드 변경 배포 전송량은 아래처럼 줄었다. 반면 라이브러리 변경에서는 이득이 제한적이었다. 따라서 개선 문구는 "모든 배포"가 아니라 "코드 변경 배포"로 제한해야 정확하다.

| 시나리오 | Baseline | Optimized |
|----------|----------|-----------|
| 코드 변경 | 183MB | 21.2MB |
| 라이브러리 변경 | 183MB | 185MB |

AppCDS 클래스 로딩 분포는 다음과 같았다. 이 결과는 현재 trainer/runtime 조건에서의 관찰값이다. 환경 옵션이 달라지면 분포도 달라질 수 있다.

| 소스 | 클래스 수 | 비율 |
|------|-----------|------|
| CDS(shared objects file) | 10,693 | 35.6% |
| JAR(file:) | 13,243 | 44.1% |
| JDK(jrt:) | 1,414 | 4.7% |
| 기타 | 4,687 | 15.6% |

Docker Desktop의 기동 시간은 아래처럼 나왔다. 여기서는 AppCDS 체감 이득을 확인하지 못했다. 가상화 파일시스템 오버헤드와 측정 편차가 함께 작용한 것으로 봤다.

| Round | Baseline | Optimized |
|-------|----------|-----------|
| R1 | 27.826s | 33.729s |
| R2 | 27.271s | 37.604s |
| 평균 | 27.5s | 35.7s |

---

## 환경별 적용 조건

환경별로 보면 판단이 더 명확해진다. Dev처럼 agent가 없는 경우와 Staging/Prod처럼 agent가 있는 경우를 분리해야 한다. classpath fingerprint 조건이 다르면 AppCDS 적중 범위가 달라질 수 있기 때문이다. 그래서 단일 결론보다 환경별 정책이 필요했다.

| 환경 | APM | AppCDS 해석 |
|------|-----|--------------|
| Dev | 없음 | trainer 조건과 유사해 검증이 쉬움 |
| Staging/Prod | OTEL javaagent | classpath 차이로 적중 범위 재검증 필요 |

운영 정책은 다음처럼 잡았다. Layered JAR는 기본 적용한다. AppCDS는 agent 포함 런타임에서 재검증 후 적용한다. 검증이 끝나기 전에는 성능 개선을 단정하지 않는다.

---

## 정리

이 케이스에서 즉시 재현된 이득은 Layered JAR의 코드 변경 전송량 절감이었다. AppCDS는 적용 가치가 있지만, 환경 조건이 맞을 때 효과를 기대하는 접근이 안전했다. 그래서 일괄 도입보다 문제 우선순위와 환경 검증을 함께 두는 편이 현실적이었다. 다음 단계는 ECS Linux 환경에서 같은 이미지로 AppCDS를 재측정하는 것이다.

같은 고민이 있으시면, 먼저 코드 변경 배포 전송량부터 계측해 보시는 것을 권한다. 이 숫자를 보면 Layered JAR 도입 우선순위를 바로 정할 수 있다. AppCDS는 그다음에 환경 조건을 맞춰 검증하는 순서가 안전했다.

---
title: "코드 한 줄 안 바꿨는데 Docker Push가 183MB에서 21MB로 줄었다"
date: 2026-02-14 11:00:00 +0900
categories: [tech]
tags: [docker, spring-boot, jvm, appcds, layered-jar]
toc: true
toc_sticky: true
---

> Layered JAR과 AppCDS가 무엇이고, 왜 OTEL 환경에서 효과가 달라지는지 실측 데이터로 정리한다.

---

## fat JAR 하나가 매번 183MB를 밀어 올린다

Spring Boot 애플리케이션을 Docker 이미지로 패키징하는 가장 흔한 방식은 fat JAR 통째 복사다.

```dockerfile
# 기존 runtime stage (Dockerfile.backoffice)
RUN cp /workspace-src/apis/backoffice/build/libs/*.jar ./backoffice.jar

ENTRYPOINT ["sh", "-c", "exec java -server -jar backoffice.jar"]
```

간단하고 직관적이다. 문제는 **코드 한 줄을 고쳐도 183MB짜리 JAR 전체가 새 Docker 레이어로 교체**된다는 점이다.

fat JAR 안에는 비즈니스 코드(~21MB)와 3rd-party 라이브러리(~160MB)가 섞여 있다. Docker는 파일 단위로 레이어 캐시를 판단하므로, JAR 내부에서 뭐가 바뀌었는지 모른다. 바이트 하나라도 달라지면 183MB 전체를 다시 push하고, 다시 pull한다.

CI/CD에서 하루에 수십 번 배포한다면, 매번 160MB의 라이브러리를 의미 없이 전송하는 셈이다.

---

## 183MB에서 21MB로: Layered JAR이 코드 변경을 분리하는 방법

Spring Boot 3.2부터 `bootJar`는 기본적으로 Layered JAR을 생성한다. 별도 설정이 필요 없다.

Layered JAR은 fat JAR 내부를 4개 레이어로 나눈다:

| 레이어 | 크기 | 변경 빈도 |
|--------|------|----------|
| dependencies | 185MB | 낮음 (라이브러리 추가/업그레이드 시만) |
| spring-boot-loader | 688KB | 매우 낮음 (Boot 버전 변경 시만) |
| snapshot-dependencies | 4.1KB | 낮음 |
| **application** | **21.2MB** | **높음 (매 배포마다)** |

핵심은 이 4개 레이어를 Docker 레이어에 1:1로 대응시키는 것이다. 변경 빈도가 낮은 레이어를 아래에, 높은 레이어를 위에 배치하면, 코드 변경 시 application 레이어(21.2MB)만 교체된다.

### Dockerfile 변경: extractor stage 추가

```dockerfile
# Layered JAR Extractor 스테이지
FROM eclipse-temurin:21-jre-jammy AS extractor
WORKDIR /extract

RUN --mount=from=builder,source=/workspace,target=/workspace-src \
    cp /workspace-src/apis/app/build/libs/*.jar app.jar

# 4개 레이어로 분리
RUN java -Djarmode=tools -jar app.jar extract --layers --launcher

# Runtime stage: 레이어별 COPY (변경 빈도 낮은 순)
COPY --from=extractor /extract/app/dependencies/ ./
COPY --from=extractor /extract/app/spring-boot-loader/ ./
COPY --from=extractor /extract/app/snapshot-dependencies/ ./
COPY --from=extractor /extract/app/application/ ./
```

`java -Djarmode=tools -jar app.jar extract --layers --launcher` 한 줄이 fat JAR을 4개 디렉토리로 풀어준다.

Runtime stage에서 `COPY`를 4번 나눠 쓰는 게 포인트다. Docker는 각 `COPY`를 별도 레이어로 만든다. dependencies가 변하지 않았으면 캐시 히트, application만 새로 올라간다.

### 실측 효과

| 변경 시나리오 | 기존 (fat JAR) | Layered JAR |
|--------------|---------------|-------------|
| 코드 변경 | 183MB 전체 | **21.2MB** (application만) |
| 라이브러리 추가 | 183MB 전체 | 185MB (dependencies + 하위) |

**코드만 바꾼 일반적인 배포에서 Docker push/pull 대상이 88% 줄었다.** `build.gradle.kts` 수정은 없다. Spring Boot 3.4에서 이미 기본 활성화되어 있으니까.

---

## AppCDS: 10,693개 클래스를 파싱 없이 로딩하기

Layered JAR이 빌드/배포 효율을 개선했다면, AppCDS(Application Class Data Sharing)는 **런타임 기동 속도**를 노린다.

JVM이 클래스를 로딩할 때는 3단계를 거친다:

```
JAR에서 .class 읽기 → 바이트코드 파싱/검증 → 내부 자료구조 생성
```

AppCDS는 이 3단계를 **빌드 타임에 미리 수행하고** 결과를 `.jsa` 파일에 저장한다. 런타임에는 `.jsa`를 메모리에 매핑만 하면 된다. 파싱도, 검증도 건너뛴다.

### trainer stage: 빌드 중에 앱을 한번 시뮬레이션 실행

Dockerfile에 `trainer` 스테이지를 추가한다. 이 스테이지에서 애플리케이션을 한번 띄웠다가 종료하면서 `.jsa` 캐시를 생성한다.

```dockerfile
FROM eclipse-temurin:21-jre-jammy AS trainer
WORKDIR /app

# extractor에서 분리된 레이어 복사
COPY --from=extractor /extract/app/dependencies/ ./
COPY --from=extractor /extract/app/spring-boot-loader/ ./
COPY --from=extractor /extract/app/snapshot-dependencies/ ./
COPY --from=extractor /extract/app/application/ ./

# Training Run: Spring Context 초기화까지만 실행하고 종료
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

`-XX:ArchiveClassesAtExit`는 JVM 종료 시점에 로딩된 모든 클래스를 `.jsa`에 기록한다. `-Dspring.context.exit=onRefresh`는 ApplicationContext refresh 완료 직후 JVM을 종료시킨다. DB 연결이나 HTTP 포트 바인딩 없이, 클래스 로딩만 수행하고 끝내는 설정이다.

### 삽질 5회만에 Training 설정을 잡았다

이론은 단순한데, 실제 Spring Boot 앱에서 에러 없이 Training을 완료하기까지 5번 반복했다.

| 시도 | 추가한 설정 | 해결한 에러 |
|------|-----------|-----------|
| 1 | Notification/Payment/Cache/Storage exclude | 커스텀 AutoConfiguration 에러 |
| 2 | `lazy-initialization=true` | BeanPostProcessor 외 Bean 인스턴스화 에러 |
| 3 | FF4J 3개 AutoConfig exclude 추가 | `ff4j.autowiringpostprocessor` -> DataSource 연쇄 실패 |
| 4 | `web-application-type=none` | Tomcat -> `jwtAuthenticationFilter` -> `tokenProvider` 체인 |
| 5 | `spring.data.redis.host=localhost` | `RedisCacheConfig` -> `RedisConnectionFactory` 누락 |

시도 4가 가장 큰 전환점이었다. Servlet 모드에서 Tomcat이 Filter 타입 빈을 강제로 eager 생성하면서, `JwtAuthenticationFilter` -> `tokenProvider` -> `jwt.secret-key` 순서로 의존성 체인이 터졌다. SecurityAutoConfiguration을 exclude해도 `@EnableWebSecurity`가 component scan 대상이라 무효했다.

Servlet 모드를 포기하고 `web-application-type=none`으로 전환한 이유는 명확하다. Tomcat/MVC 클래스까지 캐시해봤자 적중률이 35.6%에서 37.7%로 **+2%p** 오르는 데 그쳤기 때문이다. 과도한 dummy 설정으로 Training을 불안정하게 만들 가치가 없었다.

### CDS 캐시 적중률: 35.6%

`-Xlog:class+load`로 런타임 시 실제 적중률을 측정했다.

| 소스 | 클래스 수 | 비율 |
|------|----------|------|
| **CDS 캐시 (shared objects file)** | **10,693** | **35.6%** |
| JAR 파일 (file:) | 13,243 | 44.1% |
| JDK (jrt:) | 1,414 | 4.7% |
| 기타 | 4,687 | 15.6% |
| **합계** | **30,037** | **100%** |

30,037개 클래스 중 10,693개가 파싱/검증 없이 메모리 매핑으로 즉시 로드된다. 나머지 64.4%는 Training에서 로딩되지 않은 클래스들이다 -- Servlet/Tomcat/MVC(web-application-type=none이니까), Spring Security/JWT filter chain, JPA/Hibernate 런타임(DB 미연결).

---

## OTEL javaagent가 AppCDS 효과를 깎는다

여기서 한 가지 함정이 있다. **APM agent 유무에 따라 AppCDS 효과가 완전히 달라진다.**

```
# Runtime ENTRYPOINT 분기
if [ "$OTEL_JAVAAGENT_ENABLED" = "true" ]; then
    exec java -server \
        -Xshare:auto -XX:SharedArchiveFile=/app/app.jsa \
        -javaagent:/opt/otel-agent/opentelemetry-javaagent.jar \
        ...
else
    exec java -server \
        -Xshare:auto -XX:SharedArchiveFile=/app/app.jsa \
        ...
fi
```

환경별 차이를 정리하면 이렇다:

| 환경 | APM | AppCDS 캐시 범위 | 이유 |
|------|-----|-----------------|------|
| Dev | 없음 | 전체 캐시 적중 (10,693개) | Training과 동일 조건 |
| Staging/Prod | OTEL javaagent | **JDK 클래스만 캐시** | bootstrap classpath 변경으로 fingerprint 불일치 |

OTEL javaagent는 `-javaagent` 플래그로 JVM에 붙는다. 이때 bootstrap classpath가 Training 시점과 달라지면서, CDS 캐시의 fingerprint가 불일치한다. JVM은 "이 캐시는 다른 환경에서 만들어졌군" 하고 애플리케이션 클래스 캐시를 무시한다. JDK 내장 클래스(jrt: 소스)만 여전히 캐시에서 로드된다.

**`-Xshare:auto`는 이 상황의 안전장치다.** 캐시가 불일치하면 에러를 내지 않고, 그냥 캐시 없이 정상 기동한다. `-Xshare:on`이었다면 앱이 뜨지도 않았을 것이다.

---

## 실측 결과: 숫자로 정리

### 이미지 크기

| 항목 | Baseline | Optimized | 변화 |
|------|----------|-----------|------|
| 전체 이미지 크기 | 1.69GB | 1.52GB | -170MB (-10%) |

170MB 감소의 대부분은 fat JAR(183MB)이 레이어 분리로 대체되면서, 중복 파일이 줄어든 효과다. 반면 63MB짜리 `.jsa` 캐시 파일이 추가됐다.

### Docker 빌드 캐시: 진짜 이득은 여기

| 변경 시나리오 | Baseline | Optimized |
|--------------|----------|-----------|
| 코드 변경 | 183MB JAR 전체 | **21.2MB** application 레이어만 |
| 라이브러리 추가 | 183MB JAR 전체 | 185MB dependencies + 하위 |

CI/CD에서 매일 반복되는 코드 변경 배포마다 **push/pull 대상이 88% 감소**한다. ECR 전송 시간, 네트워크 비용, ECS 태스크 시작 시 이미지 pull 시간 -- 전부 줄어든다.

### 기동 시간: 솔직히 Docker Desktop에서는 개선 안 됐다

| Round | Baseline | Optimized |
|-------|----------|-----------|
| R1 | 27.826s | 33.729s |
| R2 | 27.271s | 37.604s |
| 평균 | 27.5s | 35.7s |

Optimized가 Baseline보다 **8초 느리다.** AppCDS로 기동이 빨라져야 하는 게 아닌가?

세 가지 이유가 있다:

1. **Docker Desktop의 가상 파일시스템**: macOS에서 Docker Desktop은 VirtioFS를 통해 파일시스템을 가상화한다. 63MB `.jsa` 파일의 메모리 매핑이 네이티브 Linux보다 비싸다.
2. **측정 변동폭 자체가 크다**: R3 이후 Baseline도 52초까지 튀었다. Docker Desktop 환경에서 `+-10초` 편차는 일상이다.
3. **OTEL 미사용 환경(Dev)에서만 전체 캐시 적중**: Docker Desktop 테스트는 OTEL 없이 진행했지만, 그래도 가상화 오버헤드가 CDS 이득을 상쇄했다.

**ECS(네이티브 Linux) 환경에서 재측정이 필요하다.** 네이티브 환경에서는 `.jsa` 메모리 매핑이 사실상 `mmap` 한 번이므로, 가상화 오버헤드 없이 순수한 CDS 효과를 측정할 수 있다.

---

## 이번 작업의 실질적 이득은 무엇인가

솔직하게 정리하면 이렇다.

**확실한 이득: Layered JAR의 Docker 빌드 캐시 효율화**

- 코드 변경 시 push/pull 대상: 183MB -> 21MB (88% 감소)
- `build.gradle.kts` 수정 없이, Dockerfile 변경만으로 적용
- Spring Boot 3.2+ 프로젝트라면 지금 바로 적용 가능

**부가적 이득: AppCDS**

- Dev 환경(APM 없음)에서는 10,693개 클래스 캐시 적중
- Staging/Prod 환경(OTEL)에서는 효과가 제한적 (JDK 클래스만)
- Docker Desktop에서는 기동 시간 개선 미확인, ECS 재측정 필요
- `-Xshare:auto` 덕분에 효과가 없더라도 부작용도 없다

Layered JAR은 도입 비용 대비 확실한 리턴을 주는 최적화다. AppCDS는 "켜놓으면 손해는 안 보고, 환경에 따라 이득을 볼 수 있는" 수준이다.

---

## 마무리

JVM 기동 후 첫 요청이 느린 문제는 [Part 1: JVM Warmup](/tech/spring-boot-jvm-warmup-cold-start/)에서 다뤘다. 이번 글의 Layered JAR + AppCDS는 그보다 한 단계 앞인 **빌드/배포 파이프라인**과 **JVM 기동 자체**를 최적화한 작업이다.

두 가지를 가져가자:

1. **Layered JAR은 지금 당장 적용할 수 있다.** `bootJar`에 layered 설정이 이미 있는지 확인하는 것부터 시작하자. Spring Boot 3.2+라면 기본값으로 활성화되어 있다. Dockerfile에서 `extract --layers --launcher` 한 줄 추가하고, `COPY`를 4번으로 나누면 된다.

2. **AppCDS는 환경을 따진 후 결정하자.** OTEL/Pinpoint 같은 javaagent를 쓰고 있다면, Training 시점과 런타임의 classpath가 달라져서 효과가 제한된다. APM 없이 운영하는 서비스라면 시도할 가치가 있다.

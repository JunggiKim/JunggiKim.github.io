---
title: "Spring Boot 배포 후 첫 요청이 느린 이유 — JVM Warmup 로그 기반 분석"
date: 2026-02-14 10:00:00 +0900
categories: [tech]
tags: [spring-boot, jvm, kotlin, ecs, warmup]
toc: true
toc_sticky: true
---

> 배포 직후 첫 API 응답이 3.5초 걸리던 문제를, Warmup 5.2초로 249ms까지 줄인 실제 사례를 로그와 JVM 내부 동작 기준으로 분석한다.

---

## 배포 직후 3.5초 — 서버는 Ready라고 했는데

`Started in 127 seconds` — Spring Boot가 자신 있게 선언한 로그다. 그런데 배포 직후 첫 API 호출에 3.5초가 걸렸다.

```
Spring Boot Ready → 31분 대기 → 첫 사용자 curl → 3,447ms
```

서버는 "준비 완료"라고 했는데, 실제 응답은 3.5초. 대체 무슨 일이 벌어진 걸까?

**`Started`는 "Spring Context가 준비됐다"는 뜻이지, "JVM이 최적 상태"라는 뜻이 아니다.**

Spring Boot가 Ready를 선언한 시점에 아직 일어나지 않은 일들이 있다:

- 수백 개의 클래스가 아직 로딩되지 않음
- Hibernate가 SQL 변환 계획을 아직 만들지 않음
- DB 커넥션이 1개만 열려 있음
- JIT 컴파일러가 아직 아무것도 최적화하지 않음
- DispatcherServlet조차 초기화되지 않음

이 모든 초기화 비용이 **첫 번째 사용자 요청**에 전가된다.

이 글에서는 Warmup 5.2초 동안 JVM 내부에서 무슨 일이 일어나는지 로그 기반으로 분석하고, 실제 구현 코드를 공유한다.

---

## 해결: 5.2초 Warmup으로 초기화 비용을 미리 지불하다

Warmup의 원리는 단순하다. Spring Boot가 Ready를 선언하자마자, 실제 사용자가 오기 전에 주요 API를 미리 한 번씩 호출하는 것이다.

```
Spring Boot Ready → 즉시 Warmup(5.2초) → ECS Health Check 통과 → 사용자 트래픽 수신
```

ECS Health Check가 Warmup 완료 후에야 200을 반환하므로, 이 5.2초는 사용자에게 완전히 투명하다.

### Warmup 구현 코드

`ApplicationReadyEvent`를 수신해서 7개 API를 병렬로 호출하는 코드다.

```kotlin
@Component
class AppWarmup(
    private val componentController: ComponentController,
    private val categoryController: CategoryController,
    private val searchController: SearchController,
    private val popupController: PopupController,
    private val productController: ProductController,
    private val warmupState: WarmupState,
) {
    @EventListener(ApplicationReadyEvent::class)
    fun onReady(event: ApplicationReadyEvent) {
        log.info("[Warmup] Starting warmup...")

        runBlocking {
            runCatching {
                withTimeout(WARMUP_TIMEOUT_MS) {
                    listOf(
                        asyncIO { componentController.getComponents(userId = null) },
                        asyncIO { componentController.getLatestProducts(...) },
                        asyncIO { categoryController.getCategoriesByParent(parentCategoryId = 0) },
                        asyncIO { searchController.getAutoComplete(keyword = "a", limit = 10) },
                        asyncIO { searchController.searchProducts(...) },
                        asyncIO { popupController.getActivePopupList(page = 0, size = 10) },
                        asyncIO { productController.getRecommendedProducts(...) },
                    ).awaitAll()
                }
            }.onFailure { e ->
                log.warn("[Warmup] Warmup timed out or failed, proceeding anyway", e)
            }
        }

        warmupState.setReady()
        log.info("[Warmup] Warmup completed, application is ready")
    }
}
```

핵심은 두 가지다. 첫째, Controller를 직접 호출해서 Spring MVC 전체 경로(인터셉터, AOP, 직렬화)를 통과시킨다. 둘째, `asyncIO`로 7개 API를 병렬 실행해 총 Warmup 시간을 5.2초로 줄였다.

### Health Check와 Warmup 상태 연동

Warmup이 끝나기 전에 트래픽이 들어오면 의미가 없다. `WarmupState`로 상태를 관리하고, Health Check에 연동한다.

```kotlin
@GetMapping("/actuator/health")
fun actuatorHealth(): ResponseEntity<Map<String, String>> {
    return if (warmupState.isReady()) {
        ResponseEntity.ok(mapOf("status" to "UP", "warmup" to "completed"))
    } else {
        ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
            .body(mapOf("status" to "DOWN", "warmup" to "in_progress"))
    }
}
```

`WarmupState`는 `AtomicBoolean` 하나로 구현한 단순한 컴포넌트다. Warmup이 완료되면 `setReady()`를 호출하고, 그때부터 ECS Health Check가 200을 반환한다. ECS는 200을 확인한 뒤에야 Target Group에 인스턴스를 등록하므로, 사용자 트래픽은 Warmup 완료 후에만 유입된다.

그런데 이 5.2초 동안 JVM 내부에서 **정확히 무슨 일이 일어나는 걸까?** 실제 운영 로그를 기반으로 하나씩 추적해 보자.

---

## 1단계: Spring Boot Startup — Warmup 이전, Before/After 동일

먼저 Spring Boot가 Ready를 선언하기까지의 과정을 보자. 이 부분은 Warmup 유무와 무관하게 동일하다.

| 시점 | 이벤트 | 소요 |
|------|--------|------|
| +0s | JVM 시작, OTel Agent 로딩 | ~13s |
| +13s | Spring Boot 시작 | - |
| +16s | Bean 등록 + DataSource/Flyway 조기 초기화 | ~3s |
| +19s | Tomcat 시작 | ~1s |
| +23s | Flyway migration 검증 (111개) | ~4s |
| +26s | HikariCP 커넥션 풀 시작 (첫 DB 연결 1개) | ~0.1s |
| +34s | JTA Platform 초기화 | ~8s |
| +41s | FCM/SES/S3 클라이언트 초기화 | ~10s |
| +90s | FF4J 초기화 | - |
| +127s | **Started DeartailAppApplicationKt** | - |

여기까지가 Spring의 영역이다. Bean 등록, DataSource 연결, Tomcat 기동. **차이는 이 다음부터 갈린다.**

---

## 2단계: Warmup이 트리거하는 JVM 내부 동작

Warmup은 7개 API를 실제로 호출한다. 겉으로는 "HTTP 요청 7번"이지만, JVM 내부에서는 5가지 최적화가 동시에 진행된다.

### 3,447ms → 249ms: 수백 개의 Lazy 클래스가 한꺼번에 로딩되는 순간

JVM은 클래스를 **처음 참조할 때** 로딩한다. Spring Boot가 Ready를 선언해도 실제로 사용되지 않은 클래스는 메모리에 올라와 있지 않다.

Warmup 없이 첫 사용자가 `/api/v1/home`을 호출하면 다음과 같은 로그가 남는다:

```
17:40:08.690  HTTP Request (/api/v1/home)
17:40:09.154  ComponentServiceImpl.getHome          ← 432ms
17:40:10.640  findActiveComponentBanners             ← 980ms
17:40:11.365  findActiveComponentsBySection           ← 591ms
17:40:12.137  ComponentController.getComponents 완료
              ────────────────────────────────────
              총 소요: 3,447ms
```

같은 API를 Warmup이 먼저 호출하면 클래스 로딩 비용을 Warmup이 흡수한다:

```
18:26:18.447  [Warmup] Starting warmup...
18:26:20.142  ComponentServiceImpl.getHome          ← 1,291ms (클래스 로딩 비용)
18:26:23.647  [Warmup] home 완료                    ← 5.2초 소요
```

그 뒤 실제 사용자의 첫 요청에서는 이미 로딩된 클래스를 재사용한다:

```
18:41:14.484  HTTP Request (/api/v1/home)
18:41:14.497  ComponentServiceImpl.getHome          ← 2ms  (이미 로딩됨)
18:41:14.544  findActiveComponentsBySection           ← 17ms (vs Before 591ms)
18:41:14.733  ComponentController.getComponents 완료
              ────────────────────────────────────
              총 소요: 249ms
```

**3,447ms → 249ms.** 같은 코드, 같은 서버, 같은 DB인데 14배 차이다.

Warmup 때 최초 로딩되는 클래스들은 다음과 같다:

| 카테고리 | 주요 클래스 | 특징 |
|----------|-----------|------|
| QueryDSL Q-class | `QProduct`, `QCategory`, `QComponent` 등 | 컴파일타임 생성, 런타임 첫 참조 시 로딩 |
| JPA 프록시 | Hibernate lazy proxy (`$_jvst`, CGLIB) | 엔티티별 동적 바이트코드 생성 |
| Spring AOP 프록시 | `$SpringCGLIB$` 접미사 클래스들 | Controller/Service 프록시 |
| MySQL Connector | `com.mysql.cj.jdbc.*` | Prepared Statement 캐시, 프로토콜 핸들러 |
| Jackson 직렬화기 | DTO별 Serializer/Deserializer | 첫 직렬화 시 리플렉션으로 생성 |

이 클래스들은 Spring Boot가 Ready를 선언한 시점에 아직 메모리에 없다. **누군가 처음 호출해야 로딩된다.** Warmup이 바로 그 "누군가" 역할을 한다.

### 커넥션 1개 → 풀 워밍업: HikariCP가 나머지를 채우는 과정

Spring Boot 시작 시 HikariCP 로그를 보자:

```
18:24:40.430  core-db-pool - Starting...
18:24:40.529  core-db-pool - Added connection com.mysql.cj.jdbc.ConnectionImpl@1eb925ab
18:24:40.550  core-db-pool - Start completed.
```

HikariCP는 시작 시 **최소 커넥션 1개**만 생성한다. `maximum-pool-size: 5`로 설정해도 나머지 4개는 실제 요청이 올 때 lazy하게 만들어진다.

DB 커넥션 1개를 새로 만드는 데 필요한 과정은 이렇다:

- TCP 3-way handshake
- MySQL 프로토콜 인증
- SSL negotiation (활성화된 경우)
- 서버 변수 교환

커넥션마다 수십~수백ms가 소요된다.

Warmup이 7개 API를 호출하면 동시에 여러 DB 쿼리가 실행되고, HikariCP가 추가 커넥션을 미리 생성한다. `cachePrepStmts: true, prepStmtCacheSize: 250` 설정에 의해 **Prepared Statement 캐시**도 이 시점에 채워지기 시작한다.

### 315ms → 110ms: C1 JIT 컴파일이 만드는 차이

Java 코드는 처음에 **인터프리터 모드**로 실행된다. 바이트코드를 한 줄씩 해석하는 방식이라 느리다. JIT(Just-In-Time) 컴파일러가 자주 호출되는 메서드를 감지하면, 해당 메서드를 네이티브 기계어로 변환한다.

Java 21의 `-server` 플래그는 **Tiered Compilation**(단계별 컴파일)을 사용한다:

```
[1단계] 메서드 첫 호출 → 인터프리터 모드 (가장 느림)
[2단계] 호출 횟수 증가 → C1 컴파일 (중간 최적화)
[3단계] 핫스팟 감지  → C2 컴파일 (공격적 최적화: 인라이닝, 루프 언롤링, escape analysis)
```

Warmup이 7개 API를 한 번씩 호출하는 것만으로 C2 임계값(~10,000회)에 도달하지는 않는다. 하지만 **C1 컴파일은 트리거된다.** QueryDSL의 `where()`, `join()`, `fetchJoin()` 같은 빌더 패턴 메서드들이 C1 최적화 대상이다.

이 차이는 로그에서도 드러난다:

```
Before: 2번째 /home 요청도 315ms (아직 인터프리터 실행)
After:  2번째 /home 요청은 110ms (warmup 후 C1 컴파일 적용)
```

C1만으로도 인터프리터 대비 3배 가까이 빨라졌다.

### 980ms → 17ms: Hibernate 메타데이터 캐시가 채워지는 순간

Hibernate가 **특정 쿼리를 처음 실행할 때** 내부적으로 수행하는 작업은 네 단계다:

1. JPQL/QueryDSL → SQL 변환 (파싱 + 변환 계획 생성)
2. ResultSet → Entity 매핑 정보 구축 (리플렉션으로 필드 매핑)
3. Lazy 프록시 클래스 동적 생성 (ByteBuddy로 바이트코드 생성)
4. PreparedStatement 생성 + MySQL 서버에 `PREPARE` 전송

이 결과는 Hibernate의 내부 캐시에 저장된다. 두 번째 호출부터는 캐시 히트로 빠르게 처리된다.

Warmup 없이 이 비용이 첫 사용자 요청에 전가되면 이런 숫자가 나온다:

```
findActiveComponentBanners: 980ms  ← SQL 변환 + 프록시 생성 + 매핑 구축 전부 포함
```

Warmup 후에는 SQL 실행만 남는다:

```
findActiveComponentBanners: ~17ms  ← 캐시 히트, SQL 실행만
```

`default_batch_fetch_size: 100` 설정이 있으면, Hibernate가 첫 batch fetch 시 `IN` 절 SQL을 동적으로 생성하고 파라미터 바인딩 전략을 결정하는데, 이것도 Warmup에서 완료된다.

### DispatcherServlet — Ready 후에도 초기화되지 않은 마지막 조각

의외의 차이가 하나 더 있다. Spring의 `DispatcherServlet`은 **첫 HTTP 요청이 올 때** 비로소 초기화된다.

```
Before:
18:08:42.270  Started DeartailAppApplicationKt
18:08:51.746  Initializing Spring DispatcherServlet    ← Ready 후 9.5초 뒤 (첫 요청 시)

After:
18:26:18.162  Started DeartailAppApplicationKt
18:26:18.447  [Warmup] Starting warmup...
18:26:31.047  Initializing Spring DispatcherServlet    ← Warmup이 트리거
```

DispatcherServlet 초기화에는 핸들러 매핑 구축, 인터셉터 체인 설정 등이 포함된다. Before에서는 이 비용이 첫 사용자 요청에 추가되고, After에서는 Warmup 과정에서 흡수된다.

---

## 정리: Warmup 5.2초 동안 일어난 일

| 최적화 | 내용 | Warmup 없을 때 | Warmup 후 |
|--------|------|---------------|-----------|
| **클래스 로딩** | QueryDSL Q-class, JPA Proxy, AOP Proxy, Jackson Serializer 등 수백 개 | 첫 요청에 ~2초 | Warmup에서 흡수 |
| **HikariCP 풀** | 추가 DB 커넥션 생성 + MySQL handshake | 첫 요청에 ~200ms | Warmup에서 흡수 |
| **Hibernate 메타데이터** | SQL 변환, 엔티티 매핑, Lazy Proxy 생성, PreparedStatement 캐시 | 첫 요청에 ~800ms | Warmup에서 흡수 |
| **JIT C1 컴파일** | 핫 경로 메서드 기계어 변환 | 첫~두 번째 요청에서 인터프리터 실행 | Warmup 후 C1 최적화 적용 |
| **DispatcherServlet** | 핸들러 매핑, 인터셉터 체인 구축 | 첫 요청에 ~500ms | Warmup에서 흡수 |

**Warmup 5.2초는 "낭비"가 아니다.** 사용자 첫 요청이 부담할 3.5초의 초기화 비용을 미리 지불한 것이다.

---

## Before vs After — 실제 숫자로 확인하기

```
[Before]  첫 /api/v1/home: 3,447ms
[After]   첫 /api/v1/home:   249ms   ← 14배 빨라짐
```

| 메서드 | Before (첫 호출) | After (Warmup 후 첫 호출) |
|--------|-----------------|--------------------------|
| `ComponentServiceImpl.getHome` | 432ms | **2ms** |
| `findActiveComponentBanners` | 980ms | **~17ms** |
| `findActiveComponentsBySection` | 591ms | **17ms** |

Staging 환경에서의 벤치마크도 같은 패턴을 보여준다:

| API | Before | After | 개선율 |
|-----|--------|-------|--------|
| 첫 `/api/v1/home` | 3.539s | 0.403s | 88.6% |
| 첫 `/api/v1/popups` | 0.344s | 0.064s | 81.4% |
| 2번째 `/api/v1/home` | 0.315s | 0.110s | 65.1% |

Warmup 소요 시간은 약 5.2초(7개 API 병렬)이고, 총 Ready 시간은 131.6초에서 132.0초로 거의 차이가 없다.

---

## 마무리: Started는 시작일 뿐이다

Spring Boot의 `Started in X seconds`는 **"Spring이 준비됐다"**는 의미이지, **"JVM이 최적 상태"**라는 의미가 아니다.

JVM은 본질적으로 lazy하다. 클래스 로딩, JIT 컴파일, Hibernate 캐시, DB 커넥션 — 전부 "필요할 때" 초기화한다. 이 설계는 메모리 효율과 시작 속도에 유리하지만, **첫 번째 요청의 응답 시간을 희생한다.**

Warmup은 이 비용을 사용자가 아닌 시스템이 부담하도록 시점을 앞당기는 전략이다. 구현 자체는 단순하지만, 그 5.2초 안에 클래스 로딩, 커넥션 풀, JIT 컴파일, Hibernate 캐시, DispatcherServlet 초기화가 모두 완료된다. ECS Health Check가 Warmup 완료 후에만 200을 반환하므로, 배포 후 첫 사용자는 "콜드 스타트"를 경험하지 않는다.

ECS Health Check에 Warmup 상태를 연동하는 것부터 시작해 보자. `WarmupState` 컴포넌트 하나와 Health Check 엔드포인트 수정만으로 구현할 수 있다.

다음 편에서는 [Docker 이미지 빌드 최적화(Layered JAR + AppCDS)](/tech/spring-boot-docker-appcds-layered-jar/)로 CI/CD 배포 시간을 줄이는 방법을 다룬다.

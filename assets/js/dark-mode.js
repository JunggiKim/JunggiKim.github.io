// ═══════════════════════════════════════════════════════════════
// Dark Mode Toggle Script
// ═══════════════════════════════════════════════════════════════

(function() {
  const STORAGE_KEY = 'theme-preference';

  // 저장된 테마 또는 시스템 설정 가져오기
  const getColorPreference = () => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return stored;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  };

  // 테마 적용
  const setPreference = () => {
    localStorage.setItem(STORAGE_KEY, theme.value);
    reflectPreference();
  };

  // DOM에 테마 반영
  const reflectPreference = () => {
    document.documentElement.setAttribute('data-theme', theme.value);

    // 토글 버튼 아이콘 업데이트
    const toggleBtn = document.querySelector('.dark-mode-toggle');
    if (toggleBtn) {
      const icon = toggleBtn.querySelector('.icon');
      if (icon) {
        icon.textContent = theme.value === 'dark' ? '☀️' : '🌙';
      }
      toggleBtn.setAttribute('aria-label',
        theme.value === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    }

    // Giscus 테마 업데이트
    const giscusFrame = document.querySelector('iframe.giscus-frame');
    if (giscusFrame) {
      const giscusTheme = theme.value === 'dark' ? 'dark' : 'light';
      giscusFrame.contentWindow.postMessage(
        { giscus: { setConfig: { theme: giscusTheme } } },
        'https://giscus.app'
      );
    }
  };

  // 테마 상태 객체
  const theme = {
    value: getColorPreference(),
  };

  // 페이지 로드 전 테마 적용 (깜빡임 방지)
  reflectPreference();

  // DOM 로드 후 이벤트 리스너 등록
  window.addEventListener('DOMContentLoaded', () => {
    reflectPreference();

    // 토글 버튼 클릭 이벤트
    const toggleBtn = document.querySelector('.dark-mode-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        theme.value = theme.value === 'light' ? 'dark' : 'light';
        setPreference();
      });
    }
  });

  // 시스템 테마 변경 감지
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', ({ matches: isDark }) => {
      if (!localStorage.getItem(STORAGE_KEY)) {
        theme.value = isDark ? 'dark' : 'light';
        reflectPreference();
      }
    });
})();

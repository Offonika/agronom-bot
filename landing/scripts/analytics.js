'use strict';

/**
 * Яндекс.Метрика + события
 * ID счётчика задаётся через METRIKA_ID
 */

(function() {
  // Placeholder для ID Метрики — заменить на реальный
  const METRIKA_ID = window.METRIKA_ID || 'XXXXXXXX';
  const CTA_FALLBACK_DELAY_MS = 450;
  
  /**
   * Инициализация Яндекс.Метрики
   */
  function initMetrika() {
    // Яндекс.Метрика counter code
    (function(m,e,t,r,i,k,a){
      m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
      m[i].l=1*new Date();
      for (var j = 0; j < document.scripts.length; j++) {
        if (document.scripts[j].src === r) { return; }
      }
      k=e.createElement(t);
      a=e.getElementsByTagName(t)[0];
      k.async=1;
      k.src=r;
      a.parentNode.insertBefore(k,a);
    })(window, document, "script", "https://mc.yandex.ru/metrika/tag.js?id=" + METRIKA_ID, "ym");

    if (METRIKA_ID !== 'XXXXXXXX') {
      ym(METRIKA_ID, "init", {
        ssr: true,
        webvisor: true,
        clickmap: true,
        ecommerce: "dataLayer",
        accurateTrackBounce: true,
        trackLinks: true
      });
    }
  }

  /**
   * Получение UTM-данных для событий
   */
  function getUTMParams() {
    try {
      const stored = sessionStorage.getItem('utm_data');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {}
    
    return window.__UTM_DATA__ || {};
  }

  /**
   * Сбор параметров события
   */
  function buildEventParams(params = {}) {
    const utm = getUTMParams();
    return {
      ...params,
      utm_source: utm.src || 'direct',
      utm_medium: utm.med || 'organic',
      utm_campaign: utm.cmp || ''
    };
  }

  /**
   * Логирование событий (минимум, чтобы не шуметь)
   */
  function logEvent(eventName, eventParams) {
    console.log('[Analytics]', eventName, eventParams);
  }

  /**
   * Отправка события в Метрику
   */
  function sendEvent(eventName, params = {}) {
    const eventParams = buildEventParams(params);
    logEvent(eventName, eventParams);

    // Отправляем в Метрику если ID задан
    if (typeof ym === 'function' && METRIKA_ID !== 'XXXXXXXX') {
      ym(METRIKA_ID, 'reachGoal', eventName, eventParams);
    }
  }

  /**
   * Трекинг кликов по CTA
   */
  function trackCTAClicks() {
    document.querySelectorAll('[data-cta="telegram"]').forEach(link => {
      link.addEventListener('click', function(e) {
        const targetUrl = this.href;
        if (!targetUrl) {
          return;
        }

        // Do not break open-in-new-tab / middle-click behavior.
        const isModifiedClick = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
        const isBlankTarget = (this.getAttribute('target') || '').toLowerCase() === '_blank';
        if (isModifiedClick || isBlankTarget) {
          const position = this.dataset.position || 'unknown';
          sendEvent('cta_click', { position: position });
          return;
        }

        e.preventDefault();
        const position = this.dataset.position || 'unknown';
        const eventParams = buildEventParams({ position: position });
        logEvent('cta_click', eventParams);

        let hasRedirected = false;
        const redirect = () => {
          if (hasRedirected) return;
          hasRedirected = true;
          window.location.href = targetUrl;
        };

        const fallbackTimer = setTimeout(redirect, CTA_FALLBACK_DELAY_MS);

        if (typeof ym === 'function' && METRIKA_ID !== 'XXXXXXXX') {
          ym(METRIKA_ID, 'reachGoal', 'cta_click', eventParams, () => {
            clearTimeout(fallbackTimer);
            redirect();
          });
        } else {
          clearTimeout(fallbackTimer);
          redirect();
        }
      });
    });
  }

  /**
   * Трекинг кастомных кликов (например, переход на /green-windows/)
   * Использование: data-track-click="event_name"
   */
  function trackCustomClickEvents() {
    document.querySelectorAll('[data-track-click]').forEach(el => {
      el.addEventListener('click', function(e) {
        const eventName = this.dataset.trackClick || '';
        if (!eventName) return;

        const isLink = this.tagName === 'A';
        const targetUrl = isLink ? this.getAttribute('href') : null;

        const baseParams = {
          label: (this.dataset.trackLabel || '').toString(),
          href: (targetUrl || '').toString()
        };

        // Если это ссылка с навигацией, используем fallback-редирект, чтобы событие успело отправиться.
        if (isLink && targetUrl && !targetUrl.startsWith('#')) {
          const isModifiedClick = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
          const isBlankTarget = (this.getAttribute('target') || '').toLowerCase() === '_blank';
          if (isModifiedClick || isBlankTarget) {
            sendEvent(eventName, baseParams);
            return;
          }

          e.preventDefault();
          const eventParams = buildEventParams(baseParams);

          let hasRedirected = false;
          const redirect = () => {
            if (hasRedirected) return;
            hasRedirected = true;
            window.location.href = targetUrl;
          };

          const fallbackTimer = setTimeout(redirect, CTA_FALLBACK_DELAY_MS);

          if (typeof ym === 'function' && METRIKA_ID !== 'XXXXXXXX') {
            ym(METRIKA_ID, 'reachGoal', eventName, eventParams, () => {
              clearTimeout(fallbackTimer);
              redirect();
            });
          } else {
            clearTimeout(fallbackTimer);
            redirect();
          }

          return;
        }

        sendEvent(eventName, baseParams);
      });
    });
  }

  /**
   * Трекинг просмотра блоков (IntersectionObserver)
   * Использование: data-track-view="event_name"
   */
  function trackCustomViewEvents() {
    const tracked = document.querySelectorAll('[data-track-view]');
    if (tracked.length === 0) return;

    const seen = new Set();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const eventName = el.dataset.trackView || '';
        if (!eventName) return;
        if (seen.has(el)) return;

        seen.add(el);
        sendEvent(eventName, { section: el.id || 'unknown' });
        observer.unobserve(el);
      });
    }, { threshold: 0.35 });

    tracked.forEach(el => observer.observe(el));
  }

  /**
   * Трекинг просмотра секции тарифов (IntersectionObserver)
   */
  function trackPricingView() {
    const pricingSection = document.getElementById('pricing');
    if (!pricingSection) return;
    
    let hasTracked = false;
    
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && !hasTracked) {
          hasTracked = true;
          sendEvent('pricing_view', { section: 'pricing' });
          observer.disconnect();
        }
      });
    }, { threshold: 0.5 });
    
    observer.observe(pricingSection);
  }

  /**
   * Трекинг открытия FAQ
   */
  function trackFAQOpen() {
    document.querySelectorAll('[data-faq]').forEach(item => {
      item.addEventListener('click', function() {
        const question = this.dataset.faq || 'unknown';
        sendEvent('faq_open', { question: question });
      });
    });
  }

  /**
   * Scroll-анимации (fade-in)
   */
  function initScrollAnimations() {
    const animatedElements = document.querySelectorAll('[data-animate]');
    
    if (animatedElements.length === 0) return;
    
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('animate-fade-in');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });
    
    animatedElements.forEach(el => {
      el.classList.add('opacity-0', 'translate-y-4');
      observer.observe(el);
    });
  }

  /**
   * Инициализация всех трекеров
   */
  function init() {
    initMetrika();
    trackCTAClicks();
    trackCustomClickEvents();
    trackCustomViewEvents();
    trackPricingView();
    trackFAQOpen();
    initScrollAnimations();
  }

  // Запуск при загрузке DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Экспорт для тестирования
  window.Analytics = {
    sendEvent,
    getUTMParams
  };
})();






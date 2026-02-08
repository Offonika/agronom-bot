'use strict';

/**
 * UTM → Telegram Start Payload
 * Парсит UTM-параметры из URL, компактифицирует и кодирует в base64url
 */

(function() {
  const BOT_USERNAME = 'AgronommAI_bot';
  const DEFAULT_PAYLOAD = 'src=direct|med=organic';
  
  // Маппинг UTM → короткие ключи
  const UTM_MAP = {
    utm_source: 'src',
    utm_medium: 'med',
    utm_campaign: 'cmp',
    utm_content: 'cnt',
    utm_term: 'trm'
  };

  /**
   * Парсинг UTM из URL
   */
  function parseUTM() {
    const params = new URLSearchParams(window.location.search);
    const utm = {};
    
    for (const [longKey, shortKey] of Object.entries(UTM_MAP)) {
      const value = params.get(longKey);
      if (value) {
        // Ограничиваем длину значения для компактности
        utm[shortKey] = value.substring(0, 20);
      }
    }
    
    return utm;
  }

  /**
   * Компактификация UTM в строку
   */
  function compactify(utm) {
    if (Object.keys(utm).length === 0) {
      return DEFAULT_PAYLOAD;
    }
    
    return Object.entries(utm)
      .map(([k, v]) => `${k}=${v}`)
      .join('|');
  }

  /**
   * Base64 URL-safe кодирование
   */
  function base64urlEncode(str) {
    // Используем TextEncoder для корректной работы с UTF-8
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, ''); // Удаляем padding
  }

  /**
   * Генерация Telegram-ссылки с payload
   */
  function generateTelegramLink(payload) {
    const encoded = base64urlEncode(payload);
    // Telegram ограничивает start payload до 64 символов
    const safePayload = encoded.substring(0, 64);
    return `https://t.me/${BOT_USERNAME}?start=${safePayload}`;
  }

  /**
   * Обновление всех CTA-ссылок на странице
   */
  function updateCTALinks() {
    const utm = parseUTM();
    const payload = compactify(utm);
    const telegramLink = generateTelegramLink(payload);
    
    // Находим все CTA-кнопки с data-cta атрибутом
    const ctaLinks = document.querySelectorAll('[data-cta="telegram"]');
    
    ctaLinks.forEach(link => {
      link.href = telegramLink;
    });
    
    // Сохраняем UTM в sessionStorage для аналитики
    if (Object.keys(utm).length > 0) {
      sessionStorage.setItem('utm_data', JSON.stringify(utm));
    }
    
    // Экспортируем для аналитики
    window.__UTM_DATA__ = utm;
    window.__TELEGRAM_LINK__ = telegramLink;
  }

  // Инициализация при загрузке DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateCTALinks);
  } else {
    updateCTALinks();
  }

  // Экспорт для тестирования
  window.UTMHandler = {
    parseUTM,
    compactify,
    base64urlEncode,
    generateTelegramLink,
    updateCTALinks
  };
})();











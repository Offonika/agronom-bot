# Лендинг «Карманный агроном»

Статический одностраничник для продвижения Telegram-бота [@AgronommAI_bot](https://t.me/AgronommAI_bot).

## Структура

```
landing/
├── index.html           # Основная страница
├── plant-disease-photo/ # Пиллар-страница: болезнь по фото
├── green-windows/       # Пиллар-страница: зелёные окна
├── phi/                 # Пиллар-страница: PHI
├── best-plant-disease-apps/ # Пиллар-страница: лучшие приложения
├── og-image.png         # OG-картинка (1200×630)
├── assets/
│   ├── favicon.svg      # Иконка сайта
│   ├── og-image.svg     # OG-картинка (fallback)
│   └── og-image.png     # OG-картинка (1200×630)
├── scripts/
│   ├── utm.js           # UTM → Telegram payload
│   └── analytics.js     # Яндекс.Метрика + события
├── legal/
│   ├── privacy.html     # Политика конфиденциальности
│   └── offer.html       # Публичная оферта
├── robots.txt           # robots.txt
├── sitemap.xml          # sitemap.xml
├── deploy.sh            # Скрипт деплоя
└── README.md
```

## Быстрый старт

### Локальный просмотр

```bash
cd landing
python3 -m http.server 8080
# Открыть http://localhost:8080
```

### Деплой на сервер

```bash
chmod +x deploy.sh
./deploy.sh root@your-server
```

По умолчанию деплоит на `root@agronom.offonika.ru:/var/www/agronom`.

## Настройка

### 1. Яндекс.Метрика

В `index.html` замените placeholder на реальный ID счётчика:

```html
<script>
  window.METRIKA_ID = '12345678';  // ← ваш ID
</script>
```

### 2. OG-картинка

Используется `og-image.png` размером 1200×630 px для превью в Telegram и соцсетях.

### 3. UTM-параметры

Все CTA-ссылки автоматически подхватывают UTM из URL:

```
https://agronom.offonika.ru/?utm_source=tg&utm_medium=cpc&utm_campaign=jan25
```

UTM кодируется в base64url и передаётся в Telegram `start` payload:
```
https://t.me/AgronommAI_bot?start=c3JjPXRnfG1lZD1jcGN8Y21wPWphbjI1
```

## Apache конфигурация

### VirtualHost (HTTPS)

Добавьте в `/etc/apache2/sites-available/agronom.conf`:

```apache
<VirtualHost *:443>
  ServerName agronom.offonika.ru
  DocumentRoot /var/www/agronom

  # Юридические документы
  Alias /privacy /var/www/agronom/legal/privacy.html
  Alias /offer /var/www/agronom/legal/offer.html

  <Directory /var/www/agronom>
    Require all granted
    Options -Indexes
  </Directory>

  # Gzip
  <IfModule mod_deflate.c>
    AddOutputFilterByType DEFLATE text/html text/css application/javascript image/svg+xml
  </IfModule>

  # Cache static assets
  <IfModule mod_headers.c>
    <FilesMatch "\.(css|js|svg|png|webp|woff2)$">
      Header set Cache-Control "public, max-age=31536000, immutable"
    </FilesMatch>
  </IfModule>

  # Security headers
  <IfModule mod_headers.c>
    Header always set X-Content-Type-Options "nosniff"
    Header always set X-Frame-Options "SAMEORIGIN"
    Header always set Referrer-Policy "strict-origin-when-cross-origin"
  </IfModule>

  # SSL (certbot)
  SSLEngine on
  SSLCertificateFile /etc/letsencrypt/live/agronom.offonika.ru/fullchain.pem
  SSLCertificateKeyFile /etc/letsencrypt/live/agronom.offonika.ru/privkey.pem
  Include /etc/letsencrypt/options-ssl-apache.conf
</VirtualHost>
```

### HTTP → HTTPS редирект

```apache
<VirtualHost *:80>
  ServerName agronom.offonika.ru
  RewriteEngine on
  RewriteRule ^ https://%{SERVER_NAME}%{REQUEST_URI} [END,NE,R=permanent]
</VirtualHost>
```

### Включение модулей

```bash
sudo a2enmod headers deflate rewrite ssl
sudo a2ensite agronom
sudo systemctl reload apache2
```

### SSL-сертификат (Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-apache
sudo certbot --apache -d agronom.offonika.ru
```

## События аналитики

| Событие | Когда срабатывает | Параметры |
|---------|-------------------|-----------|
| `cta_click` | Клик по CTA-кнопке | `position`, `utm_source`, `utm_medium`, `utm_campaign` |
| `pricing_view` | Скролл до тарифов (50% видимости) | `section` |
| `faq_open` | Открытие вопроса FAQ | `question` |

## Тестирование UTM

Откройте с UTM-параметрами:
```
http://localhost:8080/?utm_source=test&utm_medium=cpc&utm_campaign=demo
```

Проверьте в DevTools:
```javascript
console.log(window.__UTM_DATA__);        // {src: 'test', med: 'cpc', cmp: 'demo'}
console.log(window.__TELEGRAM_LINK__);   // https://t.me/AgronommAI_bot?start=...
```

## Чеклист перед запуском

- [ ] Заменить `METRIKA_ID` на реальный ID счётчика
- [ ] Проверить `og-image.png` (1200×630)
- [ ] Проверить UTM → payload на 2-3 ссылках
- [ ] Настроить Apache VirtualHost
- [ ] Получить SSL-сертификат через certbot
- [ ] Проверить `/privacy` и `/offer` работают
- [ ] Проверить `robots.txt` и `sitemap.xml` доступны
- [ ] Протестировать на мобильном

## Контакты

- **Бот:** [@AgronommAI_bot](https://t.me/AgronommAI_bot)
- **Поддержка:** [/support в боте](https://t.me/AgronommAI_bot)

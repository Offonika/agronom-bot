import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1000,
  duration: '60s',
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const API_KEY = __ENV.API_KEY || 'test-api-key';
const API_VER = __ENV.API_VER || 'v1';

function headers(extra = {}) {
  return Object.assign(
    {
      'X-API-Key': API_KEY,
      'X-API-Ver': API_VER,
      'Content-Type': 'application/json',
    },
    extra,
  );
}

export default function () {
  const diagnoseBody = JSON.stringify({ image_base64: 'dGVzdA==', prompt_id: 'v1' });
  let res = http.post(`${BASE_URL}/v1/ai/diagnose`, diagnoseBody, { headers: headers() });
  check(res, { 'diagnose:200': (r) => r.status === 200 });

  res = http.get(`${BASE_URL}/v1/photos/history?limit=1`, { headers: headers() });
  check(res, { 'history:200': (r) => r.status === 200 });

  const createBody = JSON.stringify({ plan: 'pro' });
  res = http.post(`${BASE_URL}/v1/payments/create`, createBody, { headers: headers() });
  check(res, { 'create:200': (r) => r.status === 200 });

  const paymentId = res.json('payment_id') || '1';
  const webhookBody = JSON.stringify({ payment_id: paymentId, status: 'paid' });
  res = http.post(`${BASE_URL}/v1/payments/sbp/webhook`, webhookBody, { headers: headers({ 'X-Sign': 'test' }) });
  check(res, { 'webhook:200': (r) => r.status === 200 });

  sleep(1);
}

export function handleSummary(data) {
  const summary = {
    http_req_duration_p95: data.metrics.http_req_duration['p(95)'],
    http_req_duration_p99: data.metrics.http_req_duration['p(99)'],
    error_rate: data.metrics.http_req_failed.rate,
  };
  return { stdout: JSON.stringify(summary) };
}

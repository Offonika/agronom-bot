from prometheus_client import Counter, Histogram, Gauge
# Prometheus metrics definitions

# Diagnosis related metrics
# Total number of diagnosis requests
# Included in ADR observability section
# diag_requests_total: Counter
# diag_latency_seconds: Histogram of diagnosis processing latency

diag_requests_total = Counter(
    "diag_requests_total", "Total diagnosis requests"
)

# latency histogram uses default buckets; can be tweaked later
_diag_latency_buckets = (
    0.5,
    1.0,
    2.0,
    4.0,
    8.0,
    16.0,
)

# Histogram for overall diagnosis latency
# Measures time spent in `_process_image`
# from reception to response (approx)

diag_latency_seconds = Histogram(
    "diag_latency_seconds", "Diagnosis latency", buckets=_diag_latency_buckets
)

# ROI calculation latency; placeholder for future ROI service
roi_calc_seconds = Histogram(
    "roi_calc_seconds", "ROI calculation latency", buckets=_diag_latency_buckets
)

# Quota rejects when hitting free monthly limit
quota_reject_total = Counter(
    "quota_reject_total", "Number of quota rejected requests"
)

# GPT timeout counter
# Incremented when call to GPT API times out
gpt_timeout_total = Counter(
    "gpt_timeout_total", "Number of GPT timeouts"
)

# Payment related metrics
# Autopay charge processing time
_autopay_buckets = (
    0.1,
    0.5,
    1.0,
    2.0,
    5.0,
)

autopay_charge_seconds = Histogram(
    "autopay_charge_seconds", "Autopay charge processing latency", buckets=_autopay_buckets
)

# Payment failure counter
payment_fail_total = Counter(
    "payment_fail_total", "Total payment failures"
)

# Webhook rejects (IP or signature)
webhook_forbidden_total = Counter(
    "webhook_forbidden_total", "Total forbidden webhook requests"
)

# Payment amount mismatches (payload amount != expected amount)
payment_amount_mismatch_total = Counter(
    "payment_amount_mismatch_total", "Total payment amount mismatches"
)

# Autopay amount mismatches
autopay_amount_mismatch_total = Counter(
    "autopay_amount_mismatch_total", "Total autopay amount mismatches"
)

# Gauge for queue size pending (photos awaiting processing)
queue_size_pending = Gauge(
    "queue_size_pending", "Number of pending photos awaiting diagnosis"
)

__all__ = [
    "diag_requests_total",
    "diag_latency_seconds",
    "roi_calc_seconds",
    "quota_reject_total",
    "gpt_timeout_total",
    "autopay_charge_seconds",
    "payment_fail_total",
    "webhook_forbidden_total",
    "payment_amount_mismatch_total",
    "autopay_amount_mismatch_total",
    "queue_size_pending",
]

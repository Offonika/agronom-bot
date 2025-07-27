import pathlib

def test_retry_worker_uses_env_cron():
    content = pathlib.Path("worker/retry_diagnosis.js").read_text(encoding="utf-8")
    assert "process.env.RETRY_CRON" in content
    assert "'0 1 * * *'" in content


def test_retry_worker_uses_env_concurrency():
    content = pathlib.Path("worker/retry_diagnosis.js").read_text(encoding="utf-8")
    assert "process.env.RETRY_CONCURRENCY" in content


def test_retry_worker_has_retry_limit():
    content = pathlib.Path("worker/retry_diagnosis.js").read_text(encoding="utf-8")
    assert "process.env.RETRY_LIMIT" in content
    assert "retry_attempts=retry_attempts+1" in content

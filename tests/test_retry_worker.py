import pathlib

def test_retry_worker_uses_env_cron():
    content = pathlib.Path("worker/retry_diagnosis.js").read_text(encoding="utf-8")
    assert "process.env.RETRY_CRON" in content
    assert "'0 1 * * *'" in content

import subprocess


def test_bot_paywall_card():
    """Ensure bot shows paywall message when API returns 402."""
    result = subprocess.run(['npm', 'test', '--prefix', 'bot'], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr

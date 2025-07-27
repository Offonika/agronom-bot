from sqlalchemy import text
from app.db import SessionLocal
from app.models import Photo


def test_photo_retry_limit_exceeded():
    """Photo moves to failed after exceeding retry attempts."""
    with SessionLocal() as session:
        photo = Photo(user_id=1, file_id="f.jpg", status="retrying", retry_attempts=2)
        session.add(photo)
        session.commit()
        pid = photo.id

        for _ in range(2):
            session.execute(
                text(
                    "UPDATE photos SET retry_attempts = retry_attempts + 1, status = CASE WHEN retry_attempts + 1 >= :limit THEN 'failed' ELSE 'retrying' END WHERE id=:id"
                ),
                {"limit": 3, "id": pid},
            )
            session.commit()

        updated = session.get(Photo, pid)
        assert updated.status == "failed"
        assert updated.retry_attempts >= 3

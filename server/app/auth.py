import asyncio
import hmac

from fastapi import HTTPException, Request, WebSocket
from itsdangerous import BadSignature, SignatureExpired, TimestampSigner

from .config import settings

COOKIE = "dm_session"
_signer = TimestampSigner(settings.secret_key, salt="dm-session")


def check_credentials(username: str, password: str) -> bool:
    ok_u = hmac.compare_digest(username.encode(), settings.admin_username.encode())
    ok_p = hmac.compare_digest(password.encode(), settings.admin_password.encode())
    return ok_u and ok_p


def make_token(username: str) -> str:
    return _signer.sign(username.encode()).decode()


def _valid(token: str | None) -> bool:
    if not token:
        return False
    try:
        user = _signer.unsign(token, max_age=settings.session_days * 86400).decode()
    except (BadSignature, SignatureExpired):
        return False
    return user == settings.admin_username


def require_user(request: Request) -> None:
    if not _valid(request.cookies.get(COOKIE)):
        raise HTTPException(status_code=401, detail="Потрібен вхід")


def ws_authorized(ws: WebSocket) -> bool:
    return _valid(ws.cookies.get(COOKIE))


_fail_lock = asyncio.Lock()


async def slow_down_on_failure() -> None:
    # Проста затримка проти перебору пароля
    async with _fail_lock:
        await asyncio.sleep(1.0)

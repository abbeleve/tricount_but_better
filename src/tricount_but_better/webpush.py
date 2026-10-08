"""Web Push: VAPID-signed (RFC 8292), aes128gcm-encrypted (RFC 8291) messages.

Built on ``cryptography`` and ``httpx`` rather than a push library, which would
bring two more HTTP stacks for one POST. The encryption is checked byte for
byte against the worked example in RFC 8291, appendix A.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import time
from dataclasses import dataclass
from enum import StrEnum
from functools import lru_cache
from typing import Any, Protocol
from urllib.parse import urlsplit

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .config import Settings, get_settings

log = logging.getLogger(__name__)

_CURVE = ec.SECP256R1()
# Order of the P-256 group: a private scalar has to lie in [1, n - 1].
_P256_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_RECORD_SIZE = 4096
# Push services reject bodies over 4096 bytes; the record header takes 86 of them.
MAX_PAYLOAD_BYTES = 3800
# A buzz about an expense is still worth delivering when a phone comes back
# online the same day, not a week later.
_TTL_SECONDS = 24 * 60 * 60

# Every browser's push service. The server POSTs to whatever endpoint a client
# registers, so anything else is refused rather than letting a signed-in user
# aim those requests at the server's own network.
PUSH_SERVICE_HOSTS = (
    "fcm.googleapis.com",  # Chrome, Edge on Android, Samsung Internet, Yandex, Opera
    "push.services.mozilla.com",  # Firefox
    "push.apple.com",  # Safari, and home-screen apps on iOS
    "notify.windows.com",  # Edge on Windows
)


class PushKeyError(ValueError):
    """A subscription's keys or endpoint are not usable."""


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError) as exc:
        raise PushKeyError("not base64url") from exc


def _point(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )


def _hkdf(salt: bytes | None, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


# ------------------------------------------------------------------------- VAPID


@dataclass(frozen=True)
class VapidKey:
    private_key: ec.EllipticCurvePrivateKey

    @property
    def public_key(self) -> str:
        """The browser's ``applicationServerKey``: an uncompressed point, base64url."""
        return b64url_encode(_point(self.private_key.public_key()))


@lru_cache(maxsize=4)
def _vapid_key(private_key: str | None, jwt_secret: str) -> VapidKey:
    if private_key:
        scalar = int.from_bytes(b64url_decode(private_key), "big")
    else:
        # Domain-separated from the JWT signing use of the same secret.
        seed = _hkdf(None, jwt_secret.encode(), b"tricount-but-better vapid key v1", 32)
        scalar = int.from_bytes(seed, "big") % (_P256_ORDER - 1) + 1
    return VapidKey(ec.derive_private_key(scalar, _CURVE))


def vapid_key(settings: Settings | None = None) -> VapidKey:
    settings = settings or get_settings()
    return _vapid_key(settings.vapid_private_key, settings.jwt_secret)


def _json_b64(value: dict[str, Any]) -> str:
    return b64url_encode(json.dumps(value, separators=(",", ":")).encode())


def vapid_authorization(
    endpoint: str, key: VapidKey, subject: str, *, now: float | None = None
) -> str:
    """The ``Authorization`` header value: an ES256 JWT scoped to the push service."""
    parts = urlsplit(endpoint)
    issued = int(time.time() if now is None else now)
    claims = {"aud": f"{parts.scheme}://{parts.netloc}", "exp": issued + 12 * 3600, "sub": subject}
    signing_input = f"{_json_b64({'typ': 'JWT', 'alg': 'ES256'})}.{_json_b64(claims)}"
    der = key.private_key.sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    signature = b64url_encode(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"vapid t={signing_input}.{signature}, k={key.public_key}"


# -------------------------------------------------------------------- encryption


def check_subscription(endpoint: str, p256dh: str, auth: str) -> None:
    """Raise ``PushKeyError`` unless this is a real browser's push subscription."""
    parts = urlsplit(endpoint)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not any(
        host == allowed or host.endswith("." + allowed) for allowed in PUSH_SERVICE_HOSTS
    ):
        raise PushKeyError("that is not a browser push service")
    if len(b64url_decode(auth)) != 16:
        raise PushKeyError("the auth secret must be 16 bytes")
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(_CURVE, b64url_decode(p256dh))
    except ValueError as exc:
        raise PushKeyError("the p256dh key is not a P-256 point") from exc


def encrypt(
    payload: bytes,
    p256dh: str,
    auth: str,
    *,
    server_key: ec.EllipticCurvePrivateKey | None = None,
    salt: bytes | None = None,
) -> bytes:
    """Encrypt ``payload`` for one subscription as a single aes128gcm record.

    ``server_key`` and ``salt`` must be fresh for every message; they are
    parameters only so a test can reproduce the RFC's worked example.
    """
    if len(payload) > MAX_PAYLOAD_BYTES:
        raise ValueError(f"push payload is {len(payload)} bytes; the limit is {MAX_PAYLOAD_BYTES}")
    ua_public = b64url_decode(p256dh)
    auth_secret = b64url_decode(auth)
    try:
        ua_key = ec.EllipticCurvePublicKey.from_encoded_point(_CURVE, ua_public)
    except ValueError as exc:
        raise PushKeyError("the p256dh key is not a P-256 point") from exc
    server_key = server_key or ec.generate_private_key(_CURVE)
    salt = salt or os.urandom(16)
    as_public = _point(server_key.public_key())

    shared = server_key.exchange(ec.ECDH(), ua_key)
    ikm = _hkdf(auth_secret, shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)

    # One record: the payload, then the 0x02 delimiter that marks it as the last.
    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    header = salt + _RECORD_SIZE.to_bytes(4, "big") + bytes([len(as_public)]) + as_public
    return header + ciphertext


# ----------------------------------------------------------------------- sending


class PushOutcome(StrEnum):
    sent = "sent"
    gone = "gone"  # the browser unsubscribed or the keys are broken: forget it
    failed = "failed"  # a transient problem: keep it for the next message


@dataclass(frozen=True)
class PushTarget:
    endpoint: str
    p256dh: str
    auth: str


class PushSender(Protocol):
    def send(self, target: PushTarget, message: dict[str, Any]) -> PushOutcome: ...


class WebPushSender:
    def __init__(self, settings: Settings):
        self._key = vapid_key(settings)
        self._subject = settings.effective_vapid_subject
        self._timeout = settings.push_timeout_seconds

    def send(self, target: PushTarget, message: dict[str, Any]) -> PushOutcome:
        host = urlsplit(target.endpoint).hostname
        payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode()
        try:
            check_subscription(target.endpoint, target.p256dh, target.auth)
            body = encrypt(payload, target.p256dh, target.auth)
        except PushKeyError as exc:
            log.warning("dropping push subscription on %s: %s", host, exc)
            return PushOutcome.gone

        headers = {
            "Authorization": vapid_authorization(target.endpoint, self._key, self._subject),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": str(_TTL_SECONDS),
            "Urgency": "normal",
        }
        try:
            response = httpx.post(
                target.endpoint, content=body, headers=headers, timeout=self._timeout
            )
        except httpx.HTTPError as exc:
            log.warning("push to %s failed: %s", host, exc)
            return PushOutcome.failed
        if response.status_code in (404, 410):
            return PushOutcome.gone
        if response.is_success:
            return PushOutcome.sent
        log.warning("push to %s rejected: %s %s", host, response.status_code, response.text[:200])
        return PushOutcome.failed


def get_push_sender(settings: Settings) -> PushSender:
    return WebPushSender(settings)

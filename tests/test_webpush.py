"""Web Push encryption and signing, checked against the RFCs rather than a live push service."""

from __future__ import annotations

import base64
import json
import os

import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from tricount_but_better.config import Settings
from tricount_but_better.webpush import (
    PushKeyError,
    _point,
    b64url_decode,
    b64url_encode,
    check_subscription,
    encrypt,
    vapid_authorization,
    vapid_key,
)

FCM = "https://fcm.googleapis.com/fcm/send/abc:def"


def _key(private: str) -> ec.EllipticCurvePrivateKey:
    return ec.derive_private_key(int.from_bytes(b64url_decode(private), "big"), ec.SECP256R1())


def _subscriber() -> tuple[ec.EllipticCurvePrivateKey, str, str]:
    key = ec.generate_private_key(ec.SECP256R1())
    return key, b64url_encode(_point(key.public_key())), b64url_encode(os.urandom(16))


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def _decrypt(body: bytes, ua_key: ec.EllipticCurvePrivateKey, auth: str) -> bytes:
    """What the browser does on receipt, written straight from RFC 8291."""
    salt, key_length = body[:16], body[20]
    as_public, ciphertext = body[21 : 21 + key_length], body[21 + key_length :]
    ua_public = _point(ua_key.public_key())
    shared = ua_key.exchange(
        ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public)
    )
    ikm = _hkdf(b64url_decode(auth), shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    padded = AESGCM(cek).decrypt(nonce, ciphertext, None)
    assert padded.endswith(b"\x02")
    return padded[:-1]


def test_encryption_matches_the_rfc_8291_worked_example() -> None:
    body = encrypt(
        b"When I grow up, I want to be a watermelon",
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        "BTBZMqHH6r4Tts7J_aSIgg",
        server_key=_key("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
        salt=b64url_decode("DGv6ra1nlYgDCS1FRnbzlw"),
    )
    assert b64url_encode(body) == (
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYW"
        "AmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSg"
        "Sxsj_Qulcy4a-fN"
    )


def test_a_subscriber_can_read_what_was_encrypted_for_it() -> None:
    key, p256dh, auth = _subscriber()
    message = json.dumps({"title": "Квартира 42", "body": "Алиса: «Продукты»"}).encode()
    first, second = encrypt(message, p256dh, auth), encrypt(message, p256dh, auth)
    assert first != second  # a fresh key and salt every time
    assert _decrypt(first, key, auth) == message


def test_oversized_payloads_are_refused() -> None:
    _, p256dh, auth = _subscriber()
    with pytest.raises(ValueError):
        encrypt(b"x" * 5000, p256dh, auth)


def test_vapid_token_is_an_es256_jwt_for_the_push_service_origin() -> None:
    key = vapid_key(Settings(jwt_secret="one secret"))
    header = vapid_authorization(FCM, key, "https://split.example.com", now=1_800_000_000)

    token, public = header.removeprefix("vapid t=").split(", k=")
    assert public == key.public_key
    signing_input, signature = token.rsplit(".", 1)
    head, claims = (json.loads(b64url_decode(part)) for part in signing_input.split("."))
    assert head == {"typ": "JWT", "alg": "ES256"}
    assert claims == {
        "aud": "https://fcm.googleapis.com",
        "exp": 1_800_000_000 + 12 * 3600,
        "sub": "https://split.example.com",
    }

    raw = b64url_decode(signature)
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    public_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b64url_decode(public))
    public_key.verify(der, signing_input.encode(), ec.ECDSA(hashes.SHA256()))
    with pytest.raises(InvalidSignature):
        public_key.verify(der, b"tampered", ec.ECDSA(hashes.SHA256()))


def test_vapid_key_is_stable_per_secret_and_can_be_set_outright() -> None:
    a = vapid_key(Settings(jwt_secret="one secret")).public_key
    assert a == vapid_key(Settings(jwt_secret="one secret")).public_key
    assert a != vapid_key(Settings(jwt_secret="another secret")).public_key
    assert len(b64url_decode(a)) == 65 and b64url_decode(a)[0] == 4

    explicit = Settings(
        jwt_secret="one secret", vapid_private_key="yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"
    )
    assert vapid_key(explicit).public_key == (
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
    )


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://fcm.googleapis.com/fcm/send/abc",
        "https://updates.push.services.mozilla.com/wpush/v2/abc",
        "https://web.push.apple.com/QGx",
        "https://wns2-db5p.notify.windows.com/w/?token=abc",
    ],
)
def test_real_push_services_are_accepted(endpoint) -> None:
    _, p256dh, auth = _subscriber()
    check_subscription(endpoint, p256dh, auth)


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/fcm/send/abc",  # not https
        "https://127.0.0.1:8010/api/health",
        "https://localhost/push",
        "https://evilfcm.googleapis.com.example.org/x",
        "https://notfcm.googleapis.com.attacker.net/x",
        "https://googleapis.com/x",
    ],
)
def test_anything_else_is_refused_so_the_server_cannot_be_aimed_inward(endpoint) -> None:
    _, p256dh, auth = _subscriber()
    with pytest.raises(PushKeyError):
        check_subscription(endpoint, p256dh, auth)


def test_broken_keys_are_refused() -> None:
    _, p256dh, auth = _subscriber()
    with pytest.raises(PushKeyError):
        check_subscription(FCM, p256dh, b64url_encode(b"short"))
    with pytest.raises(PushKeyError):
        check_subscription(FCM, b64url_encode(b"\x04" + b"\x01" * 64), auth)
    with pytest.raises(PushKeyError):
        check_subscription(FCM, "not base64 !!", auth)


def test_base64url_round_trips_without_padding() -> None:
    for size in range(0, 40):
        data = os.urandom(size)
        assert "=" not in b64url_encode(data)
        assert b64url_decode(b64url_encode(data)) == data
        assert base64.urlsafe_b64decode(b64url_encode(data) + "===") == data

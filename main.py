from __future__ import annotations
import os
import hmac
import hashlib
import secrets
import sqlite3
import logging
import smtplib
from email.message import EmailMessage
from pathlib import Path
from datetime import datetime, date, timedelta
from typing import Optional, Any, Dict

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, EmailStr

# ======================================================
# CONFIG / PATHS  (RENDER SAFE)
# ======================================================
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE_DIR))).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = Path(os.environ.get("DB_PATH", str(DATA_DIR / "workhours.db")))

APP_SECRET = os.environ.get("WORKHOURS_SECRET", "dev-secret-change-me").encode()
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0") == "1"
COOKIE_AGE = 90 * 24 * 60 * 60  # 90 days

# ======================================================
# APP
# ======================================================
app = FastAPI(title="Work Hours Tracker", version="6.0")
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("workhours")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# ======================================================
# DATABASE
# ======================================================
def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn

def now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")

def init_db() -> None:
    with db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            salt_hex TEXT NOT NULL,
            pass_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            used_at TEXT,
            created_at TEXT NOT NULL
        );
        """)
        conn.commit()

init_db()

# ======================================================
# AUTH HELPERS
# ======================================================
def pbkdf2_hash(password: str, salt_hex: str) -> str:
    salt = bytes.fromhex(salt_hex)
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 120_000).hex()

def sign_token(payload: str) -> str:
    return hmac.new(APP_SECRET, payload.encode(), hashlib.sha256).hexdigest()

def make_session_token(user_id: int) -> str:
    ts = str(int(datetime.utcnow().timestamp()))
    rnd = secrets.token_hex(12)
    payload = f"{user_id}.{ts}.{rnd}"
    sig = sign_token(payload)
    return f"{payload}.{sig}"

def verify_session_token(token: str) -> Optional[int]:
    try:
        user_id, ts, rnd, sig = token.split(".")
        payload = f"{user_id}.{ts}.{rnd}"
        if not hmac.compare_digest(sig, sign_token(payload)):
            return None
        if datetime.utcnow().timestamp() - int(ts) > COOKIE_AGE:
            return None
        return int(user_id)
    except Exception:
        return None

def require_user(request: Request) -> int:
    token = request.cookies.get("wh_session")
    uid = verify_session_token(token) if token else None
    if not uid:
        raise HTTPException(401, "Unauthorized")
    return uid

def set_session_cookie(resp: Response, token: str, remember: bool) -> None:
    resp.set_cookie(
        "wh_session",
        token,
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        max_age=COOKIE_AGE if remember else None,
    )

# ======================================================
# SMTP / EMAIL
# ======================================================
def send_reset_email(to_email: str, reset_link: str) -> None:
    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER")
    pw = os.environ.get("SMTP_PASS")
    from_email = os.environ.get("FROM_EMAIL")

    if not all([host, user, pw, from_email]):
        raise RuntimeError("SMTP not configured")

    msg = EmailMessage()
    msg["Subject"] = "Work Hours Tracker – Password reset"
    msg["From"] = from_email
    msg["To"] = to_email
    msg.set_content(
        f"""You requested a password reset.

Click the link below:
{reset_link}

If you did not request this, ignore this email.
"""
    )

    with smtplib.SMTP(host, port) as server:
        server.ehlo()
        server.starttls()
        server.login(user, pw)
        server.send_message(msg)

# ======================================================
# SCHEMAS
# ======================================================
class SignupIn(BaseModel):
    first_name: str = Field(min_length=1, max_length=40)
    last_name: str = Field(min_length=1, max_length=40)
    email: EmailStr
    password: str = Field(min_length=4)

class LoginIn(BaseModel):
    email: EmailStr
    password: str
    remember: bool = False

class ForgotIn(BaseModel):
    email: EmailStr

class ResetIn(BaseModel):
    token: str
    new_password: str = Field(min_length=4)

# ======================================================
# PAGES
# ======================================================
@app.get("/", response_class=HTMLResponse)
def index():
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")

# ======================================================
# AUTH API
# ======================================================
@app.post("/api/signup")
def signup(payload: SignupIn):
    with db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE email=?", (payload.email.lower(),)).fetchone():
            raise HTTPException(409, "Email already in use")

        salt = secrets.token_hex(16)
        ph = pbkdf2_hash(payload.password, salt)

        conn.execute(
            "INSERT INTO users(first_name,last_name,email,salt_hex,pass_hash,created_at) VALUES (?,?,?,?,?,?)",
            (payload.first_name, payload.last_name, payload.email.lower(), salt, ph, now_iso()),
        )
        conn.commit()

        uid = conn.execute("SELECT id FROM users WHERE email=?", (payload.email.lower(),)).fetchone()["id"]

    token = make_session_token(uid)
    resp = JSONResponse({"ok": True})
    set_session_cookie(resp, token, remember=True)
    return resp

@app.post("/api/login")
def login(payload: LoginIn):
    with db() as conn:
        u = conn.execute("SELECT * FROM users WHERE email=?", (payload.email.lower(),)).fetchone()
        if not u:
            raise HTTPException(401, "Invalid credentials")

        check = pbkdf2_hash(payload.password, u["salt_hex"])
        if not hmac.compare_digest(check, u["pass_hash"]):
            raise HTTPException(401, "Invalid credentials")

    token = make_session_token(u["id"])
    resp = JSONResponse({"ok": True})
    set_session_cookie(resp, token, payload.remember)
    return resp

@app.post("/api/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("wh_session")
    return resp

@app.post("/api/forgot")
def forgot(payload: ForgotIn, request: Request):
    email = payload.email.lower()

    with db() as conn:
        u = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
        if not u:
            return {"ok": True}

        raw = secrets.token_urlsafe(32)
        th = hashlib.sha256(raw.encode()).hexdigest()
        exp = (datetime.utcnow() + timedelta(minutes=30)).isoformat()

        conn.execute(
            "INSERT INTO password_resets(user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?)",
            (u["id"], th, exp, now_iso()),
        )
        conn.commit()

    base = os.environ.get("APP_BASE_URL", str(request.base_url).rstrip("/"))
    link = f"{base}/?reset={raw}"

    send_reset_email(email, link)
    return {"ok": True}

@app.post("/api/reset")
def reset_password(payload: ResetIn):
    th = hashlib.sha256(payload.token.encode()).hexdigest()

    with db() as conn:
        r = conn.execute(
            "SELECT * FROM password_resets WHERE token_hash=? AND used_at IS NULL ORDER BY id DESC LIMIT 1",
            (th,),
        ).fetchone()

        if not r or datetime.utcnow() > datetime.fromisoformat(r["expires_at"]):
            raise HTTPException(400, "Invalid or expired token")

        salt = secrets.token_hex(16)
        ph = pbkdf2_hash(payload.new_password, salt)

        conn.execute("UPDATE users SET salt_hex=?, pass_hash=? WHERE id=?", (salt, ph, r["user_id"]))
        conn.execute("UPDATE password_resets SET used_at=? WHERE id=?", (now_iso(), r["id"]))
        conn.commit()

    return {"ok": True}

@app.get("/api/me")
def me(request: Request):
    uid = require_user(request)
    with db() as conn:
        u = conn.execute("SELECT id,first_name,last_name,email FROM users WHERE id=?", (uid,)).fetchone()
        return dict(u)

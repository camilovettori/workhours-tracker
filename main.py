from __future__ import annotations

import os
import hmac
import hashlib
import secrets
import sqlite3
import smtplib
from email.message import EmailMessage
from pathlib import Path
from datetime import datetime, date, timedelta
from typing import Optional, Any, Dict, List

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, EmailStr


# =========================
# Paths / App (PERSISTENTE)
# =========================
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE_DIR)))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "workhours.db"

APP_SECRET = os.environ.get("WORKHOURS_SECRET", "dev-secret-change-me").encode("utf-8")
COOKIE_AGE = 90 * 24 * 60 * 60  # 90 days

COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0") == "1"  # set 1 on Render (https)

app = FastAPI(title="Work Hours Tracker", version="5.0")

if not STATIC_DIR.exists():
    raise RuntimeError(f"Missing folder: {STATIC_DIR}")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

print("DB PATH:", DB_PATH)


# =========================
# DB helpers + migrations
# =========================
def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    r = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone()
    return bool(r)


def col_exists(conn: sqlite3.Connection, table: str, col: str) -> bool:
    if not table_exists(conn, table):
        return False
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r["name"] == col for r in rows)


def add_col_if_missing(conn: sqlite3.Connection, table: str, col: str, ddl: str) -> None:
    if table_exists(conn, table) and not col_exists(conn, table, col):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")


def init_db() -> None:
    with db() as conn:
        # users
        conn.execute("""
        CREATE TABLE IF NOT EXISTS users(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            email TEXT,
            salt_hex TEXT NOT NULL,
            pass_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """)

        # weeks
        conn.execute("""
        CREATE TABLE IF NOT EXISTS weeks(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            week_number INTEGER NOT NULL,
            start_date TEXT NOT NULL,
            hourly_rate REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        """)

        # entries
        conn.execute("""
        CREATE TABLE IF NOT EXISTS entries(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            week_id INTEGER NOT NULL,
            work_date TEXT NOT NULL,
            time_in TEXT,
            time_out TEXT,
            break_minutes INTEGER NOT NULL DEFAULT 0,
            note TEXT,
            was_bank_holiday INTEGER NOT NULL DEFAULT 0,
            bh_paid INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        """)

        # bank holidays
        conn.execute("""
        CREATE TABLE IF NOT EXISTS bank_holidays(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            year INTEGER NOT NULL,
            name TEXT NOT NULL,
            bh_date TEXT NOT NULL,
            paid INTEGER NOT NULL DEFAULT 0
        );
        """)

        # password resets
        conn.execute("""
        CREATE TABLE IF NOT EXISTS password_resets(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            used_at TEXT,
            created_at TEXT NOT NULL
        );
        """)

        # ---- MIGRATIONS (safe) ----
        add_col_if_missing(conn, "users", "email", "TEXT")
        add_col_if_missing(conn, "weeks", "user_id", "INTEGER NOT NULL DEFAULT 0")
        add_col_if_missing(conn, "entries", "user_id", "INTEGER NOT NULL DEFAULT 0")
        add_col_if_missing(conn, "entries", "was_bank_holiday", "INTEGER NOT NULL DEFAULT 0")
        add_col_if_missing(conn, "entries", "bh_paid", "INTEGER NOT NULL DEFAULT 0")
        add_col_if_missing(conn, "weeks", "created_at", "TEXT NOT NULL DEFAULT ''")
        add_col_if_missing(conn, "entries", "created_at", "TEXT NOT NULL DEFAULT ''")
        add_col_if_missing(conn, "weeks", "hourly_rate", "REAL NOT NULL DEFAULT 0")

        # indexes
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_name ON users(first_name, last_name);")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL;")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_weeks_user ON weeks(user_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_user ON entries(user_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_week ON entries(week_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_bh_user_year ON bank_holidays(user_id, year);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_resets_hash ON password_resets(token_hash);")

        conn.commit()


init_db()


# =========================
# Auth helpers
# =========================
def pbkdf2_hash(password: str, salt_hex: str) -> str:
    salt = bytes.fromhex(salt_hex)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000)
    return dk.hex()


def sign_token(payload: str) -> str:
    return hmac.new(APP_SECRET, payload.encode("utf-8"), hashlib.sha256).hexdigest()


def make_session_token(user_id: int) -> str:
    ts = str(int(datetime.utcnow().timestamp()))
    rnd = secrets.token_hex(12)
    payload = f"{user_id}.{ts}.{rnd}"
    sig = sign_token(payload)
    return f"{payload}.{sig}"


def verify_session_token(token: str) -> Optional[int]:
    try:
        parts = token.split(".")
        if len(parts) != 4:
            return None
        user_id, ts, rnd, sig = parts
        payload = f"{user_id}.{ts}.{rnd}"
        if not hmac.compare_digest(sig, sign_token(payload)):
            return None
        if datetime.utcnow().timestamp() - int(ts) > 90 * 24 * 3600:
            return None
        return int(user_id)
    except Exception:
        return None


def require_user(request: Request) -> int:
    tok = request.cookies.get("wh_session")
    uid = verify_session_token(tok) if tok else None
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return uid


def set_session_cookie(resp: Response, token: str, remember: bool) -> None:
    kwargs = dict(
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
    )
    if remember:
        resp.set_cookie("wh_session", token, max_age=COOKIE_AGE, **kwargs)
    else:
        resp.set_cookie("wh_session", token, **kwargs)


# =========================
# Mail (SMTP)
# =========================
def send_reset_email(to_email: str, reset_link: str) -> None:
    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER")
    pw = os.environ.get("SMTP_PASS")
    use_tls = os.environ.get("SMTP_TLS", "1") == "1"
    from_email = os.environ.get("FROM_EMAIL")

    if not host or not from_email:
        raise RuntimeError("SMTP not configured (SMTP_HOST/FROM_EMAIL missing)")

    msg = EmailMessage()
    msg["Subject"] = "Work Hours Tracker - Password reset"
    msg["From"] = from_email
    msg["To"] = to_email
    msg.set_content(
        "You requested a password reset.\n\n"
        f"Open this link to set a new password:\n{reset_link}\n\n"
        "If you did not request this, ignore this email."
    )

    with smtplib.SMTP(host, port, timeout=20) as s:
        if use_tls:
            s.starttls()
        if user and pw:
            s.login(user, pw)
        s.send_message(msg)


# =========================
# Time/date helpers
# =========================
def parse_ymd(s: str) -> date:
    return date.fromisoformat(s)


def minutes_between(time_in: Optional[str], time_out: Optional[str]) -> int:
    if not time_in or not time_out:
        return 0
    h1, m1 = [int(x) for x in time_in.split(":")]
    h2, m2 = [int(x) for x in time_out.split(":")]
    t1 = h1 * 60 + m1
    t2 = h2 * 60 + m2
    if t2 < t1:
        t2 += 24 * 60
    return max(0, t2 - t1)


def hhmm_from_minutes(total_min: int) -> str:
    total_min = max(0, int(total_min))
    h = total_min // 60
    m = total_min % 60
    return f"{h:02d}:{m:02d}"


def weekday_short_en(d: date) -> str:
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d.weekday()]


def ddmmyyyy(d: date) -> str:
    return d.strftime("%d/%m/%Y")


# =========================
# Ireland bank holidays
# =========================
DEFAULT_BH = [
    ("New Year's Day", "01-01"),
    ("St. Patrick's Day", "03-17"),
    ("Easter Monday", None),
    ("May Bank Holiday", None),
    ("June Bank Holiday", None),
    ("August Bank Holiday", None),
    ("October Bank Holiday", None),
    ("Christmas Day", "12-25"),
    ("St. Stephen's Day", "12-26"),
]


def easter_sunday(year: int) -> date:
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def first_monday(year: int, month: int) -> date:
    d = date(year, month, 1)
    while d.weekday() != 0:
        d += timedelta(days=1)
    return d


def last_monday(year: int, month: int) -> date:
    if month == 12:
        d = date(year, 12, 31)
    else:
        d = date(year, month + 1, 1) - timedelta(days=1)
    while d.weekday() != 0:
        d -= timedelta(days=1)
    return d


def ensure_bh_for_year(conn: sqlite3.Connection, user_id: int, year: int) -> None:
    c = conn.execute(
        "SELECT COUNT(*) AS c FROM bank_holidays WHERE user_id=? AND year=?",
        (user_id, year),
    ).fetchone()["c"]
    if c > 0:
        return

    es = easter_sunday(year)
    computed = {
        "Easter Monday": es + timedelta(days=1),
        "May Bank Holiday": first_monday(year, 5),
        "June Bank Holiday": first_monday(year, 6),
        "August Bank Holiday": first_monday(year, 8),
        "October Bank Holiday": last_monday(year, 10),
    }

    for name, mmdd in DEFAULT_BH:
        if mmdd:
            mm, dd = [int(x) for x in mmdd.split("-")]
            dt = date(year, mm, dd)
        else:
            dt = computed[name]
        conn.execute(
            "INSERT INTO bank_holidays(user_id, year, name, bh_date, paid) VALUES (?,?,?,?,0)",
            (user_id, year, name, dt.isoformat()),
        )
    conn.commit()


def is_bank_holiday(conn: sqlite3.Connection, user_id: int, d: date) -> bool:
    ensure_bh_for_year(conn, user_id, d.year)
    r = conn.execute(
        "SELECT 1 FROM bank_holidays WHERE user_id=? AND year=? AND bh_date=? LIMIT 1",
        (user_id, d.year, d.isoformat()),
    ).fetchone()
    return bool(r)


# =========================
# Pydantic
# =========================
class SignupIn(BaseModel):
    first_name: str = Field(min_length=1, max_length=40)
    last_name: str = Field(min_length=1, max_length=40)
    email: EmailStr
    password: str = Field(min_length=4, max_length=120)


class LoginIn(BaseModel):
    email: Optional[EmailStr] = None
    first_name: Optional[str] = Field(default=None, min_length=1, max_length=40)
    last_name: Optional[str] = Field(default=None, min_length=1, max_length=40)
    password: str = Field(min_length=4, max_length=120)
    remember: bool = False


class ForgotIn(BaseModel):
    email: EmailStr


class ResetIn(BaseModel):
    token: str = Field(min_length=10, max_length=300)
    new_password: str = Field(min_length=4, max_length=120)


class WeekCreate(BaseModel):
    week_number: int = Field(ge=1, le=60)
    start_date: str
    hourly_rate: float = Field(ge=0, le=200)


class WeekPatch(BaseModel):
    hourly_rate: float = Field(ge=0, le=200)


class EntryUpsert(BaseModel):
    work_date: str
    time_in: Optional[str] = None
    time_out: Optional[str] = None
    break_minutes: int = Field(ge=0, le=600)
    note: Optional[str] = None
    bh_paid: Optional[bool] = None


class BhPaidPatch(BaseModel):
    paid: bool


# =========================
# Calculations
# =========================
def entry_minutes(e: sqlite3.Row) -> int:
    mins = minutes_between(e["time_in"], e["time_out"]) - int(e["break_minutes"] or 0)
    return max(0, mins)


def multiplier(d: date, was_bh: bool) -> float:
    if d.weekday() == 6 or was_bh:
        return 1.5
    return 1.0


def compute_week(conn: sqlite3.Connection, user_id: int, week_id: int) -> Dict[str, Any]:
    w = conn.execute(
        "SELECT * FROM weeks WHERE id=? AND user_id=?",
        (week_id, user_id),
    ).fetchone()
    if not w:
        raise HTTPException(404, "Week not found")

    rows = conn.execute(
        "SELECT * FROM entries WHERE week_id=? AND user_id=? ORDER BY work_date ASC",
        (week_id, user_id),
    ).fetchall()

    total_min = 0
    total_pay = 0.0
    out_entries = []

    for e in rows:
        d = parse_ymd(e["work_date"])
        mins = entry_minutes(e)
        was_bh = bool(e["was_bank_holiday"])
        mult = multiplier(d, was_bh)

        total_min += mins
        total_pay += (mins / 60.0) * float(w["hourly_rate"]) * mult

        out_entries.append({
            "id": e["id"],
            "work_date": e["work_date"],
            "weekday": weekday_short_en(d),
            "date_ddmmyyyy": ddmmyyyy(d),
            "time_in": e["time_in"],
            "time_out": e["time_out"],
            "break_minutes": int(e["break_minutes"] or 0),
            "worked_hhmm": hhmm_from_minutes(mins),
            "multiplier": mult,
            "is_bank_holiday": was_bh,
            "bh_paid": bool(e["bh_paid"]),
            "note": e["note"] or "",
        })

    return {
        "id": w["id"],
        "week_number": int(w["week_number"]),
        "start_date": w["start_date"],
        "hourly_rate": float(w["hourly_rate"]),
        "totals": {
            "total_hhmm": hhmm_from_minutes(total_min),
            "total_pay": round(total_pay, 2),
        },
        "entries": out_entries,
    }


# =========================
# Pages
# =========================
@app.get("/", response_class=HTMLResponse)
def home():
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


# =========================
# Auth endpoints
# =========================
@app.get("/api/me")
def me(request: Request):
    uid = require_user(request)
    with db() as conn:
        u = conn.execute(
            "SELECT id, first_name, last_name, email FROM users WHERE id=?",
            (uid,),
        ).fetchone()
        if not u:
            raise HTTPException(401, "Unauthorized")
        return {
            "id": u["id"],
            "first_name": u["first_name"],
            "last_name": u["last_name"],
            "email": u["email"] or "",
        }


@app.post("/api/signup")
def signup(payload: SignupIn):
    fn = payload.first_name.strip()
    ln = payload.last_name.strip()
    email = payload.email.lower().strip()

    with db() as conn:
        before = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]

        exists_email = conn.execute(
            "SELECT 1 FROM users WHERE lower(email)=lower(?) LIMIT 1",
            (email,),
        ).fetchone()
        if exists_email:
            raise HTTPException(409, "Email already in use")

        salt_hex = secrets.token_hex(16)
        pass_hash = pbkdf2_hash(payload.password, salt_hex)

        conn.execute(
            "INSERT INTO users(first_name, last_name, email, salt_hex, pass_hash, created_at) VALUES (?,?,?,?,?,?)",
            (fn, ln, email, salt_hex, pass_hash, now_iso()),
        )
        conn.commit()

        uid = conn.execute(
            "SELECT id FROM users WHERE lower(email)=lower(?) ORDER BY id DESC LIMIT 1",
            (email,),
        ).fetchone()["id"]

        if before == 0:
            conn.execute("UPDATE weeks SET user_id=? WHERE user_id=0", (uid,))
            conn.execute("UPDATE entries SET user_id=? WHERE user_id=0", (uid,))
            conn.execute("UPDATE bank_holidays SET user_id=? WHERE user_id=0", (uid,))
            conn.commit()

    token = make_session_token(int(uid))
    resp = JSONResponse({"ok": True})
    set_session_cookie(resp, token, remember=True)
    return resp


@app.post("/api/login")
def login(payload: LoginIn):
    with db() as conn:
        u = None

        if payload.email:
            email = payload.email.lower().strip()
            u = conn.execute(
                "SELECT * FROM users WHERE lower(email)=lower(?) LIMIT 1",
                (email,),
            ).fetchone()
        else:
            fn = (payload.first_name or "").strip()
            ln = (payload.last_name or "").strip()
            if fn and ln:
                u = conn.execute(
                    "SELECT * FROM users WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?) LIMIT 1",
                    (fn, ln),
                ).fetchone()

        if not u:
            raise HTTPException(401, "Invalid credentials")

        check = pbkdf2_hash(payload.password, u["salt_hex"])
        if not hmac.compare_digest(check, u["pass_hash"]):
            raise HTTPException(401, "Invalid credentials")

    token = make_session_token(int(u["id"]))
    resp = JSONResponse({"ok": True})
    set_session_cookie(resp, token, remember=payload.remember)
    return resp


@app.post("/api/forgot")
def forgot(payload: ForgotIn, request: Request):
    email = payload.email.lower().strip()

    with db() as conn:
        u = conn.execute(
            "SELECT id FROM users WHERE lower(email)=lower(?) LIMIT 1",
            (email,),
        ).fetchone()

        # Segurança: não revelar se email existe
        if not u:
            return {"ok": True}

        raw = secrets.token_urlsafe(32)
        th = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        expires = (datetime.utcnow() + timedelta(minutes=30)).isoformat(timespec="seconds")

        conn.execute(
            "INSERT INTO password_resets(user_id, token_hash, expires_at, used_at, created_at) VALUES (?,?,?,?,?)",
            (u["id"], th, expires, None, now_iso()),
        )
        conn.commit()

    base = os.environ.get("APP_BASE_URL")
    if not base:
        base = str(request.base_url).rstrip("/")

    reset_link = f"{base}/?reset={raw}"

    try:
        send_reset_email(email, reset_link)
    except Exception as e:
        # em produção configure SMTP_*; local pode falhar
        raise HTTPException(500, f"Email not sent: {e}")

    return {"ok": True}


@app.post("/api/reset")
def reset_password(payload: ResetIn):
    raw = payload.token.strip()
    th = hashlib.sha256(raw.encode("utf-8")).hexdigest()

    with db() as conn:
        r = conn.execute(
            "SELECT * FROM password_resets WHERE token_hash=? ORDER BY id DESC LIMIT 1",
            (th,),
        ).fetchone()
        if not r:
            raise HTTPException(400, "Invalid or expired token")

        if r["used_at"]:
            raise HTTPException(400, "Token already used")

        exp = datetime.fromisoformat(r["expires_at"])
        if datetime.utcnow() > exp:
            raise HTTPException(400, "Invalid or expired token")

        new_salt = secrets.token_hex(16)
        new_hash = pbkdf2_hash(payload.new_password, new_salt)

        conn.execute(
            "UPDATE users SET salt_hex=?, pass_hash=? WHERE id=?",
            (new_salt, new_hash, r["user_id"]),
        )
        conn.execute(
            "UPDATE password_resets SET used_at=? WHERE id=?",
            (now_iso(), r["id"]),
        )
        conn.commit()

    return {"ok": True}


@app.post("/api/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("wh_session")
    return resp


# =========================
# Weeks
# =========================
@app.get("/api/weeks")
def list_weeks(request: Request):
    uid = require_user(request)
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM weeks WHERE user_id=? ORDER BY start_date DESC, id DESC",
            (uid,),
        ).fetchall()

        out = []
        for w in rows:
            wk = compute_week(conn, uid, w["id"])
            out.append({
                "id": w["id"],
                "week_number": int(w["week_number"]),
                "start_date": w["start_date"],
                "hourly_rate": float(w["hourly_rate"]),
                "total_hhmm": wk["totals"]["total_hhmm"],
                "total_pay": wk["totals"]["total_pay"],
            })
        return out


@app.post("/api/weeks")
def create_week(payload: WeekCreate, request: Request):
    uid = require_user(request)
    try:
        parse_ymd(payload.start_date)
    except Exception:
        raise HTTPException(400, "Invalid start_date (YYYY-MM-DD)")

    with db() as conn:
        conn.execute(
            "INSERT INTO weeks(user_id, week_number, start_date, hourly_rate, created_at) VALUES (?,?,?,?,?)",
            (uid, payload.week_number, payload.start_date, float(payload.hourly_rate), now_iso()),
        )
        conn.commit()
    return {"ok": True}


@app.get("/api/weeks/{week_id}")
def get_week(week_id: int, request: Request):
    uid = require_user(request)
    with db() as conn:
        return compute_week(conn, uid, week_id)


@app.patch("/api/weeks/{week_id}")
def patch_week(week_id: int, payload: WeekPatch, request: Request):
    uid = require_user(request)
    with db() as conn:
        w = conn.execute("SELECT id FROM weeks WHERE id=? AND user_id=?", (week_id, uid)).fetchone()
        if not w:
            raise HTTPException(404, "Week not found")
        conn.execute(
            "UPDATE weeks SET hourly_rate=? WHERE id=? AND user_id=?",
            (float(payload.hourly_rate), week_id, uid),
        )
        conn.commit()
    return {"ok": True}


@app.delete("/api/weeks/{week_id}")
def delete_week(week_id: int, request: Request):
    uid = require_user(request)
    with db() as conn:
        conn.execute("DELETE FROM entries WHERE week_id=? AND user_id=?", (week_id, uid))
        conn.execute("DELETE FROM weeks WHERE id=? AND user_id=?", (week_id, uid))
        conn.commit()
    return {"ok": True}


# =========================
# Entries
# =========================
@app.put("/api/weeks/{week_id}/entry")
def upsert_entry(week_id: int, payload: EntryUpsert, request: Request):
    uid = require_user(request)
    try:
        d = parse_ymd(payload.work_date)
    except Exception:
        raise HTTPException(400, "Invalid work_date (YYYY-MM-DD)")

    with db() as conn:
        w = conn.execute("SELECT id FROM weeks WHERE id=? AND user_id=?", (week_id, uid)).fetchone()
        if not w:
            raise HTTPException(404, "Week not found")

        was_bh = 1 if is_bank_holiday(conn, uid, d) else 0

        existing = conn.execute(
            "SELECT id, bh_paid FROM entries WHERE user_id=? AND week_id=? AND work_date=?",
            (uid, week_id, payload.work_date),
        ).fetchone()

        bh_paid_val = None
        if payload.bh_paid is not None:
            bh_paid_val = 1 if payload.bh_paid else 0

        if existing:
            conn.execute(
                """
                UPDATE entries
                SET time_in=?, time_out=?, break_minutes=?, note=?, was_bank_holiday=?,
                    bh_paid=COALESCE(?, bh_paid)
                WHERE id=? AND user_id=?;
                """,
                (
                    payload.time_in,
                    payload.time_out,
                    int(payload.break_minutes),
                    payload.note,
                    was_bh,
                    bh_paid_val,
                    existing["id"],
                    uid,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO entries(user_id, week_id, work_date, time_in, time_out, break_minutes, note, was_bank_holiday, bh_paid, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?);
                """,
                (
                    uid,
                    week_id,
                    payload.work_date,
                    payload.time_in,
                    payload.time_out,
                    int(payload.break_minutes),
                    payload.note,
                    was_bh,
                    bh_paid_val if bh_paid_val is not None else 0,
                    now_iso(),
                ),
            )

        conn.commit()

    return {"ok": True}


@app.delete("/api/entries/{entry_id}")
def delete_entry(entry_id: int, request: Request):
    uid = require_user(request)
    with db() as conn:
        conn.execute("DELETE FROM entries WHERE id=? AND user_id=?", (entry_id, uid))
        conn.commit()
    return {"ok": True}


# =========================
# Bank Holiday Tracker
# =========================
@app.get("/api/bank-holidays/{year}")
def list_bh(year: int, request: Request):
    uid = require_user(request)
    with db() as conn:
        ensure_bh_for_year(conn, uid, year)
        rows = conn.execute(
            "SELECT * FROM bank_holidays WHERE user_id=? AND year=? ORDER BY bh_date ASC",
            (uid, year),
        ).fetchall()

        out = []
        for r in rows:
            d = parse_ymd(r["bh_date"])
            out.append({
                "id": r["id"],
                "name": r["name"],
                "bh_date": r["bh_date"],
                "weekday": weekday_short_en(d),
                "date_ddmmyyyy": ddmmyyyy(d),
                "paid": bool(r["paid"]),
            })
        return out


@app.patch("/api/bank-holidays/{bh_id}")
def patch_bh(bh_id: int, payload: BhPaidPatch, request: Request):
    uid = require_user(request)
    with db() as conn:
        r = conn.execute(
            "SELECT id FROM bank_holidays WHERE id=? AND user_id=?",
            (bh_id, uid),
        ).fetchone()
        if not r:
            raise HTTPException(404, "Not found")

        conn.execute(
            "UPDATE bank_holidays SET paid=? WHERE id=? AND user_id=?",
            (1 if payload.paid else 0, bh_id, uid),
        )
        conn.commit()
    return {"ok": True}

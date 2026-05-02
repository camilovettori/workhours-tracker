from __future__ import annotations

import os
import json
import re
import hmac
import hashlib
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime, date, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, File, Query
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field

import smtplib
from email.message import EmailMessage


# ======================================================
# PATHS / APP
# ======================================================
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
if not STATIC_DIR.exists():
    raise RuntimeError(f"Missing folder: {STATIC_DIR}")

DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE_DIR / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "workhours.db"

AVATARS_DIR = DATA_DIR / "avatars"
AVATARS_DIR.mkdir(parents=True, exist_ok=True)

APP_SECRET = os.environ.get("WORKHOURS_SECRET", "dev-secret-change-me").encode("utf-8")
COOKIE_AGE = 90 * 24 * 60 * 60  # 90 days
import os
COOKIE_SECURE = os.getenv("RENDER") == "true"  # ou usa uma env tua
DUBLIN_TZ = ZoneInfo("Europe/Dublin")


app = FastAPI(title="Work Hours Tracker", version="9.3")

# Static
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ======================================================
# NO CACHE FOR API (fix PWA/cache cross-user weirdness)
# ======================================================
@app.middleware("http")
async def no_cache_api(request: Request, call_next):
    resp = await call_next(request)
    p = request.url.path or ""
    if p.startswith("/api/") or p.startswith("/uploads/"):
        resp.headers["Cache-Control"] = "no-store, no-cache, max-age=0, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        resp.headers["Vary"] = "Cookie"
    return resp


# ======================================================
# TIME HELPER (FIXES YOUR 500 BUG: now() was missing)
# ======================================================
def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def local_now() -> datetime:
    return datetime.now(DUBLIN_TZ)


def utc_from_iso(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# ======================================================
# DB / MIGRATIONS
# ======================================================
@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
    finally:
        conn.close()


def col_exists(conn: sqlite3.Connection, table: str, col: str) -> bool:
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    return col in cols


def add_col_if_missing(conn: sqlite3.Connection, table: str, col: str, ddl: str) -> None:
    if not col_exists(conn, table, col):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")



def ensure_user_columns(conn: sqlite3.Connection) -> None:
    # compatibilidade com DBs antigos
    add_col_if_missing(conn, "users", "first_name", "TEXT")
    add_col_if_missing(conn, "users", "last_name", "TEXT")
    add_col_if_missing(conn, "users", "hourly_rate", "REAL DEFAULT 0")
    add_col_if_missing(conn, "users", "avatar_path", "TEXT")
    add_col_if_missing(conn, "users", "salt_hex", "TEXT")
    add_col_if_missing(conn, "users", "pass_hash", "TEXT")
    add_col_if_missing(conn, "users", "created_at", "TEXT")

    # ✅ NEW
    add_col_if_missing(conn, "users", "is_admin", "INTEGER NOT NULL DEFAULT 0")


def ensure_clock_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS clock_state(
            user_id INTEGER PRIMARY KEY,
            week_id INTEGER,
            work_date TEXT,
            in_time TEXT,
            out_time TEXT,
            break_running INTEGER DEFAULT 0,
            break_start TEXT,
            break_minutes INTEGER DEFAULT 0,
            updated_at TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        """
    )


def ensure_v2_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS deliveries(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            work_date TEXT NOT NULL,
            run_no INTEGER NOT NULL,
            location TEXT NOT NULL,
            delivery_count INTEGER NOT NULL DEFAULT 0,
            note TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS ux_deliveries_user_day_run
        ON deliveries(user_id, work_date, run_no);

        CREATE TABLE IF NOT EXISTS reminder_settings(
            user_id INTEGER PRIMARY KEY,
            break_enabled INTEGER NOT NULL DEFAULT 1,
            missed_in_enabled INTEGER NOT NULL DEFAULT 1,
            missed_out_enabled INTEGER NOT NULL DEFAULT 1,
            break_reminder_after_min INTEGER NOT NULL DEFAULT 240,
            missed_in_offset_min INTEGER NOT NULL DEFAULT 10,
            missed_out_offset_min INTEGER NOT NULL DEFAULT 20,
            updated_at TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS work_schedule(
            user_id INTEGER PRIMARY KEY,
            active_days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
            start_time TEXT NOT NULL DEFAULT '09:00',
            end_time TEXT NOT NULL DEFAULT '17:00',
            break_after_min INTEGER NOT NULL DEFAULT 240,
            updated_at TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        """
    )


def ensure_bh_indexes(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ux_bh_unique
        ON bank_holidays(user_id, year, bh_date)
        """
    )


def ensure_password_resets_table(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS password_resets(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS ix_password_resets_email
        ON password_resets(email);

        CREATE INDEX IF NOT EXISTS ix_password_resets_token_hash
        ON password_resets(token_hash);
        """
    )


def ensure_v2_defaults(conn: sqlite3.Connection, uid: int) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO reminder_settings(
            user_id, break_enabled, missed_in_enabled, missed_out_enabled,
            break_reminder_after_min, missed_in_offset_min, missed_out_offset_min, updated_at
        )
        VALUES (?, 1, 1, 1, 240, 10, 20, ?)
        """,
        (uid, now()),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO work_schedule(
            user_id, active_days, start_time, end_time, break_after_min, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (uid, json.dumps([1, 2, 3, 4, 5]), "09:00", "17:00", 240, now()),
    )


def parse_hhmm(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError("Time is required")
    parts = text.split(":")
    if len(parts) != 2:
        raise ValueError("Invalid time format")
    hh = int(parts[0])
    mm = int(parts[1])
    if hh < 0 or hh > 23 or mm < 0 or mm > 59:
        raise ValueError("Invalid time value")
    return f"{hh:02d}:{mm:02d}"


def parse_days_json(raw: str) -> list[int]:
    try:
        value = json.loads(raw or "[]")
    except Exception as exc:
        raise ValueError("Invalid active days") from exc
    if not isinstance(value, list):
        raise ValueError("Invalid active days")
    out: list[int] = []
    for item in value:
        n = int(item)
        if n < 0 or n > 6:
            raise ValueError("Invalid day index")
        if n not in out:
            out.append(n)
    return sorted(out)


def get_reminder_settings(conn: sqlite3.Connection, uid: int) -> sqlite3.Row:
    ensure_v2_defaults(conn, uid)
    row = conn.execute(
        "SELECT * FROM reminder_settings WHERE user_id=?",
        (uid,),
    ).fetchone()
    return row


def get_schedule_settings(conn: sqlite3.Connection, uid: int) -> sqlite3.Row:
    ensure_v2_defaults(conn, uid)
    row = conn.execute(
        "SELECT * FROM work_schedule WHERE user_id=?",
        (uid,),
    ).fetchone()
    return row


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                first_name TEXT,
                last_name TEXT,
                email TEXT UNIQUE,
                salt_hex TEXT,
                pass_hash TEXT,
                hourly_rate REAL DEFAULT 0,
                avatar_path TEXT,
                created_at TEXT,
                is_admin INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS weeks(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                week_number INTEGER,
                start_date TEXT,
                hourly_rate REAL,
                created_at TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS entries(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                week_id INTEGER,
                work_date TEXT,
                time_in TEXT,
                time_out TEXT,
                break_minutes INTEGER DEFAULT 0,
                note TEXT,
                bh_paid INTEGER,
                multiplier REAL DEFAULT 1.0,
                extra_authorized INTEGER DEFAULT 0,
                extra_checked INTEGER DEFAULT 0,
                created_at TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(week_id) REFERENCES weeks(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS bank_holidays(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                year INTEGER,
                name TEXT,
                bh_date TEXT,
                paid INTEGER DEFAULT 0,
                paid_date TEXT,
                paid_week INTEGER,
                applicable INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS rosters(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                week_number INTEGER,
                start_date TEXT,
                created_at TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS roster_days(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                roster_id INTEGER,
                work_date TEXT,
                shift_in TEXT,
                shift_out TEXT,
                day_off INTEGER DEFAULT 0,
                status TEXT DEFAULT 'WORK',
                created_at TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(roster_id) REFERENCES rosters(id) ON DELETE CASCADE
            );
            """
        )

        # migrations (idempotentes)
        ensure_password_resets_table(conn)
        ensure_user_columns(conn)

        add_col_if_missing(conn, "entries", "note", "TEXT")
        add_col_if_missing(conn, "entries", "bh_paid", "INTEGER")
        add_col_if_missing(conn, "entries", "multiplier", "REAL DEFAULT 1.0")
        add_col_if_missing(conn, "entries", "extra_authorized", "INTEGER DEFAULT 0")
        add_col_if_missing(conn, "entries", "extra_checked", "INTEGER DEFAULT 0")

        add_col_if_missing(conn, "bank_holidays", "paid_date", "TEXT")
        add_col_if_missing(conn, "bank_holidays", "paid_week", "INTEGER")
        add_col_if_missing(conn, "bank_holidays", "applicable", "INTEGER NOT NULL DEFAULT 1")
        # Novas colunas BH (fluxo consumo)
        add_col_if_missing(conn, "bank_holidays", "amount_paid", "REAL DEFAULT NULL")
        add_col_if_missing(conn, "bank_holidays", "pay_hours", "REAL DEFAULT NULL")
        add_col_if_missing(conn, "bank_holidays", "roster_day_id", "INTEGER DEFAULT NULL")
        add_col_if_missing(conn, "roster_days", "status", "TEXT DEFAULT 'WORK'")
        add_col_if_missing(conn, "roster_days", "bank_holiday_id", "INTEGER DEFAULT NULL")

        ensure_bh_indexes(conn)
        ensure_clock_tables(conn)
        ensure_v2_tables(conn)

        conn.commit()


        # migrations (idempotentes)
        ensure_password_resets_table(conn)
        ensure_user_columns(conn)

        add_col_if_missing(conn, "entries", "note", "TEXT")
        add_col_if_missing(conn, "entries", "bh_paid", "INTEGER")
        add_col_if_missing(conn, "entries", "multiplier", "REAL DEFAULT 1.0")
        add_col_if_missing(conn, "entries", "extra_authorized", "INTEGER DEFAULT 0")
        add_col_if_missing(conn, "entries", "extra_checked", "INTEGER DEFAULT 0")

        add_col_if_missing(conn, "bank_holidays", "paid_date", "TEXT")
        add_col_if_missing(conn, "bank_holidays", "paid_week", "INTEGER")
        add_col_if_missing(conn, "bank_holidays", "applicable", "INTEGER NOT NULL DEFAULT 1")
        # Novas colunas BH (fluxo consumo)
        add_col_if_missing(conn, "bank_holidays", "amount_paid", "REAL DEFAULT NULL")
        add_col_if_missing(conn, "bank_holidays", "pay_hours", "REAL DEFAULT NULL")
        add_col_if_missing(conn, "bank_holidays", "roster_day_id", "INTEGER DEFAULT NULL")
        add_col_if_missing(conn, "roster_days", "status", "TEXT DEFAULT 'WORK'")
        add_col_if_missing(conn, "roster_days", "bank_holiday_id", "INTEGER DEFAULT NULL")

        ensure_bh_indexes(conn)
        ensure_clock_tables(conn)
        ensure_v2_tables(conn)
        sync_tesco_week_numbers(conn)

        conn.commit()


@app.on_event("startup")
def _startup():
    init_db()


# ======================================================
# BANK HOLIDAYS (constants + helpers)
# ======================================================
BANK_HOLIDAYS_2026: list[tuple[str, str]] = [
    ("2026-01-01", "New Year's Day"),
    ("2026-02-02", "St Brigid's Day"),
    ("2026-03-17", "St Patrick's Day"),
    ("2026-04-06", "Easter Monday"),
    ("2026-05-04", "May Bank Holiday"),
    ("2026-06-01", "June Bank Holiday"),
    ("2026-08-03", "August Bank Holiday"),
    ("2026-10-26", "October Bank Holiday"),
    ("2026-12-25", "Christmas Day"),
    ("2026-12-26", "St Stephen's Day"),
]

BANK_HOLIDAYS_2025: list[tuple[str, str]] = [
    ("2025-01-01", "New Year's Day"),
    ("2025-02-03", "St Brigid's Day"),
    ("2025-03-17", "St Patrick's Day"),
    ("2025-04-21", "Easter Monday"),
    ("2025-05-05", "May Bank Holiday"),
    ("2025-06-02", "June Bank Holiday"),
    ("2025-08-04", "August Bank Holiday"),
    ("2025-10-27", "October Bank Holiday"),
    ("2025-12-25", "Christmas Day"),
    ("2025-12-26", "St Stephen's Day"),
]


def irish_bank_holidays(year: int) -> List[tuple[str, str]]:
    if year == 2025:
        return BANK_HOLIDAYS_2025
    if year == 2026:
        return BANK_HOLIDAYS_2026
    return []


def bh_repair(conn: sqlite3.Connection, uid: int, year: int) -> None:
    # remove broken rows
    conn.execute(
        """
        DELETE FROM bank_holidays
        WHERE user_id=? AND year=?
          AND (
            name IS NULL
            OR trim(name) = ''
            OR name GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            OR bh_date IS NULL
            OR bh_date NOT LIKE '____-__-__'
          )
        """,
        (uid, year),
    )

    # normalize dates
    conn.execute(
        """
        UPDATE bank_holidays
        SET bh_date = date(bh_date)
        WHERE user_id=? AND year=? AND bh_date IS NOT NULL
        """,
        (uid, year),
    )

    # remove duplicates (SQLite supports window functions on modern versions;
    # if your SQLite is old, this can fail — but your Render/PC usually is fine.)
    conn.execute(
        """
        DELETE FROM bank_holidays
        WHERE id IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY user_id, year, bh_date
                     ORDER BY
                       paid DESC,
                       CASE WHEN paid_date IS NOT NULL THEN 1 ELSE 0 END DESC,
                       id ASC
                   ) AS rn
            FROM bank_holidays
            WHERE user_id=? AND year=?
          )
          WHERE rn > 1
        )
        """,
        (uid, year),
    )

    ensure_bh_indexes(conn)
    conn.commit()


def ensure_bh_for_year(conn: sqlite3.Connection, uid: int, year: int) -> None:
    bh_repair(conn, uid, year)

    items = irish_bank_holidays(year)
    if not items:
        return

    conn.executemany(
        """
        INSERT OR IGNORE INTO bank_holidays
        (user_id, year, name, bh_date, paid, applicable)
        VALUES (?, ?, ?, date(?), 0, 1)
        """,
        [(uid, year, name, ymd) for (ymd, name) in items],
    )
    conn.commit()


# ======================================================
# MODELS
# ======================================================
class SignupIn(BaseModel):
    first_name: str = Field(..., min_length=1)
    last_name: str = Field(..., min_length=1)
    email: EmailStr
    password: str = Field(..., min_length=4)


class LoginIn(BaseModel):
    email: EmailStr
    password: str
    remember: bool = False


class WeekCreate(BaseModel):
    week_number: int
    start_date: str  # yyyy-mm-dd
    hourly_rate: float


class WeekRatePatch(BaseModel):
    hourly_rate: float


class RosterDayPatch(BaseModel):
    work_date: str  # yyyy-mm-dd
    code: str  # "A" | "B" | "OFF" | "HOLIDAY" | "BANK_HOLIDAY" | "CUSTOM:HH:MM-HH:MM"
    bank_holiday_id: Optional[int] = None  # BH selecionado no modal (fluxo novo)


class EntryUpsert(BaseModel):
    work_date: str  # yyyy-mm-dd
    time_in: Optional[str] = None  # HH:MM
    time_out: Optional[str] = None  # HH:MM
    break_minutes: int = 0
    note: Optional[str] = None
    bh_paid: Optional[bool] = None


class BhPaidPatch(BaseModel):
    paid: Optional[bool] = None
    paid_date: Optional[str] = None
    paid_week: Optional[int] = None
    applicable: Optional[bool] = None


class BhConsumeIn(BaseModel):
    roster_day_id: int
    taken_on_date: str  # yyyy-mm-dd


class BhManualMarkPaidIn(BaseModel):
    taken_on_date: str  # yyyy-mm-dd
    amount_paid: Optional[float] = None
    pay_hours: Optional[float] = None


class ForgotIn(BaseModel):
    email: EmailStr


class ResetIn(BaseModel):
    token: str
    new_password: str = Field(..., min_length=4)


class RosterCreate(BaseModel):
    week_number: int
    start_date: str  # yyyy-mm-dd (Sunday)
    days: List[str]  # 7 items: "A", "B", "OFF", "HOLIDAY", "BANK_HOLIDAY", "CUSTOM:HH:MM-HH:MM"
    bh_ids: Optional[Dict[str, int]] = None  # {"0": bh_id, ...} chave = índice do dia (0-6)


class ExtraConfirmIn(BaseModel):
    work_date: str  # yyyy-mm-dd
    authorized: bool


class MeUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    hourly_rate: Optional[float] = None


class DeliveryUpsert(BaseModel):
    work_date: str
    run_no: int = Field(..., ge=1, le=2)
    location: str = Field(..., min_length=1)
    delivery_count: int = Field(..., ge=0)
    note: Optional[str] = None


class DeliveriesDayUpsert(BaseModel):
    work_date: str
    run_1_count: int = Field(..., ge=0)
    run_1_location: str = Field(..., min_length=1)
    run_2_count: int = Field(..., ge=0)
    run_2_location: str = Field(..., min_length=1)
    run_1_note: Optional[str] = None
    run_2_note: Optional[str] = None


class ReminderSettingsUpdate(BaseModel):
    break_enabled: bool = True
    missed_in_enabled: bool = True
    missed_out_enabled: bool = True
    break_reminder_after_min: int = Field(..., ge=15, le=720)
    missed_in_offset_min: int = Field(..., ge=0, le=240)
    missed_out_offset_min: int = Field(..., ge=0, le=240)


class ScheduleSettingsUpdate(BaseModel):
    active_days: List[int] = Field(default_factory=list)
    start_time: str
    end_time: str
    break_after_min: int = Field(..., ge=15, le=720)


# ======================================================
# PAGES
# ======================================================
def serve_index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/", response_class=HTMLResponse)
def index():
    return serve_index()


@app.get("/add-week")
def add_week_page():
    return serve_index()


@app.get("/report", response_class=HTMLResponse)
def report():
    return (STATIC_DIR / "report.html").read_text(encoding="utf-8")


@app.get("/deliveries", response_class=HTMLResponse)
def deliveries_page():
    return (STATIC_DIR / "deliveries.html").read_text(encoding="utf-8")


@app.get("/settings", response_class=HTMLResponse)
def settings_page():
    return (STATIC_DIR / "settings.html").read_text(encoding="utf-8")


@app.get("/hours", response_class=HTMLResponse)
def hours_page():
    return serve_index()


@app.get("/weeks", response_class=HTMLResponse)
def weeks_page():
    return serve_index()


@app.get("/holidays", response_class=HTMLResponse)
def holidays_page(req: Request):
    require_user(req)
    return (STATIC_DIR / "holidays.html").read_text(encoding="utf-8")


@app.get("/reports", response_class=HTMLResponse)
def reports_page():
    return serve_index()


@app.get("/profile", response_class=HTMLResponse)
def profile_page(req: Request):
    require_user(req)
    return (STATIC_DIR / "profile.html").read_text(encoding="utf-8")


@app.get("/roster", response_class=HTMLResponse)
def roster_page(req: Request):
    require_user(req)
    return (STATIC_DIR / "roster.html").read_text(encoding="utf-8")


# ======================================================
# AUTH (cookie session)
# ======================================================
def hash_pw(pw: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256",
        pw.encode("utf-8"),
        bytes.fromhex(salt_hex),
        120_000,
    ).hex()


def sign(data: str) -> str:
    return hmac.new(APP_SECRET, data.encode("utf-8"), hashlib.sha256).hexdigest()


def make_token(uid: int) -> str:
    ts = str(int(datetime.utcnow().timestamp()))
    rnd = secrets.token_hex(8)
    payload = f"{uid}.{ts}.{rnd}"
    return f"{payload}.{sign(payload)}"


def verify_token(tok: str) -> Optional[int]:
    try:
        uid, ts, rnd, sig = tok.split(".")
        payload = f"{uid}.{ts}.{rnd}"
        if not hmac.compare_digest(sig, sign(payload)):
            return None
        if datetime.utcnow().timestamp() - int(ts) > COOKIE_AGE:
            return None
        return int(uid)
    except Exception:
        return None


def require_user(req: Request) -> int:
    tok = req.cookies.get("wh_session")
    uid = verify_token(tok) if tok else None
    if not uid:
        raise HTTPException(401, "Unauthorized")
    with db() as conn:
        ensure_current_week_for_user(conn, uid)
    return uid


def set_cookie(resp: Response, tok: str, remember: bool) -> None:
    kwargs = dict(
        key="wh_session",
        value=tok,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    if remember:
        kwargs["max_age"] = COOKIE_AGE
    resp.set_cookie(**kwargs)



    


# ======================================================
# SMTP (reset password)
# ======================================================
SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
SMTP_FROM = os.environ.get("SMTP_FROM", SMTP_USER or "no-reply@example.com")
SMTP_TLS = os.environ.get("SMTP_TLS", "1") == "1"

APP_BASE_URL = os.environ.get("APP_BASE_URL", "").strip().rstrip("/")
print("APP_BASE_URL =", APP_BASE_URL)


def send_email(to_email: str, subject: str, text: str) -> None:
    if not SMTP_HOST or not SMTP_USER or not SMTP_PASS:
        raise RuntimeError("SMTP not configured (missing SMTP_HOST/SMTP_USER/SMTP_PASS)")

    msg = EmailMessage()
    msg["From"] = SMTP_FROM
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(text)

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as s:
        if SMTP_TLS:
            s.starttls()
        s.login(SMTP_USER, SMTP_PASS)
        s.send_message(msg)


# ======================================================
# AUTH API
# ======================================================
from fastapi import HTTPException, Request

@app.get("/api/admin/users")
def admin_users(request: Request):
    uid = require_user(request)

    with db() as conn:
        me = conn.execute(
            "SELECT is_admin FROM users WHERE id = ?",
            (uid,)
        ).fetchone()

        if not me or not int(me["is_admin"] or 0):
            raise HTTPException(status_code=403, detail="Admin only")

        rows = conn.execute("""
            SELECT id, first_name, last_name, email, created_at, is_admin
            FROM users
            ORDER BY id DESC
        """).fetchall()

    return {
        "ok": True,
        "users": [
            {
                "id": int(r["id"]),
                "first_name": r["first_name"] or "",
                "last_name": r["last_name"] or "",
                "email": r["email"] or "",
                "created_at": r["created_at"] or "",
                "is_admin": int(r["is_admin"] or 0),
            }
            for r in rows
        ],
    }


@app.get("/admin", response_class=HTMLResponse)
def admin_page(req: Request):
    require_user(req)  # precisa estar logado
    return FileResponse(STATIC_DIR / "admin.html")


@app.post("/api/signup")
def signup(p: SignupIn):
    salt_hex = secrets.token_hex(16)
    pw_hash = hash_pw(p.password, salt_hex)

    with db() as conn:
        try:
            conn.execute(
                """
                INSERT INTO users(first_name,last_name,email,salt_hex,pass_hash,avatar_path,created_at)
                VALUES (?,?,?,?,?,?,?)
                """,
                (
                    p.first_name.strip(),
                    p.last_name.strip(),
                    p.email.lower().strip(),
                    salt_hex,
                    pw_hash,
                    None,
                    now(),
                ),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(400, "Email already registered")

        uid = conn.execute(
            "SELECT id FROM users WHERE email=?",
            (p.email.lower().strip(),),
        ).fetchone()["id"]

    resp = JSONResponse({"ok": True})
    set_cookie(resp, make_token(uid), remember=True)
    return resp


@app.post("/api/login")
def login(p: LoginIn):
    
    with db() as conn:
        u = conn.execute("SELECT * FROM users WHERE email=?", (p.email.lower().strip(),)).fetchone()
        if not u:
            raise HTTPException(401, "Invalid credentials")

        salt_hex = u["salt_hex"]
        pass_hash = u["pass_hash"]
        if not salt_hex or not pass_hash:
            raise HTTPException(500, "DB mismatch: user missing password fields")

        if hash_pw(p.password, salt_hex) != pass_hash:
            raise HTTPException(401, "Invalid credentials")

        uid = int(u["id"])

    resp = JSONResponse({"ok": True})
    set_cookie(resp, make_token(uid), remember=p.remember)
    return resp



@app.post("/api/logout")
def logout():
    r = JSONResponse({"ok": True})
    r.delete_cookie("wh_session", path="/")
    r.headers["Cache-Control"] = "no-store, max-age=0"
    r.headers["Pragma"] = "no-cache"
    r.headers["Expires"] = "0"
    return r


@app.get("/api/me")
def me(req: Request):
    uid = require_user(req)
    with db() as conn:
        u = conn.execute(
            """
            SELECT id, email, first_name, last_name, hourly_rate, avatar_path, is_admin
            FROM users
            WHERE id=?
            """,
            (uid,),
        ).fetchone()

        

        if not u:
            raise HTTPException(401, "Not logged")
        
        

        return {
            "ok": True,
            "id": int(u["id"]),
            "email": u["email"],
            "first_name": u["first_name"] or "",
            "last_name": u["last_name"] or "",
            "hourly_rate": float(u["hourly_rate"] or 0),
            "avatar_url": u["avatar_path"] or "",
            "is_admin": int(u["is_admin"] or 0),
        }



@app.patch("/api/me")
def me_patch(p: MeUpdate, req: Request):
    uid = require_user(req)
    with db() as conn:
        u = conn.execute("SELECT id FROM users WHERE id=?", (uid,)).fetchone()
        if not u:
            raise HTTPException(401, "Not logged")

        if p.first_name is not None:
            conn.execute("UPDATE users SET first_name=? WHERE id=?", (p.first_name.strip(), uid))
        if p.last_name is not None:
            conn.execute("UPDATE users SET last_name=? WHERE id=?", (p.last_name.strip(), uid))
        if p.hourly_rate is not None:
            hr = float(p.hourly_rate)
            if hr < 0 or hr > 200:
                raise HTTPException(400, "Invalid hourly_rate")
            conn.execute("UPDATE users SET hourly_rate=? WHERE id=?", (hr, uid))

        conn.commit()

    return {"ok": True}


# ======================================================
# FORGOT / RESET
# ======================================================
def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


@app.post("/api/forgot")
def forgot(p: ForgotIn):
    email = p.email.lower().strip()

    with db() as conn:
        u = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
        if not u:
            return {"ok": True}

        if not APP_BASE_URL:
            raise HTTPException(500, "APP_BASE_URL not configured")

        token = secrets.token_urlsafe(32)
        token_hash = sha256_hex(token)
        expires_at = (datetime.utcnow() + timedelta(minutes=30)).isoformat(timespec="seconds")

        conn.execute("DELETE FROM password_resets WHERE email=?", (email,))
        conn.execute(
            "INSERT INTO password_resets(email, token_hash, expires_at, created_at) VALUES (?,?,?,?)",
            (email, token_hash, expires_at, now()),
        )
        conn.commit()

    reset_link = f"{APP_BASE_URL}/?reset={token}"

    try:
        send_email(
            to_email=email,
            subject="Reset your Work Hours Tracker password",
            text=f"Use this link to reset your password (valid for 30 minutes):\n\n{reset_link}\n",
        )
    except Exception as e:
        print("EMAIL_SEND_FAILED:", repr(e))
        raise HTTPException(500, "Failed to send reset email")

    return {"ok": True}


@app.post("/api/reset")
def reset(p: ResetIn):
    tok = p.token.strip()
    token_hash = sha256_hex(tok)

    with db() as conn:
        row = conn.execute(
            "SELECT email, expires_at FROM password_resets WHERE token_hash=? LIMIT 1",
            (token_hash,),
        ).fetchone()

        if not row:
            raise HTTPException(400, "Invalid or expired token")

        exp = datetime.fromisoformat(row["expires_at"])
        if datetime.utcnow() > exp:
            conn.execute("DELETE FROM password_resets WHERE token_hash=?", (token_hash,))
            conn.commit()
            raise HTTPException(400, "Token expired")

        email = row["email"]

        new_salt = secrets.token_hex(16)
        new_hash = hash_pw(p.new_password, new_salt)

        conn.execute(
            "UPDATE users SET salt_hex=?, pass_hash=? WHERE email=?",
            (new_salt, new_hash, email),
        )

        conn.execute("DELETE FROM password_resets WHERE token_hash=?", (token_hash,))
        conn.commit()

    return {"ok": True}


# ======================================================
# AVATAR (single correct endpoint)
# ======================================================
@app.post("/api/me/avatar")
async def upload_avatar(req: Request, file: UploadFile = File(...)):
    uid = require_user(req)

    if file.content_type not in ("image/jpeg", "image/png", "image/webp"):
        raise HTTPException(400, "Invalid image (use jpg/png/webp)")

    data = await file.read()
    if len(data) > 5_000_000:
        raise HTTPException(400, "Image too large (max 5MB)")

    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[file.content_type]
    fname = f"user_{uid}.{ext}"
    (AVATARS_DIR / fname).write_bytes(data)

    url = f"/uploads/avatars/{fname}"

    with db() as conn:
        conn.execute("UPDATE users SET avatar_path=? WHERE id=?", (url, uid))
        conn.commit()

    return {"ok": True, "avatar_url": url}


@app.get("/uploads/avatars/{fname}")
def get_avatar(fname: str, req: Request):
    uid = require_user(req)
    with db() as conn:
        row = conn.execute(
            "SELECT avatar_path FROM users WHERE id=?",
            (uid,),
        ).fetchone()

    avatar_path = row["avatar_path"] if row and row["avatar_path"] else ""
    if not avatar_path or Path(avatar_path).name != fname:
        raise HTTPException(403, "Forbidden")

    p = (AVATARS_DIR / fname).resolve()
    if not str(p).startswith(str(AVATARS_DIR.resolve())):
        raise HTTPException(400, "Invalid file")
    if not p.exists():
        raise HTTPException(404, "Not found")

    resp = FileResponse(p)
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp


# ======================================================
# COMPANY RULES (TESCO) - CALC CORE
# ======================================================
SHIFT_A_IN = "09:45"
SHIFT_A_OUT = "19:00"
SHIFT_B_IN = "10:45"
SHIFT_B_OUT = "20:00"

BREAK_FIXED_MIN = 60
TOLERANCE_MIN = 5

# ====== 15-min rounding helpers ======
ROUND_STEP_MIN = 15

def round_floor(mins: int, step: int = ROUND_STEP_MIN) -> int:
    mins = int(mins or 0)
    return (mins // step) * step

def round_ceil(mins: int, step: int = ROUND_STEP_MIN) -> int:
    mins = int(mins or 0)
    return ((mins + step - 1) // step) * step

def compute_paid_window(
    official_in: Optional[str],
    official_out: Optional[str],
    real_in: Optional[str],
    real_out: Optional[str],
    authorized: bool,
) -> tuple[Optional[int], Optional[int], dict]:
    """
    Returns: (paid_in_min, paid_out_min, meta)
    meta includes the reasons/snap flags for debugging/UI.
    """
    meta = {
        "snap_in": False,
        "snap_out": False,
        "cap_in": False,
        "cap_out": False,
        "round_in": False,
        "round_out": False,
        "official_in": official_in,
        "official_out": official_out,
        "authorized": bool(authorized),
    }

    if not real_in or not real_out:
        return None, None, meta

    rin = hhmm_to_min(real_in)
    rout = hhmm_to_min(real_out)

    # handle overnight
    if rout < rin:
        rout += 24 * 60

    paid_in = rin
    paid_out = rout

    # --- IN rules ---
    if official_in:
        off_in = hhmm_to_min(official_in)
        # snap to official if within tolerance
        if abs(rin - off_in) <= TOLERANCE_MIN:
            paid_in = off_in
            meta["snap_in"] = True
        else:
            # if overtime NOT authorized and arrived early -> cap to official start
            if (not authorized) and (rin < off_in - TOLERANCE_MIN):
                paid_in = off_in
                meta["cap_in"] = True

    # --- OUT rules ---
    if official_out:
        off_out = hhmm_to_min(official_out)
        # if overnight compared to official, align official too
        if off_out < hhmm_to_min(official_in) if official_in else False:
            off_out += 24 * 60

        # snap to official if within tolerance
        if abs((rout) - off_out) <= TOLERANCE_MIN:
            paid_out = off_out
            meta["snap_out"] = True
        else:
            # if overtime NOT authorized and left late -> cap to official end
            if (not authorized) and (rout > off_out + TOLERANCE_MIN):
                paid_out = off_out
                meta["cap_out"] = True

    # --- 15-min rounding ---
    # only round when NOT snapped to official
    if not meta["snap_in"]:
        # IN rounds UP
        paid_in2 = round_ceil(paid_in)
        meta["round_in"] = (paid_in2 != paid_in)
        paid_in = paid_in2

    if not meta["snap_out"]:
        # OUT rounds DOWN
        paid_out2 = round_floor(paid_out)
        meta["round_out"] = (paid_out2 != paid_out)
        paid_out = paid_out2

    # final safety: never negative
    if paid_out < paid_in:
        paid_out = paid_in

    return int(paid_in), int(paid_out), meta


def minutes_paid_between(
    conn: sqlite3.Connection,
    uid: int,
    work_date: str,
    time_in_real: Optional[str],
    time_out_real: Optional[str],
    break_real: int,
    authorized: bool,
) -> tuple[int, dict]:
    """
    Returns (paid_minutes, meta) using roster + tolerance + 15-min rounding.
    """
    if not time_in_real or not time_out_real:
        return 0, {"reason": "missing_in_or_out"}

    ro = roster_for_date(conn, uid, work_date)
    official_in = ro["shift_in"] if ro and not int(ro["day_off"] or 0) else None
    official_out = ro["shift_out"] if ro and not int(ro["day_off"] or 0) else None

    # fallback: if no roster for the day, use detect_shift based on real_in
    if not official_in or not official_out:
        sh = detect_shift(time_in_real)
        if sh:
            official_in, official_out = sh

    paid_in_min, paid_out_min, meta = compute_paid_window(
        official_in, official_out, time_in_real, time_out_real, authorized
    )
    if paid_in_min is None or paid_out_min is None:
        return 0, {"reason": "no_paid_window"}

    worked = max(0, paid_out_min - paid_in_min)
    br = effective_break_minutes(time_in_real, time_out_real, break_real)
    paid = max(0, worked - br)

    meta.update({
        "paid_in_hhmm": min_to_hhmm(paid_in_min % (24*60)),
        "paid_out_hhmm": min_to_hhmm(paid_out_min % (24*60)),
        "break_effective": int(br),
        "paid_minutes": int(paid),
    })
    return int(paid), meta


# Public Holiday premium (payslip). Default = 1.0787 (~€19.67/h when base is €18.24/h)
PUBLIC_HOLIDAY_MULT = float(os.environ.get("PUBLIC_HOLIDAY_MULT", "1.0787"))


def hhmm_to_min(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def min_to_hhmm(m: int) -> str:
    m = int(m or 0)
    return f"{m//60:02d}:{m%60:02d}"


def _parse_hhmm_naive(value: Optional[str]) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.strptime(text[:5], "%H:%M")
    except Exception:
        return None


def detect_shift(time_in: Optional[str]):
    if not time_in:
        return None
    t = hhmm_to_min(time_in)
    if t <= hhmm_to_min("10:15"):
        return (SHIFT_A_IN, SHIFT_A_OUT)
    return (SHIFT_B_IN, SHIFT_B_OUT)


def apply_tolerance(real: str, official: str) -> int:
    real_m = hhmm_to_min(real)
    off_m = hhmm_to_min(official)
    if abs(real_m - off_m) <= TOLERANCE_MIN:
        return off_m
    return real_m


def effective_break_minutes(t_in: Optional[str], t_out: Optional[str], break_real: int) -> int:
    if not t_in or not t_out:
        return 0
    return max(BREAK_FIXED_MIN, int(break_real or 0))


def compute_week_entry_summary(
    time_in: Optional[str],
    time_out: Optional[str],
    break_minutes: Optional[int],
    hourly_rate: float,
    multiplier: float,
) -> tuple[Optional[int], float]:
    if not time_in or not time_out:
        return None, 0.0

    in_dt = _parse_hhmm_naive(time_in)
    out_dt = _parse_hhmm_naive(time_out)
    if not in_dt or not out_dt:
        return None, 0.0

    gross_minutes = int((out_dt - in_dt).total_seconds() / 60)
    if gross_minutes < 0:
        gross_minutes += 24 * 60

    net_minutes = gross_minutes - int(break_minutes or 0)
    if net_minutes < 0:
        net_minutes = 0

    gross_pay = (net_minutes / 60.0) * float(hourly_rate or 0.0) * float(multiplier or 1.0)
    return int(net_minutes), gross_pay

def clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))

def calc_paid_times_authorized(t_in: Optional[str], t_out: Optional[str]) -> dict:
    """
    Authorized overtime: keep your normal Tesco logic (detect_shift + tolerance).
    Returns paid_in_hhmm / paid_out_hhmm (best effort).
    """
    if not t_in or not t_out:
        return {"paid_in_hhmm": "", "paid_out_hhmm": ""}

    shift = detect_shift(t_in)
    if not shift:
        return {"paid_in_hhmm": t_in, "paid_out_hhmm": t_out}

    shift_in, shift_out = shift
    paid_in_m = apply_tolerance(t_in, shift_in)
    paid_out_m = apply_tolerance(t_out, shift_out)

    return {"paid_in_hhmm": min_to_hhmm(paid_in_m), "paid_out_hhmm": min_to_hhmm(paid_out_m)}

def calc_paid_times_roster(conn: sqlite3.Connection, uid: int, work_date: str,
                           t_in: Optional[str], t_out: Optional[str]) -> dict:
    """
    NOT authorized: paid window comes from roster (with tolerance + clamp to roster window).
    """
    if not t_in or not t_out:
        return {"paid_in_hhmm": "", "paid_out_hhmm": ""}

    ro = roster_for_date(conn, uid, work_date)
    if not ro or int(ro["day_off"] or 0) == 1 or not ro["shift_in"] or not ro["shift_out"]:
        # fallback: use authorized-style paid times (best effort)
        return calc_paid_times_authorized(t_in, t_out)

    off_in = ro["shift_in"]
    off_out = ro["shift_out"]

    off_in_m = hhmm_to_min(off_in)
    off_out_m = hhmm_to_min(off_out)

    paid_in_m = apply_tolerance(t_in, off_in)
    paid_out_m = apply_tolerance(t_out, off_out)

    # clamp to roster window (no early/late paid time)
    paid_in_m = clamp(paid_in_m, off_in_m, off_out_m)
    paid_out_m = clamp(paid_out_m, off_in_m, off_out_m)

    return {"paid_in_hhmm": min_to_hhmm(paid_in_m), "paid_out_hhmm": min_to_hhmm(paid_out_m)}



def minutes_between(work_date: str, t_in: Optional[str], t_out: Optional[str], break_real: int) -> int:
    if not t_in or not t_out:
        return 0

    shift = detect_shift(t_in)
    if not shift:
        return 0

    shift_in, shift_out = shift
    in_m = apply_tolerance(t_in, shift_in)
    out_m = apply_tolerance(t_out, shift_out)

    if out_m < in_m:
        out_m += 24 * 60

    worked = out_m - in_m
    br = effective_break_minutes(t_in, t_out, break_real)
    return max(0, worked - br)

def minutes_between_roster(conn: sqlite3.Connection, uid: int, work_date: str,
                          t_in: Optional[str], t_out: Optional[str], break_real: int) -> int:
    m, _meta = minutes_paid_between(
        conn, uid, work_date,
        t_in, t_out,
        int(break_real or 0),
        authorized=False
    )
    return int(m)



# ======================================================
# DATE HELPERS
# ======================================================
def parse_ymd(s: str) -> date:
    y, m, d = s.split("-")
    return date(int(y), int(m), int(d))


def ddmmyyyy(d: date) -> str:
    return f"{d.day:02d}/{d.month:02d}/{d.year}"


def weekday_short_en(d: date) -> str:
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d.weekday()]


def today_ymd() -> str:
    return local_now().date().isoformat()


def hhmm_now() -> str:
    return local_now().strftime("%H:%M")


def sunday_start(dt: date) -> date:
    return dt - timedelta(days=(dt.weekday() + 1) % 7)


def tesco_fiscal_year_start(fiscal_year: int) -> date:
    """
    Tesco Ireland fiscal year starts on the Sunday on or nearest to 1st March.
    If March 1st is Mon-Thu, go back to the previous Sunday.
    If March 1st is Fri-Sat, go forward to the next Sunday.
    """
    march1 = date(int(fiscal_year), 3, 1)
    weekday = march1.weekday()  # Mon=0 ... Sun=6
    if weekday == 6:
        return march1
    if weekday <= 3:
        return march1 - timedelta(days=weekday + 1)
    return march1 + timedelta(days=6 - weekday)


def tesco_fiscal_week(d: date) -> tuple[int, int]:
    """
    Returns (fiscal_year, week_number) for a given date using Tesco Ireland calendar.
    Weeks run Sunday to Saturday.
    """
    fiscal_year = int(d.year)
    start = tesco_fiscal_year_start(fiscal_year)

    if d < start:
        fiscal_year -= 1
        start = tesco_fiscal_year_start(fiscal_year)
    else:
        next_start = tesco_fiscal_year_start(fiscal_year + 1)
        if d >= next_start:
            fiscal_year += 1
            start = next_start

    week_number = ((d - start).days // 7) + 1
    return fiscal_year, week_number


def tesco_week_number(dt: date) -> int:
    return tesco_fiscal_week(dt)[1]


def sync_tesco_week_numbers(conn: sqlite3.Connection) -> None:
    for table in ("weeks", "rosters"):
        try:
            rows = conn.execute(
                f"SELECT id, start_date, week_number FROM {table} WHERE start_date IS NOT NULL"
            ).fetchall()
        except Exception:
            continue

        for row in rows:
            try:
                start = sunday_start(parse_ymd(row["start_date"]))
                _fiscal_year, week_number = tesco_fiscal_week(start)
            except Exception:
                continue

            if int(row["week_number"] or 0) != int(week_number):
                conn.execute(
                    f"UPDATE {table} SET week_number=? WHERE id=?",
                    (int(week_number), int(row["id"])),
                )


def current_user_hourly_rate(conn: sqlite3.Connection, uid: int) -> float:
    row = conn.execute(
        "SELECT hourly_rate FROM users WHERE id=?",
        (uid,),
    ).fetchone()
    if not row or row["hourly_rate"] is None:
        return 0.0
    try:
        return float(row["hourly_rate"])
    except Exception:
        return 0.0


def create_week_record(
    conn: sqlite3.Connection,
    uid: int,
    start_date: str,
    hourly_rate: float,
) -> sqlite3.Row:
    normalized_start = sunday_start(parse_ymd(start_date)).isoformat()
    _fiscal_year, week_number = tesco_fiscal_week(parse_ymd(normalized_start))
    conn.execute(
        "INSERT INTO weeks(user_id,week_number,start_date,hourly_rate,created_at) VALUES (?,?,?,?,?)",
        (uid, int(week_number), normalized_start, float(hourly_rate), now()),
    )
    conn.commit()
    return conn.execute(
        "SELECT * FROM weeks WHERE user_id=? AND start_date=? ORDER BY id DESC LIMIT 1",
        (uid, normalized_start),
    ).fetchone()


def ensure_current_week_for_user(conn: sqlite3.Connection, uid: int) -> Optional[sqlite3.Row]:
    today = local_now().date()
    weeks = conn.execute(
        "SELECT * FROM weeks WHERE user_id=? ORDER BY date(start_date) ASC, id ASC",
        (uid,),
    ).fetchall()

    if not weeks:
        start = sunday_start(today)
        return create_week_record(conn, uid, start.isoformat(), current_user_hourly_rate(conn, uid))

    current = None
    past = []
    for w in weeks:
        try:
            start = parse_ymd(w["start_date"])
        except Exception:
            continue
        end = start + timedelta(days=6)
        if start <= today <= end:
            current = w
            break
        if start <= today:
            past.append(w)

    if current:
        return current

    if not past:
        return weeks[0]

    latest = past[-1]
    hourly_rate = current_user_hourly_rate(conn, uid)

    while True:
        try:
            start = parse_ymd(latest["start_date"])
        except Exception:
            return latest

        end = start + timedelta(days=6)
        if today <= end:
            return latest

        next_start = (start + timedelta(days=7)).isoformat()
        existing = conn.execute(
            "SELECT * FROM weeks WHERE user_id=? AND start_date=? ORDER BY id DESC LIMIT 1",
            (uid, next_start),
        ).fetchone()
        if existing:
            latest = existing
            continue

        latest = create_week_record(
            conn,
            uid,
            next_start,
            hourly_rate,
        )


def build_week_payload(
    conn: sqlite3.Connection,
    uid: int,
    w: sqlite3.Row,
    include_entries: bool = True,
) -> tuple[dict, int, float]:
    rate = float(w["hourly_rate"] or 0.0)
    start_date = w["start_date"]
    roster_week = conn.execute(
        """
        SELECT week_number
        FROM rosters
        WHERE user_id=? AND start_date=?
        ORDER BY id DESC
        LIMIT 1
        """,
        (uid, start_date),
    ).fetchone()
    if roster_week and roster_week["week_number"] is not None:
        week_number = int(roster_week["week_number"])
    else:
        _fy, week_number = tesco_fiscal_week(parse_ymd(start_date))

    rows = conn.execute(
        """
        SELECT id, work_date, time_in, time_out, break_minutes, note, bh_paid, multiplier, extra_authorized
        FROM entries
        WHERE user_id=? AND week_id=?
        ORDER BY work_date ASC, id ASC
        """,
        (uid, int(w["id"])),
    ).fetchall()

    entries = []
    total_min = 0
    total_pay = 0.0

    for r in rows:
        authorized = bool(int(r["extra_authorized"] or 0) == 1)
        mult = float(r["multiplier"] or 1.0)
        m, pay = compute_week_entry_summary(
            r["time_in"],
            r["time_out"],
            int(r["break_minutes"] or 0),
            rate,
            mult,
        )

        if include_entries:
            d = parse_ymd(r["work_date"])
            entries.append(
                {
                    "id": int(r["id"]),
                    "week_id": int(w["id"]),
                    "work_date": r["work_date"],
                    "weekday": weekday_short_en(d),
                    "date_ddmmyyyy": ddmmyyyy(d),
                    "time_in": r["time_in"] or "",
                    "time_out": r["time_out"] or "",
                    "break_minutes": int(r["break_minutes"] or 0),
                    "note": r["note"],
                    "bh_paid": (None if r["bh_paid"] is None else bool(int(r["bh_paid"]))),
                    "multiplier": float(r["multiplier"] or 1.0),
                    "worked_hhmm": (min_to_hhmm(int(m)) if m is not None else ""),
                    "pay_eur": round(float(pay or 0.0), 2),
                    "time_in_real": r["time_in"] or "",
                    "time_out_real": r["time_out"] or "",
                    "time_in_paid": "",
                    "time_out_paid": "",
                    "extra_authorized": 1 if authorized else 0,
                }
            )

        if m is not None:
            total_min += int(m)
            total_pay += float(pay or 0.0)

    payload = {
        "id": int(w["id"]),
        "week_number": int(week_number),
        "start_date": start_date,
        "hourly_rate": rate,
        "totals": {
            "total_minutes": int(total_min),
            "total_hhmm": f"{total_min//60:02d}:{total_min%60:02d}",
            "total_pay": round(total_pay, 2),
        },
    }
    if include_entries:
        payload["entries"] = entries

    return payload, total_min, total_pay


def build_clock_today_payload(conn: sqlite3.Connection, uid: int) -> dict:
    ensure_clock_tables(conn)

    w = get_current_week(conn, uid)
    if not w:
        return {
            "ok": True,
            "has_week": False,
            "in_time": None,
            "out_time": None,
            "break_minutes": 0,
            "break_running": False,
        }

    work_date = today_ymd()
    e = get_today_entry(conn, uid, int(w["id"]), work_date)
    if not e:
        return {
            "ok": True,
            "has_week": True,
            "week_id": int(w["id"]),
            "work_date": work_date,
            "in_time": None,
            "out_time": None,
            "break_minutes": 0,
            "break_running": False,
        }

    st = conn.execute("SELECT * FROM clock_state WHERE user_id=?", (uid,)).fetchone()

    if not st or st["work_date"] != work_date:
        conn.execute(
            """
            INSERT INTO clock_state(user_id,week_id,work_date,in_time,out_time,break_running,break_start,break_minutes,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET
              week_id=excluded.week_id,
              work_date=excluded.work_date,
              in_time=excluded.in_time,
              out_time=excluded.out_time,
              break_running=0,
              break_start=NULL,
              break_minutes=excluded.break_minutes,
              updated_at=excluded.updated_at
            """,
            (
                uid,
                int(w["id"]),
                work_date,
                e["time_in"],
                e["time_out"],
                0,
                None,
                int(e["break_minutes"] or 0),
                now(),
            ),
        )
        conn.commit()
        st = conn.execute("SELECT * FROM clock_state WHERE user_id=?", (uid,)).fetchone()
    else:
        conn.execute(
            """
            UPDATE clock_state
            SET week_id=?,
                in_time=?,
                out_time=?,
                break_minutes=?,
                updated_at=?
            WHERE user_id=? AND work_date=?
            """,
            (int(w["id"]), e["time_in"], e["time_out"], int(e["break_minutes"] or 0), now(), uid, work_date),
        )
        conn.commit()
        st = conn.execute("SELECT * FROM clock_state WHERE user_id=?", (uid,)).fetchone()

    return {
        "ok": True,
        "has_week": True,
        "week_id": int(w["id"]),
        "work_date": work_date,
        "in_time": st["in_time"],
        "out_time": st["out_time"],
        "break_minutes": int(st["break_minutes"] or 0),
        "break_running": bool(int(st["break_running"] or 0)),
    }


def build_dashboard_payload(conn: sqlite3.Connection, uid: int) -> dict:
    weeks = conn.execute(
        "SELECT * FROM weeks WHERE user_id=? ORDER BY start_date ASC",
        (uid,),
    ).fetchall()

    current_week = get_current_week(conn, uid)

    total_min_all = 0
    total_pay_all = 0.0
    for w in weeks:
        _payload, week_min, week_pay = build_week_payload(conn, uid, w, include_entries=False)
        total_min_all += int(week_min)
        total_pay_all += float(week_pay)

    this_week_min = 0
    this_week_pay = 0.0
    this_week_payload = None
    if current_week:
        this_week_payload, this_week_min, this_week_pay = build_week_payload(conn, uid, current_week, include_entries=False)

    supported_years = [y for y in (2025, 2026) if irish_bank_holidays(y)]
    bh_years_out = []
    total_allowance = 0
    total_paid = 0

    for y in supported_years:
        ensure_bh_for_year(conn, uid, y)
        rows = conn.execute(
            """
            SELECT paid
            FROM bank_holidays
            WHERE user_id=? AND year=?
              AND applicable=1
              AND date(bh_date) <= date('now')
            """,
            (uid, y),
        ).fetchall()

        allowance = len(rows)
        paid = sum(1 for r in rows if int(r["paid"] or 0) == 1)
        not_paid = allowance - paid

        bh_years_out.append({"year": y, "allowance": allowance, "paid": paid, "not_paid": not_paid})
        total_allowance += allowance
        total_paid += paid

    total_remaining = total_allowance - total_paid

    return {
        "this_week": {
            "id": (int(this_week_payload["id"]) if this_week_payload else (int(current_week["id"]) if current_week else None)),
            "week_number": (int(this_week_payload["week_number"]) if this_week_payload else (int(current_week["week_number"]) if current_week else None)),
            "hourly_rate": (float(this_week_payload["hourly_rate"]) if this_week_payload else (float(current_week["hourly_rate"] or 0.0) if current_week else 0.0)),
            "hhmm": f"{this_week_min//60:02d}:{this_week_min%60:02d}",
            "pay_eur": round(this_week_pay, 2),
        },
        "bank_holidays_years": bh_years_out,
        "bank_holidays": {"allowance": total_allowance, "paid": total_paid, "remaining": total_remaining},
        "all_time": {
            "hhmm": f"{total_min_all//60:02d}:{total_min_all%60:02d}",
            "pay_eur": round(total_pay_all, 2),
        },
    }


def build_report_current_week_payload(conn: sqlite3.Connection, uid: int) -> dict:
    w = get_current_week(conn, uid)
    if not w:
        return {
            "ok": True,
            "has_week": False,
            "week": None,
            "entries": [],
            "totals": {"total_minutes": 0, "total_hhmm": "00:00", "total_pay": 0.0},
        }

    payload, _total_min, _total_pay = build_week_payload(conn, uid, w, include_entries=True)
    return {
        "ok": True,
        "has_week": True,
        "week": {
            "id": payload["id"],
            "week_number": payload["week_number"],
            "start_date": payload["start_date"],
            "hourly_rate": payload["hourly_rate"],
        },
        "entries": payload.get("entries", []),
        "totals": payload["totals"],
    }


def build_roster_week_summary(conn: sqlite3.Connection, uid: int) -> Optional[dict]:
    today = today_ymd()
    ro = roster_for_date(conn, uid, today)
    if not ro:
        return None

    roster_id = int(ro["roster_id"])
    rows = conn.execute(
        """
        SELECT work_date, day_off, shift_in, shift_out, status
        FROM roster_days
        WHERE roster_id=? AND user_id=?
        ORDER BY date(work_date) ASC, id ASC
        """,
        (roster_id, uid),
    ).fetchall()

    days = []
    total_minutes = 0
    scheduled_so_far_minutes = 0
    today_dt = parse_ymd(today)

    for row in rows:
        day_off = bool(int(row["day_off"] or 0))
        has_shift = bool(row["shift_in"] and row["shift_out"] and not day_off)
        minutes = 0
        if has_shift:
            minutes = max(0, hhmm_to_min(row["shift_out"]) - hhmm_to_min(row["shift_in"]))

        day_payload = {
            "work_date": row["work_date"],
            "day_off": day_off,
            "shift_in": row["shift_in"],
            "shift_out": row["shift_out"],
            "status": roster_day_status_from_row(row),
            "minutes": minutes,
        }
        days.append(day_payload)
        total_minutes += minutes

        try:
            row_date = parse_ymd(row["work_date"])
            if row_date <= today_dt:
                scheduled_so_far_minutes += minutes
        except Exception:
            pass

    today_day = next((day for day in days if day["work_date"] == today), None)

    return {
        "id": roster_id,
        "weekNumber": int(ro["week_number"]),
        "startDate": ro["start_date"],
        "days": days,
        "totalMinutes": total_minutes,
        "scheduledSoFarMinutes": scheduled_so_far_minutes,
        "todayDay": today_day,
    }


def build_roster_current_payload(conn: sqlite3.Connection, uid: int) -> dict:
    today = today_ymd()
    ro = roster_for_date(conn, uid, today)
    if not ro:
        return {
            "has_roster": False,
            "work_date": today,
            "week_number": None,
            "start_date": None,
            "day_off": True,
            "shift_in": None,
            "shift_out": None,
            "status": "OFF",
        }

    fiscal_year, week_number = tesco_fiscal_week(parse_ymd(today))
    return {
        "has_roster": True,
        "work_date": today,
        "fiscal_year": fiscal_year,
        "week_number": week_number,
        "start_date": ro["start_date"],
        "day_off": bool(int(ro["day_off"] or 0)),
        "shift_in": ro["shift_in"],
        "shift_out": ro["shift_out"],
        "status": roster_day_status_from_row(ro),
    }


def build_deliveries_stats_payload(conn: sqlite3.Connection, uid: int) -> dict:
    today = local_now().date()
    month_start = today.replace(day=1)
    week_start = today - timedelta(days=today.weekday())
    week_end = week_start + timedelta(days=6)

    ensure_v2_defaults(conn, uid)
    rows = conn.execute(
        """
        SELECT work_date, run_no, location, delivery_count
        FROM deliveries
        WHERE user_id=?
        ORDER BY date(work_date) ASC, run_no ASC, id ASC
        """,
        (uid,),
    ).fetchall()

    deliveries = [
        {
            "work_date": r["work_date"],
            "run_no": int(r["run_no"]),
            "location": r["location"],
            "delivery_count": int(r["delivery_count"] or 0),
        }
        for r in rows
    ]

    def sum_in_range(start_d: date, end_d: date) -> Dict[str, Any]:
        filtered = [r for r in deliveries if start_d <= parse_ymd(r["work_date"]) <= end_d]
        total = sum(int(r["delivery_count"] or 0) for r in filtered)
        run_1 = sum(int(r["delivery_count"] or 0) for r in filtered if int(r["run_no"]) == 1)
        run_2 = sum(int(r["delivery_count"] or 0) for r in filtered if int(r["run_no"]) == 2)
        by_location: Dict[str, int] = {loc: 0 for loc in DELIVERY_LOCATIONS}
        for r in filtered:
            by_location[r["location"]] = by_location.get(r["location"], 0) + int(r["delivery_count"] or 0)
        distinct_days = len({r["work_date"] for r in filtered}) or 1
        distinct_weeks = len({
            f"{parse_ymd(r['work_date']).isocalendar().year}-{parse_ymd(r['work_date']).isocalendar().week}"
            for r in filtered
        }) or 1
        trend: Dict[str, int] = {}
        for r in filtered:
            trend[r["work_date"]] = trend.get(r["work_date"], 0) + int(r["delivery_count"] or 0)
        return {
            "total": total,
            "run_1": run_1,
            "run_2": run_2,
            "by_location": by_location,
            "avg_per_day": round(total / distinct_days, 2) if distinct_days else 0.0,
            "avg_per_week": round(total / distinct_weeks, 2) if distinct_weeks else 0.0,
            "trend": trend,
        }

    week = sum_in_range(week_start, week_end)
    month = sum_in_range(month_start, today)

    weekly_trend = []
    for i in range(7):
        d = week_start + timedelta(days=i)
        weekly_trend.append(
            {
                "date": d.isoformat(),
                "label": weekday_short_en(d),
                "value": int(week["trend"].get(d.isoformat(), 0)),
            }
        )

    monthly_trend = []
    cursor = month_start
    while cursor <= today:
        monthly_trend.append(
            {
                "date": cursor.isoformat(),
                "label": f"{cursor.day:02d}",
                "value": int(month["trend"].get(cursor.isoformat(), 0)),
            }
        )
        cursor += timedelta(days=1)

    location_breakdown = [
        {"location": loc, "count": int(month["by_location"].get(loc, 0))}
        for loc in DELIVERY_LOCATIONS
    ]
    most_frequent_location = max(location_breakdown, key=lambda item: item["count"], default={"location": None, "count": 0})

    return {
        "ok": True,
        "week": {
            "total": int(week["total"]),
            "run_1": int(week["run_1"]),
            "run_2": int(week["run_2"]),
            "avg_per_day": week["avg_per_day"],
            "avg_per_week": week["avg_per_week"],
            "trend": weekly_trend,
        },
        "month": {
            "total": int(month["total"]),
            "run_1": int(month["run_1"]),
            "run_2": int(month["run_2"]),
            "avg_per_day": month["avg_per_day"],
            "avg_per_week": month["avg_per_week"],
            "trend": monthly_trend,
        },
        "items": deliveries,
        "most_frequent_location": most_frequent_location["location"],
    }


def build_home_payload(conn: sqlite3.Connection, uid: int) -> dict:
    today = today_ymd()
    return {
        "clock": build_clock_today_payload(conn, uid),
        "dashboard": build_dashboard_payload(conn, uid),
        "week": build_report_current_week_payload(conn, uid),
        "roster_summary": {
            "current_day": build_roster_current_payload(conn, uid),
            "week": build_roster_week_summary(conn, uid),
        },
        "deliveries": build_deliveries_stats_payload(conn, uid),
        "today_multiplier": multiplier_for_date(conn, uid, today),
    }


# ======================================================
# MULTIPLIER (Sunday / BH paid)
# ======================================================
def multiplier_for_date(conn: sqlite3.Connection, uid: int, work_date: str) -> float:
    """
    Priority:
      1) Public Holiday paid => PUBLIC_HOLIDAY_MULT
      2) Sunday => 1.5
      3) else => 1.0
    """
    try:
        row = conn.execute(
            "SELECT paid FROM bank_holidays WHERE user_id=? AND bh_date=? LIMIT 1",
            (uid, work_date),
        ).fetchone()
        if row and int(row["paid"] or 0) == 1:
            return float(PUBLIC_HOLIDAY_MULT)

        d = parse_ymd(work_date)
        return 1.5 if d.weekday() == 6 else 1.0
    except Exception:
        return 1.0


# ======================================================
# BH: cálculo de horas (regra Tesco 13 semanas ÷ 5)
# ======================================================
def calculate_bh_pay_hours(
    conn: sqlite3.Connection, uid: int, taken_on_date: str
) -> tuple[float, bool]:
    """
    Calcula horas pagas num dia de BH off.
    Regra Tesco: soma horas brutas das últimas 13 semanas calendário ÷ 13 ÷ 5.
    Se menos de 13 semanas disponíveis, divide pelo nº real de semanas.
    Fallback: 8h se sem histórico.
    Retorna (horas, fallback_usado).
    """
    try:
        taken = parse_ymd(taken_on_date)
    except Exception:
        return 8.0, True

    window_start = taken - timedelta(weeks=13)

    rows = conn.execute(
        """
        SELECT time_in, time_out, break_minutes, work_date
        FROM entries
        WHERE user_id=?
          AND date(work_date) >= ? AND date(work_date) < ?
          AND time_in IS NOT NULL AND time_out IS NOT NULL
        ORDER BY work_date ASC
        """,
        (uid, window_start.isoformat(), taken.isoformat()),
    ).fetchall()

    if not rows:
        return 8.0, True

    total_minutes = 0
    weeks_with_data: set[str] = set()

    for r in rows:
        try:
            t_in = hhmm_to_min(r["time_in"])
            t_out = hhmm_to_min(r["time_out"])
            if t_out < t_in:
                t_out += 24 * 60
            worked = max(0, t_out - t_in - int(r["break_minutes"] or 0))
            total_minutes += worked
            # Agrupar por semana calendário (domingo)
            d = parse_ymd(r["work_date"])
            wk_sun = (d - timedelta(days=(d.weekday() + 1) % 7)).isoformat()
            weeks_with_data.add(wk_sun)
        except Exception:
            continue

    if total_minutes == 0:
        return 8.0, True

    num_weeks = max(1, min(13, len(weeks_with_data)))
    hours = round((total_minutes / 60.0) / num_weeks / 5, 4)
    return hours, False


# ======================================================
# BANK HOLIDAYS API
# ======================================================
@app.get("/api/bank-holidays/years")
def bh_years(req: Request):
    uid = require_user(req)
    with db() as conn:
        rows = conn.execute(
            "SELECT DISTINCT year FROM bank_holidays WHERE user_id=? ORDER BY year ASC",
            (uid,),
        ).fetchall()

        years = [int(r["year"]) for r in rows if r["year"] is not None]

        for y in (2025, 2026):
            if y not in years and irish_bank_holidays(y):
                years.append(y)

        years = sorted(set(years))
        return {"years": years}


@app.get("/api/bank-holidays/year/{year}")
def list_bh_year(year: int, req: Request):
    uid = require_user(req)
    with db() as conn:
        ensure_bh_for_year(conn, uid, year)
        rows = conn.execute(
            """
            SELECT id, name, bh_date, paid, paid_date, paid_week, applicable,
                   amount_paid, pay_hours, roster_day_id
            FROM bank_holidays
            WHERE user_id=? AND year=?
            ORDER BY date(bh_date) ASC, id ASC
            """,
            (uid, year),
        ).fetchall()

        return [
            {
                "id": int(r["id"]),
                "name": r["name"],
                "date": r["bh_date"],
                "paid": bool(r["paid"]),
                "paid_date": r["paid_date"],
                "paid_week": r["paid_week"],
                "applicable": bool(r["applicable"]),
                "amount_paid": (float(r["amount_paid"]) if r["amount_paid"] is not None else None),
                "pay_hours": (float(r["pay_hours"]) if r["pay_hours"] is not None else None),
                "roster_day_id": (int(r["roster_day_id"]) if r["roster_day_id"] is not None else None),
            }
            for r in rows
        ]


@app.get("/api/bank-holidays/lookup")
def bh_lookup(req: Request, date_ymd: str):
    uid = require_user(req)
    try:
        y = int(date_ymd.split("-")[0])
    except Exception:
        raise HTTPException(400, "Invalid date")

    with db() as conn:
        ensure_bh_for_year(conn, uid, y)
        row = conn.execute(
            """
            SELECT id, name, bh_date, paid, paid_date, paid_week
            FROM bank_holidays
            WHERE user_id=? AND year=? AND bh_date=?
            LIMIT 1
            """,
            (uid, y, date_ymd),
        ).fetchone()

        if not row:
            return {"is_bh": False}

        return {
            "is_bh": True,
            "id": int(row["id"]),
            "name": row["name"],
            "date": row["bh_date"],
            "paid": bool(row["paid"]),
            "paid_date": row["paid_date"],
            "paid_week": row["paid_week"],
        }


@app.patch("/api/bank-holidays/{bh_id}")
def patch_bh(bh_id: int, p: BhPaidPatch, req: Request):
    uid = require_user(req)
    with db() as conn:
        row = conn.execute(
            "SELECT id FROM bank_holidays WHERE id=? AND user_id=?",
            (bh_id, uid),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Bank holiday not found")

        if p.applicable is not None:
            conn.execute(
                "UPDATE bank_holidays SET applicable=? WHERE id=? AND user_id=?",
                (1 if p.applicable else 0, bh_id, uid),
            )
            if p.applicable is False:
                conn.execute(
                    """
                    UPDATE bank_holidays
                    SET paid=0, paid_date=NULL, paid_week=NULL
                    WHERE id=? AND user_id=?
                    """,
                    (bh_id, uid),
                )

        if p.paid is not None:
            if p.paid:
                conn.execute(
                    """
                    UPDATE bank_holidays
                    SET paid=1, paid_date=?, paid_week=?
                    WHERE id=? AND user_id=?
                    """,
                    (
                        (p.paid_date.strip() if p.paid_date else None),
                        (int(p.paid_week) if p.paid_week is not None else None),
                        bh_id,
                        uid,
                    ),
                )
            else:
                conn.execute(
                    """
                    UPDATE bank_holidays
                    SET paid=0, paid_date=NULL, paid_week=NULL
                    WHERE id=? AND user_id=?
                    """,
                    (bh_id, uid),
                )

        conn.commit()

    return {"ok": True}


# ======================================================
# BANK HOLIDAYS — Novos endpoints (fluxo consumo)
# ======================================================
@app.get("/api/bank-holidays/available")
def bh_available(req: Request, year: int = Query(...)):
    """Lista BHs disponíveis (não pagos, aplicáveis) para um ano."""
    uid = require_user(req)
    with db() as conn:
        ensure_bh_for_year(conn, uid, year)
        rows = conn.execute(
            """
            SELECT id, name, bh_date
            FROM bank_holidays
            WHERE user_id=? AND year=? AND paid=0 AND applicable=1
            ORDER BY date(bh_date) ASC
            """,
            (uid, year),
        ).fetchall()
        return [{"id": int(r["id"]), "name": r["name"], "date": r["bh_date"]} for r in rows]


@app.get("/api/bank-holidays/used")
def bh_used(req: Request, year: int = Query(...)):
    """Lista BHs já pagos para um ano."""
    uid = require_user(req)
    with db() as conn:
        ensure_bh_for_year(conn, uid, year)
        rows = conn.execute(
            """
            SELECT id, name, bh_date, paid_date, amount_paid, pay_hours, roster_day_id
            FROM bank_holidays
            WHERE user_id=? AND year=? AND paid=1
            ORDER BY date(paid_date) ASC, date(bh_date) ASC
            """,
            (uid, year),
        ).fetchall()
        return [
            {
                "id": int(r["id"]),
                "name": r["name"],
                "date": r["bh_date"],
                "paid_date": r["paid_date"],
                "amount_paid": (float(r["amount_paid"]) if r["amount_paid"] is not None else None),
                "pay_hours": (float(r["pay_hours"]) if r["pay_hours"] is not None else None),
                "roster_day_id": (int(r["roster_day_id"]) if r["roster_day_id"] is not None else None),
            }
            for r in rows
        ]


@app.get("/api/bank-holidays/summary")
def bh_summary(req: Request, year: int = Query(...)):
    """Resumo do ano: total, pagos, disponíveis, N/A e valor total ganho."""
    uid = require_user(req)
    with db() as conn:
        ensure_bh_for_year(conn, uid, year)
        rows = conn.execute(
            "SELECT paid, applicable, amount_paid FROM bank_holidays WHERE user_id=? AND year=?",
            (uid, year),
        ).fetchall()
        total = sum(1 for r in rows if int(r["applicable"] or 1) == 1)
        paid = sum(1 for r in rows if int(r["paid"] or 0) == 1)
        na = sum(1 for r in rows if int(r["applicable"] or 1) == 0)
        available = total - paid
        total_amount = sum(
            float(r["amount_paid"] or 0) for r in rows if int(r["paid"] or 0) == 1
        )
        return {
            "total": total,
            "paid": paid,
            "available": available,
            "na": na,
            "total_amount_paid": round(total_amount, 2),
        }


@app.get("/api/bank-holidays/preview-pay")
def bh_preview_pay(req: Request, taken_on_date: str = Query(...)):
    """Prévia do pagamento de um BH off para uma data específica."""
    uid = require_user(req)
    with db() as conn:
        pay_hours, fallback = calculate_bh_pay_hours(conn, uid, taken_on_date)
        rate = current_user_hourly_rate(conn, uid)
        amount = round(pay_hours * rate * PUBLIC_HOLIDAY_MULT, 2)
        return {
            "pay_hours": pay_hours,
            "hourly_rate": rate,
            "amount": amount,
            "fallback_used": fallback,
        }


@app.post("/api/bank-holidays/{bh_id}/consume")
def bh_consume(bh_id: int, p: BhConsumeIn, req: Request):
    """Vincula um BH disponível a um roster_day (dia off pago)."""
    uid = require_user(req)
    with db() as conn:
        bh = conn.execute(
            "SELECT id, paid, applicable FROM bank_holidays WHERE id=? AND user_id=?",
            (bh_id, uid),
        ).fetchone()
        if not bh:
            raise HTTPException(404, "Bank holiday not found")
        if int(bh["paid"] or 0) == 1:
            raise HTTPException(400, "Bank holiday already paid")
        if int(bh["applicable"] or 1) == 0:
            raise HTTPException(400, "Bank holiday is not applicable")

        rd = conn.execute(
            "SELECT id, status, bank_holiday_id FROM roster_days WHERE id=? AND user_id=?",
            (p.roster_day_id, uid),
        ).fetchone()
        if not rd:
            raise HTTPException(404, "Roster day not found")
        if str(rd["status"] or "").upper() != "BANK_HOLIDAY":
            raise HTTPException(400, "Roster day is not a Bank Holiday")
        if rd["bank_holiday_id"] is not None:
            raise HTTPException(400, "Roster day already has a bank holiday linked")

        pay_hours, fallback = calculate_bh_pay_hours(conn, uid, p.taken_on_date)
        rate = current_user_hourly_rate(conn, uid)
        amount_paid = round(pay_hours * rate * PUBLIC_HOLIDAY_MULT, 2)

        try:
            _, paid_week = tesco_fiscal_week(parse_ymd(p.taken_on_date))
        except Exception:
            paid_week = None

        conn.execute(
            """
            UPDATE bank_holidays
            SET paid=1, paid_date=?, paid_week=?, pay_hours=?, amount_paid=?, roster_day_id=?
            WHERE id=? AND user_id=?
            """,
            (p.taken_on_date, paid_week, pay_hours, amount_paid, p.roster_day_id, bh_id, uid),
        )
        conn.execute(
            "UPDATE roster_days SET bank_holiday_id=? WHERE id=? AND user_id=?",
            (bh_id, p.roster_day_id, uid),
        )
        conn.commit()

        return {
            "ok": True,
            "pay_hours": pay_hours,
            "amount_paid": amount_paid,
            "hourly_rate": rate,
            "fallback_used": fallback,
        }


@app.post("/api/bank-holidays/{bh_id}/revert")
def bh_revert(bh_id: int, req: Request):
    """Reverte um BH pago de volta para disponível."""
    uid = require_user(req)
    with db() as conn:
        bh = conn.execute(
            "SELECT id, paid, roster_day_id FROM bank_holidays WHERE id=? AND user_id=?",
            (bh_id, uid),
        ).fetchone()
        if not bh:
            raise HTTPException(404, "Bank holiday not found")

        roster_day_id = bh["roster_day_id"]

        conn.execute(
            """
            UPDATE bank_holidays
            SET paid=0, paid_date=NULL, paid_week=NULL, pay_hours=NULL,
                amount_paid=NULL, roster_day_id=NULL
            WHERE id=? AND user_id=?
            """,
            (bh_id, uid),
        )

        # Remove vínculo no roster_day mas mantém status (usuário decide)
        if roster_day_id:
            conn.execute(
                "UPDATE roster_days SET bank_holiday_id=NULL WHERE id=? AND user_id=?",
                (roster_day_id, uid),
            )

        conn.commit()
        return {"ok": True}


@app.post("/api/bank-holidays/{bh_id}/manual-mark-paid")
def bh_manual_mark_paid(bh_id: int, p: BhManualMarkPaidIn, req: Request):
    """Marca BH como pago manualmente, sem vínculo a roster_day."""
    uid = require_user(req)
    with db() as conn:
        bh = conn.execute(
            "SELECT id, paid, applicable FROM bank_holidays WHERE id=? AND user_id=?",
            (bh_id, uid),
        ).fetchone()
        if not bh:
            raise HTTPException(404, "Bank holiday not found")
        if int(bh["applicable"] or 1) == 0:
            raise HTTPException(400, "Bank holiday is not applicable")

        pay_hours = p.pay_hours
        amount_paid = p.amount_paid
        fallback = False

        if pay_hours is None or amount_paid is None:
            calc_hours, fallback = calculate_bh_pay_hours(conn, uid, p.taken_on_date)
            rate = current_user_hourly_rate(conn, uid)
            if pay_hours is None:
                pay_hours = calc_hours
            if amount_paid is None:
                amount_paid = round(pay_hours * rate * PUBLIC_HOLIDAY_MULT, 2)

        try:
            _, paid_week = tesco_fiscal_week(parse_ymd(p.taken_on_date))
        except Exception:
            paid_week = None

        conn.execute(
            """
            UPDATE bank_holidays
            SET paid=1, paid_date=?, paid_week=?, pay_hours=?, amount_paid=?, roster_day_id=NULL
            WHERE id=? AND user_id=?
            """,
            (p.taken_on_date, paid_week, pay_hours, amount_paid, bh_id, uid),
        )
        conn.commit()
        return {"ok": True, "pay_hours": pay_hours, "amount_paid": amount_paid, "fallback_used": fallback}


# ======================================================
# DELIVERIES TRACKER
# ======================================================
DELIVERY_LOCATIONS = ("Dublin 8", "Dublin 15")


def _delivery_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": int(row["id"]),
        "work_date": row["work_date"],
        "run_no": int(row["run_no"]),
        "location": row["location"],
        "delivery_count": int(row["delivery_count"] or 0),
        "note": row["note"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@app.get("/api/deliveries")
def deliveries_list(req: Request):
    uid = require_user(req)
    with db() as conn:
        ensure_v2_defaults(conn, uid)
        rows = conn.execute(
            """
            SELECT *
            FROM deliveries
            WHERE user_id=?
            ORDER BY date(work_date) DESC, run_no ASC, id DESC
            """,
            (uid,),
        ).fetchall()
        return {"items": [_delivery_to_dict(r) for r in rows]}


@app.get("/api/deliveries/day")
def deliveries_day(req: Request, date_ymd: str):
    uid = require_user(req)
    with db() as conn:
        ensure_v2_defaults(conn, uid)
        rows = conn.execute(
            """
            SELECT *
            FROM deliveries
            WHERE user_id=? AND work_date=?
            ORDER BY run_no ASC, id ASC
            """,
            (uid, date_ymd),
        ).fetchall()
        return {"work_date": date_ymd, "items": [_delivery_to_dict(r) for r in rows]}


@app.post("/api/deliveries")
def deliveries_create(p: DeliveryUpsert, req: Request):
    uid = require_user(req)
    try:
        work_date = parse_ymd(p.work_date).isoformat()
    except Exception:
        raise HTTPException(400, "Invalid delivery date")

    location = str(p.location or "").strip()
    if location not in DELIVERY_LOCATIONS:
        raise HTTPException(400, "Invalid delivery location")

    with db() as conn:
        ensure_v2_defaults(conn, uid)
        existing = conn.execute(
            "SELECT id FROM deliveries WHERE user_id=? AND work_date=? AND run_no=?",
            (uid, work_date, int(p.run_no)),
        ).fetchone()
        if existing:
            conn.execute(
                """
                UPDATE deliveries
                SET location=?, delivery_count=?, note=?, updated_at=?
                WHERE id=? AND user_id=?
                """,
                (location, int(p.delivery_count), p.note, now(), int(existing["id"]), uid),
            )
            row_id = int(existing["id"])
        else:
            cur = conn.execute(
                """
                INSERT INTO deliveries(user_id, work_date, run_no, location, delivery_count, note, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (uid, work_date, int(p.run_no), location, int(p.delivery_count), p.note, now(), now()),
            )
            row_id = int(cur.lastrowid)

        conn.commit()
        row = conn.execute("SELECT * FROM deliveries WHERE id=? AND user_id=?", (row_id, uid)).fetchone()
        return {"ok": True, "item": _delivery_to_dict(row)}


@app.put("/api/deliveries/day")
def deliveries_day_upsert(p: DeliveriesDayUpsert, req: Request):
    uid = require_user(req)
    try:
        work_date = parse_ymd(p.work_date).isoformat()
    except Exception:
        raise HTTPException(400, "Invalid delivery date")

    rows = [
        {"run_no": 1, "count": p.run_1_count, "location": p.run_1_location, "note": p.run_1_note},
        {"run_no": 2, "count": p.run_2_count, "location": p.run_2_location, "note": p.run_2_note},
    ]
    for row in rows:
        if row["location"] not in DELIVERY_LOCATIONS:
            raise HTTPException(400, "Invalid delivery location")

    with db() as conn:
        ensure_v2_defaults(conn, uid)
        for row in rows:
            existing = conn.execute(
                "SELECT id FROM deliveries WHERE user_id=? AND work_date=? AND run_no=?",
                (uid, work_date, int(row["run_no"])),
            ).fetchone()
            if existing:
                conn.execute(
                    """
                    UPDATE deliveries
                    SET location=?, delivery_count=?, note=?, updated_at=?
                    WHERE id=? AND user_id=?
                    """,
                    (row["location"], int(row["count"]), row["note"], now(), int(existing["id"]), uid),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO deliveries(user_id, work_date, run_no, location, delivery_count, note, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (uid, work_date, int(row["run_no"]), row["location"], int(row["count"]), row["note"], now(), now()),
                )

        conn.commit()
        items = conn.execute(
            """
            SELECT *
            FROM deliveries
            WHERE user_id=? AND work_date=?
            ORDER BY run_no ASC, id ASC
            """,
            (uid, work_date),
        ).fetchall()
        return {"ok": True, "work_date": work_date, "items": [_delivery_to_dict(r) for r in items]}


@app.patch("/api/deliveries/{delivery_id}")
def deliveries_patch(delivery_id: int, p: DeliveryUpsert, req: Request):
    uid = require_user(req)
    try:
        work_date = parse_ymd(p.work_date).isoformat()
    except Exception:
        raise HTTPException(400, "Invalid delivery date")

    location = str(p.location or "").strip()
    if location not in DELIVERY_LOCATIONS:
        raise HTTPException(400, "Invalid delivery location")

    with db() as conn:
        row = conn.execute(
            "SELECT * FROM deliveries WHERE id=? AND user_id=?",
            (delivery_id, uid),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Delivery entry not found")

        conn.execute(
            """
            UPDATE deliveries
            SET work_date=?, run_no=?, location=?, delivery_count=?, note=?, updated_at=?
            WHERE id=? AND user_id=?
            """,
            (work_date, int(p.run_no), location, int(p.delivery_count), p.note, now(), delivery_id, uid),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM deliveries WHERE id=? AND user_id=?",
            (delivery_id, uid),
        ).fetchone()
        return {"ok": True, "item": _delivery_to_dict(row)}


@app.delete("/api/deliveries/{delivery_id}")
def deliveries_delete(delivery_id: int, req: Request):
    uid = require_user(req)
    with db() as conn:
        conn.execute("DELETE FROM deliveries WHERE id=? AND user_id=?", (delivery_id, uid))
        conn.commit()
        return {"ok": True}


@app.get("/api/deliveries/stats")
def deliveries_stats(req: Request):
    uid = require_user(req)
    with db() as conn:
        return build_deliveries_stats_payload(conn, uid)


# ======================================================
# SETTINGS / SCHEDULE
# ======================================================
@app.get("/api/settings/reminders")
def reminders_get(req: Request):
    uid = require_user(req)
    with db() as conn:
        row = get_reminder_settings(conn, uid)
        return {
            "ok": True,
            "break_enabled": bool(int(row["break_enabled"] or 0)),
            "missed_in_enabled": bool(int(row["missed_in_enabled"] or 0)),
            "missed_out_enabled": bool(int(row["missed_out_enabled"] or 0)),
            "break_reminder_after_min": int(row["break_reminder_after_min"] or 240),
            "missed_in_offset_min": int(row["missed_in_offset_min"] or 10),
            "missed_out_offset_min": int(row["missed_out_offset_min"] or 20),
        }


@app.put("/api/settings/reminders")
def reminders_put(p: ReminderSettingsUpdate, req: Request):
    uid = require_user(req)
    with db() as conn:
        ensure_v2_defaults(conn, uid)
        conn.execute(
            """
            INSERT INTO reminder_settings(
                user_id, break_enabled, missed_in_enabled, missed_out_enabled,
                break_reminder_after_min, missed_in_offset_min, missed_out_offset_min, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                break_enabled=excluded.break_enabled,
                missed_in_enabled=excluded.missed_in_enabled,
                missed_out_enabled=excluded.missed_out_enabled,
                break_reminder_after_min=excluded.break_reminder_after_min,
                missed_in_offset_min=excluded.missed_in_offset_min,
                missed_out_offset_min=excluded.missed_out_offset_min,
                updated_at=excluded.updated_at
            """,
            (
                uid,
                1 if p.break_enabled else 0,
                1 if p.missed_in_enabled else 0,
                1 if p.missed_out_enabled else 0,
                int(p.break_reminder_after_min),
                int(p.missed_in_offset_min),
                int(p.missed_out_offset_min),
                now(),
            ),
        )
        conn.commit()
        return {"ok": True}


@app.get("/api/settings/schedule")
def schedule_get(req: Request):
    uid = require_user(req)
    with db() as conn:
        row = get_schedule_settings(conn, uid)
        try:
            active_days = parse_days_json(row["active_days"] or "[]")
        except Exception:
            active_days = [1, 2, 3, 4, 5]
        return {
            "ok": True,
            "active_days": active_days,
            "start_time": row["start_time"] or "09:00",
            "end_time": row["end_time"] or "17:00",
            "break_after_min": int(row["break_after_min"] or 240),
        }


@app.put("/api/settings/schedule")
def schedule_put(p: ScheduleSettingsUpdate, req: Request):
    uid = require_user(req)
    active_days = sorted({int(d) for d in p.active_days if 0 <= int(d) <= 6})
    start_time = parse_hhmm(p.start_time)
    end_time = parse_hhmm(p.end_time)

    with db() as conn:
        ensure_v2_defaults(conn, uid)
        conn.execute(
            """
            INSERT INTO work_schedule(user_id, active_days, start_time, end_time, break_after_min, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                active_days=excluded.active_days,
                start_time=excluded.start_time,
                end_time=excluded.end_time,
                break_after_min=excluded.break_after_min,
                updated_at=excluded.updated_at
            """,
            (uid, json.dumps(active_days), start_time, end_time, int(p.break_after_min), now()),
        )
        conn.commit()
        return {"ok": True}


# ======================================================
# DAY DETAILS
# ======================================================
@app.get("/api/day-details/{entry_id}")
def day_details(entry_id: int, req: Request):
    uid = require_user(req)

    with db() as conn:
        r = conn.execute(
            "SELECT * FROM entries WHERE id=? AND user_id=?",
            (entry_id, uid),
        ).fetchone()
        if not r:
            raise HTTPException(404, "Entry not found")

        w = conn.execute(
            "SELECT * FROM weeks WHERE id=? AND user_id=?",
            (r["week_id"], uid),
        ).fetchone()
        if not w:
            raise HTTPException(404, "Week not found")

        clocked_in = r["time_in"]
        clocked_out = r["time_out"]
        break_real = int(r["break_minutes"] or 0)

        shift = detect_shift(clocked_in)
        shift_in, shift_out = shift if shift else (None, None)

        if not clocked_in or not clocked_out or not shift_in or not shift_out:
            return {
                "date": r["work_date"],
                "weekday": weekday_short_en(parse_ymd(r["work_date"])),
                "clocked": {"in": clocked_in, "out": clocked_out, "break_real": break_real},
                "tesco": {"shift": None, "tolerance": "±5 min", "break_fixed": BREAK_FIXED_MIN},
                "result": {"hours_made": "00:00", "hours_paid": "00:00", "pay": 0.0},
            }

        paid_in_min = apply_tolerance(clocked_in, shift_in)
        paid_out_min = apply_tolerance(clocked_out, shift_out)
        if paid_out_min < paid_in_min:
            paid_out_min += 24 * 60

        worked_raw = paid_out_min - paid_in_min
        break_eff = effective_break_minutes(clocked_in, clocked_out, break_real)
        worked_paid_min = max(0, worked_raw - break_eff)

        rate = float(w["hourly_rate"] or 0)
        mult = float(r["multiplier"] or 1.0)
        pay = (worked_paid_min / 60) * rate * mult

        hours_made_min = max(0, worked_raw - break_real)

        return {
            "date": r["work_date"],
            "weekday": weekday_short_en(parse_ymd(r["work_date"])),
            "clocked": {"in": clocked_in, "out": clocked_out, "break_real": break_real},
            "tesco": {"shift": f"{shift_in} → {shift_out}", "tolerance": "±5 min", "break_fixed": BREAK_FIXED_MIN},
            "result": {
                "hours_made": min_to_hhmm(hours_made_min),
                "hours_paid": min_to_hhmm(worked_paid_min),
                "break_effective": break_eff,
                "pay": round(pay, 2),
            },
        }


# ======================================================
# ROSTER HELPERS
# ======================================================
def roster_for_date(conn: sqlite3.Connection, uid: int, ymd: str) -> Optional[sqlite3.Row]:
    return conn.execute(
        """
        SELECT
            r.id AS roster_id,
            r.week_number,
            r.start_date,
            rd.work_date,
            rd.shift_in,
            rd.shift_out,
            rd.day_off,
            rd.status
        FROM roster_days rd
        JOIN rosters r ON r.id = rd.roster_id
        WHERE rd.user_id=? AND rd.work_date=?
        ORDER BY r.start_date DESC
        LIMIT 1
        """,
        (uid, ymd),
    ).fetchone()


def decide_clock_time(kind: str, real_now: str, official: Optional[str], authorized: bool):
    """
    Returns (store_time, needs_confirm)

    Rule:
    - If within tolerance -> store OFFICIAL.
    - If authorized -> store REAL.
    - If NOT authorized:
        - EARLY IN  -> store OFFICIAL and ask confirm (so overtime not counted)
        - LATE OUT  -> store OFFICIAL and ask confirm
        - Otherwise -> store REAL (but rounding/tolerance later will handle paid calc anyway)
    """
    if not official:
        return real_now, False  # no roster/official time available

    real_m = hhmm_to_min(real_now)
    off_m = hhmm_to_min(official)
    diff = real_m - off_m

    # within tolerance => snap to official
    if abs(diff) <= TOLERANCE_MIN:
        return official, False

    # if overtime authorized => keep real time
    if authorized:
        return real_now, False

    # NOT authorized => clamp the “store time” to OFFICIAL when it creates overtime
    if kind == "IN":
        # early IN creates overtime -> store official and ask confirm
        if diff < -TOLERANCE_MIN:
            return official, True
        return real_now, False

    if kind == "OUT":
        # late OUT creates overtime -> store official and ask confirm
        if diff > TOLERANCE_MIN:
            return official, True
        return real_now, False

    return real_now, False



def ensure_week_from_roster(conn: sqlite3.Connection, uid: int, start_date: str) -> int:
    normalized_start = sunday_start(parse_ymd(start_date)).isoformat()
    row = conn.execute(
        "SELECT id FROM weeks WHERE user_id=? AND start_date=? LIMIT 1",
        (uid, normalized_start),
    ).fetchone()
    if row:
        return int(row["id"])

    hourly_rate = 0.0
    last = conn.execute(
        "SELECT hourly_rate FROM weeks WHERE user_id=? ORDER BY start_date DESC LIMIT 1",
        (uid,),
    ).fetchone()
    if last and last["hourly_rate"] is not None:
        try:
            hourly_rate = float(last["hourly_rate"])
        except Exception:
            hourly_rate = 0.0

    conn.execute(
        "INSERT INTO weeks(user_id,week_number,start_date,hourly_rate,created_at) VALUES (?,?,?,?,?)",
        (uid, tesco_fiscal_week(parse_ymd(normalized_start))[1], normalized_start, float(hourly_rate), now()),
    )
    conn.commit()
    return int(conn.execute("SELECT last_insert_rowid() id").fetchone()["id"])


# ======================================================
# ROSTER API
# ======================================================
@app.get("/api/roster")
def roster_list(req: Request):
    uid = require_user(req)
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, week_number, start_date
            FROM rosters
            WHERE user_id=?
            ORDER BY date(start_date) DESC, id DESC
            """,
            (uid,),
        ).fetchall()

        return [
            {
                "id": int(r["id"]),
                "week_number": int(r["week_number"]),
                "start_date": r["start_date"],
            }
            for r in rows
        ]


def _normalize_roster_code(code: str) -> str:
    return (code or "").strip().upper()


def _custom_roster_code_to_state(code_up: str) -> tuple[Optional[str], Optional[str], int]:
    m = re.fullmatch(r"CUSTOM:(\d{2}:\d{2})-(\d{2}:\d{2})", code_up)
    if not m:
        raise HTTPException(400, "Invalid custom day code")
    start, end = m.group(1), m.group(2)
    if hhmm_to_min(end) <= hhmm_to_min(start):
        raise HTTPException(400, "Custom end time must be after start time")
    return start, end, 0


def roster_code_to_state(code: str) -> tuple[Optional[str], Optional[str], int]:
    code_up = _normalize_roster_code(code)
    if code_up == "OFF":
        return None, None, 1
    if code_up == "A":
        return SHIFT_A_IN, SHIFT_A_OUT, 0
    if code_up == "B":
        return SHIFT_B_IN, SHIFT_B_OUT, 0
    if code_up == "HOLIDAY":
        return None, None, 1
    if code_up in ("BANK_HOLIDAY", "BANK HOLIDAY", "BH"):
        return None, None, 1
    if code_up.startswith("CUSTOM:"):
        return _custom_roster_code_to_state(code_up)
    raise HTTPException(400, "Invalid day code (use A, B, OFF, HOLIDAY, BANK_HOLIDAY, CUSTOM:HH:MM-HH:MM)")


def roster_code_status(code: str) -> str:
    code_up = _normalize_roster_code(code)
    if code_up.startswith("CUSTOM:"):
        _custom_roster_code_to_state(code_up)
        return code_up
    if code_up in ("BANK HOLIDAY", "BH"):
        return "BANK_HOLIDAY"
    return code_up


def roster_day_status_from_row(row: sqlite3.Row) -> str:
    try:
        status = str(row["status"] or "").strip().upper()
    except Exception:
        status = ""
    if status.startswith("CUSTOM:"):
        return status
    if status in ("A", "B", "OFF", "HOLIDAY", "BANK_HOLIDAY"):
        return status
    if int(row["day_off"] or 0) == 1:
        return "OFF"
    if row["shift_in"] == SHIFT_A_IN:
        return "A"
    if row["shift_in"] == SHIFT_B_IN:
        return "B"
    if row["shift_in"] and row["shift_out"]:
        return f"CUSTOM:{row['shift_in']}-{row['shift_out']}"
    return "OFF"


def sync_bank_holiday_paid_for_date(conn: sqlite3.Connection, uid: int, work_date: str) -> None:
    try:
        y = int(str(work_date).split("-")[0])
    except Exception:
        return

    ensure_bh_for_year(conn, uid, y)
    row = conn.execute(
        """
        SELECT id, paid
        FROM bank_holidays
        WHERE user_id=? AND year=? AND bh_date=?
        LIMIT 1
        """,
        (uid, y, work_date),
    ).fetchone()

    if not row:
        return

    if int(row["paid"] or 0) != 1:
        conn.execute(
            """
            UPDATE bank_holidays
            SET paid=1
            WHERE id=? AND user_id=?
            """,
            (int(row["id"]), uid),
        )

@app.get("/api/roster/day")
def roster_day_lookup(req: Request, date_ymd: str = Query(..., description="YYYY-MM-DD")):
    uid = require_user(req)

    # valida formato
    try:
        parse_ymd(date_ymd)
    except Exception:
        raise HTTPException(400, "Invalid date (use YYYY-MM-DD)")

    with db() as conn:
        ro = roster_for_date(conn, uid, date_ymd)

        if not ro:
            # sem roster cadastrado pra amanhã -> trata como OFF
            return {"has_roster": False, "day_off": True, "shift_in": None, "shift_out": None, "status": "OFF"}

        day_off = bool(int(ro["day_off"] or 0))
        return {
            "has_roster": True,
            "day_off": day_off,
            "shift_in": ro["shift_in"],
            "shift_out": ro["shift_out"],
            "status": roster_day_status_from_row(ro),
        }


@app.get("/api/roster/current")
def roster_current(req: Request):
    uid = require_user(req)
    with db() as conn:
        return build_roster_current_payload(conn, uid)


@app.get("/api/roster/{roster_id}")
def roster_get(roster_id: int, req: Request):
    uid = require_user(req)
    with db() as conn:
        r = conn.execute(
            "SELECT * FROM rosters WHERE id=? AND user_id=?",
            (roster_id, uid),
        ).fetchone()
        if not r:
            raise HTTPException(404, "Roster not found")

        days = conn.execute(
            """
            SELECT *
            FROM roster_days
            WHERE roster_id=? AND user_id=?
            ORDER BY date(work_date) ASC, id ASC
            """,
            (roster_id, uid),
        ).fetchall()

        return {
            "id": int(r["id"]),
            "week_number": int(r["week_number"]),
            "start_date": r["start_date"],
            "days": [
                {
                    "id": int(d["id"]),
                    "work_date": d["work_date"],
                    "day_off": bool(int(d["day_off"] or 0)),
                    "shift_in": d["shift_in"],
                    "shift_out": d["shift_out"],
                    "status": roster_day_status_from_row(d),
                    "bank_holiday_id": (int(d["bank_holiday_id"]) if d["bank_holiday_id"] is not None else None),
                }
                for d in days
            ],
        }


@app.delete("/api/roster/{roster_id}")
def roster_delete(roster_id: int, req: Request):
    uid = require_user(req)
    with db() as conn:
        r = conn.execute(
            "SELECT id FROM rosters WHERE id=? AND user_id=?",
            (roster_id, uid),
        ).fetchone()
        if not r:
            raise HTTPException(404, "Roster not found")

        # Reverter BHs vinculados antes de deletar os dias
        linked = conn.execute(
            """
            SELECT bank_holiday_id FROM roster_days
            WHERE roster_id=? AND user_id=? AND bank_holiday_id IS NOT NULL
            """,
            (roster_id, uid),
        ).fetchall()
        for lnk in linked:
            conn.execute(
                """
                UPDATE bank_holidays
                SET paid=0, paid_date=NULL, paid_week=NULL,
                    pay_hours=NULL, amount_paid=NULL, roster_day_id=NULL
                WHERE id=? AND user_id=?
                """,
                (lnk["bank_holiday_id"], uid),
            )

        conn.execute("DELETE FROM roster_days WHERE roster_id=? AND user_id=?", (roster_id, uid))
        conn.execute("DELETE FROM rosters WHERE id=? AND user_id=?", (roster_id, uid))
        conn.commit()

    return {"ok": True}


@app.post("/api/roster")
def roster_create(p: RosterCreate, req: Request):
    uid = require_user(req)
    if not p.days or len(p.days) != 7:
        raise HTTPException(400, "days must have 7 items (Sun..Sat)")

    start = sunday_start(parse_ymd(p.start_date))
    start_date = start.isoformat()
    _fiscal_year, week_number = tesco_fiscal_week(parse_ymd(start_date))

    with db() as conn:
        dup = conn.execute(
            """
            SELECT id
            FROM rosters
            WHERE user_id=? AND start_date=?
            LIMIT 1
            """,
            (uid, start_date),
        ).fetchone()

        if dup:
            wk = conn.execute(
                "SELECT id FROM weeks WHERE user_id=? AND start_date=? LIMIT 1",
                (uid, start_date),
            ).fetchone()
            return {"ok": True, "id": int(dup["id"]), "week_id": int(wk["id"]) if wk else None}

        week_id = ensure_week_from_roster(conn, uid, start_date)

        conn.execute(
            "INSERT INTO rosters(user_id,week_number,start_date,created_at) VALUES (?,?,?,?)",
            (uid, int(week_number), start_date, now()),
        )
        roster_id = int(conn.execute("SELECT last_insert_rowid() id").fetchone()["id"])

        for i, code in enumerate(p.days):
            d = start + timedelta(days=i)
            ymd = d.isoformat()
            shift_in, shift_out, day_off = roster_code_to_state(code)
            status = roster_code_status(code)

            conn.execute(
                """
                INSERT INTO roster_days(user_id,roster_id,work_date,shift_in,shift_out,day_off,status,created_at)
                VALUES (?,?,?,?,?,?,?,?)
                """,
                (uid, roster_id, ymd, shift_in, shift_out, day_off, status, now()),
            )
            rd_id = int(conn.execute("SELECT last_insert_rowid() id").fetchone()["id"])

            if status == "BANK_HOLIDAY":
                bh_id_for_day = (p.bh_ids or {}).get(str(i))
                if bh_id_for_day:
                    # Novo fluxo: consumir BH específico selecionado no modal
                    bh_row = conn.execute(
                        "SELECT id, paid, applicable FROM bank_holidays WHERE id=? AND user_id=?",
                        (bh_id_for_day, uid),
                    ).fetchone()
                    if bh_row and int(bh_row["paid"] or 0) == 0 and int(bh_row["applicable"] or 1) == 1:
                        pay_hours, _ = calculate_bh_pay_hours(conn, uid, ymd)
                        rate = current_user_hourly_rate(conn, uid)
                        amount_paid = round(pay_hours * rate * PUBLIC_HOLIDAY_MULT, 2)
                        try:
                            _, paid_week = tesco_fiscal_week(parse_ymd(ymd))
                        except Exception:
                            paid_week = None
                        conn.execute(
                            """
                            UPDATE bank_holidays
                            SET paid=1, paid_date=?, paid_week=?, pay_hours=?, amount_paid=?, roster_day_id=?
                            WHERE id=? AND user_id=?
                            """,
                            (ymd, paid_week, pay_hours, amount_paid, rd_id, bh_id_for_day, uid),
                        )
                        conn.execute(
                            "UPDATE roster_days SET bank_holiday_id=? WHERE id=? AND user_id=?",
                            (bh_id_for_day, rd_id, uid),
                        )
                else:
                    # Fluxo legado: sync pelo date match (sem BH selecionado)
                    sync_bank_holiday_paid_for_date(conn, uid, ymd)

        conn.commit()

    return {"ok": True, "id": roster_id, "week_id": int(week_id)}


@app.patch("/api/roster/{roster_id}/day")
def roster_day_patch(roster_id: int, p: RosterDayPatch, req: Request):
    uid = require_user(req)
    code = (p.code or "").strip().upper()
    if not (
        code in ("A", "B", "OFF", "HOLIDAY", "BANK_HOLIDAY", "BANK HOLIDAY", "BH")
        or code.startswith("CUSTOM:")
    ):
        raise HTTPException(400, "Invalid code (use A, B, OFF, HOLIDAY, BANK_HOLIDAY, CUSTOM:HH:MM-HH:MM)")

    with db() as conn:
        r = conn.execute(
            "SELECT id FROM rosters WHERE id=? AND user_id=?",
            (roster_id, uid),
        ).fetchone()
        if not r:
            raise HTTPException(404, "Roster not found")

        d = conn.execute(
            """
            SELECT id, status, bank_holiday_id
            FROM roster_days
            WHERE roster_id=? AND user_id=? AND work_date=?
            """,
            (roster_id, uid, p.work_date),
        ).fetchone()
        if not d:
            raise HTTPException(404, "Roster day not found")

        current_bh_id = d["bank_holiday_id"]
        shift_in, shift_out, day_off = roster_code_to_state(code)
        status = roster_code_status(code)

        conn.execute(
            "UPDATE roster_days SET shift_in=?, shift_out=?, day_off=?, status=? WHERE id=? AND user_id=?",
            (shift_in, shift_out, day_off, status, int(d["id"]), uid),
        )

        # Se tinha BH vinculado e mudou de status: reverter automaticamente
        if current_bh_id and status != "BANK_HOLIDAY":
            conn.execute(
                """
                UPDATE bank_holidays
                SET paid=0, paid_date=NULL, paid_week=NULL,
                    pay_hours=NULL, amount_paid=NULL, roster_day_id=NULL
                WHERE id=? AND user_id=?
                """,
                (current_bh_id, uid),
            )
            conn.execute(
                "UPDATE roster_days SET bank_holiday_id=NULL WHERE id=? AND user_id=?",
                (int(d["id"]), uid),
            )

        if status == "BANK_HOLIDAY":
            if p.bank_holiday_id:
                # Novo fluxo: consumir BH específico
                bh_row = conn.execute(
                    "SELECT id, paid, applicable FROM bank_holidays WHERE id=? AND user_id=?",
                    (p.bank_holiday_id, uid),
                ).fetchone()
                if bh_row and int(bh_row["paid"] or 0) == 0 and int(bh_row["applicable"] or 1) == 1:
                    pay_hours, _ = calculate_bh_pay_hours(conn, uid, p.work_date)
                    rate = current_user_hourly_rate(conn, uid)
                    amount_paid = round(pay_hours * rate * PUBLIC_HOLIDAY_MULT, 2)
                    try:
                        _, paid_week = tesco_fiscal_week(parse_ymd(p.work_date))
                    except Exception:
                        paid_week = None
                    conn.execute(
                        """
                        UPDATE bank_holidays
                        SET paid=1, paid_date=?, paid_week=?, pay_hours=?, amount_paid=?, roster_day_id=?
                        WHERE id=? AND user_id=?
                        """,
                        (p.work_date, paid_week, pay_hours, amount_paid, int(d["id"]), p.bank_holiday_id, uid),
                    )
                    conn.execute(
                        "UPDATE roster_days SET bank_holiday_id=? WHERE id=? AND user_id=?",
                        (p.bank_holiday_id, int(d["id"]), uid),
                    )
            else:
                # Fluxo legado: só sincroniza se não tiver BH vinculado
                if not current_bh_id:
                    sync_bank_holiday_paid_for_date(conn, uid, p.work_date)

        conn.commit()

    return {"ok": True}



# ======================================================
# WEEKS / ENTRIES
# ======================================================
@app.get("/api/weeks")
def list_weeks(req: Request):
    uid = require_user(req)
    with db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM weeks
            WHERE user_id=?
            ORDER BY date(start_date) DESC, id DESC
            """,
            (uid,),
        ).fetchall()

        out = []
        for w in rows:
            payload, _total_min, _total_pay = build_week_payload(conn, uid, w, include_entries=False)
            out.append(
                {
                    "id": payload["id"],
                    "week_number": payload["week_number"],
                    "start_date": payload["start_date"],
                    "hourly_rate": payload["hourly_rate"],
                    "total_hhmm": payload["totals"]["total_hhmm"],
                    "total_pay": payload["totals"]["total_pay"],
                }
            )

        return out



@app.post("/api/weeks")
def create_week(p: WeekCreate, req: Request):
    uid = require_user(req)
    start_date = sunday_start(parse_ymd(p.start_date)).isoformat()
    _fiscal_year, week_number = tesco_fiscal_week(parse_ymd(start_date))
    with db() as conn:
        conn.execute(
            "INSERT INTO weeks(user_id,week_number,start_date,hourly_rate,created_at) VALUES (?,?,?,?,?)",
            (uid, int(week_number), start_date, float(p.hourly_rate), now()),
        )
        conn.commit()
    return {"ok": True}


@app.get("/api/weeks/{week_id}")
def get_week(week_id: int, req: Request):
    uid = require_user(req)
    with db() as conn:
        w = conn.execute("SELECT * FROM weeks WHERE id=? AND user_id=?", (week_id, uid)).fetchone()
        if not w:
            raise HTTPException(404, "Week not found")
        payload, _total_min, _total_pay = build_week_payload(conn, uid, w, include_entries=True)
        return payload



@app.patch("/api/weeks/{week_id}")
def patch_week(week_id: int, p: WeekRatePatch, req: Request):
    uid = require_user(req)
    with db() as conn:
        ok = conn.execute(
            "UPDATE weeks SET hourly_rate=? WHERE id=? AND user_id=?",
            (float(p.hourly_rate), week_id, uid),
        ).rowcount
        conn.commit()
    if not ok:
        raise HTTPException(404, "Week not found")
    return {"ok": True}


@app.delete("/api/weeks/{week_id}")
def delete_week(week_id: int, req: Request):
    uid = require_user(req)
    with db() as conn:
        ok = conn.execute("DELETE FROM weeks WHERE id=? AND user_id=?", (week_id, uid)).rowcount
        conn.commit()
    if not ok:
        raise HTTPException(404, "Week not found")
    return {"ok": True}


@app.put("/api/weeks/{week_id}/entry")
def upsert_entry(week_id: int, p: EntryUpsert, req: Request):
    uid = require_user(req)

    with db() as conn:
        w = conn.execute("SELECT id FROM weeks WHERE id=? AND user_id=?", (week_id, uid)).fetchone()
        if not w:
            raise HTTPException(404, "Week not found")

        mult = multiplier_for_date(conn, uid, p.work_date)

        existing = conn.execute(
            "SELECT id FROM entries WHERE user_id=? AND week_id=? AND work_date=?",
            (uid, week_id, p.work_date),
        ).fetchone()

        bh_paid_db = None
        if p.bh_paid is True:
            bh_paid_db = 1
        elif p.bh_paid is False:
            bh_paid_db = 0

        if existing:
            conn.execute(
                """
                UPDATE entries
                SET time_in=?, time_out=?, break_minutes=?, note=?, bh_paid=?, multiplier=?
                WHERE id=? AND user_id=?
                """,
                (
                    p.time_in,
                    p.time_out,
                    int(p.break_minutes or 0),
                    (p.note.strip() if p.note else None),
                    bh_paid_db,
                    float(mult),
                    int(existing["id"]),
                    uid,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO entries(user_id,week_id,work_date,time_in,time_out,break_minutes,note,bh_paid,multiplier,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    uid,
                    week_id,
                    p.work_date,
                    p.time_in,
                    p.time_out,
                    int(p.break_minutes or 0),
                    (p.note.strip() if p.note else None),
                    bh_paid_db,
                    float(mult),
                    now(),
                ),
            )

        # Sync clock_state if user edited TODAY
        if p.work_date == today_ymd():
            st = conn.execute(
                "SELECT * FROM clock_state WHERE user_id=? AND work_date=?",
                (uid, p.work_date),
            ).fetchone()
            if st:
                conn.execute(
                    """
                    UPDATE clock_state
                    SET week_id=?,
                        in_time=?,
                        out_time=?,
                        break_minutes=?,
                        updated_at=?
                    WHERE user_id=? AND work_date=?
                    """,
                    (
                        int(week_id),
                        p.time_in,
                        p.time_out,
                        int(p.break_minutes or 0),
                        now(),
                        uid,
                        p.work_date,
                    ),
                )

        conn.commit()

    return {"ok": True}


@app.delete("/api/entries/{entry_id}")
def delete_entry(entry_id: int, req: Request):
    uid = require_user(req)
    with db() as conn:
        ensure_clock_tables(conn)
        row = conn.execute(
            "SELECT work_date FROM entries WHERE id=? AND user_id=?",
            (entry_id, uid),
        ).fetchone()
        ok = conn.execute("DELETE FROM entries WHERE id=? AND user_id=?", (entry_id, uid)).rowcount
        if row and row["work_date"]:
            conn.execute(
                "DELETE FROM clock_state WHERE user_id=? AND work_date=?",
                (uid, row["work_date"]),
            )
        conn.commit()
    if not ok:
        raise HTTPException(404, "Not found")
    return {"ok": True}


# ======================================================
# DASHBOARD
# ======================================================
@app.get("/api/dashboard")
def dashboard(req: Request):
    uid = require_user(req)

    with db() as conn:
        payload = build_dashboard_payload(conn, uid)
        return {
            "this_week": payload["this_week"],
            "bank_holidays_years": payload["bank_holidays_years"],
            "bank_holidays": payload["bank_holidays"],
        }



# ======================================================
# REPORT CURRENT WEEK  ✅ FIXED
# - picks the week that CONTAINS today (start_date .. start_date+6)
# - if none contains today, fallback to latest week
# ======================================================
@app.get("/api/report/week/current")
def report_current_week(req: Request):
    uid = require_user(req)

    with db() as conn:
        return build_report_current_week_payload(conn, uid)


@app.get("/api/home")
def api_home(req: Request):
    uid = require_user(req)
    with db() as conn:
        return build_home_payload(conn, uid)


# ======================================================
# CLOCK (IN / OUT / BREAK) + EXTRA CONFIRM
# ======================================================
def get_current_week(conn: sqlite3.Connection, uid: int) -> Optional[sqlite3.Row]:
    return ensure_current_week_for_user(conn, uid)



def get_week_for_today_strict(conn: sqlite3.Connection, uid: int) -> Optional[sqlite3.Row]:
    today = local_now().date()

    weeks = conn.execute(
        "SELECT * FROM weeks WHERE user_id=? ORDER BY start_date ASC",
        (uid,),
    ).fetchall()

    if not weeks:
        return None

    # 1) Prefer: week that contains today
    for w in weeks:
        try:
            start = parse_ymd(w["start_date"])
        except Exception:
            continue
        end = start + timedelta(days=6)
        if start <= today <= end:
            return w

    # 2) Else: latest week that started in the past (start <= today)
    past = []
    for w in weeks:
        try:
            start = parse_ymd(w["start_date"])
        except Exception:
            continue
        if start <= today:
            past.append((start, w))

    if past:
        past.sort(key=lambda x: x[0])
        return past[-1][1]

    # 3) Else: all weeks are future -> pick the earliest future
    return weeks[0]



def get_today_entry(conn: sqlite3.Connection, uid: int, week_id: int, work_date: str) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM entries WHERE user_id=? AND week_id=? AND work_date=?",
        (uid, week_id, work_date),
    ).fetchone()


def create_today_entry(conn: sqlite3.Connection, uid: int, week_id: int, work_date: str) -> sqlite3.Row:
    row = get_today_entry(conn, uid, week_id, work_date)
    if row:
        return row

    mult = multiplier_for_date(conn, uid, work_date)

    conn.execute(
        """
        INSERT INTO entries(
            user_id,week_id,work_date,
            time_in,time_out,break_minutes,
            note,bh_paid,multiplier,created_at,
            extra_authorized,extra_checked
        )
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (uid, week_id, work_date, None, None, 0, None, None, float(mult), now(), 0, 0),
    )
    conn.commit()

    row = get_today_entry(conn, uid, week_id, work_date)
    if not row:
        raise HTTPException(500, "Failed to create entry")
    return row


@app.get("/api/clock/today")
def clock_today(req: Request):
    uid = require_user(req)
    with db() as conn:
        return build_clock_today_payload(conn, uid)


@app.post("/api/clock/extra-confirm")
def clock_extra_confirm(p: ExtraConfirmIn, req: Request):
    uid = require_user(req)
    with db() as conn:
        w = get_current_week(conn, uid)
        if not w:
            raise HTTPException(400, "Create a week first")

        e = get_today_entry(conn, uid, int(w["id"]), p.work_date)
        if not e:
            raise HTTPException(400, "Clock in first")

        conn.execute(
            "UPDATE entries SET extra_checked=1, extra_authorized=? WHERE id=? AND user_id=?",
            (1 if p.authorized else 0, int(e["id"]), uid),
        )
        conn.commit()

    return {"ok": True, "work_date": p.work_date, "authorized": bool(p.authorized)}


@app.post("/api/clock/in")
def clock_in(req: Request):
    uid = require_user(req)
    with db() as conn:
        ensure_clock_tables(conn)
        w = get_current_week(conn, uid)
        if not w:
            raise HTTPException(400, "Create a week first")

        work_date = today_ymd()
        real_now = hhmm_now()
        e = create_today_entry(conn, uid, int(w["id"]), work_date)
        ro = roster_for_date(conn, uid, work_date)

        if ro and int(ro["day_off"] or 0) == 1:
            if int(e["extra_checked"] or 0) == 0:
                return {
                    "ok": True,
                    "needs_extra_confirm": True,
                    "reason": "DAY_OFF",
                    "kind": "IN",
                    "work_date": work_date,
                    "official": None,
                    "real": real_now,
                }
            if not bool(int(e["extra_authorized"] or 0) == 1):
                return {"ok": True, "ignored": True, "reason": "DAY_OFF", "work_date": work_date}

        official_in = ro["shift_in"] if ro else None
        authorized = bool(int(e["extra_authorized"] or 0) == 1)
        store_in, needs_confirm = decide_clock_time("IN", real_now, official_in, authorized)

        if needs_confirm and int(e["extra_checked"] or 0) == 0:
            return {
                "ok": True,
                "needs_extra_confirm": True,
                "reason": "EARLY_IN",
                "kind": "IN",
                "work_date": work_date,
                "official": official_in,
                "real": real_now,
            }

        mult = multiplier_for_date(conn, uid, work_date)
        conn.execute(
            "UPDATE entries SET time_in=?, time_out=NULL, multiplier=? WHERE id=? AND user_id=?",
            (store_in, float(mult), int(e["id"]), uid),
        )

        conn.execute(
            """
            INSERT INTO clock_state(user_id,week_id,work_date,in_time,out_time,break_running,break_start,break_minutes,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET
              week_id=excluded.week_id,
              work_date=excluded.work_date,
              in_time=excluded.in_time,
              out_time=NULL,
              break_running=0,
              break_start=NULL,
              break_minutes=excluded.break_minutes,
              updated_at=excluded.updated_at
            """,
            (uid, int(w["id"]), work_date, store_in, None, 0, None, int(e["break_minutes"] or 0), now()),
        )
        conn.commit()

        return {"ok": True, "work_date": work_date}


@app.post("/api/clock/out")
def clock_out(req: Request):
    uid = require_user(req)
    with db() as conn:
        ensure_clock_tables(conn)
        w = get_current_week(conn, uid)
        if not w:
            raise HTTPException(400, "Create a week first")

        work_date = today_ymd()
        real_now = hhmm_now()
        e = get_today_entry(conn, uid, int(w["id"]), work_date)
        if not e:
            raise HTTPException(400, "Clock in first")
        ro = roster_for_date(conn, uid, work_date)

        if ro and int(ro["day_off"] or 0) == 1:
            if int(e["extra_checked"] or 0) == 0:
                return {
                    "ok": True,
                    "needs_extra_confirm": True,
                    "reason": "DAY_OFF",
                    "kind": "OUT",
                    "work_date": work_date,
                    "official": None,
                    "real": real_now,
                }
            if not bool(int(e["extra_authorized"] or 0) == 1):
                return {"ok": True, "ignored": True, "reason": "DAY_OFF", "work_date": work_date}

        official_out = ro["shift_out"] if ro else None
        authorized = bool(int(e["extra_authorized"] or 0) == 1)
        store_out, needs_confirm = decide_clock_time("OUT", real_now, official_out, authorized)

        # ✅ FIX: indentation/return block (your code was broken)
        if needs_confirm and int(e["extra_checked"] or 0) == 0:
            return {
                "ok": True,
                "needs_extra_confirm": True,
                "reason": "LATE_OUT",
                "kind": "OUT",
                "work_date": work_date,
                "official": official_out,
                "real": real_now,
            }

        st = conn.execute("SELECT * FROM clock_state WHERE user_id=?", (uid,)).fetchone()
        if st and int(st["break_running"] or 0) == 1 and st["break_start"]:
            bs = utc_from_iso(st["break_start"])
            add = int((datetime.now(timezone.utc) - bs).total_seconds() // 60)
            new_break = int(st["break_minutes"] or 0) + max(0, add)

            conn.execute(
                "UPDATE clock_state SET break_running=0, break_start=NULL, break_minutes=?, updated_at=? WHERE user_id=?",
                (new_break, now(), uid),
            )
            conn.execute(
                "UPDATE entries SET break_minutes=? WHERE id=? AND user_id=?",
                (new_break, int(e["id"]), uid),
            )
            e = conn.execute("SELECT * FROM entries WHERE id=? AND user_id=?", (int(e["id"]), uid)).fetchone()

        mult = multiplier_for_date(conn, uid, work_date)
        conn.execute(
            "UPDATE entries SET time_out=?, multiplier=? WHERE id=? AND user_id=?",
            (store_out, float(mult), int(e["id"]), uid),
        )

        conn.execute(
            """
            INSERT INTO clock_state(user_id,week_id,work_date,in_time,out_time,break_running,break_start,break_minutes,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET
              week_id=excluded.week_id,
              work_date=excluded.work_date,
              out_time=excluded.out_time,
              break_running=0,
              break_start=NULL,
              break_minutes=excluded.break_minutes,
              updated_at=excluded.updated_at
            """,
            (uid, int(w["id"]), work_date, None, store_out, 0, None, int(e["break_minutes"] or 0), now()),
        )

        conn.commit()

    return {"ok": True, "work_date": work_date}


@app.post("/api/clock/break")
def clock_break(req: Request):
    uid = require_user(req)
    with db() as conn:
        ensure_clock_tables(conn)
        w = get_current_week(conn, uid)
        if not w:
            raise HTTPException(400, "Create a week first")

        work_date = today_ymd()
        e = get_today_entry(conn, uid, int(w["id"]), work_date)
        if not e:
            raise HTTPException(400, "Clock in first")

        st = conn.execute(
            "SELECT * FROM clock_state WHERE user_id=? AND work_date=?",
            (uid, work_date),
        ).fetchone()

        if not st:
            conn.execute(
                """
                INSERT INTO clock_state(user_id,week_id,work_date,in_time,out_time,break_running,break_start,break_minutes,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)
                """,
                (
                    uid,
                    int(w["id"]),
                    work_date,
                    e["time_in"],
                    e["time_out"],
                    1,
                    now(),
                    int(e["break_minutes"] or 0),
                    now(),
                ),
            )
            conn.commit()
            return {"ok": True, "break_running": True}

        running = int(st["break_running"] or 0) == 1

        if not running:
            conn.execute(
                "UPDATE clock_state SET break_running=1, break_start=?, updated_at=? WHERE user_id=?",
                (now(), now(), uid),
            )
            conn.commit()
            return {"ok": True, "break_running": True}

        # running == True
        if not st["break_start"]:
            conn.execute(
                "UPDATE clock_state SET break_running=0, break_start=NULL, updated_at=? WHERE user_id=?",
                (now(), uid),
            )
            conn.commit()
            return {"ok": True, "break_running": False}

        bs = utc_from_iso(st["break_start"])
        add = int((datetime.now(timezone.utc) - bs).total_seconds() // 60)
        new_break = int(st["break_minutes"] or 0) + max(0, add)

        conn.execute(
            "UPDATE clock_state SET break_running=0, break_start=NULL, break_minutes=?, updated_at=? WHERE user_id=?",
            (new_break, now(), uid),
        )
        conn.execute(
            "UPDATE entries SET break_minutes=? WHERE id=? AND user_id=?",
            (new_break, int(e["id"]), uid),
        )
        conn.commit()

    return {"ok": True, "break_running": False, "break_minutes": new_break}

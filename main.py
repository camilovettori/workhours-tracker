from __future__ import annotations

import os
import hmac
import hashlib
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime, date, timedelta
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, File
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
    return datetime.utcnow().isoformat(timespec="seconds")


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

        ensure_bh_indexes(conn)
        ensure_clock_tables(conn)

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
        

        ensure_bh_indexes(conn)
        ensure_clock_tables(conn)

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
    code: str  # "A" | "B" | "OFF"


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


class ForgotIn(BaseModel):
    email: EmailStr


class ResetIn(BaseModel):
    token: str
    new_password: str = Field(..., min_length=4)


class RosterCreate(BaseModel):
    week_number: int
    start_date: str  # yyyy-mm-dd (Sunday)
    days: List[str]  # 7 items: "A", "B", "OFF"


class ExtraConfirmIn(BaseModel):
    work_date: str  # yyyy-mm-dd
    authorized: bool


class MeUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    hourly_rate: Optional[float] = None


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
    require_user(req)
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
    return date.today().isoformat()


def hhmm_now() -> str:
    return datetime.now().strftime("%H:%M")


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
            SELECT id, name, bh_date, paid, paid_date, paid_week, applicable
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
        SELECT rd.shift_in, rd.shift_out, rd.day_off
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



def ensure_week_from_roster(conn: sqlite3.Connection, uid: int, week_number: int, start_date: str) -> int:
    row = conn.execute(
        "SELECT id FROM weeks WHERE user_id=? AND week_number=? LIMIT 1",
        (uid, int(week_number)),
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
        (uid, int(week_number), start_date, float(hourly_rate), now()),
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
            ORDER BY CAST(week_number AS INTEGER) DESC, date(start_date) DESC, id DESC
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

from fastapi import Query

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
            return {"has_roster": False, "day_off": True, "shift_in": None, "shift_out": None}

        day_off = bool(int(ro["day_off"] or 0))
        return {
            "has_roster": True,
            "day_off": day_off,
            "shift_in": ro["shift_in"],
            "shift_out": ro["shift_out"],
        }


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
                    "work_date": d["work_date"],
                    "day_off": bool(int(d["day_off"] or 0)),
                    "shift_in": d["shift_in"],
                    "shift_out": d["shift_out"],
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

        conn.execute("DELETE FROM roster_days WHERE roster_id=? AND user_id=?", (roster_id, uid))
        conn.execute("DELETE FROM rosters WHERE id=? AND user_id=?", (roster_id, uid))
        conn.commit()

    return {"ok": True}


@app.post("/api/roster")
def roster_create(p: RosterCreate, req: Request):
    uid = require_user(req)
    if not p.days or len(p.days) != 7:
        raise HTTPException(400, "days must have 7 items (Sun..Sat)")

    start = parse_ymd(p.start_date)

    with db() as conn:
        dup = conn.execute(
            """
            SELECT id
            FROM rosters
            WHERE user_id=? AND week_number=? AND start_date=?
            LIMIT 1
            """,
            (uid, int(p.week_number), p.start_date),
        ).fetchone()

        if dup:
            wk = conn.execute(
                "SELECT id FROM weeks WHERE user_id=? AND week_number=? LIMIT 1",
                (uid, int(p.week_number)),
            ).fetchone()
            return {"ok": True, "id": int(dup["id"]), "week_id": int(wk["id"]) if wk else None}

        week_id = ensure_week_from_roster(conn, uid, int(p.week_number), p.start_date)

        conn.execute(
            "INSERT INTO rosters(user_id,week_number,start_date,created_at) VALUES (?,?,?,?)",
            (uid, int(p.week_number), p.start_date, now()),
        )
        roster_id = int(conn.execute("SELECT last_insert_rowid() id").fetchone()["id"])

        for i, code in enumerate(p.days):
            d = start + timedelta(days=i)
            ymd = d.isoformat()
            code_up = (code or "").strip().upper()

            if code_up == "OFF":
                shift_in, shift_out, day_off = None, None, 1
            elif code_up == "A":
                shift_in, shift_out, day_off = SHIFT_A_IN, SHIFT_A_OUT, 0
            elif code_up == "B":
                shift_in, shift_out, day_off = SHIFT_B_IN, SHIFT_B_OUT, 0
            else:
                raise HTTPException(400, "Invalid day code (use A, B, OFF)")

            conn.execute(
                """
                INSERT INTO roster_days(user_id,roster_id,work_date,shift_in,shift_out,day_off,created_at)
                VALUES (?,?,?,?,?,?,?)
                """,
                (uid, roster_id, ymd, shift_in, shift_out, day_off, now()),
            )

        conn.commit()

    return {"ok": True, "id": roster_id, "week_id": int(week_id)}


@app.patch("/api/roster/{roster_id}/day")
def roster_day_patch(roster_id: int, p: RosterDayPatch, req: Request):
    uid = require_user(req)
    code = (p.code or "").strip().upper()
    if code not in ("A", "B", "OFF"):
        raise HTTPException(400, "Invalid code (use A, B, OFF)")

    with db() as conn:
        r = conn.execute(
            "SELECT id FROM rosters WHERE id=? AND user_id=?",
            (roster_id, uid),
        ).fetchone()
        if not r:
            raise HTTPException(404, "Roster not found")

        d = conn.execute(
            """
            SELECT id
            FROM roster_days
            WHERE roster_id=? AND user_id=? AND work_date=?
            """,
            (roster_id, uid, p.work_date),
        ).fetchone()
        if not d:
            raise HTTPException(404, "Roster day not found")

        if code == "OFF":
            shift_in, shift_out, day_off = None, None, 1
        elif code == "A":
            shift_in, shift_out, day_off = SHIFT_A_IN, SHIFT_A_OUT, 0
        else:
            shift_in, shift_out, day_off = SHIFT_B_IN, SHIFT_B_OUT, 0

        conn.execute(
            "UPDATE roster_days SET shift_in=?, shift_out=?, day_off=? WHERE id=? AND user_id=?",
            (shift_in, shift_out, day_off, int(d["id"]), uid),
        )
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
            ORDER BY week_number DESC, start_date DESC
            """,
            (uid,),
        ).fetchall()

        out = []
        for w in rows:
            entries = conn.execute(
                """
                SELECT work_date, time_in, time_out, break_minutes, multiplier, extra_authorized
                FROM entries
                WHERE user_id=? AND week_id=?
                """,
                (uid, int(w["id"])),
            ).fetchall()

            total_min = 0
            total_pay = 0.0
            rate = float(w["hourly_rate"] or 0.0)

            for e in entries:
                authorized = bool(int(e["extra_authorized"] or 0) == 1)
                m, _meta = minutes_paid_between(
                    conn, uid, e["work_date"],
                    e["time_in"], e["time_out"],
                    int(e["break_minutes"] or 0),
                    authorized
                )
                mult = float(e["multiplier"] or 1.0)
                total_min += int(m)
                total_pay += (m / 60.0) * rate * mult

            out.append(
                {
                    "id": int(w["id"]),
                    "week_number": int(w["week_number"]),
                    "start_date": w["start_date"],
                    "hourly_rate": float(w["hourly_rate"] or 0),
                    "total_hhmm": f"{total_min//60:02d}:{total_min%60:02d}",
                    "total_pay": round(total_pay, 2),
                }
            )

        return out



@app.post("/api/weeks")
def create_week(p: WeekCreate, req: Request):
    uid = require_user(req)
    with db() as conn:
        conn.execute(
            "INSERT INTO weeks(user_id,week_number,start_date,hourly_rate,created_at) VALUES (?,?,?,?,?)",
            (uid, int(p.week_number), p.start_date, float(p.hourly_rate), now()),
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

        rows = conn.execute(
            "SELECT * FROM entries WHERE week_id=? AND user_id=? ORDER BY work_date ASC",
            (week_id, uid),
        ).fetchall()

        entries = []
        total_min = 0
        total_pay = 0.0
        rate = float(w["hourly_rate"] or 0.0)

        for r in rows:
            authorized = bool(int(r["extra_authorized"] or 0) == 1)
            m, meta = minutes_paid_between(
                conn, uid, r["work_date"],
                r["time_in"], r["time_out"],
                int(r["break_minutes"] or 0),
                authorized
            )

            mult = float(r["multiplier"] or 1.0)
            total_min += int(m)
            total_pay += (m / 60.0) * rate * mult

            break_eff = effective_break_minutes(r["time_in"], r["time_out"], int(r["break_minutes"] or 0))
            d = parse_ymd(r["work_date"])

            entries.append(
                {
                    "id": int(r["id"]),
                    "week_id": int(r["week_id"]),
                    "work_date": r["work_date"],
                    "weekday": weekday_short_en(d),
                    "date_ddmmyyyy": ddmmyyyy(d),
                    "time_in": r["time_in"] or "",
                    "time_out": r["time_out"] or "",
                    "break_minutes": int(break_eff),
                    "note": r["note"],
                    "bh_paid": (None if r["bh_paid"] is None else bool(int(r["bh_paid"]))),
                    "multiplier": float(r["multiplier"] or 1.0),

                    "worked_hhmm": f"{int(m)//60:02d}:{int(m)%60:02d}",

                    "time_in_real": r["time_in"] or "",
                    "time_out_real": r["time_out"] or "",
                    "time_in_paid": meta.get("paid_in_hhmm") or "",
                    "time_out_paid": meta.get("paid_out_hhmm") or "",

                    "extra_authorized": 1 if authorized else 0,
                }
            )

        return {
            "id": int(w["id"]),
            "week_number": int(w["week_number"]),
            "start_date": w["start_date"],
            "hourly_rate": float(w["hourly_rate"] or 0),
            "totals": {
                "total_hhmm": f"{total_min//60:02d}:{total_min%60:02d}",
                "total_pay": round(total_pay, 2)
            },
            "entries": entries,
        }



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
        ok = conn.execute("DELETE FROM entries WHERE id=? AND user_id=?", (entry_id, uid)).rowcount
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
        weeks = conn.execute(
            "SELECT * FROM weeks WHERE user_id=? ORDER BY start_date ASC",
            (uid,),
        ).fetchall()

        current_week = get_week_for_today_strict(conn, uid)

        # Totals (all time)
        total_min_all = 0
        total_pay_all = 0.0

        for w in weeks:
            rate = float(w["hourly_rate"] or 0.0)

            rows = conn.execute(
                """
                SELECT work_date, time_in, time_out, break_minutes, multiplier, extra_authorized
                FROM entries
                WHERE user_id=? AND week_id=?
                """,
                (uid, int(w["id"])),
            ).fetchall()

            for r in rows:
                authorized = bool(int(r["extra_authorized"] or 0) == 1)
                m, _meta = minutes_paid_between(
                    conn, uid, r["work_date"],
                    r["time_in"], r["time_out"],
                    int(r["break_minutes"] or 0),
                    authorized
                )

                mult = float(r["multiplier"] or 1.0)
                total_min_all += int(m)
                total_pay_all += (m / 60.0) * rate * mult

        # Totals (this week)
        this_week_min = 0
        this_week_pay = 0.0

        if current_week:
            rate = float(current_week["hourly_rate"] or 0.0)

            rows = conn.execute(
                """
                SELECT work_date, time_in, time_out, break_minutes, multiplier, extra_authorized
                FROM entries
                WHERE user_id=? AND week_id=?
                """,
                (uid, int(current_week["id"])),
            ).fetchall()

            for r in rows:
                authorized = bool(int(r["extra_authorized"] or 0) == 1)
                m, _meta = minutes_paid_between(
                    conn, uid, r["work_date"],
                    r["time_in"], r["time_out"],
                    int(r["break_minutes"] or 0),
                    authorized
                )

                mult = float(r["multiplier"] or 1.0)
                this_week_min += int(m)
                this_week_pay += (m / 60.0) * rate * mult

        # Bank holidays
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
                "id": (int(current_week["id"]) if current_week else None),
                "week_number": (int(current_week["week_number"]) if current_week else None),
                "hourly_rate": (float(current_week["hourly_rate"] or 0.0) if current_week else 0.0),
                "hhmm": f"{this_week_min//60:02d}:{this_week_min%60:02d}",
                "pay_eur": round(this_week_pay, 2),
            },
            "bank_holidays_years": bh_years_out,
            "bank_holidays": {"allowance": total_allowance, "paid": total_paid, "remaining": total_remaining},
        }



# ======================================================
# REPORT CURRENT WEEK  ✅ FIXED
# - picks the week that CONTAINS today (start_date .. start_date+6)
# - if none contains today, fallback to latest week
# ======================================================
@app.get("/api/report/week/current")
def report_current_week(req: Request):
    uid = require_user(req)
    today = date.today().isoformat()

    with db() as conn:
        w = conn.execute(
            """
            SELECT *
            FROM weeks
            WHERE user_id = ?
              AND date(start_date) <= date(?)
              AND date(start_date, '+6 day') >= date(?)
            ORDER BY start_date DESC
            LIMIT 1
            """,
            (uid, today, today),
        ).fetchone()

        if not w:
            w = conn.execute(
                "SELECT * FROM weeks WHERE user_id=? ORDER BY start_date DESC LIMIT 1",
                (uid,),
            ).fetchone()

        if not w:
            return {
                "ok": True,
                "has_week": False,
                "week": None,
                "entries": [],
                "totals": {"hhmm": "00:00", "pay_eur": 0.0},
            }

        rate = float(w["hourly_rate"] or 0.0)

        rows = conn.execute(
            """
            SELECT id, work_date, time_in, time_out, break_minutes, multiplier, extra_authorized
            FROM entries
            WHERE user_id=? AND week_id=?
            ORDER BY work_date ASC
            """,
            (uid, int(w["id"])),
        ).fetchall()

        entries = []
        total_min = 0
        total_pay = 0.0

        for r in rows:
            authorized = bool(int(r["extra_authorized"] or 0) == 1)

            m, meta = minutes_paid_between(
                conn, uid, r["work_date"],
                r["time_in"], r["time_out"],
                int(r["break_minutes"] or 0),
                authorized
            )

            mult = float(r["multiplier"] or 1.0)
            total_min += int(m)
            total_pay += (m / 60.0) * rate * mult

            d = parse_ymd(r["work_date"])
            break_eff = effective_break_minutes(r["time_in"], r["time_out"], int(r["break_minutes"] or 0))

            entries.append(
                {
                    "id": int(r["id"]),
                    "work_date": r["work_date"],
                    "weekday": weekday_short_en(d),
                    "date_ddmmyyyy": ddmmyyyy(d),

                    "time_in": r["time_in"] or "",
                    "time_out": r["time_out"] or "",

                    "time_in_real": r["time_in"] or "",
                    "time_out_real": r["time_out"] or "",
                    "time_in_paid": meta.get("paid_in_hhmm") or "",
                    "time_out_paid": meta.get("paid_out_hhmm") or "",

                    "break_minutes": int(break_eff),
                    "worked_hhmm": f"{int(m)//60:02d}:{int(m)%60:02d}",
                    "pay_eur": round((m / 60.0) * rate * mult, 2),

                    "extra_authorized": 1 if authorized else 0,
                }
            )

        return {
            "ok": True,
            "has_week": True,
            "week": {
                "id": int(w["id"]),
                "week_number": int(w["week_number"]),
                "start_date": w["start_date"],
                "hourly_rate": rate,
            },
            "entries": entries,
            "totals": {
                "hhmm": f"{total_min//60:02d}:{total_min%60:02d}",
                "pay_eur": round(total_pay, 2),
            },
        }


# ======================================================
# CLOCK (IN / OUT / BREAK) + EXTRA CONFIRM
# ======================================================
def get_current_week(conn: sqlite3.Connection, uid: int) -> Optional[sqlite3.Row]:
    return get_week_for_today_strict(conn, uid)



def get_week_for_today_strict(conn: sqlite3.Connection, uid: int) -> Optional[sqlite3.Row]:
    today = date.today()

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



def get_or_create_today_entry(conn: sqlite3.Connection, uid: int, week_id: int, work_date: str) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM entries WHERE user_id=? AND week_id=? AND work_date=?",
        (uid, week_id, work_date),
    ).fetchone()
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

    return conn.execute(
        "SELECT * FROM entries WHERE user_id=? AND week_id=? AND work_date=?",
        (uid, week_id, work_date),
    ).fetchone()


@app.get("/api/clock/today")
def clock_today(req: Request):
    uid = require_user(req)
    with db() as conn:
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
        e = get_or_create_today_entry(conn, uid, int(w["id"]), work_date)

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


@app.post("/api/clock/extra-confirm")
def clock_extra_confirm(p: ExtraConfirmIn, req: Request):
    uid = require_user(req)
    with db() as conn:
        w = get_current_week(conn, uid)
        if not w:
            raise HTTPException(400, "Create a week first")

        e = get_or_create_today_entry(conn, uid, int(w["id"]), p.work_date)

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
        e = get_or_create_today_entry(conn, uid, int(w["id"]), work_date)
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
        e = get_or_create_today_entry(conn, uid, int(w["id"]), work_date)
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
            bs = datetime.fromisoformat(st["break_start"])
            add = int((datetime.now() - bs).total_seconds() // 60)
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
        e = get_or_create_today_entry(conn, uid, int(w["id"]), work_date)

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
                    datetime.now().isoformat(timespec="seconds"),
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
                (datetime.now().isoformat(timespec="seconds"), now(), uid),
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

        bs = datetime.fromisoformat(st["break_start"])
        add = int((datetime.now() - bs).total_seconds() // 60)
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

from __future__ import annotations

import os
import hmac
import hashlib
import secrets
import sqlite3
from pathlib import Path
from datetime import datetime, date, timedelta
from typing import Optional, Any, Dict, List

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


# =========================
# Paths / App
# =========================
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DB_PATH = BASE_DIR / "workhours.db"

APP_SECRET = os.environ.get("WORKHOURS_SECRET", "dev-secret-change-me").encode("utf-8")

app = FastAPI(title="Work Hours Tracker", version="4.0")

if not STATIC_DIR.exists():
    raise RuntimeError(f"Missing folder: {STATIC_DIR}")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
from fastapi.responses import FileResponse

@app.get("/app.js")
def app_js():
    return FileResponse(STATIC_DIR / "app.js")

@app.get("/app.css")
def app_css():
    return FileResponse(STATIC_DIR / "app.css")

@app.get("/sw.js")
def sw_js():
    return FileResponse(STATIC_DIR / "sw.js")

@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC_DIR / "manifest.webmanifest")



# =========================
# DB helpers + migrations
# =========================
def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
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
    """
    Creates tables if missing AND migrates older DBs that don't have user_id columns.
    Legacy rows will be assigned user_id=0 until first signup, then we bind them to the first user.
    """
    with db() as conn:
        # users
        conn.execute("""
        CREATE TABLE IF NOT EXISTS users(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
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

        # bank holidays (tracker)
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

        # ---- MIGRATIONS for older DBs ----
        # if user_id columns didn't exist previously, add them (safe)
        add_col_if_missing(conn, "weeks", "user_id", "INTEGER NOT NULL DEFAULT 0")
        add_col_if_missing(conn, "entries", "user_id", "INTEGER NOT NULL DEFAULT 0")
        add_col_if_missing(conn, "entries", "was_bank_holiday", "INTEGER NOT NULL DEFAULT 0")
        add_col_if_missing(conn, "entries", "bh_paid", "INTEGER NOT NULL DEFAULT 0")

        # if created_at missing
        add_col_if_missing(conn, "weeks", "created_at", "TEXT NOT NULL DEFAULT ''")
        add_col_if_missing(conn, "entries", "created_at", "TEXT NOT NULL DEFAULT ''")

        # if hourly_rate missing
        add_col_if_missing(conn, "weeks", "hourly_rate", "REAL NOT NULL DEFAULT 0")

        # indexes
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_name ON users(first_name, last_name);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_weeks_user ON weeks(user_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_user ON entries(user_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_week ON entries(week_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_bh_user_year ON bank_holidays(user_id, year);")

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
        # 90 days
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
# Ireland bank holidays (usable list + tracker)
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
    password: str = Field(min_length=4, max_length=120)


class LoginIn(BaseModel):
    first_name: str = Field(min_length=1, max_length=40)
    last_name: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=4, max_length=120)


class ForgotIn(BaseModel):
    first_name: str = Field(min_length=1, max_length=40)
    last_name: str = Field(min_length=1, max_length=40)
    new_password: str = Field(min_length=4, max_length=120)


class WeekCreate(BaseModel):
    week_number: int = Field(ge=1, le=60)
    start_date: str  # YYYY-MM-DD
    hourly_rate: float = Field(ge=0, le=200)


class WeekPatch(BaseModel):
    hourly_rate: float = Field(ge=0, le=200)


class EntryUpsert(BaseModel):
    work_date: str
    time_in: Optional[str] = None
    time_out: Optional[str] = None
    break_minutes: int = Field(ge=0, le=600)
    note: Optional[str] = None
    bh_paid: Optional[bool] = None  # tracker


class BhPaidPatch(BaseModel):
    paid: bool


# =========================
# Calculations
# =========================
def entry_minutes(e: sqlite3.Row) -> int:
    mins = minutes_between(e["time_in"], e["time_out"]) - int(e["break_minutes"] or 0)
    return max(0, mins)


def multiplier(d: date, was_bh: bool) -> float:
    # Sunday OR Bank Holiday => 1.5x
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
    p = STATIC_DIR / "index.html"
    return p.read_text(encoding="utf-8")


@app.get("/report", response_class=HTMLResponse)
def report_page():
    p = STATIC_DIR / "report.html"
    return p.read_text(encoding="utf-8")


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
        u = conn.execute("SELECT id, first_name, last_name FROM users WHERE id=?", (uid,)).fetchone()
        if not u:
            raise HTTPException(401, "Unauthorized")
        return {"id": u["id"], "first_name": u["first_name"], "last_name": u["last_name"]}


@app.post("/api/signup")
def signup(payload: SignupIn):
    fn = payload.first_name.strip()
    ln = payload.last_name.strip()

    with db() as conn:
        before = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]

        exists = conn.execute(
            "SELECT 1 FROM users WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?) LIMIT 1",
            (fn, ln),
        ).fetchone()
        if exists:
            raise HTTPException(409, "User already exists")

        salt_hex = secrets.token_hex(16)
        pass_hash = pbkdf2_hash(payload.password, salt_hex)

        conn.execute(
            "INSERT INTO users(first_name, last_name, salt_hex, pass_hash, created_at) VALUES (?,?,?,?,?)",
            (fn, ln, salt_hex, pass_hash, now_iso()),
        )
        conn.commit()

        uid = conn.execute(
            "SELECT id FROM users WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?) ORDER BY id DESC LIMIT 1",
            (fn, ln),
        ).fetchone()["id"]

        # If this is the FIRST user, bind legacy data (user_id=0) to them
        if before == 0:
            conn.execute("UPDATE weeks SET user_id=? WHERE user_id=0", (uid,))
            conn.execute("UPDATE entries SET user_id=? WHERE user_id=0", (uid,))
            conn.execute("UPDATE bank_holidays SET user_id=? WHERE user_id=0", (uid,))
            conn.commit()

    token = make_session_token(int(uid))
    resp = JSONResponse({"ok": True})
    resp.set_cookie("wh_session", token, httponly=True, samesite="lax")
    return resp


@app.post("/api/login")
def login(payload: LoginIn):
    fn = payload.first_name.strip()
    ln = payload.last_name.strip()

    with db() as conn:
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
    resp.set_cookie("wh_session", token, httponly=True, samesite="lax")
    return resp


@app.post("/api/forgot")
def forgot(payload: ForgotIn):
    fn = payload.first_name.strip()
    ln = payload.last_name.strip()

    with db() as conn:
        u = conn.execute(
            "SELECT id FROM users WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?) LIMIT 1",
            (fn, ln),
        ).fetchone()
        if not u:
            raise HTTPException(404, "User not found")

        new_salt = secrets.token_hex(16)
        new_hash = pbkdf2_hash(payload.new_password, new_salt)
        conn.execute(
            "UPDATE users SET salt_hex=?, pass_hash=? WHERE id=?",
            (new_salt, new_hash, u["id"]),
        )
        conn.commit()

    return {"ok": True}


@app.post("/api/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("wh_session")
    return resp


@app.get("/api/ping")
def ping():
    return {"ok": True}


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
    # validate date
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
        w = conn.execute("SELECT * FROM weeks WHERE id=? AND user_id=?", (week_id, uid)).fetchone()
        if not w:
            raise HTTPException(404, "Week not found")

        was_bh = 1 if is_bank_holiday(conn, uid, d) else 0

        existing = conn.execute(
            "SELECT * FROM entries WHERE user_id=? AND week_id=? AND work_date=?",
            (uid, week_id, payload.work_date),
        ).fetchone()

        bh_paid_val = None
        if payload.bh_paid is not None:
            bh_paid_val = 1 if payload.bh_paid else 0

        if existing:
            conn.execute("""
                UPDATE entries
                SET time_in=?, time_out=?, break_minutes=?, note=?, was_bank_holiday=?,
                    bh_paid=COALESCE(?, bh_paid)
                WHERE id=? AND user_id=?;
            """, (
                payload.time_in,
                payload.time_out,
                int(payload.break_minutes),
                payload.note,
                was_bh,
                bh_paid_val,
                existing["id"],
                uid,
            ))
        else:
            conn.execute("""
                INSERT INTO entries(user_id, week_id, work_date, time_in, time_out, break_minutes, note, was_bank_holiday, bh_paid, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?);
            """, (
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
            ))

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

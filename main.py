from __future__ import annotations

import os
import hmac
import hashlib
import secrets
import sqlite3
from pathlib import Path
from datetime import datetime, date, timedelta
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field


# ======================================================
# PATHS / APP
# ======================================================
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
if not STATIC_DIR.exists():
    raise RuntimeError(f"Missing folder: {STATIC_DIR}")

DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE_DIR)))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "workhours.db"

AVATARS_DIR = STATIC_DIR / "avatars"
AVATARS_DIR.mkdir(parents=True, exist_ok=True)

APP_SECRET = os.environ.get("WORKHOURS_SECRET", "dev-secret-change-me").encode("utf-8")
COOKIE_AGE = 90 * 24 * 60 * 60  # 90 days
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0") == "1"  # keep 0 in localhost/http

app = FastAPI(title="Work Hours Tracker", version="9.2")


# ======================================================
# STATIC
# ======================================================
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.middleware("http")
async def no_cache_static_dev(request: Request, call_next):
    resp = await call_next(request)
    p = request.url.path or ""
    if p == "/" or p.startswith("/static/") or p in (
        "/hours", "/weeks", "/holidays", "/reports", "/profile", "/report", "/add-week", "/roster"
    ):
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp


# ======================================================
# DB
# ======================================================
def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def col_exists(conn: sqlite3.Connection, table: str, col: str) -> bool:
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    return col in cols


def add_col_if_missing(conn: sqlite3.Connection, table: str, col: str, ddl: str) -> None:
    if not col_exists(conn, table, col):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")


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
                avatar_path TEXT,
                created_at TEXT
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

        # migrations
        add_col_if_missing(conn, "users", "salt_hex", "TEXT")
        add_col_if_missing(conn, "users", "pass_hash", "TEXT")
        add_col_if_missing(conn, "users", "avatar_path", "TEXT")
        add_col_if_missing(conn, "users", "created_at", "TEXT")

        add_col_if_missing(conn, "entries", "note", "TEXT")
        add_col_if_missing(conn, "entries", "bh_paid", "INTEGER")
        add_col_if_missing(conn, "entries", "multiplier", "REAL")

        # Roster extra-hours confirmation flags
        add_col_if_missing(conn, "entries", "extra_authorized", "INTEGER DEFAULT 0")
        add_col_if_missing(conn, "entries", "extra_checked", "INTEGER DEFAULT 0")

        ensure_clock_tables(conn)
        conn.commit()


init_db()


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
    resp.set_cookie(
        key="wh_session",
        value=tok,
        max_age=COOKIE_AGE if remember else None,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


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
    code: str       # "A" | "B" | "OFF"

class EntryUpsert(BaseModel):
    work_date: str  # yyyy-mm-dd
    time_in: Optional[str] = None  # HH:MM
    time_out: Optional[str] = None  # HH:MM
    break_minutes: int = 0
    note: Optional[str] = None
    bh_paid: Optional[bool] = None


class BhPaidPatch(BaseModel):
    paid: bool


class ForgotIn(BaseModel):
    email: EmailStr


class ResetIn(BaseModel):
    token: str
    new_password: str = Field(..., min_length=4)


# Roster models
class RosterCreate(BaseModel):
    week_number: int
    start_date: str  # yyyy-mm-dd (Sunday)
    days: List[str]  # 7 items: "A", "B", "OFF"


class ExtraConfirmIn(BaseModel):
    work_date: str  # yyyy-mm-dd
    authorized: bool


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
def holidays_page():
    return serve_index()


@app.get("/reports", response_class=HTMLResponse)
def reports_page():
    return serve_index()


@app.get("/profile", response_class=HTMLResponse)
def profile_page():
    return serve_index()


@app.get("/roster", response_class=HTMLResponse)
def roster_page():
    return (STATIC_DIR / "roster.html").read_text(encoding="utf-8")



# ======================================================
# AUTH API
# ======================================================
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
    return r


@app.get("/api/me")
def me(req: Request):
    uid = require_user(req)
    with db() as conn:
        u = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not u:
            raise HTTPException(401, "Unauthorized")
        return {
            "id": u["id"],
            "first_name": u["first_name"] or "",
            "last_name": u["last_name"] or "",
            "email": u["email"] or "",
            "avatar_url": u["avatar_path"],
        }


# ======================================================
# FORGOT / RESET (DEV MODE)
# ======================================================
_RESET_TOKENS: Dict[str, Dict[str, Any]] = {}


@app.post("/api/forgot")
def forgot(p: ForgotIn):
    email = p.email.lower().strip()
    with db() as conn:
        u = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
        if not u:
            return {"ok": True}  # do not reveal existence

    token = secrets.token_urlsafe(32)
    _RESET_TOKENS[token] = {"email": email, "ts": datetime.utcnow().timestamp()}
    return {"ok": True, "dev_reset_link": f"/?reset={token}"}


@app.post("/api/reset")
def reset(p: ResetIn):
    tok = p.token.strip()
    item = _RESET_TOKENS.get(tok)
    if not item:
        raise HTTPException(400, "Invalid or expired token")

    if datetime.utcnow().timestamp() - float(item["ts"]) > 60 * 30:
        _RESET_TOKENS.pop(tok, None)
        raise HTTPException(400, "Token expired")

    new_salt = secrets.token_hex(16)
    new_hash = hash_pw(p.new_password, new_salt)

    with db() as conn:
        conn.execute(
            "UPDATE users SET salt_hex=?, pass_hash=? WHERE email=?",
            (new_salt, new_hash, item["email"]),
        )
        conn.commit()

    _RESET_TOKENS.pop(tok, None)
    return {"ok": True}


# ======================================================
# AVATAR
# ======================================================
@app.post("/api/me/avatar")
async def upload_avatar(req: Request, file: UploadFile = File(...)):
    uid = require_user(req)

    if file.content_type not in ("image/jpeg", "image/png", "image/webp"):
        raise HTTPException(400, "Invalid image (use jpg/png/webp)")

    data = await file.read()
    if len(data) > 2_500_000:
        raise HTTPException(400, "Image too large (max 2.5MB)")

    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[file.content_type]
    fname = f"user_{uid}.{ext}"
    (AVATARS_DIR / fname).write_bytes(data)

    url = f"/static/avatars/{fname}"
    with db() as conn:
        conn.execute("UPDATE users SET avatar_path=? WHERE id=?", (url, uid))
        conn.commit()

    return {"ok": True, "avatar_url": url}


# ======================================================
# COMPANY RULES (TESCO) - CALC CORE
# ======================================================
SHIFT_A_IN = "09:45"
SHIFT_A_OUT = "19:00"
SHIFT_B_IN = "10:45"
SHIFT_B_OUT = "20:00"

BREAK_FIXED_MIN = 60
TOLERANCE_MIN = 5


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


# ======================================================
# ROSTER HELPERS (used by clock)
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


def needs_extra_confirm(real_hhmm: str, official_hhmm: str) -> bool:
    if not real_hhmm or not official_hhmm:
        return False
    return abs(hhmm_to_min(real_hhmm) - hhmm_to_min(official_hhmm)) > TOLERANCE_MIN


def snap_to_official_if_not_authorized(real_hhmm: str, official_hhmm: Optional[str], authorized: bool) -> str:
    """
    If NOT authorized and roster exists: we store OFFICIAL time (so extra does NOT count).
    If authorized: store real.
    If no official: store real.
    """
    if not official_hhmm:
        return real_hhmm
    if authorized:
        return real_hhmm
    return official_hhmm


# ======================================================
# BANK HOLIDAYS (minimal)
# ======================================================
def irish_bank_holidays(year: int) -> List[tuple[str, str]]:
    return [
        ("New Year's Day", f"{year}-01-01"),
        ("St. Patrick's Day", f"{year}-03-17"),
        ("Christmas Day", f"{year}-12-25"),
        ("St. Stephen's Day", f"{year}-12-26"),
    ]


def ensure_bh_for_year(conn: sqlite3.Connection, uid: int, year: int) -> None:
    c = conn.execute(
        "SELECT COUNT(*) c FROM bank_holidays WHERE user_id=? AND year=?",
        (uid, year),
    ).fetchone()["c"]
    if int(c or 0) > 0:
        return

    for name, ymd in irish_bank_holidays(year):
        conn.execute(
            "INSERT INTO bank_holidays(user_id,year,name,bh_date,paid) VALUES (?,?,?,?,0)",
            (uid, year, name, ymd),
        )
    conn.commit()


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
            out.append(
                {
                    "id": r["id"],
                    "name": r["name"],
                    "bh_date": r["bh_date"],
                    "weekday": weekday_short_en(d),
                    "date_ddmmyyyy": ddmmyyyy(d),
                    "paid": bool(r["paid"]),
                }
            )
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


# ======================================================
# DAY DETAILS (TESCO VIEW)
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
# ROSTER API
# ======================================================
@app.get("/api/roster")
def roster_list(req: Request):
    uid = require_user(req)
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM rosters WHERE user_id=? ORDER BY start_date DESC",
            (uid,),
        ).fetchall()
        return [
            {"id": r["id"], "week_number": r["week_number"], "start_date": r["start_date"]}
            for r in rows
        ]


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
            "SELECT * FROM roster_days WHERE roster_id=? AND user_id=? ORDER BY work_date ASC",
            (roster_id, uid),
        ).fetchall()

        return {
            "id": r["id"],
            "week_number": r["week_number"],
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


@app.post("/api/roster")
def roster_create(p: RosterCreate, req: Request):
    uid = require_user(req)

    if not p.days or len(p.days) != 7:
        raise HTTPException(400, "days must have 7 items (Sun..Sat)")

    start = parse_ymd(p.start_date)

    with db() as conn:
        conn.execute(
            "INSERT INTO rosters(user_id,week_number,start_date,created_at) VALUES (?,?,?,?)",
            (uid, int(p.week_number), p.start_date, now()),
        )
        roster_id = conn.execute("SELECT last_insert_rowid() id").fetchone()["id"]

        for i, code in enumerate(p.days):
            d = start + timedelta(days=i)
            ymd = d.isoformat()

            if code == "OFF":
                conn.execute(
                    """
                    INSERT INTO roster_days(user_id,roster_id,work_date,shift_in,shift_out,day_off,created_at)
                    VALUES (?,?,?,?,?,?,?)
                    """,
                    (uid, roster_id, ymd, None, None, 1, now()),
                )
            elif code == "A":
                conn.execute(
                    """
                    INSERT INTO roster_days(user_id,roster_id,work_date,shift_in,shift_out,day_off,created_at)
                    VALUES (?,?,?,?,?,?,?)
                    """,
                    (uid, roster_id, ymd, SHIFT_A_IN, SHIFT_A_OUT, 0, now()),
                )
            elif code == "B":
                conn.execute(
                    """
                    INSERT INTO roster_days(user_id,roster_id,work_date,shift_in,shift_out,day_off,created_at)
                    VALUES (?,?,?,?,?,?,?)
                    """,
                    (uid, roster_id, ymd, SHIFT_B_IN, SHIFT_B_OUT, 0, now()),
                )
            else:
                raise HTTPException(400, "Invalid day code (use A, B, OFF)")

        conn.commit()

    return {"ok": True, "id": int(roster_id)}

@app.patch("/api/roster/{roster_id}/day")
def roster_day_patch(roster_id: int, p: RosterDayPatch, req: Request):
    uid = require_user(req)

    code = (p.code or "").strip().upper()
    if code not in ("A", "B", "OFF"):
        raise HTTPException(400, "Invalid code (use A, B, OFF)")

    with db() as conn:
        # garante que o roster é do user
        r = conn.execute(
            "SELECT id FROM rosters WHERE id=? AND user_id=?",
            (roster_id, uid),
        ).fetchone()
        if not r:
            raise HTTPException(404, "Roster not found")

        # garante que existe o dia dentro do roster
        d = conn.execute(
            """
            SELECT id FROM roster_days
            WHERE roster_id=? AND user_id=? AND work_date=?
            """,
            (roster_id, uid, p.work_date),
        ).fetchone()
        if not d:
            raise HTTPException(404, "Roster day not found")

        # aplica A / B / OFF
        if code == "OFF":
            shift_in, shift_out, day_off = None, None, 1
        elif code == "A":
            shift_in, shift_out, day_off = SHIFT_A_IN, SHIFT_A_OUT, 0
        else:  # "B"
            shift_in, shift_out, day_off = SHIFT_B_IN, SHIFT_B_OUT, 0

        conn.execute(
            """
            UPDATE roster_days
            SET shift_in=?, shift_out=?, day_off=?
            WHERE id=? AND user_id=?
            """,
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
                "SELECT work_date,time_in,time_out,break_minutes,multiplier FROM entries WHERE user_id=? AND week_id=?",
                (uid, w["id"]),
            ).fetchall()

            total_min = 0
            total_pay = 0.0
            rate = float(w["hourly_rate"] or 0)

            for e in entries:
                m = minutes_between(e["work_date"], e["time_in"], e["time_out"], int(e["break_minutes"] or 0))
                mult = float(e["multiplier"] or 1.0)
                total_min += m
                total_pay += (m / 60.0) * rate * mult

            out.append(
                {
                    "id": w["id"],
                    "week_number": w["week_number"],
                    "start_date": w["start_date"],
                    "hourly_rate": w["hourly_rate"],
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
        w = conn.execute(
            "SELECT * FROM weeks WHERE id=? AND user_id=?",
            (week_id, uid),
        ).fetchone()
        if not w:
            raise HTTPException(404, "Week not found")

        rows = conn.execute(
            "SELECT * FROM entries WHERE week_id=? AND user_id=? ORDER BY work_date ASC",
            (week_id, uid),
        ).fetchall()

        entries = []
        total_min = 0
        total_pay = 0.0
        rate = float(w["hourly_rate"] or 0)

        for r in rows:
            m = minutes_between(r["work_date"], r["time_in"], r["time_out"], int(r["break_minutes"] or 0))
            mult = float(r["multiplier"] or 1.0)
            total_min += m
            total_pay += (m / 60.0) * rate * mult

            break_eff = effective_break_minutes(r["time_in"], r["time_out"], int(r["break_minutes"] or 0))
            d = parse_ymd(r["work_date"])

            entries.append(
                {
                    "id": r["id"],
                    "week_id": r["week_id"],
                    "work_date": r["work_date"],
                    "weekday": weekday_short_en(d),
                    "date_ddmmyyyy": ddmmyyyy(d),
                    "time_in": r["time_in"],
                    "time_out": r["time_out"],
                    "break_minutes": int(break_eff),
                    "note": r["note"],
                    "bh_paid": (None if r["bh_paid"] is None else bool(int(r["bh_paid"]))),
                    "multiplier": float(r["multiplier"] or 1.0),
                    "worked_hhmm": f"{m//60:02d}:{m%60:02d}",
                }
            )

        return {
            "id": w["id"],
            "week_number": w["week_number"],
            "start_date": w["start_date"],
            "hourly_rate": w["hourly_rate"],
            "totals": {"total_hhmm": f"{total_min//60:02d}:{total_min%60:02d}", "total_pay": round(total_pay, 2)},
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
        ok = conn.execute(
            "DELETE FROM weeks WHERE id=? AND user_id=?",
            (week_id, uid),
        ).rowcount
        conn.commit()
    if not ok:
        raise HTTPException(404, "Week not found")
    return {"ok": True}


@app.put("/api/weeks/{week_id}/entry")
def upsert_entry(week_id: int, p: EntryUpsert, req: Request):
    uid = require_user(req)

    # multiplier: Sunday => 1.5, else 1.0
    d = parse_ymd(p.work_date)
    is_sunday = (d.weekday() == 6)
    mult = 1.5 if is_sunday else 1.0

    with db() as conn:
        w = conn.execute("SELECT id FROM weeks WHERE id=? AND user_id=?", (week_id, uid)).fetchone()
        if not w:
            raise HTTPException(404, "Week not found")

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
        # ✅ Sync dashboard clock_state if user edited TODAY via Week report
        if p.work_date == today_ymd():
            st = conn.execute(
                "SELECT * FROM clock_state WHERE user_id=? AND work_date=?",
                (uid, p.work_date),
            ).fetchone()

            if st:
                # keep break_running/break_start as-is
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
    year = datetime.utcnow().year

    with db() as conn:
        weeks = conn.execute("SELECT * FROM weeks WHERE user_id=? ORDER BY start_date DESC", (uid,)).fetchall()
        most_recent = weeks[0] if weeks else None

        total_min_all = 0
        total_pay_all = 0.0

        for w in weeks:
            rate = float(w["hourly_rate"] or 0)
            rows = conn.execute(
                "SELECT work_date,time_in,time_out,break_minutes,multiplier FROM entries WHERE user_id=? AND week_id=?",
                (uid, w["id"]),
            ).fetchall()
            for r in rows:
                m = minutes_between(r["work_date"], r["time_in"], r["time_out"], int(r["break_minutes"] or 0))
                mult = float(r["multiplier"] or 1.0)
                total_min_all += m
                total_pay_all += (m / 60.0) * rate * mult

        this_week_min = 0
        this_week_pay = 0.0
        if most_recent:
            rate = float(most_recent["hourly_rate"] or 0)
            rows = conn.execute(
                "SELECT work_date,time_in,time_out,break_minutes,multiplier FROM entries WHERE user_id=? AND week_id=?",
                (uid, most_recent["id"]),
            ).fetchall()
            for r in rows:
                m = minutes_between(r["work_date"], r["time_in"], r["time_out"], int(r["break_minutes"] or 0))
                mult = float(r["multiplier"] or 1.0)
                this_week_min += m
                this_week_pay += (m / 60.0) * rate * mult

        ensure_bh_for_year(conn, uid, year)
        bhs = conn.execute("SELECT paid FROM bank_holidays WHERE user_id=? AND year=?", (uid, year)).fetchall()
        paid = sum(1 for x in bhs if int(x["paid"] or 0) == 1)
        available = len(bhs) - paid

        return {
            "this_week": {"hhmm": f"{this_week_min//60:02d}:{this_week_min%60:02d}", "pay_eur": round(this_week_pay, 2)},
            "totals": {"hhmm": f"{total_min_all//60:02d}:{total_min_all%60:02d}", "pay_eur": round(total_pay_all, 2)},
            "bank_holidays": {"available": available, "paid": paid},
        }


@app.get("/api/report/week/current")
def report_current_week(req: Request):
    uid = require_user(req)

    with db() as conn:
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

        rate = float(w["hourly_rate"] or 0)
        rows = conn.execute(
            "SELECT * FROM entries WHERE user_id=? AND week_id=? ORDER BY work_date ASC",
            (uid, int(w["id"])),
        ).fetchall()

        entries = []
        total_min = 0
        total_pay = 0.0

        for r in rows:
            m = minutes_between(r["work_date"], r["time_in"], r["time_out"], int(r["break_minutes"] or 0))
            mult = float(r["multiplier"] or 1.0)

            total_min += m
            total_pay += (m / 60.0) * rate * mult

            d = parse_ymd(r["work_date"])
            break_eff = effective_break_minutes(r["time_in"], r["time_out"], int(r["break_minutes"] or 0))

            entries.append({
                "id": int(r["id"]),
                "work_date": r["work_date"],
                "weekday": weekday_short_en(d),
                "date_ddmmyyyy": ddmmyyyy(d),
                "time_in": r["time_in"] or "",
                "time_out": r["time_out"] or "",
                "break_minutes": int(break_eff),
                "worked_hhmm": f"{m//60:02d}:{m%60:02d}",
                "pay_eur": round((m/60.0) * rate * mult, 2),
            })

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
# CLOCK (IN / OUT / BREAK) + ROSTER EXTRA CONFIRM
# ======================================================
def today_ymd() -> str:
    return date.today().isoformat()


def hhmm_now() -> str:
    return datetime.now().strftime("%H:%M")


def get_current_week(conn: sqlite3.Connection, uid: int) -> Optional[sqlite3.Row]:
    today = date.today()
    weeks = conn.execute(
        "SELECT * FROM weeks WHERE user_id=? ORDER BY start_date DESC",
        (uid,),
    ).fetchall()

    if not weeks:
        return None

    for w in weeks:
        try:
            start = parse_ymd(w["start_date"])
        except Exception:
            continue
        end = start + timedelta(days=6)
        if start <= today <= end:
            return w

    return weeks[0]


def get_or_create_today_entry(conn: sqlite3.Connection, uid: int, week_id: int, work_date: str) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM entries WHERE user_id=? AND week_id=? AND work_date=?",
        (uid, week_id, work_date),
    ).fetchone()
    if row:
        return row

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
        (uid, week_id, work_date, None, None, 0, None, None, 1.0, now(), 0, 0),
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

        # If missing OR it's a different day: reset state for the new day (as you already do)
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
            # ✅ IMPORTANT FIX:
            # clock_state exists for TODAY, but user may have edited the day in /report.
            # Sync in/out/break_minutes from today's entry WITHOUT touching break_running/break_start.
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
                    int(w["id"]),
                    e["time_in"],
                    e["time_out"],
                    int(e["break_minutes"] or 0),
                    now(),
                    uid,
                    work_date,
                ),
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

    # store confirmation on today's entry (or create it)
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

    return {"ok": True}


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
            raise HTTPException(400, "Today is DAY OFF in roster")

        official_in = ro["shift_in"] if ro else None

        # If roster exists and this IN differs > tolerance, ask once
        if official_in and needs_extra_confirm(real_now, official_in) and int(e["extra_checked"] or 0) == 0:
            return {
                "ok": True,
                "needs_extra_confirm": True,
                "kind": "IN",
                "official": official_in,
                "real": real_now,
            }

        authorized = bool(int(e["extra_authorized"] or 0) == 1)
        store_in = snap_to_official_if_not_authorized(real_now, official_in, authorized)

        # overwrite IN always + clear OUT
        conn.execute(
            "UPDATE entries SET time_in=?, time_out=NULL WHERE id=? AND user_id=?",
            (store_in, int(e["id"]), uid),
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

    return {"ok": True}


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
            raise HTTPException(400, "Today is DAY OFF in roster")

        official_out = ro["shift_out"] if ro else None

        # Ask once if OUT differs > tolerance
        if official_out and needs_extra_confirm(real_now, official_out) and int(e["extra_checked"] or 0) == 0:
            return {
                "ok": True,
                "needs_extra_confirm": True,
                "kind": "OUT",
                "official": official_out,
                "real": real_now,
            }

        authorized = bool(int(e["extra_authorized"] or 0) == 1)
        store_out = snap_to_official_if_not_authorized(real_now, official_out, authorized)

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

        conn.execute(
            "UPDATE entries SET time_out=? WHERE id=? AND user_id=?",
            (store_out, int(e["id"]), uid),
        )

        conn.execute(
            """
            INSERT INTO clock_state(user_id,week_id,work_date,in_time,out_time,break_running,break_start,break_minutes,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET
              week_id=excluded.week_id,
              work_date=excluded.work_date,
              out_time=excluded.out_time,
              updated_at=excluded.updated_at
            """,
            (uid, int(w["id"]), work_date, None, store_out, 0, None, int(e["break_minutes"] or 0), now()),
        )

        conn.commit()

    return {"ok": True}


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
                    uid, int(w["id"]), work_date,
                    e["time_in"], e["time_out"],
                    1, datetime.now().isoformat(timespec="seconds"),
                    int(e["break_minutes"] or 0),
                    now()
                ),
            )
            conn.commit()
            return {"ok": True, "break_running": True}

        running = int(st["break_running"] or 0) == 1

        # start
        if not running:
            conn.execute(
                "UPDATE clock_state SET break_running=1, break_start=?, updated_at=? WHERE user_id=?",
                (datetime.now().isoformat(timespec="seconds"), now(), uid),
            )
            conn.commit()
            return {"ok": True, "break_running": True}

        # stop
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

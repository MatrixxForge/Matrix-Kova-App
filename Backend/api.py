import os
import sys
import uuid
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import json
import hashlib
import time
import threading
import subprocess
import tempfile
import requests
from collections import defaultdict

app = FastAPI()

# Add project root to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from Backend.assistant import ChatbotAssistant
from Backend import database
from Backend import model_downloader
from Backend.drive_manager import DriveManager

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

APP_VERSION = "1.0.0"

class UpdateManager:
    def __init__(self):
        self.progress = 0
        self.status = "idle"  # idle, downloading, ready, error
        self.update_thread = None

    def start_download(self, url: str):
        if self.status == "downloading":
            return
        self.status = "downloading"
        self.progress = 0
        self.update_thread = threading.Thread(target=self._download_task, args=(url,))
        self.update_thread.daemon = True
        self.update_thread.start()

    def _download_task(self, url: str):
        try:
            temp_dir = tempfile.gettempdir()
            update_path = os.path.join(temp_dir, "matrix_update.exe")
            
            response = requests.get(url, stream=True, timeout=30)
            total_size = int(response.headers.get('content-length', 0))
            
            downloaded_size = 0
            with open(update_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded_size += len(chunk)
                        if total_size > 0:
                            self.progress = int((downloaded_size / total_size) * 100)
            
            self.status = "ready"
            self._create_swap_script(update_path)
        except Exception as e:
            print(f"[UPDATE ERROR]: {e}")
            self.status = "error"

    def _create_swap_script(self, new_exe_path: str):
        current_exe = sys.executable
        current_pid = os.getpid()
        temp_dir = tempfile.gettempdir()
        script_path = os.path.join(temp_dir, "matrix_swap.ps1")
        
        # PowerShell script to wait for process exit, replace file, and restart
        script_content = f"""
$pid_to_wait = {current_pid}
$current_exe = "{current_exe}"
$new_exe = "{new_exe_path}"

# Wait for main process to exit
while (Get-Process -Id $pid_to_wait -ErrorAction SilentlyContinue) {{
    Start-Sleep -Seconds 1
}}

# Perform swap
try {{
    Move-Item -Path $new_exe -Destination $current_exe -Force
    Start-Process -FilePath $current_exe
}} catch {{
    Write-Error "Failed to swap binary: $_"
}}
"""
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(script_content)

    def trigger_install(self):
        if self.status != "ready":
            return False
        
        temp_dir = tempfile.gettempdir()
        script_path = os.path.join(temp_dir, "matrix_swap.ps1")
        
        # Start the PowerShell script detached
        subprocess.Popen(["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", script_path], 
                         creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        return True

updater = UpdateManager()

@app.get("/system/version")
def get_version():
    return {"version": APP_VERSION}

@app.get("/system/update/status")
def get_update_status():
    return {"status": updater.status, "progress": updater.progress}

@app.post("/system/update/install")
async def install_update(request: Request):
    data = await request.json()
    url = data.get("url")
    if not url:
        raise HTTPException(status_code=400, detail="Missing download URL")
    
    updater.start_download(url)
    return {"status": "started"}

@app.post("/system/update/finalize")
async def finalize_update():
    success = updater.trigger_install()
    if not success:
        raise HTTPException(status_code=400, detail="Update not ready or failed")
    
    # The app will close shortly after this
    return {"status": "closing"}

assistant = ChatbotAssistant()
drive_mgr = DriveManager()

# Signal that uvicorn is fully up and ready
import threading as _threading
BACKEND_READY = _threading.Event()

def verify_system_integrity():
    """
    🚨 AUTOMATED DETECTOR: Integrity Anti-Tamper
    Verifies that core system files have not been modified.
    Bypassed in dev mode; strictly enforced in production (.exe).
    """
    if not getattr(sys, 'frozen', False):
        return
        
    CORE_FILES = {
        "Backend/database.py": "ec70a851ab715938dd8dc8b43e5164c7889a0a0559173f93e98ac0d9f77015fe",
        "Backend/assistant.py": "1d4b96330ed663c14b4c328c2b9fd4ce2d691a41bf1f01c3bfdb24a7d7a956ab",
        "Backend/config.py": "10ecb7340cd9ff27a585cae3916d0aa313d6578a0888d7801844d783fa3ab2f1"
    }
    
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for rel_path, expected in CORE_FILES.items():
        abs_path = os.path.join(root_dir, rel_path)
        if not os.path.exists(abs_path): continue
        
        h = hashlib.sha256()
        with open(abs_path, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""): h.update(chunk)
            
        if h.hexdigest() != expected:
            print(f"[SECURITY] Critical Error: Integrity violation in {rel_path}")
            from Backend import kova_config
            kova_config.update_value("meta.device_banned", True)
            sys.exit(1)

@app.on_event("startup")
async def on_startup():
    verify_system_integrity()
    BACKEND_READY.set()
    print("[API] Matrix Backend is fully operational.")

class ChatRequest(BaseModel):
    message: str
    conversation_id: int = None
    use_orchestrator: bool = False

class ModelSelectRequest(BaseModel):
    model_id: str = None

class ModeRequest(BaseModel):
    mode: str

class RenameRequest(BaseModel):
    new_title: str

class SettingsRequest(BaseModel):
    personalisation: dict
    resources: dict
    appearance: dict

class PathRequest(BaseModel):
    new_path: str

@app.get("/models")
def get_available_models():
    from Backend import config
    from Backend.config import get_dynamic_models
    local_registry, groq_models = get_dynamic_models()
    
    # Return registry based on current mode
    if assistant.model.mode == "online":
        return groq_models
    
    # Local Mode: enriched with download status
    allowed_ram = assistant.model.limits["allowed_ram_gb"]
    enriched = {}
    for mid, info in local_registry.items():
        if info.get("disabled"):   # Hidden by admin — skip completely
            continue
        ram = info["ram_gb"]
        file_exists = os.path.exists(os.path.join(config.MODELS_DIR, info["filename"]))
        
        # Resource checking
        if ram <= allowed_ram * 0.75: status = "recommended"
        elif ram <= allowed_ram: status = "struggling"
        else: status = "disabled"
        
        dl_status = model_downloader.get_download_status(mid)
        part_exists = os.path.exists(os.path.join(config.MODELS_DIR, info["filename"] + ".part"))
        
        current_status = dl_status.get("status", "idle")
        if current_status == "idle" and part_exists:
            current_status = "paused"

        enriched[mid] = {
            **info, 
            "status": status, 
            "file_exists": file_exists,
            "download_status": current_status,
            "download_progress": dl_status.get("progress", 0),
            "telemetry": dl_status
        }
    return enriched

@app.post("/set_mode")
def set_mode(request: ModeRequest):
    success = assistant.model.set_mode(request.mode)
    if success:
        database.update_state("last_mode", request.mode)
        # Reset selection to avoid invalid model across modes
        assistant.model.selected_model_id = None
        database.update_state("last_model_id", "None")
        return {"status": "success", "mode": request.mode}
    raise HTTPException(status_code=400, detail="Invalid mode")

@app.post("/select_model")
def select_model(request: ModelSelectRequest):
    from Backend import config
    from Backend.config import get_dynamic_models
    local_registry, groq_models = get_dynamic_models()
    
    # Online Selection
    if assistant.model.mode == "online":
        if request.model_id in groq_models:
            assistant.model.selected_model_id = request.model_id
            database.update_state("last_model_id", request.model_id)
            return {"status": "success", "model": request.model_id}
        raise HTTPException(status_code=400, detail="Invalid online model")

    # Local Selection
    if request.model_id in local_registry:
        model_info = local_registry[request.model_id]
        model_path = os.path.join(config.MODELS_DIR, model_info["filename"])
        if os.path.exists(model_path):
            valid, error = assistant.model.validate_model(model_path)
            if not valid:
                raise HTTPException(status_code=400, detail=f"Invalid model file: {error}")
            assistant.model.selected_model_id = request.model_id
            database.update_state("last_model_id", request.model_id)
            
            # Start asynchronous background loading
            assistant.model.load_local_model(model_path, background=True)
            
            return {"status": "loading", "model": request.model_id}
        raise HTTPException(status_code=404, detail="Model file not found")
    raise HTTPException(status_code=400, detail="Invalid model ID")

@app.post("/set_default_model")
def set_default_model(request: ModelSelectRequest):
    database.update_state("default_model_id", request.model_id)
    return {"status": "success", "default_model": request.model_id}

@app.get("/models_all")
def get_all_models():
    from Backend import config
    from Backend.config import get_dynamic_models
    local_registry, groq_models = get_dynamic_models()
    
    # Use the user-defined allowed RAM as the budget for filtering
    usable_ram = assistant.model.limits["allowed_ram_gb"]
    current_free = assistant.model.resource_manager.get_system_stats()["available_ram_gb"]
    
    local_enriched = {}
    for mid, info in local_registry.items():
        ram = info["ram_gb"]
        file_exists = os.path.exists(os.path.join(config.MODELS_DIR, info["filename"]))
        dl_status = model_downloader.get_download_status(mid)
        
        # Honest status based on budget vs current pressure
        if ram <= current_free * 0.8:
            status = "recommended" # Fits comfortably in current free RAM
        elif ram <= usable_ram:
            status = "ok"          # Fits in user budget, might swap/page slightly
        else:
            status = "disabled"    # Exceeds user-set RAM limit
        
        local_enriched[mid] = {
            **info,
            "status": status,
            "file_exists": file_exists,
            "download_status": dl_status.get("status", "idle"),
            "download_progress": dl_status.get("progress", 0),
            "usable_ram_gb": round(usable_ram, 1)
        }
        
    return {
        "online": groq_models,
        "local": local_enriched
    }

@app.post("/delete_model")
def delete_model(request: ModelSelectRequest):
    from Backend import config
    from Backend.config import get_dynamic_models
    local_registry, _ = get_dynamic_models()
    
    if request.model_id not in local_registry:
        raise HTTPException(status_code=400, detail="Invalid model ID")
    
    model_info = local_registry[request.model_id]
    model_path = os.path.join(config.MODELS_DIR, model_info["filename"])
    
    if not os.path.exists(model_path):
        return {"status": "success", "message": "File already gone"}
    
    # Check if currently loaded
    if assistant.model.selected_model_id == request.model_id:
        # Unload if possible or reject
        assistant.model.llm = None
        assistant.model.selected_model_id = "None"
    
    try:
        os.remove(model_path)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/status")
def get_status():
    return {
        "status": "online",
        "mode": assistant.model.mode,
        "model": assistant.model.selected_model_id,
        "limits": assistant.model.limits,
        "loading_status": getattr(assistant.model, "loading_status", {"is_loading": False})
    }

@app.get("/telemetry")
def get_telemetry():
    """
    Real-time system and engine telemetry for the Control Center dashboard.
    """
    stats = assistant.model.resource_manager.get_system_stats()
    return {
        "hardware": {
            "cpu_percent": stats["cpu_usage_percent"],
            "ram_percent": stats["ram_usage_percent"],
            "ram_available_gb": stats["available_ram_gb"],
            "ram_total_gb": stats["total_ram_gb"],
            "cores": stats["cpu_cores"]
        },
        "engine": {
            "model": assistant.model.selected_model_id,
            "mode": assistant.model.mode,
            "is_loading": assistant.model.loading_status["is_loading"],
            "loading_progress": assistant.model.loading_status["progress"],
            "loading_status": assistant.model.loading_status["status"]
        },
        "limits": assistant.model.limits
    }

# ── Setup / First Boot Endpoints ──────────────────────────────────────────────
from Backend import kova_config

@app.get("/setup/status")
def get_setup_status():
    """Checks if the user has completed the initial setup wizard."""
    cfg = kova_config.load()
    return {
        "setup_complete": cfg["meta"].get("setup_complete", False),
        "device_banned": cfg["meta"].get("device_banned", False),
        "boot_count": cfg["meta"].get("boot_count", 1)
    }

@app.post("/setup/complete")
def mark_setup_complete():
    """Updates the config to reflect that the setup wizard was finished."""
    kova_config.update_value("meta.setup_complete", True)
    return {"status": "success"}

class SetupFinalizeRequest(BaseModel):
    user_name: str = "User"
    resources: dict  # max_ram_percent, max_cpu_cores
    theme: str = "green"
    selected_model: str  # model_id from MODEL_REGISTRY
    groq_key: str = ""

@app.post("/setup/finalize")
def finalize_setup(request: SetupFinalizeRequest):
    """Atomically saves all wizard choices, triggers model download, marks setup complete."""
    from Backend.config import MODEL_REGISTRY
    from Backend import config
    import Backend.model_downloader as md
    
    # 1. Save resource limits to kova_config
    kova_config.update_value("resources.max_ram_percentage", request.resources.get("max_ram_percent", 50))
    kova_config.update_value("resources.max_cpu_cores", request.resources.get("max_cpu_cores", 4))
    
    # Also update DB so SettingsModal is in sync
    database.update_state("resources", {
        "max_ram_percent": request.resources.get("max_ram_percent", 50),
        "max_cpu_cores": request.resources.get("max_cpu_cores", 4),
        "min_os_reserved": 2
    })
    
    # Update live limits on the running assistant
    assistant.model.reload_limits()
    
    # 2. Save Groq key if provided
    if request.groq_key:
        kova_config.update_value("groq.api_key", request.groq_key)
    
    # 3. Save appearance theme
    kova_config.update_value("appearance.theme", request.theme)
    
    # 4. Save selected model as default
    kova_config.update_value("appearance.default_model", request.selected_model)
    database.update_state("last_model_id", request.selected_model)
    assistant.model.selected_model_id = request.selected_model
    
    # 5. Trigger immediate download if not already present
    if request.selected_model in MODEL_REGISTRY:
        model_info = MODEL_REGISTRY[request.selected_model]
        model_path = os.path.join(config.MODELS_DIR, model_info["filename"])
        if not os.path.exists(model_path):
            md.start_download(request.selected_model)
    
    # 6. Mark setup complete
    kova_config.update_value("meta.setup_complete", True)
    
    return {"status": "success", "downloading": request.selected_model}

# ── Permission Gateway Endpoints ──────────────────────────────────────────────

from Backend import permission_gateway as pg

class ConfirmActionRequest(BaseModel):
    action_id: str
    decision: str  # "allow" or "cancel"
    trust_future: bool = False

@app.post("/confirm_action")
def confirm_action(request: ConfirmActionRequest):
    """
    Called by the frontend when the user clicks Allow or Cancel
    on the permission bar.
    """
    if request.decision not in ("allow", "cancel"):
        raise HTTPException(status_code=400, detail="Invalid decision")
    
    # Check if we should trust this session going forward
    if request.trust_future and request.decision == "allow":
        # We need the conversation ID from the action info
        with pg._lock:
            action = pg._pending_actions.get(request.action_id)
            if action:
                pg.add_trust(action.get("conv_id"))

    success = pg.resolve_permission(request.action_id, request.decision)
    if not success:
        raise HTTPException(status_code=404, detail="Action not found or already resolved")
    return {"status": "resolved", "decision": request.decision}

@app.get("/pending_actions")
def get_pending_actions():
    """Returns all currently pending permission requests."""
    return pg.get_pending_actions()

# ── Authentication Endpoints ──────────────────────────────────────────────────

# The URL where your Next.js website middleman is running
MIDDLEMAN_URL = os.environ.get("MIDDLEMAN_URL", "https://matrixx-forge.vercel.app")

import time
from collections import defaultdict
from fastapi import Request

# Simple In-Memory Rate Limiter: Tracks (IP) -> list of timestamps
_AUTH_RATE_LIMITS = defaultdict(list)
_AUTH_STRIKES = defaultdict(int)
MAX_AUTH_ATTEMPTS_PER_MINUTE = 5

def check_auth_rate_limit(request: Request):
    from Backend import kova_config
    client_ip = request.client.host if request.client else "127.0.0.1"
    now = time.time()
    
    # Clean up old timestamps
    _AUTH_RATE_LIMITS[client_ip] = [ts for ts in _AUTH_RATE_LIMITS[client_ip] if now - ts < 60]
    
    if len(_AUTH_RATE_LIMITS[client_ip]) >= MAX_AUTH_ATTEMPTS_PER_MINUTE:
        _AUTH_STRIKES[client_ip] += 1
        print(f"[SECURITY] Rate limit strike {_AUTH_STRIKES[client_ip]}/3 for IP {client_ip}")
        
        # 🚨 AUTOMATED DETECTOR: 3 Strikes = Permanent Local Hardware Ban
        if _AUTH_STRIKES[client_ip] >= 3:
            print(f"[SECURITY] Critical Violation: IP {client_ip} exceeded rate limits 3 times. AUTOMATIC HARDWARE BAN.")
            kova_config.update_value("meta.device_banned", True)
            
        return False
    
    _AUTH_RATE_LIMITS[client_ip].append(now)
    return True

@app.get("/auth/login-url")
def get_login_url(request: Request):
    """Generates a secure login URL with a state parameter for CSRF protection."""
    if not check_auth_rate_limit(request):
        raise HTTPException(status_code=429, detail="Too many login attempts. Please try again in a minute.")
        
    print("[AUTH] Generating login URL...")
    state = str(uuid.uuid4())
    try:
        database.update_state("auth_state", state)
        print(f"[AUTH] State saved: {state}")
    except Exception as e:
        print(f"[AUTH] Database error saving state: {e}")
        raise HTTPException(status_code=500, detail="Database error")
    
    # Construct redirect URI for the callback
    host = request.headers.get("host", "127.0.0.1:8000")
    redirect_uri = f"http://{host}/auth/callback"
    
    login_url = f"{MIDDLEMAN_URL}/login?redirect_uri={redirect_uri}&state={state}"
    print(f"[AUTH] Returning URL: {login_url}")
    return {"login_url": login_url}

@app.get("/auth/callback", response_class=HTMLResponse)
async def auth_callback(request: Request):
    """Catches the browser redirect from the SSO login page."""
    if not check_auth_rate_limit(request):
        return HTMLResponse("<html><body style='font-family:sans-serif;background:#0a0a0b;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'><div style='text-align:center'><h2 style='color:#ef4444'>Too Many Requests</h2><p style='color:rgba(255,255,255,0.5)'>Please try logging in again in a minute.</p></div></body></html>", status_code=429)
        
    token = request.query_params.get("token")
    state = request.query_params.get("state")
    
    if not token or not state:
        return HTMLResponse("<html><body style='font-family:sans-serif;background:#0a0a0b;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'><div style='text-align:center'><h2 style='color:#ef4444'>Login Failed</h2><p style='color:rgba(255,255,255,0.5)'>Missing token or state parameter. Please try again.</p></div></body></html>", status_code=400)

    # 1. State Verification (Anti-Theft)
    expected_state = database.get_state("auth_state")
    
    if not expected_state or state != expected_state:
        # Graceful handling for duplicate redirects: if we already have a session, just show success
        if database.get_user_session():
            return HTMLResponse("""
            <html><body style='font-family:sans-serif;background:#0a0a0b;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>
            <div style='text-align:center'>
                <div style='font-size:48px;margin-bottom:16px'>&#x2705;</div>
                <h2 style='color:#00d26a;margin-bottom:8px'>Already Connected</h2>
                <p style='color:rgba(255,255,255,0.5)'>Your session is active. You can safely close this tab.</p>
            </div>
            </body></html>
            """)
        return HTMLResponse("<html><body style='font-family:sans-serif;background:#0a0a0b;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'><div style='text-align:center'><h2 style='color:#ef4444'>Security Alert</h2><p style='color:rgba(255,255,255,0.5)'>State mismatch. This login attempt was blocked because it was not initiated by your Matrix Kova app.</p></div></body></html>", status_code=401)

    # Clear the state immediately so it can't be reused (Replay Attack protection)
    database.update_state("auth_state", None)

    # 2. Verify the token against your website middleman
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{MIDDLEMAN_URL}/api/auth/verify-token",
                json={"token": token},
                headers={"Content-Type": "application/json"}
            )
        if resp.status_code != 200:
            raise ValueError("Middleman rejected token")
        
        data = resp.json()
        user_data = data.get("user", {})
        
        # Check for ban status
        if user_data.get("status") == "Banned":
            kova_config.update_value("meta.device_banned", True)
            database.save_user_session(None, None) # Clear any partial session
            return HTMLResponse("""
            <html><body style='font-family:sans-serif;background:#0a0a0b;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>
            <div style='text-align:center'>
                <div style='font-size:48px;margin-bottom:16px'>&#x26D4;</div>
                <h2 style='color:#ef4444;margin-bottom:8px'>Access Denied</h2>
                <p style='color:rgba(255,255,255,0.5)'>Your account has been banned. This device is now blacklisted.</p>
            </div>
            </body></html>
            """, status_code=403)
        
        user_profile = {
            "uid": user_data.get("uid"),
            "email": user_data.get("email"),
            "name": user_data.get("name") or user_data.get("email") or "MatrixForge User",
            "photo_url": user_data.get("photo_url")
        }
        # Save the session to local DB
        database.save_user_session(token, user_profile)

        return HTMLResponse("""
        <html><body style='font-family:sans-serif;background:#0a0a0b;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>
        <div style='text-align:center'>
            <div style='font-size:48px;margin-bottom:16px'>&#x2705;</div>
            <h2 style='color:#00d26a;margin-bottom:8px'>Login Successful!</h2>
            <p style='color:rgba(255,255,255,0.5)'>You are now connected to Matrix Kova. You can close this tab.</p>
        </div>
        </body></html>
        """)
    except Exception as e:
        return HTMLResponse(f"<html><body style='font-family:sans-serif;background:#0a0a0b;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'><div style='text-align:center'><h2 style='color:#ef4444'>Verification Failed</h2><p style='color:rgba(255,255,255,0.5)'>{str(e)}</p></div></body></html>", status_code=401)



_last_sync_time = 0

@app.get("/auth/status")
async def auth_status():
    """Lets the frontend poll to check if a user is currently logged in."""
    global _last_sync_time
    
    # NEW: Check for device ban first
    if kova_config.get_value("meta.device_banned", False):
        return {"logged_in": False, "user": None, "banned": True}
        
    session = database.get_user_session()
    
    if session and session.get("user"):
        print(f"[AUTH] Active session found for: {session.get('user', {}).get('name')}")
        return {"logged_in": True, "user": session["user"]}
    
    print("[AUTH] No active session.")
    return {"logged_in": False, "user": None}

async def refresh_user_profile(token: str):
    """Background task to fetch latest profile data from middleman."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{MIDDLEMAN_URL}/api/auth/verify-token",
                json={"token": token},
                headers={"Content-Type": "application/json"}
            )
            if resp.status_code == 200:
                data = resp.json()
                user_data = data.get("user", {})
                
                # Check for ban status in sync
                if user_data.get("status") == "Banned":
                    kova_config.update_value("meta.device_banned", True)
                    database.save_user_session(None, None)
                    print("[SYNC]: User banned. Device blacklisted.")
                    return

                user_profile = {
                    "uid": user_data.get("uid"),
                    "email": user_data.get("email"),
                    "name": user_data.get("name") or user_data.get("email") or "Matrix User",
                    "photo_url": user_data.get("photo_url")
                }
                database.save_user_session(token, user_profile)
    except Exception as e:
        # Avoid spamming logs if the website is just not running yet
        if "Connection refused" in str(e) or "ConnectError" in str(e):
             print(f"[SYNC]: Website node at {MIDDLEMAN_URL} is currently unreachable.")
        else:
             print(f"[SYNC ERROR]: {repr(e)}")


@app.post("/auth/logout")
def auth_logout():
    """Clears the local user session."""
    database.clear_user_session()
    return {"status": "success"}
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/download/{model_id}")
def download_model(model_id: str):
    success = model_downloader.start_download(model_id)
    return {"status": "started" if success else "already_running"}

@app.post("/pause/{model_id}")
def pause_download(model_id: str):
    success = model_downloader.stop_download(model_id, cancel=False)
    return {"status": "paused" if success else "not_found"}

@app.post("/cancel/{model_id}")
def cancel_download(model_id: str):
    success = model_downloader.stop_download(model_id, cancel=True)
    return {"status": "cancelled" if success else "not_found"}

@app.get("/conversations")
def list_conversations():
    return database.get_all_conversations()

@app.get("/history/{conv_id}")
def get_chat_history(conv_id: int):
    return database.get_history(conv_id)

@app.post("/conversations")
def new_conversation(request: ModelSelectRequest):
    model_id = request.model_id
    if not model_id:
        appearance = database.get_state("appearance", {})
        model_id = appearance.get("default_model", "phi3") # Sensible default
    
    conv_id = database.create_conversation("New Chat", model_id)
    return {"id": conv_id}

@app.delete("/conversations/{conv_id}")
def delete_conv(conv_id: int):
    database.delete_conversation(conv_id)
    return {"status": "deleted"}

@app.patch("/conversations/{conv_id}")
def rename_conv(conv_id: int, request: RenameRequest):
    database.update_conversation_title(conv_id, request.new_title)
    return {"status": "renamed"}

@app.post("/chat")
def chat(request: ChatRequest):
    return StreamingResponse(
        assistant.chat_stream(request.message, request.conversation_id, request.use_orchestrator),
        media_type="text/event-stream"
    )

@app.get("/settings")
def get_settings():
    return {
        "personalisation": database.get_state("personalisation", {
            "name": "", "occupation": "", "instructions": ""
        }),
        "resources": database.get_state("resources", {
            "max_ram_percent": 25, "max_cpu_cores": 4, "min_os_reserved": 2
        }),
        "appearance": database.get_state("appearance", {
            "theme": "green",
            "default_model": "phi3"
        }),
        "paths": {
            "models_dir": kova_config.get_value("paths.models_dir") or os.path.join(kova_config.KOVA_DIR, "Models")
        },
        "auth": {
            "user": database.get_state("auth_user"),
            "token": database.get_state("auth_token")
        },
        "drive": drive_mgr.get_local_status()
    }

@app.post("/settings/update_models_path")
def update_models_path(request: PathRequest):
    import shutil
    from Backend import config
    from Backend import kova_config
    
    new_base = request.new_path.strip()
    if not new_base:
        raise HTTPException(status_code=400, detail="Path cannot be empty")
        
    # Create the MatrixKovaModels subfolder as requested
    new_models_dir = os.path.join(new_base, "MatrixKovaModels")
    try:
        os.makedirs(new_models_dir, exist_ok=True)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not create directory: {str(e)}")
    
    old_models_dir = config.MODELS_DIR
    
    # Shift files if it's a different location
    if os.path.abspath(old_models_dir) != os.path.abspath(new_models_dir):
        try:
            files = os.listdir(old_models_dir)
            for f in files:
                src = os.path.join(old_models_dir, f)
                dst = os.path.join(new_models_dir, f)
                if os.path.isfile(src):
                    # If destination exists, remove it first to avoid move errors
                    if os.path.exists(dst):
                        os.remove(dst)
                    shutil.move(src, dst)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to move models: {str(e)}")
    
    # Update config.json
    kova_config.update_value("paths.models_dir", new_models_dir)
    
    # Update current runtime config
    config.MODELS_DIR = new_models_dir
    
    return {"status": "success", "new_path": new_models_dir}

@app.post("/settings")
def save_settings(request: SettingsRequest):
    database.update_state("personalisation", request.personalisation)
    database.update_state("resources", request.resources)
    database.update_state("appearance", request.appearance)
    # Trigger dynamic reload of limits in model manager
    assistant.model.reload_limits()
    return {"status": "success"}

@app.get("/settings/export")
def export_backup():
    """Exports entire database as JSON."""
    try:
        return database.export_data()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/settings/import")
def import_backup(data: dict):
    """Overwrites entire database from provided JSON."""
    try:
        success = database.import_data(data)
        if success:
            return {"status": "success"}
        raise HTTPException(status_code=400, detail="Database import failed.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/files")
def list_files():
    EXTS = {'.py', '.js', '.txt', '.md', '.json', '.html', '.css'}
    IGNORE = {'node_modules', '.next', '.git', '__pycache__', 'venv', '.gemini'}
    files = []
    
    # We will scan the project root AND the user's Desktop
    project_root = os.getcwd()
    desktop = os.path.join(os.path.expanduser("~"), "Desktop")
    
    search_dirs = [
        ("Project", project_root),
        ("Desktop", desktop)
    ]
    
    for label, root_dir in search_dirs:
        if not os.path.exists(root_dir): continue
        
        for dirpath, dirnames, filenames in os.walk(root_dir):
            # Filter out ignored directories
            dirnames[:] = [d for d in dirnames if d not in IGNORE]
            
            for f in filenames:
                if any(f.endswith(ext) for ext in EXTS):
                    full_path = os.path.join(dirpath, f)
                    rel_path = os.path.relpath(full_path, root_dir)
                    # Prefix with the label so user knows where it is
                    display_name = f"[{label}] {rel_path}"
                    
                    files.append({
                        "name": display_name,
                        "real_path": full_path,
                        "size": os.path.getsize(full_path),
                        "modified": os.path.getmtime(full_path)
                    })
    
    # Sort by newest first
    files.sort(key=lambda x: x['modified'], reverse=True)
    return files

@app.get("/files/read")
def read_file_content(filepath: str):
    # We now receive the absolute path from the frontend
    safe_path = os.path.abspath(filepath)
    
    project_root = os.getcwd()
    desktop = os.path.join(os.path.expanduser("~"), "Desktop")
    
    # Security check: MUST be inside the project root OR the Desktop
    is_safe = safe_path.startswith(project_root) or safe_path.startswith(desktop)
    
    if not is_safe or not os.path.exists(safe_path):
        raise HTTPException(status_code=403, detail="Access denied or file not found")
    
    try:
        with open(safe_path, 'r', encoding='utf-8') as f:
            return {"content": f.read()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ==========================================

@app.post("/drive/connect")
async def drive_connect():
    try:
        # This will open the browser if not authenticated, or return True if valid
        success = drive_mgr.connect()
        return {"status": "success", "connected": success}
    except Exception as e:
        print(f"Drive connection error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/drive/status")
async def drive_status():
    try:
        return drive_mgr.get_local_status()
    except Exception as e:
        print(f"Drive status error: {e}")
        return {"connected": False, "error": str(e)}

@app.post("/drive/backup")
async def drive_backup():
    try:
        result = drive_mgr.backup_database()
        return result
    except Exception as e:
        print(f"Drive backup error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ── Serve Frontend Static Files ──────────────────────────────────────────────
# Determine where the frontend files are
if getattr(sys, 'frozen', False):
    # Running from a PyInstaller bundle
    static_dir = os.path.join(sys._MEIPASS, "frontend", "out")
else:
    # Running from source
    static_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "out")

if os.path.exists(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
else:
    print(f"Warning: Static directory not found at {static_dir}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)

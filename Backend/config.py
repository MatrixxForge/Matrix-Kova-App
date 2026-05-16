import os
import threading as _threading
import time
import json
from dotenv import load_dotenv
from Backend.kova_config import KOVA_DIR, load as load_kova_config

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Seed .env into the process environment first (kova_config uses it on first boot)
env_path = os.path.join(os.path.dirname(BASE_DIR), ".env")
if os.path.exists(env_path):
    load_dotenv(env_path)

# ── Load the authoritative config from Matrix Kova/config.json ───────────────
_cfg = load_kova_config()

HISTORY_DIR = os.path.join(KOVA_DIR, "history")
if not os.path.exists(HISTORY_DIR):
    os.makedirs(HISTORY_DIR, exist_ok=True)
HISTORY_FILE = os.path.join(HISTORY_DIR, "chatlog.json")
# ── Dynamic Model Storage ────────────────────────────────────────────────────
from Backend.kova_config import get_value

MODELS_DIR = get_value("paths.models_dir")
if not MODELS_DIR:
    MODELS_DIR = os.path.join(KOVA_DIR, "Models")

if not os.path.exists(MODELS_DIR):
    os.makedirs(MODELS_DIR, exist_ok=True)

# Resource Constraints — sourced from config.json (user-editable)
MAX_RAM_PERCENT      = float(_cfg["resources"]["max_ram_percentage"])
MAX_CPU_CORES        = int(_cfg["resources"].get("max_cpu_cores", 4))
MIN_OS_RESERVED_RAM  = float(_cfg["resources"]["min_os_reserved_ram_gb"])

# Model Registry (4-bit quantized estimates)
# ram_gb     = size of the model file on disk
# min_ram_gb = minimum SYSTEM RAM required to run it comfortably
# Model Registry is now fetched dynamically from the Firebase DB via the Middleman API
# Default fallback if dynamic fetch fails (will be populated dynamically at runtime)
# Model Registry is now fetched dynamically from the Firebase DB via the Middleman API
# Default fallback if dynamic fetch fails
MODEL_REGISTRY = {}
GROQ_MODELS = {}
_LAST_MODEL_FETCH = 0
_SYNC_LOCK = _threading.Lock()

def get_dynamic_models():
    """
    Returns the current in-memory registry instantly.
    Triggers a background sync if the cache is stale.
    """
    global MODEL_REGISTRY, GROQ_MODELS, _LAST_MODEL_FETCH
    
    now = time.time()
    
    # 1. If we have data and it's fresh (60s), just return it
    if (MODEL_REGISTRY or GROQ_MODELS) and (now - _LAST_MODEL_FETCH < 60):
        return MODEL_REGISTRY, GROQ_MODELS
        
    # 2. If data is stale or missing, trigger a BACKGROUND sync
    # We use a lock to ensure only one sync happens at a time
    if _SYNC_LOCK.locked():
        # Sync already in progress, return what we have (even if empty)
        if not MODEL_REGISTRY and not GROQ_MODELS:
            _load_from_persistence()
        return MODEL_REGISTRY, GROQ_MODELS
        
    # Trigger sync in a daemon thread
    _threading.Thread(target=_perform_sync_task, daemon=True).start()
    
    # While syncing, try to load from persistence if memory is empty
    if not MODEL_REGISTRY and not GROQ_MODELS:
        _load_from_persistence()
        
    return MODEL_REGISTRY, GROQ_MODELS

def _perform_sync_task():
    """Threaded task to fetch data from website and update local state."""
    global MODEL_REGISTRY, GROQ_MODELS, _LAST_MODEL_FETCH
    
    with _SYNC_LOCK:
        import requests
        from Backend import database
        
        MIDDLEMAN_URL = os.environ.get("MIDDLEMAN_URL", "https://matrixx-forge.vercel.app")
        success = False
        data = {}
        
        try:
            # Short timeout for background sync to keep it snappy
            resp = requests.get(f"{MIDDLEMAN_URL}/api/models", timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                if "models" in data: data = data["models"]
                # Filter out any error responses from website
                if isinstance(data, dict) and len(data) > 0:
                    success = True
        except Exception as e:
            # Fallback for Windows port conflicts
            if "3000" in MIDDLEMAN_URL:
                try:
                    alt_url = MIDDLEMAN_URL.replace("3000", "3001")
                    resp = requests.get(f"{alt_url}/api/models", timeout=3)
                    if resp.status_code == 200:
                        data = resp.json()
                        if "models" in data: data = data["models"]
                        success = True
                except: pass

        if success:
            database.update_state("cached_model_registry", data)
            database.update_state("last_models_sync", time.time())
            _LAST_MODEL_FETCH = time.time()
            print(f"[SYNC] Neural Registry updated from {MIDDLEMAN_URL}")
        else:
            # If sync failed, try to load from DB or Seed
            cached = database.get_state("cached_model_registry")
            if cached:
                data = cached
            else:
                data = _load_seed_registry()

        # Process into split registry
        local_models = {}
        groq_models = {}
        for k, v in data.items():
            if v.get("disabled"): continue
            if v.get("is_online"):
                groq_models[k] = v
            else:
                local_models[k] = v
                
        MODEL_REGISTRY = local_models
        GROQ_MODELS = groq_models
        _LAST_MODEL_FETCH = time.time()
        
        # Also auto-sync user profile if we have an active session
        session = database.get_user_session()
        if session:
            try:
                auth_resp = requests.post(
                    f"{MIDDLEMAN_URL}/api/auth/verify-token", 
                    json={"token": session["token"]},
                    timeout=5
                )
                if auth_resp.status_code == 200:
                    user_data = auth_resp.json().get("user", {})
                    if user_data:
                        new_profile = session["user"].copy()
                        new_profile.update({
                            "name": user_data.get("name") or new_profile.get("name"),
                            "photo_url": user_data.get("photo_url") or new_profile.get("photo_url")
                        })
                        database.update_state("auth_user", new_profile)
            except:
                pass

def _load_from_persistence():
    """Helper to populate memory from DB or Seed without a web request."""
    global MODEL_REGISTRY, GROQ_MODELS
    from Backend import database
    
    cached = database.get_state("cached_model_registry")
    if not cached:
        cached = _load_seed_registry()
        
    local_models = {}
    groq_models = {}
    for k, v in cached.items():
        if v.get("disabled"): continue
        if v.get("is_online"):
            groq_models[k] = v
        else:
            local_models[k] = v
            
    MODEL_REGISTRY = local_models
    GROQ_MODELS = groq_models

def _load_seed_registry():
    """Reads the hard-coded seed registry if everything else is empty."""
    seed_path = os.path.join(os.path.dirname(__file__), "seed_registry.json")
    if os.path.exists(seed_path):
        try:
            with open(seed_path, "r") as f:
                return json.load(f)
        except: pass
    return {}


# Current default if no dynamic selection happens
MODEL_PATH = os.path.join(MODELS_DIR, "llama-3-8b-instruct.gguf")

# CPU Core restrictions (Fallback)
MAX_THREADS = 4

# Groq Configuration — sourced from config.json (user-editable)
GROQ_API_KEY = _cfg["groq"]["api_key"] or os.environ.get("GROQ_API_KEY", "")

# User awareness: Desktop path for "on desktop" commands
DESKTOP_PATH = os.path.join(os.environ.get('USERPROFILE', ''), 'Desktop')

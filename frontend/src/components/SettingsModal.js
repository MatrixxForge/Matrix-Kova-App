"use client";
import React, { useState, useEffect } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { User, Cpu, Layers, Info, Check, Loader2, X, ChevronRight, Zap, Globe, HardDrive, Shield, Sliders, AlertCircle, Trash2, Palette, Cloud, Database, Download, Upload, RefreshCw, History } from 'lucide-react';

// ── Minimal Dialog built from primitives to avoid missing-title warning ──
function Modal({ open, onClose, children }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onClose}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(16px)', zIndex: 500 }}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            zIndex: 501, outline: 'none',
            width: '860px', maxWidth: '96vw', height: '560px', maxHeight: '92vh',
          }}
        >
          <DialogPrimitive.Title style={{ display: 'none' }}>Matrix System Configuration</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const TABS = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'resources', label: 'Resources', icon: Sliders },
  { id: 'models', label: 'Models', icon: Layers },
  { id: 'backup', label: 'Backup & Sync', icon: Database },
  { id: 'updates', label: 'Updates', icon: RefreshCw },
  { id: 'about', label: 'About', icon: Info },
];

function SliderInput({ min, max, step, value, onChange, color = 'var(--matrix-primary)' }) {
  return (
    <input
      type="range" min={min} max={max} step={step} value={value}
      onChange={e => onChange(Number(e.target.value))}
      style={{ width: '100%', accentColor: color, cursor: 'pointer', height: '4px' }}
    />
  );
}

export default function SettingsModal({ isOpen, onClose }) {
  const getApiBase = () => {
    const port = (typeof window !== 'undefined' && window.MATRIX_BACKEND_PORT) || 8000;
    const host = (typeof window !== 'undefined' && window.location.hostname) || '127.0.0.1';
    return `http://${host}:${port}`;
  };
  const [activeTab, setActiveTab] = useState('profile');
  const [profile, setProfile] = useState({ name: '', occupation: '', instructions: '' });
  const [resources, setResources] = useState({ max_ram_percent: 25, max_cpu_cores: 4, min_os_reserved: 2 });
  const [telemetry, setTelemetry] = useState(null);
  const [appearance, setAppearance] = useState({ theme: 'green' });
  const [engineMode, setEngineMode] = useState('online');
  const [availableModels, setAvailableModels] = useState({});
  const [selectedModel, setSelectedModel] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [modelsPath, setModelsPath] = useState('');
  const [isUpdatingPath, setIsUpdatingPath] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  
  // Drive state (Frontend simulation until backend is ready)
  const [driveStatus, setDriveStatus] = useState("not_connected"); // "not_connected" | "connected_no_backup" | "backup_exists"
  const [lastBackup, setLastBackup] = useState(null);
  const [isDriveWorking, setIsDriveWorking] = useState(false);
  
  // Update state
  const [version, setVersion] = useState('...');
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateStatus, setUpdateStatus] = useState('idle'); // idle, latest, available, error

  useEffect(() => {
    if (!isOpen) return;
    fetch(`${getApiBase()}/settings`).then(r => r.json()).then(d => {
      if (d.personalisation) setProfile(d.personalisation);
      if (d.resources) setResources(d.resources);
      if (d.appearance) {
        setAppearance(d.appearance);
        setModelsPath(d.paths?.models_dir || '');
        document.documentElement.setAttribute('data-theme', d.appearance.theme);
      }
      
      // Update Drive Status from Local DB
      if (d.drive) {
        if (d.drive.connected) {
          setDriveStatus(d.drive.last_backup_at ? "backup_exists" : "connected_no_backup");
          setLastBackup(d.drive.last_backup_at);
        }
      }

      // SYNC WITH WEBSITE (Firebase) - Dual Source Check
      const uid = d.auth?.user?.uid;
      if (uid) {
        fetch(`https://matrixx-forge.vercel.app/api/drive/status?uid=${uid}`)
          .then(r => r.json())
          .then(webData => {
            if (webData.connected) {
              // Website/Firebase is the source of truth for "is connected"
              setDriveStatus(prev => {
                if (webData.lastBackupAt) return "backup_exists";
                return "connected_no_backup";
              });
              if (webData.lastBackupAt) {
                // Use the most recent backup timestamp
                setLastBackup(prev => {
                  if (!prev) return webData.lastBackupAt;
                  return new Date(webData.lastBackupAt) > new Date(prev) ? webData.lastBackupAt : prev;
                });
              }
            }
          }).catch(err => console.warn("Failed to sync with website drive status", err));
      }
    }).catch(() => { });
    fetch(`${getApiBase()}/status`).then(r => r.json()).then(d => {
      setEngineMode(d.mode || 'online');
      setSelectedModel(d.model || '');
    }).catch(() => { });
    fetch(`${getApiBase()}/models_all`).then(r => r.json()).then(setAvailableModels).catch(() => { });
    fetch(`${getApiBase()}/telemetry`).then(r => r.json()).then(d => setTelemetry(d.hardware)).catch(() => { });
    
    // Fetch version
    fetch(`${getApiBase()}/system/version`).then(r => r.json()).then(d => setVersion(d.version)).catch(() => {});
  }, [isOpen]);

  const handleCheckUpdate = async () => {
    setIsCheckingUpdate(true);
    setUpdateStatus('idle');
    try {
      // Use the website API to check for latest version
      const res = await fetch('https://matrixx-forge.vercel.app/api/system/latest');
      if (!res.ok) throw new Error();
      const latest = await res.json();
      setUpdateInfo(latest);
      
      if (latest.version !== version) {
        setUpdateStatus('available');
      } else {
        setUpdateStatus('latest');
      }
    } catch (e) {
      setUpdateStatus('error');
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleTriggerUpdate = async () => {
    try {
      await fetch(`${getApiBase()}/system/update/finalize`, { method: "POST" });
    } catch (e) {
      console.error("Failed to finalize update:", e);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await fetch(`${getApiBase()}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personalisation: profile, resources, appearance })
      });
      document.documentElement.setAttribute('data-theme', appearance.theme);
      await fetch(`${getApiBase()}/set_mode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: engineMode }) });
      if (selectedModel) await fetch(`${getApiBase()}/select_model`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_id: selectedModel }) });
      setSaveSuccess(true);
      setTimeout(() => { setSaveSuccess(false); onClose(); }, 1500);
    } finally { setIsSaving(false); }
  };

  const computedTotalCores = telemetry?.cores || 8;
  const cpuPercent = (resources.max_cpu_cores / computedTotalCores) * 100;
  const healthScore = Math.round((resources.max_ram_percent + cpuPercent) / 2) || 0;
  const healthColor = healthScore > 70 ? '#ef4444' : healthScore > 45 ? '#f59e0b' : 'var(--matrix-primary)';

  const [deletingModel, setDeletingModel] = useState(null); // For confirmation popup

  const handleUpdatePath = async () => {
    if (!modelsPath) return;
    setIsUpdatingPath(true);
    try {
      const res = await fetch(`${getApiBase()}/settings/update_models_path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_path: modelsPath })
      });
      if (res.ok) {
        const data = await res.json();
        setModelsPath(data.new_path);
        // Refresh models list to ensure everything is correct
        fetch(`${getApiBase()}/models_all`).then(r => r.json()).then(setAvailableModels);
      }
    } catch (e) {
      console.error("Error moving models:", e);
    } finally {
      setIsUpdatingPath(false);
    }
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const res = await fetch(`${getApiBase()}/settings/export`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Server error (${res.status}): ${text.substring(0, 100)}`);
      }
      
      const data = await res.json();
      const jsonString = JSON.stringify(data, null, 2);

      // Try modern File System Access API first (Asks for location)
      if ('showSaveFilePicker' in window) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: `matrix_backup_${new Date().toISOString().split('T')[0]}.json`,
            types: [{
              description: 'JSON Backup File',
              accept: { 'application/json': ['.json'] },
            }],
          });
          const writable = await handle.createWritable();
          await writable.write(jsonString);
          await writable.close();
          return;
        } catch (err) {
          if (err.name === 'AbortError') return;
          console.warn("showSaveFilePicker failed, falling back to legacy download", err);
        }
      }

      // Legacy fallback download
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `matrix_backup_${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Export failed:", e);
      alert(`Export failed: ${e.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleBrowseFolder = async () => {
    try {
      if (window.pywebview && window.pywebview.api) {
        const path = await window.pywebview.api.browse_folder();
        if (path) setModelsPath(path);
      } else {
        console.warn("Native file picker not available (Browser mode?)");
      }
    } catch (e) {
      console.error("Browse failed:", e);
    }
  };

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsImporting(true);
    try {
      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          const data = JSON.parse(evt.target.result);
          const res = await fetch(`${getApiBase()}/settings/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          
          if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText || "Database import failed.");
          }

          alert("Backup restored successfully. The app will now reload.");
          window.location.reload();
        } catch (err) {
          alert(`Import failed: ${err.message}`);
        } finally {
          setIsImporting(false);
        }
      };
      reader.readAsText(file);
    } catch (err) {
      console.error("Import failed:", err);
      setIsImporting(false);
    }
  };

  const handleConnectDrive = () => {
    // 1. Get the actual UID from the profile if it exists, else use temp
    const uid = profile.uid || "desktop_user_temp";
    const port = window.MATRIX_BACKEND_PORT || 8000;
    const url = `https://matrixx-forge.vercel.app/drive-connect?uid=${uid}&redirect=app&port=${port}`;
    
    // 2. Open the website connect page using native browser if possible
    if (window.pywebview && window.pywebview.api && window.pywebview.api.open_external_browser) {
      window.pywebview.api.open_external_browser(url);
    } else {
      window.open(url, "_blank");
    }
    
    setIsDriveWorking(true);
    
    // 3. Poll the LOCAL backend to see when the user finishes the browser flow
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(`${getApiBase()}/drive/status`);
        const d = await res.json();
        if (d.connected) {
          clearInterval(poll);
          setDriveStatus(d.last_backup_at ? "backup_exists" : "connected_no_backup");
          setLastBackup(d.last_backup_at);
          setIsDriveWorking(false);
        }
      } catch (e) { }
      if (attempts > 30) {
        clearInterval(poll);
        setIsDriveWorking(false);
      }
    }, 2000);
  };

  const handleBackupDrive = async () => {
    setIsDriveWorking(true);
    try {
      const res = await fetch(`${getApiBase()}/drive/backup`, { method: "POST" });
      if (!res.ok) throw new Error("Backup failed on backend");
      
      const now = new Date().toLocaleString();
      setLastBackup(now);
      setDriveStatus("backup_exists");
    } catch (e) {
      console.error(e);
      alert("Failed to create backup on Google Drive.");
    } finally {
      setIsDriveWorking(false);
    }
  };

  const handleSetDefault = async (modelId) => {
    try {
      await fetch(`${getApiBase()}/set_default_model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: modelId })
      });
      setAppearance(prev => ({ ...prev, default_model: modelId }));
    } catch (e) {
      console.error("Failed to set default model:", e);
    }
  };

  const handleDeleteModel = async (modelId) => {
    try {
      const res = await fetch(`${getApiBase()}/delete_model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: modelId })
      });
      if (res.ok) {
        // Refresh models list
        const r = await fetch(`${getApiBase()}/models_all`);
        const d = await r.json();
        setAvailableModels(d);
        setDeletingModel(null);
      }
    } catch (err) {
      console.error("Failed to delete model", err);
    }
  };

  return (
    <Modal open={isOpen} onClose={onClose}>
      <div style={{ display: 'flex', height: '100%', background: '#0e0e10', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '20px', overflow: 'hidden', boxShadow: '0 40px 100px rgba(0,0,0,0.8)', fontFamily: 'Inter, sans-serif', position: 'relative' }}>

        {/* ── Confirmation Overlay ── */}
        {deletingModel && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(10px)', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px' }}>
            <div style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '20px', padding: '32px', maxWidth: '400px', width: '100%', textAlign: 'center', boxShadow: '0 30px 60px rgba(0,0,0,0.5)' }}>
              <div style={{ width: '60px', height: '60px', borderRadius: '50%', background: 'rgba(239,68,68,0.1)', color: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                <AlertCircle size={30} />
              </div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#fff', marginBottom: '8px' }}>Delete Model?</div>
              <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.4)', marginBottom: '28px', lineHeight: 1.5 }}>
                Are you sure you want to delete <span style={{ color: '#fff', fontWeight: 600 }}>{deletingModel.name}</span>? This will free up {deletingModel.size} of space.
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button onClick={() => setDeletingModel(null)} style={{ flex: 1, height: '42px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                <button onClick={() => handleDeleteModel(deletingModel.id)} style={{ flex: 1, height: '42px', borderRadius: '12px', border: 'none', background: '#ef4444', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer', boxShadow: '0 4px 12px rgba(239,68,68,0.3)' }}>Delete</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Left Sidebar Nav ── */}
        <div style={{ width: '200px', borderRight: '1px solid rgba(255,255,255,0.05)', display: 'flex', flexDirection: 'column', flexShrink: 0, background: '#0a0a0b' }}>
          {/* Modal title area */}
          <div style={{ padding: '24px 20px 20px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--matrix-primary)', letterSpacing: '3px', textTransform: 'uppercase', marginBottom: '4px' }}>Matrix Kova</div>
            <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff', letterSpacing: '-0.3px' }}>System Config</div>
          </div>

          {/* Nav Items */}
          <div style={{ flex: 1, padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {TABS.map(({ id, label, icon: Icon }) => {
              const active = activeTab === id;
              return (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '10px 12px', borderRadius: '10px', border: 'none',
                    cursor: 'pointer', transition: 'all 0.2s', width: '100%', textAlign: 'left',
                    background: active ? 'rgba(var(--matrix-primary-rgb),0.08)' : 'transparent',
                    color: active ? 'var(--matrix-primary)' : 'rgba(255,255,255,0.4)',
                  }}
                  onMouseEnter={e => { if (!active) { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = '#fff'; } }}
                  onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; } }}
                >
                  <Icon size={15} />
                  <span style={{ fontSize: '13px', fontWeight: 600 }}>{label}</span>
                  {active && <ChevronRight size={13} style={{ marginLeft: 'auto', opacity: 0.5 }} />}
                </button>
              );
            })}
          </div>

          {/* Close */}
          <div style={{ padding: '16px 10px', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            <button onClick={onClose} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '10px', border: 'none', cursor: 'pointer', width: '100%', background: 'transparent', color: 'rgba(255,255,255,0.25)', transition: 'all 0.2s' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = '#fff'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.25)'; }}
            >
              <X size={15} /><span style={{ fontSize: '13px', fontWeight: 600 }}>Close</span>
            </button>
          </div>
        </div>

        {/* ── Right Content Panel ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* Content Area */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '32px 36px' }} className="custom-scrollbar">

            {/* ──── PROFILE TAB ──── */}
            {activeTab === 'profile' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                <div>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: '#fff', marginBottom: '4px' }}>Profile</div>
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.3)' }}>Personalise how Matrix addresses you and behaves</div>
                </div>
                {[
                  { label: 'Your Name', key: 'name', placeholder: 'e.g. John Doe', hint: 'Used when Matrix addresses you in conversation.' },
                  { label: 'Role / Occupation', key: 'occupation', placeholder: 'e.g. Software Engineer', hint: 'Helps the agent tailor technical depth to your level.' },
                ].map(({ label, key, placeholder, hint }) => (
                  <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: '1.5px', textTransform: 'uppercase' }}>{label}</label>
                    <input
                      value={profile[key]} onChange={e => setProfile({ ...profile, [key]: e.target.value })}
                      placeholder={placeholder}
                      style={{ height: '42px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '0 14px', fontSize: '14px', color: '#fff', outline: 'none', transition: 'border-color 0.2s' }}
                      onFocus={e => e.target.style.borderColor = 'rgba(var(--matrix-primary-rgb),0.4)'}
                      onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.08)'}
                    />
                    <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.2)' }}>{hint}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: '1.5px', textTransform: 'uppercase' }}>System Instructions</label>
                  <textarea
                    value={profile.instructions} onChange={e => setProfile({ ...profile, instructions: e.target.value })}
                    placeholder="e.g. Always respond concisely. Use Python for all code examples..."
                    rows={4}
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '12px 14px', fontSize: '14px', color: '#fff', outline: 'none', resize: 'vertical', lineHeight: 1.6, transition: 'border-color 0.2s', fontFamily: 'inherit' }}
                    onFocus={e => e.target.style.borderColor = 'rgba(var(--matrix-primary-rgb),0.4)'}
                    onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.08)'}
                  />
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.2)' }}>Permanently injected into every conversation as a system directive.</span>
                </div>
              </div>
            )}

            {/* ──── APPEARANCE TAB ──── */}
            {activeTab === 'appearance' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
                <div>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: '#fff', marginBottom: '4px' }}>Appearance</div>
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.3)' }}>Customise the visual interface and accent colors</div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: '1.5px', textTransform: 'uppercase' }}>Accent Color</label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px' }}>
                    {[
                      { id: 'green', label: 'Matrix Green', color: '#00d26a' },
                      { id: 'cyan', label: 'Cyber Cyan', color: '#00e5ff' },
                      { id: 'amber', label: 'Neon Amber', color: '#ffbf00' },
                      { id: 'purple', label: 'Deep Purple', color: '#d000ff' },
                      { id: 'blue', label: 'Ocean Blue', color: '#3b82f6' },
                      { id: 'red', label: 'Blood Red', color: '#ef4444' },
                    ].map((theme) => {
                      const active = appearance.theme === theme.id;
                      return (
                        <button
                          key={theme.id}
                          onClick={() => {
                            setAppearance({ ...appearance, theme: theme.id });
                            document.documentElement.setAttribute('data-theme', theme.id);
                          }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: '12px', padding: '16px',
                            borderRadius: '16px', border: '1px solid',
                            borderColor: active ? theme.color : 'rgba(255,255,255,0.06)',
                            background: active ? `${theme.color}08` : 'rgba(255,255,255,0.02)',
                            cursor: 'pointer', transition: 'all 0.2s', textAlign: 'left'
                          }}
                          onMouseEnter={e => { if (!active) e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'; }}
                          onMouseLeave={e => { if (!active) e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'; }}
                        >
                          <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: theme.color, boxShadow: active ? `0 0 15px ${theme.color}60` : 'none', flexShrink: 0 }} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: '14px', fontWeight: 700, color: active ? '#fff' : 'rgba(255,255,255,0.5)' }}>{theme.label}</div>
                          </div>
                          {active && <Check size={16} color={theme.color} />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={{ padding: '24px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '20px', display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
                  <div style={{
                    width: '40px', height: '40px', borderRadius: '12px',
                    background: 'rgba(var(--matrix-primary-rgb),0.1)',
                    color: 'var(--matrix-primary)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    transition: 'all 0.3s ease'
                  }}>
                    <Zap size={20} />
                  </div>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: '#fff', marginBottom: '4px' }}>Real-time Preview Active</div>
                    <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.3)', lineHeight: 1.5 }}>
                      The interface color now updates instantly as you browse themes. Click "Apply Changes" to persist your selection permanently.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ──── RESOURCES TAB ──── */}
            {activeTab === 'resources' && (() => {
              const totalRam = telemetry?.ram_total_gb || 8;
              const totalCores = telemetry?.cores || 8;
              const allowedRam = ((totalRam * resources.max_ram_percent) / 100).toFixed(1);

              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
                  <div>
                    <div style={{ fontSize: '18px', fontWeight: 700, color: '#fff', marginBottom: '4px' }}>Hardware Limits</div>
                    <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.3)' }}>Control how much of your system Matrix is allowed to use</div>
                  </div>

                  {/* RAM slider */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>Max RAM Allocation</label>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <span style={{ fontSize: '12px', fontWeight: 700, padding: '3px 10px', borderRadius: '20px', background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.1)' }}>
                          {allowedRam} GB
                        </span>
                        <span style={{ fontSize: '12px', fontWeight: 700, padding: '3px 10px', borderRadius: '20px', background: 'rgba(var(--matrix-primary-rgb),0.08)', color: 'var(--matrix-primary)', border: '1px solid rgba(var(--matrix-primary-rgb),0.15)' }}>
                          {resources.max_ram_percent}%
                        </span>
                      </div>
                    </div>
                    <SliderInput min={5} max={90} step={5} value={resources.max_ram_percent} onChange={v => setResources({ ...resources, max_ram_percent: v })} />
                    <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.2)' }}>Upper bound on memory consumption by local models.</span>
                  </div>

                  {/* CPU slider */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>CPU Thread Usage</label>
                      <span style={{ fontSize: '12px', fontWeight: 700, padding: '3px 10px', borderRadius: '20px', background: 'rgba(var(--matrix-primary-rgb),0.08)', color: 'var(--matrix-primary)', border: '1px solid rgba(var(--matrix-primary-rgb),0.15)' }}>
                        {resources.max_cpu_cores} Cores
                      </span>
                    </div>
                    <SliderInput min={1} max={totalCores} step={1} value={resources.max_cpu_cores} onChange={v => setResources({ ...resources, max_cpu_cores: v })} />
                    <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.2)' }}>Affects local inference speed. Higher = faster but more load.</span>
                  </div>

                  {/* OS Reserve slider */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>OS Memory Reserve</label>
                      <span style={{ fontSize: '12px', fontWeight: 700, padding: '3px 10px', borderRadius: '20px', background: 'rgba(var(--matrix-primary-rgb),0.08)', color: 'var(--matrix-primary)', border: '1px solid rgba(var(--matrix-primary-rgb),0.15)' }}>
                        {resources.min_os_reserved} GB
                      </span>
                    </div>
                    <SliderInput min={1} max={8} step={0.5} value={resources.min_os_reserved} onChange={v => setResources({ ...resources, min_os_reserved: v })} />
                    <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.2)' }}>Always keep this much RAM free for Windows to prevent lag.</span>
                  </div>

                  <div style={{ padding: '16px 20px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '1px' }}>System Stress</span>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: healthColor }}>{healthScore}%</span>
                    </div>
                    <div style={{ height: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${healthScore}%`, background: healthColor, borderRadius: '6px', boxShadow: `0 0 12px ${healthColor}60`, transition: 'all 0.4s' }} />
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* ──── MODELS TAB ──── */}
            {activeTab === 'models' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: '#fff', marginBottom: '4px' }}>Model Engine</div>
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.3)' }}>Manage local and cloud models and set your default startup engine</div>
                </div>

                {/* Model Storage Path Section */}
                <div style={{ padding: '20px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'rgba(var(--matrix-primary-rgb),0.1)', color: 'var(--matrix-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <HardDrive size={16} />
                    </div>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>Model Storage Location</div>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)' }}>Where local models are saved and loaded from</div>
                    </div>
                  </div>
                  
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <input 
                      type="text" 
                      value={modelsPath} 
                      onChange={(e) => setModelsPath(e.target.value)}
                      placeholder="e.g. D:\AI_Models"
                      style={{ flex: 1, background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 12px', color: '#fff', fontSize: '13px', outline: 'none' }}
                    />
                    <button 
                      onClick={handleBrowseFolder}
                      style={{ padding: '0 16px', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontSize: '12px', fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                    >
                      Browse
                    </button>
                    <button 
                      onClick={handleUpdatePath}
                      disabled={isUpdatingPath || !modelsPath}
                      style={{ padding: '0 16px', borderRadius: '8px', background: 'rgba(var(--matrix-primary-rgb),0.1)', color: 'var(--matrix-primary)', border: '1px solid rgba(var(--matrix-primary-rgb),0.2)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s' }}
                    >
                      {isUpdatingPath ? 'Moving...' : 'Move & Update'}
                    </button>
                  </div>
                  <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.2)', fontStyle: 'italic' }}>
                    Note: Shifting models may take a few seconds depending on file sizes.
                  </div>
                </div>

                <div style={{ padding: '14px 16px', background: 'rgba(var(--matrix-primary-rgb),0.05)', border: '1px solid rgba(var(--matrix-primary-rgb),0.1)', borderRadius: '12px', display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <Info size={18} color="var(--matrix-primary)" />
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', lineHeight: 1.4 }}>
                    The <b>Default Engine</b> is the model Matrix will automatically load when starting a new session.
                  </div>
                </div>

                <div style={{ display: 'flex', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '4px', gap: '4px' }}>
                  {[{ id: 'online', label: 'Groq Cloud', icon: Globe, color: '#3b82f6' }, { id: 'local', label: 'Local (Native)', icon: HardDrive, color: 'var(--matrix-primary)' }].map(({ id, label, icon: Icon, color }) => (
                    <button key={id} onClick={() => setEngineMode(id)}
                      style={{
                        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '10px', borderRadius: '9px', border: 'none', cursor: 'pointer', transition: 'all 0.2s', fontWeight: 600, fontSize: '13px',
                        background: engineMode === id ? `${color}18` : 'transparent',
                        color: engineMode === id ? color : 'rgba(255,255,255,0.35)',
                      }}>
                      <Icon size={15} />{label}
                    </button>
                  ))}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  {availableModels[engineMode] && Object.entries(availableModels[engineMode]).map(([id, model]) => {
                    let liveStatus = model.status;
                    if (engineMode === 'local') {
                      const totalRam = telemetry?.ram_total_gb || 16;
                      const budget = (totalRam * resources.max_ram_percent) / 100;
                      const min_ram = model.min_ram_gb || model.ram_gb;
                      if (min_ram <= budget * 0.75) liveStatus = 'recommended';
                      else if (min_ram <= budget) liveStatus = 'ok';
                      else liveStatus = 'disabled';
                    }
                    const isDisabled = engineMode === 'local' && liveStatus === 'disabled';
                    const isSelected = selectedModel === id;
                    const isDefault = appearance.default_model === id;
                    const tagColor = liveStatus === 'recommended' ? 'var(--matrix-primary)' : liveStatus === 'ok' ? '#f59e0b' : '#ef4444';
                    return (
                      <div key={id} onClick={() => !isDisabled && setSelectedModel(id)}
                        style={{
                          padding: '14px 16px', borderRadius: '12px', cursor: isDisabled ? 'not-allowed' : 'pointer',
                          opacity: isDisabled ? 0.4 : 1,
                          background: isSelected ? 'rgba(var(--matrix-primary-rgb),0.05)' : 'rgba(255,255,255,0.02)',
                          border: isSelected ? '1px solid rgba(var(--matrix-primary-rgb),0.3)' : isDefault ? '1px solid rgba(255,255,255,0.15)' : '1px solid rgba(255,255,255,0.07)',
                          transition: 'all 0.2s', position: 'relative'
                        }}
                      >
                        {engineMode === 'local' && model.file_exists && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setDeletingModel({ id, name: model.name, size: model.size }); }}
                            style={{ position: 'absolute', top: '8px', right: '8px', width: '24px', height: '24px', borderRadius: '6px', background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                          ><Trash2 size={12} /></button>
                        )}
                        <div style={{ marginBottom: '10px' }}>
                          <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>{model.name}</div>
                          {isDefault && <div style={{ fontSize: '9px', fontWeight: 800, color: 'var(--matrix-primary)', textTransform: 'uppercase', marginTop: '2px' }}>Default</div>}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)' }}>{model.params}</span>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            {!isDefault && !isDisabled && (
                              <button onClick={(e) => { e.stopPropagation(); handleSetDefault(id); }}
                                style={{ fontSize: '10px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.5)', padding: '2px 6px', borderRadius: '4px', cursor: 'pointer' }}>Set Default</button>
                            )}
                            {engineMode === 'local' && <span style={{ fontSize: '10px', color: tagColor }}>{model.ram_gb}GB</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ──── BACKUP TAB ──── */}
            {activeTab === 'backup' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                <div>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: '#fff', marginBottom: '4px' }}>Backup & Synchronization</div>
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.3)' }}>Secure your conversations and system settings</div>
                </div>

                {/* Local Backup Section */}
                <div style={{ padding: '24px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(var(--matrix-primary-rgb),0.1)', color: 'var(--matrix-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <HardDrive size={18} />
                    </div>
                    <div>
                      <div style={{ fontSize: '15px', fontWeight: 600, color: '#fff' }}>Local Data Backup</div>
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)' }}>Export your database to a JSON file or restore from a previous one.</div>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <button 
                      onClick={handleExport}
                      disabled={isExporting}
                      style={{ padding: '12px', borderRadius: '12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', transition: 'all 0.2s' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                    >
                      {isExporting ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} 
                      {isExporting ? 'Exporting...' : 'Export to JSON'}
                    </button>
                    
                    <div style={{ position: 'relative' }}>
                      <input 
                        type="file" 
                        accept=".json" 
                        onChange={handleImport} 
                        id="import-json" 
                        style={{ display: 'none' }} 
                      />
                      <button 
                        onClick={() => document.getElementById('import-json').click()}
                        disabled={isImporting}
                        style={{ width: '100%', padding: '12px', borderRadius: '12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', transition: 'all 0.2s' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                      >
                        {isImporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} 
                        {isImporting ? 'Importing...' : 'Import from JSON'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Cloud Backup Section */}
                <div style={{ padding: '24px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(59,130,246,0.1)', color: '#3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Cloud size={18} />
                    </div>
                    <div>
                      <div style={{ fontSize: '15px', fontWeight: 600, color: '#fff' }}>Cloud Synchronization</div>
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)' }}>Sync your data across devices using Google Drive.</div>
                    </div>
                  </div>

                  <div style={{ padding: '16px', background: 'rgba(59,130,246,0.03)', border: '1px solid rgba(59,130,246,0.1)', borderRadius: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{ 
                        width: '8px', height: '8px', borderRadius: '50%', 
                        background: driveStatus === "not_connected" ? 'rgba(239,68,68,0.8)' : 'rgba(34,197,94,0.8)',
                        boxShadow: driveStatus !== "not_connected" ? '0 0 10px rgba(34,197,94,0.5)' : 'none'
                      }} />
                      <div>
                        <div style={{ fontSize: '13px', color: driveStatus === "not_connected" ? 'rgba(255,255,255,0.5)' : '#fff', fontWeight: 500 }}>
                          {driveStatus === "not_connected" ? "Not Connected" : "Connected"}
                        </div>
                        {driveStatus === "backup_exists" && lastBackup && (
                          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>Last backup: {lastBackup}</div>
                        )}
                        {driveStatus === "connected_no_backup" && (
                          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>Ready for first backup</div>
                        )}
                      </div>
                    </div>
                    
                    {driveStatus === "not_connected" ? (
                      <button 
                        onClick={handleConnectDrive}
                        disabled={isDriveWorking}
                        style={{ padding: '8px 16px', borderRadius: '8px', background: '#3b82f6', color: '#fff', border: 'none', fontSize: '12px', fontWeight: 700, cursor: isDriveWorking ? 'wait' : 'pointer', transition: 'all 0.2s', boxShadow: '0 4px 12px rgba(59,130,246,0.3)', opacity: isDriveWorking ? 0.7 : 1 }}
                        onMouseEnter={e => { if(!isDriveWorking) e.currentTarget.style.transform = 'translateY(-1px)'}}
                        onMouseLeave={e => { if(!isDriveWorking) e.currentTarget.style.transform = 'translateY(0)'}}
                      >
                        {isDriveWorking ? "Connecting..." : "Connect Google Drive"}
                      </button>
                    ) : (
                      <button 
                        onClick={handleBackupDrive}
                        disabled={isDriveWorking}
                        style={{ padding: '8px 16px', borderRadius: '8px', background: 'var(--matrix-primary)', color: '#000', border: 'none', fontSize: '12px', fontWeight: 700, cursor: isDriveWorking ? 'wait' : 'pointer', transition: 'all 0.2s', boxShadow: '0 4px 12px rgba(0,210,106,0.3)', opacity: isDriveWorking ? 0.7 : 1 }}
                        onMouseEnter={e => { if(!isDriveWorking) e.currentTarget.style.transform = 'translateY(-1px)'}}
                        onMouseLeave={e => { if(!isDriveWorking) e.currentTarget.style.transform = 'translateY(0)'}}
                      >
                        {isDriveWorking ? "Working..." : (driveStatus === "backup_exists" ? "Update Backup" : "Take Backup")}
                      </button>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '0 4px' }}>
                    <div style={{ width: '16px', height: '16px', borderRadius: '4px', background: 'rgba(var(--matrix-primary-rgb),0.1)', color: 'var(--matrix-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Shield size={10} />
                    </div>
                    <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)', fontStyle: 'italic' }}>
                      End-to-end encrypted: Only you can access your cloud data.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ──── UPDATES TAB ──── */}
            {activeTab === 'updates' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                <div>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: '#fff', marginBottom: '4px' }}>System Updates</div>
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.3)' }}>Ensure your Matrix Kova terminal is running the latest neural sequences</div>
                </div>

                <div style={{ padding: '24px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(var(--matrix-primary-rgb),0.1)', color: 'var(--matrix-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Cpu size={20} />
                      </div>
                      <div>
                        <div style={{ fontSize: '15px', fontWeight: 600, color: '#fff' }}>Current Build</div>
                        <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', fontMono: 'monospace' }}>Version v{version}</div>
                      </div>
                    </div>

                    <button 
                      onClick={handleCheckUpdate}
                      disabled={isCheckingUpdate}
                      style={{ padding: '8px 16px', borderRadius: '8px', background: 'rgba(var(--matrix-primary-rgb),0.1)', color: 'var(--matrix-primary)', border: '1px solid rgba(var(--matrix-primary-rgb),0.2)', fontSize: '12px', fontWeight: 700, cursor: 'pointer', transition: 'all 0.2s', display: 'flex', alignItems: 'center', gap: '8px' }}
                    >
                      {isCheckingUpdate ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                      {isCheckingUpdate ? 'Scanning...' : 'Check for Updates'}
                    </button>
                  </div>

                  {updateStatus === 'latest' && (
                    <div style={{ padding: '12px 16px', borderRadius: '12px', background: 'rgba(var(--matrix-primary-rgb),0.05)', border: '1px solid rgba(var(--matrix-primary-rgb),0.1)', color: 'var(--matrix-primary)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Check size={16} />
                      Your system is up to date.
                    </div>
                  )}

                  {updateStatus === 'available' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <div style={{ padding: '12px 16px', borderRadius: '12px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#3b82f6', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <Download size={16} className="animate-bounce" />
                        Version {updateInfo.version} is available.
                      </div>
                      <button 
                        onClick={handleTriggerUpdate}
                        style={{ width: '100%', padding: '12px', borderRadius: '12px', background: '#3b82f6', color: '#fff', border: 'none', fontSize: '13px', fontWeight: 700, cursor: 'pointer', boxShadow: '0 4px 12px rgba(59,130,246,0.3)' }}
                      >
                        Install Update Now
                      </button>
                    </div>
                  )}
                </div>

                {updateInfo && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '1px' }}>Transmission Logs</div>
                    <div style={{ padding: '20px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', fontSize: '13px', color: 'rgba(255,255,255,0.6)', lineHeight: 1.6, maxHeight: '180px', overflowY: 'auto' }}>
                      {updateInfo.release_notes || "Performance optimizations and stability improvements."}
                    </div>
                  </div>
                )}
              </div>
            )}


            {/* ──── ABOUT TAB ──── */}

            {activeTab === 'about' && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '16px', textAlign: 'center' }}>
                <div style={{ fontSize: '36px', fontWeight: 900, color: 'var(--matrix-primary)', letterSpacing: '8px' }}>MATRIX KOVA</div>
                <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.2)', letterSpacing: '4px', textTransform: 'uppercase' }}>Personal AI Interface</div>
                <div style={{ padding: '6px 16px', borderRadius: '20px', background: 'rgba(var(--matrix-primary-rgb),0.08)', fontSize: '12px', fontWeight: 700, color: 'var(--matrix-primary)' }}>Version {version}</div>
                <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.4)', maxWidth: '340px', lineHeight: 1.7, marginTop: '8px' }}>
                  A clean, private workspace to chat with AI models, designed to be simple and out of your way.
                </p>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.2)', marginTop: '24px' }}>
                  &copy; {new Date().getFullYear()} Matrix Kova. All rights reserved.
                </div>
              </div>
            )}
          </div>

          {/* ── Footer Actions ── */}
          <div style={{ padding: '16px 36px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'flex-end', gap: '10px', flexShrink: 0, background: '#0e0e10' }}>
            <button onClick={onClose}
              style={{ height: '38px', padding: '0 20px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: 'rgba(255,255,255,0.5)', fontSize: '13px', fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#fff'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.5)'; }}
            >Discard</button>
            <button onClick={handleSave} disabled={isSaving || saveSuccess}
              style={{
                height: '38px', padding: '0 24px', borderRadius: '10px', border: 'none', fontSize: '13px', fontWeight: 700, cursor: isSaving || saveSuccess ? 'not-allowed' : 'pointer', transition: 'all 0.3s', display: 'flex', alignItems: 'center', gap: '8px', minWidth: '130px', justifyContent: 'center',
                background: saveSuccess ? '#22c55e' : 'var(--matrix-primary)',
                color: '#000',
                boxShadow: saveSuccess ? '0 0 20px rgba(34,197,94,0.4)' : '0 4px 16px rgba(var(--matrix-primary-rgb),0.25)',
              }}
            >
              {isSaving ? <><Loader2 size={14} className="animate-spin" /> Saving...</>
                : saveSuccess ? <><Check size={14} /> Saved!</>
                  : 'Apply Changes'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

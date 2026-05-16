"use client";
import React, { useState, useEffect, useCallback } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X, User, LogIn, LogOut, ShieldCheck, Mail, Key, Loader2, RefreshCw } from 'lucide-react';

const API_BASE = typeof window !== 'undefined'
  ? `http://127.0.0.1:${window.MATRIX_BACKEND_PORT || 8000}`
  : 'http://127.0.0.1:8000';

const MIDDLEMAN_LOGIN_URL = 'https://matrixx-forge.vercel.app/login';

function Modal({ open, onClose, children }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onClose}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(16px)', zIndex: 600 }}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            zIndex: 601, outline: 'none',
            width: '440px', maxWidth: '90vw',
            background: '#0a0a0b', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '24px', boxShadow: '0 40px 100px rgba(0,0,0,0.8)',
            overflow: 'hidden'
          }}
        >
          <DialogPrimitive.Title className="sr-only">Matrix Account</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export default function AccountModal({ isOpen, onClose }) {
  const [user, setUser] = useState(null);
  const [isPolling, setIsPolling] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  // Check current auth status from Python backend
  const checkAuthStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/status`);
      const data = await res.json();
      if (data.logged_in && data.user) {
        setUser(data.user);
        setIsPolling(false); // stop polling once logged in
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  // On open, check if already logged in
  useEffect(() => {
    if (isOpen) {
      checkAuthStatus();
    }
  }, [isOpen, checkAuthStatus]);

  // Continuously refresh user profile while modal is open (picks up background-synced photo_url)
  useEffect(() => {
    if (!isOpen || isPolling) return; // don't interfere with login polling
    const refreshInterval = setInterval(() => {
      checkAuthStatus();
    }, 30000); // refresh every 30s
    return () => clearInterval(refreshInterval);
  }, [isOpen, isPolling, checkAuthStatus]);

  // Poll every 2 seconds while waiting for browser login to complete
  useEffect(() => {
    if (!isPolling) return;
    const interval = setInterval(async () => {
      const loggedIn = await checkAuthStatus();
      if (loggedIn) clearInterval(interval);
    }, 2000);
    return () => clearInterval(interval);
  }, [isPolling, checkAuthStatus]);

  const handleLogin = async () => {
    setIsPolling(true); // show spinner immediately
    try {
      const res = await fetch(`${API_BASE}/auth/login-url`);
      const data = await res.json();
      if (data.login_url) {
        window.open(data.login_url, '_blank');
      } else {
        setIsPolling(false);
      }
    } catch {
      setIsPolling(false);
    }
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await fetch(`${API_BASE}/auth/logout`, { method: 'POST' });
      setUser(null);
    } catch {}
    setIsLoggingOut(false);
  };

  return (
    <Modal open={isOpen} onClose={onClose}>
      {/* Header */}
      <div style={{ padding: '24px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(0,210,106,0.1)', color: '#00d26a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <User size={18} />
          </div>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, color: '#fff' }}>Matrix Account</div>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '1px' }}>Single Sign-On</div>
          </div>
        </div>
        <button onClick={onClose}
          style={{ width: '32px', height: '32px', borderRadius: '8px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; }}
        >
          <X size={16} />
        </button>
      </div>

      <div style={{ padding: '32px' }}>
        {!user ? (
          /* ── LOGGED OUT STATE ── */
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
            <div style={{ width: '80px', height: '80px', borderRadius: '24px', background: 'rgba(0,210,106,0.05)', border: '1px solid rgba(0,210,106,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px', boxShadow: '0 0 40px rgba(0,210,106,0.1)' }}>
              {isPolling
                ? <Loader2 size={36} color="#00d26a" className="animate-spin" />
                : <ShieldCheck size={36} color="#00d26a" />
              }
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: '#fff', marginBottom: '8px' }}>
              {isPolling ? 'Waiting for Login...' : 'Secure Matrix Access'}
            </div>
            <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.4)', lineHeight: 1.6, marginBottom: '32px' }}>
              {isPolling
                ? 'Complete the login in your browser. This window will update automatically.'
                : 'Connect your Matrix Desktop client with your Web Account to sync settings and history.'}
            </p>
            {!isPolling && (
              <button onClick={handleLogin}
                style={{ width: '100%', height: '48px', borderRadius: '12px', border: 'none', background: '#00d26a', color: '#000', fontSize: '14px', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', boxShadow: '0 8px 24px rgba(0,210,106,0.25)', transition: 'all 0.2s' }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 12px 32px rgba(0,210,106,0.35)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,210,106,0.25)'; }}
              >
                <LogIn size={18} strokeWidth={2.5} />
                Login with Web Account
              </button>
            )}
            {isPolling && (
              <button onClick={() => setIsPolling(false)}
                style={{ marginTop: '12px', height: '40px', padding: '0 24px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: 'rgba(255,255,255,0.4)', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
              >
                Cancel
              </button>
            )}
            {!isPolling && (
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.2)', marginTop: '16px' }}>
                Opens your browser for secure SSO authentication.
              </div>
            )}
          </div>
        ) : (
          /* ── LOGGED IN STATE ── */
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '20px', marginBottom: '32px' }}>
              <div style={{ width: '72px', height: '72px', borderRadius: '20px', background: 'rgba(0,210,106,0.08)', border: '1px solid rgba(0,210,106,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                {user.photo_url ? (
                  <img src={user.photo_url} alt={user.name} referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <User size={32} color="#00d26a" />
                )}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '20px', fontWeight: 800, color: '#fff', marginBottom: '4px' }}>{user.name}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'rgba(255,255,255,0.4)' }}>
                  <Mail size={12} /> {user.email}
                </div>
              </div>
              <button
                onClick={checkAuthStatus}
                title="Refresh profile"
                style={{ width: '32px', height: '32px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s', flexShrink: 0 }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.3)'; }}
              >
                <RefreshCw size={13} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '32px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Key size={16} color="rgba(255,255,255,0.4)" />
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>Access Token</div>
                    <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', marginTop: '2px', fontFamily: 'monospace' }}>UID: {user.uid?.slice(0, 12)}...</div>
                  </div>
                </div>
                <div style={{ fontSize: '10px', fontWeight: 700, padding: '4px 10px', borderRadius: '12px', background: 'rgba(0,210,106,0.1)', color: '#00d26a', textTransform: 'uppercase', letterSpacing: '1px' }}>
                  Active
                </div>
              </div>
            </div>

            <button onClick={handleLogout} disabled={isLoggingOut}
              style={{ width: '100%', height: '48px', borderRadius: '12px', border: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.05)', color: '#ef4444', fontSize: '14px', fontWeight: 700, cursor: isLoggingOut ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', transition: 'all 0.2s' }}
              onMouseEnter={e => { if (!isLoggingOut) e.currentTarget.style.background = 'rgba(239,68,68,0.1)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.05)'; }}
            >
              {isLoggingOut ? <Loader2 size={16} className="animate-spin" /> : <LogOut size={16} strokeWidth={2.5} />}
              {isLoggingOut ? 'Signing Out...' : 'Sign Out'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

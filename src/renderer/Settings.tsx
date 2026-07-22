import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { getThemePref, setThemePref, type ThemePref } from "./theme.ts";
import { signOut, useAuth } from "./auth.ts";
import { DeviceFlowPanel } from "./SignIn.tsx";
import { ProviderConfigSection } from "./ProjectSettings.tsx";
import { Icon } from "./icons.tsx";

/**
 * App-level settings (ADR-0006): a full-window surface with its own left
 * sidebar, sibling of Shell — the URL is the section (#/settings/general).
 */
export function SettingsShell() {
  const navigate = useNavigate();
  return (
    <div className="settings">
      <nav className="settings-nav">
        <button type="button" className="btn btn-ghost settings-back" onClick={() => navigate("/")}>
          <Icon name="chevron-left" size={14} /> Back to app
        </button>
        <div className="settings-nav-group dim">Account</div>
        <NavLink to="general" className="settings-navlink">
          General
        </NavLink>
        <NavLink to="connections" className="settings-navlink">
          Connections
        </NavLink>
        <div className="settings-nav-group dim">Workspace</div>
        <NavLink to="providers" className="settings-navlink">
          Providers
        </NavLink>
      </nav>
      <main className="settings-content">
        <Outlet />
      </main>
    </div>
  );
}

const THEME_LABELS: Record<ThemePref, string> = {
  system: "Auto",
  light: "Light",
  dark: "Dark",
};

/** Segmented theme control; theme.ts stays the single persistence path. */
function ThemePicker() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  return (
    <div className="settings-segmented" role="radiogroup" aria-label="Color scheme">
      {(Object.keys(THEME_LABELS) as ThemePref[]).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={pref === option}
          className={pref === option ? "active" : undefined}
          onClick={() => {
            setThemePref(option);
            setPref(option);
          }}
        >
          {THEME_LABELS[option]}
        </button>
      ))}
    </div>
  );
}

export function SettingsGeneral() {
  const { user, refresh } = useAuth();
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="settings-card">
      <h3>General</h3>
      {user && (
        <div className="settings-profile">
          {user.avatarUrl && <img className="settings-avatar" src={user.avatarUrl} alt="" />}
          <div>
            <div className="settings-profile-name">{user.name ?? user.login}</div>
            <div className="dim">@{user.login}</div>
            {user.email && <div className="dim">{user.email}</div>}
          </div>
        </div>
      )}
      <div className="settings-row">
        <div>
          <div className="settings-row-title">Theme</div>
          <div className="dim">Follows the system, or pin light/dark.</div>
        </div>
        <ThemePicker />
      </div>
      <div className="settings-row">
        <div>
          <div className="settings-row-title">Sign out</div>
          <div className="dim">Removes the stored GitHub token from this machine.</div>
        </div>
        {confirming ? (
          <span className="settings-actions">
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void signOut().then(() => refresh())}
            >
              Confirm sign out
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Keep me signed in
            </button>
          </span>
        ) : (
          <button type="button" className="btn" onClick={() => setConfirming(true)}>
            Sign out
          </button>
        )}
      </div>
    </section>
  );
}

export function SettingsConnections() {
  const { user, refresh } = useAuth();
  return (
    <section className="settings-card">
      <h3>Connections</h3>
      <div className="settings-row">
        <div>
          <div className="settings-row-title">GitHub</div>
          {user ? (
            <div className="dim">
              Connected as @{user.login} — identity only; repo operations use the{" "}
              <code>gh</code> CLI.
            </div>
          ) : (
            <div className="dim">Not connected.</div>
          )}
        </div>
        {user ? (
          <button type="button" className="btn" onClick={() => void signOut().then(() => refresh())}>
            Disconnect
          </button>
        ) : (
          <DeviceFlowPanel onAuthorized={() => void refresh()} />
        )}
      </div>
    </section>
  );
}

export function SettingsProviders() {
  return (
    <section className="settings-card">
      <ProviderConfigSection />
    </section>
  );
}

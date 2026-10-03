// Canvas Pro-Tools — popup.js

const STORAGE_KEY  = 'cpt_review_data';
const FEATURES_KEY = 'cpt_features';
const LINKS_KEY    = 'cpt_admin_links';
const MAPPINGS_KEY = 'cpt_checkpoint_mappings';

// Single source of truth for the version string. Read from the manifest so
// export payloads, the header label, and the About tab can never drift apart
// the way the hand-maintained strings did (tracker said 3.6.6, links/mappings/
// settings said 3.6.5, per-course said 2.0, About said 3.7.1, manifest said
// 3.8.0). Declared at the top because the export handlers below reference it;
// const is not hoisted, so a later declaration would be a TDZ error waiting
// for the first non-callback caller.
const EXT_VERSION = chrome.runtime.getManifest().version;

// Feature definitions — id must match checkbox id (feature-{id}) and
// the key content scripts will check in chrome.storage.local
//
// `default` applies only when a feature has never been toggled on this Canvas
// instance (see getFeatures). It is NOT the single source of truth: each
// content script carries its own fallback for the case where it runs before
// the popup has ever been opened, and feature-flags.js carries a third copy
// for the MAIN-world scripts. All copies must agree or the popup will show a
// state the page does not honour. Sites, per feature:
//   reviewTracker    — feature-flags.js, gradebook-tracker.js, speedgrader.js
//   adminCourseLinks — feature-flags.js, admin-course-links.js
//   userEnrollments  — user-enrollments.js  (absent from feature-flags.js;
//                      that script reads chrome.storage directly)
//   sgAvatarZoom     — feature-flags.js, sg-avatar-zoom.js
//   checkpointMapper — feature-flags.js, checkpoint-mapper.js,
//                      rubric-checkpoint-mapper.js
//
// Defaults are opt-in for anything that doesn't earn its place immediately.
// A feature ships ON only if it helps a rank-and-file instructor the moment
// they hit the page, with no setup. Three reasons a feature ships OFF:
//   - Admin audience. Most users are not admins, so admin-facing features
//     would be noise on pages they never visit. (adminCourseLinks,
//     userEnrollments — the "Dean / Admin" group in the Tools tab.)
//   - Needs configuration first. Does nothing useful until the user enables a
//     course or maps criteria, so shipping it on just adds UI with no payoff.
//     (reviewTracker, checkpointMapper.)
//   - Cosmetic preference, not a problem being solved. (sgAvatarZoom.)
// Everything ON works on sight and answers a question the user already had.
const FEATURES = [
    { id: 'reviewTracker',    default: false },
    { id: 'whatIfGrades',     default: true  },
    { id: 'quizNav',          default: true  },
    { id: 'rubricPlus',       default: true  },
    { id: 'assignmentDetails', default: true },
    { id: 'sgAvatarZoom',     default: false },
    { id: 'sgGradedAt',       default: true  },
    { id: 'adminCourseLinks', default: false },
    { id: 'userEnrollments',  default: false },
    { id: 'checkpointMapper', default: false },
];

const BUILTIN_LINKS = [
    { id: 'assignments',       path: 'assignments',          label: 'Assignments',   enabled: true  },
    { id: 'modules',           path: 'modules',              label: 'Modules',       enabled: true  },
    { id: 'users',             path: 'users',                label: 'People',        enabled: true  },
    { id: 'grades',            path: 'grades',               label: 'Grades',        enabled: true  },
    { id: 'files',             path: 'files',                label: 'Files',         enabled: true  },
    { id: 'syllabus',          path: 'assignments/syllabus', label: 'Syllabus',      enabled: true  },
    { id: 'settings',          path: 'settings',             label: 'Settings',      enabled: false },
    { id: 'announcements',     path: 'announcements',        label: 'Announcements', enabled: false },
    { id: 'discussion_topics', path: 'discussion_topics',    label: 'Discussions',   enabled: false },
    { id: 'outcomes',          path: 'outcomes',             label: 'Outcomes',      enabled: false },
    { id: 'pages',             path: 'pages',                label: 'Pages',         enabled: false },
    { id: 'quizzes',           path: 'quizzes',              label: 'Quizzes',       enabled: false },
];

const DEFAULT_STATES = {
    NONE:     { emoji: '',   label: 'Not tracked',  color: null },
    PENDING:  { emoji: '🟡', label: 'Needs Review', color: null },
    FLAGGED:  { emoji: '🔴', label: 'Needs Action', color: null },
    REVIEWED: { emoji: '✅', label: 'Reviewed',     color: null },
};
const DEFAULT_CYCLE    = ['NONE', 'PENDING', 'FLAGGED', 'REVIEWED'];
const MAX_CUSTOM_STATES = 4;

// ── Safe SVG dot icon builder ────────────────────────────────────────────────
// Builds the colored dot indicator via createElementNS instead of an
// innerHTML template string — attribute values set with setAttribute can
// never break out into markup, regardless of where the color came from.

const SVG_NS = 'http://www.w3.org/2000/svg';

function buildDotIcon(color, size = 12) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width',  size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.style.cssText = 'display:inline-block;vertical-align:middle;';

    const circle = document.createElementNS(SVG_NS, 'circle');
    const c = size / 2;
    circle.setAttribute('cx', c);
    circle.setAttribute('cy', c);
    circle.setAttribute('r',  c - 1.5);
    circle.setAttribute('fill', String(color));
    svg.appendChild(circle);
    return svg;
}

// ── Storage helpers ──────────────────────────────────────────────────────────
//
// cpt_review_data, cpt_admin_links, and cpt_checkpoint_mappings are namespaced
// per Canvas instance (hostname):
//   { "<hostname>": { ...per-instance data... }, "<other-hostname>": {...} }
//
// CURRENT_INSTANCE holds the hostname this popup session operates on. It is
// resolved once at startup (see resolveInstance below) — either from the
// active tab's URL (if it's a Canvas page) or from a user selection in the
// instance selector dropdown (if not).

const HOSTNAME_RE = /^[a-zA-Z0-9.\-]{1,253}$/;

let CURRENT_INSTANCE = null;

// Returns true if `hostname` looks like a Canvas instance (instructure.com
// subdomain, or any custom domain — we can't validate custom domains, so any
// non-empty hostname from a Canvas-shaped URL is accepted).
function isCanvasUrl(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:') return false;
        // *.instructure.com is always Canvas. For custom/self-hosted domains
        // we can't be certain from the URL alone, so we only auto-detect
        // instructure.com here; everything else falls through to the
        // dropdown (where it will appear if it has stored data, or the user
        // can rely on instructure.com auto-detection on their own campus).
        return /\.instructure\.com$/i.test(u.hostname);
    } catch {
        return false;
    }
}

// Collects every hostname namespace that has stored data across the three
// namespaced storage keys.
function getKnownInstances(cb) {
    chrome.storage.local.get([STORAGE_KEY, LINKS_KEY, MAPPINGS_KEY, FEATURES_KEY], result => {
        const set = new Set();
        [STORAGE_KEY, LINKS_KEY, MAPPINGS_KEY, FEATURES_KEY].forEach(key => {
            const obj = result[key] || {};
            Object.keys(obj).forEach(k => {
                if (HOSTNAME_RE.test(k) && k.includes('.')) set.add(k);
            });
        });
        cb(Array.from(set).sort());
    });
}

// Returns true if `obj` looks like the OLD flat (pre-namespacing) shape for
// cpt_review_data: top-level keys are tracker fields, not hostnames.
function looksLegacyTracker(obj) {
    const LEGACY_KEYS = ['globalEnabled', 'courses', 'reviews', 'customStates', 'customCycle', 'hints'];
    return LEGACY_KEYS.some(k => k in obj);
}

// Returns true if `obj` looks like the OLD flat shape for cpt_admin_links:
// order/links/custom directly at the top level, not under a hostname.
function looksLegacyLinks(obj) {
    return Array.isArray(obj.order) || Array.isArray(obj.links) || Array.isArray(obj.custom);
}

// Returns true if `obj` looks like the OLD flat shape for
// cpt_checkpoint_mappings: top-level keys are rubric IDs whose values have
// a `.criteria` property, rather than hostname keys.
function looksLegacyMappings(obj) {
    return Object.keys(obj).some(k => {
        const v = obj[k];
        return v && typeof v === 'object' && v.criteria;
    });
}

// Returns true if `obj` looks like the OLD flat shape for cpt_features:
// top-level values are booleans (feature toggles), rather than hostname
// keys mapping to objects. Feature IDs never contain a dot; hostnames do.
function looksLegacyFeatures(obj) {
    return Object.keys(obj).some(k => typeof obj[k] === 'boolean');
}

// One-time migration: if any of the three namespaced storage keys still has
// data in the old flat (pre-3.6.4) shape, wrap it under `targetHost`. Safe
// to call on every popup open — it's a no-op once migrated. This is the
// single guaranteed migration point (the popup is opened by every user),
// rather than relying on which content script happens to load first.
function migrateLegacyStorage(targetHost, cb) {
    chrome.storage.local.get([STORAGE_KEY, LINKS_KEY, MAPPINGS_KEY, FEATURES_KEY], result => {
        const updates = {};

        const tracker = result[STORAGE_KEY] || {};
        if (looksLegacyTracker(tracker)) {
            updates[STORAGE_KEY] = { [targetHost]: tracker };
        }

        const links = result[LINKS_KEY] || {};
        if (looksLegacyLinks(links)) {
            updates[LINKS_KEY] = { [targetHost]: links };
        }

        const mappings = result[MAPPINGS_KEY] || {};
        if (looksLegacyMappings(mappings)) {
            updates[MAPPINGS_KEY] = { [targetHost]: mappings };
        }

        const features = result[FEATURES_KEY] || {};
        if (looksLegacyFeatures(features)) {
            updates[FEATURES_KEY] = { [targetHost]: features };
        }

        if (Object.keys(updates).length === 0) { cb(); return; }
        chrome.storage.local.set(updates, cb);
    });
}

// Resolves CURRENT_INSTANCE, then calls `cb`. If the active tab is a
// recognized Canvas page, uses its hostname directly. Otherwise shows the
// instance selector dropdown populated from known namespaces and waits for
// the user to pick one.
function resolveInstance(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const tab = tabs && tabs[0];
        const url = tab && tab.url;

        if (url && isCanvasUrl(url)) {
            const host = new URL(url).hostname;
            migrateLegacyStorage(host, () => {
                CURRENT_INSTANCE = host;
                cb();
            });
            return;
        }

        // Active tab isn't a recognized Canvas page. We may still be able to
        // migrate, but only to a hostname we know is a real Canvas instance.
        //
        // The only trustworthy source here is a hostname already present as a
        // namespace key in cpt_review_data, written by a content script that
        // by definition only runs on Canvas. The active tab's hostname is NOT
        // an acceptable substitute: this branch is reached precisely because
        // the tab is not recognized as Canvas, so it could be any site the
        // user happens to have focused. Opening the popup from a mail tab
        // once used to wrap every legacy record under that mail hostname.
        //
        // Migration rewrites stored data in place and is one-way, with no
        // repair path, so an unattributable migration is worse than no
        // migration. When there is no known host, leave the legacy shape
        // untouched: migrateLegacyStorage is a no-op once migrated and safe to
        // call repeatedly, so the next popup open on an actual Canvas tab
        // performs it correctly.
        chrome.storage.local.get(STORAGE_KEY, trackerResult => {
            const tracker = trackerResult[STORAGE_KEY] || {};
            const knownHost = Object.keys(tracker).find(k => HOSTNAME_RE.test(k) && k.includes('.'));

            const afterMigration = () => resolveInstanceDropdown(url, cb);
            if (knownHost) {
                migrateLegacyStorage(knownHost, afterMigration);
            } else {
                afterMigration();
            }
        });
    });
}

// Shows the instance selector dropdown populated from known namespaces, or
// falls back to a single implicit instance if none exist yet.
function resolveInstanceDropdown(url, cb) {
    getKnownInstances(instances => {
        const bar      = document.getElementById('instanceBar');
        const selector = document.getElementById('instanceSelector');

        if (instances.length === 0) {
            // No stored data anywhere yet. Fall back to the active tab's
            // hostname if it has one (covers custom Canvas domains the
            // user is currently on but that we couldn't confirm), else a
            // placeholder. Either way there's nothing to pick from.
            //
            // Note this deliberately differs from the migration path above,
            // which refuses an unconfirmed hostname. The two cases are not
            // equivalent: migration REWRITES existing records under a new key
            // and cannot be undone, whereas this only decides where NEW data
            // will be filed. A wrong guess here is visible in the instance
            // dropdown on the next open and can be cleared from the Data tab,
            // and guessing is what makes a self-hosted Canvas domain usable
            // at all. Certainty is required to move a user's data; it is not
            // required to choose a label for data that does not exist yet.
            CURRENT_INSTANCE = (url && (() => { try { return new URL(url).hostname; } catch { return null; } })())
                || 'unknown';
            cb();
            return;
        }

        bar.style.display = 'flex';
        selector.innerHTML = '';
        instances.forEach(host => {
            const opt = document.createElement('option');
            opt.value = host;
            opt.textContent = host;
            selector.appendChild(opt);
        });

        CURRENT_INSTANCE = instances[0];
        selector.value = CURRENT_INSTANCE;

        selector.addEventListener('change', () => {
            CURRENT_INSTANCE = selector.value;
            refreshAll();
        });

        cb();
    });
}

// Re-renders everything after the instance selection changes.
function refreshAll() {
    renderFeatures();
    renderAll();
    applyDataSectionVisibility();
}

function getData(cb) {
    chrome.storage.local.get(STORAGE_KEY, result => {
        const all = result[STORAGE_KEY] || {};
        cb(all[CURRENT_INSTANCE] || {});
    });
}

function setData(data, cb) {
    chrome.storage.local.get(STORAGE_KEY, result => {
        const all = result[STORAGE_KEY] || {};
        all[CURRENT_INSTANCE] = data;
        chrome.storage.local.set({ [STORAGE_KEY]: all }, cb);
    });
}

function getFeatures(cb) {
    chrome.storage.local.get(FEATURES_KEY, result => {
        const all   = result[FEATURES_KEY] || {};
        const saved = all[CURRENT_INSTANCE] || {};
        const features = {};
        FEATURES.forEach(f => {
            features[f.id] = typeof saved[f.id] === 'boolean' ? saved[f.id] : f.default;
        });
        cb(features);
    });
}

function setFeatures(features, cb) {
    chrome.storage.local.get(FEATURES_KEY, result => {
        const all = result[FEATURES_KEY] || {};
        all[CURRENT_INSTANCE] = features;
        chrome.storage.local.set({ [FEATURES_KEY]: all }, cb);
    });
}

// ── Toast ────────────────────────────────────────────────────────────────────

function toast(msg, duration = 2500) {
    const el = document.getElementById('popupToast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), duration);
}

// ── Custom confirm dialog ────────────────────────────────────────────────────

function popupConfirm(title, body, confirmLabel = 'Confirm', danger = false) {
    return new Promise(resolve => {
        const backdrop = document.createElement('div');
        backdrop.className = 'cpt-dialog-backdrop';

        const dialog = document.createElement('div');
        dialog.className = 'cpt-dialog';

        const titleEl = document.createElement('div');
        titleEl.className = 'cpt-dialog__title';
        titleEl.textContent = title;

        const bodyEl = document.createElement('div');
        bodyEl.className = 'cpt-dialog__body';
        bodyEl.textContent = body;

        const actions = document.createElement('div');
        actions.className = 'cpt-dialog__actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => { backdrop.remove(); resolve(false); });

        const confirmBtn = document.createElement('button');
        confirmBtn.className = danger ? 'btn btn--danger' : 'btn btn--primary';
        confirmBtn.textContent = confirmLabel;
        confirmBtn.addEventListener('click', () => { backdrop.remove(); resolve(true); });

        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);
        dialog.appendChild(titleEl);
        dialog.appendChild(bodyEl);
        dialog.appendChild(actions);
        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);

        confirmBtn.focus();

        const escHandler = e => {
            if (e.key === 'Escape') { backdrop.remove(); resolve(false); document.removeEventListener('keydown', escHandler); }
        };
        document.addEventListener('keydown', escHandler);
    });
}

// ── Notify content scripts ───────────────────────────────────────────────────

function notifyContentScripts() {
    chrome.tabs.query({ url: 'https://*.instructure.com/courses/*/gradebook*' }, tabs => {
        tabs.forEach(tab => {
            // Only reload tabs on the same Canvas instance whose data we just edited.
            try {
                if (new URL(tab.url).hostname !== CURRENT_INSTANCE) return;
            } catch { return; }
            chrome.tabs.sendMessage(tab.id, { action: 'reload' }).catch(() => {});
        });
    });
}

// ── Storage size estimate ────────────────────────────────────────────────────

function updateStorageUsage(data) {
    const bytes = new TextEncoder().encode(JSON.stringify(data)).length;
    const kb    = (bytes / 1024).toFixed(1);
    document.getElementById('storageUsage').textContent = `~${kb} KB used`;
}

// ============================================================================
// TABS
// ============================================================================

document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('pane-' + tab.dataset.tab).classList.add('active');
        // Re-render Links tab each time it's opened so it stays fresh
        if (tab.dataset.tab === 'links') renderLinks();
        if (tab.dataset.tab === 'mappings') renderMappings();
    });
});

// ── Sub-tab switching (Tracker → Courses / States) ────────────────────────

document.querySelectorAll('.sub-tab').forEach(subTab => {
    subTab.addEventListener('click', () => {
        document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.sub-pane').forEach(p => p.classList.remove('active'));
        subTab.classList.add('active');
        document.getElementById('sub-pane-' + subTab.dataset.subTab).classList.add('active');
    });
});

// ── Per-tab help icons ───────────────────────────────────────────────────────

const TAB_HELP_TEXT = {
    tools:   'Turn individual features on or off. Most changes take effect on the next page load.',
    tracker: 'Manage courses you\'ve enabled for review tracking. Use the Courses sub-tab for the global toggle and course list. Switch to the 🎨 States sub-tab to customize your review states.',
    data:    'Manage your data by category. Tracker, Links, and Mappings can each be exported or cleared on their own, and Settings can be exported. Importing is done through Full Backup: load a backup file and choose which categories to restore. Clear All removes tracker data, links, and mappings for this Canvas instance, but never your feature settings.',
};

let activeTabPopover = null;

function closeTabPopover() {
    if (!activeTabPopover) return;
    activeTabPopover.el.classList.remove('visible');
    activeTabPopover.icon.classList.remove('active');
    setTimeout(() => { if (activeTabPopover) { activeTabPopover.el.remove(); activeTabPopover = null; } }, 160);
}

function showLinksHelpModal() {
    if (document.getElementById('cpt-links-help-backdrop')) return;

    const sections = [
        { heading: '📍 Where it appears',    body: 'Quick-access links appear beneath each course name on the Admin Accounts search page. They are only visible to you — students and instructors do not see them.' },
        { heading: '🔗 Built-in links',      body: 'Twelve built-in links are available: Assignments, Modules, People, Grades, Files, and Syllabus are enabled by default. Settings, Announcements, Discussions, Outcomes, Pages, and Quizzes are available but off by default. Toggle any of them on or off using the switches below.' },
        { heading: '↕ Reordering links',     body: 'Use the ↑ and ↓ buttons to change the order links appear beneath each course. Built-in and custom links share one unified list — you can freely mix their order.' },
        { heading: '➕ Adding custom links',  body: 'Scroll to the bottom of this tab and use the "Add Custom Tool Link" form. Enter a label and paste any full Canvas course URL — including external tool URLs. The extension automatically extracts the course-relative path and applies it to every course in the search results.' },
        { heading: '🗑 Removing custom links', body: 'Custom links show an ✕ button. Built-in links cannot be deleted — only toggled off.' },
        { heading: '💾 Saving your settings', body: 'All link settings save automatically. Use the 💾 Data tab to export your full configuration as a backup or restore a previous one.' },
        { heading: '⚠️ Page requirement',     body: 'Links appear wherever an account\'s courses table is shown. That includes reaching Courses by navigating within an account, for example from People, without a full page reload. They do not appear on individual course pages.' },
    ];

    const backdrop = document.createElement('div');
    backdrop.id = 'cpt-links-help-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:99999;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.25s ease;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#fff;border-radius:8px;padding:22px 24px 20px;max-width:380px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 4px 24px rgba(0,0,0,0.25);font-family:Lato,sans-serif;color:#2d3b45;position:relative;';
    dialog.addEventListener('click', e => e.stopPropagation());

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:absolute;top:10px;right:12px;background:none;border:none;font-size:15px;cursor:pointer;color:#8a9bb0;line-height:1;padding:2px 4px;border-radius:3px;';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:14px;font-weight:700;color:#0770a3;margin-bottom:16px;padding-right:20px;';
    title.textContent = '🔗 Admin Course Links — Tips & Help';

    const body = document.createElement('div');
    sections.forEach((sec, idx) => {
        const section = document.createElement('div');
        section.style.cssText = idx > 0 ? 'border-top:1px solid #e8eaec;padding-top:11px;margin-top:11px;' : '';

        const heading = document.createElement('div');
        heading.style.cssText = 'font-size:12px;font-weight:700;margin-bottom:4px;';
        heading.textContent = sec.heading;

        const text = document.createElement('div');
        text.style.cssText = 'font-size:12px;line-height:1.6;color:#555;';
        text.textContent = sec.body;

        section.appendChild(heading);
        section.appendChild(text);
        body.appendChild(section);
    });

    const gotItBtn = document.createElement('button');
    gotItBtn.textContent = 'Got it';
    gotItBtn.style.cssText = 'margin-top:18px;width:100%;padding:8px 14px;font-size:13px;font-family:Lato,sans-serif;border-radius:4px;border:none;background:#0770a3;color:#fff;cursor:pointer;font-weight:600;';

    function dismiss() {
        backdrop.style.opacity = '0';
        setTimeout(() => backdrop.remove(), 260);
    }

    gotItBtn.addEventListener('click', dismiss);
    closeBtn.addEventListener('click', dismiss);
    backdrop.addEventListener('click', dismiss);
    document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', escHandler); }
    });

    dialog.appendChild(closeBtn);
    dialog.appendChild(title);
    dialog.appendChild(body);
    dialog.appendChild(gotItBtn);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    requestAnimationFrame(() => requestAnimationFrame(() => { backdrop.style.opacity = '1'; }));
}

document.querySelectorAll('.pane-help-icon').forEach(icon => {
    icon.addEventListener('click', e => {
        e.stopPropagation();

        const tabId = icon.dataset.tabHelp;

        // Links tab gets a full modal instead of a popover
        if (tabId === 'links') {
            closeTabPopover();
            showLinksHelpModal();
            return;
        }

        // Toggle off if already open for this icon
        if (activeTabPopover && activeTabPopover.icon === icon) {
            closeTabPopover();
            return;
        }

        closeTabPopover();

        const text = TAB_HELP_TEXT[tabId];
        if (!text) return;

        const popover = document.createElement('div');
        popover.className = 'tab-help-popover';
        popover.textContent = text;
        document.body.appendChild(popover);

        const rect = icon.getBoundingClientRect();
        const pw   = 220;
        let left   = rect.right - pw;
        left       = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
        popover.style.width = pw + 'px';
        popover.style.left  = left + 'px';
        popover.style.top   = (rect.bottom + 7) + 'px';

        const arrowLeft = rect.left + rect.width / 2 - left;
        popover.style.setProperty('--arrow-left', arrowLeft + 'px');

        activeTabPopover = { el: popover, icon };
        icon.classList.add('active');

        requestAnimationFrame(() => requestAnimationFrame(() => popover.classList.add('visible')));
    });
});

// Close popover when clicking anywhere else
document.addEventListener('click', () => closeTabPopover());

// ============================================================================
// TOOLS — feature toggles
// ============================================================================

function updateGlobalToggleState(trackerEnabled) {
    const wrap  = document.getElementById('globalToggle').closest('.tracker-global');
    const label = wrap ? wrap.querySelector('.tracker-global__label') : null;

    if (trackerEnabled) {
        globalToggle.disabled = false;
        globalToggle.closest('label').style.opacity = '1';
        globalToggle.closest('label').style.cursor  = 'pointer';
        if (label) {
            label.textContent = 'Global tracking enabled';
            label.style.color = '';
        }
        // Restore saved globalEnabled state
        getData(data => {
            globalToggle.checked = data.globalEnabled !== false;
        });
    } else {
        globalToggle.disabled = true;
        globalToggle.checked  = false;
        globalToggle.closest('label').style.opacity = '0.4';
        globalToggle.closest('label').style.cursor  = 'not-allowed';
        if (label) {
            label.textContent = 'Global tracking disabled (feature is off)';
            label.style.color = 'var(--gray-3)';
        }
    }
}

function renderFeatures() {
    getFeatures(features => {
        FEATURES.forEach(f => {
            const checkbox = document.getElementById(`feature-${f.id}`);
            if (!checkbox) return;
            checkbox.checked = features[f.id];
        });
        // Sync global toggle state with tracker feature flag
        updateGlobalToggleState(features.reviewTracker !== false);
    });
}

// ── Feature card carets (collapsible descriptions) ───────────────────────────

const CARET_KEY = 'cpt_card_expanded';

function initFeatureCarets() {
    chrome.storage.local.get(CARET_KEY, result => {
        const expanded = result[CARET_KEY] || {};

        document.querySelectorAll('.feature-card__caret').forEach(caret => {
            const cardId  = caret.dataset.card;
            const wrap    = document.getElementById(`desc-${cardId}`);
            const nameDiv = caret.closest('.feature-card__name');
            if (!wrap || !nameDiv) return;

            // Apply persisted state (default: collapsed)
            if (expanded[cardId]) {
                wrap.classList.add('expanded');
                caret.classList.add('expanded');
                caret.setAttribute('aria-expanded', 'true');
                caret.title = 'Hide description';
            }

            nameDiv.addEventListener('click', () => {
                const isExpanded = wrap.classList.toggle('expanded');
                caret.classList.toggle('expanded', isExpanded);
                caret.setAttribute('aria-expanded', String(isExpanded));
                caret.title = isExpanded ? 'Hide description' : 'Show description';

                // Persist state
                chrome.storage.local.get(CARET_KEY, r => {
                    const state = r[CARET_KEY] || {};
                    if (isExpanded) {
                        state[cardId] = true;
                    } else {
                        delete state[cardId];
                    }
                    chrome.storage.local.set({ [CARET_KEY]: state });
                });
            });
        });
    });
}

FEATURES.forEach(f => {
    const checkbox = document.getElementById(`feature-${f.id}`);
    if (!checkbox) return;

    checkbox.addEventListener('change', () => {
        getFeatures(features => {
            features[f.id] = checkbox.checked;
            setFeatures(features, () => {
                toast(checkbox.checked
                    ? `✅ Feature enabled`
                    : `⬜ Feature disabled`
                );
                // If this is the review tracker toggle, sync the global toggle
                if (f.id === 'reviewTracker') {
                    updateGlobalToggleState(checkbox.checked);
                }
                // Show/hide Tracker, Links, and Mappings tabs when their features are toggled
                const tabMap = {
                    reviewTracker:    'tab-tracker',
                    adminCourseLinks: 'tab-links',
                    checkpointMapper: 'tab-mappings',
                };
                if (tabMap[f.id]) {
                    const tab = document.getElementById(tabMap[f.id]);
                    if (tab) tab.style.display = checkbox.checked ? '' : 'none';
                }
                // Show/hide the corresponding Data tab section
                const dataSectionMap = {
                    reviewTracker:    'data-section-tracker',
                    adminCourseLinks: 'data-section-links',
                    checkpointMapper: 'data-section-mappings',
                };
                if (dataSectionMap[f.id]) {
                    const section = document.getElementById(dataSectionMap[f.id]);
                    if (section) section.style.display = checkbox.checked ? '' : 'none';
                }
            });
        });
    });
});

// ============================================================================
// TRACKER — global toggle
// ============================================================================

const globalToggle = document.getElementById('globalToggle');

globalToggle.addEventListener('change', () => {
    if (globalToggle.disabled) return; // guard against programmatic events
    getData(data => {
        data.globalEnabled = globalToggle.checked;
        setData(data, () => {
            notifyContentScripts();
            toast(globalToggle.checked ? '✅ Tracking enabled globally' : '⬜ Tracking paused globally');
        });
    });
});

// ============================================================================
// DASHBOARD — course list
// ============================================================================

function renderDashboard(data) {
    const list    = document.getElementById('courseList');
    const empty   = document.getElementById('emptyState');
    const reviews = data.reviews  || {};
    const courses = data.courses  || {};
    const states  = { ...DEFAULT_STATES, ...(data.customStates || {}) };

    const courseIds = new Set([
        ...Object.keys(reviews),
        ...Object.keys(courses),
    ]);

    list.querySelectorAll('.course-card').forEach(el => el.remove());

    if (courseIds.size === 0) {
        empty.style.display = '';
        return;
    }
    empty.style.display = 'none';

    courseIds.forEach(cid => {
        const courseReviews = reviews[cid] || {};
        const enabled       = courses[cid] ? courses[cid].enabled === true : false;
        const total         = Object.keys(courseReviews).length;

        const counts = {};
        Object.values(courseReviews).forEach(s => { counts[s] = (counts[s] || 0) + 1; });

        const bytes      = new TextEncoder().encode(JSON.stringify(courseReviews)).length;
        const kb         = (bytes / 1024).toFixed(1);
        const pct        = Math.min((bytes / (5 * 1024 * 1024)) * 100, 100).toFixed(1);
        const courseName = courses[cid] ? courses[cid].name : null;
        const courseLabel = courseName || `Course ${cid}`;

        const card = document.createElement('div');
        card.className = 'course-card';

        // Top row
        const top = document.createElement('div');
        top.className = 'course-card__top';

        const idEl = document.createElement('div');
        idEl.className = 'course-card__id';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = courseLabel;
        nameSpan.title = 'Click to rename';
        nameSpan.style.cssText = 'cursor:text;border-bottom:1px dashed transparent;transition:border-color 0.15s;';
        nameSpan.addEventListener('mouseenter', () => { nameSpan.style.borderBottomColor = '#0770a3'; });
        nameSpan.addEventListener('mouseleave', () => { nameSpan.style.borderBottomColor = 'transparent'; });

        nameSpan.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'text';
            input.value = courseName || '';
            input.placeholder = `Course ${cid}`;
            input.style.cssText = [
                'font-size: 11px', 'font-weight: 700', 'color: #0770a3',
                'font-family: Lato, sans-serif', 'border: none',
                'border-bottom: 2px solid #0770a3', 'outline: none',
                'background: transparent', 'width: 100%', 'padding: 0',
            ].join(';');

            nameSpan.replaceWith(input);
            input.focus();
            input.select();

            function saveName() {
                const newName = input.value.trim();
                getData(d => {
                    if (!d.courses)      d.courses = {};
                    if (!d.courses[cid]) d.courses[cid] = {};
                    if (newName) {
                        d.courses[cid].name = newName;
                    } else {
                        delete d.courses[cid].name;
                    }
                    setData(d, () => {
                        notifyContentScripts();
                        renderDashboard(d);
                        toast(`✅ Course name ${newName ? 'updated' : 'cleared'}.`);
                    });
                });
            }

            input.addEventListener('keydown', e => {
                if (e.key === 'Enter')  { input.blur(); }
                if (e.key === 'Escape') { renderAll(); }
            });
            input.addEventListener('blur', saveName);
        });

        idEl.appendChild(nameSpan);

        if (courseName) {
            const subEl = document.createElement('div');
            subEl.style.cssText = 'font-size:10px;color:#8a9bb0;font-weight:400;margin-top:1px;';
            subEl.textContent = `ID: ${cid}`;
            idEl.appendChild(subEl);
        }

        const countsEl = document.createElement('div');
        countsEl.className = 'course-card__counts';

        const stateOrder = (data.customCycle || DEFAULT_CYCLE).filter(k => k !== 'NONE');
        stateOrder.filter(k => counts[k]).forEach(k => {
            const s     = states[k] || {};
            const badge = document.createElement('div');
            badge.className = 'count-badge';
            badge.title = s.label || k;

            const iconEl = document.createElement('span');
            if (s.emoji) {
                iconEl.textContent = s.emoji;
            } else if (s.color) {
                iconEl.replaceChildren(buildDotIcon(s.color, 12));
            } else {
                iconEl.textContent = '○';
            }

            const countEl = document.createElement('span');
            countEl.textContent = counts[k];

            badge.appendChild(iconEl);
            badge.appendChild(countEl);
            countsEl.appendChild(badge);
        });

        if (total === 0) {
            const badge = document.createElement('div');
            badge.className = 'count-badge';
            badge.textContent = 'No markers';
            countsEl.appendChild(badge);
        }

        top.appendChild(idEl);
        top.appendChild(countsEl);

        // Toggle row
        const toggleRow = document.createElement('div');
        toggleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;';

        const toggleLabel = document.createElement('span');
        toggleLabel.style.cssText = 'font-size:11px;color:#4a6070;';
        toggleLabel.textContent = enabled ? 'Tracking ON for this course' : 'Tracking OFF for this course';

        const toggleWrap  = document.createElement('label');
        toggleWrap.className = 'toggle';
        const toggleInput = document.createElement('input');
        toggleInput.type    = 'checkbox';
        toggleInput.checked = enabled;
        const toggleTrack   = document.createElement('span');
        toggleTrack.className = 'toggle__track';
        toggleWrap.appendChild(toggleInput);
        toggleWrap.appendChild(toggleTrack);

        toggleInput.addEventListener('change', () => {
            getData(d => {
                if (!d.courses)      d.courses = {};
                if (!d.courses[cid]) d.courses[cid] = {};
                d.courses[cid].enabled = toggleInput.checked;
                toggleLabel.textContent = toggleInput.checked
                    ? 'Tracking ON for this course'
                    : 'Tracking OFF for this course';
                setData(d, () => notifyContentScripts());
            });
        });

        toggleRow.appendChild(toggleLabel);
        toggleRow.appendChild(toggleWrap);

        // Storage bar
        const bar = document.createElement('div');
        bar.className = 'storage-bar';
        const fill = document.createElement('div');
        fill.className = 'storage-bar__fill';
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);

        const storageLabel = document.createElement('div');
        storageLabel.className = 'storage-label';
        storageLabel.textContent = `${total} marker${total !== 1 ? 's' : ''} · ${kb} KB`;

        // Action buttons
        const actions = document.createElement('div');
        actions.className = 'course-card__actions';

        const exportBtn = document.createElement('button');
        exportBtn.className = 'btn';
        exportBtn.textContent = '📤 Export';
        exportBtn.addEventListener('click', () => exportCourse(cid));

        const importBtn = document.createElement('button');
        importBtn.className = 'btn';
        importBtn.textContent = '📥 Import';
        importBtn.addEventListener('click', () => importCourse(cid));

        const clearBtn = document.createElement('button');
        clearBtn.className = 'btn btn--danger';
        clearBtn.textContent = '🗑 Clear';
        clearBtn.addEventListener('click', async () => {
            const ok = await popupConfirm(
                `Clear ${courseLabel}?`,
                'This will remove all review markers for this course. Cannot be undone.',
                'Clear', true
            );
            if (!ok) return;
            getData(d => {
                if (d.reviews) delete d.reviews[cid];
                if (d.courses) delete d.courses[cid];
                if (d.hints)   delete d.hints[cid];
                setData(d, () => {
                    notifyContentScripts();
                    renderAll();
                    toast('🗑 Course data cleared.');
                });
            });
        });

        actions.appendChild(exportBtn);
        actions.appendChild(importBtn);
        actions.appendChild(clearBtn);

        card.appendChild(top);
        card.appendChild(toggleRow);
        card.appendChild(bar);
        card.appendChild(storageLabel);
        card.appendChild(actions);
        list.appendChild(card);
    });
}

// ============================================================================
// STATES
// ============================================================================

function renderStates(data) {
    const customStates = data.customStates || {};
    const customCycle  = data.customCycle  || DEFAULT_CYCLE;

    const defaultList = document.getElementById('defaultStateList');
    defaultList.innerHTML = '';

    DEFAULT_CYCLE.filter(k => k !== 'NONE').forEach(key => {
        const s   = DEFAULT_STATES[key];
        const row = document.createElement('div');
        row.className = 'state-row state-row--default';

        const emojiEl = document.createElement('div');
        emojiEl.className = 'state-row__emoji';
        emojiEl.textContent = s.emoji || '○';

        const labelEl = document.createElement('div');
        labelEl.style.cssText = 'flex:1;font-size:12px;color:#4a6070;';
        labelEl.textContent = s.label;

        const badge = document.createElement('span');
        badge.className = 'state-row__badge';
        badge.textContent = 'default';

        row.appendChild(emojiEl);
        row.appendChild(labelEl);
        row.appendChild(badge);
        defaultList.appendChild(row);
    });

    const customList = document.getElementById('customStateList');
    customList.innerHTML = '';

    const customKeys = Object.keys(customStates);

    if (customKeys.length === 0) {
        const none = document.createElement('div');
        none.style.cssText = 'font-size:11px;color:#8a9bb0;padding:4px 0;';
        none.textContent = 'No custom states added yet.';
        customList.appendChild(none);
    }

    customKeys.forEach(key => {
        const s   = customStates[key];
        const row = document.createElement('div');
        row.className = 'state-row';

        const preview = document.createElement('div');
        preview.className = 'state-row__emoji';

        const emojiInput = document.createElement('input');
        emojiInput.type = 'text';
        emojiInput.className = 'state-row__input state-row__input--emoji';
        emojiInput.value = s.emoji || '';
        emojiInput.maxLength = 2;
        emojiInput.placeholder = '🔵';

        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'state-row__input state-row__input--label';
        labelInput.value = s.label || '';
        labelInput.placeholder = 'State label...';

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'state-row__input state-row__input--color';
        colorInput.value = s.color || '#3498db';
        colorInput.title = 'Indicator color';

        function updatePreview() {
            const emoji = emojiInput.value.trim();
            const color = colorInput.value;
            if (emoji) {
                preview.textContent = emoji;
            } else {
                preview.replaceChildren(buildDotIcon(color, 16));
            }
        }

        emojiInput.addEventListener('input', updatePreview);
        colorInput.addEventListener('input', updatePreview);
        updatePreview();

        [emojiInput, labelInput, colorInput].forEach(input => {
            input.addEventListener('change', () => {
                getData(d => {
                    if (!d.customStates) d.customStates = {};
                    d.customStates[key] = {
                        emoji: emojiInput.value.trim(),
                        label: labelInput.value.trim() || key,
                        color: colorInput.value,
                    };
                    setData(d, () => {
                        notifyContentScripts();
                        renderDashboard(d);
                        toast('✅ State updated.');
                    });
                });
            });
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn--danger';
        deleteBtn.textContent = '✕';
        deleteBtn.title = 'Remove custom state';
        deleteBtn.style.padding = '4px 8px';
        deleteBtn.addEventListener('click', async () => {
            const ok = await popupConfirm(
                `Remove "${s.label}"?`,
                'Any cells marked with this state will show no indicator until re-marked.',
                'Remove', true
            );
            if (!ok) return;
            getData(d => {
                if (d.customStates) delete d.customStates[key];
                if (d.customCycle)  d.customCycle = d.customCycle.filter(k => k !== key);
                setData(d, () => { notifyContentScripts(); renderAll(); toast('🗑 Custom state removed.'); });
            });
        });

        row.appendChild(preview);
        row.appendChild(emojiInput);
        row.appendChild(labelInput);
        row.appendChild(colorInput);
        row.appendChild(deleteBtn);
        customList.appendChild(row);
    });

    document.getElementById('addStateRow').style.display =
        customKeys.length >= MAX_CUSTOM_STATES ? 'none' : 'flex';
}

document.getElementById('addStateBtn').addEventListener('click', () => {
    const emoji = document.getElementById('newStateEmoji').value.trim();
    const label = document.getElementById('newStateLabel').value.trim();
    const color = document.getElementById('newStateColor').value;

    if (!label) { toast('⚠️ Please enter a label.'); return; }

    getData(data => {
        const customStates = data.customStates || {};
        if (Object.keys(customStates).length >= MAX_CUSTOM_STATES) {
            toast('⚠️ Maximum 4 custom states allowed.'); return;
        }

        const key = 'CUSTOM_' + Date.now();
        customStates[key] = { emoji, label, color };

        const cycle  = data.customCycle || [...DEFAULT_CYCLE];
        const revIdx = cycle.indexOf('REVIEWED');
        cycle.splice(revIdx >= 0 ? revIdx : cycle.length, 0, key);

        data.customStates = customStates;
        data.customCycle  = cycle;

        setData(data, () => {
            document.getElementById('newStateEmoji').value = '';
            document.getElementById('newStateLabel').value = '';
            notifyContentScripts();
            renderAll();
            toast('✅ Custom state added.');
        });
    });
});

// ============================================================================
// DATA — export / import / clear
// ============================================================================

// ── Import sanitization ───────────────────────────────────────────────────────
// Never write raw parsed JSON into chrome.storage.local. Whitelist keys,
// coerce types, and validate any value that later reaches an HTML/attribute
// context (colors especially). Unknown keys are intentionally dropped.

const HEX_COLOR_RE      = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const STATE_KEY_RE      = /^[A-Z0-9_]{1,32}$/;      // NONE, PENDING, CUSTOM_1…
const ID_RE             = /^[a-zA-Z0-9_\-]{1,64}$/; // course/rubric/link ids
// All three values are persisted by both mappers — 'ignore' is a real stored
// choice (rubric-checkpoint-mapper.js writes it; checkpoint-mapper.js reads it
// back to skip that criterion when summing). Omitting it here silently
// discarded a user's explicit decision on import.
const CHECKPOINT_VALUES = new Set(['reply_to_topic', 'reply_to_entry', 'ignore']);

function cleanStr(v, max = 200) {
    return (typeof v === 'string') ? v.slice(0, max) : '';
}

function cleanColor(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return HEX_COLOR_RE.test(s) ? s : null;
}

function cleanBool(v, fallback = false) {
    return (typeof v === 'boolean') ? v : fallback;
}

// Per-course reviews map: { "studentId_assignmentId": STATE }
function sanitizeCourseReviews(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const rk of Object.keys(raw)) {
        if (!/^\d+_\d+$/.test(rk)) continue; // studentId_assignmentId
        const state = raw[rk];
        if (typeof state === 'string' && STATE_KEY_RE.test(state)) {
            out[rk] = state;
        }
    }
    return out;
}

// Tracker (cpt_review_data):
// { courses, customCycle, customStates, globalEnabled, hints, reviews }
function sanitizeTracker(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};

    if (raw.courses && typeof raw.courses === 'object') {
        out.courses = {};
        for (const cid of Object.keys(raw.courses)) {
            if (!ID_RE.test(cid)) continue;
            const c = raw.courses[cid] || {};
            const entry = { enabled: cleanBool(c.enabled, false) };
            const name  = cleanStr(c.name, 200);
            if (name) entry.name = name;
            out.courses[cid] = entry;
        }
    }

    if (Array.isArray(raw.customCycle)) {
        out.customCycle = raw.customCycle
            .filter(k => typeof k === 'string' && STATE_KEY_RE.test(k))
            .slice(0, 16);
    }

    if (raw.customStates && typeof raw.customStates === 'object') {
        out.customStates = {};
        for (const key of Object.keys(raw.customStates)) {
            if (!STATE_KEY_RE.test(key)) continue;
            const s = raw.customStates[key] || {};
            out.customStates[key] = {
                emoji: cleanStr(s.emoji, 8),
                label: cleanStr(s.label, 60) || key,
                color: cleanColor(s.color),   // ← the XSS-relevant field
            };
        }
    }

    if (typeof raw.globalEnabled === 'boolean') out.globalEnabled = raw.globalEnabled;

    if (raw.hints && typeof raw.hints === 'object') {
        out.hints = {};
        for (const cid of Object.keys(raw.hints)) {
            if (ID_RE.test(cid)) out.hints[cid] = cleanBool(raw.hints[cid], false);
        }
    }

    if (raw.reviews && typeof raw.reviews === 'object') {
        out.reviews = {};
        for (const cid of Object.keys(raw.reviews)) {
            if (!ID_RE.test(cid)) continue;
            const course = sanitizeCourseReviews(raw.reviews[cid]);
            if (course) out.reviews[cid] = course;
        }
    }

    return out;
}

// Links (cpt_admin_links): { order: [ {id, path, label, enabled, custom} ] }
// plus legacy keys still read as fallbacks: links: [{id, enabled}] and
// custom: [{id, label, path, enabled}].
function sanitizeLinkPath(raw) {
    let path = cleanStr(raw, 300).replace(/^[/\\]+/, '');
    if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(path)) return null; // javascript:, data:, …
    if (path.includes('..')) return null;
    return path;
}

function sanitizeLinks(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};

    if (Array.isArray(raw.order)) {
        out.order = [];
        for (const l of raw.order.slice(0, 100)) {
            if (!l || typeof l !== 'object') continue;
            const id   = cleanStr(l.id, 64);
            const path = sanitizeLinkPath(l.path);
            if (!id || !ID_RE.test(id) || path === null) continue;
            out.order.push({
                id,
                path,
                label:   cleanStr(l.label, 60) || id,
                enabled: cleanBool(l.enabled, true),
                custom:  cleanBool(l.custom, false),
            });
        }
    }

    // Legacy built-in overrides: only id + enabled are meaningful.
    if (Array.isArray(raw.links)) {
        out.links = [];
        for (const l of raw.links.slice(0, 100)) {
            if (!l || typeof l !== 'object') continue;
            const id = cleanStr(l.id, 64);
            if (!id || !ID_RE.test(id)) continue;
            out.links.push({ id, enabled: cleanBool(l.enabled, true) });
        }
    }

    // Legacy custom link definitions.
    if (Array.isArray(raw.custom)) {
        out.custom = [];
        for (const l of raw.custom.slice(0, 100)) {
            if (!l || typeof l !== 'object') continue;
            const id   = cleanStr(l.id, 64);
            const path = sanitizeLinkPath(l.path);
            if (!id || !ID_RE.test(id) || path === null) continue;
            out.custom.push({
                id,
                path,
                label:   cleanStr(l.label, 60) || id,
                enabled: cleanBool(l.enabled, true),
            });
        }
    }

    // A links payload with none of the three known keys is not valid.
    if (!out.order && !out.links && !out.custom) return null;
    return out;
}

// Mappings (cpt_checkpoint_mappings):
// { [rubricId]: { criteria: { [criterionId]: { assign, index } },
//                 courseId, courseName, rubricName, createdAt } }
//
// This sanitizer previously validated the PRE-3.7.0 shape: numeric criterion
// keys (/^\d{1,3}$/) holding bare string values. Both mappers now write
// criterion-ID keys ("_1033") holding { assign, index } objects
// (checkpoint-mapper.js setCriterionMapping, rubric-checkpoint-mapper.js
// setCriterionMapping). Every criterion therefore failed both guards and was
// discarded, while the function still returned a truthy {} — so import
// reported success and restored nothing. Verified against both write paths.
//
// Criterion IDs are underscore-prefixed alphanumerics, which ID_RE already
// accepts; there is no need for a separate pattern.
function sanitizeMappings(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};

    for (const rubricId of Object.keys(raw)) {
        if (!ID_RE.test(rubricId)) continue;
        const m = raw[rubricId];
        if (!m || typeof m !== 'object') continue;

        const criteria = {};
        if (m.criteria && typeof m.criteria === 'object') {
            for (const criterionId of Object.keys(m.criteria)) {
                if (!ID_RE.test(criterionId)) continue;

                const c = m.criteria[criterionId];
                // Pre-3.7.0 entries stored a bare string here. They are not
                // migrated (3.7.0 was a deliberate clean break) and are
                // dropped rather than guessed at.
                if (!c || typeof c !== 'object') continue;
                if (!CHECKPOINT_VALUES.has(c.assign)) continue;

                // `index` is metadata only — never a key — so a bad value
                // costs nothing and defaults to 0 rather than voiding the
                // criterion.
                const idx = Number.isInteger(c.index) && c.index >= 0 && c.index <= 999
                    ? c.index
                    : 0;

                criteria[criterionId] = { assign: c.assign, index: idx };
            }
        }

        // Both mappers create a rubric entry lazily, only when a criterion is
        // actually assigned, so an entry with no surviving criteria is
        // corruption rather than intent. Dropping it keeps the Mappings tab
        // free of rows that display "0 criteria mapped" and do nothing.
        if (Object.keys(criteria).length === 0) continue;

        out[rubricId] = {
            criteria,
            courseId:   cleanStr(m.courseId, 64),
            courseName: cleanStr(m.courseName, 200),
            rubricName: cleanStr(m.rubricName, 200),
            createdAt:  cleanStr(m.createdAt, 40),
        };
    }

    // An empty result means nothing in the file was usable. Returning {} here
    // would be truthy, so the import dialog would offer a Mappings category
    // that restores nothing over the top of existing data.
    if (Object.keys(out).length === 0) return null;
    return out;
}

// Settings (cpt_features): whitelist against the FEATURES array.
function sanitizeSettings(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    FEATURES.forEach(f => {
        if (typeof raw[f.id] === 'boolean') out[f.id] = raw[f.id];
    });
    // {} is truthy, so returning it for a file containing no recognizable
    // toggles would offer a Settings category that overwrites the user's
    // current toggles with an empty object — resetting every feature to its
    // default. Nothing usable means nothing to restore.
    if (Object.keys(out).length === 0) return null;
    return out;
}

const SANITIZERS = {
    tracker:  sanitizeTracker,
    links:    sanitizeLinks,
    mappings: sanitizeMappings,
    settings: sanitizeSettings,
};

// ── Shared helpers ────────────────────────────────────────────────────────────

function triggerDownload(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function pickFile(cb) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.addEventListener('change', () => {
        const file = input.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
            try { cb(JSON.parse(e.target.result)); }
            catch { toast('❌ Could not read file.'); }
        };
        reader.readAsText(file);
    });
    input.click();
}

const TODAY = new Date().toISOString().slice(0, 10);

// ── Tracker ───────────────────────────────────────────────────────────────────

document.getElementById('exportTrackerBtn').addEventListener('click', () => {
    getData(data => {
        triggerDownload(
            `canvas-pro-tools-tracker-${TODAY}.json`,
            { version: EXT_VERSION, exported: new Date().toISOString(), instance: CURRENT_INSTANCE, categories: ['tracker'], tracker: data }
        );
        toast('✅ Tracker data exported.');
    });
});

// Removes only CURRENT_INSTANCE's slice from a namespaced storage key,
// leaving other institutions' data intact.
function removeInstanceSlice(storageKey, cb) {
    chrome.storage.local.get(storageKey, result => {
        const all = result[storageKey] || {};
        delete all[CURRENT_INSTANCE];
        chrome.storage.local.set({ [storageKey]: all }, cb);
    });
}

document.getElementById('clearTrackerBtn').addEventListener('click', async () => {
    const ok = await popupConfirm(
        'Clear Tracker Data?',
        'This removes all review markers, course settings, and custom states. Cannot be undone.',
        'Clear', true
    );
    if (!ok) return;
    removeInstanceSlice(STORAGE_KEY, () => {
        notifyContentScripts();
        renderAll();
        toast('🗑 Tracker data cleared.');
    });
});

// ── Links ─────────────────────────────────────────────────────────────────────

document.getElementById('exportLinksBtn').addEventListener('click', () => {
    getLinksData(data => {
        triggerDownload(
            `canvas-pro-tools-links-${TODAY}.json`,
            { version: EXT_VERSION, exported: new Date().toISOString(), instance: CURRENT_INSTANCE, categories: ['links'], links: data }
        );
        toast('✅ Links data exported.');
    });
});

document.getElementById('clearLinksBtn').addEventListener('click', async () => {
    const ok = await popupConfirm(
        'Clear Links Data?',
        'This resets all link configuration to defaults. Cannot be undone.',
        'Clear', true
    );
    if (!ok) return;
    removeInstanceSlice(LINKS_KEY, () => {
        renderLinks();
        toast('🗑 Links data cleared.');
    });
});

// ── Mappings ──────────────────────────────────────────────────────────────────

document.getElementById('exportMappingsBtn').addEventListener('click', () => {
    getMappings(data => {
        triggerDownload(
            `canvas-pro-tools-mappings-${TODAY}.json`,
            { version: EXT_VERSION, exported: new Date().toISOString(), instance: CURRENT_INSTANCE, categories: ['mappings'], mappings: data }
        );
        toast('✅ Mappings data exported.');
    });
});

document.getElementById('clearMappingsBtn').addEventListener('click', async () => {
    const ok = await popupConfirm(
        'Clear Mappings Data?',
        'This removes all checkpoint rubric mappings. Cannot be undone.',
        'Clear', true
    );
    if (!ok) return;
    removeInstanceSlice(MAPPINGS_KEY, () => {
        renderMappings();
        toast('🗑 Mappings data cleared.');
    });
});

// ── Settings ──────────────────────────────────────────────────────────────────

document.getElementById('exportSettingsBtn').addEventListener('click', () => {
    getFeatures(data => {
        triggerDownload(
            `canvas-pro-tools-settings-${TODAY}.json`,
            { version: EXT_VERSION, exported: new Date().toISOString(), instance: CURRENT_INSTANCE, categories: ['settings'], settings: data }
        );
        toast('✅ Settings exported.');
    });
});

// ── Full Backup ───────────────────────────────────────────────────────────────

document.getElementById('exportAllBtn').addEventListener('click', () => {
    chrome.storage.local.get([STORAGE_KEY, LINKS_KEY, FEATURES_KEY, MAPPINGS_KEY], result => {
        const tracker  = (result[STORAGE_KEY]  || {})[CURRENT_INSTANCE] || {};
        const links    = (result[LINKS_KEY]    || {})[CURRENT_INSTANCE] || {};
        const mappings = (result[MAPPINGS_KEY] || {})[CURRENT_INSTANCE] || {};
        const settings = (result[FEATURES_KEY] || {})[CURRENT_INSTANCE] || {};
        const payload = {
            version:  EXT_VERSION,
            exported: new Date().toISOString(),
            instance: CURRENT_INSTANCE,
            categories: ['tracker', 'links', 'settings', 'mappings'],
            tracker,
            links,
            settings,
            mappings,
        };
        triggerDownload(`canvas-pro-tools-backup-${CURRENT_INSTANCE}-${TODAY}.json`, payload);
        toast('✅ Full backup exported.');
    });
});

document.getElementById('importAllBtn').addEventListener('click', () => {
    pickFile(payload => {
        // Sanitize every category up front — `available` is built from the
        // cleaned data, never from the raw parsed file.
        const cleaned = {};
        ['tracker', 'links', 'mappings', 'settings'].forEach(k => {
            const c = SANITIZERS[k](payload[k]);
            if (c) cleaned[k] = c;
        });

        // Detect which categories are present in the file
        const available = [];
        if (cleaned.tracker)  available.push({ key: 'tracker',  label: '📊 Tracker',   storageKey: STORAGE_KEY  });
        if (cleaned.links)    available.push({ key: 'links',    label: '🔗 Links',     storageKey: LINKS_KEY    });
        if (cleaned.mappings) available.push({ key: 'mappings', label: '🗂️ Mappings',  storageKey: MAPPINGS_KEY });
        if (cleaned.settings) available.push({ key: 'settings', label: '⚙️ Settings',  storageKey: FEATURES_KEY });

        if (available.length === 0) { toast('❌ No recognizable data found in this file.'); return; }

        const crossInstance = payload.instance && payload.instance !== CURRENT_INSTANCE;

        // Build a selection dialog listing what was found
        const backdrop = document.createElement('div');
        backdrop.className = 'cpt-dialog-backdrop';

        const dialog = document.createElement('div');
        dialog.className = 'cpt-dialog';

        const titleEl = document.createElement('div');
        titleEl.className = 'cpt-dialog__title';
        titleEl.textContent = 'Choose what to restore';

        const bodyEl = document.createElement('div');
        bodyEl.className = 'cpt-dialog__body';
        bodyEl.style.textAlign = 'left';

        const intro = document.createElement('div');
        intro.style.cssText = 'margin-bottom:10px;font-size:11px;color:#555;';
        intro.textContent = 'The following categories were found. Select which to restore — selected categories will overwrite existing data.';
        bodyEl.appendChild(intro);

        if (crossInstance) {
            const warn = document.createElement('div');
            warn.style.cssText = 'margin-bottom:10px;font-size:11px;color:#856404;background:#fff3cd;border:1px solid #f0ad4e;border-radius:4px;padding:6px 8px;';
            warn.textContent = `⚠️ This backup was exported from ${payload.instance}, but you're currently restoring to ${CURRENT_INSTANCE}. Course/rubric IDs may not match.`;
            bodyEl.appendChild(warn);
        }


        const checkboxes = {};
        available.forEach(cat => {
            const row = document.createElement('label');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px;cursor:pointer;';

            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.checked = true;
            checkboxes[cat.key] = cb;

            const lbl = document.createElement('span');
            lbl.textContent = cat.label;

            row.appendChild(cb);
            row.appendChild(lbl);
            bodyEl.appendChild(row);
        });

        const actions = document.createElement('div');
        actions.className = 'cpt-dialog__actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => backdrop.remove());

        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'btn btn--primary';
        restoreBtn.textContent = 'Restore selected';
        restoreBtn.addEventListener('click', () => {
            const selectedKeys = available
                .filter(cat => checkboxes[cat.key].checked)
                .map(cat => cat.key);
            if (selectedKeys.length === 0) { toast('⚠️ Nothing selected.'); return; }
            backdrop.remove();

            // All four categories — tracker, links, mappings, and settings —
            // are namespaced per Canvas instance. Merge the restored data
            // into CURRENT_INSTANCE's slice without disturbing other
            // institutions' data.
            const storageKeysToFetch = selectedKeys.map(k => ({
                tracker: STORAGE_KEY, links: LINKS_KEY, mappings: MAPPINGS_KEY, settings: FEATURES_KEY,
            }[k])).filter(Boolean);

            chrome.storage.local.get(storageKeysToFetch, result => {
                const toRestore = {};

                if (selectedKeys.includes('settings')) {
                    const all = result[FEATURES_KEY] || {};
                    all[CURRENT_INSTANCE] = cleaned.settings;
                    toRestore[FEATURES_KEY] = all;
                }
                if (selectedKeys.includes('tracker')) {
                    const all = result[STORAGE_KEY] || {};
                    all[CURRENT_INSTANCE] = cleaned.tracker;
                    toRestore[STORAGE_KEY] = all;
                }
                if (selectedKeys.includes('links')) {
                    const all = result[LINKS_KEY] || {};
                    all[CURRENT_INSTANCE] = cleaned.links;
                    toRestore[LINKS_KEY] = all;
                }
                if (selectedKeys.includes('mappings')) {
                    const all = result[MAPPINGS_KEY] || {};
                    all[CURRENT_INSTANCE] = cleaned.mappings;
                    toRestore[MAPPINGS_KEY] = all;
                }

                chrome.storage.local.set(toRestore, () => {
                    notifyContentScripts();
                    renderAll();
                    renderFeatures();
                    renderLinks();
                    renderMappings();
                    applyDataSectionVisibility();
                    toast('✅ Data restored.');
                });
            });
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(restoreBtn);
        dialog.appendChild(titleEl);
        dialog.appendChild(bodyEl);
        dialog.appendChild(actions);
        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);
        restoreBtn.focus();

        const escHandler = e => {
            if (e.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', escHandler); }
        };
        document.addEventListener('keydown', escHandler);
    });
});

document.getElementById('clearAllBtn').addEventListener('click', async () => {
    const ok = await popupConfirm(
        'Clear All Data?',
        'This removes all tracker data, link configuration, and checkpoint mappings. Feature settings are preserved. Cannot be undone.',
        'Clear everything', true
    );
    if (!ok) return;
    chrome.storage.local.get([STORAGE_KEY, LINKS_KEY, MAPPINGS_KEY], result => {
        const updates = {};
        [STORAGE_KEY, LINKS_KEY, MAPPINGS_KEY].forEach(key => {
            const all = result[key] || {};
            delete all[CURRENT_INSTANCE];
            updates[key] = all;
        });
        chrome.storage.local.set(updates, () => {
            notifyContentScripts();
            renderAll();
            renderLinks();
            renderMappings();
            toast('🗑 All data cleared.');
        });
    });
});

// ── Per-course export/import ──────────────────────────────────────────────────

function exportCourse(cid) {
    getData(data => {
        const reviews = (data.reviews || {})[cid] || {};
        const name    = (data.courses || {})[cid] ? data.courses[cid].name : null;
        const label   = name || `Course ${cid}`;
        const payload = { version: EXT_VERSION, courseId: cid, exported: new Date().toISOString(), reviews };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `review-tracker-course-${cid}-${new Date().toISOString().slice(0,10)}.json`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast(`✅ ${label} exported.`);
    });
}

async function importCourse(cid) {
    getData(async data => {
        const name  = (data.courses || {})[cid] ? data.courses[cid].name : null;
        const label = name || `Course ${cid}`;
        const ok = await popupConfirm(
            `Import ${label}?`,
            'This overwrites existing markers for this course. Cannot be undone.',
            'Import', true
        );
        if (!ok) return;

        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.json,application/json';
        input.addEventListener('change', () => {
            const file = input.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = e => {
                try {
                    const payload = JSON.parse(e.target.result);
                    const cleanedReviews = sanitizeCourseReviews(payload.reviews);
                    if (!cleanedReviews || Object.keys(cleanedReviews).length === 0) { toast('❌ Invalid file.'); return; }
                    getData(d => {
                        if (!d.reviews) d.reviews = {};
                        d.reviews[cid] = cleanedReviews;
                        setData(d, () => { notifyContentScripts(); renderAll(); toast(`✅ ${label} imported.`); });
                    });
                } catch { toast('❌ Could not read file.'); }
            };
            reader.readAsText(file);
        });
        input.click();
    });
}

// ============================================================================
// LINKS — admin course links manager
// ============================================================================

function getLinksData(cb) {
    chrome.storage.local.get(LINKS_KEY, result => {
        const all = result[LINKS_KEY] || {};
        cb(all[CURRENT_INSTANCE] || {});
    });
}

function setLinksData(data, cb) {
    chrome.storage.local.get(LINKS_KEY, result => {
        const all = result[LINKS_KEY] || {};
        all[CURRENT_INSTANCE] = data;
        chrome.storage.local.set({ [LINKS_KEY]: all }, cb);
    });
}

function parseToolUrl(url) {
    // Extract path after /courses/[id]/, preserve hash, strip query strings.
    // e.g. https://*.instructure.com/courses/12345/external_tools/3488?x=y → external_tools/3488
    // e.g. https://*.instructure.com/courses/12345/settings#tab-sections   → settings#tab-sections
    try {
        const u     = new URL(url);
        const match = u.pathname.match(/\/courses\/\d+\/(.+)$/);
        if (match) return match[1].replace(/\/$/, '') + u.hash;
    } catch (e) {}
    return null;
}

// ── Unified link list helpers ─────────────────────────────────────────────────
// Storage model: cpt_admin_links = { order: [ {id, path, label, enabled, custom} ] }
// Built-ins are seeded from BUILTIN_LINKS on first load then stored in order[].
// Custom links are also stored in order[] with custom:true.

function getUnifiedLinks(saved) {
    const order = saved.order;

    // If we already have a unified order array, use it — merging in any
    // new built-ins that may have been added since last save.
    if (Array.isArray(order) && order.length > 0) {
        const existingIds = new Set(order.map(l => l.id));
        const newBuiltins = BUILTIN_LINKS.filter(l => !existingIds.has(l.id));
        return [...order, ...newBuiltins];
    }

    // First load — migrate old separate storage format if present,
    // otherwise seed from BUILTIN_LINKS defaults.
    const savedLinks  = saved.links  || [];
    const savedCustom = saved.custom || [];

    const builtins = BUILTIN_LINKS.map(link => {
        const match = savedLinks.find(s => s.id === link.id);
        return { id: link.id, path: link.path, label: link.label,
                 enabled: match ? match.enabled : link.enabled, custom: false };
    });

    const customs = savedCustom.map(c => ({
        id: c.id, path: c.path, label: c.label,
        enabled: c.enabled !== false, custom: true,
    }));

    return [...builtins, ...customs];
}

function saveUnifiedLinks(links, cb) {
    getLinksData(saved => {
        saved.order = links;
        setLinksData(saved, cb);
    });
}

function renderLinks() {
    getLinksData(saved => {
        const links = getUnifiedLinks(saved);
        const list  = document.getElementById('linksList');
        if (!list) return;
        list.innerHTML = '';

        // ── Header ──────────────────────────────────────────────────────────
        const header = document.createElement('div');
        header.className = 'section-label';
        header.style.marginBottom = '8px';
        header.textContent = 'Course Links';
        list.appendChild(header);

        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:11px;color:#8a9bb0;margin-bottom:10px;';
        hint.textContent = 'Toggle links on or off. Use ↑ ↓ to reorder.';
        list.appendChild(hint);

        // ── Unified ordered list ─────────────────────────────────────────────
        links.forEach((link, idx) => {
            const row = document.createElement('div');
            row.className = 'link-row';

            // Info
            const info = document.createElement('div');
            info.className = 'link-row__info';

            const labelEl = document.createElement('div');
            labelEl.className = 'link-row__label';
            labelEl.textContent = link.label;

            const pathEl = document.createElement('div');
            pathEl.className = 'link-row__path';
            pathEl.textContent = link.path;

            // Custom badge
            if (link.custom) {
                const badge = document.createElement('span');
                badge.className = 'state-row__badge';
                badge.style.marginLeft = '5px';
                badge.textContent = 'custom';
                labelEl.appendChild(badge);
            }

            info.appendChild(labelEl);
            info.appendChild(pathEl);

            // Controls
            const controls = document.createElement('div');
            controls.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;';

            // Up/down buttons
            const upBtn = document.createElement('button');
            upBtn.className   = 'btn';
            upBtn.textContent = '↑';
            upBtn.style.cssText = 'padding:2px 7px;font-size:12px;line-height:1.4;';
            upBtn.disabled    = idx === 0;
            upBtn.title       = 'Move up';
            upBtn.addEventListener('click', () => {
                const newLinks = [...links];
                [newLinks[idx - 1], newLinks[idx]] = [newLinks[idx], newLinks[idx - 1]];
                saveUnifiedLinks(newLinks, () => renderLinks());
            });

            const downBtn = document.createElement('button');
            downBtn.className   = 'btn';
            downBtn.textContent = '↓';
            downBtn.style.cssText = 'padding:2px 7px;font-size:12px;line-height:1.4;';
            downBtn.disabled    = idx === links.length - 1;
            downBtn.title       = 'Move down';
            downBtn.addEventListener('click', () => {
                const newLinks = [...links];
                [newLinks[idx + 1], newLinks[idx]] = [newLinks[idx], newLinks[idx + 1]];
                saveUnifiedLinks(newLinks, () => renderLinks());
            });

            // Toggle
            const toggleWrap  = document.createElement('label');
            toggleWrap.className = 'toggle';
            const toggleInput   = document.createElement('input');
            toggleInput.type    = 'checkbox';
            toggleInput.checked = link.enabled;
            const toggleTrack   = document.createElement('span');
            toggleTrack.className = 'toggle__track';
            toggleWrap.appendChild(toggleInput);
            toggleWrap.appendChild(toggleTrack);

            toggleInput.addEventListener('change', () => {
                const newLinks = [...links];
                newLinks[idx]  = { ...newLinks[idx], enabled: toggleInput.checked };
                saveUnifiedLinks(newLinks, () =>
                    toast(toggleInput.checked ? `✅ ${link.label} enabled` : `⬜ ${link.label} disabled`)
                );
            });

            controls.appendChild(upBtn);
            controls.appendChild(downBtn);
            controls.appendChild(toggleWrap);

            // Delete button for custom links
            if (link.custom) {
                const deleteBtn = document.createElement('button');
                deleteBtn.className   = 'btn btn--danger';
                deleteBtn.textContent = '✕';
                deleteBtn.style.padding = '2px 7px';
                deleteBtn.title = 'Remove custom link';
                deleteBtn.addEventListener('click', async () => {
                    const ok = await popupConfirm(`Remove "${link.label}"?`, 'This custom link will be removed.', 'Remove', true);
                    if (!ok) return;
                    const newLinks = links.filter((_, i) => i !== idx);
                    saveUnifiedLinks(newLinks, () => { renderLinks(); toast('🗑 Custom link removed.'); });
                });
                controls.appendChild(deleteBtn);
            }

            row.appendChild(info);
            row.appendChild(controls);
            list.appendChild(row);
        });

        // ── Add custom link form ─────────────────────────────────────────────
        const divider = document.createElement('hr');
        divider.className = 'divider';
        list.appendChild(divider);

        const formDiv = document.createElement('div');
        formDiv.className = 'link-add-form';

        const formTitle = document.createElement('div');
        formTitle.className = 'section-label';
        formTitle.style.marginBottom = '8px';
        formTitle.textContent = 'Add Custom Tool Link';
        formDiv.appendChild(formTitle);

        const labelInput = document.createElement('input');
        labelInput.type        = 'text';
        labelInput.className   = 'state-row__input state-row__input--label';
        labelInput.placeholder = 'Link label (e.g. Sections)';
        labelInput.id          = 'newLinkLabel';
        labelInput.style.width = '100%';

        const urlInput = document.createElement('input');
        urlInput.type        = 'text';
        urlInput.className   = 'state-row__input state-row__input--label';
        urlInput.placeholder = 'Full Canvas URL (e.g. https://*.instructure.com/courses/123/external_tools/3488)';
        urlInput.id          = 'newLinkUrl';
        urlInput.style.cssText = 'margin-top:6px;width:100%;';

        const addBtn = document.createElement('button');
        addBtn.className      = 'btn btn--primary';
        addBtn.textContent    = 'Add Link';
        addBtn.style.marginTop = '8px';

        addBtn.addEventListener('click', () => {
            const label = labelInput.value.trim();
            const url   = urlInput.value.trim();
            if (!label) { toast('⚠️ Please enter a label.'); return; }
            if (!url)   { toast('⚠️ Please enter a URL.'); return; }
            const path = parseToolUrl(url);
            if (!path)  { toast('⚠️ Could not parse a course path from that URL. Make sure it includes /courses/[id]/...'); return; }

            const newLink = {
                id:      'custom_' + Date.now(),
                path:    path,
                label:   label,
                enabled: true,
                custom:  true,
            };
            const newLinks = [...links, newLink];
            saveUnifiedLinks(newLinks, () => {
                labelInput.value = '';
                urlInput.value   = '';
                renderLinks();
                toast('✅ Custom link added.');
            });
        });

        formDiv.appendChild(labelInput);
        formDiv.appendChild(urlInput);
        formDiv.appendChild(addBtn);
        list.appendChild(formDiv);
    });
}

// ============================================================================
// MAPPINGS — checkpoint rubric mapper management
// ============================================================================

function getMappings(cb) {
    chrome.storage.local.get(MAPPINGS_KEY, result => {
        const all = (result && result[MAPPINGS_KEY]) || {};
        cb(all[CURRENT_INSTANCE] || {});
    });
}

function saveMappingsData(data, cb) {
    chrome.storage.local.get(MAPPINGS_KEY, result => {
        const all = (result && result[MAPPINGS_KEY]) || {};
        all[CURRENT_INSTANCE] = data;
        chrome.storage.local.set({ [MAPPINGS_KEY]: all }, cb);
    });
}

function renderMappings() {
    const list = document.getElementById('mappingsList');
    const clearAllBtn = document.getElementById('clearAllMappingsBtn');
    if (!list) return;

    getMappings(mappings => {
        const entries = Object.entries(mappings);
        list.innerHTML = '';

        if (clearAllBtn) {
            clearAllBtn.disabled = entries.length === 0;
            clearAllBtn.style.opacity = entries.length === 0 ? '0.4' : '1';
        }

        if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:#8a9bb0;font-size:12px;text-align:center;padding:20px 0;';
            empty.textContent = 'No checkpoint mappings saved yet.';
            list.appendChild(empty);
            return;
        }

        entries.forEach(([rubricId, entry]) => {
            const criteria   = (entry && entry.criteria)   ? entry.criteria   : {};
            const count      = Object.keys(criteria).length;
            const courseName = (entry && entry.courseName) ? entry.courseName : 'Unknown Course';
            const createdAt  = (entry && entry.createdAt)  ? entry.createdAt  : '';
            const rubricName = (entry && entry.rubricName) ? entry.rubricName : `Rubric #${rubricId}`;

            const row = document.createElement('div');
            row.style.cssText = [
                'display: flex',
                'align-items: flex-start',
                'justify-content: space-between',
                'gap: 10px',
                'padding: 10px 0',
                'border-bottom: 1px solid #e8eaec',
                'font-family: Lato, sans-serif',
            ].join(';');

            const info = document.createElement('div');
            info.style.cssText = 'flex:1;min-width:0;overflow:hidden;';

            // ── Primary label (rubric name) — inline editable ──
            const nameLine = document.createElement('div');
            nameLine.style.cssText = 'font-weight:700;font-size:12px;color:#2d3b45;cursor:text;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            nameLine.textContent = rubricName;
            nameLine.title = 'Click to rename';

            nameLine.addEventListener('click', function () {
                // Replace with an input for inline editing
                const input = document.createElement('input');
                input.type  = 'text';
                input.value = nameLine.textContent;
                input.style.cssText = [
                    'font-weight: 700',
                    'font-size: 12px',
                    'color: #2d3b45',
                    'border: 1px solid #0770a3',
                    'border-radius: 3px',
                    'padding: 1px 5px',
                    'width: 100%',
                    'box-sizing: border-box',
                    'outline: none',
                    'font-family: Lato, sans-serif',
                ].join(';');

                nameLine.replaceWith(input);
                input.focus();
                input.select();

                function commitRename() {
                    const newName = input.value.trim() || rubricName;
                    getMappings(data => {
                        if (data[rubricId]) {
                            data[rubricId].rubricName = newName;
                            saveMappingsData(data, () => {
                                toast('✅ Rubric renamed.');
                                renderMappings();
                            });
                        }
                    });
                }

                function cancelRename() {
                    input.replaceWith(nameLine);
                }

                input.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter')  { e.preventDefault(); commitRename(); }
                    if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                });
                input.addEventListener('blur', commitRename);
            });

            // ── Secondary line: Rubric ID + criteria count ──
            const idLine = document.createElement('div');
            idLine.style.cssText = 'font-size:11px;color:#555;margin-top:1px;';
            idLine.textContent = `Rubric #${rubricId} · ${count} ${count === 1 ? 'criterion' : 'criteria'} mapped`;

            // ── Tertiary line: course + date ──
            const courseLine = document.createElement('div');
            courseLine.style.cssText = 'font-size:11px;color:#8a9bb0;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            courseLine.textContent = courseName + (createdAt ? ` · ${createdAt}` : '');
            courseLine.title = courseName;

            info.appendChild(nameLine);
            info.appendChild(idLine);
            info.appendChild(courseLine);

            const clearBtn = document.createElement('button');
            clearBtn.className = 'btn btn--danger';
            clearBtn.textContent = 'Clear';
            clearBtn.style.cssText = 'flex-shrink:0;font-size:11px;padding:3px 10px;';
            clearBtn.addEventListener('click', () => {
                popupConfirm(
                    'Clear Mapping',
                    `Remove the checkpoint mapping for "${rubricName}"? This cannot be undone.`,
                    'Clear',
                    true
                ).then(confirmed => {
                    if (!confirmed) return;
                    getMappings(data => {
                        delete data[rubricId];
                        saveMappingsData(data, () => {
                            toast(`🗑 Mapping for "${rubricName}" cleared.`);
                            renderMappings();
                        });
                    });
                });
            });

            row.appendChild(info);
            row.appendChild(clearBtn);
            list.appendChild(row);
        });
    });
}

document.getElementById('clearAllMappingsBtn').addEventListener('click', async () => {
    const ok = await popupConfirm(
        'Clear All Mappings?',
        'This removes all checkpoint rubric mappings for this Canvas instance. Cannot be undone.',
        'Clear', true
    );
    if (!ok) return;
    removeInstanceSlice(MAPPINGS_KEY, () => {
        renderMappings();
        toast('🗑 All mappings cleared.');
    });
});

// ============================================================================
// RENDER ALL
// ============================================================================

function renderAll() {
    getData(data => {
        globalToggle.checked = data.globalEnabled !== false;
        updateStorageUsage(data);
        renderDashboard(data);
        renderStates(data);
    });
}

// ── Tips & Help ───────────────────────────────────────────────────────────────

const tipsPanel = document.getElementById('tipsHelpPanel');
const tipsBtn   = document.getElementById('tipsHelpBtn');
const tipsClose = document.getElementById('tipsHelpClose');

tipsBtn.addEventListener('click',  () => { tipsPanel.style.display = 'flex'; });
tipsClose.addEventListener('click', () => { tipsPanel.style.display = 'none'; });
tipsPanel.addEventListener('click', e => { if (e.target === tipsPanel) tipsPanel.style.display = 'none'; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') tipsPanel.style.display = 'none'; });

// ── Init ──────────────────────────────────────────────────────────────────────

// Both version surfaces are driven from EXT_VERSION (declared at the top of
// this file from the manifest). The About tab was previously a hardcoded
// literal in popup.html and had drifted a release behind; setting it here
// means it can only ever show what is actually installed.
document.getElementById('versionLabel').textContent = `v${EXT_VERSION}`;

const aboutVersionEl = document.getElementById('aboutVersionLabel');
if (aboutVersionEl) aboutVersionEl.textContent = `Version ${EXT_VERSION}`;

// Show/hide tabs and Data sections based on feature flags
function applyDataSectionVisibility() {
    getFeatures(features => {
        // Tab visibility
        const tabMap = {
            reviewTracker:    'tab-tracker',
            adminCourseLinks: 'tab-links',
            checkpointMapper: 'tab-mappings',
        };
        Object.entries(tabMap).forEach(([featureId, tabId]) => {
            const tab = document.getElementById(tabId);
            if (tab) tab.style.display = features[featureId] ? '' : 'none';
        });

        // Data section visibility
        const sectionMap = {
            reviewTracker:    'data-section-tracker',
            adminCourseLinks: 'data-section-links',
            checkpointMapper: 'data-section-mappings',
        };
        Object.entries(sectionMap).forEach(([featureId, sectionId]) => {
            const section = document.getElementById(sectionId);
            if (section) section.style.display = features[featureId] ? '' : 'none';
        });
    });
}

resolveInstance(() => {
    renderFeatures();
    renderAll();
    applyDataSectionVisibility();
    initFeatureCarets();
});

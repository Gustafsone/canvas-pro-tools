// Canvas Pro-Tools - Gradebook Tracker
// Injected into: https://*.instructure.com/courses/*/gradebook*
// Storage: chrome.storage.local, namespaced per Canvas instance (hostname)
//          since 3.6.4 - see popup.js migrateLegacyStorage. Shares
//          cpt_review_data with speedgrader.js.
//
// DEFERRED (P2): the redraw poll in initTracking runs applyAllIndicators and
// applyAllColumnButtons every POLL_INTERVAL_MS for as long as the gradebook is
// open. A MutationObserver would be cheaper, but SlickGrid virtualizes rows and
// recycles cells on scroll, so indicators have to be re-applied continuously.
// Replacing the poll requires probing SlickGrid's live mutation patterns during
// scroll, sort, and filter; guessing wrong makes indicators vanish while
// scrolling, which reads as data loss to a grader. Do not swap this out without
// that probe.

(function () {
    'use strict';

    // =========================================================================
    // CONSTANTS
    // =========================================================================

    const STORAGE_KEY       = 'cpt_review_data';   // single object in chrome.storage.local
    const POLL_INTERVAL_MS  = 1200;

    // Default states — may be extended by user custom states stored in chrome.storage
    const DEFAULT_STATES = {
        NONE:     { emoji: '',   label: 'Not tracked',  color: null    },
        PENDING:  { emoji: '🟡', label: 'Needs Review', color: null    },
        FLAGGED:  { emoji: '🔴', label: 'Needs Action', color: null    },
        REVIEWED: { emoji: '✅', label: 'Reviewed',     color: null    },
    };
    const DEFAULT_CYCLE = ['NONE', 'PENDING', 'FLAGGED', 'REVIEWED'];

    let STATES     = { ...DEFAULT_STATES };
    let STATE_CYCLE = [...DEFAULT_CYCLE];

    // ── Safe SVG dot icon builder ─────────────────────────────────────────────
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
        circle.setAttribute('r',  c - 1);
        circle.setAttribute('fill', String(color));
        svg.appendChild(circle);
        return svg;
    }

    // Extract course ID from URL
    const courseIdMatch = window.location.pathname.match(/\/courses\/(\d+)/);
    if (!courseIdMatch) return;
    const courseId = courseIdMatch[1];

    // =========================================================================
    // STORAGE LAYER
    // chrome.storage.local[STORAGE_KEY] is now namespaced per Canvas instance:
    // {
    //   "<hostname>": {
    //     globalEnabled: true,
    //     courses: { [courseId]: { enabled: bool } },
    //     reviews: { [courseId]: { [studentId_assignmentId]: 'PENDING'|'FLAGGED'|'REVIEWED' } },
    //     customStates: { [key]: { emoji, label, color } },
    //     customCycle: ['NONE','PENDING',...,'CUSTOM_1'],
    //     hints: { [courseId]: true },
    //   },
    //   "<other-hostname>": { ... }
    // }
    //
    // _cache always holds the slice for THIS instance (window.location.hostname
    // / CPT_INSTANCE_KEY). On first load after upgrading from the old flat
    // (non-namespaced) shape, the entire existing object is migrated under the
    // current hostname.
    // =========================================================================

    const INSTANCE_KEY = window.CPT_INSTANCE_KEY || window.location.hostname;

    // Keys that indicate the OLD flat (pre-namespacing) storage shape.
    const LEGACY_TOP_LEVEL_KEYS = ['globalEnabled', 'courses', 'reviews', 'customStates', 'customCycle', 'hints'];

    let _cache = null; // in-memory cache to avoid async on every cell render
    let enrolledStudentIds = null; // fetched once per session via API; null = not yet loaded

    function loadStorage(cb) {
        chrome.storage.local.get(STORAGE_KEY, result => {
            const raw = result[STORAGE_KEY] || {};

            const looksLegacy = LEGACY_TOP_LEVEL_KEYS.some(k => k in raw);
            let allInstances;
            if (looksLegacy) {
                // Migrate: wrap the entire old object under this hostname.
                allInstances = { [INSTANCE_KEY]: raw };
                chrome.storage.local.set({ [STORAGE_KEY]: allInstances });
            } else {
                allInstances = raw;
            }

            _cache = allInstances[INSTANCE_KEY] || {};
            if (cb) cb(_cache);
        });
    }

    function saveStorage(cb) {
        chrome.storage.local.get(STORAGE_KEY, result => {
            const allInstances = result[STORAGE_KEY] || {};
            allInstances[INSTANCE_KEY] = _cache;
            chrome.storage.local.set({ [STORAGE_KEY]: allInstances }, cb);
        });
    }

    function getCache() {
        return _cache || {};
    }

    // ── Global enabled ────────────────────────────────────────────────────────
    function isGlobalEnabled() {
        return getCache().globalEnabled !== false; // default true
    }

    // ── Course enabled ────────────────────────────────────────────────────────
    function isCourseEnabled(id) {
        const courses = getCache().courses || {};
        return courses[id] ? courses[id].enabled === true : false;
    }

    function setCourseEnabled(id, enabled) {
        if (!_cache.courses) _cache.courses = {};
        if (!_cache.courses[id]) _cache.courses[id] = {};
        _cache.courses[id].enabled = enabled;
        saveStorage();
    }

    // ── Review state ──────────────────────────────────────────────────────────
    function reviewKey(studentId, assignmentId) {
        return `${studentId}_${assignmentId}`;
    }

    function getReviewState(studentId, assignmentId) {
        const reviews = (getCache().reviews || {})[courseId] || {};
        return reviews[reviewKey(studentId, assignmentId)] || 'NONE';
    }

    function setReviewState(studentId, assignmentId, state) {
        if (!_cache.reviews) _cache.reviews = {};
        if (!_cache.reviews[courseId]) _cache.reviews[courseId] = {};
        const key = reviewKey(studentId, assignmentId);
        if (state === 'NONE') {
            delete _cache.reviews[courseId][key];
        } else {
            _cache.reviews[courseId][key] = state;
        }
        saveStorage();
    }

    // ── Custom states ─────────────────────────────────────────────────────────
    function loadCustomStates() {
        const custom = getCache().customStates || {};
        const cycle  = getCache().customCycle  || DEFAULT_CYCLE;
        STATES      = { ...DEFAULT_STATES, ...custom };
        STATE_CYCLE = cycle.filter(k => STATES[k] !== undefined);
        if (!STATE_CYCLE.includes('NONE')) STATE_CYCLE.unshift('NONE');
    }

    // ── Hint seen — stored in chrome.storage.local (not localStorage) ─────────
    function hasSeenHint() {
        return !!((getCache().hints || {})[courseId]);
    }
    function markHintSeen(cb) {
        if (!_cache.hints) _cache.hints = {};
        _cache.hints[courseId] = true;
        saveStorage(cb);
    }
    function clearHintSeen() {
        if (_cache.hints) delete _cache.hints[courseId];
        saveStorage();
    }

    // =========================================================================
    // CELL IDENTIFICATION
    // =========================================================================

    function getCellIds(cell) {
        let el = cell, assignmentId = null, studentId = null;
        while (el && el !== document.body) {
            if (!assignmentId && el.dataset.assignmentId) assignmentId = el.dataset.assignmentId;
            if (!studentId    && el.dataset.studentId)    studentId    = el.dataset.studentId;
            if (assignmentId && studentId) break;
            el = el.parentElement;
        }
        if (!assignmentId) {
            const m = (cell.className || '').match(/\bassignment[_-](\d+)\b/);
            if (m) assignmentId = m[1];
        }
        if (!studentId) {
            let row = cell;
            while (row && !row.classList.contains('slick-row') && row !== document.body) row = row.parentElement;
            if (row) {
                const m = (row.className || '').match(/\bstudent[_-](\d+)\b/);
                if (m) studentId = m[1];
                if (!studentId && row.dataset.studentId) studentId = row.dataset.studentId;
            }
        }
        return { studentId, assignmentId };
    }

    // =========================================================================
    // INDICATOR OVERLAY
    // =========================================================================

    function ensureOverlay(cell, studentId, assignmentId) {
        if (!assignmentId || !studentId) return;
        let overlay = cell.querySelector('.cpt-review-indicator');
        if (!overlay) {
            overlay = document.createElement('span');
            overlay.className = 'cpt-review-indicator';
            overlay.style.cssText = [
                'display: inline-flex', 'align-items: center', 'justify-content: center',
                'font-size: 13px', 'line-height: 1',
                'pointer-events: auto', 'z-index: 10', 'user-select: none',
                'cursor: pointer', 'min-width: 16px', 'min-height: 16px',
            ].join(';');
            overlay.title = 'Set review status';
            overlay.addEventListener('click', e => {
                e.stopPropagation();
                if (contextMenu && contextMenu._anchor === overlay) {
                    removeContextMenu();
                    return;
                }
                buildContextMenu(overlay, studentId, assignmentId);
            });
            overlay.addEventListener('mouseenter', () => { overlay.style.opacity = '1'; });
            overlay.addEventListener('mouseleave', () => {
                if (!overlay._hasState) overlay.style.opacity = '0.35';
            });
            // Inject into the start container if present; fall back to cell root
            const startContainer = cell.querySelector('.Grid__GradeCell__StartContainer');
            const target = startContainer || cell;
            if (!startContainer && window.getComputedStyle(cell).position === 'static') {
                cell.style.position = 'relative';
            }
            target.appendChild(overlay);
        }
        const state = getReviewState(studentId, assignmentId);
        if (overlay._renderedState === state) return; // nothing changed — skip all DOM writes
        overlay._renderedState = state;

        const def   = STATES[state];
        if (!def || state === 'NONE') {
            overlay._hasState    = false;
            overlay.style.opacity = '0.35';
            overlay.title        = 'Set review status';
            overlay.innerHTML    = `<svg width="11" height="11" viewBox="0 0 11 11" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;"><line x1="5.5" y1="1" x2="5.5" y2="10" stroke="#6b7780" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="5.5" x2="10" y2="5.5" stroke="#6b7780" stroke-width="1.5" stroke-linecap="round"/></svg>`;
            overlay.style.color  = '';
        } else if (def.emoji) {
            overlay._hasState    = true;
            overlay.style.opacity = '1';
            overlay.innerHTML    = '';
            overlay.textContent  = def.emoji;
            overlay.title        = def.label;
            overlay.style.color  = '';
        } else {
            // No emoji — render an SVG circle sized to match emoji visually
            const color = def.color || '#3498db';
            overlay._hasState    = true;
            overlay.style.opacity = '1';
            overlay.replaceChildren(buildDotIcon(color, 13));
            overlay.title     = def.label;
            overlay.style.color = '';
        }
    }

    function applyAllIndicators() {
        if (!isGlobalEnabled() || !isCourseEnabled(courseId)) return;
        const cells = document.querySelectorAll('.slick-cell.editable, .slick-cell[class*="assignment"]');
        cells.forEach(cell => {
            const { studentId, assignmentId } = getCellIds(cell);
            if (studentId && assignmentId) ensureOverlay(cell, studentId, assignmentId);
        });
    }

    function removeAllIndicators() {
        document.querySelectorAll('.cpt-review-indicator').forEach(el => el.remove());
    }

    // =========================================================================
    // TOAST
    // =========================================================================

    function showToast(message, type = 'info', durationMs = 3500) {
        const existing = document.getElementById('cpt-review-toast');
        if (existing) existing.remove();
        const colors = {
            info:    { bg: '#2d3b45', border: '#4a6070' },
            success: { bg: '#1a7d44', border: '#27ae60' },
            error:   { bg: '#a93226', border: '#c0392b' },
        };
        const c = colors[type] || colors.info;
        const toast = document.createElement('div');
        toast.id = 'cpt-review-toast';
        toast.style.cssText = [
            'position: fixed', 'bottom: 24px', 'left: 50%',
            'transform: translateX(-50%) translateY(12px)',
            'background: ' + c.bg, 'color: #fff',
            'border: 1px solid ' + c.border, 'border-radius: 6px',
            'padding: 10px 20px', 'font-family: Lato, sans-serif',
            'font-size: 13px', 'z-index: 999999',
            'box-shadow: 0 4px 16px rgba(0,0,0,0.25)',
            'opacity: 0', 'transition: opacity 0.2s ease, transform 0.2s ease',
            'pointer-events: none', 'white-space: nowrap',
        ].join(';');
        toast.textContent = message;
        document.body.appendChild(toast);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            toast.style.opacity   = '1';
            toast.style.transform = 'translateX(-50%) translateY(0)';
        }));
        setTimeout(() => {
            toast.style.opacity   = '0';
            toast.style.transform = 'translateX(-50%) translateY(12px)';
            setTimeout(() => toast.remove(), 220);
        }, durationMs);
    }

    // =========================================================================
    // DISCOVERABILITY HINT — first-run modal
    // Shown only the first time a course is enabled. Stored in chrome.storage.local
    // so it persists across browser sessions and profiles.
    // =========================================================================

    function showDiscoverabilityHint() {
        if (hasSeenHint()) return;
        if (document.getElementById('cpt-review-hint-backdrop')) return;

        // ── Backdrop ──────────────────────────────────────────────────────────
        const backdrop = document.createElement('div');
        backdrop.id = 'cpt-review-hint-backdrop';
        backdrop.style.cssText = [
            'position: fixed', 'inset: 0',
            'background: rgba(0,0,0,0.45)',
            'z-index: 999999',
            'display: flex', 'align-items: center', 'justify-content: center',
            'opacity: 0', 'transition: opacity 0.25s ease',
        ].join(';');

        // ── Dialog ────────────────────────────────────────────────────────────
        const dialog = document.createElement('div');
        dialog.style.cssText = [
            'background: #fff', 'border-radius: 8px',
            'padding: 24px 26px 20px',
            'max-width: 400px', 'width: 90%',
            'box-shadow: 0 4px 24px rgba(0,0,0,0.25)',
            'font-family: Lato, sans-serif', 'color: #2d3b45',
            'position: relative',
        ].join(';');
        dialog.addEventListener('click', e => e.stopPropagation());

        // ── Close button ──────────────────────────────────────────────────────
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.title = 'Dismiss';
        closeBtn.style.cssText = [
            'position: absolute', 'top: 10px', 'right: 12px',
            'background: none', 'border: none', 'font-size: 15px',
            'cursor: pointer', 'color: #8a9bb0', 'line-height: 1',
            'padding: 2px 4px', 'border-radius: 3px',
        ].join(';');
        closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#2d3b45'; });
        closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = '#8a9bb0'; });

        // ── Title ─────────────────────────────────────────────────────────────
        const title = document.createElement('div');
        title.style.cssText = 'font-size:15px;font-weight:700;color:#0770a3;margin-bottom:14px;padding-right:20px;';
        title.textContent = '📊 Review Tracker is ON';

        // ── Tips list ─────────────────────────────────────────────────────────
        const tips = [
            { icon: '🖱', heading: 'Mark a cell', body: 'Click the indicator icon on any grade cell to set a review status.' },
            { icon: '📋', heading: 'Mark a column', body: 'Click the ≡ button in a column header to mark all students in that column at once.' },
            { icon: '📥', heading: 'Submission tray', body: 'Open a cell\'s tray — a Review Status badge appears below the status section.' },
            { icon: '⚡', heading: 'SpeedGrader', body: 'A badge appears in the grade area and syncs back to the gradebook.' },
        ];

        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-bottom:16px;';

        tips.forEach(tip => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:10px;align-items:flex-start;';

            const iconEl = document.createElement('span');
            iconEl.textContent = tip.icon;
            iconEl.style.cssText = 'font-size:16px;line-height:1.4;flex-shrink:0;';

            const textEl = document.createElement('div');
            textEl.style.cssText = 'font-size:12px;line-height:1.5;';
            const headingEl = document.createElement('strong');
            headingEl.textContent = tip.heading;
            textEl.appendChild(headingEl);
            textEl.appendChild(document.createTextNode(' — ' + tip.body));

            row.appendChild(iconEl);
            row.appendChild(textEl);
            list.appendChild(row);
        });

        // ── Footer note ───────────────────────────────────────────────────────
        const note = document.createElement('div');
        note.style.cssText = 'font-size:11px;color:#8a9bb0;margin-bottom:14px;';
        note.textContent = 'Find more tips in the ▾ menu → Tips & Help';

        // ── Got it button ─────────────────────────────────────────────────────
        const gotItBtn = document.createElement('button');
        gotItBtn.style.cssText = [
            'width: 100%', 'padding: 8px 14px',
            'font-size: 13px', 'font-family: Lato, sans-serif',
            'border-radius: 4px', 'border: none',
            'background: #0770a3', 'color: #fff',
            'cursor: pointer', 'font-weight: 600',
        ].join(';');

        gotItBtn.textContent = 'Got it';

        // ── Dismiss logic ─────────────────────────────────────────────────────
        function dismiss() {
            backdrop.style.opacity = '0';
            setTimeout(() => backdrop.remove(), 260);
            markHintSeen();
        }

        gotItBtn.addEventListener('click', dismiss);
        closeBtn.addEventListener('click', dismiss);
        backdrop.addEventListener('click', dismiss);

        // ── Assemble ──────────────────────────────────────────────────────────
        dialog.appendChild(closeBtn);
        dialog.appendChild(title);
        dialog.appendChild(list);
        dialog.appendChild(note);
        dialog.appendChild(gotItBtn);
        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);

        requestAnimationFrame(() => requestAnimationFrame(() => {
            backdrop.style.opacity = '1';
        }));

        // Dismiss on Escape
        const escHandler = e => {
            if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', escHandler); }
        };
        document.addEventListener('keydown', escHandler);
    }

    // =========================================================================
    // CONTEXT MENU — shared builder helpers
    // =========================================================================

    let contextMenu = null;

    function removeContextMenu() {
        if (contextMenu) { contextMenu.remove(); contextMenu = null; }
    }

    function dismissContextMenuOnClick(e) {
        // If the click is on the element that opened the menu, let its own
        // handler manage the toggle — don't pre-empt it here.
        if (contextMenu && contextMenu._anchor && contextMenu._anchor.contains(e.target)) return;
        removeContextMenu();
    }

    function menuHeader(text) {
        const h = document.createElement('div');
        h.textContent = text;
        h.style.cssText = [
            'padding: 6px 12px', 'font-weight: bold', 'color: #555',
            'border-bottom: 1px solid #e8eaec', 'background: #f5f5f5',
            'font-size: 11px', 'text-transform: uppercase', 'letter-spacing: 0.5px',
        ].join(';');
        return h;
    }

    function menuItem(emojiText, labelText, isCurrent, onClick, color) {
        const item = document.createElement('div');
        item.style.cssText = [
            'padding: 7px 12px', 'cursor: pointer', 'display: flex',
            'align-items: center', 'gap: 8px',
            isCurrent ? 'background: #e8f0fe; font-weight: bold;' : '',
        ].join(';');
        const es = document.createElement('span');
        es.style.cssText = 'width:16px;display:inline-block;text-align:center;vertical-align:middle;';
        if (emojiText) {
            es.textContent = emojiText;
        } else if (color) {
            es.replaceChildren(buildDotIcon(color, 12));
        } else {
            es.textContent = '○';
        }
        const ls = document.createElement('span');
        ls.textContent = labelText;
        item.appendChild(es); item.appendChild(ls);
        item.addEventListener('mouseenter', () => { if (!isCurrent) item.style.background = '#f0f4ff'; });
        item.addEventListener('mouseleave', () => { if (!isCurrent) item.style.background = ''; });
        item.addEventListener('click', onClick);
        return item;
    }

    function baseMenu(x, y, minWidth = 180) {
        const menu = document.createElement('div');
        menu.id = 'cpt-review-context-menu';
        menu.style.cssText = [
            'position: fixed', `left: ${x}px`, `top: ${y}px`,
            'background: #fff', 'border: 1px solid #c7cdd1',
            'border-radius: 4px', 'box-shadow: 0 2px 8px rgba(0,0,0,0.18)',
            'z-index: 99999', 'font-family: Lato, sans-serif',
            'font-size: 13px', `min-width: ${minWidth}px`, 'overflow: hidden',
        ].join(';');
        return menu;
    }

    // =========================================================================
    // CELL CONTEXT MENU
    // =========================================================================

    function buildContextMenu(anchorEl, studentId, assignmentId) {
        removeContextMenu();
        const anchor = anchorEl.getBoundingClientRect();
        const x = anchor.left;
        const y = anchor.bottom + 4;
        const menu = baseMenu(x, y);
        menu.appendChild(menuHeader('Review Status'));
        const current = getReviewState(studentId, assignmentId);
        STATE_CYCLE.forEach(key => {
            const s = STATES[key] || {};
            menu.appendChild(menuItem(
                s.emoji, s.label, key === current,
                () => {
                    setReviewState(studentId, assignmentId, key);
                    applyAllIndicators();
                    removeContextMenu();
                },
                s.color
            ));
        });
        document.body.appendChild(menu);
        contextMenu = menu;
        contextMenu._anchor = anchorEl;
        const rect = menu.getBoundingClientRect();
        if (rect.right  > window.innerWidth)  menu.style.left = `${x - rect.width}px`;
        if (rect.bottom > window.innerHeight)  menu.style.top  = `${anchor.top - rect.height}px`;
    }

    // =========================================================================
    // COLUMN HEADER IDENTIFICATION & BULK SET
    // =========================================================================

    function getAssignmentIdFromHeader(el) {
        let target = el;
        while (target && target !== document.body) {
            if (target.dataset.id) {
                const m = target.dataset.id.match(/^assignment[_-](\d+)$/);
                if (m) return m[1];
            }
            if (target.id) {
                const m = target.id.match(/assignment[_-](\d+)/);
                if (m) return m[1];
            }
            const cm = (target.className || '').match(/\bassignment[_-](\d+)\b/);
            if (cm) return cm[1];
            if (target.classList && target.classList.contains('slick-header-column')) break;
            target = target.parentElement;
        }
        return null;
    }

    function bulkSetColumn(assignmentId, state) {
        let count = 0;

        if (enrolledStudentIds && enrolledStudentIds.size > 0) {
            // Use the full enrollment list so off-screen students are included
            enrolledStudentIds.forEach(studentId => {
                setReviewState(studentId, assignmentId, state);
                count++;
            });
        } else {
            // Fallback: only visible DOM cells (enrollment fetch not ready or failed)
            const cells = document.querySelectorAll('.slick-cell.editable, .slick-cell[class*="assignment"]');
            cells.forEach(cell => {
                const ids = getCellIds(cell);
                if (ids.assignmentId === assignmentId && ids.studentId) {
                    setReviewState(ids.studentId, assignmentId, state);
                    count++;
                }
            });
        }

        applyAllIndicators();
        const s = STATES[state];
        const scope = (enrolledStudentIds && enrolledStudentIds.size > 0) ? 'all' : 'visible';
        showToast(
            `${s.emoji || '○'} Marked ${count} ${scope} student${count !== 1 ? 's' : ''} as "${s.label}".` +
            (scope === 'visible' ? ' Scroll to mark more.' : ''),
            state === 'NONE' ? 'info' : 'success'
        );
    }

    // =========================================================================
    // COLUMN HEADER CONTEXT MENU
    // =========================================================================

    function buildColumnContextMenu(anchorEl, assignmentId) {
        removeContextMenu();
        const anchor = anchorEl.getBoundingClientRect();
        const x = anchor.left;
        const y = anchor.bottom + 4;
        const menu = baseMenu(x, y, 200);
        menu.appendChild(menuHeader('Mark Entire Column'));
        STATE_CYCLE.forEach(key => {
            const s = STATES[key] || {};
            menu.appendChild(menuItem(
                s.emoji, `Set all to: ${s.label}`, false,
                () => { bulkSetColumn(assignmentId, key); removeContextMenu(); },
                s.color
            ));
        });
        document.body.appendChild(menu);
        contextMenu = menu;
        contextMenu._anchor = anchorEl;
        const rect = menu.getBoundingClientRect();
        if (rect.right  > window.innerWidth)  menu.style.left = `${x - rect.width}px`;
        if (rect.bottom > window.innerHeight)  menu.style.top  = `${anchor.top - rect.height}px`;
    }

    // =========================================================================
    // COLUMN HEADER BULK BUTTON
    // Injects a small clickable icon into .Gradebook__ColumnHeaderIndicators
    // for each assignment column. Clicking it opens the bulk-set dropdown.
    // Replaces the old right-click header listener entirely.
    // =========================================================================

    function ensureColumnButton(headerEl, assignmentId) {
        const container = headerEl.querySelector('.Gradebook__ColumnHeaderIndicators');
        if (!container) return;
        if (container.querySelector('.cpt-col-bulk-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'cpt-col-bulk-btn';
        btn.type  = 'button';
        btn.title = 'Mark entire column';
        btn.style.cssText = [
            'display: inline-flex', 'align-items: center', 'justify-content: center',
            'width: 20px', 'height: 20px',
            'padding: 0', 'margin: 0 1px',
            'background: none', 'border: none',
            'border-radius: 3px', 'cursor: pointer',
            'color: #6b7780', 'opacity: 0.7',
            'vertical-align: middle', 'flex-shrink: 0',
        ].join(';');
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="2" width="10" height="1.5" rx="0.75" fill="currentColor"/>
            <rect x="1" y="5.25" width="10" height="1.5" rx="0.75" fill="currentColor"/>
            <rect x="1" y="8.5" width="10" height="1.5" rx="0.75" fill="currentColor"/>
        </svg>`;

        btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; btn.style.background = '#e8eaec'; });
        btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.7'; btn.style.background = 'none'; });
        btn.addEventListener('click', e => {
            e.stopPropagation();
            if (contextMenu && contextMenu._anchor === btn) {
                removeContextMenu();
                return;
            }
            buildColumnContextMenu(btn, assignmentId);
        });

        container.appendChild(btn);
    }

    function applyAllColumnButtons() {
        if (!isGlobalEnabled() || !isCourseEnabled(courseId)) return;
        document.querySelectorAll('.slick-header-column').forEach(headerEl => {
            const assignmentId = getAssignmentIdFromHeader(headerEl);
            if (assignmentId) ensureColumnButton(headerEl, assignmentId);
        });
    }

    function removeAllColumnButtons() {
        document.querySelectorAll('.cpt-col-bulk-btn').forEach(el => el.remove());
    }

    // =========================================================================
    // HELP PANEL
    // =========================================================================

    function showHelpPanel() {
        const existing = document.getElementById('cpt-review-help-panel');
        if (existing) { existing.remove(); return; }
        const backdrop = document.createElement('div');
        backdrop.id = 'cpt-review-help-panel';
        backdrop.style.cssText = [
            'position: fixed', 'inset: 0', 'background: rgba(0,0,0,0.45)',
            'z-index: 999999', 'display: flex', 'align-items: center', 'justify-content: center',
        ].join(';');
        const panel = document.createElement('div');
        panel.style.cssText = [
            'background: #fff', 'border-radius: 8px', 'padding: 28px 32px',
            'max-width: 480px', 'width: 90%', 'box-shadow: 0 4px 24px rgba(0,0,0,0.22)',
            'font-family: Lato, sans-serif', 'font-size: 13px', 'color: #2d3b45',
            'line-height: 1.6', 'position: relative',
        ].join(';');
        panel.addEventListener('click', e => e.stopPropagation());
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = [
            'position: absolute', 'top: 12px', 'right: 14px', 'background: none',
            'border: none', 'font-size: 16px', 'cursor: pointer', 'color: #888', 'line-height: 1',
        ].join(';');
        closeBtn.addEventListener('click', () => backdrop.remove());
        const title = document.createElement('div');
        title.textContent = '💡 Review Tracker — Tips & Help';
        title.style.cssText = 'font-size: 15px; font-weight: bold; margin-bottom: 18px; color: #0770a3;';
        const sections = [
            { heading: '🖱 Marking individual cells', body: 'Click the indicator icon on any grade cell to set its review status. Choose from your available states. Select "Not tracked" to clear a cell.' },
            { heading: '📋 Marking an entire column', body: 'Click the ≡ button in a column header to mark all students in that column at once. The button appears in the header\'s indicator area next to Canvas\'s own icons.' },
            { heading: '📥 Submission tray', body: 'Click a grade cell to open the submission tray. A Review Status badge appears below the Status section — click it to change the state for that student and assignment. Use the carousel arrows to navigate between students and assignments without closing the tray.' },
            { heading: '⚡ SpeedGrader', body: 'A Review Status badge appears in the grade area of SpeedGrader. Click it to mark the current student\'s submission. The badge updates automatically as you navigate between students and syncs back to the gradebook.' },
            { heading: '⏸ Paused state', body: 'If you see the tracker in a paused state, global tracking is off. All your data is preserved — re-enable global tracking from the extension popup to resume.' },
            { heading: '📤 Export & Import', body: 'Use the ▾ menu → "Export course data" to download a backup of your review markers as a JSON file. Use "Import course data" to restore a previous export — you will be asked to confirm before any data is overwritten.' },
        ];
        sections.forEach((s, i) => {
            const block = document.createElement('div');
            block.style.cssText = [i > 0 ? 'margin-top:14px;padding-top:14px;border-top:1px solid #e8eaec;' : ''].join('');
            const h = document.createElement('div');
            h.textContent = s.heading; h.style.cssText = 'font-weight:bold;margin-bottom:4px;';
            const p = document.createElement('div');
            p.textContent = s.body; p.style.color = '#555';
            block.appendChild(h); block.appendChild(p); panel.appendChild(block);
        });
        panel.insertBefore(closeBtn, panel.firstChild);
        panel.insertBefore(title, panel.firstChild);
        backdrop.appendChild(panel);
        backdrop.addEventListener('click', () => backdrop.remove());
        const escHandler = e => { if (e.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', escHandler); } };
        document.addEventListener('keydown', escHandler);
        document.body.appendChild(backdrop);
    }

    // =========================================================================
    // CUSTOM CONFIRM DIALOG (page-level, no browser dialogs)
    // Returns a Promise<boolean>.
    // =========================================================================

    function pageConfirm(title, body, confirmLabel = 'Confirm', danger = false) {
        return new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.style.cssText = [
                'position: fixed', 'inset: 0', 'background: rgba(0,0,0,0.45)',
                'z-index: 9999999', 'display: flex', 'align-items: center', 'justify-content: center',
            ].join(';');

            const dialog = document.createElement('div');
            dialog.style.cssText = [
                'background: #fff', 'border-radius: 8px', 'padding: 22px 24px 18px',
                'max-width: 360px', 'width: 90%', 'box-shadow: 0 4px 24px rgba(0,0,0,0.25)',
                'font-family: Lato, sans-serif', 'color: #2d3b45',
            ].join(';');
            dialog.addEventListener('click', e => e.stopPropagation());

            const titleEl = document.createElement('div');
            titleEl.textContent = title;
            titleEl.style.cssText = 'font-size:14px;font-weight:700;margin-bottom:8px;';

            const bodyEl = document.createElement('div');
            bodyEl.textContent = body;
            bodyEl.style.cssText = 'font-size:12px;color:#4a6070;line-height:1.5;margin-bottom:18px;';

            const actions = document.createElement('div');
            actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.cssText = 'padding:6px 14px;font-size:12px;font-family:Lato,sans-serif;border-radius:4px;border:1px solid #c7cdd1;background:#fff;color:#2d3b45;cursor:pointer;';
            cancelBtn.addEventListener('click', () => { backdrop.remove(); resolve(false); });

            const confirmBtn = document.createElement('button');
            confirmBtn.textContent = confirmLabel;
            confirmBtn.style.cssText = `padding:6px 14px;font-size:12px;font-family:Lato,sans-serif;border-radius:4px;border:none;background:${danger ? '#c0392b' : '#0770a3'};color:#fff;cursor:pointer;`;
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

    // =========================================================================
    // EXPORT / IMPORT (course-scoped)
    // =========================================================================

    function exportCourseData() {
        const reviews = (getCache().reviews || {})[courseId] || {};
        if (Object.keys(reviews).length === 0) {
            showToast('No review data found for this course to export.', 'info');
            return;
        }
        const payload = { courseId, exported: new Date().toISOString(), reviews };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `review-tracker-course-${courseId}-${new Date().toISOString().slice(0,10)}.json`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(`✅ Exported ${Object.keys(reviews).length} review entries.`, 'success');
    }

    async function importCourseData() {
        const ok = await pageConfirm(
            'Import Course Data?',
            'This will overwrite any existing markers for this course. Cannot be undone.',
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
                    if (!payload.reviews || typeof payload.reviews !== 'object') {
                        showToast('❌ Invalid file format.', 'error', 5000); return;
                    }
                    if (!_cache.reviews) _cache.reviews = {};
                    _cache.reviews[courseId] = payload.reviews;
                    saveStorage(() => { applyAllIndicators(); });
                    showToast(`✅ Imported review data successfully.`, 'success');
                } catch (err) {
                    showToast('❌ Could not read file.', 'error', 5000);
                }
            };
            reader.readAsText(file);
        });
        input.click();
    }

    function clearCourseData() {
        if (!_cache.reviews) _cache.reviews = {};
        delete _cache.reviews[courseId];
        if (!_cache.courses) _cache.courses = {};
        if (_cache.courses[courseId]) delete _cache.courses[courseId];
        clearHintSeen();
        saveStorage();
    }

    // =========================================================================
    // TOOLBAR SPLIT BUTTON + DROPDOWN
    // =========================================================================

    function injectToolbarButton() {
        if (document.getElementById('cpt-review-wrapper')) return;
        const actionsDiv = document.getElementById('gradebook-actions');
        if (!actionsDiv) return false;

        // InstUI-matched token values from computed styles on Canvas's own toolbar buttons
        const FONT       = 'LatoWeb, "Lato Extended", Lato, "Helvetica Neue", Helvetica, Arial, sans-serif';
        const FONT_SIZE  = '16px';
        const FONT_WT    = '400';
        const LINE_H     = '18px';
        const HEIGHT     = '37.6px';
        const RADIUS     = '4px';
        const BORDER     = '0.8px solid rgb(215, 218, 222)';
        const BG         = 'rgb(242, 244, 244)';
        const BG_HOVER   = 'rgb(228, 232, 232)';
        const BG_CHEV    = 'rgb(228, 232, 232)';
        const BG_CHEV_HV = 'rgb(215, 218, 222)';
        const COLOR      = 'rgb(39, 53, 64)';
        const DIVIDER    = 'rgb(215, 218, 222)';
        const SWITCH_ON  = '#0B874B'; // Canvas success green
        const SWITCH_OFF = 'rgb(215, 218, 222)';
        const PAUSE_CLR  = '#f39c12';
        const PAD_H      = '12px';

        // Shared style builder for both button halves
        function halfStyle(extraCss) {
            return [
                'display:inline-flex', 'align-items:center',
                `height:${HEIGHT}`, 'box-sizing:border-box',
                `font-family:${FONT}`, `font-size:${FONT_SIZE}`,
                `font-weight:${FONT_WT}`, `line-height:${LINE_H}`,
                'border:none', 'cursor:pointer', 'white-space:nowrap',
                'transition:background 0.12s',
                ...(extraCss || [])
            ].join(';');
        }

        // ── Wrapper ───────────────────────────────────────────────────────────
        const wrapper = document.createElement('span');
        wrapper.id = 'cpt-review-wrapper';
        wrapper.style.cssText = [
            'display:inline-flex', 'align-items:stretch',
            'margin-right:8px', 'vertical-align:middle',
            'position:relative',
            `border-radius:${RADIUS}`, `border:${BORDER}`,
            `height:${HEIGHT}`, 'box-sizing:border-box',
        ].join(';');

        // ── Toggle switch track + thumb ───────────────────────────────────────
        // Both carry ids because the popup 'reload' handler has to find them
        // again to repaint the switch. It previously located the track with
        // wrapper.querySelector('span[style*="border-radius:8px"]'), matching a
        // CSS declaration inside the style attribute - which meant it needed a
        // second selector variant for the spaced form, and would have broken
        // silently on any restyle. 'border-radius: 8px' appears on four other
        // elements in this file.
        const switchTrack = document.createElement('span');
        switchTrack.id = 'cpt-review-switch-track';
        switchTrack.style.cssText = [
            'display:inline-flex', 'align-items:center',
            'width:28px', 'height:16px', 'border-radius:8px',
            `background:${SWITCH_OFF}`,
            'flex-shrink:0', 'position:relative',
            'transition:background 0.18s', 'pointer-events:none',
        ].join(';');

        const switchThumb = document.createElement('span');
        switchThumb.id = 'cpt-review-switch-thumb';
        switchThumb.style.cssText = [
            'position:absolute', 'left:2px', 'top:2px',
            'width:12px', 'height:12px', 'border-radius:50%',
            'background:#fff', 'transition:left 0.18s', 'pointer-events:none',
        ].join(';');
        switchTrack.appendChild(switchThumb);

        // ── Left button: switch + label ───────────────────────────────────────
        const toggleBtn = document.createElement('button');
        toggleBtn.id   = 'cpt-review-toggle-btn';
        toggleBtn.type = 'button';
        toggleBtn.style.cssText = halfStyle([`padding:0 ${PAD_H}`, `background:${BG}`, `color:${COLOR}`, 'gap:8px', `border-radius:${RADIUS} 0 0 ${RADIUS}`]);

        const labelSpan = document.createElement('span');
        labelSpan.textContent = 'Review Tracker';

        toggleBtn.appendChild(switchTrack);
        toggleBtn.appendChild(labelSpan);

        // ── Divider ───────────────────────────────────────────────────────────
        const dividerEl = document.createElement('span');
        dividerEl.style.cssText = `width:1px;background:${DIVIDER};align-self:stretch;flex-shrink:0;`;

        // ── Chevron button ────────────────────────────────────────────────────
        const chevronBtn = document.createElement('button');
        chevronBtn.id    = 'cpt-review-chevron-btn';
        chevronBtn.type  = 'button';
        chevronBtn.title = 'Review Tracker options';
        chevronBtn.style.cssText = halfStyle([`padding:0 10px`, `background:${BG_CHEV}`, `color:${COLOR}`, `border-radius:0 ${RADIUS} ${RADIUS} 0`]);
        chevronBtn.innerHTML = `<svg width="10" height="7" viewBox="0 0 10 7" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1 1.5l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

        // ── Dropdown ──────────────────────────────────────────────────────────
        const dropdown = document.createElement('div');
        dropdown.id = 'cpt-review-dropdown';
        dropdown.style.cssText = [
            'display:none', 'position:absolute',
            'top:calc(100% + 4px)', 'right:0',
            'background:rgb(255, 255, 255)',
            'border:0.8px solid rgb(141, 149, 159)',
            `border-radius:${RADIUS}`,
            'box-shadow:rgba(0,0,0,0.2) 0px 1px 2px 0px, rgba(0,0,0,0.1) 0px 2px 8px 0px',
            'z-index:99998', 'min-width:200px', 'overflow:hidden',
            `font-family:${FONT}`, `font-size:${FONT_SIZE}`,
            'padding:8px 0',
        ].join(';');

        function makeItem(text, onClick, danger) {
            const item = document.createElement('div');
            item.textContent = text;
            item.style.cssText = [
                'padding:8px 12px', 'cursor:pointer', 'white-space:nowrap',
                `color:${danger ? '#c0392b' : COLOR}`,
                `font-family:${FONT}`, `font-size:${FONT_SIZE}`,
                'line-height:20px', 'height:36px',
                'display:flex', 'align-items:center',
                'box-sizing:border-box',
            ].join(';');
            item.addEventListener('mouseenter', () => { item.style.background = danger ? '#fff5f5' : 'rgb(242, 244, 244)'; });
            item.addEventListener('mouseleave', () => { item.style.background = 'rgb(255, 255, 255)'; });
            item.addEventListener('click', () => { closeDropdown(); onClick(); });
            return item;
        }

        function makeDivider() {
            const d = document.createElement('div');
            d.style.cssText = 'border-top:0.8px solid rgb(215, 218, 222);margin:8px 0;';
            return d;
        }

        dropdown.appendChild(makeItem('💡 Tips & Help', showHelpPanel));
        dropdown.appendChild(makeDivider());
        dropdown.appendChild(makeItem('📤 Export course data', exportCourseData));
        dropdown.appendChild(makeItem('📥 Import course data', importCourseData));
        dropdown.appendChild(makeDivider());
        dropdown.appendChild(makeItem('🗑 Clear course data', async () => {
            const ok = await pageConfirm(
                'Clear Course Data?',
                'This will remove all markers for this course and reset the tracker to OFF. Cannot be undone.',
                'Clear', true
            );
            if (!ok) return;
            stopTracking(); clearCourseData(); updateLabel();
            showToast('🗑 Course review data cleared.', 'info');
        }, true));

        function openDropdown()  { dropdown.style.display = 'block'; }
        function closeDropdown() { dropdown.style.display = 'none';  }
        function isOpen()        { return dropdown.style.display !== 'none'; }

        chevronBtn.addEventListener('click', e => { e.stopPropagation(); isOpen() ? closeDropdown() : openDropdown(); });
        document.addEventListener('click', e => { if (!wrapper.contains(e.target)) closeDropdown(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDropdown(); });

        // ── State update ──────────────────────────────────────────────────────
        function updateLabel() {
            const globalOn = isGlobalEnabled();
            const courseOn = isCourseEnabled(courseId);
            const on       = globalOn && courseOn;
            const paused   = !globalOn && courseOn;

            if (paused) {
                switchTrack.style.background = PAUSE_CLR;
                switchThumb.style.left       = '13px';
                toggleBtn.title  = 'Global tracking is paused. Click the extension icon to re-enable.';
                toggleBtn.style.cursor  = 'not-allowed';
                toggleBtn.style.opacity = '0.8';
            } else {
                switchTrack.style.background = on ? SWITCH_ON : SWITCH_OFF;
                switchThumb.style.left       = on ? '13px' : '2px';
                toggleBtn.title  = on
                    ? 'Review Tracker is ON — click cell indicators to mark. Click to disable.'
                    : 'Review Tracker is OFF for this course. Click to enable.';
                toggleBtn.style.cursor  = 'pointer';
                toggleBtn.style.opacity = '1';
            }
        }

        // ── Toggle click ──────────────────────────────────────────────────────
        toggleBtn.addEventListener('click', () => {
            if (!isGlobalEnabled()) return;
            closeDropdown();
            const nowEnabled = !isCourseEnabled(courseId);

            if (!_cache.courses)           _cache.courses = {};
            if (!_cache.courses[courseId]) _cache.courses[courseId] = {};
            _cache.courses[courseId].enabled = nowEnabled;

            if (nowEnabled) {
                const existingName = (_cache.courses[courseId] || {}).name;
                if (!existingName) {
                    const name = getCourseName();
                    if (name) _cache.courses[courseId].name = name;
                }
            }

            saveStorage();
            updateLabel();
            nowEnabled ? initTracking() : stopTracking();
        });

        // ── Hover states ──────────────────────────────────────────────────────
        toggleBtn.addEventListener('mouseenter',   () => { toggleBtn.style.background   = BG_HOVER; });
        toggleBtn.addEventListener('mouseleave',   () => { toggleBtn.style.background   = BG; });
        chevronBtn.addEventListener('mouseenter',  () => { chevronBtn.style.background  = BG_CHEV_HV; });
        chevronBtn.addEventListener('mouseleave',  () => { chevronBtn.style.background  = BG_CHEV; });

        updateLabel();

        wrapper.appendChild(toggleBtn);
        wrapper.appendChild(dividerEl);
        wrapper.appendChild(chevronBtn);
        wrapper.appendChild(dropdown);

        const settingsDiv = actionsDiv.querySelector('.gradebook_menu');
        settingsDiv ? actionsDiv.insertBefore(wrapper, settingsDiv) : actionsDiv.insertBefore(wrapper, actionsDiv.firstChild);
        return true;
    }

    // =========================================================================
    // POLLING TIMER
    // =========================================================================

    let pollTimer = null;

    // =========================================================================
    // ENROLLMENT FETCH
    // Called once when tracking starts. Paginates the Canvas enrollments API
    // to collect every active student ID for this course. Result is stored in
    // enrolledStudentIds (in-memory only; cleared on page reload).
    // =========================================================================

    async function fetchEnrolledStudentIds() {
        const ids = new Set();
        let url = `/api/v1/courses/${courseId}/enrollments?type[]=StudentEnrollment&state[]=active&per_page=100`;
        while (url) {
            let response;
            try {
                response = await fetch(url, { credentials: 'same-origin' });
            } catch (err) {
                console.warn('[CPT] Enrollment fetch failed:', err);
                break;
            }
            if (!response.ok) {
                console.warn('[CPT] Enrollment fetch returned', response.status);
                break;
            }
            const data = await response.json();
            data.forEach(enrollment => {
                if (enrollment.user_id) ids.add(String(enrollment.user_id));
            });
            // Follow the Link header for the next page, if any
            const linkHeader = response.headers.get('Link') || '';
            const nextMatch  = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            url = nextMatch ? nextMatch[1] : null;
        }
        enrolledStudentIds = ids;
        console.debug(`[CPT] Loaded ${ids.size} enrolled students for course ${courseId}`);
    }

    function initTracking() {
        applyAllIndicators();
        applyAllColumnButtons();
        showDiscoverabilityHint();
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => {
            applyAllIndicators();
            applyAllColumnButtons();
        }, POLL_INTERVAL_MS);
        document.addEventListener('click', dismissContextMenuOnClick, true);
        document.addEventListener('keydown', _escHandler);
        // Fetch all enrolled student IDs once for this session so bulkSetColumn
        // can mark every student, not just those visible in the Slick Grid viewport.
        fetchEnrolledStudentIds();
    }

    function stopTracking() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        removeAllIndicators();
        removeAllColumnButtons();
        document.removeEventListener('click', dismissContextMenuOnClick, true);
        document.removeEventListener('keydown', _escHandler);
    }

    function _escHandler(e) { if (e.key === 'Escape') removeContextMenu(); }

    // =========================================================================
    // LISTEN FOR MESSAGES FROM POPUP
    // Popup can send: { action: 'reload' } to force a storage refresh + redraw
    // =========================================================================

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'reload') {
            loadStorage(() => {
                loadCustomStates();

                // Always update the toolbar button to reflect new global/course state
                const wrapper = document.getElementById('cpt-review-wrapper');
                if (wrapper) {
                    const switchTrack = document.getElementById('cpt-review-switch-track');
                    const switchThumb = document.getElementById('cpt-review-switch-thumb');
                    const btn         = document.getElementById('cpt-review-toggle-btn');
                    if (switchTrack && switchThumb && btn) {
                        const globalOn = isGlobalEnabled();
                        const courseOn = isCourseEnabled(courseId);
                        const on       = globalOn && courseOn;
                        const paused   = !globalOn && courseOn;
                        if (paused) {
                            switchTrack.style.background = '#f39c12';
                            switchThumb.style.left       = '13px';
                            btn.title       = 'Global tracking is paused. Click the extension icon to re-enable.';
                            btn.style.cursor  = 'not-allowed';
                            btn.style.opacity = '0.8';
                        } else {
                            switchTrack.style.background = on ? '#0B874B' : 'rgb(215, 218, 222)';
                            switchThumb.style.left       = on ? '13px' : '2px';
                            btn.title       = on
                                ? 'Review Tracker is ON — click cell indicators to mark. Click to disable.'
                                : 'Review Tracker is OFF for this course. Click to enable.';
                            btn.style.cursor  = 'pointer';
                            btn.style.opacity = '1';
                        }
                    }
                }

                removeAllIndicators();
                if (isGlobalEnabled() && isCourseEnabled(courseId)) {
                    applyAllIndicators();
                    if (pollTimer === null) initTracking();
                } else {
                    stopTracking();
                }
            });
        }
    });

    // =========================================================================
    // COURSE NAME
    // Chrome extension content scripts run in an isolated world and cannot
    // access window.ENV from the page. Instead we read from document.title
    // which contains "Gradebook - {course name}" on gradebook pages.
    // =========================================================================

    function getCourseName() {
        const title     = document.title || '';
        const separator = ' - ';
        const idx       = title.indexOf(separator);
        return idx >= 0 ? title.slice(idx + separator.length).trim() : '';
    }

    function saveCourseName() {
        if (!isCourseEnabled(courseId)) return;

        // Only auto-save from page title if no name has been saved yet.
        // If the user has manually set a name in the dashboard, preserve it.
        const existing = ((getCache().courses || {})[courseId] || {}).name;
        if (existing) return; // name already set — don't overwrite

        const name = getCourseName();
        if (!name) return;

        if (!_cache.courses)           _cache.courses = {};
        if (!_cache.courses[courseId]) _cache.courses[courseId] = {};
        _cache.courses[courseId].name = name;
        saveStorage();
    }

    // =========================================================================
    // SUBMISSION TRAY INTEGRATION
    // Watches for .SubmissionTray__Container to appear in the DOM, then
    // injects a review status badge below the Status radio group.
    // Updates when the student or assignment carousel arrows are clicked.
    // =========================================================================

    // Read student ID from the student carousel link href
    // e.g. /courses/42275/grades/117744 → "117744"
    function getTrayStudentId() {
        const link = document.querySelector('#student-carousel a[href*="/grades/"]');
        if (!link) return null;
        const m = link.href.match(/\/grades\/(\d+)/);
        return m ? m[1] : null;
    }

    // Read assignment ID from the assignment carousel link href
    // e.g. /courses/42275/assignments/924177 → "924177"
    function getTrayAssignmentId() {
        const link = document.querySelector('#assignment-carousel a[href*="/assignments/"]');
        if (!link) return null;
        const m = link.href.match(/\/assignments\/(\d+)/);
        return m ? m[1] : null;
    }

    function stateIconElTray(stateKey, size = 13) {
        const def = STATES[stateKey];
        const span = document.createElement('span');
        if (!def || stateKey === 'NONE') {
            span.style.opacity = '0.4';
            span.textContent = '—';
            return span;
        }
        if (def.emoji) {
            span.style.fontSize = size + 'px';
            span.textContent = def.emoji;
            return span;
        }
        return buildDotIcon(def.color || '#3498db', size);
    }

    function updateTrayBadge() {
        const badgeLeft = document.getElementById('cpt-tray-badge-left');
        if (!badgeLeft) return;

        const studentId    = getTrayStudentId();
        const assignmentId = getTrayAssignmentId();
        if (!studentId || !assignmentId) return;

        const state = getReviewState(studentId, assignmentId);
        const def   = STATES[state] || STATES['NONE'];

        const iconSpan = document.createElement('span');
        iconSpan.appendChild(stateIconElTray(state, 13));

        const textSpan = document.createElement('span');
        textSpan.textContent = def.label || 'Not tracked';

        badgeLeft.replaceChildren(iconSpan, textSpan);

        const badge = document.getElementById('cpt-tray-review-badge');
        if (badge) {
            if (state === 'NONE') {
                badge.style.borderColor = '#c7cdd1';
                badge.style.color       = '#2d3b45';
            } else if (def.emoji) {
                badge.style.borderColor = '#0770a3';
                badge.style.color       = '#0770a3';
            } else {
                badge.style.borderColor = def.color || '#0770a3';
                badge.style.color       = def.color || '#0770a3';
            }
        }
    }

    let trayDropdownEl = null;

    function closeTrayDropdown() {
        if (trayDropdownEl) { trayDropdownEl.remove(); trayDropdownEl = null; }
    }

    function buildTrayDropdown(anchorEl) {
        closeTrayDropdown();

        const studentId    = getTrayStudentId();
        const assignmentId = getTrayAssignmentId();
        if (!studentId || !assignmentId) return;

        const dropdown = document.createElement('div');
        dropdown.id = 'cpt-tray-dropdown';
        dropdown.style.cssText = [
            'position: absolute',
            'top: calc(100% + 4px)',
            'left: 0',
            'background: #fff',
            'border: 1px solid #c7cdd1',
            'border-radius: 4px',
            'box-shadow: 0 2px 8px rgba(0,0,0,0.18)',
            'z-index: 99999',
            'font-family: Lato, sans-serif',
            'font-size: 12px',
            'min-width: 180px',
            'overflow: hidden',
        ].join(';');

        const header = document.createElement('div');
        header.textContent = 'Review Status';
        header.style.cssText = [
            'padding: 5px 10px',
            'font-size: 10px',
            'font-weight: 700',
            'text-transform: uppercase',
            'letter-spacing: 0.5px',
            'color: #8a9bb0',
            'border-bottom: 1px solid #e8eaec',
            'background: #f5f7f8',
        ].join(';');
        dropdown.appendChild(header);

        const current = getReviewState(studentId, assignmentId);

        STATE_CYCLE.forEach(key => {
            const def       = STATES[key] || {};
            const isCurrent = key === current;
            const item      = document.createElement('div');
            item.style.cssText = [
                'padding: 7px 10px',
                'cursor: pointer',
                'display: flex',
                'align-items: center',
                'gap: 8px',
                isCurrent ? 'background: #e8f0fe; font-weight: bold;' : '',
            ].join(';');

            const iconWrap = document.createElement('span');
            iconWrap.style.cssText = 'width:16px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;';
            iconWrap.appendChild(stateIconElTray(key, 13));

            const label = document.createElement('span');
            label.textContent = def.label || key;

            item.appendChild(iconWrap);
            item.appendChild(label);

            item.addEventListener('mouseenter', () => { if (!isCurrent) item.style.background = '#f0f4ff'; });
            item.addEventListener('mouseleave', () => { if (!isCurrent) item.style.background = ''; });

            item.addEventListener('click', () => {
                setReviewState(studentId, assignmentId, key);
                closeTrayDropdown();
                updateTrayBadge();
                // Also refresh gradebook cell indicator
                applyAllIndicators();
            });

            dropdown.appendChild(item);
        });

        anchorEl.style.position = 'relative';
        anchorEl.appendChild(dropdown);
        trayDropdownEl = dropdown;

        setTimeout(() => {
            document.addEventListener('click', closeTrayDropdown, { once: true });
        }, 0);
        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape') {
                closeTrayDropdown();
                document.removeEventListener('keydown', escHandler);
            }
        });
    }

    function injectTrayBadge() {
        if (document.getElementById('cpt-tray-review-wrap')) return;
        if (!isGlobalEnabled() || !isCourseEnabled(courseId)) return;

        // Insert after the Status radio group, before the Comments section
        const radioGroup = document.querySelector('[data-testid="SubmissionTray__RadioInputGroup"]');
        if (!radioGroup) return;

        // ── Wrapper ───────────────────────────────────────────────────────────
        const wrap = document.createElement('div');
        wrap.id = 'cpt-tray-review-wrap';
        wrap.style.cssText = [
            'padding: 12px 18px',
            'font-family: Lato, sans-serif',
            'position: relative',
        ].join(';');

        // ── Label ─────────────────────────────────────────────────────────────
        const label = document.createElement('div');
        label.textContent = 'Review Status';
        label.style.cssText = [
            'font-size: 10px',
            'font-weight: 700',
            'text-transform: uppercase',
            'letter-spacing: 0.5px',
            'color: #8a9bb0',
            'margin-bottom: 6px',
        ].join(';');

        // ── Badge button ──────────────────────────────────────────────────────
        const badge = document.createElement('button');
        badge.id   = 'cpt-tray-review-badge';
        badge.type = 'button';
        badge.style.cssText = [
            'display: inline-flex',
            'align-items: center',
            'gap: 6px',
            'padding: 5px 10px',
            'font-size: 12px',
            'font-family: Lato, sans-serif',
            'border-radius: 4px',
            'border: 1px solid #c7cdd1',
            'background: #fff',
            'color: #2d3b45',
            'cursor: pointer',
            'white-space: nowrap',
            'width: 100%',
            'justify-content: space-between',
        ].join(';');

        const badgeLeft = document.createElement('span');
        badgeLeft.id = 'cpt-tray-badge-left';
        badgeLeft.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';

        const badgeChevron = document.createElement('span');
        badgeChevron.textContent = '▾';
        badgeChevron.style.cssText = 'font-size:10px;color:#8a9bb0;';

        badge.appendChild(badgeLeft);
        badge.appendChild(badgeChevron);

        badge.addEventListener('click', e => {
            e.stopPropagation();
            if (trayDropdownEl) { closeTrayDropdown(); return; }
            buildTrayDropdown(wrap);
        });

        wrap.appendChild(label);
        wrap.appendChild(badge);

        // Insert after the radio group using a divider to match Canvas's style
        const hr = document.createElement('div');
        hr.setAttribute('dir', 'ltr');
        hr.className = 'hr css-148rtmo-view';

        radioGroup.insertAdjacentElement('afterend', hr);
        hr.insertAdjacentElement('afterend', wrap);

        updateTrayBadge();

        // Watch carousel arrows for student/assignment changes
        watchTrayCarousels();
    }

    function watchTrayCarousels() {
        const studentCarousel    = document.getElementById('student-carousel');
        const assignmentCarousel = document.getElementById('assignment-carousel');

        [studentCarousel, assignmentCarousel].forEach(carousel => {
            if (!carousel) return;
            carousel.addEventListener('click', e => {
                if (e.target.closest('button')) {
                    // Small delay for Canvas to update the link hrefs
                    setTimeout(updateTrayBadge, 300);
                }
            });
        });
    }

    function initTrayObserver() {
        // Watches document.body because Canvas portals the submission tray in
        // at body level rather than inside the grid. It also runs even when
        // tracking is off for this course, so that enabling a course mid-
        // session makes the tray badge work without a reload.
        //
        // That combination means this callback fires constantly: SlickGrid
        // virtualizes rows and recycles cells on every scroll, so an undebounced
        // querySelector here ran on each mutation batch for the life of the
        // page. Coalescing to one check per frame collapses a scroll burst into
        // a single query without changing what is detected.
        let pending = false;
        const observer = new MutationObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => {
                pending = false;
                const tray = document.querySelector('.SubmissionTray__Container');
                if (tray) {
                    // Small delay for tray content to fully render
                    setTimeout(injectTrayBadge, 300);
                } else {
                    // Tray closed — clean up dropdown
                    closeTrayDropdown();
                }
            });
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // =========================================================================
    // ENTRY POINT
    // =========================================================================

    // =========================================================================
    // FEATURE FLAG CHECK
    // Respect the Tools tab toggle before doing anything.
    // =========================================================================

    chrome.storage.local.get('cpt_features', result => {
        // cpt_features is namespaced per Canvas instance (hostname), with a
        // legacy flat-shape fallback until popup.js migrates it on disk.
        const allFeatures = (result && result['cpt_features']) || {};
        const featLegacy  = Object.keys(allFeatures).some(k => typeof allFeatures[k] === 'boolean');
        const features = featLegacy ? allFeatures : (allFeatures[INSTANCE_KEY] || {});
        const enabled  = typeof features.reviewTracker === 'boolean'
            ? features.reviewTracker
            : false; // default OFF — must match FEATURES in popup.js and
                     // DEFAULTS in feature-flags.js. Review Tracker also
                     // requires a per-course opt-in (isCourseEnabled), so
                     // shipping it on would add a toolbar control that does
                     // nothing until the user enables a course anyway.

        if (!enabled) return; // feature disabled — do nothing

        loadStorage(() => {
            loadCustomStates();
            saveCourseName(); // persist course name from page title

            // Bounded. The manifest match (/courses/*/gradebook*) also covers
            // Individual View and Gradebook History, where neither
            // .slick-viewport/#gradebook_grid nor #gradebook-actions ever
            // appears. An unbounded interval polled every 500ms for the entire
            // life of those tabs. 60 attempts is 30 seconds, past a normal grid
            // render even on a large course, while still terminating.
            const MAX_STARTUP_ATTEMPTS = 60;
            let startupAttempts = 0;

            const startupCheck = setInterval(() => {
                const gridReady    = document.querySelector('.slick-viewport') || document.querySelector('#gradebook_grid');
                const actionsReady = document.getElementById('gradebook-actions');
                if (gridReady && actionsReady) {
                    clearInterval(startupCheck);
                    injectToolbarButton();
                    if (isGlobalEnabled() && isCourseEnabled(courseId)) {
                        initTracking();
                    }
                    // Always watch for the submission tray
                    initTrayObserver();
                    return;
                }

                if (++startupAttempts >= MAX_STARTUP_ATTEMPTS) {
                    clearInterval(startupCheck);
                    console.debug('[CPT] Gradebook grid not found after ' +
                                  (MAX_STARTUP_ATTEMPTS * 500 / 1000) + 's; ' +
                                  'expected on Individual View and Gradebook History');
                }
            }, 500);
        });
    });

})();

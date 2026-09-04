// Canvas Pro-Tools - SpeedGrader Review Badge
// Injected into: https://*.instructure.com/courses/*/gradebook/speed_grader*
// Adds a review status badge + dropdown to the SpeedGrader grading panel,
// between the grade inputs and Assignment Comments.
// Shares chrome.storage with gradebook-tracker.js so markers sync to the
// gradebook. Both read the same reviewTracker flag and the same
// cpt_review_data key, so their defaults must not diverge.

(function () {
    'use strict';

    // =========================================================================
    // CONSTANTS
    // =========================================================================

    const STORAGE_KEY  = 'cpt_review_data';

    const DEFAULT_STATES = {
        NONE:     { emoji: '',   label: 'Not tracked',  color: null },
        PENDING:  { emoji: '🟡', label: 'Needs Review', color: null },
        FLAGGED:  { emoji: '🔴', label: 'Needs Action', color: null },
        REVIEWED: { emoji: '✅', label: 'Reviewed',     color: null },
    };
    const DEFAULT_CYCLE = ['NONE', 'PENDING', 'FLAGGED', 'REVIEWED'];

    let STATES      = { ...DEFAULT_STATES };
    let STATE_CYCLE = [...DEFAULT_CYCLE];

    const courseIdMatch = window.location.pathname.match(/\/courses\/(\d+)/);
    if (!courseIdMatch) return;
    const courseId = courseIdMatch[1];

    // =========================================================================
    // URL PARAM READING
    // =========================================================================

    function getParams() {
        const p = new URLSearchParams(window.location.search);
        return {
            assignmentId: p.get('assignment_id'),
            studentId:    p.get('student_id'),
        };
    }

    // =========================================================================
    // STORAGE LAYER
    // chrome.storage.local[STORAGE_KEY] is namespaced per Canvas instance
    // (hostname). _cache holds the slice for THIS instance. See
    // gradebook-tracker.js for the full shape comment.
    // =========================================================================

    const INSTANCE_KEY = window.CPT_INSTANCE_KEY || window.location.hostname;
    const LEGACY_TOP_LEVEL_KEYS = ['globalEnabled', 'courses', 'reviews', 'customStates', 'customCycle', 'hints'];

    let _cache = null;

    function loadStorage(cb) {
        chrome.storage.local.get(STORAGE_KEY, result => {
            const raw = result[STORAGE_KEY] || {};

            const looksLegacy = LEGACY_TOP_LEVEL_KEYS.some(k => k in raw);
            let allInstances;
            if (looksLegacy) {
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

    function isGlobalEnabled() {
        return (_cache || {}).globalEnabled !== false;
    }

    function isCourseEnabled(id) {
        const courses = (_cache || {}).courses || {};
        return courses[id] ? courses[id].enabled === true : false;
    }

    function getReviewState(studentId, assignmentId) {
        const reviews = ((_cache || {}).reviews || {})[courseId] || {};
        return reviews[`${studentId}_${assignmentId}`] || 'NONE';
    }

    function setReviewState(studentId, assignmentId, state) {
        if (!_cache.reviews)           _cache.reviews = {};
        if (!_cache.reviews[courseId]) _cache.reviews[courseId] = {};
        const key = `${studentId}_${assignmentId}`;
        if (state === 'NONE') {
            delete _cache.reviews[courseId][key];
        } else {
            _cache.reviews[courseId][key] = state;
        }
        saveStorage();
    }

    function loadCustomStates() {
        const custom = (_cache || {}).customStates || {};
        const cycle  = (_cache || {}).customCycle  || DEFAULT_CYCLE;
        STATES      = { ...DEFAULT_STATES, ...custom };
        STATE_CYCLE = cycle.filter(k => STATES[k] !== undefined);
        if (!STATE_CYCLE.includes('NONE')) STATE_CYCLE.unshift('NONE');
    }

    // =========================================================================
    // STATE ICON HELPER
    // =========================================================================
    // Builds icons as real elements via createElement/createElementNS instead
    // of innerHTML template strings — emoji and color both originate from
    // user-importable customStates, so attribute/text APIs keep them inert.

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

    function stateIconEl(stateKey, size = 14) {
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

    // =========================================================================
    // DROPDOWN
    // =========================================================================

    let activeDropdown = null;
    let activeEscHandler = null;

    function closeDropdown() {
        // The Escape handler is torn down here rather than inside itself,
        // because the dropdown can also be closed by an outside click or by
        // navigating to another student. Removing it only on Escape left one
        // live document-level keydown listener behind per open-and-close
        // cycle, accumulating for as long as the SpeedGrader tab stayed open.
        if (activeEscHandler) {
            document.removeEventListener('keydown', activeEscHandler);
            activeEscHandler = null;
        }
        if (activeDropdown) { activeDropdown.remove(); activeDropdown = null; }
    }

    function buildDropdown(anchorEl, studentId, assignmentId, onSelect) {
        closeDropdown();

        const dropdown = document.createElement('div');
        dropdown.id = 'cpt-sg-dropdown';
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
            'min-width: 170px',
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
            iconWrap.appendChild(stateIconEl(key, 13));

            const label = document.createElement('span');
            label.textContent = def.label || key;

            item.appendChild(iconWrap);
            item.appendChild(label);

            item.addEventListener('mouseenter', () => { if (!isCurrent) item.style.background = '#f0f4ff'; });
            item.addEventListener('mouseleave', () => { if (!isCurrent) item.style.background = isCurrent ? '#e8f0fe' : ''; });

            item.addEventListener('click', () => {
                setReviewState(studentId, assignmentId, key);
                closeDropdown();
                onSelect(key);
            });

            dropdown.appendChild(item);
        });

        anchorEl.style.position = 'relative';
        anchorEl.appendChild(dropdown);
        activeDropdown = dropdown;

        setTimeout(() => {
            document.addEventListener('click', closeDropdown, { once: true });
        }, 0);

        // Not { once: true }: keydown fires for every key, so a one-shot
        // listener would unbind on the first keystroke and Escape would stop
        // working. Held in activeEscHandler instead and removed by
        // closeDropdown, which every close path already calls.
        activeEscHandler = function (e) {
            if (e.key === 'Escape') closeDropdown();
        };
        document.addEventListener('keydown', activeEscHandler);
    }

    // =========================================================================
    // BADGE WIDGET
    // =========================================================================

    function buildBadgeWidget() {
        const wrap = document.createElement('div');
        wrap.id = 'cpt-sg-review-wrap';
        wrap.style.cssText = [
            'margin-top: 10px',
            'padding-top: 10px',
            'border-top: 1px solid #c7cdd1',
            'font-family: Lato, sans-serif',
            'position: relative',
        ].join(';');

        const label = document.createElement('div');
        label.textContent = 'Review Status';
        label.style.cssText = [
            'font-size: 10px',
            'font-weight: 700',
            'text-transform: uppercase',
            'letter-spacing: 0.5px',
            'color: #8a9bb0',
            'margin-bottom: 5px',
        ].join(';');

        const badge = document.createElement('button');
        badge.id   = 'cpt-sg-review-badge';
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
        badgeLeft.id = 'cpt-sg-badge-left';
        badgeLeft.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';

        const badgeChevron = document.createElement('span');
        badgeChevron.textContent = '▾';
        badgeChevron.style.cssText = 'font-size:10px;color:#8a9bb0;';

        badge.appendChild(badgeLeft);
        badge.appendChild(badgeChevron);
        wrap.appendChild(label);
        wrap.appendChild(badge);

        return wrap;
    }

    function updateBadge(stateKey) {
        const badgeLeft = document.getElementById('cpt-sg-badge-left');
        if (!badgeLeft) return;

        const def = STATES[stateKey] || STATES['NONE'];

        const iconSpan = document.createElement('span');
        iconSpan.appendChild(stateIconEl(stateKey, 13));

        const textSpan = document.createElement('span');
        textSpan.textContent = def.label || 'Not tracked';

        badgeLeft.replaceChildren(iconSpan, textSpan);

        const badge = document.getElementById('cpt-sg-review-badge');
        if (badge) {
            if (stateKey === 'NONE') {
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

    function refreshBadge() {
        const { studentId, assignmentId } = getParams();
        if (!studentId || !assignmentId) return;
        const state = getReviewState(studentId, assignmentId);
        updateBadge(state);
    }

    // =========================================================================
    // INJECT THE BADGE WIDGET
    // =========================================================================

    // Find the insertion point: between the grade inputs and Assignment Comments.
    //
    // The classic mount (#grade_container) does not exist in the new SpeedGrader.
    // The obvious replacement, [data-testid="assessment"], is a trap: it holds a
    // single child wrapping the entire panel, so appendChild() lands the widget
    // at the very bottom, below the comment box.
    //
    // Rather than hardcode a nesting depth — which differs between checkpoint
    // discussions (two grade boxes, Canvas's rubric alert, our mapping notice)
    // and ordinary assignments (one box) — walk up from the comments heading
    // until we reach the ancestor whose parent ALSO contains the grade inputs.
    // That node is the comments block; inserting before it puts the badge after
    // whatever grading UI happens to be present. Self-adjusting, both layouts.
    function getBadgeAnchor() {
        const label     = document.querySelector('[data-testid="comments-label"]');
        const gradeView = document.querySelector('[data-testid="assessment-grade-input-view"]');
        if (!label || !gradeView) return null; // panel not rendered yet

        let node = label;
        while (node.parentElement && !node.parentElement.contains(gradeView)) {
            node = node.parentElement;
        }
        return node.parentElement ? { parent: node.parentElement, before: node } : null;
    }

    // Creates the widget if absent, and corrects its position if the panel has
    // been restructured around it.
    //
    // Written as a repair rather than a one-shot injection because this panel
    // re-renders after mount: a widget placed correctly at injection time gets
    // stranded elsewhere moments later, differing per page load. The same problem
    // bit the checkpoint mapping notice. The existing node is MOVED rather than
    // rebuilt, so its click listener and dropdown state survive.
    //
    // Returns true when the widget is present and correctly placed.
    function injectWidget() {
        const anchor = getBadgeAnchor();
        if (!anchor) return false;

        let wrap = document.getElementById('cpt-sg-review-wrap');

        if (wrap) {
            // Already correct — do nothing. Re-inserting unconditionally would
            // retrigger the placement observer and spin.
            if (wrap.parentElement === anchor.parent && wrap.nextElementSibling === anchor.before) {
                return true;
            }
            anchor.parent.insertBefore(wrap, anchor.before);
            return true;
        }

        wrap = buildBadgeWidget();
        anchor.parent.insertBefore(wrap, anchor.before);

        // getElementById only resolves once the widget is in the document.
        const badge = document.getElementById('cpt-sg-review-badge');
        badge.addEventListener('click', e => {
            e.stopPropagation();
            if (activeDropdown) { closeDropdown(); return; }
            const { studentId, assignmentId } = getParams();
            if (!studentId || !assignmentId) return;
            const w = document.getElementById('cpt-sg-review-wrap');
            buildDropdown(w, studentId, assignmentId, newState => {
                updateBadge(newState);
            });
        });

        refreshBadge();
        return true;
    }

    // Re-checks placement after every re-render. Coalesced to one repair per
    // frame: our own insertBefore mutates the DOM and would otherwise make the
    // observer react to itself.
    let _placementObserver = null;
    let _placementRaf      = null;

    function watchBadgePlacement() {
        if (_placementObserver) return;
        const root = document.getElementById('application') || document.body;
        _placementObserver = new MutationObserver(() => {
            if (_placementRaf) return;
            _placementRaf = requestAnimationFrame(() => {
                _placementRaf = null;
                injectWidget();
            });
        });
        _placementObserver.observe(root, { childList: true, subtree: true });
    }

    // =========================================================================
    // STUDENT NAVIGATION OBSERVER
    // =========================================================================

    function watchStudentNavigation() {
        let lastStudentId = getParams().studentId;

        // No history.pushState override here. This script runs in the ISOLATED
        // world, which has its own JavaScript globals, so assigning to
        // history.pushState only rebinds this script's own copy. SpeedGrader
        // changes students via pushState from the page (MAIN world), which
        // would never reach the override.
        //
        // popstate is a real DOM event and does cross the world boundary, but
        // it only fires for back/forward. The select-container observer below
        // is therefore the mechanism that actually catches student changes.
        window.addEventListener('popstate', handleNavigation);

        const selectContainer = document.getElementById('combo_box_container') ||
                                document.querySelector('[data-testid="student-drilldown-container"]');
        if (selectContainer) {
            const observer = new MutationObserver(() => {
                const { studentId } = getParams();
                if (studentId && studentId !== lastStudentId) {
                    lastStudentId = studentId;
                    handleNavigation();
                }
            });
            observer.observe(selectContainer, { childList: true, subtree: true, characterData: true });
        } else {
            // Neither container matched. Only back/forward navigation will be
            // detected, so the badge can go stale when the grader moves to the
            // next student. Surfaced at debug level rather than silently, since
            // the symptom (a badge showing the previous student's state) is
            // easy to misread as a storage bug.
            console.debug('CPT SpeedGrader: student select container not found; ' +
                          'badge will not refresh on in-app student navigation');
        }

        function handleNavigation() {
            const { studentId } = getParams();
            if (studentId !== lastStudentId) lastStudentId = studentId;
            closeDropdown();
            setTimeout(refreshBadge, 150);
        }
    }

    // =========================================================================
    // LISTEN FOR MESSAGES FROM POPUP
    // =========================================================================

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'reload') {
            loadStorage(() => {
                loadCustomStates();
                refreshBadge();
                const wrap = document.getElementById('cpt-sg-review-wrap');
                if (wrap) {
                    wrap.style.display = (isGlobalEnabled() && isCourseEnabled(courseId))
                        ? '' : 'none';
                }
            });
        }
    });

    // =========================================================================
    // ENTRY POINT
    // Poll for the grading panel, inject when ready, then keep it anchored.
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
            : false; // default OFF — must match FEATURES in popup.js,
                     // DEFAULTS in feature-flags.js, and the same guard in
                     // gradebook-tracker.js. Both halves of Review Tracker
                     // read this one flag, so they must not disagree: a
                     // mismatch would show the SpeedGrader badge for a course
                     // the gradebook is not tracking.

        if (!enabled) return; // feature disabled — do nothing

        loadStorage(() => {
            loadCustomStates();

            // Bounded. injectWidget() succeeds only once getBadgeAnchor finds
            // both [data-testid="comments-label"] and
            // [data-testid="assessment-grade-input-view"], which are new
            // SpeedGrader markup. On classic SpeedGrader they never appear, so
            // an unbounded interval polled every 500ms for the entire life of
            // the tab. The manifest match (/gradebook/speed_grader*) cannot
            // distinguish the two, so the ceiling is what stops it.
            //
            // 60 attempts at 500ms is 30 seconds, well beyond a normal panel
            // render even on a slow connection, while still terminating.
            const MAX_STARTUP_ATTEMPTS = 60;
            let startupAttempts = 0;

            const startupCheck = setInterval(() => {
                if (injectWidget() === true) {
                    clearInterval(startupCheck);

                    const wrap = document.getElementById('cpt-sg-review-wrap');
                    if (wrap) {
                        wrap.style.display = (isGlobalEnabled() && isCourseEnabled(courseId))
                            ? '' : 'none';
                    }

                    watchStudentNavigation();
                    // Keep the widget anchored as Canvas re-renders the panel.
                    watchBadgePlacement();
                    return;
                }

                if (++startupAttempts >= MAX_STARTUP_ATTEMPTS) {
                    clearInterval(startupCheck);
                    console.debug('CPT SpeedGrader: grading panel not found after ' +
                                  (MAX_STARTUP_ATTEMPTS * 500 / 1000) + 's; ' +
                                  'this is expected on classic SpeedGrader');
                }
            }, 500);
        });
    });

})();

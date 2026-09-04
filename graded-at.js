// graded-at.js
// Canvas Pro-Tools — SpeedGrader Graded At Timestamp
// Runs in ISOLATED world — can access chrome.storage directly.
// Matches: /courses/*/gradebook/speed_grader*

(function () {
    'use strict';

    if (!/\/courses\/\d+\/gradebook\/speed_grader/.test(window.location.pathname)) return;

    const FEATURES_KEY = 'cpt_features';

    chrome.storage.local.get(FEATURES_KEY, function (result) {
        // cpt_features is namespaced per Canvas instance (hostname), with a
        // legacy flat-shape fallback until popup.js migrates it on disk.
        const allFeatures = (result && result[FEATURES_KEY]) || {};
        const featLegacy  = Object.keys(allFeatures).some(k => typeof allFeatures[k] === 'boolean');
        const saved    = featLegacy ? allFeatures : (allFeatures[window.location.hostname] || {});
        const enabled  = typeof saved.sgGradedAt === 'boolean' ? saved.sgGradedAt : true;
        if (!enabled) return;

        initialize();
    });

    // =========================================================================
    // FORMATTING
    // =========================================================================

    function formatDateTime(isoString) {
        if (!isoString) return 'Not graded';
        const date   = new Date(isoString);
        const month  = date.toLocaleString('en-US', { month: 'short' });
        const day    = date.getDate();
        const hour   = date.getHours() % 12 || 12;
        const minute = date.getMinutes().toString().padStart(2, '0');
        const ampm   = date.getHours() >= 12 ? 'pm' : 'am';
        return `${month} ${day} at ${hour}:${minute}${ampm}`;
    }

    // =========================================================================
    // DOM TARGETING
    // Content scripts run in an isolated world and cannot read window.ENV, so
    // we probe the DOM directly for both SpeedGrader versions — whichever
    // selector matches first wins.
    // =========================================================================

    function findSubmittedElement() {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
            if (node.textContent.includes('Submitted')) {
                return node.parentElement || null;
            }
        }
        return null;
    }

    function findTargetElement() {
        let el;

        // New SpeedGrader — stable data-testid (most reliable)
        el = document.querySelector('section[data-testid="single-submission-info"]');
        if (el) return el;

        // New SpeedGrader — CSS class selectors (less stable, tried as fallback)
        el = document.querySelector('#react-router-portals aside div.css-1fdf6sz-view');
        if (el) return el;

        el = document.querySelector('#react-router-portals > main > div:nth-child(3) > aside > span > span > span > span > div.css-1fdf6sz-view');
        if (el) return el;

        // Classic SpeedGrader
        el = document.getElementById('submission_details');
        if (el) return el;

        // Last resort: any element whose text includes "Submitted"
        const submittedEl = findSubmittedElement();
        if (submittedEl) {
            return (
                submittedEl.closest('section') ||
                submittedEl.closest('div[class*="view"]') ||
                submittedEl.closest('span[class*="view"]') ||
                submittedEl
            );
        }

        return null;
    }

    // =========================================================================
    // URL PARAM HELPERS
    // =========================================================================

    function getAssignmentId() {
        // window.ENV is not accessible in isolated world - use URL params only.
        // Validated the same way as getStudentId below: this value is
        // interpolated into the API path, so anything that is not a bare
        // integer is rejected rather than passed through.
        const val = new URLSearchParams(window.location.search).get('assignment_id') || null;
        return (val && /^\d+$/.test(val)) ? val : null;
    }

    function getStudentId() {
        const val = new URLSearchParams(window.location.search).get('student_id') || null;
        return (val && /^\d+$/.test(val)) ? val : null;
    }

    function getCourseId() {
        const m = window.location.pathname.match(/\/courses\/(\d+)/);
        return m ? m[1] : null;
    }

    // =========================================================================
    // MAIN INJECTION
    // =========================================================================

    function addGradedTimestamp(retryCount) {
        retryCount = retryCount || 0;

        const courseId     = getCourseId();
        const assignmentId = getAssignmentId();
        const userId       = getStudentId();

        if (!courseId || !assignmentId || !userId) return;

        const target = findTargetElement();
        if (!target) {
            if (retryCount < 5) {
                setTimeout(function () { addGradedTimestamp(retryCount + 1); }, 1000 * (retryCount + 1));
            }
            return;
        }

        const apiUrl = `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`;

        fetch(apiUrl)
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                // Remove any previous stamp
                const existing = document.querySelector('.cpt-graded-at');
                if (existing) existing.remove();

                const wrap = document.createElement('div');
                wrap.className  = 'cpt-graded-at';
                wrap.style.cssText = [
                    'margin-top: 0.5rem',
                    'padding: 0.5rem 0',
                    'font-family: LatoWeb, Lato, "Helvetica Neue", Helvetica, Arial, sans-serif',
                    'font-size: 14px',
                    'color: #2D3B45',
                ].join(';');

                const wasManual = data.grader_id > 0;

                const label = document.createElement('span');
                label.style.fontWeight = 'bold';
                label.textContent      = wasManual ? 'Manually graded: ' : 'Auto-graded: ';

                const date = document.createElement('span');
                date.style.fontWeight = 'normal';
                date.textContent      = formatDateTime(data.graded_at);

                wrap.appendChild(label);
                wrap.appendChild(date);
                target.appendChild(wrap);
            })
            .catch(function (err) {
                console.error('[Canvas Pro-Tools] graded-at.js error:', err);
            });
    }

    // =========================================================================
    // URL CHANGE DETECTION
    // =========================================================================

    var lastUrl = '';

    function checkForUpdates() {
        var currentUrl = window.location.href;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            setTimeout(addGradedTimestamp, 1500);
        }
    }

    function setupUrlChangeDetection() {
        // No history.pushState override here. This script runs in the ISOLATED
        // world, which has its own JavaScript globals, so assigning to
        // history.pushState only rebinds this script's own copy. Canvas makes
        // its pushState calls from the page (MAIN world) and would never hit
        // the override. The three mechanisms below are what actually detect
        // navigation: popstate fires as a real DOM event and does cross the
        // world boundary, the poll is a backstop, and the observer catches
        // in-app view swaps.
        window.addEventListener('popstate', checkForUpdates);
        setInterval(checkForUpdates, 2000);

        // checkForUpdates is a string comparison against the last seen URL and
        // returns immediately when nothing changed, so it is already the cheap
        // check. This callback used to gate it behind findSubmittedElement(),
        // which walks every text node under document.body - expensive work
        // repeated on every mutation batch, in order to decide whether to call
        // a function that usually no-ops. SpeedGrader mutates constantly, so
        // that walk was the single hottest thing this script did.
        //
        // The gate also guaranteed nothing: the 2s poll above calls
        // checkForUpdates ungated, so any URL change was picked up within two
        // seconds regardless. And addGradedTimestamp carries its own retry
        // loop (5 attempts with backoff) for the case where the target element
        // is not in the DOM yet, so acting early is already handled.
        //
        // Call checkForUpdates directly instead, coalesced to one call per
        // frame so a burst of React re-renders collapses into a single check.
        var pending = false;
        var observer = new MutationObserver(function () {
            if (pending) return;
            pending = true;
            requestAnimationFrame(function () {
                pending = false;
                checkForUpdates();
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // =========================================================================
    // ENTRY POINT
    // Do not wait on window.ENV — it is not accessible in isolated world.
    // The retry loop in addGradedTimestamp handles DOM not being ready yet.
    // =========================================================================

    function initialize() {
        setupUrlChangeDetection();
        addGradedTimestamp();
    }

})();

// assignment-details.js
// Canvas Pro-Tools — Assignment Details
// Adds a "Load Assignment Details" item to the assignments index page options
// menu. On click, annotates every assignment row with submission type(s),
// whether it affects the final grade, and its rubric (linked, with grading-use
// and outcome-criteria flags).
// Runs in ISOLATED world (default). Does not need window.ENV or page jQuery.
// Adapted from Code with Ski's Canvas-LMS-Mods (MIT) — see CREDITS.md.
// Match: /courses/*/assignments  (index only — the bare path, no trailing id)

(function () {
    'use strict';

    // ── Route guard ───────────────────────────────────────────────────────────
    // Index page only. Exclude /assignments/<id>, /assignments/syllabus, and
    // /assignments/new by requiring the path to END at "assignments".

    var path  = window.location.pathname;
    var match = /^\/courses\/([0-9]+)\/assignments$/.exec(path);
    if (!match) return;

    var courseId = match[1];

    // ── Feature flag — stamped by feature-flags.js ────────────────────────────

    if (document.documentElement.dataset.cptAssignmentDetails === 'false') return;

    // ── Constants ─────────────────────────────────────────────────────────────

    var MENU_SEL      = '#settingsMountPoint ul.ui-menu';
    var ROW_SEL       = '.assignment-list .ig-row';
    var LIST_SEL      = '.assignment-list';
    var MENU_ITEM_ID  = 'cpt-load-assignment-details';

    // Panel visuals, colors, collapse logic, and the shared stylesheet now
    // live in cpt-panel.js (CPTPanel), loaded before this file. Thin local
    // aliases keep the call sites below unchanged.
    var PANEL_CLASS   = CPTPanel.PANEL_CLASS;

    // Page-level status/control bar (loading indicator, then collapse-all).
    var STATUS_BAR_ID = 'cpt-ad-status-bar';

    // Per-page size for the bulk assignments fetch.
    var PER_PAGE = 100;

    // ── Shared design system (from CPTPanel) ──────────────────────────────────
    var COLORS         = CPTPanel.COLORS;
    var C_ACCENT       = COLORS.accent;
    var C_SUCCESS      = COLORS.success;
    var C_WARNING      = COLORS.warning;
    var C_MUTED        = COLORS.muted;
    var C_TEXT         = COLORS.text;
    var segment        = CPTPanel.segment;
    var setAllCollapsed = CPTPanel.setAllCollapsed;

    // ── Status / control bar ──────────────────────────────────────────────────
    // Injected above the assignment list. During the fetch it shows a spinner;
    // once panels are drawn it becomes a persistent collapse-all/expand-all
    // control. Removed and rebuilt on each run for idempotency.

    function removeStatusBar() {
        var existing = document.getElementById(STATUS_BAR_ID);
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }
    }

    function makeStatusBar() {
        removeStatusBar();
        var firstList = document.querySelector(LIST_SEL);
        if (!firstList) return null;

        // From the live DOM, the nesting is:
        //   div#ag-list.item-group-container      ← wrapper around ALL groups
        //     ul.ig-list
        //       li.item-group-condensed           ← one assignment group
        //         div.assignment_group
        //           div.assignment-list           ← LIST_SEL (per-group)
        // Insert before the all-groups container so the bar sits above the
        // whole list. Note the group class is `assignment_group` (underscore);
        // targeting the container by its own class is more robust than guessing
        // the group class. Fallbacks walk outward if the structure differs.
        var anchor =
            firstList.closest('.item-group-container') ||
            firstList.closest('.item-group-condensed') ||
            firstList.parentElement ||
            firstList;

        var bar = document.createElement('div');
        bar.id = STATUS_BAR_ID;
        bar.style.cssText = CPTPanel.barStyle();

        anchor.insertAdjacentElement('beforebegin', bar);
        return bar;
    }

    function showLoading() {
        CPTPanel.ensureStyle();
        var bar = makeStatusBar();
        if (!bar) return;

        var icon = document.createElement('i');
        icon.className = 'icon-line icon-refresh ' + CPTPanel.SPIN_CLASS;
        icon.setAttribute('aria-hidden', 'true');
        icon.style.color = C_ACCENT;

        var text = document.createElement('span');
        text.textContent = 'Loading assignment details…';

        bar.appendChild(icon);
        bar.appendChild(text);
    }

    function showControlBar(panelCount) {
        var bar = document.getElementById(STATUS_BAR_ID);
        if (!bar) bar = makeStatusBar();
        if (!bar) return;
        bar.textContent = '';

        var label = document.createElement('span');
        label.textContent = panelCount +
            (panelCount === 1 ? ' assignment annotated' : ' assignments annotated');
        label.style.flex = '1';

        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'Button Button--small';
        toggle.style.cssText = 'font-size:0.75rem;';
        toggle.setAttribute('aria-pressed', 'false');

        function renderToggle(collapsed) {
            toggle.textContent = '';
            var i = document.createElement('i');
            i.className = 'icon-line ' +
                (collapsed ? 'icon-arrow-open-down' : 'icon-arrow-open-up');
            i.setAttribute('aria-hidden', 'true');
            i.style.marginRight = '4px';
            toggle.appendChild(i);
            toggle.appendChild(document.createTextNode(
                collapsed ? 'Expand all' : 'Collapse all'));
        }
        renderToggle(false);

        toggle.addEventListener('click', function () {
            var collapse = toggle.getAttribute('aria-pressed') !== 'true';
            setAllCollapsed(collapse);
            toggle.setAttribute('aria-pressed', collapse ? 'true' : 'false');
            renderToggle(collapse);
        });

        bar.appendChild(label);
        bar.appendChild(toggle);
    }

    function showError() {
        var bar = document.getElementById(STATUS_BAR_ID) || makeStatusBar();
        if (!bar) return;
        bar.textContent = '';

        var icon = document.createElement('i');
        icon.className = 'icon-line icon-warning';
        icon.setAttribute('aria-hidden', 'true');
        icon.style.color = C_WARNING;

        var text = document.createElement('span');
        text.textContent =
            "Couldn't load assignment details. Check your connection and try again.";

        bar.appendChild(icon);
        bar.appendChild(text);
    }

    // ── Menu injection ────────────────────────────────────────────────────────

    function watchForMenu() {
        var existing = document.querySelector(MENU_SEL);
        if (existing) {
            addMenuItem(existing);
            return;
        }

        // Verified on a fresh assignments-index load: #settingsMountPoint is
        // present in the initial markup, but '#settingsMountPoint ul.ui-menu'
        // is null. Canvas renders the <ul> as .al-options and jQuery UI adds
        // the ui-menu class only when the menu is first opened, so this
        // observer branch is the normal path, not a fallback.
        //
        // The user may open that menu immediately, minutes later, or never,
        // so the observer cannot be given a deadline without breaking the
        // feature. Scope is limited instead: watching the mount point rather
        // than document.body means the callback wakes only for changes inside
        // the settings menu, not for every mutation on a busy assignments
        // page. It still disconnects as soon as the menu is found.
        //
        // Falls back to document.body if the mount point has not rendered
        // yet, which preserves the previous behaviour rather than silently
        // doing nothing.
        var root = document.getElementById('settingsMountPoint') || document.body;

        var observer = new MutationObserver(function () {
            var menu = document.querySelector(MENU_SEL);
            if (menu) {
                observer.disconnect();
                addMenuItem(menu);
            }
        });
        observer.observe(root, { childList: true, subtree: true });
    }

    function addMenuItem(menu) {
        if (menu.querySelector('#' + MENU_ITEM_ID)) return; // idempotency

        var li = document.createElement('li');
        li.setAttribute('role', 'presentation');
        li.className = 'ui-menu-item';

        var link = document.createElement('a');
        link.id   = MENU_ITEM_ID;
        link.href = '#';
        link.className = 'ui-corner-all';
        link.setAttribute('role', 'menuitem');
        link.title = 'Load assignment details';
        link.innerHTML = '<i class="icon-blank"></i> Load assignment details';

        link.addEventListener('click', function (e) {
            e.preventDefault();
            if (link._cptBusy) return;
            link._cptBusy = true;

            var original = link.innerHTML;
            link.innerHTML = '<i class="icon-blank"></i> Loading…';

            loadAssignmentDetails().then(function () {
                // Leave the item in place so it can be re-run after paging or
                // filtering the list, but restore its label.
                link.innerHTML = original;
                link._cptBusy = false;
            });
        });

        li.appendChild(link);
        menu.appendChild(li);
    }

    // ── API ───────────────────────────────────────────────────────────────────

    function apiGet(url) {
        return fetch(url, {
            credentials: 'same-origin',
            headers:     { 'Accept': 'application/json' },
        }).then(function (response) {
            if (!response.ok) {
                throw new Error('Fetch failed (' + response.status + ')');
            }
            return response;
        });
    }

    // Follows RFC-5988 Link headers to page through the full assignment list.
    function getAllAssignments() {
        var results = [];
        var url = '/api/v1/courses/' + courseId + '/assignments?per_page=' + PER_PAGE;

        function next(pageUrl) {
            return apiGet(pageUrl).then(function (response) {
                return response.json().then(function (page) {
                    results = results.concat(page);
                    var link = response.headers.get('Link');
                    var nextUrl = link ? parseNextLink(link) : null;
                    return nextUrl ? next(nextUrl) : results;
                });
            });
        }

        return next(url);
    }

    function parseNextLink(linkHeader) {
        var parts = linkHeader.split(',');
        for (var i = 0; i < parts.length; i++) {
            var section = parts[i].split(';');
            if (section.length < 2) continue;
            if (/rel="next"/.test(section[1])) {
                var m = /<([^>]+)>/.exec(section[0]);
                if (m) return m[1];
            }
        }
        return null;
    }

    function getExternalTools() {
        var url = '/api/v1/courses/' + courseId +
                  '/external_tools?include_parents=true&per_page=' + PER_PAGE;
        // Single page is sufficient for the tool-name lookup Ski does; a course
        // with >100 external tools is not a real scenario here. If that ever
        // changes, this can adopt the same Link-paging as getAllAssignments.
        return apiGet(url).then(function (r) { return r.json(); });
    }

    // ── Row annotation ────────────────────────────────────────────────────────

    // ── Panel building blocks ─────────────────────────────────────────────────
    // Value builders below compose CPTPanel.segment() (aliased as `segment`)
    // and plain text nodes. Everything uses textContent — never innerHTML —
    // so user-controlled assignment/rubric titles cannot inject markup.

    function formatSubmissionTypes(assignment, toolsById) {
        var types = assignment.submission_types || [];

        // Classic Quizzes (legacy engine) use the online_quiz submission type.
        // Verified on the list payload: these carry is_quiz_assignment === true
        // and a quiz_id. Checked before the generic formatting below.
        if (types.indexOf('online_quiz') !== -1) {
            return 'Classic Quizzes';
        }

        var formatted = types.map(function (t) {
            return t.replace(/_/g, ' ');
        }).join('; ');

        if (formatted === 'external tool') {
            // New Quizzes (LTI engine) are external_tool assignments. Verified
            // that is_quiz_lti_assignment === true identifies them. Note
            // is_quiz_assignment is FALSE for New Quizzes and true for Classic —
            // the reverse of what the name suggests — so it is not used here.
            if (assignment.is_quiz_lti_assignment) {
                return 'New Quizzes';
            }
            var toolId = assignment.external_tool_tag_attributes &&
                         assignment.external_tool_tag_attributes.content_id;
            if (toolId && toolsById[toolId] && toolsById[toolId].name) {
                var toolName = toolsById[toolId].name;
                // Fallback: if the LTI flag is ever absent, the New Quizzes tool
                // still reports as "Quizzes 2" / "Quizzes.Next".
                if (/^Quizzes[\s.]*(Next|2)\b/i.test(toolName)) {
                    return 'New Quizzes';
                }
                return formatted + ' (' + toolName + ')';
            }
        }
        return formatted;
    }

    function buildSubmissionValue(assignment, toolsById) {
        return document.createTextNode(
            formatSubmissionTypes(assignment, toolsById) || 'None');
    }

    function buildGradeValue(assignment) {
        if (assignment.omit_from_final_grade) {
            return segment(C_WARNING, 'icon-line icon-warning',
                "Doesn't affect final grade");
        }
        return segment(C_SUCCESS, 'icon-line icon-check',
            'Affects final grade');
    }

    function buildRubricValue(assignment) {
        var rubric = assignment.rubric; // array of criteria, or undefined
        if (!rubric) {
            return segment(C_MUTED, null, 'No associated rubric');
        }

        var settings    = assignment.rubric_settings || {};
        var usedGrading = assignment.use_rubric_for_grading;
        // On the assignments endpoint outcome criteria carry `outcome_id`.
        // (The rubrics endpoint exposes the same concept as
        // `learning_outcome_id` — see rubric-info.js.)
        var hasOutcome  = rubric.some(function (c) { return !!c.outcome_id; });

        var wrap = document.createElement('span');

        if (settings.id) {
            var link = document.createElement('a');
            link.target = '_blank';
            link.href = '/courses/' + courseId + '/rubrics/' + settings.id;
            link.title = 'View rubric';
            link.style.color = C_ACCENT;
            link.textContent = settings.title || 'Rubric';
            wrap.appendChild(link);
        } else {
            wrap.appendChild(document.createTextNode(settings.title || 'Rubric'));
        }

        wrap.appendChild(document.createTextNode('  \u00b7  '));

        if (usedGrading) {
            wrap.appendChild(segment(C_SUCCESS, 'icon-line icon-check',
                'Used for grading'));
        } else {
            wrap.appendChild(segment(C_WARNING, 'icon-line icon-warning',
                'Not used for grading'));
        }

        wrap.appendChild(document.createTextNode('  \u00b7  '));
        wrap.appendChild(segment(C_MUTED, null,
            hasOutcome ? 'Has outcome criteria' : 'No outcome criteria'));

        return wrap;
    }

    // Builds the whole panel for one row and appends it.
    function buildPanel(rowInfo, row, assignment, toolsById) {
        // Idempotency: replace any prior panel so re-running the menu item
        // refreshes rather than stacking duplicates.
        var existing = row.querySelector('.' + PANEL_CLASS);
        if (existing) existing.parentNode.removeChild(existing);

        var built = CPTPanel.makePanel('Assignment details');
        built.addRow('Submission', buildSubmissionValue(assignment, toolsById));
        built.addRow('Grade', buildGradeValue(assignment));
        built.addRow('Rubric', buildRubricValue(assignment));

        rowInfo.appendChild(built.panel);
    }

    // ── Orchestration ─────────────────────────────────────────────────────────

    function loadAssignmentDetails() {
        var rows = Array.prototype.slice.call(document.querySelectorAll(ROW_SEL));
        if (rows.length === 0) return Promise.resolve();

        showLoading();

        return Promise.all([
            getAllAssignments(),
            getExternalTools().catch(function () { return []; }),
        ]).then(function (data) {
            var assignments = data[0];
            var tools       = data[1];

            var assignmentsById = {};
            assignments.forEach(function (a) { assignmentsById[a.id] = a; });

            var toolsById = {};
            tools.forEach(function (t) { toolsById[t.id] = t; });

            var panelCount = 0;

            rows.forEach(function (row) {
                var rowAssignmentId = row.dataset.itemId;
                if (!rowAssignmentId) return;

                var assignment = assignmentsById[rowAssignmentId];
                if (!assignment) return;

                var rowInfo = row.querySelector('.ig-info');
                if (!rowInfo) return;

                buildPanel(rowInfo, row, assignment, toolsById);
                panelCount++;
            });

            showControlBar(panelCount);
        }).catch(function (error) {
            console.error('[CPT] Load assignment details failed:', error);
            showError();
        });
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    watchForMenu();

})();

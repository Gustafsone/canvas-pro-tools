// user-enrollments.js
// Canvas Pro-Tools - User Enrollments (sort + filter)
// Adapted from original work by James Sekcienski (Code with Ski)
// Source: https://github.com/Code-with-Ski/Canvas-LMS-Mods/tree/main/canvas-mods/shared-locations/users/feature-enhance-courses-list
// License: MIT - see CREDITS.md
// Runs in ISOLATED world. Matches: /accounts/*/users/*, /users/*
//
// Changes from the original enhance-courses-list-user.js:
//   - Zero API calls. The original fetched /api/v1/courses/{id} once per row
//     to render course-code and SIS-ID badges. Those badges are out of scope
//     here, so the feature is pure synchronous DOM work.
//   - Filter logic is a flat predicate list rather than a nested if-pyramid.
//   - Dropdown options are built with createElement/textContent, not
//     innerHTML string concatenation, closing an HTML-injection path on
//     term names.
//   - One consistent subtitle selector throughout. The original built the
//     term list with 'a span.subtitle' but applied filters with
//     "span[class='subtitle']", which behaved differently.
//   - sortEnrollments no longer throws when a subtitle has no comma.
//   - Scope: course-name search, term dropdown, course-status dropdown.
//     The original also shipped course-code search, SIS-ID search,
//     enrollment-status and role dropdowns, and a resizable pane.
//
// Sort order (top to bottom), confirmed with Erik 2026-08-04:
//   1. Enrollment status ascending (Active, Completed, Inactive)
//   2. Default Term rows
//   3. Named non-dated terms (e.g. "Master Templates FTF") ascending
//   4. Dated terms (SEASON-YY, e.g. "FA-26") DESCENDING
//   5. Role, as final tiebreaker
// To flip the dated-term direction, change DATED_TERM_DESC below.

(function () {
    'use strict';

    var FEATURES_KEY = 'cpt_features';
    var READY_ATTR   = 'cptEnrollments';

    // Dated terms sort newest-first. Flip to false for oldest-first.
    var DATED_TERM_DESC = true;

    // Matches the MBU term vocabulary (FA-26, SP-21, SU-23, YR-25) without
    // hardcoding the season codes, so a new code sorts with the dated group
    // instead of silently landing among the named terms.
    var DATED_TERM_RE = /^[A-Za-z]{2}-\d{2}$/;

    // Term-group ranks. Lower sorts higher in the list.
    var GROUP_DEFAULT = 0;
    var GROUP_NAMED   = 1;
    var GROUP_DATED   = 2;

    var DEFAULT_TERM_LABEL = 'Default Term';

    // ── Route guard ───────────────────────────────────────────────────────

    // Canvas accepts "self" in place of a numeric id in either slot, so
    // /users/self is a real user detail page and must match. Ski's original
    // only allowed "self" in the account slot, which silently excluded a
    // logged-in user viewing their own page. The trailing (\/|$) keeps
    // /users/settings and similar sibling routes from matching.
    var path = window.location.pathname;
    var onUserPage =
        /^\/accounts\/(\d+|self)\/users\/(\d+|self)(\/|$)/.test(path) ||
        /^\/users\/(\d+|self)(\/|$)/.test(path);
    if (!onUserPage) return;

    // ── Helpers ───────────────────────────────────────────────────────────

    function collapseWhitespace(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    // Every subtitle for a row, in document order. The last one always
    // carries "<Status>, Enrolled as: <Role>". When there are two or more,
    // the first carries the term name.
    function subtitlesOf(item) {
        return [].slice.call(item.querySelectorAll('a span.subtitle'));
    }

    function termOf(item) {
        var subs = subtitlesOf(item);
        if (subs.length < 2) return '';
        return collapseWhitespace(subs[0].textContent);
    }

    // Splits the trailing subtitle into status and role. The original
    // indexed [1] unconditionally and threw on any row without a comma.
    function statusAndRoleOf(item) {
        var subs = subtitlesOf(item);
        var last = subs.length ? subs[subs.length - 1] : null;
        var text = last ? collapseWhitespace(last.textContent) : '';
        var comma = text.indexOf(',');

        if (comma === -1) {
            return { status: text, role: '' };
        }
        return {
            status: text.slice(0, comma).trim(),
            role: text.slice(comma + 1).replace('Enrolled as:', '').trim()
        };
    }

    function termGroupOf(term) {
        if (!term) return GROUP_DEFAULT;
        return DATED_TERM_RE.test(term) ? GROUP_DATED : GROUP_NAMED;
    }

    function courseNameOf(item) {
        var name = item.querySelector('a span.name');
        return collapseWhitespace(name ? name.textContent : '');
    }

    function isUnpublished(item) {
        return item.classList.contains('unpublished');
    }

    function compareStrings(a, b) {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    }

    // ── Sorting ───────────────────────────────────────────────────────────

    function sortEnrollments(list) {
        var items = [].slice.call(list.querySelectorAll('li'));

        // Decorate once so the comparator does no DOM reads. With 100+ rows
        // and a multi-key comparator, re-querying per comparison is wasteful.
        var decorated = items.map(function (item) {
            var term = termOf(item);
            var sr = statusAndRoleOf(item);
            return {
                item: item,
                term: term,
                group: termGroupOf(term),
                status: sr.status,
                role: sr.role
            };
        });

        decorated.sort(function (a, b) {
            var byStatus = compareStrings(a.status, b.status);
            if (byStatus !== 0) return byStatus;

            if (a.group !== b.group) return a.group - b.group;

            if (a.group === GROUP_DATED) {
                var byTerm = compareStrings(a.term, b.term);
                if (byTerm !== 0) return DATED_TERM_DESC ? -byTerm : byTerm;
            } else if (a.group === GROUP_NAMED) {
                var byName = compareStrings(a.term, b.term);
                if (byName !== 0) return byName;
            }

            return compareStrings(a.role, b.role);
        });

        // Re-appending an existing node moves it. A fragment keeps this to
        // a single reflow instead of one per row.
        var fragment = document.createDocumentFragment();
        decorated.forEach(function (entry) {
            fragment.appendChild(entry.item);
        });
        list.appendChild(fragment);
    }

    // ── Filtering ─────────────────────────────────────────────────────────

    // Each predicate returns true if the row should stay visible. A row shows
    // only if every predicate passes. Adding or removing a filter is a
    // one-entry change here rather than another level of nesting.
    var predicates = [];

    function applyFilters(list, countEl) {
        var items = [].slice.call(list.querySelectorAll('li'));
        var shown = 0;

        items.forEach(function (item) {
            var visible = predicates.every(function (test) {
                return test(item);
            });
            item.style.display = visible ? '' : 'none';
            if (visible) shown++;
        });

        if (countEl) {
            countEl.textContent = shown === items.length
                ? 'Showing all ' + items.length + ' enrollments'
                : 'Showing ' + shown + ' of ' + items.length + ' enrollments';
        }
    }

    // ── Controls ──────────────────────────────────────────────────────────

    function makeControlBar() {
        var bar = document.createElement('div');
        bar.className = 'cpt-enrollments-controls';
        bar.style.cssText =
            'display:flex;flex-wrap:wrap;gap:8px;align-items:center;' +
            'margin:0 0 8px;';
        return bar;
    }

    function makeSearchInput(bar, onChange) {
        var label = document.createElement('label');

        var sr = document.createElement('span');
        sr.className = 'screenreader-only';
        sr.textContent = 'Search course name';
        label.appendChild(sr);

        var input = document.createElement('input');
        input.type = 'search';
        input.id = 'cpt-course-name-search';
        input.placeholder = 'Search course name';
        input.title = 'Search course name';
        input.style.cssText = 'margin:0;';
        label.appendChild(input);

        input.addEventListener('input', onChange);
        bar.appendChild(label);

        predicates.push(function (item) {
            var needle = input.value.trim().toUpperCase();
            if (!needle) return true;
            return courseNameOf(item).toUpperCase().indexOf(needle) !== -1;
        });
    }

    function makeSelect(bar, id, srLabel, options, onChange) {
        var label = document.createElement('label');

        var sr = document.createElement('span');
        sr.className = 'screenreader-only';
        sr.textContent = srLabel;
        label.appendChild(sr);

        var select = document.createElement('select');
        select.id = id;
        select.style.cssText = 'margin:0;';

        // textContent, not innerHTML. Term names come straight off the page
        // and may contain quotes or angle brackets.
        options.forEach(function (opt) {
            var option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            select.appendChild(option);
        });

        select.addEventListener('change', onChange);
        label.appendChild(select);
        bar.appendChild(label);

        return select;
    }

    function makeTermFilter(bar, list, onChange) {
        var items = [].slice.call(list.querySelectorAll('li'));
        var seen = {};

        items.forEach(function (item) {
            var term = termOf(item);
            if (term) seen[term] = true;
        });

        // Same ordering the rows use: named terms first, then dated
        // descending. Keeps the dropdown consistent with the list.
        var terms = Object.keys(seen).sort(function (a, b) {
            var ga = termGroupOf(a);
            var gb = termGroupOf(b);
            if (ga !== gb) return ga - gb;
            var cmp = compareStrings(a, b);
            if (ga === GROUP_DATED && DATED_TERM_DESC) return -cmp;
            return cmp;
        });

        var options = [{ value: '', label: 'All Terms' }];
        options.push({ value: DEFAULT_TERM_LABEL, label: DEFAULT_TERM_LABEL });
        terms.forEach(function (term) {
            options.push({ value: term, label: term });
        });

        var select = makeSelect(
            bar, 'cpt-term-filter', 'Filter by term', options, onChange
        );

        predicates.push(function (item) {
            var selected = select.value;
            if (!selected) return true;
            var term = termOf(item);
            if (selected === DEFAULT_TERM_LABEL) return term === '';
            return term === selected;
        });
    }

    function makeCourseStatusFilter(bar, onChange) {
        var options = [
            { value: '',            label: 'All Course Statuses' },
            { value: 'published',   label: 'Published' },
            { value: 'unpublished', label: 'Unpublished' }
        ];

        var select = makeSelect(
            bar, 'cpt-course-status-filter', 'Filter by course status',
            options, onChange
        );

        predicates.push(function (item) {
            var selected = select.value;
            if (!selected) return true;
            // Canvas stamps only the unpublished state on the li. Published
            // is the absence of that token, not a token of its own.
            return selected === 'unpublished'
                ? isUnpublished(item)
                : !isUnpublished(item);
        });
    }

    // Creates the element but does not insert it. enhance() appends it last,
    // after the filter controls, so the count reads at the end of the bar.
    // Building it here without appending avoids a create-append-then-move
    // sequence that looked like a double-insert bug.
    function makeCountLabel() {
        var count = document.createElement('span');
        count.className = 'cpt-enrollments-count';
        count.setAttribute('role', 'status');
        count.setAttribute('aria-live', 'polite');
        // #6B7780 on Canvas white is 4.87:1, clearing WCAG 2.1 AA for
        // normal text.
        count.style.cssText = 'color:#6B7780;font-size:0.875rem;';
        return count;
    }

    // ── Init ──────────────────────────────────────────────────────────────

    function enhance() {
        var list = document.querySelector('#courses_list div.courses ul');
        if (!list) return;

        // Idempotency guard. Canvas can restructure this region, and a second
        // pass would stack a duplicate control bar and duplicate predicates.
        if (list.dataset[READY_ATTR] === 'ready') return;
        list.dataset[READY_ATTR] = 'ready';

        sortEnrollments(list);

        var bar = makeControlBar();
        var count = makeCountLabel();

        var onChange = function () {
            applyFilters(list, count);
        };

        // The count element is created first because onChange closes over it,
        // and the filter controls below each take onChange. It is appended
        // last so the bar reads: search, term, status, count.
        makeSearchInput(bar, onChange);
        makeTermFilter(bar, list, onChange);
        makeCourseStatusFilter(bar, onChange);
        bar.appendChild(count);

        list.parentNode.insertBefore(bar, list);
        applyFilters(list, count);
    }

    chrome.storage.local.get(FEATURES_KEY, function (result) {
        // cpt_features is namespaced per Canvas instance (hostname), with a
        // legacy flat-shape fallback until popup.js migrates it on disk.
        var all = (result && result[FEATURES_KEY]) || {};
        var looksLegacy = Object.keys(all).some(function (k) {
            return typeof all[k] === 'boolean';
        });
        var features = looksLegacy
            ? all
            : (all[window.CPT_INSTANCE_KEY || window.location.hostname] || {});

        var enabled = typeof features.userEnrollments === 'boolean'
            ? features.userEnrollments
            : false; // default OFF — must match FEATURES in popup.js. Not
                     // present in feature-flags.js DEFAULTS by design: that
                     // script never runs on /users/* or /accounts/*/users/*,
                     // so this file is the only place the default lives.
                     // Admin-facing; most users never open a user detail page.

        if (!enabled) return;

        enhance();
    });
})();

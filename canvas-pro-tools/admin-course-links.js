// admin-course-links.js
// Canvas Pro-Tools — Admin Course Links
// Adapted from original work by James Jones (james@richland.edu)
// Source: https://github.com/jamesjonesmath/canvancement/tree/master/courses/admin-course-links
// License: ISC — see CREDITS.md
// Changes: Link set is now fully configurable via chrome.storage (set in popup Links tab).
// Runs in ISOLATED world. Matches: /accounts/*

(function () {
    'use strict';

    // Run on any account page OR sub-page. Canvas swaps the Courses table in
    // via in-app navigation (pushState, no full reload), so the content script
    // does not re-run when moving People -> Courses. We must therefore stay
    // resident on sub-pages (e.g. /accounts/123/users) to catch the table when
    // it later appears. Actual injection is still gated by the courses-list
    // selector inside checkCourses(), so this is a no-op on pages that never
    // show that table.
    var pageRegex = new RegExp('^/accounts/\\d+(/|$)');
    if (!pageRegex.test(window.location.pathname)) return;

    var LINKS_KEY    = 'cpt_admin_links';
    var FEATURES_KEY = 'cpt_features';
    var wrapperClass = 'cpt_course_links';

    // ── Default built-in links ─────────────────────────────────────────────
    // enabled: true  = on by default
    // enabled: false = off by default
    // custom: false  = built-in (not deletable)
    // custom: true   = user-added (deletable)

    var BUILTIN_LINKS = [
        { id: 'assignments',         path: 'assignments',         label: 'Assignments',  enabled: true,  custom: false },
        { id: 'modules',             path: 'modules',             label: 'Modules',      enabled: true,  custom: false },
        { id: 'users',               path: 'users',               label: 'People',       enabled: true,  custom: false },
        { id: 'grades',              path: 'grades',              label: 'Grades',       enabled: true,  custom: false },
        { id: 'files',               path: 'files',               label: 'Files',        enabled: true,  custom: false },
        { id: 'syllabus',            path: 'assignments/syllabus',label: 'Syllabus',     enabled: true,  custom: false },
        { id: 'settings',            path: 'settings',            label: 'Settings',     enabled: false, custom: false },
        { id: 'announcements',       path: 'announcements',       label: 'Announcements',enabled: false, custom: false },
        { id: 'discussion_topics',   path: 'discussion_topics',   label: 'Discussions',  enabled: false, custom: false },
        { id: 'outcomes',            path: 'outcomes',            label: 'Outcomes',     enabled: false, custom: false },
        { id: 'pages',               path: 'pages',               label: 'Pages',        enabled: false, custom: false },
        { id: 'quizzes',             path: 'quizzes',             label: 'Quizzes',      enabled: false, custom: false },
    ];

    // ── CSS ────────────────────────────────────────────────────────────────

    var wrapperCSS = [
        '.' + wrapperClass + ' ul { list-style: none; font-size: 0.8rem; margin-left: 0; margin-top: 2px; }',
        '.' + wrapperClass + ' ul li { display: inline; }',
        '.' + wrapperClass + ' ul li:not(:first-child):before { content: " | "; color: #c7cdd1; }',
        '.' + wrapperClass + ' ul li a { color: #0770a3; text-decoration: none; }',
        '.' + wrapperClass + ' ul li a:hover { text-decoration: underline; }',
    ];

    function injectCSS() {
        var style = document.createElement('style');
        style.id  = 'cpt-admin-links-css';
        document.head.appendChild(style);
        wrapperCSS.forEach(function (rule, i) {
            style.sheet.insertRule(rule, i);
        });
    }

    // ── Build link config from storage ────────────────────────────────────
    // Reads the unified order[] array written by the popup Links tab.
    // Falls back to BUILTIN_LINKS defaults on first load.

    function buildLinkConfig(saved, cb) {
        var order = saved.order;

        if (Array.isArray(order) && order.length > 0) {
            // Unified format — use as-is, add any new builtins not yet in list
            var existingIds = order.map(function (l) { return l.id; });
            var newBuiltins = BUILTIN_LINKS.filter(function (l) {
                return existingIds.indexOf(l.id) === -1;
            });
            cb(order.concat(newBuiltins));
            return;
        }

        // Legacy / first load — migrate from old separate format
        var savedLinks  = saved.links  || [];
        var savedCustom = saved.custom || [];

        var builtins = BUILTIN_LINKS.map(function (link) {
            var match = savedLinks.find(function (s) { return s.id === link.id; });
            return {
                id:      link.id,
                path:    link.path,
                label:   link.label,
                enabled: match ? match.enabled : link.enabled,
                custom:  false,
            };
        });

        var customs = savedCustom.map(function (c) {
            return { id: c.id, path: c.path, label: c.label,
                     enabled: c.enabled !== false, custom: true };
        });

        cb(builtins.concat(customs));
    }

    // ── DOM helpers ────────────────────────────────────────────────────────

    function checkCourses(links) {
        var enabled = links.filter(function (l) { return l.enabled; });
        if (enabled.length === 0) return;

        var sel1 = 'tbody[data-automation="courses list"] tr td:nth-child(2) > a';
        var el1  = document.querySelectorAll(sel1);

        el1.forEach(function (anchor) {
            if (anchor.parentNode.querySelector('.' + wrapperClass)) return;
            var div = buildLinks(anchor.href, enabled);
            if (div) anchor.parentNode.appendChild(div);
        });
    }

    function buildLinks(base, links) {
        // Strip query strings from base URL, keep just the course URL
        var cleanBase = base.split('?')[0].replace(/\/$/, '');

        var div = document.createElement('div');
        div.classList.add(wrapperClass);

        var ul = document.createElement('ul');

        links.forEach(function (link) {
            var li = document.createElement('li');
            var a  = document.createElement('a');
            a.href      = cleanBase + '/' + link.path;
            a.textContent = link.label;
            li.appendChild(a);
            ul.appendChild(li);
        });

        div.appendChild(ul);
        return div;
    }

    function addMutationObserver(links) {
        // Observe a container that survives Canvas's in-app navigation. The
        // inner #content node can be swapped out when moving between account
        // sub-pages, so binding the observer to #content would stop firing
        // after a navigation. Watch a stable ancestor instead and re-check for
        // the courses table on each batch of mutations. The check is debounced
        // via requestAnimationFrame so a burst of SPA re-renders collapses into
        // a single checkCourses() call. checkCourses() is idempotent (it skips
        // anchors that already have links) and no-ops when no table is present.
        var root = document.getElementById('application') || document.body;
        if (!root) return;

        var pending = false;
        var observer = new MutationObserver(function () {
            if (pending) return;
            pending = true;
            requestAnimationFrame(function () {
                pending = false;
                checkCourses(links);
            });
        });
        observer.observe(root, { childList: true, subtree: true });
    }

    // ── Init ──────────────────────────────────────────────────────────────

    chrome.storage.local.get([FEATURES_KEY, LINKS_KEY], function (result) {
        // cpt_features is namespaced per Canvas instance (hostname), with a
        // legacy flat-shape fallback until popup.js migrates it on disk.
        var allFeatures = (result && result[FEATURES_KEY]) || {};
        var featLegacy  = Object.keys(allFeatures).some(function (k) {
            return typeof allFeatures[k] === 'boolean';
        });
        var features = featLegacy ? allFeatures : (allFeatures[window.location.hostname] || {});
        var enabled  = typeof features.adminCourseLinks === 'boolean'
            ? features.adminCourseLinks
            : false; // default OFF — must match FEATURES in popup.js and
                     // DEFAULTS in feature-flags.js. Admin-facing: most users
                     // never open /accounts/* pages, so this earns its place
                     // only for the deans and admins who turn it on.

        if (!enabled) return;

        var INSTANCE_KEY = window.CPT_INSTANCE_KEY || window.location.hostname;
        var allInstances = (result && result[LINKS_KEY]) || {};

        // chrome.storage.local[LINKS_KEY] is namespaced per Canvas instance:
        // { "<hostname>": { order: [...], links: [...], custom: [...] } }
        // If the top-level object still has a legacy un-namespaced shape
        // (order/links/custom directly at the top), use it as-is for this
        // instance — popup.js performs the on-disk migration to the
        // namespaced shape.
        var looksLegacy = Array.isArray(allInstances.order)
            || Array.isArray(allInstances.links)
            || Array.isArray(allInstances.custom);

        var saved = looksLegacy ? allInstances : (allInstances[INSTANCE_KEY] || {});

        buildLinkConfig(saved, function (links) {
            injectCSS();
            checkCourses(links);
            addMutationObserver(links);
        });
    });

})();

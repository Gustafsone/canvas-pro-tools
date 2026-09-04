// rubric-sorter.js
// Canvas Pro-Tools — Find Rubric Sorter
// Adapted from original work by James Jones (james@richland.edu)
// Source: https://github.com/jamesjonesmath/canvancement/blob/master/rubrics/find-rubric-sorter/find-rubric-sorter.user.js
// License: ISC — see CREDITS.md
// Changes: jQuery $.ajax replaced with fetch(). All sort/display logic preserved.
// Runs in MAIN_WORLD to access window.ENV and page jQuery (for dialog detection).
// Matches: /courses/*/assignments/*, /courses/*/quizzes/*, /courses/*/discussion_topics/*

(function () {
    'use strict';

    // Only run on individual item pages, not list pages
    var assignRegex = new RegExp('^/courses/[0-9]+/(assignments|quizzes|discussion_topics)/[0-9]+$');
    if (!assignRegex.test(window.location.pathname)) {
        return;
    }

    // Feature flag — reads data attribute stamped by feature-flags.js (ISOLATED world)
    if (document.documentElement.dataset.cptRubricPlus === 'false') return;

    // ── Configuration ─────────────────────────────────────────────────────────
    // sortOrder:
    //   0 — do not sort
    //   1 — courses first, then name, then term
    //   2 — courses first, then term, then name
    //   3 — accounts first, then name, then term  (default)
    //   or provide a custom array of keys e.g. ['context+', 'title', 'term']

    var config = {
        sortOrder:       3,
        courseLookup:    true,   // fetch course+term info from Canvas API
        addTerm:         true,   // show term name beneath course name
        removeCount:     false,  // hide rubric count, show only term
        prependTerm:     true,   // put term before rubric count
        hideDays:        -1,     // hide courses ended > N days ago (-1 = show all)
        hideUnknown:     false,  // hide courses not in your course list
        hideAccounts:    false,  // hide account-level contexts
        hideNeverending: false,  // hide courses with no term end date
        separator:       ' | '  // string between rubric count and term
    };

    // ── Internals ─────────────────────────────────────────────────────────────

    var sortableKeys = {
        'name'       : 's+',
        'title'      : 's+',
        'context'    : 's-',
        'courseEnd'  : 'd-',
        'courseStart': 'd-',
        'termName'   : 's-',
        'termStart'  : 'd-',
        'termEnd'    : 'd-',
        'term'       : ':termEnd'
    };

    var predefinedSorts = {
        1: ['context', 'name', 'term'],
        2: ['context', 'term', 'name'],
        3: ['context+', 'name', 'term']
    };

    var courseData      = [];
    var contextInfo     = {};
    var contextRegex    = new RegExp('^(account|course)_([0-9]+)$');
    var isCurrentFirst  = false;

    checkDialog();

    // ── Dialog detection ──────────────────────────────────────────────────────
    // The "Find a Rubric" dialog is injected into the DOM dynamically.
    // Watch for it to appear, then process the course list inside it.

    function checkDialog() {
        var selector = 'ul.rubrics_dialog_contexts_select';
        if (document.querySelector(selector)) {
            checkList();
        } else {
            var observer = new MutationObserver(function (mutations) {
                var found = mutations.some(function (m) {
                    return m.addedNodes.length === 1 &&
                           m.addedNodes[0].querySelector &&
                           m.addedNodes[0].querySelector(selector);
                });
                if (found) {
                    observer.disconnect();
                    checkList();
                }
            });
            observer.observe(document.body, { childList: true });
        }
    }

    function checkList() {
        var selector = 'ul.rubrics_dialog_contexts_select';
        var element  = document.querySelector(selector);
        if (!element) return;

        if (element.children.length > 1) {
            processList();
        } else {
            var observer = new MutationObserver(function () {
                observer.disconnect();
                processList();
            });
            observer.observe(element, { childList: true });
        }
    }

    // ── List processing ───────────────────────────────────────────────────────

    function processList() {
        var list           = getContextList();
        var currentContext = window.ENV && window.ENV.context_asset_string;

        // Move the current course to the top of the list
        if (list.length > 1 && currentContext) {
            waitForLoad(list[0], 1);
            var parent = list[0].parentNode;
            if (parent && typeof contextInfo[currentContext] !== 'undefined') {
                isCurrentFirst = true;
                var currentPosition = contextInfo[currentContext].row;
                if (currentPosition > 0) {
                    var current = list[currentPosition];
                    parent.insertBefore(current, list[0]);
                    waitForLoad(current, 2);
                    current.click();
                }
            }
        }

        if (config.courseLookup) {
            fetchAllCourses('/api/v1/courses?include[]=term&per_page=50')
                .then(function (data) {
                    courseData = data;
                    addCourseInfo();
                })
                .catch(function (err) {
                    console.warn('[Canvas Pro-Tools Rubric Sorter] Course lookup failed:', err);
                    sortList();
                });
        } else {
            sortList();
        }
    }

    // ── Canvas API fetch (replaces jQuery $.ajax + pagination) ────────────────

    function fetchAllCourses(url) {
        return new Promise(function (resolve, reject) {
            var results = [];

            function fetchPage(pageUrl) {
                fetch(pageUrl, {
                    credentials: 'same-origin',
                    headers: { 'Accept': 'application/json' }
                })
                .then(function (response) {
                    if (!response.ok) {
                        throw new Error('HTTP ' + response.status);
                    }
                    // Extract next-page URL from Link header before consuming body
                    var linkHeader = response.headers.get('Link');
                    var nextUrl    = parseNextUrl(linkHeader);

                    return response.json().then(function (data) {
                        if (Array.isArray(data)) {
                            results = results.concat(data);
                        }
                        if (nextUrl) {
                            fetchPage(nextUrl);
                        } else {
                            resolve(results);
                        }
                    });
                })
                .catch(reject);
            }

            fetchPage(url);
        });
    }

    function parseNextUrl(linkHeader) {
        if (!linkHeader) return null;
        var parts    = linkHeader.split(',');
        var nextRegex = /^<(.*)>; rel="next"$/;
        for (var i = 0; i < parts.length; i++) {
            var match = nextRegex.exec(parts[i].trim());
            if (match) return match[1];
        }
        return null;
    }

    // ── Course info enrichment ────────────────────────────────────────────────

    function addCourseInfo() {
        var list = getContextList();
        if (list.length === 0) { sortList(); return; }

        var sep      = config.separator;
        var addTerm  = config.addTerm;

        courseData.forEach(function (course) {
            var courseCode = 'course_' + course.id;
            if (typeof contextInfo[courseCode] === 'undefined') return;

            var context   = contextInfo[courseCode];
            var courseRow = context.row;
            var el        = list[courseRow];

            context.courseStart = course.start_at;
            context.courseEnd   = course.end_at;

            if (course.name) {
                context.title = course.name;
                var anchor = el && el.querySelector('a');
                if (anchor) anchor.title = course.name;
            }

            if (addTerm && course.term) {
                context.termName  = course.term.name;
                context.termStart = course.term.start_at;
                context.termEnd   = course.term.end_at;

                var div = el && el.querySelector('div.rubrics');
                if (div) {
                    var rubricCount = div.textContent;
                    var txt;
                    if (config.removeCount) {
                        txt = course.term.name;
                    } else if (config.prependTerm) {
                        txt = course.term.name + sep + rubricCount;
                    } else {
                        txt = rubricCount + sep + course.term.name;
                    }
                    div.textContent = txt;
                }
            }
        });

        sortList();
    }

    // ── Sorting ───────────────────────────────────────────────────────────────

    function sortList() {
        hideContent();
        var keys = determineSortOrder(config.sortOrder);
        if (keys === false) return;

        var list = getContextList();
        if (!list || list.length < (isCurrentFirst ? 3 : 2)) return;

        var parent = list[0].parentNode;
        if (!parent) return;

        var currentContext = window.ENV && window.ENV.context_asset_string;
        var contextKeys    = Object.keys(contextInfo);
        var items          = contextKeys.filter(function (k) {
            return typeof contextInfo[k].hidden === 'undefined' || !contextInfo[k].hidden;
        });

        items.sort(function multisort(a, b) {
            var current = (a === currentContext ? -1 : 0) + (b === currentContext ? 1 : 0);
            if (current !== 0) return current;

            var order = 0;
            for (var i = 0; i < keys.length && order === 0; i++) {
                var key = keys[i];
                var A   = contextInfo[a][key.key] !== undefined ? contextInfo[a][key.key] : null;
                var B   = contextInfo[b][key.key] !== undefined ? contextInfo[b][key.key] : null;
                if (A === B) continue;
                if (A !== null && B !== null) {
                    order = key.type === 's' ? A.localeCompare(B) : (A < B ? -1 : 1);
                } else {
                    order = A === null ? -1 : 1;
                }
                if (order !== 0 && !key.asc) order = -order;
            }
            return order;
        });

        var rows  = items.map(function (k) { return list[contextInfo[k].row]; });
        var start = isCurrentFirst ? 1 : 0;
        var top   = list[start];

        for (var k = rows.length - 1; k >= start; k--) {
            top = parent.insertBefore(rows[k], top);
        }

        if (!isCurrentFirst) {
            waitForLoad(top, 2);
            top.click();
        }
    }

    function determineSortOrder(userOrder) {
        if (typeof userOrder === 'undefined') return false;
        var keyRegex     = /^([a-zA-Z]+)([+-])?$/;
        var keyInfoRegex = /^([sd])([+-])$/;

        if (typeof userOrder !== 'object' && /^[0-9]+$/.test(userOrder)) {
            if (predefinedSorts[userOrder]) userOrder = predefinedSorts[userOrder];
        }
        if (!Array.isArray(userOrder)) return false;

        var sortOrder = [];
        userOrder.forEach(function (entry) {
            var m = keyRegex.exec(entry);
            if (!m) return;
            var key = m[1];
            // Resolve aliases (e.g. 'term' → 'termEnd')
            while (sortableKeys[key] && /^:/.test(sortableKeys[key])) {
                key = sortableKeys[key].substr(1);
            }
            if (!sortableKeys[key]) return;
            var ki   = keyInfoRegex.exec(sortableKeys[key]);
            var type = ki ? ki[1] : 's';
            var asc  = ki ? ki[2] === '+' : true;
            if (m[2]) asc = m[2] === '+';
            sortOrder.push({ key: key, asc: asc, type: type });
        });

        return sortOrder.length > 0 ? sortOrder : false;
    }

    // ── Hide logic ────────────────────────────────────────────────────────────

    function hideContent() {
        var hideDate  = false;
        var hideAccounts    = config.hideAccounts    || false;
        var hideUnknown     = config.hideUnknown     || false;
        var hideNeverending = config.hideNeverending || false;

        if (config.hideDays >= 0) {
            var dt = new Date();
            dt.setDate(dt.getDate() - config.hideDays);
            hideDate = dt.toISOString().replace(/[.][0-9]{3}Z$/, 'Z');
        }

        var list        = getContextList();
        var codes       = Object.keys(contextInfo);
        var hiddenCount = 0;
        var currentCtx  = window.ENV && window.ENV.context_asset_string;

        codes.forEach(function (code) {
            var ctx    = contextInfo[code];
            var hidden = false;
            if (ctx.code === currentCtx) return;
            if (hideAccounts     && ctx.context === 'account') hidden = true;
            if (hideUnknown      && ctx.context === 'course' && typeof ctx.title === 'undefined') hidden = true;
            if (hideDate         && ctx.context === 'course' && ctx.courseEnd && ctx.courseEnd < hideDate) hidden = true;
            if (hideNeverending  && ctx.context === 'course' && ctx.termEnd === null) hidden = true;
            if (hidden) { ctx.hidden = true; hiddenCount++; }
        });

        if (hiddenCount > 0 && hiddenCount < codes.length) {
            codes.forEach(function (code) {
                if (contextInfo[code].hidden) {
                    list[contextInfo[code].row].style.display = 'none';
                }
            });
        }
    }

    // ── DOM helpers ───────────────────────────────────────────────────────────

    function getContextList() {
        var selector = 'ul.rubrics_dialog_contexts_select li:not(.blank)';
        var list     = document.querySelectorAll(selector);
        list.forEach(function (item, i) {
            var ctx = getContext(item);
            if (!ctx) return;
            if (typeof contextInfo[ctx.code] === 'undefined') {
                contextInfo[ctx.code]      = ctx;
                contextInfo[ctx.code].name = getName(item);
            }
            contextInfo[ctx.code].row = i;
        });
        return list;
    }

    function getName(item) {
        var el = item.querySelector('span.name');
        return el ? el.textContent : undefined;
    }

    function getContext(item) {
        var el = item.querySelector('span.context_code');
        if (!el) return undefined;
        return parseContextCode(el.textContent);
    }

    function parseContextCode(code) {
        var m = contextRegex.exec(code);
        if (!m) return undefined;
        return { code: code, context: m[1], id: m[2] };
    }

    function waitForLoad(element, phase) {
        if (!element) return;
        if (element.classList.contains('loaded')) {
            onLoaded(phase);
        } else {
            var obs = new MutationObserver(function () {
                if (element.classList.contains('loaded')) {
                    obs.disconnect();
                    onLoaded(phase);
                }
            });
            obs.observe(element, { attributes: true });
        }
    }

    // Phase 1 = first item loaded (course list ready to read)
    // Phase 2 = selected item loaded (safe to click)
    var _phase1Done = false;
    function onLoaded(phase) {
        if (phase === 1) {
            _phase1Done = true;
        } else if (phase === 2 && _phase1Done) {
            loadCurrentContext();
        }
    }

    function loadCurrentContext() {
        var list = getContextList();
        if (list.length > 1) list[0].click();
    }

})();

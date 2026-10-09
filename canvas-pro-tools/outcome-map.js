// outcome-map.js
// Canvas Pro-Tools - Outcome Map
//
// Adds an "Outcome Map" button to the classic course Outcomes page toolbar.
// The button opens the same page in a new tab with the #cpt-outcome-map hash.
// In that tab this script hides Canvas's page chrome and renders, inside a
// Shadow DOM host so Canvas CSS cannot leak in:
//   - Summary tiles
//   - Map tab: assignments and aligned Classic Quiz question banks as rows,
//     outcomes as columns (grouped by outcome group), a mark where an
//     assignment's rubric has a criterion for an outcome or a question bank is
//     aligned to it, and per-row / per-column counts. A scope note says what
//     the map includes, whether outcome criteria count toward the grade, and,
//     for Blueprint courses, where shared content is managed.
//   - Cleanup tab: a suggested fix order, a Likely remove list, possible
//     duplicate outcomes, outcomes nothing uses, outcomes that may belong to
//     another course, unattached rubrics that carry outcomes, assignments with
//     no outcome, duplicate rubric copies, outcomes used but not linked in the
//     course, and a note when more than one outcome group is in use. Each
//     outcome row says whether Canvas will let you remove it now (can_unlink).
//   - Every outcome is tagged with its source: Institution (account-level),
//     This course, or Other course (course-level outcome created elsewhere).
//     A "Likely remove" hint marks (a) course-level duplicates nothing uses,
//     when the set has another member worth keeping, and (b) outcomes whose
//     description names a different course code than this course.
//   - Refresh, Export Map CSV, Export Cleanup CSV, Print (landscape)
//
// LOADING. Phase 1 (parallel, about 2 s): course, blueprint subscription,
// outcome_group_links, assignment_groups, assignments, rubrics. The map is
// drawn right away. Phase 2: the course's Classic Quiz question banks, read
// four at a time from each bank's own page (the only place Canvas exposes a
// bank's aligned outcomes). Cleanup checks and the "used" counts wait for
// phase 2, so an outcome assessed only through a quiz bank is never shown as
// unused or Likely remove.
//
// READ-ONLY. Same-origin GET requests only. Nothing in Canvas is changed and
// nothing is written to chrome.storage. No student data (submissions, scores,
// rollups) is requested.
//
// Probe evidence (courses 29965, 43251, 41902; 2026-10-08/09):
//   - outcome_group_links?outcome_style=full returns outcome + outcome_group;
//     link.can_unlink is true only for outcomes with no remaining alignment
//   - outcome.assessed is true for every Institution outcome, so it cannot tell
//     this course's results apart; it is shown for course-level outcomes only
//   - assignments[].rubric[] criteria carry outcome_id and ignore_for_scoring;
//     rubric_settings.id identifies the attached rubric
//   - rubrics list returns data[] with learning_outcome_id (no per-rubric calls)
//   - course.blueprint marks a Blueprint master; a child has a
//     blueprint_subscriptions entry naming its master, and its assignments
//     carry is_master_course_child_content / restricted_by_master_course
//   - /courses/:id/question_banks (Accept: JSON) lists banks; each bank page
//     lists aligned outcomes as #aligned_outcomes_list li.outcome[data-id]
//     with "mastery at N%". Pages are large (up to ~575 KB): 19 banks took
//     40.7 s one at a time, hence phase 2 with four in flight
//   - outcome_alignments?assignment_id=<quiz> returns nothing for bank-based
//     quizzes, and GraphQL LearningOutcome.alignments is null here
//   - contributing_scores is deliberately NOT used: it returns student scores
//   - Outcomes page CSP is frame-ancestors only, so Blob downloads work
//   - Toolbar is div.toolbar.outcomes-toolbar; Find is button.find_outcome
//
// Runs in ISOLATED world (default). No window.ENV or page jQuery needed.
// Match: /courses/*/outcomes (index only). cpt-panel.js loads first for COLORS.

(function () {
    'use strict';

    // -- Route guard --------------------------------------------------------
    // Index page only: /courses/<id>/outcomes, optional trailing slash.
    // Outcome detail pages (/outcomes/<id>) are excluded.

    var match = /^\/courses\/([0-9]+)\/outcomes\/?$/.exec(window.location.pathname);
    if (!match) return;
    var courseId = match[1];

    // -- Feature flag - stamped by feature-flags.js ---------------------------
    // Default ON: an unstamped attribute (undefined) is treated as enabled,
    // the same convention as assignment-details.js.

    if (document.documentElement.dataset.cptOutcomeMap === 'false') return;

    // -- Constants ------------------------------------------------------------

    var MAP_HASH          = '#cpt-outcome-map';
    var BUTTON_ID         = 'cpt-om-open';
    var HOST_ID           = 'cpt-om-host';
    var TAKEOVER_STYLE_ID = 'cpt-om-takeover-style';
    var ACTIVE_CLASS      = 'cpt-om-active';
    var TOOLBAR_SEL       = '.outcomes-toolbar';
    var FIND_SEL          = '.find_outcome';
    var TOOLBAR_WAIT_MS   = 15000;
    var PER_PAGE          = 100;
    var MAX_PAGES         = 50;
    var BANK_CONCURRENCY  = 4;
    var BANK_ALIGNED_SEL  = '#aligned_outcomes_list li.outcome:not(.blank)';

    // Possible-duplicate threshold: Jaccard similarity of content words, with
    // the leading number removed. Tested against course 29965 titles: 0.5
    // groups "Explain current and evolving healthcare quality management
    // approaches" with "Evaluate current and evolving ..." and the three
    // "1. Analyze the role informatics plays ..." versions, but not
    // "Examine the role of information management systems ..." with
    // "Evaluate leadership strategies ..." (well below).
    // The leading number is NOT required to match: probe data showed
    // "4. Apply concepts of quality and safety ..." re-numbered as "7.Apply ...".
    var SIMILARITY_THRESHOLD = 0.5;

    var STOPWORDS = {};
    ('a an and are as at be by for from in into is it its of on or that the ' +
     'their this to with within between among using use via').split(' ')
        .forEach(function (w) { STOPWORDS[w] = true; });

    // Shared palette from cpt-panel.js; fallback keeps this file usable if the
    // manifest order ever changes.
    var COLORS = (typeof CPTPanel !== 'undefined' && CPTPanel.COLORS) || {
        accent: '#0770a3', accentBg: '#e8f4fb', surface: '#ffffff',
        border: '#c7cdd1', header: '#5f6b73', success: '#166b3a',
        warning: '#7a4f00', muted: '#4a6070', text: '#2d3b45'
    };

    // Current map state. runToken guards against a slow load finishing after
    // the user pressed Refresh.
    var state = { model: null, runToken: 0 };

    // -- Entry ----------------------------------------------------------------

    if (window.location.hash === MAP_HASH) {
        startMapMode();
    } else {
        injectButton();
    }

    // Entering or leaving map mode in the same tab (editing the URL, Back
    // button) reloads, so the page is never half Canvas, half map. Other hash
    // changes Canvas itself makes are ignored.
    window.addEventListener('hashchange', function () {
        var inMap = !!document.getElementById(HOST_ID);
        if ((window.location.hash === MAP_HASH) !== inMap) window.location.reload();
    });

    // =========================================================================
    // Button on the Outcomes page
    // =========================================================================

    function injectButton() {
        if (tryInsertButton()) return;
        if (!document.body) return;
        var obs = new MutationObserver(function () {
            if (tryInsertButton()) obs.disconnect();
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(function () { obs.disconnect(); }, TOOLBAR_WAIT_MS);
    }

    function tryInsertButton() {
        if (document.getElementById(BUTTON_ID)) return true;
        var toolbar = document.querySelector(TOOLBAR_SEL);
        if (!toolbar) return false;

        // An <a> rather than a <button>: it is navigation, and middle-click /
        // Ctrl+click work as users expect. The jQuery UI classes match the
        // look of the neighbouring Find button.
        var a = document.createElement('a');
        a.id = BUTTON_ID;
        a.href = '/courses/' + courseId + '/outcomes' + MAP_HASH;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'ui-button ui-widget ui-state-default ui-corner-all';
        a.setAttribute('aria-label', 'Outcome Map (opens in a new tab)');
        a.title = 'See every outcome and the assignments and question banks aligned to it (opens in a new tab)';
        a.style.cssText =
            'margin-left:6px;padding:6px 12px;text-decoration:none;' +
            'display:inline-flex;align-items:center;gap:6px;vertical-align:middle;';

        var icon = document.createElement('i');
        icon.className = 'icon-line icon-outcomes';
        icon.setAttribute('aria-hidden', 'true');
        a.appendChild(icon);
        a.appendChild(document.createTextNode('Outcome Map'));

        var find = toolbar.querySelector(FIND_SEL);
        if (find && find.parentNode === toolbar) {
            find.insertAdjacentElement('afterend', a);
        } else {
            toolbar.appendChild(a);
        }
        return true;
    }

    // =========================================================================
    // Map mode (new tab)
    // =========================================================================

    function startMapMode() {
        takeOverPage();
        var ui = buildShell();
        run(ui);
    }

    // One full load: phase 1 draws the map, phase 2 reads question banks and
    // then completes the Cleanup checks. Also used by Refresh and Try again.
    function run(ui) {
        var token = ++state.runToken;
        var t0 = performance.now();
        setBusy(ui, true);
        setStatus(ui, 'Loading outcomes, assignments and rubrics...', true);

        loadData()
            .then(function (raw) {
                if (token !== state.runToken) return null;
                var model = buildModel(raw);
                state.model = model;
                renderAll(ui, model);
                return loadBanks(model, function (done, total) {
                    if (token !== state.runToken) return;
                    setStatus(ui, 'Map ready. Checking question banks: ' + done + ' of ' + total +
                        '... Cleanup results appear when this finishes.', true);
                }).then(function () {
                    if (token !== state.runToken) return;
                    finishModel(model);
                    renderAll(ui, model);
                    setBusy(ui, false);
                    var secs = ((performance.now() - t0) / 1000).toFixed(1);
                    var b = model.banks;
                    setStatus(ui, 'Loaded ' + plural(model.outcomes.length, 'outcome') + ', ' +
                        plural(model.assignments.length, 'assignment') + ', ' +
                        plural(model.rubrics.length, 'rubric') + ' and ' +
                        (b.state === 'error' ? 'no question banks (they could not be read)'
                                             : plural(b.list.length, 'question bank')) +
                        ' in ' + secs + ' s. Read-only: nothing in Canvas was changed.', false);
                });
            })
            .catch(function (err) {
                if (token !== state.runToken) return;
                setBusy(ui, false);
                showError(ui, err);
            });
    }

    // Hide Canvas's page and host the map in a Shadow DOM so Canvas CSS cannot
    // restyle it. @page must live in the document stylesheet (it has no effect
    // inside a shadow root), which is why print orientation is set here.
    function takeOverPage() {
        if (!document.getElementById(TAKEOVER_STYLE_ID)) {
            var style = document.createElement('style');
            style.id = TAKEOVER_STYLE_ID;
            style.textContent =
                'html.' + ACTIVE_CLASS + ' body > :not(#' + HOST_ID + '){display:none !important;}' +
                // Only the window scrolls. If body also had overflow set, it
                // would become the scroll container for position:sticky and
                // the map headers would scroll away with the page.
                'html.' + ACTIVE_CLASS + '{height:auto !important;overflow:auto !important;}' +
                'html.' + ACTIVE_CLASS + ' body{' +
                    'height:auto !important;overflow:visible !important;' +
                    'margin:0 !important;padding:0 !important;background:#f5f6f7 !important;}' +
                '@media print{' +
                    '@page{size:landscape;margin:0.4in;}' +
                    'html.' + ACTIVE_CLASS + ',html.' + ACTIVE_CLASS + ' body{background:#fff !important;}' +
                '}';
            (document.head || document.documentElement).appendChild(style);
        }
        document.documentElement.classList.add(ACTIVE_CLASS);
        document.title = 'Outcome Map';
    }

    // -- Shell ----------------------------------------------------------------

    function buildShell() {
        var host = document.createElement('div');
        host.id = HOST_ID;
        document.body.appendChild(host);
        var root = host.attachShadow({ mode: 'open' });

        var style = document.createElement('style');
        style.textContent = shadowCss();
        root.appendChild(style);

        var page = el('div', { class: 'page' });
        root.appendChild(page);

        var titleEl = el('h1', { text: 'Outcome Map' });
        var courseEl = el('div', { class: 'course', text: 'Loading course...' });

        var btnRefresh = el('button', { type: 'button', class: 'btn', disabled: true, text: 'Refresh',
            title: 'Reload everything from Canvas, for example after fixing something' });
        var btnMap = el('button', { type: 'button', class: 'btn', disabled: true, text: 'Export Map CSV' });
        var btnClean = el('button', { type: 'button', class: 'btn', disabled: true, text: 'Export Cleanup CSV' });
        var btnPrint = el('button', { type: 'button', class: 'btn', disabled: true, text: 'Print' });
        var back = el('a', { class: 'btn', href: '/courses/' + courseId + '/outcomes', text: 'Canvas Outcomes page' });

        var header = el('header', { class: 'top' }, [
            el('div', null, [titleEl, courseEl]),
            el('div', { class: 'actions no-print' }, [btnRefresh, btnMap, btnClean, btnPrint, back])
        ]);

        var status = el('div', { class: 'status no-print', role: 'status', 'aria-live': 'polite' });
        var tiles = el('section', { class: 'tiles', 'aria-label': 'Summary' });

        var tabMap = el('button', { type: 'button', role: 'tab', id: 'om-tab-map', 'aria-controls': 'om-panel-map', 'aria-selected': 'true', class: 'tab', text: 'Map' });
        var tabClean = el('button', { type: 'button', role: 'tab', id: 'om-tab-clean', 'aria-controls': 'om-panel-clean', 'aria-selected': 'false', tabindex: '-1', class: 'tab', text: 'Cleanup' });
        var tablist = el('div', { role: 'tablist', 'aria-label': 'Outcome Map views', class: 'tablist no-print' }, [tabMap, tabClean]);

        var panelMap = el('section', { role: 'tabpanel', id: 'om-panel-map', 'aria-labelledby': 'om-tab-map', class: 'panel' });
        var panelClean = el('section', { role: 'tabpanel', id: 'om-panel-clean', 'aria-labelledby': 'om-tab-clean', class: 'panel', hidden: true });

        page.appendChild(header);
        page.appendChild(status);
        page.appendChild(tiles);
        page.appendChild(tablist);
        page.appendChild(panelMap);
        page.appendChild(panelClean);

        var tabs = [tabMap, tabClean];
        var panels = [panelMap, panelClean];
        function select(i, focus) {
            tabs.forEach(function (t, j) {
                var on = i === j;
                t.setAttribute('aria-selected', on ? 'true' : 'false');
                t.setAttribute('tabindex', on ? '0' : '-1');
                panels[j].hidden = !on;
            });
            if (focus) tabs[i].focus();
            if (i === 0) refreshStickyOffsets(panelMap);
        }
        tabs.forEach(function (t, i) {
            t.addEventListener('click', function () { select(i, false); });
            t.addEventListener('keydown', function (e) {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault();
                    select((i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length, true);
                } else if (e.key === 'Home') { e.preventDefault(); select(0, true); }
                else if (e.key === 'End') { e.preventDefault(); select(tabs.length - 1, true); }
            });
        });

        var ui = {
            root: root, page: page, courseEl: courseEl, status: status, tiles: tiles,
            tabClean: tabClean, panelMap: panelMap, panelClean: panelClean,
            btnRefresh: btnRefresh, btnMap: btnMap, btnClean: btnClean, btnPrint: btnPrint
        };

        // Listeners attach once and read the current model, so Refresh never
        // stacks duplicate handlers.
        btnRefresh.addEventListener('click', function () { run(ui); });
        btnMap.addEventListener('click', function () {
            if (state.model) downloadCsv(mapCsv(state.model), fileStem(state.model) + '_outcome-map.csv');
        });
        btnClean.addEventListener('click', function () {
            if (state.model) downloadCsv(cleanupCsv(state.model), fileStem(state.model) + '_outcome-cleanup.csv');
        });
        btnPrint.addEventListener('click', function () { window.print(); });

        return ui;
    }

    function setBusy(ui, busy) {
        ui.btnRefresh.disabled = busy;
        ui.btnMap.disabled = busy;
        ui.btnClean.disabled = busy;
        ui.btnPrint.disabled = busy;
    }

    function setStatus(ui, text, spinning) {
        ui.status.textContent = '';
        ui.status.classList.remove('error');
        if (spinning) ui.status.appendChild(el('span', { class: 'spin', 'aria-hidden': 'true', text: '◌' }));
        ui.status.appendChild(document.createTextNode((spinning ? ' ' : '') + text));
    }

    function showError(ui, err) {
        var status = err && err.status;
        var msg;
        if (status === 401 || status === 403) {
            msg = 'Canvas did not allow this request (HTTP ' + status + '). The Outcome Map needs ' +
                  'teacher, designer, or admin access to this course\'s outcomes, assignments and rubrics.';
        } else {
            msg = 'The Outcome Map could not load' + (status ? ' (HTTP ' + status + ')' : '') + '. ' +
                  (err && err.message ? err.message : '');
        }
        ui.status.textContent = '';
        ui.status.classList.add('error');
        ui.status.appendChild(document.createTextNode(msg + ' '));
        ui.status.appendChild(el('button', { type: 'button', class: 'btn', text: 'Try again', onclick: function () { run(ui); } }));
        console.warn('CPT Outcome Map: load failed', err);
    }

    // =========================================================================
    // Data
    // =========================================================================

    function HttpError(status, message) {
        this.status = status;
        this.message = message;
    }

    function fetchJson(url) {
        return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(function (r) {
                if (!r.ok) throw new HttpError(r.status, 'Request failed: ' + url.split('?')[0]);
                return r.text().then(function (t) {
                    // Non-API Rails endpoints can prefix JSON with while(1);
                    return { body: JSON.parse(t.replace(/^while\(1\);/, '')), link: r.headers.get('Link') || '' };
                });
            });
    }

    // Follows Link rel="next". Only same-origin next URLs are followed.
    function getAll(url) {
        var out = [];
        var pages = 0;
        function step(u) {
            return fetchJson(u).then(function (res) {
                pages++;
                if (Array.isArray(res.body)) out = out.concat(res.body);
                var m = res.link.match(/<([^>]+)>;\s*rel="next"/);
                var next = m ? m[1] : null;
                if (next && next.indexOf(window.location.origin + '/') === 0 && pages < MAX_PAGES) {
                    return step(next);
                }
                return out;
            });
        }
        return step(url);
    }

    function loadData() {
        var base = '/api/v1/courses/' + courseId;
        return Promise.all([
            fetchJson(base).then(function (r) { return r.body; }),
            getAll(base + '/outcome_group_links?outcome_style=full&per_page=' + PER_PAGE),
            getAll(base + '/assignment_groups?per_page=' + PER_PAGE),
            getAll(base + '/assignments?per_page=' + PER_PAGE),
            getAll(base + '/rubrics?per_page=' + PER_PAGE),
            // Blueprint child detection. Optional: a failure here only hides
            // the Blueprint banner, so it never blocks the map.
            getAll(base + '/blueprint_subscriptions').catch(function () { return []; })
        ]).then(function (r) {
            return { course: r[0] || {}, links: r[1], groups: r[2], assignments: r[3], rubrics: r[4], subscriptions: r[5] };
        });
    }

    // Phase 2: the course's Classic Quiz question banks. The bank list is a
    // JSON endpoint; aligned outcomes only appear on each bank's own page.
    // DOMParser builds an inert document (no scripts run, nothing loads).
    function loadBanks(model, onProgress) {
        var b = model.banks;
        b.state = 'loading';
        return fetchJson('/courses/' + courseId + '/question_banks')
            .then(function (res) {
                var list = (Array.isArray(res.body) ? res.body : [])
                    .map(function (x) { return x.assessment_question_bank || x; })
                    .filter(function (x) { return x && x.id != null && x.workflow_state !== 'deleted'; });
                b.list = list.map(function (x) {
                    return {
                        id: String(x.id), title: (x.title || ('Question bank ' + x.id)).trim(),
                        questionCount: x.assessment_question_count,
                        url: '/courses/' + courseId + '/question_banks/' + x.id,
                        outcomes: [], error: null
                    };
                });
                var done = 0;
                onProgress(done, b.list.length);
                return pool(b.list, BANK_CONCURRENCY, function (bank) {
                    return fetch(bank.url, { credentials: 'same-origin' })
                        .then(function (r) {
                            if (!r.ok) throw new HttpError(r.status, 'Bank page failed');
                            return r.text();
                        })
                        .then(function (html) {
                            var doc = new DOMParser().parseFromString(html, 'text/html');
                            doc.querySelectorAll(BANK_ALIGNED_SEL).forEach(function (li) {
                                var id = li.getAttribute('data-id');
                                if (!id) return;
                                var m = /mastery at\s*([\d.]+)\s*%/i.exec(li.textContent || '');
                                bank.outcomes.push({ id: String(id), mastery: m ? m[1] : '' });
                            });
                        })
                        .catch(function (err) { bank.error = (err && err.status) ? 'HTTP ' + err.status : 'could not be read'; })
                        .then(function () { done++; onProgress(done, b.list.length); });
                });
            })
            .then(function () { b.state = 'done'; })
            .catch(function (err) {
                b.state = 'error';
                b.error = (err && err.status) ? 'HTTP ' + err.status : 'could not be read';
            });
    }

    // Run fn over items with at most `limit` promises in flight.
    function pool(items, limit, fn) {
        var i = 0;
        function worker() {
            if (i >= items.length) return Promise.resolve();
            var item = items[i++];
            return fn(item).then(worker);
        }
        var workers = [];
        for (var k = 0; k < Math.min(limit, items.length); k++) workers.push(worker());
        return Promise.all(workers);
    }

    // -- Model ----------------------------------------------------------------

    function buildModel(raw) {
        var model = {
            course: { name: raw.course.name || ('Course ' + courseId), code: raw.course.course_code || '', codes: [] },
            outcomes: [], outcomeById: {}, outcomeGroups: [],
            assignmentGroups: [], assignments: [], rubrics: [],
            unlinked: {}, cleanup: null,
            banks: { state: 'pending', list: [], error: null },
            blueprint: { role: null, parent: null },
            scoring: { total: 0, tracked: 0 }
        };

        // Blueprint role. Master: course.blueprint is true. Child: a
        // subscription names the master. A plain course copy has neither.
        var sub = (raw.subscriptions || [])[0];
        if (raw.course.blueprint) {
            model.blueprint.role = 'master';
        } else if (sub && sub.blueprint_course) {
            model.blueprint.role = 'child';
            model.blueprint.parent = {
                id: String(sub.blueprint_course.id),
                name: sub.blueprint_course.name || ('Course ' + sub.blueprint_course.id),
                url: '/courses/' + sub.blueprint_course.id
            };
        }

        // This course's subject codes (e.g. "MTW-01-NRSG-412-WEB-8WK" -> NRSG412).
        // Course code first; the name is a fallback when the code has none.
        model.course.codes = courseCodes(model.course.code);
        if (!model.course.codes.length) model.course.codes = courseCodes(model.course.name);

        // Outcomes, de-duplicated by outcome id, ordered by outcome group
        // (first appearance), then leading number, then title.
        var groupOrder = {};
        raw.links.forEach(function (l) {
            var o = l.outcome;
            if (!o || o.id == null || model.outcomeById[String(o.id)]) return;
            var g = l.outcome_group || {};
            var gKey = g.id != null ? String(g.id) : 'none';
            if (!(gKey in groupOrder)) {
                groupOrder[gKey] = model.outcomeGroups.length;
                model.outcomeGroups.push({ id: gKey, title: (g.title || '').trim() || 'Ungrouped', outcomes: [] });
            }
            var title = (o.title || o.display_name || ('Outcome ' + o.id)).trim();
            var rec = {
                id: String(o.id), title: title, groupId: gKey,
                groupTitle: model.outcomeGroups[groupOrder[gKey]].title,
                contextType: o.context_type || '', contextId: o.context_id,
                source: sourceOf(o),
                description: plainText(o.description),
                url: '/courses/' + courseId + '/outcomes/' + o.id,
                number: leadingNumber(title),
                canUnlink: l.can_unlink === true,
                assessed: o.assessed === true,
                assignmentIds: [], bankIds: [], orphanRubricIds: [], label: '', hints: []
            };
            rec.descCodes = courseCodes(rec.description);
            model.outcomeById[rec.id] = rec;
            model.outcomes.push(rec);
        });
        model.outcomes.sort(function (a, b) {
            return (groupOrder[a.groupId] - groupOrder[b.groupId]) ||
                   numCompare(a.number, b.number) ||
                   a.title.localeCompare(b.title);
        });
        model.outcomes.forEach(function (o) { model.outcomeGroups[groupOrder[o.groupId]].outcomes.push(o); });
        assignLabels(model.outcomeGroups);

        // Assignment groups in Canvas order, plus a catch-all for strays.
        var agById = {};
        raw.groups.slice().sort(function (a, b) { return (a.position || 0) - (b.position || 0); })
            .forEach(function (g) {
                var rec = { id: String(g.id), name: g.name || ('Group ' + g.id), assignments: [] };
                agById[rec.id] = rec;
                model.assignmentGroups.push(rec);
            });

        raw.assignments.forEach(function (a) {
            var crit = Array.isArray(a.rubric) ? a.rubric : null;
            var aligned = {};
            (crit || []).forEach(function (c) {
                if (c && c.outcome_id != null) {
                    var k = String(c.outcome_id);
                    var tracked = c.ignore_for_scoring === true;
                    (aligned[k] = aligned[k] || []).push({ desc: (c.description || '').trim(), tracked: tracked });
                    model.scoring.total++;
                    if (tracked) model.scoring.tracked++;
                }
            });
            var rs = a.rubric_settings || null;
            var rec = {
                id: String(a.id), name: (a.name || ('Assignment ' + a.id)).trim(),
                url: a.html_url || ('/courses/' + courseId + '/assignments/' + a.id),
                published: a.published !== false, position: a.position || 0,
                groupId: String(a.assignment_group_id),
                hasRubric: !!crit,
                rubricId: rs && rs.id != null ? String(rs.id) : null,
                rubricTitle: (rs && rs.title) || '',
                useRubricForGrading: a.use_rubric_for_grading !== false,
                locked: a.restricted_by_master_course === true,
                aligned: aligned
            };
            model.assignments.push(rec);
            var ag = agById[rec.groupId];
            if (!ag) {
                ag = { id: rec.groupId, name: 'Other assignments', assignments: [] };
                agById[rec.groupId] = ag;
                model.assignmentGroups.push(ag);
            }
            ag.assignments.push(rec);

            Object.keys(aligned).forEach(function (oid) {
                var o = model.outcomeById[oid];
                if (o) {
                    o.assignmentIds.push(rec.id);
                } else {
                    unlinkedFor(model, oid, aligned[oid][0].desc).assignmentIds.push(rec.id);
                }
            });
        });
        model.assignmentGroups.forEach(function (g) {
            g.assignments.sort(function (a, b) { return a.position - b.position || a.name.localeCompare(b.name); });
        });
        model.assignmentGroups = model.assignmentGroups.filter(function (g) { return g.assignments.length; });

        // Rubrics. "Attached" means some assignment's rubric_settings.id
        // points at it. Everything else is a bookmark-only rubric.
        var attached = {};
        model.assignments.forEach(function (a) { if (a.rubricId) attached[a.rubricId] = true; });
        raw.rubrics.forEach(function (r) {
            var ids = [];
            (Array.isArray(r.data) ? r.data : []).forEach(function (c) {
                if (c && c.learning_outcome_id != null) {
                    var k = String(c.learning_outcome_id);
                    if (ids.indexOf(k) < 0) ids.push(k);
                }
            });
            var isAccount = r.context_type === 'Account';
            var rec = {
                id: String(r.id), title: (r.title || ('Rubric ' + r.id)).trim(), outcomeIds: ids,
                attached: !!attached[String(r.id)],
                url: isAccount ? '/accounts/' + r.context_id + '/rubrics/' + r.id
                               : '/courses/' + courseId + '/rubrics/' + r.id
            };
            model.rubrics.push(rec);
            if (!rec.attached) {
                ids.forEach(function (oid) {
                    var o = model.outcomeById[oid];
                    if (o) o.orphanRubricIds.push(rec.id);
                });
            }
        });

        return model;
    }

    function unlinkedFor(model, oid, description) {
        return model.unlinked[oid] || (model.unlinked[oid] = { id: oid, description: description || '', assignmentIds: [], bankIds: [] });
    }

    // After phase 2: attach bank alignments, then run the Cleanup checks.
    function finishModel(model) {
        model.banks.list.forEach(function (bank) {
            bank.outcomes.forEach(function (bo) {
                var o = model.outcomeById[bo.id];
                if (o) {
                    if (o.bankIds.indexOf(bank.id) < 0) o.bankIds.push(bank.id);
                } else {
                    unlinkedFor(model, bo.id, '').bankIds.push(bank.id);
                }
            });
        });
        model.cleanup = buildCleanup(model);
    }

    function isUsed(o) { return o.assignmentIds.length > 0 || o.bankIds.length > 0; }

    function usageText(o) {
        return 'used by ' + plural(o.assignmentIds.length, 'assignment') +
               (o.bankIds.length ? ' and ' + plural(o.bankIds.length, 'question bank') : '');
    }

    // Whether Canvas will let the outcome be removed from this course now.
    // Probe evidence: can_unlink is true only when nothing in the course is
    // aligned to the outcome any more (rubrics, including unattached ones, and
    // question banks).
    function removalText(o) {
        var t = o.canUnlink
            ? 'Canvas allows removing it now'
            : 'Canvas will not remove it yet: first point its rubric criteria and question bank alignments at the outcome you are keeping, or delete unattached rubrics that carry it';
        if (o.assessed && o.source.kind !== 'institution') t += '. It has student results';
        return t;
    }

    // Leading outcome number, e.g. "3. Explain ..." -> "3", "6.Employ" -> "6",
    // "1.2 Describe" -> "1.2". Empty string when the title has no number.
    function leadingNumber(title) {
        var m = /^\s*(\d+(?:\.\d+)*)/.exec(title);
        return m ? m[1].replace(/\.$/, '') : '';
    }

    // Where an outcome lives. Canvas's own badges say "Institution" for
    // account-level outcomes and "Course" for course-level ones; a course-level
    // outcome whose context_id is a different course was created elsewhere and
    // copied in (probe 2026-10-09: 79127/79128 came from course 38166).
    function sourceOf(o) {
        if (o.context_type === 'Account') {
            return { kind: 'institution', label: 'Institution', short: 'Inst.' };
        }
        if (o.context_type === 'Course' && String(o.context_id) === courseId) {
            return { kind: 'course', label: 'This course', short: 'Course' };
        }
        if (o.context_type === 'Course') {
            return { kind: 'other', label: 'Other course (' + o.context_id + ')', short: 'Other' };
        }
        return { kind: 'unknown', label: o.context_type || 'Unknown', short: '?' };
    }

    // Outcome descriptions are HTML, sometimes double-encoded ("&amp;nbsp;").
    // DOMParser builds an inert document (no scripts run, nothing loads), and
    // textContent drops the markup. A second pass catches double encoding.
    function plainText(html) {
        if (!html) return '';
        var text = String(html);
        for (var pass = 0; pass < 2; pass++) {
            text = new DOMParser().parseFromString(text, 'text/html').body.textContent || '';
            if (!/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(text)) break;
        }
        return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // Subject + number course codes, normalised: "NRSG 412", "NRSG-412",
    // "NRSG412" -> "NRSG412". Needs 2-5 capital letters and 3-4 digits, so
    // codes like "CO1", "PO 10", "IO3", or "MTW-01" are not mistaken for one.
    function courseCodes(text) {
        var out = [];
        var re = /\b([A-Z]{2,5})[\s_-]?(\d{3,4})\b/g;
        var m;
        while ((m = re.exec(text || '')) !== null) {
            var code = m[1] + m[2];
            if (out.indexOf(code) < 0) out.push(code);
        }
        return out;
    }

    function prettyCode(c) { return c.replace(/^([A-Z]+)(\d+)$/, '$1 $2'); }

    function numCompare(a, b) {
        if (a === b) return 0;
        if (!a) return 1;
        if (!b) return -1;
        var pa = a.split('.'), pb = b.split('.');
        for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
            var d = (parseInt(pa[i] || '0', 10)) - (parseInt(pb[i] || '0', 10));
            if (d) return d;
        }
        return 0;
    }

    // Column header labels: the outcome number, or the first word when there is
    // none. Repeats inside one outcome group get a/b/c suffixes so "1" is never
    // ambiguous within a group.
    function assignLabels(groups) {
        groups.forEach(function (g) {
            var counts = {};
            g.outcomes.forEach(function (o) {
                o.label = o.number || (o.title.split(/\s+/)[0] || '?').slice(0, 10);
                counts[o.label] = (counts[o.label] || 0) + 1;
            });
            var seen = {};
            g.outcomes.forEach(function (o) {
                if (counts[o.label] > 1) {
                    var i = seen[o.label] = (seen[o.label] || 0) + 1;
                    o.label = o.label + String.fromCharCode(96 + Math.min(i, 26));
                }
            });
        });
    }

    // -- Cleanup checks -------------------------------------------------------

    function words(title) {
        var set = {};
        title.toLowerCase()
            .replace(/^\s*\d+(?:\.\d+)*\.?\s*/, '')
            .replace(/[^a-z0-9\s-]/g, ' ')
            .split(/\s+/)
            .forEach(function (w) { if (w && !STOPWORDS[w]) set[w] = true; });
        return set;
    }

    function jaccard(a, b) {
        var inter = 0, union = 0, k;
        for (k in a) { union++; if (b[k]) inter++; }
        for (k in b) { if (!a[k]) union++; }
        return union ? inter / union : 0;
    }

    function buildCleanup(model) {
        var sections = [];
        var abs = function (u) { return /^https?:/.test(u) ? u : window.location.origin + u; };
        var isCourseLevel = function (o) { return o.source.kind === 'course' || o.source.kind === 'other'; };

        // 1. Possible duplicate outcomes (union-find over similar pairs)
        var os = model.outcomes;
        os.forEach(function (o) { o.hints = []; });
        var ws = os.map(function (o) { return words(o.title); });
        var parent = os.map(function (_, i) { return i; });
        function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
        for (var i = 0; i < os.length; i++) {
            for (var j = i + 1; j < os.length; j++) {
                if (jaccard(ws[i], ws[j]) >= SIMILARITY_THRESHOLD) parent[find(i)] = find(j);
            }
        }
        var clusters = {};
        os.forEach(function (o, idx) { var r = find(idx); (clusters[r] = clusters[r] || []).push(o); });
        var dupItems = [];
        var setNo = 0;
        Object.keys(clusters).forEach(function (r) {
            var c = clusters[r];
            if (c.length < 2) return;
            setNo++;
            // "Likely remove": course-level and unused, but only when the set
            // has a member worth keeping (Institution, or used by an assignment
            // or question bank). Otherwise every member would be flagged.
            var keepers = c.filter(function (o) { return !isCourseLevel(o) || isUsed(o); });
            c.forEach(function (o) {
                if (keepers.length && keepers.indexOf(o) < 0) {
                    var keep = keepers.map(function (k) { return k.label + ' (' + k.id + ')'; }).join(', ');
                    o.hints.push('Course-level duplicate of ' + keep + ' and not used by any assignment or question bank');
                }
            });
            c.forEach(function (o) {
                dupItems.push({
                    type: 'Outcome', id: o.id, name: o.title, url: abs(o.url), outcome: o,
                    detail: 'Set ' + setNo + ' · ' + o.source.label + ' · ' + o.groupTitle +
                            (o.description ? ' · ' + o.description : '') + ' · ' + usageText(o)
                });
            });
        });

        // Course-code mismatch: the description names course codes and none of
        // them is this course's code. Hinted whether or not it is used, since
        // an outcome for a different course should not stay; when it is used,
        // the hint says to move those alignments first.
        var own = model.course.codes;
        var mismatched = own.length ? os.filter(function (o) {
            return o.descCodes.length && !o.descCodes.some(function (c) { return own.indexOf(c) >= 0; });
        }) : [];
        mismatched.forEach(function (o) {
            o.hints.push('Description names ' + o.descCodes.map(prettyCode).join(', ') +
                ', but this course is ' + own.map(prettyCode).join(', ') +
                (isUsed(o) ? '. It is ' + usageText(o) + ': move those alignments to the right outcome before removing' : ''));
        });
        sections.push({
            key: 'duplicates', title: 'Possible duplicate outcomes',
            help: 'Outcomes with very similar wording but different IDs, often an old and a revised version. ' +
                  'Compare each set and keep the one the course should use. This is a wording match, so review before acting.',
            count: setNo, countLabel: plural(setNo, 'set'), items: dupItems
        });

        // 2. Linked but unused
        var unused = os.filter(function (o) { return !isUsed(o); }).map(function (o) {
            return {
                type: 'Outcome', id: o.id, name: o.title, url: abs(o.url), outcome: o,
                detail: o.source.label + ' · ' + o.groupTitle + (o.orphanRubricIds.length
                    ? ' · only on ' + plural(o.orphanRubricIds.length, 'rubric') + ' not attached to any assignment'
                    : ' · not on any rubric or question bank') + ' · ' + removalText(o)
            };
        });
        sections.push({
            key: 'unused', title: 'Outcomes not used by any assignment or question bank',
            help: 'Linked in this course, but no assignment\'s rubric has a criterion for them and no question bank in this course is aligned to them.',
            count: unused.length, items: unused
        });

        // 2b. Outcomes that may belong to another course
        var otherItems = [];
        os.forEach(function (o) {
            var why = [];
            if (o.source.kind === 'other') why.push('Created in course ' + o.contextId + ', not this one');
            if (mismatched.indexOf(o) >= 0) why.push('Description names ' + o.descCodes.map(prettyCode).join(', '));
            if (!why.length) return;
            otherItems.push({
                type: 'Outcome', id: o.id, name: o.title, url: abs(o.url), outcome: o,
                detail: why.join(' · ') + ' · ' + usageText(o)
            });
        });
        sections.push({
            key: 'otherCourse', title: 'Outcomes that may belong to another course',
            help: 'Course-level outcomes created in a different course, and outcomes whose description names a different course code' +
                  (own.length ? ' than this course (' + own.map(prettyCode).join(', ') + ')' : '') +
                  '. The course-code check reads the description text, so review before acting.',
            count: otherItems.length, items: otherItems
        });

        // 3. Unattached rubrics that carry outcomes
        var orphan = model.rubrics.filter(function (r) { return !r.attached && r.outcomeIds.length; }).map(function (r) {
            return {
                type: 'Rubric', id: r.id, name: r.title, url: abs(r.url),
                detail: 'Carries ' + r.outcomeIds.map(function (oid) {
                    var o = model.outcomeById[oid];
                    return o ? 'outcome ' + o.label + ' (' + oid + ')' : 'outcome ' + oid;
                }).join(', ')
            };
        });
        sections.push({
            key: 'orphanRubrics', title: 'Rubrics not attached to any assignment that carry outcomes',
            help: 'Canvas still lists these as outcome alignments, which is why the native Outcomes page looks cluttered, ' +
                  'and they keep Canvas from removing those outcomes. Delete them in Canvas if they are no longer needed.',
            count: orphan.length, items: orphan
        });

        // 4. Assignments with no outcome
        var noOutcome = [];
        model.assignments.forEach(function (a) {
            if (!a.hasRubric) {
                noOutcome.push({ type: 'Assignment', id: a.id, name: a.name, url: abs(a.url), detail: 'No rubric' + (a.published ? '' : ' · unpublished') });
            } else if (!Object.keys(a.aligned).length) {
                noOutcome.push({ type: 'Assignment', id: a.id, name: a.name, url: abs(a.url), detail: 'Rubric "' + a.rubricTitle + '" has no outcome criteria' + (a.published ? '' : ' · unpublished') });
            }
        });
        sections.push({
            key: 'noOutcome', title: 'Assignments with no outcome',
            help: 'Assignments with no rubric, or with a rubric that has no outcome criteria. Some may be intentional (practice work, external tools, ' +
                  'or Classic Quizzes that draw from an aligned question bank, which appear in the map\'s Question banks rows).',
            count: noOutcome.length, items: noOutcome
        });

        // 5. Duplicate rubric copies
        var byTitle = {};
        model.rubrics.forEach(function (r) {
            var k = r.title.replace(/\s*\(\d+\)\s*$/, '').trim().toLowerCase();
            (byTitle[k] = byTitle[k] || []).push(r);
        });
        var dupRub = [];
        var rubSets = 0;
        Object.keys(byTitle).forEach(function (k) {
            var list = byTitle[k];
            if (list.length < 2) return;
            rubSets++;
            list.forEach(function (r) {
                dupRub.push({ type: 'Rubric', id: r.id, name: r.title, url: abs(r.url), detail: 'Copy set ' + rubSets + ' · ' + (r.attached ? 'attached to an assignment' : 'not attached') });
            });
        });
        sections.push({
            key: 'dupRubrics', title: 'Duplicate rubric copies',
            help: 'Rubrics with the same title, or the same title plus a "(1)" style suffix.',
            count: rubSets, countLabel: plural(rubSets, 'set'), items: dupRub
        });

        // 6. Used but not linked in the course
        var bankById = {};
        model.banks.list.forEach(function (b) { bankById[b.id] = b; });
        var unl = Object.keys(model.unlinked).map(function (oid) {
            var u = model.unlinked[oid];
            var where = [];
            if (u.assignmentIds.length) where.push(plural(u.assignmentIds.length, 'assignment'));
            if (u.bankIds.length) where.push(u.bankIds.map(function (id) { return 'bank "' + (bankById[id] ? bankById[id].title : id) + '"'; }).join(', '));
            return { type: 'Outcome', id: oid, name: u.description || ('Outcome ' + oid), url: '', detail: 'On ' + where.join(' and ') + ' but missing from this course\'s outcome list' };
        });
        sections.push({
            key: 'unlinked', title: 'Outcomes on rubrics or question banks but not in this course',
            help: 'A rubric or question bank uses these outcomes, but they are not linked on the course Outcomes page, so they do not appear on the map.',
            count: unl.length, items: unl
        });

        // 7. More than one outcome group in use
        var groupsUsed = model.outcomeGroups.filter(function (g) { return g.outcomes.some(isUsed); });
        var groupItems = groupsUsed.length > 1 ? groupsUsed.map(function (g) {
            var used = g.outcomes.filter(isUsed).length;
            return { type: 'Outcome group', id: g.id, name: g.title, url: '', detail: used + ' of ' + g.outcomes.length + ' outcomes used by assignments or question banks' };
        }) : [];
        sections.push({
            key: 'groups', title: 'More than one outcome group in use',
            help: 'Can be intentional, but often means outcomes from an older version or another course were mixed in.',
            count: groupItems.length ? groupsUsed.length : 0, countLabel: groupItems.length ? plural(groupsUsed.length, 'group') : '0',
            items: groupItems
        });

        // Summary of every "Likely remove" hint, shown first.
        var removeItems = os.filter(function (o) { return o.hints.length; }).map(function (o) {
            return {
                type: 'Outcome', id: o.id, name: o.title, url: abs(o.url), outcome: o,
                detail: o.source.label + ' · ' + o.groupTitle + ' · ' + o.hints.join('; ') + ' · ' + removalText(o)
            };
        });
        sections.unshift({
            key: 'likelyRemove', title: 'Likely remove',
            help: 'Suggestions, not decisions. Flagged: course-level duplicates that nothing uses (when the set has an ' +
                  'Institution or in-use member to keep), and outcomes whose description names a different course. ' +
                  'Each row says whether Canvas will let you remove it yet.',
            count: removeItems.length, items: removeItems
        });

        sections.forEach(function (s) {
            s.items.forEach(function (it) {
                it.check = s.title;
                it.source = it.outcome ? it.outcome.source.label : '';
                it.hint = it.outcome && it.outcome.hints.length ? 'Likely remove' : '';
            });
        });
        return sections;
    }

    // =========================================================================
    // Render
    // =========================================================================

    function renderAll(ui, model) {
        var name = model.course.name + (model.course.code && model.course.code !== model.course.name ? ' (' + model.course.code + ')' : '');
        ui.courseEl.textContent = name;
        document.title = 'Outcome Map · ' + model.course.name;

        renderTiles(ui, model);

        ui.panelMap.textContent = '';
        renderScopeNotes(ui.panelMap, model);
        if (!model.outcomes.length) {
            ui.panelMap.appendChild(el('p', { class: 'empty', text: 'This course has no outcomes linked on its Outcomes page, so there is nothing to map yet.' }));
        } else {
            renderMap(ui.panelMap, model);
        }

        ui.panelClean.textContent = '';
        renderCleanup(ui.panelClean, model);

        var issues = model.cleanup ? model.cleanup.reduce(function (n, s) { return n + (s.count ? 1 : 0); }, 0) : 0;
        ui.tabClean.textContent = 'Cleanup' + (issues ? ' (' + issues + ')' : '');
    }

    function renderTiles(ui, model) {
        ui.tiles.textContent = '';
        var ready = !!model.cleanup;
        var used = model.outcomes.filter(isUsed).length;
        var sec = function (k) { return ready ? model.cleanup.filter(function (s) { return s.key === k; })[0].count : null; };
        var alignedBanks = model.banks.list.filter(function (b) { return b.outcomes.length; }).length;
        var tiles = [
            { n: model.outcomes.length, label: 'Outcomes in this course' },
            { n: ready ? used : null, label: 'Used by an assignment or question bank' },
            { n: ready ? model.outcomes.length - used : null, label: 'Not used anywhere', warn: ready && model.outcomes.length - used > 0 },
            { n: sec('noOutcome'), label: 'Assignments with no outcome', warn: sec('noOutcome') > 0 },
            { n: model.banks.state === 'done' ? alignedBanks : model.banks.state === 'error' ? 'n/a' : null, label: 'Question banks aligned to outcomes' },
            { n: sec('orphanRubrics'), label: 'Unattached rubrics carrying outcomes', warn: sec('orphanRubrics') > 0 },
            { n: sec('duplicates'), label: 'Possible duplicate outcome sets', warn: sec('duplicates') > 0 },
            { n: model.outcomes.filter(function (o) { return o.source.kind === 'course' || o.source.kind === 'other'; }).length, label: 'Course-level outcomes' },
            { n: sec('likelyRemove'), label: 'Outcomes marked likely remove', warn: sec('likelyRemove') > 0 }
        ];
        tiles.forEach(function (t) {
            ui.tiles.appendChild(el('div', { class: 'tile' + (t.warn ? ' warn' : '') }, [
                el('div', { class: 'tile-n', text: t.n == null ? '…' : String(t.n), title: t.n == null ? 'Waiting for question banks' : null }),
                el('div', { class: 'tile-l', text: t.label })
            ]));
        });
    }

    // What the map covers, how outcome criteria are scored, and Blueprint
    // context. Shown above the map.
    function renderScopeNotes(panel, model) {
        var notes = el('div', { class: 'notes' });
        var b = model.banks;
        var bankLine;
        if (b.state === 'done') {
            var aligned = b.list.filter(function (x) { return x.outcomes.length; }).length;
            var failed = b.list.filter(function (x) { return x.error; }).length;
            bankLine = plural(b.list.length, 'question bank') + ' read, ' + aligned + ' aligned to outcomes' +
                       (failed ? ' (' + failed + ' could not be read)' : '');
        } else if (b.state === 'error') {
            bankLine = 'question banks could not be read (' + b.error + '), so quiz-only outcomes may look unused';
        } else {
            bankLine = 'question banks are still loading';
        }
        notes.appendChild(el('p', { class: 'note' }, [
            el('strong', { text: 'What this map includes: ' }),
            'rubrics on assignments, and Classic Quiz question banks that belong to this course (' + bankLine + '). ' +
            'Not included: New Quizzes item banks, and question banks stored in other courses or accounts.'
        ]));

        var s = model.scoring;
        if (s.total) {
            var scoringText = s.tracked === s.total
                ? 'All ' + plural(s.total, 'outcome criterion') + ' on assignment rubrics are tracked only: they record outcome results but do not count toward the grade.'
                : s.tracked === 0
                    ? 'All ' + plural(s.total, 'outcome criterion') + ' on assignment rubrics count toward the grade.'
                    : s.tracked + ' of ' + s.total + ' outcome criteria are tracked only (shown as ○) and the rest count toward the grade (shown as ●).';
            notes.appendChild(el('p', { class: 'note' }, [el('strong', { text: 'Grading: ' }), scoringText]));
        }

        var bp = model.blueprint;
        if (bp.role === 'master') {
            notes.appendChild(el('p', { class: 'note bp' }, [
                el('strong', { text: 'Blueprint course: ' }),
                'changes made here sync to its associated courses when the Blueprint is synced. Fix shared outcomes and rubrics here first.'
            ]));
        } else if (bp.role === 'child') {
            notes.appendChild(el('p', { class: 'note bp' }, [
                el('strong', { text: 'Managed by a Blueprint: ' }),
                'this course receives content from ',
                el('a', { href: bp.parent.url, target: '_blank', rel: 'noopener', text: bp.parent.name }),
                '. Fix shared rubrics and outcomes in the Blueprint, then sync. Changes made here to synced content can be overwritten or can stop that item from receiving future updates.'
            ]));
        }
        panel.appendChild(notes);
    }

    // -- Map tab --------------------------------------------------------------

    function renderMap(panel, model) {
        var groups = model.outcomeGroups.filter(function (g) { return g.outcomes.length; });
        var cols = [];
        groups.forEach(function (g, gi) { g.outcomes.forEach(function (o) { cols.push({ o: o, band: gi % 2 }); }); });
        var mixed = model.scoring.tracked > 0 && model.scoring.tracked < model.scoring.total;
        var bp = model.blueprint.role;

        // Key: a compact visual legend instead of a paragraph. Each sample is
        // the real mark or tag as it appears in the map, followed by a few
        // words. Text carries the meaning, so it reads without color.
        var hasFlags = model.outcomes.some(function (o) { return o.hints.length; });
        var keyItems = [
            [el('span', { class: 'k-mark', text: '\u25cf' }), mixed ? 'Counts toward the grade' : 'Aligned by a rubric criterion or question bank'],
            mixed ? [el('span', { class: 'k-mark tracked', text: '\u25cb' }), 'Tracked only'] : null,
            [el('span', { class: 'src src-institution', text: 'Inst.' }), 'Institution outcome'],
            [el('span', { class: 'src src-course', text: 'Course' }), 'Created in this course'],
            [el('span', { class: 'src src-other', text: 'Other' }), 'Created in another course'],
            hasFlags ? [el('span', { class: 'k-flag', text: '\u2691' }), 'Likely remove (see Cleanup)'] : null
        ].filter(Boolean);
        var key = el('div', { class: 'key', role: 'list', 'aria-label': 'Map key' });
        keyItems.forEach(function (k) {
            key.appendChild(el('span', { class: 'k-item', role: 'listitem' }, [k[0], ' ' + k[1]]));
        });
        panel.appendChild(key);
        panel.appendChild(el('p', { class: 'hint no-print', text:
            'Rows: assignments, then question banks. Columns: outcomes. Hover a mark or column for details; full titles are in the legend below.' }));

        var table = el('table', { class: 'map' });
        table.appendChild(el('caption', { class: 'sr', text: 'Outcome alignment map: assignments and question banks by outcomes' }));

        var thead = el('thead');
        var r1 = el('tr', { class: 'h1' });
        r1.appendChild(el('th', { scope: 'col', rowspan: '2', class: 'corner', text: 'Assignment or question bank' }));
        groups.forEach(function (g, gi) {
            r1.appendChild(el('th', { scope: 'colgroup', colspan: String(g.outcomes.length), class: 'grp band' + (gi % 2), title: g.title, text: g.title }));
        });
        r1.appendChild(el('th', { scope: 'col', rowspan: '2', class: 'count-h', text: 'Outcomes' }));
        var r2 = el('tr', { class: 'h2' });
        cols.forEach(function (c) {
            var flagged = c.o.hints.length > 0;
            r2.appendChild(el('th', {
                scope: 'col', class: 'oc band' + c.band + (flagged ? ' flagged' : ''),
                title: c.o.label + ' · ' + c.o.source.label + ' · ' + c.o.groupTitle + '\n' + c.o.title +
                       (c.o.description ? '\n' + c.o.description : '') + '\nOutcome ID ' + c.o.id +
                       (flagged ? '\nLikely remove: ' + c.o.hints.join('; ') : '')
            }, [
                el('span', { class: 'oc-lab', 'aria-hidden': 'true', text: (flagged ? '⚑ ' : '') + c.o.label }),
                el('span', { class: 'src src-' + c.o.source.kind, 'aria-hidden': 'true', text: c.o.source.short }),
                el('span', { class: 'sr', text: 'Outcome ' + c.o.label + ', ' + c.o.source.label + ', ' + c.o.groupTitle + ': ' + c.o.title +
                    (flagged ? '. Likely remove.' : '') })
            ]));
        });
        thead.appendChild(r1);
        thead.appendChild(r2);
        table.appendChild(thead);

        var span = String(cols.length + 2);
        var tbody = el('tbody');
        model.assignmentGroups.forEach(function (ag) {
            tbody.appendChild(el('tr', { class: 'agrp' }, [el('th', { scope: 'colgroup', colspan: span, text: ag.name })]));
            ag.assignments.forEach(function (a) {
                var tr = el('tr');
                var badges = [];
                if (!a.published) badges.push(el('span', { class: 'badge', text: 'Unpublished' }));
                if (!a.hasRubric) badges.push(el('span', { class: 'badge', text: 'No rubric' }));
                if (a.hasRubric && !a.useRubricForGrading) badges.push(el('span', { class: 'badge', text: 'Rubric not used for grading' }));
                if (a.locked && bp === 'child') badges.push(el('span', { class: 'badge lock', text: 'Locked by Blueprint' }));
                if (a.locked && bp === 'master') badges.push(el('span', { class: 'badge lock', text: 'Locked in associated courses' }));
                tr.appendChild(el('th', { scope: 'row', class: 'aname' }, [
                    el('a', { href: a.url, target: '_blank', rel: 'noopener', text: a.name })
                ].concat(badges)));
                var n = 0;
                cols.forEach(function (c) {
                    var crit = a.aligned[c.o.id];
                    if (crit) {
                        n++;
                        var tracked = crit.every(function (x) { return x.tracked; });
                        var tip = 'Outcome ' + c.o.label + ' · ' + c.o.groupTitle + '\nRubric: ' + (a.rubricTitle || '(untitled)') +
                                  '\nCriterion: ' + (crit.map(function (x) { return x.desc; }).join(' | ') || '(no description)') +
                                  '\n' + (tracked ? 'Tracked only: does not count toward the grade' : 'Counts toward the grade');
                        tr.appendChild(el('td', { class: 'hit band' + c.band + (mixed && tracked ? ' tracked' : ''), title: tip }, [
                            el('span', { 'aria-hidden': 'true', text: mixed && tracked ? '○' : '●' }),
                            el('span', { class: 'sr', text: 'Aligned to outcome ' + c.o.label + ' through rubric ' + (a.rubricTitle || '') +
                                (tracked ? ', tracked only' : ', counts toward the grade') })
                        ]));
                    } else {
                        tr.appendChild(el('td', { class: 'band' + c.band }));
                    }
                });
                tr.appendChild(el('td', { class: 'count' + (n ? '' : ' zero'), text: String(n) }));
                tbody.appendChild(tr);
            });
        });

        // Question banks
        var b = model.banks;
        tbody.appendChild(el('tr', { class: 'agrp' }, [el('th', { scope: 'colgroup', colspan: span, text: 'Question banks (Classic Quizzes)' })]));
        var alignedBanks = b.list.filter(function (x) { return x.outcomes.length; });
        if (b.state === 'pending' || b.state === 'loading') {
            tbody.appendChild(el('tr', null, [el('td', { class: 'msg', colspan: span, text: 'Checking question banks...' })]));
        } else if (b.state === 'error') {
            tbody.appendChild(el('tr', null, [el('td', { class: 'msg', colspan: span, text: 'Question banks could not be read (' + b.error + ').' })]));
        } else if (!alignedBanks.length) {
            tbody.appendChild(el('tr', null, [el('td', { class: 'msg', colspan: span,
                text: b.list.length ? 'None of the ' + plural(b.list.length, 'question bank') + ' in this course is aligned to an outcome.'
                                    : 'This course has no question banks.' })]));
        } else {
            alignedBanks.forEach(function (bank) {
                var tr = el('tr', { class: 'bank' });
                var mine = {};
                bank.outcomes.forEach(function (bo) { mine[bo.id] = bo; });
                tr.appendChild(el('th', { scope: 'row', class: 'aname' }, [
                    el('a', { href: bank.url, target: '_blank', rel: 'noopener', text: bank.title }),
                    el('span', { class: 'badge', text: 'Question bank' }),
                    bank.questionCount != null ? el('span', { class: 'badge', text: plural(bank.questionCount, 'question') }) : null
                ]));
                var n = 0;
                cols.forEach(function (c) {
                    var bo = mine[c.o.id];
                    if (bo) {
                        n++;
                        var tip = 'Outcome ' + c.o.label + ' · ' + c.o.groupTitle + '\nQuestion bank: ' + bank.title +
                                  (bo.mastery ? '\nMastery at ' + bo.mastery + '%' : '') +
                                  '\nClassic Quizzes that draw questions from this bank record results for this outcome.';
                        tr.appendChild(el('td', { class: 'hit band' + c.band, title: tip }, [
                            el('span', { 'aria-hidden': 'true', text: '●' }),
                            el('span', { class: 'sr', text: 'Aligned to outcome ' + c.o.label + ' through question bank ' + bank.title +
                                (bo.mastery ? ', mastery at ' + bo.mastery + ' percent' : '') })
                        ]));
                    } else {
                        tr.appendChild(el('td', { class: 'band' + c.band }));
                    }
                });
                tr.appendChild(el('td', { class: 'count', text: String(n) }));
                tbody.appendChild(tr);
            });
            var unaligned = b.list.length - alignedBanks.length;
            if (unaligned) {
                tbody.appendChild(el('tr', null, [el('td', { class: 'msg', colspan: span,
                    text: plural(unaligned, 'other question bank') + ' in this course ' + (unaligned === 1 ? 'is' : 'are') + ' not aligned to any outcome.' })]));
            }
        }
        table.appendChild(tbody);

        var tfoot = el('tfoot');
        var fr = el('tr');
        fr.appendChild(el('th', { scope: 'row', class: 'aname', text: 'Assignments aligned' }));
        cols.forEach(function (c) {
            var n = c.o.assignmentIds.length;
            fr.appendChild(el('td', { class: 'count band' + c.band + (n || c.o.bankIds.length ? '' : ' zero'), title: c.o.title, text: String(n) }));
        });
        fr.appendChild(el('td', { class: 'count' }));
        tfoot.appendChild(fr);
        if (b.state === 'done') {
            var fb = el('tr');
            fb.appendChild(el('th', { scope: 'row', class: 'aname', text: 'Question banks aligned' }));
            cols.forEach(function (c) {
                var n = c.o.bankIds.length;
                fb.appendChild(el('td', { class: 'count band' + c.band + (n || c.o.assignmentIds.length ? '' : ' zero'), title: c.o.title, text: String(n) }));
            });
            fb.appendChild(el('td', { class: 'count' }));
            tfoot.appendChild(fb);
        }
        table.appendChild(tfoot);

        // No inner scroll box: the page itself scrolls, in both directions,
        // and the header rows and assignment column stick to the window.
        panel.appendChild(el('div', { class: 'scroll' }, [table]));

        // Legend
        panel.appendChild(el('h2', { text: 'Legend' }));
        var lt = el('table', { class: 'legend' });
        lt.appendChild(el('thead', null, [el('tr', null, ['Column', 'Outcome', 'Source', 'Description', 'Outcome group', 'ID', 'Assignments', 'Banks', 'Can remove now', 'Hint'].map(function (h) {
            return el('th', { scope: 'col', text: h });
        }))]));
        var lb = el('tbody');
        var ready = !!model.cleanup;
        model.outcomes.forEach(function (o) {
            lb.appendChild(el('tr', null, [
                el('td', { class: 'lab', text: o.label }),
                el('td', null, [el('a', { href: o.url, target: '_blank', rel: 'noopener', text: o.title })]),
                el('td', null, [el('span', { class: 'src src-' + o.source.kind, text: o.source.label })]),
                el('td', { class: 'desc', text: o.description }),
                el('td', { text: o.groupTitle }),
                el('td', { class: 'mono', text: o.id }),
                el('td', { class: o.assignmentIds.length || !ready || o.bankIds.length ? '' : 'zero', text: String(o.assignmentIds.length) }),
                el('td', { text: b.state === 'done' ? String(o.bankIds.length) : '…' }),
                el('td', { title: removalText(o), text: o.canUnlink ? 'Yes' : 'No' }),
                el('td', { title: o.hints.join('\n') }, [o.hints.length ? el('span', { class: 'pill warn', text: 'Likely remove' }) : null])
            ]));
        });
        lt.appendChild(lb);
        panel.appendChild(lt);

        refreshStickyOffsets(panel);
    }

    // The second header row sticks just below the first. Its offset depends on
    // the first row's rendered height, so measure after layout.
    function refreshStickyOffsets(panel) {
        requestAnimationFrame(function () {
            var r1 = panel.querySelector('tr.h1');
            if (!r1) return;
            var h = r1.getBoundingClientRect().height;
            panel.querySelectorAll('tr.h2 th').forEach(function (th) { th.style.top = h + 'px'; });
        });
    }

    // -- Cleanup tab ----------------------------------------------------------

    function renderCleanup(panel, model) {
        if (!model.cleanup) {
            panel.appendChild(el('p', { class: 'empty', text:
                'Checking question banks first, so that no outcome assessed only through a quiz bank is reported as unused. ' +
                'Cleanup results appear here when that finishes.' }));
            return;
        }
        panel.appendChild(el('p', { class: 'hint no-print', text:
            'Things worth a look. Each name links to its Canvas page (opens in a new tab), where any change is made. ' +
            'The Outcome Map itself never changes Canvas. After fixing something, click Refresh to check again.' }));

        if (model.banks.state === 'error') {
            panel.appendChild(el('p', { class: 'note warnnote', text:
                'Question banks could not be read (' + model.banks.error + '). Outcomes assessed only through Classic Quiz banks ' +
                'may be listed as unused or likely remove here. Check those on the bank pages before removing anything.' }));
        }

        // Suggested fix order
        var bp = model.blueprint;
        var steps = [
            'Point rubric criteria at the outcome you are keeping (edit the rubric), and on question bank pages use Align Outcome for the kept outcome and remove the old one.',
            'Remove the outcomes you no longer need from the course Outcomes page. The Can remove now column in the legend shows which Canvas will allow.',
            'Delete rubrics that are not attached to any assignment, if no one needs them.',
            'Click Refresh here to check the result.'
        ];
        if (bp.role === 'master') steps.push('Sync the Blueprint so associated courses receive the fixes, then check one associated course.');
        var order = el('section', { class: 'card' }, [el('h2', { text: 'Suggested fix order' })]);
        if (bp.role === 'child') {
            order.appendChild(el('p', { class: 'help' }, [
                'This course is managed by the Blueprint ',
                el('a', { href: bp.parent.url, target: '_blank', rel: 'noopener', text: bp.parent.name }),
                '. Make shared fixes there first and sync, then use these steps for anything that belongs only to this course.'
            ]));
        }
        var ol = el('ol', { class: 'steps' });
        steps.forEach(function (s) { ol.appendChild(el('li', { text: s })); });
        order.appendChild(ol);
        panel.appendChild(order);

        model.cleanup.forEach(function (s) {
            var box = el('section', { class: 'card' + (s.count ? '' : ' ok') });
            box.appendChild(el('h2', null, [
                s.title + ' ',
                el('span', { class: 'pill' + (s.count ? ' warn' : ' good'), text: s.count ? (s.countLabel || String(s.count)) : 'None found' })
            ]));
            box.appendChild(el('p', { class: 'help', text: s.help }));
            if (s.items.length) {
                var t = el('table', { class: 'clean' });
                t.appendChild(el('thead', null, [el('tr', null, ['Name', 'Type', 'Source', 'ID', 'Detail', 'Hint'].map(function (h) {
                    return el('th', { scope: 'col', text: h });
                }))]));
                var tb = el('tbody');
                s.items.forEach(function (it) {
                    tb.appendChild(el('tr', null, [
                        el('td', null, [it.url ? el('a', { href: it.url, target: '_blank', rel: 'noopener', text: it.name }) : el('span', { text: it.name })]),
                        el('td', { text: it.type }),
                        el('td', null, [it.outcome ? el('span', { class: 'src src-' + it.outcome.source.kind, text: it.source }) : null]),
                        el('td', { class: 'mono', text: it.id }),
                        el('td', { text: it.detail }),
                        el('td', null, [it.hint ? el('span', { class: 'pill warn', text: it.hint }) : null])
                    ]));
                });
                t.appendChild(tb);
                box.appendChild(t);
            }
            panel.appendChild(box);
        });
    }

    // =========================================================================
    // Export
    // =========================================================================

    function csvCell(v) {
        var s = v == null ? '' : String(v);
        // Neutralise spreadsheet formula injection from Canvas-entered titles.
        if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s;
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    function csvRow(cells) { return cells.map(csvCell).join(','); }

    function mapCsv(model) {
        var lines = [];
        lines.push(csvRow(['Outcome Map', model.course.name, model.course.code, 'Exported ' + new Date().toISOString().slice(0, 10)]));
        lines.push('');
        var head = ['Group', 'Assignment or question bank', 'ID', 'Published', 'Rubric']
            .concat(model.outcomes.map(function (o) { return o.label + ' | ' + o.groupTitle + ' | ' + o.id + ' | ' + o.title; }))
            .concat(['Outcomes aligned']);
        lines.push(csvRow(head));
        var pad = ['', '', '', ''];
        lines.push(csvRow(pad.concat(['Outcome source']).concat(model.outcomes.map(function (o) { return o.source.label; }))));
        lines.push(csvRow(pad.concat(['Outcome description']).concat(model.outcomes.map(function (o) { return o.description; }))));
        lines.push(csvRow(pad.concat(['Can remove now']).concat(model.outcomes.map(function (o) { return o.canUnlink ? 'Yes' : 'No'; }))));
        lines.push(csvRow(pad.concat(['Hint']).concat(model.outcomes.map(function (o) { return o.hints.length ? 'Likely remove' : ''; }))));
        model.assignmentGroups.forEach(function (ag) {
            ag.assignments.forEach(function (a) {
                var n = 0;
                var cells = model.outcomes.map(function (o) {
                    var crit = a.aligned[o.id];
                    if (!crit) return '';
                    n++;
                    return crit.every(function (x) { return x.tracked; }) ? 'X (tracked)' : 'X';
                });
                lines.push(csvRow([ag.name, a.name, a.id, a.published ? 'Yes' : 'No', a.hasRubric ? a.rubricTitle : '(no rubric)']
                    .concat(cells).concat([n])));
            });
        });
        model.banks.list.filter(function (b) { return b.outcomes.length; }).forEach(function (bank) {
            var mine = {};
            bank.outcomes.forEach(function (bo) { mine[bo.id] = bo; });
            var n = 0;
            var cells = model.outcomes.map(function (o) {
                if (!mine[o.id]) return '';
                n++;
                return mine[o.id].mastery ? 'X (mastery ' + mine[o.id].mastery + '%)' : 'X';
            });
            lines.push(csvRow(['Question banks', bank.title, bank.id, '', '(question bank)'].concat(cells).concat([n])));
        });
        lines.push(csvRow(['', 'Assignments aligned', '', '', '']
            .concat(model.outcomes.map(function (o) { return o.assignmentIds.length; })).concat([''])));
        lines.push(csvRow(['', 'Question banks aligned', '', '', '']
            .concat(model.outcomes.map(function (o) { return o.bankIds.length; })).concat([''])));
        return lines.join('\r\n');
    }

    function cleanupCsv(model) {
        var lines = [csvRow(['Check', 'Type', 'Source', 'ID', 'Name', 'Detail', 'Hint', 'URL'])];
        (model.cleanup || []).forEach(function (s) {
            if (!s.items.length) {
                lines.push(csvRow([s.title, '', '', '', 'None found', '', '', '']));
                return;
            }
            s.items.forEach(function (it) { lines.push(csvRow([it.check, it.type, it.source, it.id, it.name, it.detail, it.hint, it.url])); });
        });
        return lines.join('\r\n');
    }

    function fileStem(model) {
        var base = (model.course.code || model.course.name || 'course').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
        return (base || 'course') + '_' + courseId + '_' + new Date().toISOString().slice(0, 10);
    }

    // Blob download. Probe 3 confirmed the Outcomes page CSP is
    // frame-ancestors only, so blob: URLs are not blocked here (unlike quiz
    // pages, see rubric-exporter.js). The BOM makes Excel read UTF-8.
    function downloadCsv(csv, filename) {
        var url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.getElementById(HOST_ID).appendChild(a);
        a.click();
        a.remove();
        requestAnimationFrame(function () { URL.revokeObjectURL(url); });
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    // DOM builder. Text always goes through textContent / text nodes, never
    // innerHTML, so Canvas-entered titles cannot inject markup.
    function el(tag, props, kids) {
        var n = document.createElement(tag);
        if (props) {
            Object.keys(props).forEach(function (k) {
                var v = props[k];
                if (v == null || v === false) return;
                if (k === 'text') n.textContent = v;
                else if (k === 'class') n.className = v;
                else if (k.indexOf('on') === 0 && typeof v === 'function') n.addEventListener(k.slice(2), v);
                else n.setAttribute(k, v === true ? '' : v);
            });
        }
        (kids || []).forEach(function (c) {
            if (c == null || c === false) return;
            n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
        return n;
    }

    function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

    function shadowCss() {
        var C = COLORS;
        return [
            ':host{all:initial;display:block;}',
            '*,*::before,*::after{box-sizing:border-box;}',
            '.page{font-family:Lato,"Lato Extended","Helvetica Neue",Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:' + C.text + ';padding:20px 24px 40px;max-width:100%;}',
            'a{color:' + C.accent + ';text-decoration:none;}a:hover{text-decoration:underline;}',
            'a:focus-visible,button:focus-visible,.scroll:focus-visible{outline:2px solid ' + C.accent + ';outline-offset:2px;}',
            '.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}',
            '.top{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:flex-end;justify-content:space-between;margin-bottom:12px;}',
            'h1{font-size:22px;font-weight:600;margin:0;}',
            '.course{color:' + C.muted + ';font-size:14px;}',
            '.actions{display:flex;flex-wrap:wrap;gap:8px;}',
            '.btn{font:inherit;font-size:13px;padding:6px 12px;border:1px solid ' + C.border + ';border-radius:4px;background:#fff;color:' + C.text + ';cursor:pointer;display:inline-flex;align-items:center;}',
            '.btn:hover:not([disabled]){background:#f2f4f5;text-decoration:none;}',
            '.btn[disabled]{opacity:0.55;cursor:default;}',
            '.status{padding:9px 13px;margin:0 0 14px;background:#fff;border:0.5px solid ' + C.border + ';border-radius:6px;font-size:13px;}',
            '.status.error{border-color:' + C.warning + ';color:' + C.warning + ';}',
            '.spin{display:inline-block;animation:omspin 0.8s linear infinite;}@keyframes omspin{to{transform:rotate(360deg)}}',
            '.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:16px;}',
            '.tile{background:#fff;border:0.5px solid ' + C.border + ';border-radius:6px;padding:10px 12px;}',
            '.tile-n{font-size:24px;font-weight:600;color:' + C.text + ';}',
            '.tile.warn .tile-n{color:' + C.warning + ';}',
            '.tile-l{font-size:12px;color:' + C.muted + ';}',
            '.tablist{display:flex;gap:4px;border-bottom:1px solid ' + C.border + ';margin-bottom:12px;}',
            '.tab{font:inherit;font-size:14px;padding:8px 16px;background:none;border:none;border-bottom:3px solid transparent;color:' + C.muted + ';cursor:pointer;margin-bottom:-1px;}',
            '.tab[aria-selected="true"]{color:' + C.accent + ';border-bottom-color:' + C.accent + ';font-weight:600;}',
            '.hint{font-size:13px;color:' + C.muted + ';margin:0 0 10px;max-width:900px;}',
            '.empty{background:#fff;border:0.5px solid ' + C.border + ';border-radius:6px;padding:16px;}',
            // Map
            // The map card grows to the table's full size; a wide map widens
            // the page instead of scrolling inside a box. With no overflow on
            // any ancestor, position:sticky uses the window, so the headers
            // stay on screen while the page scrolls.
            '.scroll{width:max-content;min-width:100%;background:#fff;border:0.5px solid ' + C.border + ';border-radius:6px;}',
            'table.map{border-collapse:separate;border-spacing:0;font-size:13px;}',
            'table.map th,table.map td{border-bottom:0.5px solid #e3e6e8;border-right:0.5px solid #e3e6e8;padding:4px 6px;}',
            'table.map thead th{position:sticky;top:0;background:#fff;z-index:2;font-weight:600;}',
            'table.map thead th.corner{left:0;z-index:4;text-align:left;vertical-align:bottom;min-width:240px;color:' + C.muted + ';}',
            'table.map thead th.grp{font-size:12px;color:' + C.header + ';max-width:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;}',
            'table.map thead th.oc{min-width:46px;text-align:center;color:' + C.text + ';cursor:help;line-height:1.2;}',
            'table.map thead th.oc .oc-lab{display:block;}',
            'table.map thead th.oc.flagged{box-shadow:inset 0 -3px 0 ' + C.warning + ';}',
            'table.map thead th.oc.flagged .oc-lab{color:' + C.warning + ';}',
            // Source tags: text carries the meaning; color echoes Canvas's
            // Institution (purple) and Course (brown) badges. Both AA on white.
            '.src{display:inline-block;font-size:10px;font-weight:600;padding:0 5px;border-radius:8px;border:0.5px solid currentColor;white-space:nowrap;}',
            '.src-institution{color:#5b3f8c;}',
            '.src-course{color:#8a4510;}',
            '.src-other{color:#8a4510;border-style:dashed;}',
            '.src-unknown{color:' + C.muted + ';}',
            'table.legend td.desc{color:' + C.muted + ';font-size:12px;}',
            'table.map thead th.count-h{font-size:12px;color:' + C.muted + ';vertical-align:bottom;}',
            'table.map .band1{background:#f6f8f9;}',
            'table.map thead th.band1{background:#eef2f4;}',
            'table.map tbody th.aname,table.map tfoot th.aname{position:sticky;left:0;background:#fff;z-index:1;text-align:left;font-weight:400;min-width:240px;max-width:360px;}',
            'table.map tr.agrp th{position:sticky;left:0;background:' + C.accentBg + ';text-align:left;font-weight:600;font-size:12px;color:' + C.text + ';z-index:1;}',
            'table.map td.hit{text-align:center;color:' + C.accent + ';font-size:14px;cursor:help;}',
            'table.map td.count{text-align:center;font-weight:600;}',
            'table.map td.zero,.legend td.zero{color:' + C.warning + ';}',
            'table.map tfoot th,table.map tfoot td{background:#fafbfb;border-top:1px solid ' + C.border + ';}',
            'table.map tbody tr:hover td,table.map tbody tr:hover th.aname{background:#fffbe8;}',
            '.badge{display:inline-block;margin-left:6px;padding:0 6px;border-radius:9px;font-size:11px;background:#f2f4f5;color:' + C.muted + ';border:0.5px solid ' + C.border + ';}',
            'h2{font-size:16px;font-weight:600;margin:20px 0 8px;}',
            'table.legend,table.clean{border-collapse:collapse;width:100%;background:#fff;font-size:13px;}',
            'table.legend th,table.legend td,table.clean th,table.clean td{text-align:left;padding:5px 10px 5px 0;border-bottom:0.5px solid #e3e6e8;vertical-align:baseline;}',
            'table.legend th,table.clean th{color:' + C.muted + ';font-weight:600;border-bottom:1px solid ' + C.border + ';}',
            'table.legend td.lab{font-weight:600;white-space:nowrap;}',
            '.mono{font-family:Menlo,Consolas,monospace;font-size:12px;color:' + C.muted + ';}',
            // Cleanup
            '.card{background:#fff;border:0.5px solid ' + C.border + ';border-radius:6px;padding:12px 16px;margin-bottom:12px;}',
            '.card h2{margin:0 0 4px;display:flex;align-items:center;gap:8px;}',
            '.card .help{margin:0 0 8px;font-size:13px;color:' + C.muted + ';}',
            '.pill{font-size:11px;font-weight:600;padding:1px 8px;border-radius:9px;border:0.5px solid currentColor;white-space:nowrap;}',
            '.pill.warn{color:' + C.warning + ';}.pill.good{color:' + C.success + ';}',
            '.notes{margin:0 0 12px;}',
            '.note{background:#fff;border:0.5px solid ' + C.border + ';border-left:3px solid ' + C.accent + ';border-radius:4px;padding:7px 12px;margin:0 0 6px;font-size:13px;max-width:1100px;}',
            '.note.bp{border-left-color:#5b3f8c;}',
            '.note.warnnote{border-left-color:' + C.warning + ';color:' + C.warning + ';}',
            'table.map td.msg{font-size:12px;color:' + C.muted + ';font-style:italic;padding:6px 8px;}',
            'table.map td.hit.tracked{color:' + C.muted + ';}',
            '.badge.lock{color:#5b3f8c;border-color:#5b3f8c;}',
            '.key{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;background:#fff;border:0.5px solid ' + C.border + ';border-radius:6px;padding:8px 12px;margin:0 0 6px;font-size:13px;width:fit-content;max-width:100%;}',
            '.k-item{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}',
            '.k-mark{color:' + C.accent + ';font-size:14px;}.k-mark.tracked{color:' + C.muted + ';}',
            '.k-flag{color:' + C.warning + ';font-weight:600;}',
            'ol.steps{margin:4px 0 0;padding-left:22px;font-size:13px;}ol.steps li{margin:2px 0;}',
            // Print: show both views, drop sticky/scroll, shrink type.
            '@media print{',
                '.no-print{display:none !important;}',
                '.page{padding:0;font-size:10px;}',
                '.panel[hidden]{display:block !important;}',
                '#om-panel-clean{break-before:page;}',
                '.scroll{width:auto;border:none;}',
                'table.map{font-size:9px;}',
                'table.map thead th,table.map tbody th.aname,table.map tfoot th.aname,table.map tr.agrp th{position:static;}',
                'table.map thead{display:table-header-group;}',
                'table.map tr{break-inside:avoid;}',
                'table.map tbody tr:hover td,table.map tbody tr:hover th.aname{background:inherit;}',
                '.tiles{grid-template-columns:repeat(4,1fr);}',
                '.card{break-inside:avoid;}',
            '}'
        ].join('\n');
    }

})();

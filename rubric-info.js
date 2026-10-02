// rubric-info.js
// Canvas Pro-Tools — Rubrics+ : Rubric Info
// Two independent, route-guarded features sharing the rubricPlus flag:
//   1. Used-for-grading badge on the assignment page rubric. Derived purely
//      from the DOM — no API call.
//   2. "Load Rubric Details" button on the course rubrics list page. Fetches
//      each rubric and annotates its row with context, association count, and
//      whether it carries outcome criteria.
// Runs in ISOLATED world (default). Does not need window.ENV or page jQuery.
// Adapted from Code with Ski's Canvas-LMS-Mods (MIT) — see CREDITS.md.
// Matches:
//   /courses/*/rubrics          ← Load Rubric Details button
//   /courses/*/assignments/*    ← used-for-grading badge

(function () {
    'use strict';

    // ── Route guard ───────────────────────────────────────────────────────────

    var path = window.location.pathname;

    var rubricListRegex   = new RegExp('^/courses/([0-9]+)/rubrics$');
    var rubricDetailRegex = new RegExp('^/courses/([0-9]+)/rubrics/([0-9]+)$');
    var assignmentRegex   = new RegExp('^/courses/([0-9]+)/assignments/[0-9]+$');

    var rubricListMatch   = rubricListRegex.exec(path);
    var rubricDetailMatch = rubricDetailRegex.exec(path);
    var assignmentMatch   = assignmentRegex.exec(path);

    var isRubricList   = !!rubricListMatch;
    var isRubricDetail = !!rubricDetailMatch;
    var isAssignment   = !!assignmentMatch;

    if (!isRubricList && !isRubricDetail && !isAssignment) return;

    // ── Feature flag — stamped by feature-flags.js ────────────────────────────

    if (document.documentElement.dataset.cptRubricPlus === 'false') return;

    // ── Constants ─────────────────────────────────────────────────────────────

    // Course ID is capture group 1 in whichever regex matched
    var courseId = (rubricListMatch || rubricDetailMatch || assignmentMatch)[1];
    // Rubric ID only exists on the individual rubric page (group 2)
    var rubricId = rubricDetailMatch ? rubricDetailMatch[2] : null;

    var CONTAINER_SEL  = '.rubric_container';
    var TITLE_AREA_SEL = '.rubric_title .displaying';
    var BADGE_CLASS    = 'cpt-rubric-grading-badge';
    var BADGE_STALE_ATTR = 'data-cpt-stale';
    var DETAILS_BTN_ID = 'cpt-rubric-details-btn';
    var COLLAPSE_BAR_ID = 'cpt-rubric-collapse-bar';
    var DETAILS_CLASS  = 'cpt-rubric-details';
    var ASSOC_PANEL_ID = 'cpt-rubric-associations';
    var ASSOC_BTN_ID   = 'cpt-rubric-assoc-btn';
    var ASSOC_BTN_WRAP_ID = 'cpt-rubric-assoc-btn-wrap';

    // Canvas renders three .rubric_container elements on an assignment page:
    // the real rubric (id="rubric_<id>"), a hidden summary
    // (id="default_rubric_summary"), and a blank template (id="default_rubric").
    // Matching the id positively is the only reliable filter — the template's
    // class list is a subset of the real one, so exclusion lists are fragile.
    var REAL_RUBRIC_ID = /^rubric_[0-9]+$/;

    // Bounded pool size for rubric detail fetches on the list page.
    var FETCH_CONCURRENCY = 4;

    // ══ Feature 1 — used-for-grading badge (assignment page) ══════════════════

    // Canvas stamps `for_grading` onto the container's class list when the
    // rubric drives the assignment grade. Verified on live DOM:
    //   used for grading:  "rubric_container rubric  for_grading"
    //   not used:          "rubric_container rubric  "
    // Note the doubled space — the class string is assembled with gaps, so
    // classList.contains() is required. A substring test on className would
    // work today and break the first time Canvas adds a class containing
    // "for_grading" as a prefix.
    //
    // The #grading_rubric checkbox looks like the obvious source but is not
    // usable: Canvas renders TWO elements sharing that id, both inside
    // #edit_rubric_form, and neither sits within a .rubric_container — so a
    // checkbox cannot be attributed to the rubric it edits. On a page whose
    // rubric IS used for grading, one reads true and one reads false, and
    // nothing in the DOM says which is authoritative. Verified on live DOM.

    function realRubricContainers() {
        var out = [];
        var all = document.querySelectorAll(CONTAINER_SEL);
        Array.prototype.forEach.call(all, function (c) {
            if (REAL_RUBRIC_ID.test(c.id)) out.push(c);
        });
        return out;
    }

    function buildBadgeContent(badge, forGrading) {
        badge.textContent = '';

        var span = document.createElement('span');
        span.className = forGrading ? 'text-success' : 'text-warning';

        var icon = document.createElement('i');
        icon.className = forGrading
            ? 'icon-line icon-check-plus'
            : 'icon-line icon-warning';

        span.appendChild(icon);
        span.appendChild(document.createTextNode(
            forGrading ? ' Used for grading' : ' Not used for grading'
        ));

        badge.appendChild(span);
    }

    function renderBadge(container) {
        var titleArea = container.querySelector(TITLE_AREA_SEL);
        if (!titleArea) return;

        var badge = container.querySelector('.' + BADGE_CLASS);
        if (!badge) {
            badge = document.createElement('div');
            badge.className = BADGE_CLASS;
            badge.style.cssText = 'font-size:1rem;font-weight:normal;';
            // Insert AFTER .displaying rather than inside it — rubric-exporter.js
            // appends its Export CSV button into the title area, and sharing the
            // node would put the badge on the same line as the button.
            titleArea.insertAdjacentElement('afterend', badge);
        }

        // Once marked stale, leave the refresh notice in place.
        if (badge.getAttribute(BADGE_STALE_ATTR) === 'true') return;

        buildBadgeContent(badge, container.classList.contains('for_grading'));
    }

    // ── Stale handling after an in-page rubric edit ───────────────────────────
    // Originally this watched the container's `class` attribute, expecting
    // Canvas to toggle `for_grading` after a save so the badge could re-derive
    // itself. Testing showed it does not: after saving a rubric edit the class
    // still reflects the pre-save state until the page is reloaded. The DOM
    // itself is stale, so no amount of re-reading it can produce a correct
    // answer. Instead, detect that an edit happened and say so plainly rather
    // than displaying a value we know may be wrong.

    function markBadgesStale() {
        var badges = document.querySelectorAll('.' + BADGE_CLASS);
        Array.prototype.forEach.call(badges, function (badge) {
            if (badge.getAttribute(BADGE_STALE_ATTR) === 'true') return;
            badge.setAttribute(BADGE_STALE_ATTR, 'true');
            badge.textContent = '';
            badge.appendChild(CPTPanel.segment(
                CPTPanel.COLORS.accent, 'icon-line icon-info',
                'Refresh page to update grading indicator'));
        });
    }

    // Canvas saves the rubric editor by submitting #edit_rubric_form (jQuery
    // intercepts and preventDefaults it, but the submit event still fires and
    // bubbles, so a capture-phase document listener sees it either way).
    function watchForRubricEdits() {
        document.addEventListener('submit', function (e) {
            var form = e.target;
            if (!form || form.nodeType !== 1) return;
            if (form.id === 'edit_rubric_form' ||
                (form.classList && form.classList.contains('edit-rubric-form'))) {
                markBadgesStale();
            }
        }, true);
    }

    function injectBadges() {
        realRubricContainers().forEach(function (container) {
            renderBadge(container);
        });
    }

    // ── Observation strategy (assignment page) ────────────────────────────────
    // The rubric container is present at document_idle on a normal load, but
    // Canvas swaps it in asynchronously after a save. Only fires on nodes that
    // are (or contain) a rubric container — the badge itself matches neither,
    // so injection cannot retrigger this.

    function startObserver() {
        var observer = new MutationObserver(function (mutations) {
            var shouldCheck = mutations.some(function (m) {
                return Array.prototype.some.call(m.addedNodes, function (node) {
                    if (node.nodeType !== 1) return false;
                    return node.matches(CONTAINER_SEL) ||
                           node.querySelector(CONTAINER_SEL) !== null;
                });
            });
            if (shouldCheck) injectBadges();
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ══ Feature 2 — Load Rubric Details (rubrics list page) ═══════════════════

    // Reuses rubric-exporter.js's row selectors so both features agree on what
    // a rubric row is: #rubrics ul li.hover-container, ID from the a.title href.

    function listRows() {
        var out = [];
        var items = document.querySelectorAll('#rubrics ul li.hover-container');
        Array.prototype.forEach.call(items, function (li) {
            var titleLink = li.querySelector('a.title');
            if (!titleLink) return;
            var m = /\/rubrics\/([0-9]+)$/.exec(titleLink.getAttribute('href'));
            if (!m) return;
            out.push({ li: li, rubricId: m[1] });
        });
        return out;
    }

    function fetchRubric(rubricId) {
        // Request include[]=assignment_associations but read the result from
        // `associations` — Canvas returns the array under `associations`
        // regardless of which association scope was asked for.
        var url = '/api/v1/courses/' + courseId + '/rubrics/' + rubricId +
                  '?include[]=assignment_associations';

        return fetch(url, {
            credentials: 'same-origin',
            headers:     { 'Accept': 'application/json' },
        })
        .then(function (response) {
            if (!response.ok) {
                throw new Error('Fetch failed (' + response.status + ')');
            }
            return response.json();
        });
    }

    function renderRowDetails(li, rubric, error) {
        // Replace any prior panel on this row so re-running refreshes cleanly.
        var existing = li.querySelector('.' + DETAILS_CLASS);
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }

        var built = CPTPanel.makePanel('Rubric details');
        var panel = built.panel;
        // DETAILS_CLASS is the per-row hook for idempotency; CPTPanel adds its
        // own PANEL_CLASS for collapse targeting.
        panel.classList.add(DETAILS_CLASS);
        panel.style.marginLeft = '20px';

        if (error) {
            built.addRow('Error',
                CPTPanel.segment(CPTPanel.COLORS.warning,
                    'icon-line icon-warning', error.message));
            li.appendChild(panel);
            return;
        }

        var assoc    = rubric.associations || [];
        var criteria = rubric.data || [];

        // On this endpoint outcome criteria carry `learning_outcome_id`. The
        // assignments endpoint exposes the same concept as `outcome_id` —
        // different field name for the same thing depending on the route.
        var hasOutcome = criteria.some(function (c) {
            return !!c.learning_outcome_id;
        });

        built.addRow('Context', document.createTextNode(
            (rubric.context_type || '?') +
            ' ' + (rubric.context_id != null ? rubric.context_id : '?')));

        if (assoc.length > 0) {
            built.addRow('Associations', CPTPanel.segment(CPTPanel.COLORS.text,
                null,
                assoc.length + ' assignment association' +
                (assoc.length === 1 ? '' : 's')));
        } else {
            built.addRow('Associations', CPTPanel.segment(CPTPanel.COLORS.warning,
                'icon-line icon-warning', 'No assignment associations'));
        }

        built.addRow('Outcomes', CPTPanel.segment(
            hasOutcome ? CPTPanel.COLORS.success : CPTPanel.COLORS.muted,
            hasOutcome ? 'icon-line icon-check' : null,
            hasOutcome ? 'Has outcome criteria' : 'No outcome criteria'));

        li.appendChild(panel);
    }

    // Ski's original awaits each rubric inside the row loop — a course with 30
    // rubrics means 30 sequential round trips. Run a bounded pool instead.
    function loadAllRubricDetails() {
        var queue = listRows();
        var total = queue.length;

        function worker() {
            var row = queue.shift();
            if (!row) return Promise.resolve();

            return fetchRubric(row.rubricId)
                .then(function (rubric) {
                    renderRowDetails(row.li, rubric, null);
                })
                .catch(function (error) {
                    renderRowDetails(row.li, null, error);
                })
                .then(worker);
        }

        var workers = [];
        var poolSize = Math.min(FETCH_CONCURRENCY, total);
        for (var i = 0; i < poolSize; i++) {
            workers.push(worker());
        }

        return Promise.all(workers).then(function () { return total; });
    }

    function injectCollapseBar(count) {
        var rubrics = document.getElementById('rubrics');
        if (!rubrics) return;

        var existing = document.getElementById(COLLAPSE_BAR_ID);
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }

        var bar = document.createElement('div');
        bar.id = COLLAPSE_BAR_ID;
        bar.style.cssText = CPTPanel.barStyle();

        var label = document.createElement('span');
        label.style.flex = '1';
        label.textContent = count +
            (count === 1 ? ' rubric loaded' : ' rubrics loaded');

        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'Button Button--small';
        toggle.style.fontSize = '0.75rem';
        toggle.setAttribute('aria-pressed', 'false');

        function render(collapsed) {
            toggle.innerHTML =
                '<i class="icon-line ' +
                (collapsed ? 'icon-arrow-open-down' : 'icon-arrow-open-up') +
                '" aria-hidden="true" style="margin-right:4px;"></i>' +
                (collapsed ? 'Expand all' : 'Collapse all');
        }
        render(false);

        toggle.addEventListener('click', function () {
            var collapse = toggle.getAttribute('aria-pressed') !== 'true';
            CPTPanel.setAllCollapsed(collapse);
            toggle.setAttribute('aria-pressed', collapse ? 'true' : 'false');
            render(collapse);
        });

        bar.appendChild(label);
        bar.appendChild(toggle);
        rubrics.insertAdjacentElement('beforebegin', bar);
    }

    function injectDetailsButton() {
        var rightSide = document.getElementById('right-side');
        if (!rightSide) return;
        if (document.getElementById(DETAILS_BTN_ID)) return;

        var btn = document.createElement('button');
        btn.id        = DETAILS_BTN_ID;
        btn.className = 'Button button-sidebar-wide';
        btn.title     = 'Load details for every rubric in this list';
        btn.innerHTML = '<i class="icon-line icon-info"></i> Load Rubric Details';

        btn.addEventListener('click', function () {
            if (btn._cptBusy) return;
            btn._cptBusy  = true;
            btn.disabled  = true;

            var original  = btn.innerHTML;
            btn.innerHTML = '<i class="icon-line icon-refresh"></i> Loading…';

            loadAllRubricDetails().then(function (count) {
                btn.innerHTML = original;
                btn.disabled  = false;
                btn._cptBusy  = false;
                injectCollapseBar(count);
            });
        });

        rightSide.appendChild(btn);
    }

    // ══ Feature 4 — Rubric Associations report (individual rubric page) ═══════
    // Answers "what is this rubric actually attached to?" — the thing that is
    // otherwise invisible in the Canvas UI, and the reason rubric IDs change on
    // course copy are hard to trace.

    function fetchAssociations() {
        var url = '/api/v1/courses/' + courseId + '/rubrics/' + rubricId +
                  '?include[]=associations';

        return fetch(url, {
            credentials: 'same-origin',
            headers:     { 'Accept': 'application/json' },
        })
        .then(function (response) {
            if (!response.ok) {
                throw new Error('Fetch failed (' + response.status + ')');
            }
            return response.json();
        });
    }

    // Canvas does not return the associated item's name on the rubric
    // endpoint — only its type and id. Ski's version leaves it at that (his
    // source carries a "TODO Consider trying to get item name"). Resolving them
    // costs one bulk call for the whole course rather than one per association,
    // so it is worth doing: the report is only useful if it says *what* the
    // rubric is attached to.
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

    // The same bulk call also carries each assignment's points_possible, so
    // points come along at no extra request cost. Resolves to
    // { names: {id: name}, points: {id: number|null} }.
    function fetchAssignmentInfo() {
        var results = [];

        function next(pageUrl) {
            return fetch(pageUrl, {
                credentials: 'same-origin',
                headers:     { 'Accept': 'application/json' },
            }).then(function (response) {
                if (!response.ok) {
                    throw new Error('Fetch failed (' + response.status + ')');
                }
                return response.json().then(function (page) {
                    results = results.concat(page);
                    var link = response.headers.get('Link');
                    var nextUrl = link ? parseNextLink(link) : null;
                    return nextUrl ? next(nextUrl) : results;
                });
            });
        }

        return next('/api/v1/courses/' + courseId + '/assignments?per_page=100')
            .then(function (list) {
                var info = { names: {}, points: {} };
                list.forEach(function (a) {
                    info.names[a.id] = a.name;
                    info.points[a.id] =
                        (typeof a.points_possible === 'number')
                            ? a.points_possible : null;
                });
                return info;
            });
    }

    // null/undefined means Canvas did not report points for this assignment
    // (or the lookup missed it); show a dash rather than a misleading 0.
    function pointsCell(points) {
        return (points == null) ? '-' : String(points);
    }

    // Association types returned here are 'Assignment', 'Course', and
    // 'Account'. Only assignment associations answer the question faculty
    // actually have (what uses this rubric). Course and Account rows describe
    // where the rubric is stored, not what consumes it, so they are filtered
    // out rather than shown.
    function assignmentLinkCell(assoc, namesById) {
        var id = assoc.association_id;
        var link = document.createElement('a');
        link.href = '/courses/' + courseId + '/assignments/' + id;
        link.target = '_blank';
        link.style.color = CPTPanel.COLORS.accent;

        // Fall back to the bare id if the name lookup missed this one, for
        // instance a deleted assignment or a lookup that failed entirely.
        var name = namesById && namesById[id];
        link.textContent = name || ('Assignment ' + id);
        link.title = name ? ('Open "' + name + '"') : 'Open assignment';
        return link;
    }

    function gradingCell(assoc) {
        if (assoc.use_for_grading) {
            return CPTPanel.segment(CPTPanel.COLORS.success,
                'icon-line icon-check', 'Yes');
        }
        return CPTPanel.segment(CPTPanel.COLORS.warning,
            'icon-line icon-warning', 'No');
    }

    // Place the panel directly beneath the trigger button when it exists, so
    // the button stays available for a refresh. Falls back to the top of the
    // content area if the button could not be injected.
    function placePanel(panel) {
        var anchor = document.getElementById(ASSOC_BTN_WRAP_ID);
        if (anchor) {
            anchor.insertAdjacentElement('afterend', panel);
            return;
        }
        var content = document.getElementById('content');
        if (content) content.insertAdjacentElement('afterbegin', panel);
    }

    function renderAssociationsPanel(rubric, error, info) {
        var existing = document.getElementById(ASSOC_PANEL_ID);
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }

        var built = CPTPanel.makePanel('Rubric associations');
        built.panel.id = ASSOC_PANEL_ID;

        if (error) {
            built.addRow('Error', CPTPanel.segment(CPTPanel.COLORS.warning,
                'icon-line icon-warning', error.message));
            placePanel(built.panel);
            return;
        }

        var names  = (info && info.names)  || {};
        var points = (info && info.points) || {};

        var assoc = (rubric.associations || []).filter(function (a) {
            return a.association_type === 'Assignment' && a.association_id != null;
        });

        if (assoc.length === 0) {
            built.addRow('Assignments', CPTPanel.segment(CPTPanel.COLORS.warning,
                'icon-line icon-warning', 'Not used by any assignment'));
            placePanel(built.panel);
            return;
        }

        // Alphabetical by resolved name. Unnamed entries sort last by id.
        // Returning 0 for those instead would make the comparator
        // non-transitive and scramble the named entries around them.
        assoc.sort(function (a, b) {
            var an = names[a.association_id];
            var bn = names[b.association_id];
            if (an && bn) {
                an = an.toLowerCase();
                bn = bn.toLowerCase();
                if (an !== bn) return an < bn ? -1 : 1;
                return 0;
            }
            if (an) return -1;
            if (bn) return 1;
            return (a.association_id || 0) - (b.association_id || 0);
        });

        var rows = assoc.map(function (a) {
            return [
                assignmentLinkCell(a, names),
                pointsCell(points[a.association_id]),
                gradingCell(a)
            ];
        });

        // The association also carries hide_points, hide_score_total, and
        // hide_outcome_results. They are deliberately not shown for now; add a
        // third column here if they turn out to be worth surfacing.
        built.addBlock(CPTPanel.makeTable(
            ['Assignment', 'Points possible', 'Used for grading'],
            rows,
            assoc.length + (assoc.length === 1 ? ' assignment' : ' assignments')
        ));

        placePanel(built.panel);
    }

    function loadAssociations() {
        return fetchAssociations()
            .then(function (rubric) {
                var assoc = rubric.associations || [];
                var hasAssignments = assoc.some(function (a) {
                    return a.association_type === 'Assignment';
                });

                // Skip the name lookup entirely when nothing would use it.
                if (!hasAssignments) {
                    renderAssociationsPanel(rubric, null, {});
                    return;
                }

                // Names are an enhancement, not a requirement. If the lookup
                // fails, still render the panel with ids rather than an error.
                return fetchAssignmentInfo()
                    .then(function (info) {
                        renderAssociationsPanel(rubric, null, info);
                    })
                    .catch(function () {
                        renderAssociationsPanel(rubric, null, {});
                    });
            })
            .catch(function (error) {
                renderAssociationsPanel(null, error, {});
            });
    }

    // Loading is behind a button rather than automatic. The report costs two
    // requests (the rubric plus the course assignment list for names), and not
    // every visit to a rubric page needs it.
    function injectAssociationsButton() {
        var content = document.getElementById('content');
        if (!content) return;
        if (document.getElementById(ASSOC_BTN_ID)) return;

        CPTPanel.ensureStyle(); // spin keyframe, before any panel exists

        var wrap = document.createElement('div');
        wrap.id = ASSOC_BTN_WRAP_ID;
        wrap.style.cssText = 'margin:10px 0;';

        var btn = document.createElement('button');
        btn.id        = ASSOC_BTN_ID;
        btn.type      = 'button';
        btn.className = 'Button';
        btn.title     = 'Show which assignments use this rubric';

        var IDLE_HTML =
            '<i class="icon-line icon-info" aria-hidden="true"></i> ' +
            'Load rubric associations';
        btn.innerHTML = IDLE_HTML;

        btn.addEventListener('click', function () {
            if (btn._cptBusy) return;
            btn._cptBusy = true;
            btn.disabled = true;
            btn.innerHTML =
                '<i class="icon-line icon-refresh ' + CPTPanel.SPIN_CLASS +
                '" aria-hidden="true"></i> Loading…';

            loadAssociations().then(function () {
                btn.innerHTML = IDLE_HTML;
                btn.disabled = false;
                btn._cptBusy = false;
            });
        });

        wrap.appendChild(btn);
        content.insertAdjacentElement('afterbegin', wrap);
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    if (isRubricList) {
        injectDetailsButton();
    } else if (isRubricDetail) {
        injectAssociationsButton();
    } else {
        injectBadges();
        startObserver();
        watchForRubricEdits();
    }

})();

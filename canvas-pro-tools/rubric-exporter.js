// rubric-exporter.js
// Canvas Pro-Tools — Rubrics+ CSV Exporter & Importer
// Export: injects an "Export CSV" button on rubric pages, assignments, discussions, and quizzes.
//   Attempts API-first export via POST /api/v1/courses/:id/rubrics/download_rubrics.
//   Falls back to DOM parsing if the rubric ID cannot be determined or the API call fails.
// Import: injects an "Import Rubric" button on the course rubrics list page.
//   POSTs the selected CSV to /api/v1/courses/:id/rubrics/upload, polls for completion,
//   then refreshes the page to show the newly imported rubric.
// Runs in ISOLATED world (default). Does not need window.ENV or page jQuery.
// Matches:
//   /courses/*/rubrics          ← import button only
//   /courses/*/rubrics/*        ← export button only
//   /courses/*/assignments/*
//   /courses/*/quizzes/*
//   /courses/*/discussion_topics/*

(function () {
    'use strict';

    // ── Route guard ───────────────────────────────────────────────────────────

    var path = window.location.pathname;

    var rubricListRegex  = new RegExp('^/courses/([0-9]+)/rubrics$');
    var rubricPageRegex  = new RegExp('^/courses/([0-9]+)/rubrics/([0-9]+)$');
    var assignmentRegex  = new RegExp('^/courses/([0-9]+)/assignments/[0-9]+$');
    var discussionRegex  = new RegExp('^/courses/([0-9]+)/discussion_topics/[0-9]+$');
    var quizRegex        = new RegExp('^/courses/([0-9]+)/quizzes/[0-9]+$');

    var rubricListMatch  = rubricListRegex.exec(path);
    var rubricPageMatch  = rubricPageRegex.exec(path);
    var assignmentMatch  = assignmentRegex.exec(path);
    var discussionMatch  = discussionRegex.exec(path);
    var quizMatch        = quizRegex.exec(path);

    var isRubricList = !!rubricListMatch;
    var isRubricPage = !!rubricPageMatch;
    var isAssignment = !!assignmentMatch;
    var isDiscussion = !!discussionMatch;
    var isQuiz       = !!quizMatch;

    if (!isRubricList && !isRubricPage && !isAssignment && !isDiscussion && !isQuiz) return;

    // ── Feature flag — stamped by feature-flags.js ────────────────────────────

    if (document.documentElement.dataset.cptRubricPlus === 'false') return;

    // ── Constants ─────────────────────────────────────────────────────────────

    var EXPORT_BTN_CLASS    = 'cpt-rubric-export-btn';
    var EXPORT_STATUS_CLASS = 'cpt-rubric-export-status';
    var IMPORT_BTN_ID       = 'cpt-rubric-import-btn';
    var TEMPLATE_BTN_ID     = 'cpt-rubric-template-btn';
    var EXPORT_ALL_BTN_ID   = 'cpt-rubric-export-all-btn';
    var LIST_EXPORT_CLASS   = 'cpt-rubric-list-export';
    var CONTAINER_SEL       = '.rubric_container';
    var TITLE_AREA_SEL      = '.rubric_title .displaying';

    // Course ID is always capture group 1 in whichever regex matched
    var courseId = (rubricListMatch || rubricPageMatch || assignmentMatch || discussionMatch || quizMatch)[1];

    // On the rubric page the rubric ID is in the URL (capture group 2).
    // On other pages it has to be read from the DOM per container.
    var urlRubricId = rubricPageMatch ? rubricPageMatch[2] : null;

    // ── CSRF token ────────────────────────────────────────────────────────────
    // Canvas stores the CSRF token in the _csrf_token cookie.
    // Reading document.cookie works in the isolated world for same-origin cookies.
    // The value is URI-encoded and must be decoded before sending.

    function getCsrfToken() {
        var cookies = document.cookie.split(';');
        for (var i = 0; i < cookies.length; i++) {
            var cookie = cookies[i].trim();
            if (cookie.indexOf('_csrf_token=') === 0) {
                return decodeURIComponent(cookie.substring('_csrf_token='.length));
            }
        }
        return null;
    }

    // ── Rubric ID from DOM ────────────────────────────────────────────────────
    // Verified on live MBU pages (assignment, discussion, rubric page):
    // Canvas sets the container id to "rubric_NNNNN" on all page types.
    // The quiz template container uses id="default_rubric" (no digits) and is
    // already excluded by injectButton, so the regex below is safe everywhere.

    function getRubricIdFromContainer(container) {
        if (container.id) {
            var idMatch = /^rubric_([0-9]+)$/.exec(container.id);
            if (idMatch) return idMatch[1];
        }
        return null;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // IMPORT — rubrics list page only
    // ═════════════════════════════════════════════════════════════════════════

    // ── Upload POST ───────────────────────────────────────────────────────────
    // POST /api/v1/courses/:course_id/rubrics/upload
    // Body: multipart/form-data with attachment field containing the CSV file.
    // Returns a RubricImport job object with an id we can poll.

    function uploadRubricCsv(file) {
        var csrfToken = getCsrfToken();
        if (!csrfToken) return Promise.reject(new Error('CSRF token not found'));

        var url  = '/api/v1/courses/' + courseId + '/rubrics/upload';
        var body = new FormData();
        body.append('attachment', file);

        return fetch(url, {
            method:      'POST',
            credentials: 'same-origin',
            headers: {
                'X-CSRF-Token':     csrfToken,
                'X-Requested-With': 'XMLHttpRequest',
                'Accept':           'application/json',
            },
            body: body,
        })
        .then(function (response) {
            if (!response.ok) throw new Error('Upload failed (' + response.status + ')');
            return response.json();
        });
    }

    // ── Import status poll ────────────────────────────────────────────────────
    // GET /api/v1/courses/:course_id/rubrics/upload/latest
    // Polls every 1.5 seconds until workflow_state is "succeeded" or "failed".
    // Calls onTick(attempt, maxAttempts) on each poll so the caller can advance
    // a progress indicator. Resolves with the final import object or rejects.

    function pollImportStatus(maxAttempts, onTick) {
        maxAttempts = maxAttempts || 20;
        var url = '/api/v1/courses/' + courseId + '/rubrics/upload/latest';
        var attempts = 0;

        return new Promise(function (resolve, reject) {
            function check() {
                attempts++;
                if (onTick) onTick(attempts, maxAttempts);

                fetch(url, {
                    credentials: 'same-origin',
                    headers: { 'Accept': 'application/json' },
                })
                .then(function (response) {
                    if (!response.ok) throw new Error('Poll failed (' + response.status + ')');
                    return response.json();
                })
                .then(function (data) {
                    var state = data.workflow_state;
                    if (state === 'succeeded') {
                        resolve(data);
                    } else if (state === 'failed') {
                        reject(new Error('Import failed: ' + (data.error_data || 'unknown error')));
                    } else if (attempts >= maxAttempts) {
                        reject(new Error('Import timed out'));
                    } else {
                        setTimeout(check, 1500);
                    }
                })
                .catch(reject);
            }
            setTimeout(check, 1500);
        });
    }

    // ── Find draft rubrics via GraphQL ────────────────────────────────────────
    // CSV-imported rubrics land in workflow_state "draft", but the REST
    // /api/v1/courses/:course_id/rubrics endpoint does not return workflow_state
    // at all (confirmed via live testing). GraphQL's Course.rubricsConnection
    // does return workflowState, but rubricsConnection has no server-side filter
    // for it (confirmed via schema introspection: args are after/before/first/id/last
    // only) — so we fetch up to 100 rubrics and filter client-side.
    // Returns a promise resolving to an array of rubric ID strings (workflowState === "draft").

    function findDraftRubricIds(csrfToken) {
        var query = 'query { courses(ids: "' + courseId + '") { rubricsConnection(first: 100) { nodes { _id workflowState } } } }';

        return fetch('/api/graphql', {
            method:      'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type':  'application/json',
                'X-CSRF-Token':  csrfToken,
                'Accept':        'application/json',
            },
            body: JSON.stringify({ query: query }),
        })
        .then(function (response) {
            if (!response.ok) throw new Error('GraphQL request failed (' + response.status + ')');
            return response.json();
        })
        .then(function (result) {
            var courses = result && result.data && result.data.courses;
            var nodes = (courses && courses[0] && courses[0].rubricsConnection && courses[0].rubricsConnection.nodes) || [];
            return nodes
                .filter(function (n) { return n.workflowState === 'draft'; })
                .map(function (n) { return n._id; });
        });
    }

    // ── Publish a single rubric ────────────────────────────────────────────────
    // CSV-imported rubrics are created with workflow_state "draft" and are not
    // visible/usable until published. There is no GraphQL mutation or simple
    // REST flag for this (confirmed via schema introspection — the only
    // rubric-related mutations are saveRubricAssessment, setRubricSelfAssessment,
    // updateRubricArchivedState, and updateRubricAssessmentReadState; none set
    // workflowState).
    //
    // Validated approach (live-tested against mobap.instructure.com):
    //   1. GET /api/v1/courses/:course_id/rubrics/:id?include[]=associations
    //   2. Rebuild the full rubric[*] form payload from that response, adding
    //      rubric[workflow_state] = "active"
    //   3. Include rubric_association[*] targeting the rubric's existing
    //      association (by its id), with purpose = "bookmark" — this matches
    //      the end state produced by Canvas's own Enhanced Rubrics publish flow.
    //   4. PUT /api/v1/courses/:course_id/rubrics/:id with that full payload
    //
    // Sending workflow_state alone (without the full criteria payload) was
    // tested and caused Canvas to wipe the rubric's criteria — the endpoint
    // requires the complete rubric definition on every update.

    function publishRubric(rubricId, csrfToken) {
        var getUrl = '/api/v1/courses/' + courseId + '/rubrics/' + rubricId + '?include[]=associations';

        return fetch(getUrl, {
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' },
        })
        .then(function (response) {
            if (!response.ok) throw new Error('Rubric fetch failed (' + response.status + ')');
            return response.json();
        })
        .then(function (rubric) {
            var body = new URLSearchParams();

            body.append('rubric[title]', rubric.title || '');
            body.append('rubric[hide_points]', rubric.hide_points ? 'true' : 'false');
            body.append('rubric[free_form_criterion_comments]', rubric.free_form_criterion_comments ? '1' : '0');
            body.append('rubric[button_display]', rubric.button_display || 'numeric');
            body.append('rubric[rating_order]', rubric.rating_order || 'descending');
            body.append('rubric[workflow_state]', 'active');

            var criteria = rubric.data || [];
            for (var i = 0; i < criteria.length; i++) {
                var criterion = criteria[i];
                var cPrefix = 'rubric[criteria][' + i + ']';

                body.append(cPrefix + '[id]', criterion.id);
                body.append(cPrefix + '[description]', criterion.description || '');
                body.append(cPrefix + '[long_description]', criterion.long_description || '');
                body.append(cPrefix + '[points]', criterion.points);
                body.append(cPrefix + '[learning_outcome_id]', criterion.learning_outcome_id || '');
                body.append(cPrefix + '[ignore_for_scoring]', criterion.ignore_for_scoring ? 'true' : 'false');
                body.append(cPrefix + '[mastery_points]', criterion.mastery_points != null ? criterion.mastery_points : '');
                body.append(cPrefix + '[criterion_use_range]', criterion.criterion_use_range ? 'true' : 'false');

                var ratings = criterion.ratings || [];
                for (var j = 0; j < ratings.length; j++) {
                    var rating = ratings[j];
                    var rPrefix = cPrefix + '[ratings][' + j + ']';

                    body.append(rPrefix + '[description]', rating.description || '');
                    body.append(rPrefix + '[long_description]', rating.long_description || '');
                    body.append(rPrefix + '[points]', rating.points);
                    body.append(rPrefix + '[id]', rating.id);
                }
            }

            var assoc = (rubric.associations && rubric.associations[0]) || null;
            if (assoc) {
                body.append('rubric_association[id]', assoc.id);
                body.append('rubric_association[association_id]', assoc.association_id);
                body.append('rubric_association[association_type]', assoc.association_type);
                body.append('rubric_association[purpose]', 'bookmark');
                body.append('rubric_association[hide_points]', assoc.hide_points ? '1' : '0');
                body.append('rubric_association[hide_outcome_results]', assoc.hide_outcome_results ? '1' : '0');
                body.append('rubric_association[hide_score_total]', assoc.hide_score_total ? '1' : '0');
                body.append('rubric_association[use_for_grading]', assoc.use_for_grading ? '1' : '0');
            }

            var putUrl = '/api/v1/courses/' + courseId + '/rubrics/' + rubricId;

            return fetch(putUrl, {
                method:      'PUT',
                credentials: 'same-origin',
                headers: {
                    'Content-Type':  'application/x-www-form-urlencoded',
                    'X-CSRF-Token':  csrfToken,
                    'Accept':        'application/json',
                },
                body: body.toString(),
            });
        })
        .then(function (response) {
            if (!response.ok) throw new Error('Rubric publish failed (' + response.status + ')');
            return response.json();
        });
    }

    // ── Publish all draft rubrics from an import ──────────────────────────────
    // Finds rubrics left in "draft" state (via GraphQL — see findDraftRubricIds)
    // and publishes each one in turn. Resolves with the count published.
    // If the GraphQL lookup or any individual publish fails, the error is
    // logged but the import is still considered successful — the rubric(s)
    // will simply remain in draft state and can be published manually.

    function publishImportedRubrics() {
        var csrfToken = getCsrfToken();
        if (!csrfToken) return Promise.reject(new Error('CSRF token not found'));

        return findDraftRubricIds(csrfToken)
            .then(function (draftIds) {
                if (draftIds.length === 0) return 0;

                var chain = Promise.resolve();
                draftIds.forEach(function (id) {
                    chain = chain.then(function () {
                        return publishRubric(id, csrfToken)
                            .catch(function (err) {
                                console.warn('CPT Rubrics+: failed to publish rubric ' + id + ' — ' + err.message);
                            });
                    });
                });
                return chain.then(function () { return draftIds.length; });
            })
            .catch(function (err) {
                console.warn('CPT Rubrics+: draft rubric lookup failed — ' + err.message);
                return 0;
            });
    }

    // ── Import progress bar ───────────────────────────────────────────────────
    // Injected below the Import Rubric button as a self-contained block.
    // States: idle (hidden), uploading (0→40%), processing (40→90% per poll tick),
    //         success (100%, green), error (current width, red).

    function injectProgressBarStyles() {
        if (document.getElementById('cpt-rubric-progress-styles')) return;
        var style = document.createElement('style');
        style.id = 'cpt-rubric-progress-styles';
        style.textContent = [
            '#cpt-rubric-progress-wrap {',
            '  display:none;',
            '  margin-top:6px;',
            '}',
            '#cpt-rubric-progress-label {',
            '  font-size:0.8em;',
            '  color:#555;',
            '  margin-bottom:3px;',
            '  font-family:inherit;',
            '}',
            '#cpt-rubric-progress-track {',
            '  height:6px;',
            '  background:#e8eaec;',
            '  border-radius:3px;',
            '  overflow:hidden;',
            '}',
            '#cpt-rubric-progress-fill {',
            '  height:100%;',
            '  width:0%;',
            '  border-radius:3px;',
            '  background:#0770a3;',
            '  transition:width 0.4s ease, background 0.3s ease;',
            '}',
            '#cpt-rubric-progress-fill.cpt-pulse {',
            '  animation:cpt-pulse 1.2s ease-in-out infinite;',
            '}',
            '@keyframes cpt-pulse {',
            '  0%,100% { opacity:1; }',
            '  50%      { opacity:0.55; }',
            '}',
        ].join('\n');
        document.head.appendChild(style);
    }

    function getOrCreateProgressBar(anchorEl) {
        var existing = document.getElementById('cpt-rubric-progress-wrap');
        if (existing) return existing;

        var wrap  = document.createElement('div');
        wrap.id   = 'cpt-rubric-progress-wrap';

        var label = document.createElement('div');
        label.id  = 'cpt-rubric-progress-label';

        var track = document.createElement('div');
        track.id  = 'cpt-rubric-progress-track';

        var fill  = document.createElement('div');
        fill.id   = 'cpt-rubric-progress-fill';

        track.appendChild(fill);
        wrap.appendChild(label);
        wrap.appendChild(track);

        anchorEl.insertAdjacentElement('afterend', wrap);
        return wrap;
    }

    function setProgress(anchorEl, pct, labelText, colorState) {
        var wrap  = getOrCreateProgressBar(anchorEl);
        var label = document.getElementById('cpt-rubric-progress-label');
        var fill  = document.getElementById('cpt-rubric-progress-fill');

        wrap.style.display  = 'block';
        label.textContent   = labelText || '';

        // pct === null means keep current width (used for error state)
        if (pct !== null) {
            fill.style.width = pct + '%';
        }

        fill.style.background = colorState === 'success' ? '#1a7d44'
                              : colorState === 'error'   ? '#c0392b'
                              :                            '#0770a3';

        if (colorState === 'working') {
            fill.classList.add('cpt-pulse');
        } else {
            fill.classList.remove('cpt-pulse');
        }
    }

    function hideProgress() {
        var wrap = document.getElementById('cpt-rubric-progress-wrap');
        if (wrap) wrap.style.display = 'none';
    }

    // ── Import button factory ─────────────────────────────────────────────────

    function injectImportButton() {
        // Idempotency guard
        if (document.getElementById(IMPORT_BTN_ID)) return;

        // The "Add Rubric" button is our anchor — insert after it
        var addBtn = document.querySelector('a.add_rubric_link');
        if (!addBtn) return;

        // Inject progress bar CSS once
        injectProgressBarStyles();

        // Hidden file input — triggered by the visible button
        var fileInput = document.createElement('input');
        fileInput.type   = 'file';
        fileInput.accept = '.csv,text/csv';
        fileInput.style.display = 'none';
        fileInput.id = 'cpt-rubric-import-file';
        document.body.appendChild(fileInput);

        // Visible button — styled to match Canvas's own sidebar buttons
        var btn = document.createElement('a');
        btn.id        = IMPORT_BTN_ID;
        btn.className = 'btn button-sidebar-wide';
        btn.href      = '#';
        btn.innerHTML = '<i class="icon-import"></i> Import Rubric';
        btn.style.cssText = 'display:block;margin-top:4px;';

        btn.addEventListener('click', function (e) {
            e.preventDefault();
            if (btn.disabled) return;
            fileInput.value = '';   // reset so same file can be re-selected
            fileInput.click();
        });

        fileInput.addEventListener('change', function () {
            var file = fileInput.files[0];
            if (!file) return;

            var MAX_POLL = 20;

            btn.disabled = true;
            setProgress(btn, 10, 'Uploading…', 'working');

            uploadRubricCsv(file)
                .then(function () {
                    // Upload done — start processing phase (40% → up to 90%)
                    setProgress(btn, 40, 'Processing…', 'working');

                    return pollImportStatus(MAX_POLL, function (attempt, max) {
                        // Each tick nudges the bar from 40% toward 90%
                        // using a decelerating curve so it slows as it approaches 90%
                        var range   = 50;   // 40% to 90%
                        var raw     = attempt / max;
                        var eased   = 1 - Math.pow(1 - raw, 2);  // ease-out quad
                        var pct     = 40 + Math.round(eased * range);
                        setProgress(btn, pct, 'Processing…', 'working');
                    });
                })
                .then(function () {
                    // Import succeeded — newly imported rubrics are left in
                    // "draft" state by Canvas and won't be usable until
                    // published. Find and publish them before reloading.
                    setProgress(btn, 95, 'Publishing rubric(s)…', 'working');
                    return publishImportedRubrics();
                })
                .then(function () {
                    setProgress(btn, 100, 'Imported — reloading…', 'success');
                    setTimeout(function () {
                        window.location.reload();
                    }, 1200);
                })
                .catch(function (err) {
                    setProgress(btn, null, '⚠ ' + err.message, 'error');
                    btn.disabled = false;
                });
        });

        // Insert directly after the Add Rubric button
        addBtn.insertAdjacentElement('afterend', btn);

        // Template button sits below the import button
        injectTemplateButton(btn);
    }

    // ── Template download button ──────────────────────────────────────────────
    // GET /api/v1/rubrics/upload_template — no course ID or CSRF needed.
    // Canvas returns the blank CSV template directly as the response body.

    function injectTemplateButton(afterEl) {
        if (document.getElementById(TEMPLATE_BTN_ID)) return;

        var btn = document.createElement('a');
        btn.id        = TEMPLATE_BTN_ID;
        btn.className = 'btn button-sidebar-wide';
        btn.href      = '#';
        btn.innerHTML = '<i class="icon-download"></i> Download Template';
        btn.style.cssText = 'display:block;margin-top:4px;';

        btn.addEventListener('click', function (e) {
            e.preventDefault();
            if (btn.disabled) return;
            btn.disabled = true;

            fetch('/api/v1/rubrics/upload_template', {
                credentials: 'same-origin',
                headers: { 'Accept': 'text/csv' },
            })
            .then(function (response) {
                if (!response.ok) throw new Error('Request failed (' + response.status + ')');
                return response.text();
            })
            .then(function (csv) {
                downloadCsv(csv, 'import_rubric_template.csv');
                btn.disabled = false;
            })
            .catch(function (err) {
                console.warn('CPT Rubrics+: template download failed — ' + err.message);
                btn.disabled = false;
            });
        });

        afterEl.insertAdjacentElement('afterend', btn);

        // Export All button sits below the template button
        injectExportAllButton(btn);
    }
    // Collects all rubric IDs from the list DOM, POSTs them all to
    // download_rubrics in one request, downloads the resulting CSV.

    function injectExportAllButton(afterEl) {
        if (document.getElementById(EXPORT_ALL_BTN_ID)) return;

        var btn = document.createElement('a');
        btn.id        = EXPORT_ALL_BTN_ID;
        btn.className = 'btn button-sidebar-wide';
        btn.href      = '#';
        btn.innerHTML = '<i class="icon-export"></i> Export All Rubrics';
        btn.style.cssText = 'display:block;margin-top:4px;';

        btn.addEventListener('click', function (e) {
            e.preventDefault();
            if (btn.disabled) return;

            var ids = getRubricIdsFromList();
            if (ids.length === 0) {
                console.warn('CPT Rubrics+: no rubric IDs found on page');
                return;
            }

            btn.disabled = true;
            btn.innerHTML = '<i class="icon-export"></i> Exporting…';

            exportRubricsByIds(ids, 'all-rubrics')
                .then(function () {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="icon-export"></i> Export All Rubrics';
                })
                .catch(function (err) {
                    console.warn('CPT Rubrics+: export all failed — ' + err.message);
                    btn.disabled = false;
                    btn.innerHTML = '<i class="icon-export"></i> Export All Rubrics';
                });
        });

        afterEl.insertAdjacentElement('afterend', btn);
    }

    // ── Rubric ID harvester (list page) ───────────────────────────────────────
    // Reads rubric IDs from the title link hrefs in the rubric list.
    // e.g. /courses/42275/rubrics/123727 → "123727"

    function getRubricIdsFromList() {
        var ids = [];
        var links = document.querySelectorAll('#rubrics ul li a.title');
        links.forEach(function (a) {
            var m = /\/rubrics\/([0-9]+)$/.exec(a.getAttribute('href'));
            if (m) ids.push(m[1]);
        });
        return ids;
    }

    // ── Shared API export by ID(s) ────────────────────────────────────────────
    // Used by both per-row and export-all buttons on the list page.

    function exportRubricsByIds(ids, filenameStem) {
        var csrfToken = getCsrfToken();
        if (!csrfToken) return Promise.reject(new Error('CSRF token not found'));

        var url  = '/api/v1/courses/' + courseId + '/rubrics/download_rubrics';
        var body = new URLSearchParams();
        ids.forEach(function (id) { body.append('rubric_ids[]', id); });

        return fetch(url, {
            method:      'POST',
            credentials: 'same-origin',
            headers: {
                'X-CSRF-Token':     csrfToken,
                'X-Requested-With': 'XMLHttpRequest',
                'Accept':           'text/csv',
            },
            body: body,
        })
        .then(function (response) {
            if (!response.ok) throw new Error('API returned ' + response.status);
            return response.text();
        })
        .then(function (csv) {
            // Export All is the largest payload this script produces, so it is
            // the one that most needs downloadCsv's Blob path rather than an
            // inline data: URI.
            downloadCsv(csv, safeFilename(filenameStem) + '.csv');
        });
    }

    // ── Per-row export injection (list page) ──────────────────────────────────
    // Injects an export icon into the existing .links span (hover-reveal, matches
    // edit/delete style) AND a standalone always-visible button after the <li>
    // content, so both placements can be compared.

    function injectListRowExportButtons() {
        var items = document.querySelectorAll('#rubrics ul li.hover-container');
        items.forEach(function (li) {
            if (li.querySelector('.' + LIST_EXPORT_CLASS)) return; // idempotency

            // Extract rubric ID from the title link href
            var titleLink = li.querySelector('a.title');
            if (!titleLink) return;
            var m = /\/rubrics\/([0-9]+)$/.exec(titleLink.getAttribute('href'));
            if (!m) return;
            var rubricId   = m[1];
            var rubricName = titleLink.textContent.trim();

            // ── Export icon inside .links span (always visible, between edit and delete) ──
            var linksSpan = li.querySelector('span.links');
            if (linksSpan) {
                var deleteLink = linksSpan.querySelector('a.delete_rubric_link');

                var iconLink = document.createElement('a');
                iconLink.className  = LIST_EXPORT_CLASS + ' hide-till-hover';
                iconLink.href       = '#';
                iconLink.title      = 'Export Rubric CSV: ' + rubricName;
                iconLink.setAttribute('aria-label', 'Export Rubric CSV: ' + rubricName);
                iconLink.innerHTML  = '<i class="icon-download standalone-icon"></i>';

                iconLink.addEventListener('click', function (e) {
                    e.preventDefault();
                    if (iconLink._cptBusy) return;
                    iconLink._cptBusy = true;
                    exportRubricsByIds([rubricId], rubricName)
                        .then(function ()  { iconLink._cptBusy = false; })
                        .catch(function () { iconLink._cptBusy = false; });
                });

                // Insert before delete so order is: Edit, Export, Delete
                if (deleteLink) {
                    linksSpan.insertBefore(iconLink, deleteLink);
                } else {
                    linksSpan.appendChild(iconLink);
                }
            }
        });
    }

    // ── Export status indicator ───────────────────────────────────────────────

    function getOrCreateExportStatus(btn) {
        var existing = btn.parentNode && btn.parentNode.querySelector('.' + EXPORT_STATUS_CLASS);
        if (existing) return existing;

        var span = document.createElement('span');
        span.className = EXPORT_STATUS_CLASS;
        span.style.cssText = [
            'display:none',
            'margin-left:8px',
            'font-size:0.82em',
            'font-family:inherit',
            'vertical-align:middle',
            'font-weight:normal',
        ].join(';');
        btn.parentNode.insertBefore(span, btn.nextSibling);
        return span;
    }

    function setExportStatus(btn, state, message) {
        var span = getOrCreateExportStatus(btn);

        if (btn._cptStatusTimer) {
            clearTimeout(btn._cptStatusTimer);
            btn._cptStatusTimer = null;
        }

        var colors = { working: '#666', success: '#127a12', error: '#c00' };
        var prefix = { working: '⏳ ', success: '✓ ', error: '⚠ ' };

        span.style.display  = 'inline';
        span.style.color    = colors[state] || '#666';
        span.textContent    = (prefix[state] || '') + (message || '');

        if (state === 'success') {
            btn._cptStatusTimer = setTimeout(function () {
                span.style.display = 'none';
                span.textContent   = '';
            }, 2000);
        }

        if (state === 'idle') {
            span.style.display = 'none';
            span.textContent   = '';
        }
    }

    // ── API export ────────────────────────────────────────────────────────────

    function exportViaApi(rubricId, btn) {
        var csrfToken = getCsrfToken();
        if (!csrfToken) return Promise.reject(new Error('CSRF token not found'));

        var url  = '/api/v1/courses/' + courseId + '/rubrics/download_rubrics';
        var body = new URLSearchParams();
        body.append('rubric_ids[]', rubricId);

        setExportStatus(btn, 'working', 'Fetching from API…');

        return fetch(url, {
            method:      'POST',
            credentials: 'same-origin',
            headers: {
                'X-CSRF-Token':     csrfToken,
                'X-Requested-With': 'XMLHttpRequest',
                'Accept':           'text/csv',
            },
            body: body,
        })
        .then(function (response) {
            if (!response.ok) throw new Error('API returned ' + response.status);
            return response.text();
        })
        .then(function (csv) {
            var titleEl  = document.querySelector(CONTAINER_SEL + ' .rubric_title .displaying .title');
            var title    = titleEl ? titleEl.textContent.trim() : 'rubric';
            var filename = safeFilename(title) + '.csv';
            return { csv: csv, filename: filename };
        });
    }

    // ── DOM parser ────────────────────────────────────────────────────────────

    function parseRubric(container) {
        var titleEl    = container.querySelector('.rubric_title .displaying .title');
        var rubricTitle = titleEl ? titleEl.textContent.trim() : '';

        var criteria   = [];
        var maxRatings = 0;

        var criterionRows = container.querySelectorAll('tr.criterion:not(.blank)');

        criterionRows.forEach(function (row) {
            var titleSpan      = row.querySelector('.description.description_title');
            var criterionTitle = titleSpan ? titleSpan.textContent.trim() : '';

            var descEl         = row.querySelector('.long_description.small_description');
            var criterionDesc  = descEl ? descEl.textContent.trim() : '';

            var rangeCheckbox  = row.querySelector('input.criterion_use_range');
            var rangeEnabled   = rangeCheckbox ? rangeCheckbox.checked : false;

            var ratingDivs = row.querySelectorAll('.rating:not(.add_rating_link)');
            var ratings    = [];

            ratingDivs.forEach(function (ratingDiv) {
                var labelEl     = ratingDiv.querySelector('.description.rating_description_value');
                var ratingLabel = labelEl ? labelEl.textContent.trim() : '';

                var ptsSpan    = ratingDiv.querySelector('.nobr .points');
                var ratingPts  = ptsSpan ? ptsSpan.textContent.trim() : '';

                var ratingDescEl = ratingDiv.querySelector('.rating_long_description.small_description');
                var ratingDesc   = ratingDescEl ? ratingDescEl.textContent.trim() : '';

                ratings.push([ratingLabel, ratingDesc, ratingPts]);
            });

            if (ratings.length > maxRatings) maxRatings = ratings.length;

            criteria.push({
                rubricTitle:    rubricTitle,
                criterionTitle: criterionTitle,
                criterionDesc:  criterionDesc,
                rangeEnabled:   rangeEnabled,
                ratings:        ratings,
            });
        });

        return { criteria: criteria, maxRatings: maxRatings };
    }

    // ── CSV builder ───────────────────────────────────────────────────────────

    function csvEscape(val) {
        var s = (val === null || val === undefined) ? '' : String(val).trim();

        // Formula-injection guard: Excel/Sheets evaluate cells beginning with
        // = + - @ as formulas, even inside quoted CSV fields, so rubric text
        // authored by others could execute on the exporter's machine. Prefix
        // a single space to force text interpretation. Plain numbers (e.g.
        // negative points "-2") are exempt — they can't be formulas, and a
        // space prefix would stop Excel from treating them as numeric. The
        // space is round-trip-safe: values are trimmed on import.
        if (/^[=+\-@]/.test(s) && !/^[-+]?\d*\.?\d+$/.test(s)) {
            s = ' ' + s;
        }

        if (s.indexOf('"') !== -1 || s.indexOf(',') !== -1 || s.indexOf('\n') !== -1) {
            s = '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
    }

    function buildRow(cells) {
        return cells.map(csvEscape).join(',');
    }

    function buildCsv(parsed) {
        var maxRatings  = parsed.maxRatings;
        var headerCells = [
            'Rubric Name',
            'Criteria Name',
            'Criteria Description',
            'Criteria Enable Range',
        ];
        for (var h = 0; h < maxRatings; h++) {
            headerCells.push('Rating Name', 'Rating Description', 'Rating Points');
        }

        var lines = [buildRow(headerCells)];

        parsed.criteria.forEach(function (c) {
            var cells = [
                c.rubricTitle,
                c.criterionTitle,
                c.criterionDesc,
                c.rangeEnabled ? 'true' : 'false',
            ];
            for (var r = 0; r < maxRatings; r++) {
                if (r < c.ratings.length) {
                    cells.push(c.ratings[r][0], c.ratings[r][1], c.ratings[r][2]);
                } else {
                    cells.push('', '', '');
                }
            }
            lines.push(buildRow(cells));
        });

        return lines.join('\n');
    }

    // ── Downloader ────────────────────────────────────────────────────────────

    // Two paths, deliberately. Quiz pages serve a stricter Content-Security-
    // Policy than the rest of Canvas, and it blocks both blob: and data: URI
    // downloads. An <a download> pointing at either one silently fails there:
    // no file, no error. Routing through a new about:blank tab escapes that
    // document's CSP, which is why openCsvInNewTab exists and why it uses
    // document.write.
    //
    // This is a workaround for a platform constraint, not legacy code. Do not
    // "simplify" the quiz branch into the direct download below without first
    // re-testing an export from a live quiz page; the failure is silent, so a
    // regression here would not surface until a user reported a dead button.
    //
    // The non-quiz path uses a Blob rather than a data: URI. A data: URI has
    // to hold the entire file inside the URL string, which is size-capped, and
    // encodeURIComponent inflates it further: measured at about 1.43x on
    // realistic rubric CSV, since commas, quotes, and newlines each become
    // three characters. Export All Rubrics on a large course is the case that
    // would approach that ceiling, and it would fail silently too. Blob URLs
    // carry no such limit. Verified on a live rubrics page that Canvas's CSP
    // there permits blob: downloads.
    //
    // Every non-quiz download goes through here. Callers previously built
    // their own anchor inline, which meant the quiz branch and any future
    // change to download mechanics had to be repeated in three places.
    function downloadCsv(csvString, filename) {
        if (isQuiz) {
            openCsvInNewTab(csvString, filename);
            return;
        }

        var url = URL.createObjectURL(
            new Blob([csvString], { type: 'text/csv;charset=utf-8' })
        );
        var a = document.createElement('a');
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // The click is synchronous but the fetch the browser performs against
        // the blob URL is not, so revoking immediately can race the download
        // on slower machines. One frame is enough and prevents the URL (and
        // the Blob it pins in memory) from leaking for the tab's lifetime.
        requestAnimationFrame(function () { URL.revokeObjectURL(url); });
    }

    function openCsvInNewTab(csvString, filename) {
        var win = window.open('about:blank', '_blank');
        if (!win) {
            alert('Export failed: please allow popups for this site and try again.');
            return;
        }

        var escaped = csvString
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        var html = [
            '<!DOCTYPE html>',
            '<html><head><meta charset="utf-8">',
            '<title>' + filename + '</title>',
            '<style>',
            'body{font-family:monospace;font-size:13px;padding:20px;background:#f5f5f5;}',
            'h2{font-family:sans-serif;font-size:16px;margin-bottom:8px;}',
            'p{font-family:sans-serif;font-size:13px;color:#555;margin-bottom:12px;}',
            '.btn{display:inline-block;padding:8px 16px;background:#0770a3;color:#fff;',
            'border:none;border-radius:4px;cursor:pointer;font-size:14px;margin-bottom:16px;}',
            '.btn:hover{background:#045a82;}',
            'pre{background:#fff;border:1px solid #ddd;padding:12px;',
            'overflow:auto;white-space:pre;border-radius:4px;}',
            '</style></head><body>',
            '<h2>📋 ' + filename + '</h2>',
            '<p>Click the button below to download, or select all and copy.</p>',
            '<button class="btn" id="dlBtn">⬇ Download CSV</button>',
            '<pre id="csv">' + escaped + '</pre>',
            '</body></html>',
        ].join('\n');

        win.document.open();
        win.document.write(html);
        win.document.close();

        var dlBtn = win.document.getElementById('dlBtn');
        var csvEl = win.document.getElementById('csv');
        if (dlBtn && csvEl) {
            dlBtn.addEventListener('click', function () {
                var a = win.document.createElement('a');
                a.href     = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvEl.textContent);
                a.download = filename;
                win.document.body.appendChild(a);
                a.click();
                win.document.body.removeChild(a);
            });
        }
    }

    function safeFilename(title) {
        return (title || 'rubric')
            .replace(/[^a-z0-9\-_\s]/gi, '')
            .replace(/\s+/g, '-')
            .toLowerCase()
            .slice(0, 60);
    }

    // ── Export orchestrator ───────────────────────────────────────────────────

    function runExport(container, btn) {
        btn.disabled = true;

        var rubricId = urlRubricId || getRubricIdFromContainer(container);

        if (!rubricId) {
            // Routine, not an error: the API path needs a rubric ID, and some
            // pages (notably an unsaved or inline rubric) do not expose one.
            // The DOM parser handles those. Kept at debug level so a normal
            // export does not write to the user's console.
            console.debug('CPT Rubrics+: rubric ID not found in DOM, falling back to DOM parser');
            runDomExport(container, btn);
            return;
        }

        exportViaApi(rubricId, btn)
            .then(function (result) {
                downloadCsv(result.csv, result.filename);
                setExportStatus(btn, 'success', 'Exported');
                btn.disabled = false;
            })
            .catch(function (err) {
                console.warn('CPT Rubrics+: API export failed (' + err.message + ') — falling back to DOM parser');
                setExportStatus(btn, 'working', 'Retrying…');
                runDomExport(container, btn);
            });
    }

    function runDomExport(container, btn) {
        var parsed = parseRubric(container);
        if (parsed.criteria.length === 0) {
            setExportStatus(btn, 'error', 'No rubric data found');
            btn.disabled = false;
            return;
        }
        var titleEl  = container.querySelector('.rubric_title .displaying .title');
        var title    = titleEl ? titleEl.textContent.trim() : 'rubric';
        var filename = safeFilename(title) + '.csv';
        downloadCsv(buildCsv(parsed), filename);
        setExportStatus(btn, 'success', 'Exported');
        btn.disabled = false;
    }

    // ── Export button factory ─────────────────────────────────────────────────

    function createExportButton(container) {
        var btn = document.createElement('button');
        btn.className   = EXPORT_BTN_CLASS;
        btn.textContent = '⬇ Export CSV';
        btn.title       = 'Export this rubric as a CSV file';
        btn.style.cssText = [
            'display:inline-block',
            'margin-left:12px',
            'padding:3px 10px',
            'font-size:0.85em',
            'font-family:inherit',
            'background:#0770a3',
            'color:#fff',
            'border:none',
            'border-radius:4px',
            'cursor:pointer',
            'vertical-align:middle',
            'line-height:1.6',
        ].join(';');

        btn.addEventListener('mouseenter', function () {
            if (!btn.disabled) btn.style.background = '#045a82';
        });
        btn.addEventListener('mouseleave', function () {
            if (!btn.disabled) btn.style.background = '#0770a3';
        });

        btn.addEventListener('click', function () {
            runExport(container, btn);
        });

        return btn;
    }

    // ── Export injection ──────────────────────────────────────────────────────

    function injectExportButton(container) {
        if (container.id === 'default_rubric') return;
        if (container.classList.contains('rubric_summary')) return;
        if (container.style.display === 'none') return;
        if (container.querySelector('.' + EXPORT_BTN_CLASS)) return;

        var titleArea = container.querySelector(TITLE_AREA_SEL);
        if (!titleArea) return;

        var btn = createExportButton(container);
        titleArea.appendChild(btn);
    }

    function injectAllExportButtons() {
        var containers = document.querySelectorAll(CONTAINER_SEL);
        containers.forEach(function (c) {
            injectExportButton(c);
        });
    }

    // ── Observation strategy ──────────────────────────────────────────────────

    function startObserver() {
        var observer = new MutationObserver(function (mutations) {
            var shouldCheck = mutations.some(function (m) {
                if (m.type === 'childList') {
                    return Array.prototype.some.call(m.addedNodes, function (node) {
                        if (node.nodeType !== 1) return false;
                        return node.matches(CONTAINER_SEL) ||
                               node.querySelector(CONTAINER_SEL) !== null;
                    });
                }
                if (m.type === 'attributes' && m.attributeName === 'style') {
                    var target = m.target;
                    return target.matches(CONTAINER_SEL) ||
                           target.closest(CONTAINER_SEL) !== null;
                }
                return false;
            });
            if (shouldCheck) injectAllExportButtons();
        });

        observer.observe(document.body, {
            childList:       true,
            subtree:         true,
            attributes:      true,
            attributeFilter: ['style'],
        });
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    if (isRubricList) {
        injectImportButton();
        injectListRowExportButtons();
    } else {
        injectAllExportButtons();
        startObserver();
    }

})();

// rubric-assoc-editor.js
// Canvas Pro-Tools - Rubrics+ : Rubric Association Editor
// Canvas hides the Edit button on a rubric that is attached to more than one
// assignment. This feature works around that in two steps:
//   1. "Unlock rubric for editing" - saves a snapshot of every assignment
//      association except the first, then deletes those associations through
//      the Canvas API. The rubric is left attached to one assignment, so after
//      a page refresh Canvas shows Edit again.
//   2. "Restore associations" - after the rubric has been edited, re-creates
//      the saved associations from the snapshot.
// Ported from Erik's PowerShell script (dissociate all but the first, then
// re-POST the rest). Differences from the script:
//   - Only Assignment associations are touched. Course/Account associations
//     describe where the rubric is stored and are never deleted.
//   - The snapshot is saved to chrome.storage.local BEFORE the first delete, so
//     it survives the page refresh (and a browser restart) between the two steps.
//   - Restore is resumable: it re-reads the live associations first and skips
//     any that are already present, so a partial failure can be retried.
//   - The page refreshes itself ~1.5s after a fully successful detach or
//     restore. It does not refresh after a failure (the error stays visible)
//     or while the rubric edit form is open (unsaved edits would be lost).
//     After a restore refresh, the page confirms the live association count
//     and compares each assignment's points with what it had before the
//     rubric was detached (restoring can change assignment points).
// Runs in ISOLATED world (default). Does not need window.ENV or page jQuery.
// Matches:
//   /courses/*/rubrics/*   (individual rubric page only; route-guarded below)
// Must be listed AFTER cpt-panel.js and rubric-info.js in the same manifest
// block: it uses the global CPTPanel and places its button beside the
// "Load rubric associations" button that rubric-info.js creates.

(function () {
    'use strict';

    // ── Route guard ───────────────────────────────────────────────────────────

    var match = /^\/courses\/([0-9]+)\/rubrics\/([0-9]+)$/.exec(window.location.pathname);
    if (!match) return;

    // ── Feature flag - stamped by feature-flags.js (shares Rubrics+) ──────────

    if (document.documentElement.dataset.cptRubricPlus === 'false') return;

    if (typeof CPTPanel === 'undefined') {
        console.warn('[CPT] rubric-assoc-editor: CPTPanel not loaded; ' +
                     'check manifest order (cpt-panel.js must come first).');
        return;
    }

    // ── Constants ─────────────────────────────────────────────────────────────

    var courseId = match[1];
    var rubricId = match[2];

    // Storage shape: { "<hostname>": { "<courseId>_<rubricId>": snapshot } }
    // under one cpt_-prefixed key, hostname-scoped like every other CPT key.
    var STORE_KEY  = 'cpt_rubric_assoc_snapshots';
    var HOST       = window.location.hostname;
    var SNAP_ID    = courseId + '_' + rubricId;

    var BTN_ID        = 'cpt-rubric-unlock-btn';
    var HOST_ID       = 'cpt-rubric-assoc-editor';
    var OWN_WRAP_ID   = 'cpt-rubric-unlock-wrap';
    var INFO_WRAP_ID  = 'cpt-rubric-assoc-btn-wrap'; // created by rubric-info.js

    // Pause before an automatic page refresh, so the success message can be
    // read. It is not needed for correctness: every API call has completed
    // before the refresh is scheduled.
    var RELOAD_DELAY_MS = 1500;

    // One-shot note left for the page load that follows an automatic refresh
    // after Restore, so the page can confirm the result from live data.
    // Shape: { "<hostname>": { "<courseId>_<rubricId>": { at, expected } } }
    var NOTICE_KEY        = 'cpt_rubric_assoc_notices';
    var NOTICE_MAX_AGE_MS = 5 * 60 * 1000;

    var busy = false;

    // ── Storage ───────────────────────────────────────────────────────────────

    function readAll() {
        return new Promise(function (resolve, reject) {
            chrome.storage.local.get(STORE_KEY, function (result) {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve((result && result[STORE_KEY]) || {});
            });
        });
    }

    function readSnapshot() {
        return readAll().then(function (all) {
            return (all[HOST] && all[HOST][SNAP_ID]) || null;
        });
    }

    // Pass null to delete this rubric's snapshot.
    function writeSnapshot(snapshot) {
        return readAll().then(function (all) {
            if (!all[HOST]) all[HOST] = {};
            if (snapshot) {
                all[HOST][SNAP_ID] = snapshot;
            } else {
                delete all[HOST][SNAP_ID];
            }
            return new Promise(function (resolve, reject) {
                var payload = {};
                payload[STORE_KEY] = all;
                chrome.storage.local.set(payload, function () {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    resolve();
                });
            });
        });
    }

    function readNoticeStore() {
        return new Promise(function (resolve, reject) {
            chrome.storage.local.get(NOTICE_KEY, function (result) {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve((result && result[NOTICE_KEY]) || {});
            });
        });
    }

    function writeNoticeStore(store) {
        return new Promise(function (resolve, reject) {
            var payload = {};
            payload[NOTICE_KEY] = store;
            chrome.storage.local.set(payload, function () {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve();
            });
        });
    }

    // note: { at, expected, rows: [{ id, name, before }] } - `rows` is every
    // assignment that should be attached after the restore, with the points it
    // had when it was detached.
    function saveNotice(note) {
        return readNoticeStore().then(function (store) {
            if (!store[HOST]) store[HOST] = {};
            store[HOST][SNAP_ID] = note;
            return writeNoticeStore(store);
        });
    }

    // Reads and removes this rubric's note. Returns null when there is none or
    // it is too old to belong to the refresh that just happened.
    function takeNotice() {
        return readNoticeStore().then(function (store) {
            var note = store[HOST] && store[HOST][SNAP_ID];
            if (!note) return null;
            delete store[HOST][SNAP_ID];
            return writeNoticeStore(store).then(function () {
                return (Date.now() - note.at <= NOTICE_MAX_AGE_MS) ? note : null;
            });
        });
    }

    // ── Canvas API ────────────────────────────────────────────────────────────

    // Same-origin fetch with the CSRF token from the _csrf_token cookie.
    // Required on every non-GET request to the Canvas API from a page session.
    function csrfToken() {
        var m = /(?:^|;\s*)_csrf_token=([^;]*)/.exec(document.cookie);
        return m ? decodeURIComponent(m[1]) : '';
    }

    function apiRequest(method, url, body) {
        var headers = { 'Accept': 'application/json' };
        var opts = { method: method, credentials: 'same-origin', headers: headers };

        if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken();
        if (body) {
            headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }

        return fetch(url, opts).then(function (response) {
            return response.text().then(function (text) {
                if (!response.ok) {
                    var msg = 'HTTP ' + response.status;
                    try {
                        var parsed = JSON.parse(text);
                        if (parsed && parsed.errors) {
                            msg += ': ' + JSON.stringify(parsed.errors);
                        }
                    } catch (e) { /* body was not JSON; keep the status only */ }
                    throw new Error(msg);
                }
                if (!text) return null;
                try { return JSON.parse(text); } catch (e) { return null; }
            });
        });
    }

    // Live Assignment associations for this rubric, in the order Canvas
    // returns them (the PowerShell script keeps the first of this order).
    function fetchAssignmentAssociations() {
        var url = '/api/v1/courses/' + courseId + '/rubrics/' + rubricId +
                  '?include[]=assignment_associations';
        return apiRequest('GET', url).then(function (rubric) {
            return ((rubric && rubric.associations) || []).filter(function (a) {
                return a.association_type === 'Assignment' &&
                       a.association_id != null;
            });
        });
    }

    function deleteAssociation(associationRecordId) {
        return apiRequest('DELETE',
            '/api/v1/courses/' + courseId + '/rubric_associations/' +
            associationRecordId);
    }

    function createAssociation(item) {
        var assoc = {
            rubric_id:        rubricId,
            association_id:   item.association_id,
            association_type: item.association_type || 'Assignment',
            use_for_grading:  !!item.use_for_grading,
            hide_score_total: !!item.hide_score_total,
            purpose:          item.purpose || 'grading'
        };
        // Present on the association object; only send what Canvas gave us.
        if (typeof item.hide_points === 'boolean') {
            assoc.hide_points = item.hide_points;
        }
        if (typeof item.hide_outcome_results === 'boolean') {
            assoc.hide_outcome_results = item.hide_outcome_results;
        }
        return apiRequest('POST',
            '/api/v1/courses/' + courseId + '/rubric_associations',
            { rubric_association: assoc });
    }

    // Assignment names and points are an enhancement: the associations only
    // carry ids. One paginated call for the course covers both, same approach
    // as rubric-info.js. Resolves to { names: {id: name}, points: {id: n|null} }
    // and never rejects: on failure both maps are empty and the UI falls back
    // to bare ids and "Unavailable".
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

    function fetchAssignmentInfo() {
        var results = [];

        function next(pageUrl) {
            return fetch(pageUrl, {
                credentials: 'same-origin',
                headers:     { 'Accept': 'application/json' }
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
            })
            .catch(function () { return { names: {}, points: {} }; });
    }

    function fmtPoints(p) {
        return (p == null) ? '-' : String(p);
    }

    // Compares a before/after pair of point values.
    // Returns 'changed' | 'same' | 'unknown'.
    function comparePoints(before, now) {
        if (before == null || now == null) return 'unknown';
        return Number(before) === Number(now) ? 'same' : 'changed';
    }

    // ── Small DOM helpers ─────────────────────────────────────────────────────

    function makeButton(label, iconClass, onClick, extraClass) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'Button' + (extraClass ? ' ' + extraClass : '');
        if (iconClass) {
            var icon = document.createElement('i');
            icon.className = 'icon-line ' + iconClass;
            icon.setAttribute('aria-hidden', 'true');
            btn.appendChild(icon);
            btn.appendChild(document.createTextNode(' '));
        }
        btn.appendChild(document.createTextNode(label));
        btn.addEventListener('click', onClick);
        return btn;
    }

    function assignmentLink(assignmentId, name) {
        var link = document.createElement('a');
        link.href = '/courses/' + courseId + '/assignments/' + assignmentId;
        link.target = '_blank';
        link.rel = 'noopener';
        link.style.color = CPTPanel.COLORS.accent;
        link.textContent = name || ('Assignment ' + assignmentId);
        return link;
    }

    // ── Confirmation dialog ───────────────────────────────────────────────────
    // Custom dialog rather than window.confirm(), which triggers Chrome's
    // "prevent additional dialogs" warning and blocks the extension.

    function openDialog(opts) {
        var previousFocus = document.activeElement;

        var overlay = document.createElement('div');
        overlay.style.cssText =
            'position:fixed;top:0;left:0;right:0;bottom:0;z-index:100000;' +
            'background:rgba(0,0,0,0.45);display:flex;align-items:center;' +
            'justify-content:center;';

        var box = document.createElement('div');
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-labelledby', 'cpt-assoc-dialog-title');
        box.style.cssText =
            'background:#fff;border-radius:6px;padding:20px 24px;width:92%;' +
            'max-width:560px;max-height:80vh;overflow:auto;' +
            'color:' + CPTPanel.COLORS.text + ';font-size:0.9rem;' +
            'box-shadow:0 4px 24px rgba(0,0,0,0.3);';

        var title = document.createElement('h2');
        title.id = 'cpt-assoc-dialog-title';
        title.textContent = opts.title;
        title.style.cssText = 'font-size:1.15rem;margin:0 0 12px;';
        box.appendChild(title);

        box.appendChild(opts.body);

        var actions = document.createElement('div');
        actions.style.cssText =
            'display:flex;justify-content:flex-end;gap:8px;margin-top:18px;';

        function close() {
            document.removeEventListener('keydown', onKey, true);
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            if (previousFocus && previousFocus.focus) previousFocus.focus();
        }

        var cancelBtn = makeButton('Cancel', null, close);
        var confirmBtn = makeButton(opts.confirmLabel, null, function () {
            close();
            opts.onConfirm();
        });
        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);
        box.appendChild(actions);

        function onKey(e) {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
                return;
            }
            if (e.key === 'Tab') {
                // Two focusable controls; keep focus inside the dialog.
                var first = cancelBtn, last = confirmBtn;
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        }
        document.addEventListener('keydown', onKey, true);

        overlay.appendChild(box);
        document.body.appendChild(overlay);
        cancelBtn.focus();
    }

    // ── Automatic refresh ─────────────────────────────────────────────────────
    // A refresh would throw away unsaved edits, so it is skipped when Canvas's
    // rubric edit form (#edit_rubric_form, also what rubric-info.js watches) is
    // visible. A hidden template copy of the form must not count, hence the
    // layout-box test rather than a plain existence check.

    function editFormOpen() {
        var form = document.getElementById('edit_rubric_form');
        return !!form && form.getClientRects().length > 0;
    }

    // Returns true when a refresh was scheduled.
    function scheduleReload() {
        if (editFormOpen()) return false;
        setTimeout(function () { window.location.reload(); }, RELOAD_DELAY_MS);
        return true;
    }

    // ── Status panel ──────────────────────────────────────────────────────────
    // One panel in a stable host element, rebuilt on every state change.
    // opts: { snapshot, notice: {kind, text}, busyText, nextText, refresh,
    //         reloading, rows: [[label, node]], block: node }
    //   reloading hides the action buttons; rows/block add extra content.

    function getHost() {
        var host = document.getElementById(HOST_ID);
        if (host) return host;

        host = document.createElement('div');
        host.id = HOST_ID;
        host.setAttribute('aria-live', 'polite');

        var anchor = document.getElementById(INFO_WRAP_ID) ||
                     document.getElementById(OWN_WRAP_ID);
        if (anchor) {
            anchor.insertAdjacentElement('afterend', host);
        } else {
            var content = document.getElementById('content');
            if (!content) return null;
            content.insertAdjacentElement('afterbegin', host);
        }
        return host;
    }

    function clearPanel() {
        var host = document.getElementById(HOST_ID);
        if (host) host.textContent = '';
    }

    function noticeSegment(notice) {
        if (notice.kind === 'success') {
            return CPTPanel.segment(CPTPanel.COLORS.success,
                'icon-line icon-check', notice.text);
        }
        return CPTPanel.segment(CPTPanel.COLORS.warning,
            'icon-line icon-warning', notice.text);
    }

    function itemStatusCell(item) {
        if (item.restored) {
            return CPTPanel.segment(CPTPanel.COLORS.success,
                'icon-line icon-check', 'Restored');
        }
        if (item.error) {
            return CPTPanel.segment(CPTPanel.COLORS.warning,
                'icon-line icon-warning', 'Restore failed: ' + item.error);
        }
        return CPTPanel.segment(CPTPanel.COLORS.muted, null, 'Detached');
    }

    function renderPanel(opts) {
        var host = getHost();
        if (!host) return;
        host.textContent = '';

        var built = CPTPanel.makePanel('Rubric editing');
        var snapshot = opts.snapshot || null;

        if (opts.busyText) {
            var spinner = document.createElement('span');
            var icon = document.createElement('i');
            icon.className = 'icon-line icon-refresh ' + CPTPanel.SPIN_CLASS;
            icon.setAttribute('aria-hidden', 'true');
            spinner.appendChild(icon);
            spinner.appendChild(document.createTextNode(' ' + opts.busyText));
            built.addRow('Working', spinner);
            host.appendChild(built.panel);
            return;
        }

        if (snapshot) {
            var total = snapshot.items.length;
            var pending = snapshot.items.filter(function (i) {
                return !i.restored;
            }).length;

            built.addRow('Status', CPTPanel.segment(CPTPanel.COLORS.warning,
                'icon-line icon-warning',
                pending + ' of ' + total + ' assignment association' +
                (total === 1 ? '' : 's') + ' detached (saved ' +
                new Date(snapshot.savedAt).toLocaleString() + ')'));

            if (snapshot.keptAssignmentId != null) {
                built.addRow('Still attached', assignmentLink(
                    snapshot.keptAssignmentId, snapshot.keptName));
            }
        }

        if (opts.notice) {
            built.addRow('Result', noticeSegment(opts.notice));
        }

        if (opts.rows) {
            opts.rows.forEach(function (r) { built.addRow(r[0], r[1]); });
        }

        if (opts.nextText) {
            built.addRow('Next', document.createTextNode(opts.nextText));
        }

        if (opts.block) {
            built.addBlock(opts.block);
        }

        if (snapshot) {
            var rows = snapshot.items.map(function (item) {
                return [assignmentLink(item.association_id, item.name),
                        itemStatusCell(item)];
            });
            built.addBlock(CPTPanel.makeTable(
                ['Assignment', 'State'], rows,
                'Detached assignments'));

            if (!opts.reloading) {
                var actions = document.createElement('div');
                actions.style.cssText =
                    'display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;';
                actions.appendChild(makeButton('Restore associations',
                    'icon-refresh', function () { runRestore(snapshot); },
                    'Button--primary'));
                actions.appendChild(makeButton('Refresh page', 'icon-refresh',
                    function () { window.location.reload(); }));
                actions.appendChild(makeButton('Discard snapshot', null,
                    function () { confirmDiscard(snapshot); }));
                built.addBlock(actions);
            }
        } else if (opts.refresh) {
            var refreshRow = document.createElement('div');
            refreshRow.style.cssText = 'margin-top:6px;';
            refreshRow.appendChild(makeButton('Refresh page', 'icon-refresh',
                function () { window.location.reload(); }));
            built.addBlock(refreshRow);
        }

        host.appendChild(built.panel);
    }

    // ── Step 1: unlock (detach all but the first) ─────────────────────────────

    function buildUnlockDialogBody(assocs, info) {
        var names = info.names;
        var body = document.createElement('div');

        var intro = document.createElement('p');
        intro.style.cssText = 'margin:0 0 10px;';
        intro.textContent =
            'This rubric is attached to ' + assocs.length + ' assignments. ' +
            'To make it editable, every assignment except the first will be ' +
            'detached from it. Afterwards, refresh the page to get the Edit ' +
            'button, make your changes, then use "Restore associations".';
        body.appendChild(intro);

        var rows = assocs.map(function (a, index) {
            var state = index === 0
                ? CPTPanel.segment(CPTPanel.COLORS.success,
                    'icon-line icon-check', 'Stays attached')
                : CPTPanel.segment(CPTPanel.COLORS.warning,
                    'icon-line icon-warning', 'Will be detached');
            return [assignmentLink(a.association_id, names[a.association_id]),
                    fmtPoints(info.points[a.association_id]),
                    state];
        });
        var table = CPTPanel.makeTable(
            ['Assignment', 'Points now', 'Action'], rows);
        table.style.marginBottom = '10px';
        body.appendChild(table);

        var caution = document.createElement('p');
        caution.style.cssText =
            'margin:0;color:' + CPTPanel.COLORS.warning + ';';
        caution.textContent =
            'Restoring creates new associations. After restoring, check that ' +
            'rubric scores on the affected assignments still appear.';
        body.appendChild(caution);

        return body;
    }

    function startUnlock() {
        if (busy) return;
        busy = true;
        renderPanel({ busyText: 'Loading associations…' });

        Promise.all([fetchAssignmentAssociations(), fetchAssignmentInfo()])
            .then(function (results) {
                var assocs = results[0];
                var info = results[1];
                busy = false;
                clearPanel();

                if (assocs.length < 2) {
                    renderPanel({ notice: { kind: 'warning', text:
                        'This rubric is attached to ' + assocs.length +
                        ' assignment' + (assocs.length === 1 ? '' : 's') +
                        '. Nothing to detach.' } });
                    return;
                }

                openDialog({
                    title: 'Unlock rubric for editing',
                    body: buildUnlockDialogBody(assocs, info),
                    confirmLabel: 'Detach ' + (assocs.length - 1) +
                                  ' assignment' +
                                  (assocs.length - 1 === 1 ? '' : 's'),
                    onConfirm: function () { runUnlock(assocs, info); }
                });
            })
            .catch(function (error) {
                busy = false;
                renderPanel({ notice: { kind: 'warning',
                    text: 'Could not load associations: ' + error.message } });
            });
    }

    function runUnlock(assocs, info) {
        if (busy) return;
        busy = true;

        var names = info.names;
        var points = info.points;
        var kept = assocs[0];
        var toDetach = assocs.slice(1);

        var snapshot = {
            savedAt:           new Date().toISOString(),
            courseId:          courseId,
            rubricId:          rubricId,
            keptAssignmentId:  kept.association_id,
            keptName:          names[kept.association_id] || null,
            keptPoints:        points[kept.association_id] != null
                                   ? points[kept.association_id] : null,
            items: toDetach.map(function (a) {
                return {
                    recordId:             a.id,
                    association_id:       a.association_id,
                    association_type:     a.association_type,
                    use_for_grading:      a.use_for_grading,
                    hide_score_total:     a.hide_score_total,
                    hide_points:          a.hide_points,
                    hide_outcome_results: a.hide_outcome_results,
                    purpose:              a.purpose,
                    name:                 names[a.association_id] || null,
                    // Points the assignment had before the rubric was edited,
                    // for the comparison shown after restore.
                    points:               points[a.association_id] != null
                                              ? points[a.association_id] : null
                };
            })
        };

        renderPanel({ busyText: 'Saving snapshot…' });

        // The snapshot is written BEFORE the first delete. If this write fails,
        // nothing has been changed in Canvas yet.
        writeSnapshot(snapshot)
            .then(function () {
                var chain = Promise.resolve();
                snapshot.items.forEach(function (item, index) {
                    chain = chain.then(function () {
                        renderPanel({ busyText: 'Detaching assignment ' +
                            (index + 1) + ' of ' + snapshot.items.length + '…' });
                        return deleteAssociation(item.recordId);
                    });
                });
                return chain;
            })
            .then(function () {
                busy = false;
                hideUnlockButton();

                var reloading = scheduleReload();
                renderPanel({
                    snapshot: snapshot,
                    reloading: reloading,
                    notice: { kind: 'success', text:
                        'All ' + snapshot.items.length + ' associations detached.' },
                    nextText: reloading
                        ? 'Refreshing the page so Canvas shows the Edit ' +
                          'button. Then make your changes and click ' +
                          '"Restore associations".'
                        : 'The rubric edit form is open, so the page was ' +
                          'not refreshed. Refresh it yourself when ready to ' +
                          'get the Edit button, then click "Restore ' +
                          'associations" after your changes.'
                });
            })
            .catch(function (error) {
                // The snapshot already lists every intended detach. Restore
                // skips any that are still attached, so this state is safe.
                busy = false;
                hideUnlockButton();
                renderPanel({
                    snapshot: snapshot,
                    notice: { kind: 'warning', text:
                        'Stopped early: ' + error.message + '. Some ' +
                        'assignments may still be attached.' },
                    nextText: 'Use "Restore associations" to put back anything ' +
                        'that was detached.'
                });
            });
    }

    // ── Step 2: restore ───────────────────────────────────────────────────────

    function runRestore(snapshot) {
        if (busy) return;
        busy = true;
        renderPanel({ busyText: 'Checking current associations…' });

        fetchAssignmentAssociations()
            .then(function (current) {
                var present = {};
                current.forEach(function (a) { present[a.association_id] = true; });

                var chain = Promise.resolve();
                snapshot.items.forEach(function (item, index) {
                    chain = chain.then(function () {
                        if (item.restored) return null;

                        // Already attached (never detached, or restored by an
                        // earlier attempt): nothing to create.
                        if (present[item.association_id]) {
                            item.restored = true;
                            delete item.error;
                            return writeSnapshot(snapshot);
                        }

                        renderPanel({ busyText: 'Restoring assignment ' +
                            (index + 1) + ' of ' + snapshot.items.length + '…' });
                        return createAssociation(item)
                            .then(function () {
                                item.restored = true;
                                delete item.error;
                            })
                            .catch(function (error) {
                                item.error = error.message;
                            })
                            .then(function () {
                                return writeSnapshot(snapshot);
                            });
                    });
                });
                return chain;
            })
            .then(function () {
                busy = false;
                var failed = snapshot.items.filter(function (i) {
                    return !i.restored;
                });

                if (failed.length === 0) {
                    var note = buildNote(snapshot);

                    // Edit form open: do not refresh. Show the live check now.
                    if (editFormOpen()) {
                        return writeSnapshot(null).then(function () {
                            return showVerification(note, true);
                        });
                    }

                    return writeSnapshot(null)
                        .then(function () {
                            // The note lets the refreshed page confirm the
                            // result from live data. Losing it only loses that
                            // confirmation, so a failed write is not fatal.
                            return saveNotice(note).catch(function () {});
                        })
                        .then(function () {
                            scheduleReload();
                            renderPanel({
                                notice: { kind: 'success', text:
                                    'All ' + snapshot.items.length +
                                    ' associations restored.' },
                                nextText: 'Refreshing the page to confirm ' +
                                    'the rubric is attached again and to ' +
                                    'check assignment points.'
                            });
                        });
                }

                renderPanel({
                    snapshot: snapshot,
                    notice: { kind: 'warning', text:
                        failed.length + ' of ' + snapshot.items.length +
                        ' could not be restored. Click "Restore associations" ' +
                        'to retry.' }
                });
            })
            .catch(function (error) {
                busy = false;
                renderPanel({
                    snapshot: snapshot,
                    notice: { kind: 'warning', text:
                        'Restore stopped: ' + error.message }
                });
            });
    }

    function confirmDiscard(snapshot) {
        var body = document.createElement('p');
        body.style.cssText = 'margin:0;';
        body.textContent =
            'This forgets the saved list of detached assignments. Assignments ' +
            'that have not been restored will stay detached from this rubric, ' +
            'and this tool will no longer be able to put them back.';

        openDialog({
            title: 'Discard snapshot?',
            body: body,
            confirmLabel: 'Discard snapshot',
            onConfirm: function () {
                writeSnapshot(null)
                    .then(function () {
                        renderPanel({ notice: { kind: 'warning',
                            text: 'Snapshot discarded.' } });
                        syncUnlockButton();
                    })
                    .catch(function (error) {
                        renderPanel({ snapshot: snapshot, notice: {
                            kind: 'warning', text:
                            'Could not discard: ' + error.message } });
                    });
            }
        });
    }

    // ── Unlock button ─────────────────────────────────────────────────────────
    // Shown only when there is something to unlock: no saved snapshot for this
    // rubric AND more than one Assignment association right now.

    function ensureUnlockButton() {
        var existing = document.getElementById(BTN_ID);
        if (existing) return existing;

        var wrap = document.getElementById(INFO_WRAP_ID);
        if (!wrap) {
            var content = document.getElementById('content');
            if (!content) return null;
            CPTPanel.ensureStyle();
            wrap = document.createElement('div');
            wrap.id = OWN_WRAP_ID;
            wrap.style.cssText = 'margin:10px 0;';
            content.insertAdjacentElement('afterbegin', wrap);
        }

        var btn = makeButton('Unlock rubric for editing', 'icon-edit',
            startUnlock);
        btn.id = BTN_ID;
        btn.title = 'Detach this rubric from all but one assignment so ' +
                    'Canvas allows editing it';
        btn.style.marginLeft = INFO_WRAP_ID === wrap.id ? '8px' : '0';
        btn.style.display = 'none';
        wrap.appendChild(btn);
        return btn;
    }

    function hideUnlockButton() {
        var btn = document.getElementById(BTN_ID);
        if (btn) btn.style.display = 'none';
    }

    function syncUnlockButton() {
        var btn = ensureUnlockButton();
        if (!btn) return Promise.resolve();

        return readSnapshot()
            .then(function (snapshot) {
                if (snapshot) {
                    btn.style.display = 'none';
                    return;
                }
                return fetchAssignmentAssociations().then(function (assocs) {
                    btn.style.display = assocs.length > 1 ? '' : 'none';
                });
            })
            .catch(function (error) {
                console.warn('[CPT] rubric-assoc-editor: ' + error.message);
                btn.style.display = 'none';
            });
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    // Every assignment that should be attached after Restore, with the points
    // it had at detach time.
    function buildNote(snapshot) {
        function norm(p) { return p == null ? null : p; }
        var rows = [{ id: snapshot.keptAssignmentId,
                      name: snapshot.keptName,
                      before: norm(snapshot.keptPoints) }];
        snapshot.items.forEach(function (item) {
            rows.push({ id: item.association_id, name: item.name,
                        before: norm(item.points) });
        });
        return { at: Date.now(), expected: rows.length, rows: rows };
    }

    function pointsCheckCell(state) {
        if (state === 'changed') {
            return CPTPanel.segment(CPTPanel.COLORS.warning,
                'icon-line icon-warning', 'Changed');
        }
        if (state === 'same') {
            return CPTPanel.segment(CPTPanel.COLORS.success,
                'icon-line icon-check', 'Same');
        }
        return CPTPanel.segment(CPTPanel.COLORS.muted, null, 'Unavailable');
    }

    // Confirms from live data that the rubric is attached again and compares
    // each assignment's points with what it had before. Shown after the
    // automatic refresh that follows Restore (or immediately, when the edit
    // form was open and no refresh happened - formOpen).
    function showVerification(note, formOpen) {
        return Promise.all([fetchAssignmentAssociations(),
                            fetchAssignmentInfo()])
            .then(function (results) {
                var assocs = results[0];
                var info = results[1];

                var n = assocs.length;
                var label = n + ' assignment' + (n === 1 ? '' : 's');
                var countNotice = (n >= note.expected)
                    ? { kind: 'success', text:
                        'Restored. This rubric is attached to ' + label + '.' }
                    : { kind: 'warning', text:
                        'Expected ' + note.expected + ' assignments but this ' +
                        'rubric is attached to ' + label + '.' };

                var changed = 0, unknown = 0;
                var tableRows = (note.rows || []).map(function (row) {
                    var now = info.points[row.id];
                    var state = comparePoints(row.before, now);
                    if (state === 'changed') changed++;
                    if (state === 'unknown') unknown++;
                    return [assignmentLink(row.id,
                                info.names[row.id] || row.name),
                            fmtPoints(row.before),
                            fmtPoints(now == null ? null : now),
                            pointsCheckCell(state)];
                });

                var total = tableRows.length;
                var summary;
                if (changed > 0) {
                    summary = CPTPanel.segment(CPTPanel.COLORS.warning,
                        'icon-line icon-warning',
                        'Points changed on ' + changed + ' of ' + total +
                        ' assignment' + (total === 1 ? '' : 's') +
                        '. Verify these in each assignment.');
                } else if (unknown > 0) {
                    summary = CPTPanel.segment(CPTPanel.COLORS.warning,
                        'icon-line icon-warning',
                        'Could not compare points on ' + unknown + ' of ' +
                        total + ' assignment' + (total === 1 ? '' : 's') +
                        '. Check them in each assignment.');
                } else {
                    summary = CPTPanel.segment(CPTPanel.COLORS.success,
                        'icon-line icon-check',
                        'Points unchanged on all ' + total + ' assignment' +
                        (total === 1 ? '' : 's') + '.');
                }

                renderPanel({
                    notice:   countNotice,
                    rows:     tableRows.length ? [['Points', summary]] : null,
                    nextText: formOpen
                        ? 'The rubric edit form is open, so the page was ' +
                          'not refreshed. Refresh it yourself once your ' +
                          'edits are saved.'
                        : null,
                    block:    tableRows.length
                        ? CPTPanel.makeTable(
                            ['Assignment', 'Points before', 'Points now',
                             'Check'], tableRows, 'Assignment points')
                        : null,
                    refresh:  !!formOpen
                });
                if (formOpen) syncUnlockButton();
            })
            .catch(function (error) {
                renderPanel({ notice: { kind: 'warning', text:
                    'Could not verify the restored associations: ' +
                    error.message } });
            });
    }

    function init() {
        Promise.all([readSnapshot(), takeNotice()])
            .then(function (results) {
                var snapshot = results[0];
                var note = results[1];

                if (snapshot) {
                    var pending = snapshot.items.filter(function (i) {
                        return !i.restored;
                    }).length;
                    renderPanel({
                        snapshot: snapshot,
                        nextText: pending > 0
                            ? 'Edit the rubric, then click "Restore ' +
                              'associations". The page refreshes by itself ' +
                              'afterwards.'
                            : null
                    });
                    return syncUnlockButton();
                }

                if (note) {
                    return showVerification(note, false).then(syncUnlockButton);
                }
                return syncUnlockButton();
            })
            .catch(function (error) {
                console.warn('[CPT] rubric-assoc-editor: ' + error.message);
            });
    }

    init();

})();

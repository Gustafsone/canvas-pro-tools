// Canvas Pro-Tools — Rubric Checkpoint Mapper
// Injected on: /courses/*/rubrics, /courses/*/rubrics/*, /courses/*/discussion_topics/*
//
// Index page      : adds "✓ Checkpoint mapped" badge to each rubric's .details span
// Detail page     : injects mapping pills onto each criterion row
// Discussion page : fetches topic API, checks is_checkpointed, then injects pills
//                   onto the lazily-loaded rubric panel via MutationObserver

(function () {
    'use strict';

    const MAPPINGS_KEY = 'cpt_checkpoint_mappings';
    const FEATURES_KEY = 'cpt_features';

    const CHECKPOINT_OPTIONS = [
        { value: 'reply_to_topic', label: 'Reply to Topic' },
        { value: 'reply_to_entry', label: 'Required Replies' },
        { value: 'ignore',         label: 'Ignore' },
    ];

    const PILL_STYLES = {
        reply_to_topic: { bg: '#e8f0fe', border: '#6d9eeb', text: '#1a56a0' },
        reply_to_entry: { bg: '#fce8b2', border: '#e6a817', text: '#7a4f00' },
        ignore:         { bg: '#f1f3f4', border: '#c7cdd1', text: '#6b7c8b' },
        unassigned:     { bg: '#fff3cd', border: '#f0ad4e', text: '#856404' },
    };

    // ── GUARD ─────────────────────────────────────────────────────────────────

    chrome.storage.local.get(FEATURES_KEY, function (result) {
        // cpt_features is namespaced per Canvas instance (hostname), with a
        // legacy flat-shape fallback until popup.js migrates it on disk.
        const allFeatures = (result && result[FEATURES_KEY]) || {};
        const featLegacy  = Object.keys(allFeatures).some(k => typeof allFeatures[k] === 'boolean');
        const features = featLegacy ? allFeatures : (allFeatures[window.location.hostname] || {});
        const enabled  = typeof features.checkpointMapper === 'boolean'
            ? features.checkpointMapper : false;
        if (!enabled) return;

        const path         = window.location.pathname;
        const isDetail     = /\/courses\/\d+\/rubrics\/\d+/.test(path);
        const isIndex      = /\/courses\/\d+\/rubrics$/.test(path);
        const isDiscussion = /\/courses\/\d+\/discussion_topics\/\d+/.test(path);

        if (isDetail)          initDetailPage();
        else if (isIndex)      initIndexPage();
        else if (isDiscussion) initDiscussionPage();
    });

    // ── STORAGE ───────────────────────────────────────────────────────────────
    // cpt_checkpoint_mappings is namespaced per Canvas instance (hostname),
    // same shape checkpoint-mapper.js uses:
    // { "<hostname>": { "<rubricId>": {
    //     criteria: { "<criterionId>": { assign, index } },
    //     courseId, courseName, rubricName, createdAt } } }
    // _mappings holds the slice for THIS instance only.
    //
    // v3.7.0: criteria are keyed by CRITERION ID, not by DOM row index.
    // The API and both DOM surfaces share one ID space:
    //   API "_1033" -> SpeedGrader "criterion-score-_1033"
    //                -> classic rubric row id "criterion__1033"
    // (The long-noted "double underscore" is just the criterion_ prefix plus an
    // ID that itself starts with "_".)
    //
    // Index-keying wasn't merely fragile — it was already wrong here. Canvas
    // renders a hidden template row (criterion_1, "Description of criterion")
    // that does NOT carry .blank, so getRealCriterionRows() returned 3 rows for
    // a 2-criterion rubric: a pill was injected onto a criterion that doesn't
    // exist, and completeness could never be satisfied. Validating rows against
    // the API criteria list removes it by construction.
    //
    // `index` is stored as metadata only (display ordering, debugging) — it is
    // never used as a key.

    const INSTANCE_KEY = window.CPT_INSTANCE_KEY || window.location.hostname;

    let _mappings = {};

    // Authoritative criteria per rubric, from the API: { "<rubricId>": [{id, index, description}] }
    // The API decides which criteria exist; the DOM is only where pills are drawn.
    let _criteria = {};

    // True if `entry` looks like a rubric mapping entry (has .criteria),
    // as opposed to a stray non-entry key (e.g. a hostname key that ended
    // up nested here from the pre-namespacing flat-write bug).
    function isRubricEntry(entry) {
        return !!(entry && typeof entry === 'object' && entry.criteria);
    }

    function loadMappings(cb) {
        chrome.storage.local.get(MAPPINGS_KEY, function (result) {
            const raw           = (result && result[MAPPINGS_KEY]) || {};
            const instanceSlice = raw[INSTANCE_KEY] || {};

            // Self-heal: drop anything that isn't a real rubric entry so
            // stray/corrupted keys don't get re-saved on the next write.
            //
            // NOTE: pre-3.7.0 index-keyed entries still pass isRubricEntry (they
            // have .criteria) but hold string values rather than {assign, index}
            // objects. No migration is performed — 3.7.0 is a deliberate clean
            // break. getCriterionAssign() returns null for the old shape, so
            // stale data degrades to "unassigned" instead of throwing.
            const cleaned = {};
            Object.keys(instanceSlice).forEach(function (rubricId) {
                if (isRubricEntry(instanceSlice[rubricId])) cleaned[rubricId] = instanceSlice[rubricId];
            });

            _mappings = cleaned;
            if (cb) cb();
        });
    }

    function saveMappings(cb) {
        chrome.storage.local.get(MAPPINGS_KEY, function (result) {
            const all = (result && result[MAPPINGS_KEY]) || {};
            all[INSTANCE_KEY] = _mappings;
            chrome.storage.local.set({ [MAPPINGS_KEY]: all }, cb);
        });
    }

    function getRubricMapping(rubricId) {
        const entry = _mappings[rubricId];
        return (entry && entry.criteria) ? entry.criteria : {};
    }

    // Read a criterion's assignment by criterion ID. Returns null for unmapped
    // criteria and for pre-3.7.0 string-valued entries.
    function getCriterionAssign(rubricId, criterionId) {
        const c = getRubricMapping(rubricId)[criterionId];
        return (c && typeof c === 'object' && c.assign) ? c.assign : null;
    }

    // True if any criterion is mapped to an actual checkpoint (not "ignore").
    // Shared by the index-page badge and the Clear button's enabled state.
    function hasRealAssignment(entry) {
        if (!entry || !entry.criteria) return false;
        return Object.values(entry.criteria).some(function (v) {
            return v && typeof v === 'object' && v.assign && v.assign !== 'ignore';
        });
    }

    // ── UTILS ─────────────────────────────────────────────────────────────────

    function getCourseId() {
        const m = window.location.pathname.match(/\/courses\/(\d+)/);
        return m ? m[1] : '';
    }

    // Course code, resolved once from the API during init and cached, so
    // detectCourseName() can stay synchronous for saveCriterionMapping().
    //
    // Breadcrumbs still exist on these (classic) pages, but checkpoint-mapper.js
    // must use the API — the new SpeedGrader renders no breadcrumbs at all. Both
    // files write courseName into the same storage entry, so they source it the
    // same way; otherwise whichever surface mapped first would decide whether the
    // popup showed a course code or breadcrumb text for that rubric.
    //
    // course_code verified present on the live API; short_name is NOT a course
    // field (it belongs to the user object).
    let _courseCode = null;

    function fetchCourseCode(courseId) {
        return fetch('/api/v1/courses/' + courseId, { credentials: 'same-origin' })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (c) {
                _courseCode = c.course_code || c.name || null;
                return _courseCode;
            })
            .catch(function (err) {
                console.warn('[CPT] course fetch failed:', err);
                return null;
            });
    }

    function detectCourseName() {
        if (_courseCode) return _courseCode;
        // Breadcrumb fallback: only reached if the course fetch failed.
        const crumb = document.querySelector('#breadcrumbs li:nth-child(2) a');
        if (crumb && crumb.textContent.trim()) return crumb.textContent.trim();
        return getCourseId() ? 'Course ' + getCourseId() : 'Unknown Course';
    }

    function getRubricIdFromDetail() {
        const candidates = document.querySelectorAll('[id^="rubric_"]');
        for (const el of candidates) {
            const m = /^rubric_(\d+)$/.exec(el.id);
            if (m) return m[1];
        }
        return null;
    }

    function getRubricNameFromDetail(rubricId) {
        const container = rubricId
            ? document.getElementById('rubric_' + rubricId)
            : document.querySelector('.rubric_container.rubric:not(#default_rubric)');
        if (!container) return null;
        const titleEl = container.querySelector('.rubric_title .displaying .title');
        return titleEl ? titleEl.textContent.trim() : null;
    }

    // Scoped to a root element to exclude hidden template containers.
    // Matches candidate criterion rows, excluding Canvas's hidden template
    // row (tr.criterion.blank). Previously filtered by a regex on the row
    // id (criterion__NNNN), but that broke on Learning-Outcome-aligned
    // criteria, whose ids use a two-segment numeric suffix
    // (e.g. criterion_78667_7041) that the old regex couldn't match.
    //
    // NOTE: this is NOT sufficient on its own. Canvas also renders a template
    // row (id "criterion_1", description "Description of criterion") that does
    // NOT carry .blank and therefore survives this filter. Callers must validate
    // against the API criteria list — see getMappableRows().
    function getRealCriterionRows(root) {
        root = root || document;
        return Array.from(root.querySelectorAll('tr.criterion:not(.blank)'));
    }

    // Extract the criterion ID from a row's DOM id.
    // "criterion__1033" -> "_1033"  (prefix "criterion_" + API id "_1033")
    // Returns null for rows with no usable id.
    function getCriterionIdFromRow(row) {
        if (!row || !row.id) return null;
        const m = /^criterion_(.+)$/.exec(row.id);
        return m ? m[1] : null;
    }

    // Rows that correspond to real, API-known criteria, paired with their ID
    // and canonical index. This is what removes the phantom template row: its
    // id ("criterion_1" -> "1") is not in the API criteria list, so it's dropped.
    function getMappableRows(rubricId, root) {
        const criteria = _criteria[rubricId] || [];
        if (!criteria.length) return [];

        const byId = {};
        criteria.forEach(function (c) { byId[c.id] = c; });

        const out = [];
        getRealCriterionRows(root).forEach(function (row) {
            const cid = getCriterionIdFromRow(row);
            if (!cid || !byId[cid]) return; // phantom/template row, or not in this rubric
            out.push({ row: row, criterionId: cid, index: byId[cid].index });
        });
        return out;
    }

    // Fetch a rubric's criteria from the API and cache them.
    // The detail page has no other source for the authoritative criteria list;
    // the discussion page already has it from the topic API and calls
    // setCriteria() directly instead.
    function fetchRubricCriteria(courseId, rubricId) {
        return fetch('/api/v1/courses/' + courseId + '/rubrics/' + rubricId, {
            credentials: 'same-origin',
        })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (rub) {
                setCriteria(rubricId, rub.data || []);
                return _criteria[rubricId];
            })
            .catch(function (err) {
                console.warn('[CPT] rubric criteria fetch failed:', err);
                return null;
            });
    }

    // Normalise an API criteria array into the cache shape.
    function setCriteria(rubricId, apiCriteria) {
        _criteria[rubricId] = (apiCriteria || []).map(function (c, i) {
            return { id: c.id, index: i, description: c.description || '' };
        });
    }

    // ── TOAST ─────────────────────────────────────────────────────────────────

    let _toastTimer = null;

    function showToast(msg, duration) {
        duration = duration || 2500;
        let toast = document.getElementById('cpt-rubric-mapper-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'cpt-rubric-mapper-toast';
            toast.style.cssText = [
                'position: fixed',
                'bottom: 24px',
                'left: 50%',
                'transform: translateX(-50%)',
                'background: #2d3b45',
                'color: #fff',
                'font-family: Lato, sans-serif',
                'font-size: 12px',
                'padding: 7px 16px',
                'border-radius: 4px',
                'box-shadow: 0 2px 8px rgba(0,0,0,0.25)',
                'z-index: 999999',
                'pointer-events: none',
                'opacity: 0',
                'transition: opacity 0.2s ease',
                'white-space: nowrap',
            ].join(';');
            document.body.appendChild(toast);
        }
        toast.textContent   = msg;
        toast.style.opacity = '1';
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(function () { toast.style.opacity = '0'; }, duration);
    }

    // ── PILL BUILDER ──────────────────────────────────────────────────────────

    function buildPill(rubricId, criterionId, criterionIndex, currentValue) {
        const wrap = document.createElement('span');
        wrap.className     = 'cpt-mapper-pill-wrap';
        wrap.style.cssText = 'display:inline-block;margin-top:5px;position:relative;';

        const pill = document.createElement('button');
        pill.type = 'button';
        pill.dataset.rubricId       = rubricId;
        pill.dataset.criterionId    = criterionId;
        pill.dataset.criterionIndex = criterionIndex;
        pill.className = 'cpt-mapper-pill';

        updatePillAppearance(pill, currentValue);

        pill.addEventListener('click', function (e) {
            e.stopPropagation();
            openPillDropdown(pill, rubricId, criterionId, criterionIndex);
        });

        wrap.appendChild(pill);
        return wrap;
    }

    function updatePillAppearance(pill, value) {
        const styleKey = value || 'unassigned';
        const s        = PILL_STYLES[styleKey] || PILL_STYLES.unassigned;
        const option   = CHECKPOINT_OPTIONS.find(function (o) { return o.value === value; });
        const label    = option ? option.label : 'Unassigned';

        pill.textContent = label + ' ▾';
        pill.style.cssText = [
            'display: inline-flex',
            'align-items: center',
            'gap: 4px',
            'padding: 2px 7px',
            'font-size: 10px',
            'font-family: Lato, sans-serif',
            'font-weight: 600',
            'border-radius: 10px',
            'background: ' + s.bg,
            'border: 1px solid ' + s.border,
            'color: ' + s.text,
            'cursor: pointer',
            'white-space: nowrap',
            'line-height: 1.6',
        ].join(';');
    }

    // ── PILL DROPDOWN ─────────────────────────────────────────────────────────

    let _activePillDropdown = null;

    function closePillDropdown() {
        if (_activePillDropdown) {
            _activePillDropdown.remove();
            _activePillDropdown = null;
        }
    }

    function openPillDropdown(pill, rubricId, criterionId, criterionIndex) {
        closePillDropdown();

        const dropdown = document.createElement('div');
        dropdown.style.cssText = [
            'position: absolute',
            'top: calc(100% + 3px)',
            'left: 0',
            'background: #fff',
            'border: 1px solid #c7cdd1',
            'border-radius: 4px',
            'box-shadow: 0 2px 8px rgba(0,0,0,0.18)',
            'z-index: 999999',
            'font-family: Lato, sans-serif',
            'font-size: 12px',
            'min-width: 150px',
            'overflow: hidden',
        ].join(';');

        const currentValue = getCriterionAssign(rubricId, criterionId);

        CHECKPOINT_OPTIONS.forEach(function (opt) {
            const item      = document.createElement('div');
            const isCurrent = opt.value === currentValue;
            item.style.cssText = [
                'padding: 7px 12px',
                'cursor: pointer',
                'display: flex',
                'align-items: center',
                'gap: 8px',
                isCurrent ? 'background: #e8f0fe; font-weight: bold;' : '',
            ].join(';');
            item.textContent = opt.label;

            item.addEventListener('mouseenter', function () {
                if (!isCurrent) item.style.background = '#f0f4ff';
            });
            item.addEventListener('mouseleave', function () {
                if (!isCurrent) item.style.background = '';
            });
            item.addEventListener('click', function (e) {
                e.stopPropagation();
                saveCriterionMapping(rubricId, criterionId, criterionIndex, opt.value);
                updatePillAppearance(pill, opt.value);
                closePillDropdown();
            });

            dropdown.appendChild(item);
        });

        pill.parentElement.style.position = 'relative';
        pill.parentElement.appendChild(dropdown);
        _activePillDropdown = dropdown;

        setTimeout(function () {
            document.addEventListener('click', closePillDropdown, { once: true });
        }, 0);
        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape') {
                closePillDropdown();
                document.removeEventListener('keydown', escHandler);
            }
        });
    }

    // ── SAVE ──────────────────────────────────────────────────────────────────

    // _discussionRubricMeta is populated by initDiscussionPage() so that
    // saveCriterionMapping() has rubricName available without a DOM scrape.
    let _discussionRubricMeta = null;

    function saveCriterionMapping(rubricId, criterionId, criterionIndex, value) {
        if (!_mappings[rubricId]) {
            const courseId   = getCourseId();
            const courseName = detectCourseName();
            // Use API-sourced name (discussion page) if available, else scrape DOM (detail page)
            const rubricName = (_discussionRubricMeta && _discussionRubricMeta.rubricId === rubricId)
                ? _discussionRubricMeta.rubricName
                : (getRubricNameFromDetail(rubricId) || 'Rubric #' + rubricId);
            const createdAt  = new Date().toISOString().slice(0, 10);
            _mappings[rubricId] = { criteria: {}, courseId, courseName, rubricName, createdAt };
        }
        // Keyed by criterion ID; index kept as metadata only.
        _mappings[rubricId].criteria[criterionId] = { assign: value, index: criterionIndex };
        saveMappings(function () {
            showToast('Checkpoint mapping saved');
            const clearBtn = document.getElementById('cpt-mapping-clear-btn');
            if (clearBtn) {
                const hasAny = Object.keys(_mappings[rubricId].criteria).length > 0;
                if (hasAny) {
                    clearBtn.removeAttribute('disabled');
                } else {
                    clearBtn.setAttribute('disabled', 'disabled');
                }
            }
        });
    }

    // ── SHARED INJECTION ──────────────────────────────────────────────────────

    // Iterates API-validated rows rather than raw DOM rows, so Canvas's template
    // row (criterion_1, "Description of criterion" — which does not carry .blank)
    // can no longer receive a pill.
    function injectCriterionPills(rubricId, root) {
        getMappableRows(rubricId, root).forEach(function (entry) {
            const row = entry.row;
            if (row.querySelector('.cpt-mapper-pill-wrap')) return;

            const descCell = row.querySelector('td.criterion_description');
            if (!descCell) return;

            const currentValue = getCriterionAssign(rubricId, entry.criterionId);
            const pillWrap     = buildPill(rubricId, entry.criterionId, entry.index, currentValue);

            const insertAfter = descCell.querySelector('.long_description')
                || descCell.querySelector('.description.description_title');

            if (insertAfter && insertAfter.parentNode) {
                insertAfter.parentNode.insertBefore(pillWrap, insertAfter.nextSibling);
            } else {
                const content = descCell.querySelector('.description_content');
                if (content) content.appendChild(pillWrap);
            }
        });
    }

    function showClearConfirmDialog(rubricId, clearBtn) {
        // Remove any existing dialog first
        const existing = document.getElementById('cpt-clear-dialog-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'cpt-clear-dialog-overlay';
        overlay.style.cssText = [
            'position: fixed',
            'inset: 0',
            'background: rgba(0,0,0,0.5)',
            'z-index: 9999999',
            'display: flex',
            'align-items: center',
            'justify-content: center',
        ].join(';');

        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'cpt-dialog-title');
        dialog.style.cssText = [
            'background: #fff',
            'border: 1px solid #c7cdd1',
            'border-radius: 4px',
            'width: 320px',
            'font-family: Lato, sans-serif',
            'overflow: hidden',
        ].join(';');

        // ── Header ──
        const header = document.createElement('div');
        header.style.cssText = [
            'background: #f5f5f5',
            'border-bottom: 1px solid #c7cdd1',
            'padding: 10px 14px',
            'display: flex',
            'align-items: center',
            'justify-content: space-between',
        ].join(';');

        const title = document.createElement('span');
        title.id          = 'cpt-dialog-title';
        title.textContent = 'Clear checkpoint mapping?';
        title.style.cssText = 'font-size:13px;font-weight:700;color:#2d3b45;';

        const closeBtn = document.createElement('button');
        closeBtn.type      = 'button';
        closeBtn.innerHTML = '&#x2715;';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.style.cssText = [
            'background: none',
            'border: none',
            'cursor: pointer',
            'color: #6b7c8b',
            'font-size: 16px',
            'padding: 0',
            'line-height: 1',
        ].join(';');

        header.appendChild(title);
        header.appendChild(closeBtn);

        // ── Body ──
        const body = document.createElement('div');
        body.style.cssText = 'padding:14px;font-size:13px;color:#2d3b45;line-height:1.5;';

        const msg = document.createElement('p');
        msg.style.cssText  = 'margin:0 0 8px;';
        msg.textContent    = 'Are you sure you want to clear the checkpoint mapping for this rubric?';

        const warning = document.createElement('div');
        warning.style.cssText = [
            'font-size: 11px',
            'color: #8a6d3b',
            'background: #fcf8e3',
            'border: 1px solid #faebcc',
            'border-radius: 3px',
            'padding: 6px 10px',
        ].join(';');
        warning.textContent = '\u26A0 This cannot be undone.';

        body.appendChild(msg);
        body.appendChild(warning);

        // ── Footer ──
        const foot = document.createElement('div');
        foot.style.cssText = [
            'padding: 10px 14px',
            'border-top: 1px solid #e8e8e8',
            'display: flex',
            'justify-content: flex-end',
            'gap: 8px',
        ].join(';');

        const noBtn = document.createElement('button');
        noBtn.type      = 'button';
        noBtn.className = 'btn btn-default';
        noBtn.textContent = 'No';

        const yesBtn = document.createElement('button');
        yesBtn.type      = 'button';
        yesBtn.className = 'btn btn-default';
        yesBtn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;';
        yesBtn.innerHTML = '<i class="icon-trash" aria-hidden="true"></i> Yes, clear it';

        foot.appendChild(noBtn);
        foot.appendChild(yesBtn);

        dialog.appendChild(header);
        dialog.appendChild(body);
        dialog.appendChild(foot);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Focus the No button by default — safer choice gets focus
        noBtn.focus();

        function closeDialog() {
            overlay.remove();
        }

        closeBtn.addEventListener('click', closeDialog);
        noBtn.addEventListener('click', closeDialog);

        // Close on overlay backdrop click
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeDialog();
        });

        // Close on Escape
        function escHandler(e) {
            if (e.key === 'Escape') {
                closeDialog();
                document.removeEventListener('keydown', escHandler);
            }
        }
        document.addEventListener('keydown', escHandler);

        yesBtn.addEventListener('click', function () {
            closeDialog();
            delete _mappings[rubricId];
            saveMappings(function () {
                showToast('Checkpoint mapping cleared.');
                document.querySelectorAll('.cpt-mapper-pill').forEach(function (pill) {
                    updatePillAppearance(pill, null);
                });
                clearBtn.setAttribute('disabled', 'disabled');
            });
        });
    }

    function injectClearFooter(rubricId, root) {
        if (document.getElementById('cpt-mapping-footer')) return;

        const scope           = root || document;
        const rubricContainer = scope.getElementById
            ? scope.getElementById('rubric_' + rubricId)
            : document.getElementById('rubric_' + rubricId);
        if (!rubricContainer) return;

        const footer = rubricContainer.querySelector('.rubric-footer');
        if (!footer) return;

        const wrap = document.createElement('div');
        wrap.id            = 'cpt-mapping-footer';
        wrap.style.cssText = 'margin-top:6px;text-align:right;';

        const clearBtn = document.createElement('button');
        clearBtn.type      = 'button';
        clearBtn.id        = 'cpt-mapping-clear-btn';
        clearBtn.className = 'btn btn-default btn-small';
        clearBtn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;';
        clearBtn.innerHTML = '<i class="icon-trash" aria-hidden="true"></i> Clear mapping';

        const entry         = _mappings[rubricId];
        const hasMappingNow = entry && entry.criteria && Object.keys(entry.criteria).length > 0;
        if (!hasMappingNow) clearBtn.setAttribute('disabled', 'disabled');
        clearBtn.addEventListener('click', function () {
            showClearConfirmDialog(rubricId, clearBtn);
        });

        wrap.appendChild(clearBtn);
        footer.appendChild(wrap);
    }

    // ── INDEX PAGE ────────────────────────────────────────────────────────────

    function initIndexPage() {
        loadMappings(function () {
            document.querySelectorAll('#rubrics li.hover-container').forEach(function (li) {
                const titleLink = li.querySelector('a.title');
                if (!titleLink) return;
                const m = (titleLink.getAttribute('href') || '').match(/\/rubrics\/(\d+)/);
                if (!m) return;
                const rubricId = m[1];
                const entry    = _mappings[rubricId];
                if (!entry || !entry.criteria) return;
                // v3.7.0: criteria values are now { assign, index } objects, so
                // the old `v !== 'ignore'` test was always true and the badge
                // appeared even when every criterion was set to Ignore.
                if (!hasRealAssignment(entry)) return;
                const details = li.querySelector('span.details');
                if (!details || details.querySelector('.cpt-mapping-indicator')) return;
                const indicator = document.createElement('span');
                indicator.className     = 'cpt-mapping-indicator';
                indicator.style.cssText = 'display:block;margin-top:3px;font-size:11px;color:#0a7d1a;font-weight:600;';
                indicator.textContent   = '✓ Checkpoint mapped';
                details.appendChild(indicator);
            });
        });
    }

    // ── DETAIL PAGE ───────────────────────────────────────────────────────────

    function initDetailPage() {
        let attempts = 0;
        const poll = setInterval(function () {
            attempts++;
            const rubricId = getRubricIdFromDetail();
            if (!rubricId && attempts < 20) return;
            clearInterval(poll);
            if (!rubricId) return;
            loadMappings(function () {
                // Only show mapping UI if this rubric has been mapped from a
                // checkpointed discussion or SpeedGrader — no proactive injection.
                const entry = _mappings[rubricId];
                if (!entry || !entry.criteria) return;

                // v3.7.0: the criteria list must come from the API before pills
                // can be drawn — it's what distinguishes real criterion rows from
                // Canvas's template row. The discussion page gets this free from
                // the topic API; the detail page has no other source, so it costs
                // one request here.
                const courseId = getCourseId();
                if (!courseId) return;

                // Resolve the course code alongside the criteria — a mapping can
                // be saved as soon as pills exist, and detectCourseName() reads
                // the cached value synchronously.
                Promise.all([
                    fetchRubricCriteria(courseId, rubricId),
                    fetchCourseCode(courseId),
                ]).then(function (results) {
                    const criteria = results[0];
                    if (!criteria || !criteria.length) return;
                    injectCriterionPills(rubricId, null);
                    injectClearFooter(rubricId, null);
                });
            });
        }, 300);
    }

    // ── DISCUSSION PAGE ───────────────────────────────────────────────────────

    function initDiscussionPage() {
        const pathMatch = window.location.pathname.match(/\/courses\/(\d+)\/discussion_topics\/(\d+)/);
        if (!pathMatch) return;
        const courseId = pathMatch[1];
        const topicId  = pathMatch[2];

        fetch('/api/v1/courses/' + courseId + '/discussion_topics/' + topicId)
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.is_checkpointed) return;

                const rubricSettings = data.assignment && data.assignment.rubric_settings;
                const rubricArray    = data.assignment && data.assignment.rubric;
                if (!rubricSettings || !rubricArray || !rubricArray.length) return;

                const rubricId   = String(rubricSettings.id);
                const rubricName = rubricSettings.title || 'Rubric #' + rubricId;

                // Store for use by saveCriterionMapping()
                _discussionRubricMeta = { rubricId: rubricId, rubricName: rubricName };

                // The topic API already carries the authoritative criteria list,
                // so the discussion page needs no extra request to filter out
                // Canvas's template row.
                setCriteria(rubricId, rubricArray);

                // Course code must be cached before a mapping can be saved.
                fetchCourseCode(courseId);

                loadMappings(function () {
                    watchForRubricPanel(rubricId);
                });
            })
            .catch(function (err) {
                console.warn('[CPT] Discussion topic API fetch failed:', err);
            });
    }

    function watchForRubricPanel(rubricId) {
        const targetId = 'rubric_' + rubricId;

        // Attempt immediate injection in case the panel is already open
        tryInjectDiscussion(rubricId, targetId);

        // Watch document.body for new rubric containers being added (e.g. instructor
        // adds a rubric to the discussion after page load — new rubric ID)
        const addObserver = new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                m.addedNodes.forEach(function (node) {
                    if (node.nodeType !== 1) return;
                    // Check if the added node is or contains a rubric container
                    const containers = node.id && /^rubric_\d+$/.test(node.id)
                        ? [node]
                        : Array.from(node.querySelectorAll ? node.querySelectorAll('[id^="rubric_"]') : []);
                    containers.forEach(function (el) {
                        const m2 = /^rubric_(\d+)$/.exec(el.id);
                        if (!m2) return;
                        const newRubricId = m2[1];
                        // Re-fetch topic API to validate is_checkpointed for new rubric
                        refreshDiscussionMeta(newRubricId, function () {
                            tryInjectDiscussion(newRubricId, 'rubric_' + newRubricId);
                            watchDialogAncestor(newRubricId);
                        });
                    });
                });
            });
        });
        addObserver.observe(document.body, { childList: true, subtree: true });

        // Watch the dialog ancestor for aria-hidden changes (open/close panel)
        watchDialogAncestor(rubricId);
    }

    // Poll the rubric container's actual rendered visibility rather than
    // watching for a specific Canvas attribute change. Live debugging
    // showed Canvas's open/close signal here is inconsistent — sometimes
    // style.display, sometimes aria-hidden, sometimes neither reliably,
    // and aria-hidden mutations were also observed on an unrelated
    // page-wide drawer-layout wrapper, not just this dialog. Asking the
    // browser for the actual computed visibility sidesteps needing to
    // know which Canvas-internal mechanism is doing the toggling.
    const _dialogWatchers = {};

    function watchDialogAncestor(rubricId) {
        // Avoid stacking duplicate poll loops if called again for the
        // same rubricId (e.g. when a rubric is swapped on the page).
        if (_dialogWatchers[rubricId]) clearInterval(_dialogWatchers[rubricId]);

        let wasOpen = false;
        const containerId = 'rubric_' + rubricId;

        _dialogWatchers[rubricId] = setInterval(function () {
            const container = document.getElementById(containerId);
            if (!container) { wasOpen = false; return; }

            const dialog = container.closest('.ui-dialog');
            const isOpen = dialog
                ? getComputedStyle(dialog).display !== 'none'
                : getComputedStyle(container).display !== 'none';

            if (isOpen && !wasOpen) {
                // Dialog just became visible — strip stale pills then poll
                // until criterion rows are present before re-injecting.
                container.querySelectorAll('.cpt-mapper-pill-wrap').forEach(function (el) { el.remove(); });
                const footer = document.getElementById('cpt-mapping-footer');
                if (footer) footer.remove();

                let attempts = 0;
                const poll = setInterval(function () {
                    attempts++;
                    const rows = getMappableRows(rubricId, container);
                    if (rows.length > 0) {
                        clearInterval(poll);
                        loadMappings(function () {
                            tryInjectDiscussion(rubricId, containerId);
                        });
                    } else if (attempts > 20) {
                        clearInterval(poll);
                    }
                }, 100);
            }

            wasOpen = isOpen;
        }, 400);
    }

    // Re-fetch the topic API to pick up a newly added rubric, update meta, then callback.
    function refreshDiscussionMeta(newRubricId, cb) {
        const pathMatch = window.location.pathname.match(/\/courses\/(\d+)\/discussion_topics\/(\d+)/);
        if (!pathMatch) return;
        const courseId = pathMatch[1];
        const topicId  = pathMatch[2];

        fetch('/api/v1/courses/' + courseId + '/discussion_topics/' + topicId)
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.is_checkpointed) return;
                const rubricSettings = data.assignment && data.assignment.rubric_settings;
                if (!rubricSettings || String(rubricSettings.id) !== newRubricId) return;
                _discussionRubricMeta = {
                    rubricId:   newRubricId,
                    rubricName: rubricSettings.title || 'Rubric #' + newRubricId,
                };
                // Cache criteria for the newly added rubric too, or
                // getMappableRows() will find nothing and no pills will appear.
                setCriteria(newRubricId, (data.assignment && data.assignment.rubric) || []);
                if (cb) cb();
            })
            .catch(function (err) {
                console.warn('[CPT] refreshDiscussionMeta fetch failed:', err);
            });
    }

    function tryInjectDiscussion(rubricId, targetId) {
        const container = document.getElementById(targetId);
        if (!container) return;

        // Skip hidden template containers
        if (container.id === 'default_rubric') return;
        if (container.closest('#default_rubric')) return;
        if (container.closest('#default_rubric_summary')) return;

        // Guard: already injected
        if (container.querySelector('.cpt-mapper-pill-wrap')) return;

        // Verify real (API-known) rows are present before injecting. Checking
        // raw row count here would pass on a container holding only the template
        // row, and injectCriterionPills() would then draw nothing.
        const rows = getMappableRows(rubricId, container);
        if (!rows.length) return;

        injectCriterionPills(rubricId, container);
        injectClearFooter(rubricId, container);
    }

})();

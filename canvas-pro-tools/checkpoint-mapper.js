// Canvas Pro-Tools — Checkpoint Rubric Mapper (SpeedGrader)
// Injected into: https://*.instructure.com/courses/*/gradebook/speed_grader*
//
// When a checkpoint-enabled discussion has a rubric, this feature injects a
// small mapping pill onto each criterion row in the grading rubric. The
// instructor assigns each criterion to "Reply to Topic", "Required Replies",
// or "Ignore". That mapping is saved per rubric ID in chrome.storage.
//
// When the instructor saves the rubric assessment, scored points are summed by
// checkpoint assignment and written to the checkpoint grade inputs.
//
// Storage key : cpt_checkpoint_mappings
// Structure   : { "<hostname>": { "<rubricId>": {
//                   criteria: { "<criterionId>": { assign, index } },
//                   courseId, courseName, rubricName, createdAt } } }
//
// ─────────────────────────────────────────────────────────────────────────────
// v3.7.0 — rewritten for the NEW SpeedGrader (Enhanced Rubrics).
//
// The new SpeedGrader renders rubrics via Canvas Enhanced Rubrics even when the
// Enhanced Rubrics account feature flag is OFF. Every classic hook this file
// previously relied on is gone: #rubric_full, .rubric_container.assessing,
// #rubric_summary_container, tr[data-testid="rubric-criterion"],
// .save_rubric_button, .graded-points, #speed_grader_checkpoints_mount_point,
// and the rubric_NNNNN element that carried the rubric ID.
//
// Three consequences drove this rewrite:
//
//   1. THE RUBRIC ID IS NOT IN THE DOM. It now comes from the assignment API
//      (rubric_settings.id), which also supplies is_checkpointed, the rubric
//      title, and the authoritative criterion list. init() is therefore async.
//
//   2. MAPPINGS ARE KEYED BY CRITERION ID, NOT INDEX. The API and both DOM
//      surfaces share one ID space (API "_1033" -> SpeedGrader testid
//      "criterion-score-_1033" -> classic rubric page row id "criterion__1033").
//      Index-keying was not merely fragile: on classic rubric pages Canvas
//      renders a template row (criterion_1, "Description of criterion") that
//      does NOT carry .blank, so index 2 mapped to a criterion that does not
//      exist. Validating against the API criteria list removes it by
//      construction. `index` is retained as metadata only — never a key.
//
//   3. THERE IS NO SUMMARY VIEW. Saving unmounts the rubric entirely and the
//      criterion scores go with it (verified: scoreInputs 2 -> 0 on save). The
//      old read-AFTER-save flow is impossible. Auto-fill is now
//      capture-BEFORE-unmount: read the scores synchronously on the Save click
//      while they still exist, hold the totals in memory, then write them once
//      the unmount confirms the save committed.
//
// Read-only summary pills were deleted with the summary view. Pills are visible
// only while the rubric is open. Awaiting feedback before replacing them.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
    'use strict';

    // =========================================================================
    // CONSTANTS
    // =========================================================================

    const MAPPINGS_KEY = 'cpt_checkpoint_mappings';
    const FEATURES_KEY = 'cpt_features';

    const CHECKPOINT_OPTIONS = [
        { value: 'reply_to_topic', label: 'Reply to Topic' },
        { value: 'reply_to_entry', label: 'Required Replies' },
        { value: 'ignore',         label: 'Ignore' },
    ];

    // Pill colours per assignment
    const PILL_STYLES = {
        reply_to_topic: { bg: '#e8f0fe', border: '#6d9eeb', text: '#1a56a0' },
        reply_to_entry: { bg: '#fce8b2', border: '#e6a817', text: '#7a4f00' },
        ignore:         { bg: '#f1f3f4', border: '#c7cdd1', text: '#6b7c8b' },
        unassigned:     { bg: '#fff3cd', border: '#f0ad4e', text: '#856404' },
    };

    // New SpeedGrader (Enhanced Rubrics) selectors. All verified against the
    // live DOM. data-testid is used throughout rather than the css-* classes,
    // which are Emotion hashes that change whenever InstUI's style objects do.
    const SEL = {
        rubricView:   '[data-testid="rubric-assessment-traditional-view"]',
        criterionScore: '[data-testid^="criterion-score-"]',
        saveButton:   '[data-testid="save-rubric-assessment-button"]',
        cancelButton: '[data-testid="cancel-rubric-assessment-button"]',
        topicInput:   '[data-testid="grade-input-reply_to_topic"]',
        entryInput:   '[data-testid="grade-input-reply_to_entry"]',
    };

    // =========================================================================
    // GUARD — feature flag check
    // =========================================================================

    chrome.storage.local.get(FEATURES_KEY, function (result) {
        // cpt_features is namespaced per Canvas instance (hostname), with a
        // legacy flat-shape fallback until popup.js migrates it on disk.
        const allFeatures = (result && result[FEATURES_KEY]) || {};
        const featLegacy  = Object.keys(allFeatures).some(k => typeof allFeatures[k] === 'boolean');
        const features = featLegacy ? allFeatures : (allFeatures[window.location.hostname] || {});
        const enabled  = typeof features.checkpointMapper === 'boolean'
            ? features.checkpointMapper
            : false; // default OFF

        if (!enabled) return;
        init();
    });

    // =========================================================================
    // STORAGE
    // chrome.storage.local[MAPPINGS_KEY] is namespaced per Canvas instance:
    // { "<hostname>": { "<rubricId>": { criteria, courseId, courseName,
    //                                   rubricName, createdAt } } }
    // _mappings holds the slice for THIS instance.
    // =========================================================================

    const INSTANCE_KEY = window.CPT_INSTANCE_KEY || window.location.hostname;

    let _mappings = {};

    // True if `entry` looks like a rubric mapping entry, as opposed to a stray
    // key (e.g. a hostname key nested here by the pre-namespacing flat-write bug).
    function isRubricEntry(entry) {
        return !!(entry && typeof entry === 'object' && entry.criteria);
    }

    function loadMappings(cb) {
        chrome.storage.local.get(MAPPINGS_KEY, function (result) {
            const raw           = (result && result[MAPPINGS_KEY]) || {};
            const instanceSlice = raw[INSTANCE_KEY] || {};

            // Self-heal: drop anything that isn't a real rubric entry so stray
            // or corrupted keys don't get re-saved on the next write.
            //
            // NOTE: pre-3.7.0 index-keyed entries still pass isRubricEntry (they
            // have .criteria) but their criteria values are strings rather than
            // { assign, index } objects. No migration is performed — 3.7.0 is a
            // deliberate clean break and existing mappings are cleared manually
            // via the popup. getCriterionAssign() tolerates the old shape by
            // returning null for it, so stale data degrades to "unassigned"
            // rather than throwing.
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
            const allInstances = (result && result[MAPPINGS_KEY]) || {};
            allInstances[INSTANCE_KEY] = _mappings;
            chrome.storage.local.set({ [MAPPINGS_KEY]: allInstances }, cb);
        });
    }

    // Returns the criteria sub-object for a rubric, or {}
    function getRubricMapping(rubricId) {
        const entry = _mappings[rubricId];
        return (entry && entry.criteria) ? entry.criteria : {};
    }

    function getRubricEntry(rubricId) {
        return _mappings[rubricId] || null;
    }

    // Read a criterion's assignment by criterion ID.
    // Returns null for unmapped criteria and for pre-3.7.0 string-valued
    // entries, so stale data degrades to "unassigned" instead of throwing.
    function getCriterionAssign(rubricId, criterionId) {
        const c = getRubricMapping(rubricId)[criterionId];
        return (c && typeof c === 'object' && c.assign) ? c.assign : null;
    }

    function setCriterionMapping(rubricId, criterionId, index, value) {
        if (!_mappings[rubricId]) {
            _mappings[rubricId] = {
                criteria:   {},
                courseId:   _ctx.courseId,
                courseName: detectCourseName(),
                rubricName: _ctx.rubricName,
                createdAt:  new Date().toISOString().slice(0, 10),
            };
        }
        _mappings[rubricId].criteria[criterionId] = { assign: value, index: index };
        saveMappings(() => showToast('Checkpoint mapping saved'));
    }

    // =========================================================================
    // CONTEXT — populated once by init() from the assignment API
    // =========================================================================

    // { courseId, assignmentId, rubricId, rubricName, criteria: [{id, index, description, points}] }
    let _ctx = null;

    function getCourseId() {
        const m = window.location.pathname.match(/\/courses\/(\d+)/);
        return m ? m[1] : null;
    }

    function getAssignmentId() {
        // window.ENV is not accessible in the isolated world — use URL params only
        return new URLSearchParams(window.location.search).get('assignment_id');
    }

    // Course code, resolved once from the API during init and cached.
    // Populated before any mapping can be saved, so detectCourseName() stays
    // synchronous for its callers.
    let _courseCode = null;

    // The new SpeedGrader renders no breadcrumbs at all (verified: both
    // #breadcrumbs and nav[aria-label="breadcrumb"] are absent), so the old
    // scrape always fell through to "Course <id>" and stored the raw Canvas ID
    // instead of a human-readable code. The course API is the only reliable
    // source here.
    //
    // Fields checked against the live API: course_code exists
    // ("CNVS-SAND-ERIK-GUSTAFSON-1"); short_name does NOT exist on the course
    // object (that's a user field); friendly_name is null unless set.
    function fetchCourseCode(courseId) {
        return fetch(`/api/v1/courses/${courseId}`, { credentials: 'same-origin' })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (c) {
                _courseCode = c.course_code || c.name || null;
                return _courseCode;
            })
            .catch(function (err) {
                console.warn('[Canvas Pro-Tools] checkpoint-mapper: course fetch failed:', err);
                return null;
            });
    }

    function detectCourseName() {
        if (_courseCode) return _courseCode;
        const courseId = getCourseId();
        return courseId ? 'Course ' + courseId : 'Unknown Course';
    }

    // Fetch the assignment and derive everything the feature needs from it:
    // is_checkpointed, rubric ID, rubric title, and the authoritative criteria.
    // The DOM carries none of these any more.
    function fetchContext() {
        const courseId     = getCourseId();
        const assignmentId = getAssignmentId();
        if (!courseId || !assignmentId) return Promise.resolve(null);

        return fetch(`/api/v1/courses/${courseId}/assignments/${assignmentId}`, {
            credentials: 'same-origin',
        })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (a) {
                // Early gate. Non-checkpoint assignments bail here — before any
                // polling or observers are attached.
                //
                // is_checkpointed hangs off the nested discussion_topic object,
                // NOT the assignment root — a.is_checkpointed is always
                // undefined and silently disabled the whole feature in 3.7.0-dev.
                // Ordinary (non-discussion) assignments have no discussion_topic
                // at all, so the optional chain also covers that case.
                const isCheckpointed = !!(a.discussion_topic && a.discussion_topic.is_checkpointed);
                if (!isCheckpointed) return null;

                const settings = a.rubric_settings || {};
                if (!settings.id) return null;

                return {
                    courseId:     courseId,
                    assignmentId: assignmentId,
                    rubricId:     String(settings.id),
                    rubricName:   settings.title || ('Rubric #' + settings.id),
                    // The API is the authority on which criteria exist. The DOM
                    // is only where pills get drawn.
                    criteria: (a.rubric || []).map(function (c, i) {
                        return {
                            id:          c.id,
                            index:       i,
                            description: c.description || '',
                            points:      c.points,
                        };
                    }),
                };
            })
            .catch(function (err) {
                console.error('[Canvas Pro-Tools] checkpoint-mapper: context fetch failed:', err);
                return null;
            });
    }

    // =========================================================================
    // DOM HELPERS
    // =========================================================================

    function getRubricView() {
        return document.querySelector(SEL.rubricView);
    }

    // Map a criterion ID to its score input. The testid suffix IS the criterion
    // ID, so this is a direct lookup — no proximity walking.
    function getScoreInput(criterionId) {
        return document.querySelector(`[data-testid="criterion-score-${CSS.escape(criterionId)}"]`);
    }

    // Walk from a criterion's score input up to its table row.
    function getCriterionRow(criterionId) {
        const input = getScoreInput(criterionId);
        return input ? input.closest('tr') : null;
    }

    // The checkpoint grade inputs. Each now has its own testid, so the old
    // status-select + closest('.css-1265v5l-view--flex-flex') walk is gone.
    function getCheckpointInputs() {
        return {
            topicInput:   document.querySelector(SEL.topicInput),
            repliesInput: document.querySelector(SEL.entryInput),
        };
    }

    // =========================================================================
    // TOAST
    // =========================================================================

    let _toastTimer = null;

    function showToast(msg, duration = 2500) {
        let toast = document.getElementById('cpt-mapper-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'cpt-mapper-toast';
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
        toast.textContent = msg;
        toast.style.opacity = '1';
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, duration);
    }

    // =========================================================================
    // PILL BUILDER
    // =========================================================================

    function buildPill(rubricId, criterionId, index, currentValue) {
        const wrap = document.createElement('span');
        wrap.className = 'cpt-mapper-pill-wrap';
        wrap.style.cssText = 'display:inline-block;margin-top:5px;position:relative;';

        const pill = document.createElement('button');
        pill.type = 'button';
        pill.dataset.rubricId      = rubricId;
        pill.dataset.criterionId   = criterionId;
        pill.dataset.criterionIndex = index;
        pill.className = 'cpt-mapper-pill';

        updatePillAppearance(pill, currentValue);

        pill.addEventListener('click', function (e) {
            e.stopPropagation();
            e.preventDefault();
            openPillDropdown(pill, rubricId, criterionId, index);
        });

        wrap.appendChild(pill);
        return wrap;
    }

    function updatePillAppearance(pill, value) {
        const styleKey = value || 'unassigned';
        const s = PILL_STYLES[styleKey] || PILL_STYLES.unassigned;
        const option = CHECKPOINT_OPTIONS.find(o => o.value === value);
        const label  = option ? option.label : 'Unassigned';

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
            `background: ${s.bg}`,
            `border: 1px solid ${s.border}`,
            `color: ${s.text}`,
            'cursor: pointer',
            'white-space: nowrap',
            'line-height: 1.6',
        ].join(';');
    }

    // =========================================================================
    // PILL DROPDOWN
    // =========================================================================

    let _activePillDropdown = null;

    function closePillDropdown() {
        if (_activePillDropdown) {
            _activePillDropdown.remove();
            _activePillDropdown = null;
        }
    }

    function openPillDropdown(pill, rubricId, criterionId, index) {
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
            const item = document.createElement('div');
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
                setCriterionMapping(rubricId, criterionId, index, opt.value);
                updatePillAppearance(pill, opt.value);
                closePillDropdown();
                updateNoticeState(rubricId);
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

    // =========================================================================
    // INJECT PILLS INTO THE RUBRIC
    //
    // Iterates the API criteria list rather than DOM rows: the API is
    // authoritative about which criteria exist, so template/phantom rows can't
    // be picked up. Each criterion is located via its score input's testid.
    // =========================================================================

    function injectPills(rubricId) {
        if (!_ctx) return;

        _ctx.criteria.forEach(function (crit) {
            const row = getCriterionRow(crit.id);
            if (!row) return;                                    // not rendered yet
            if (row.querySelector('.cpt-mapper-pill-wrap')) return; // already injected

            // First cell holds the criterion description and the
            // "view longer description" button. The pill goes under it.
            const descCell = row.querySelector('td');
            if (!descCell) return;

            const anchor = descCell.querySelector('div') || descCell;

            const currentValue = getCriterionAssign(rubricId, crit.id);
            const pillWrap = buildPill(rubricId, crit.id, crit.index, currentValue);
            anchor.appendChild(pillWrap);
        });
    }

    function removePills() {
        document.querySelectorAll('.cpt-mapper-pill-wrap').forEach(el => el.remove());
    }

    // =========================================================================
    // UNSET MAPPING NOTICE
    // =========================================================================

    // Place the notice directly beneath Canvas's own "Rubrics do not
    // auto-populate grades for checkpoints" alert — the two say related things,
    // and the original fallback wedged this between the Reply to Topic grade box
    // and its Status dropdown, splitting a field group.
    //
    // Returns the alert element Canvas renders above the comment box, or null.
    // The class match uses the "-view-alert" suffix rather than the full Emotion
    // hash (css-1hhuh5m-view-alert): the suffix is InstUI's component name and
    // survives style-object changes; the hash does not. The leading hyphen keeps
    // it from matching component names that merely contain "view-alert".
    function getRubricAlert() {
        const host = document.querySelector('[data-testid="assessment"]');
        return host ? host.querySelector('[class*="-view-alert"]') : null;
    }

    function buildNoticeEl() {
        const notice = document.createElement('div');
        notice.id = 'cpt-mapper-notice';
        notice.style.cssText = [
            'margin: 6px 0',
            'padding: 5px 8px',
            'background: #fff8e1',
            'border: 1px solid #f0c040',
            'border-radius: 4px',
            'font-family: Lato, sans-serif',
            'font-size: 11px',
            'color: #6b4f00',
            'line-height: 1.5',
        ].join(';');
        notice.textContent = '⚠️ Checkpoint mapping not configured — open the rubric and assign each criterion to a checkpoint using the pill below the criterion name.';
        return notice;
    }

    // Place the notice directly beneath Canvas's "Rubrics do not auto-populate
    // grades for checkpoints" alert.
    //
    // This is written as a repair function rather than a one-shot injection
    // because the placement kept drifting: inject once and the notice ends up
    // stranded next to Discussion Insights, at the top of the panel, or below the
    // comment box, differing per refresh with the same code. The notice itself
    // does NOT move once the page settles — but the panel is still restructuring
    // around it at injection time, so whatever position was correct at that
    // instant isn't correct a moment later. Waiting for the alert to exist wasn't
    // enough; there's no reliable signal for "the panel has finished rendering".
    //
    // So instead of racing: check adjacency, and correct it whenever it's wrong.
    // Cheap (two DOM reads), idempotent, and survives however many re-renders
    // Canvas decides to do.
    //
    // Returns true when the notice is correctly placed.
    function repairNotice() {
        const alertEl = getRubricAlert();
        if (!alertEl || !alertEl.parentElement) return false; // alert not rendered yet

        let notice = document.getElementById('cpt-mapper-notice');
        if (!notice) notice = buildNoticeEl();

        // Already correct — do nothing. Re-inserting unconditionally would
        // retrigger the observer and spin.
        if (notice.previousElementSibling === alertEl && notice.parentElement === alertEl.parentElement) {
            return true;
        }

        alertEl.parentElement.insertBefore(notice, alertEl.nextSibling);
        return true;
    }

    function removeUnsetNotice() {
        const el = document.getElementById('cpt-mapper-notice');
        if (el) el.remove();
    }

    // Completeness is now measured against the API criteria list, so it no
    // longer depends on the rubric being open. The old "null = unknown"
    // sentinel is gone: we always know how many criteria exist.
    function isMappingComplete(rubricId) {
        if (!_ctx || !_ctx.criteria.length) return false;
        return _ctx.criteria.every(function (c) {
            return !!getCriterionAssign(rubricId, c.id);
        });
    }

    // Keeps the notice correctly placed for as long as it should be shown.
    //
    // A poll was tried first and wasn't enough: it could only decide placement
    // once, and whatever was correct at that instant stopped being correct as the
    // panel finished rendering. An observer re-checks after every mutation, so a
    // stranded notice gets pulled back under the alert automatically.
    let _noticeObserver = null;
    let _noticeRaf      = null;

    function stopNoticeWatch() {
        if (_noticeObserver) { _noticeObserver.disconnect(); _noticeObserver = null; }
        if (_noticeRaf) { cancelAnimationFrame(_noticeRaf); _noticeRaf = null; }
    }

    function updateNoticeState(rubricId) {
        if (isMappingComplete(rubricId)) {
            stopNoticeWatch();
            removeUnsetNotice();
            return;
        }

        repairNotice(); // immediate attempt; no-ops if the alert isn't up yet
        if (_noticeObserver) return; // already watching

        const anchor = document.getElementById('application') || document.body;
        _noticeObserver = new MutationObserver(function () {
            // Coalesce bursts of mutations into one repair per frame. Our own
            // insertBefore also mutates, so this keeps the observer from
            // reacting to itself in a tight loop.
            if (_noticeRaf) return;
            _noticeRaf = requestAnimationFrame(function () {
                _noticeRaf = null;
                if (isMappingComplete(rubricId)) {
                    stopNoticeWatch();
                    removeUnsetNotice();
                    return;
                }
                repairNotice();
            });
        });
        _noticeObserver.observe(anchor, { childList: true, subtree: true });
    }

    // =========================================================================
    // AUTO-FILL CHECKPOINT INPUTS
    // =========================================================================

    // React-safe value setter. Verified still working in the new SpeedGrader:
    // the controlled inputs need focus + an InputEvent carrying inputType, plus
    // a keyboard Enter to commit. Plain Event dispatches don't reach React's
    // internal state and the grade won't persist.
    function setReactInputValue(input, value) {
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        ).set;

        input.focus();
        nativeSetter.call(input, value);
        input.dispatchEvent(new InputEvent('input', {
            bubbles:   true,
            inputType: 'insertText',
            data:      value,
        }));
        input.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13,
        }));
        input.dispatchEvent(new KeyboardEvent('keyup', {
            bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13,
        }));
    }

    // Read the criterion scores straight out of the rubric's inputs.
    // MUST run while the rubric is still mounted — saving unmounts it and takes
    // the scores with it. Called synchronously from the Save click handler.
    function captureScores(rubricId) {
        if (!_ctx) return null;

        const totals = { reply_to_topic: 0, reply_to_entry: 0 };
        let hasUnassigned = false;
        let sawAnyInput   = false;

        _ctx.criteria.forEach(function (crit) {
            const assign = getCriterionAssign(rubricId, crit.id);
            if (!assign) { hasUnassigned = true; return; }
            if (assign === 'ignore') return;

            const input = getScoreInput(crit.id);
            if (!input) return;
            sawAnyInput = true;

            // Empty input means the grader left the criterion unscored; treat
            // as 0 rather than aborting the whole fill.
            const pts = parseFloat(input.value);
            if (!isNaN(pts)) totals[assign] += pts;
        });

        return { totals, hasUnassigned, sawAnyInput };
    }

    function writeCheckpoints(captured) {
        if (!captured) return;

        if (captured.hasUnassigned) {
            showToast('⚠️ Mapping incomplete — checkpoint grades not updated', 3500);
            return;
        }

        const { topicInput, repliesInput } = getCheckpointInputs();
        if (!topicInput && !repliesInput) {
            showToast('⚠️ Checkpoint inputs not found — grades not updated', 3500);
            return;
        }

        if (topicInput) {
            setReactInputValue(topicInput, String(captured.totals.reply_to_topic));
        }
        // Stagger the second write so React can settle the first input's state
        // before the second commits.
        setTimeout(function () {
            if (repliesInput) {
                setReactInputValue(repliesInput, String(captured.totals.reply_to_entry));
            }
            showToast('✓ Checkpoint grades updated from rubric');
        }, 1200);
    }

    // =========================================================================
    // RUBRIC LIFECYCLE
    //
    // The rubric panel mounts and unmounts; it is not shown/hidden via
    // style.display as in classic SpeedGrader, so there is no stable node to
    // watch attributes on. A single observer on a stable ancestor tracks the
    // panel's presence instead.
    //
    // Save flow (capture-before-unmount):
    //   1. Save click  -> capture scores synchronously (rubric still mounted)
    //   2. Rubric unmounts -> save committed
    //   3. Write totals to the checkpoint inputs (they survive the unmount)
    //
    // Cancel discards the captured scores so a cancelled assessment can't write.
    // =========================================================================

    let _pendingCapture = null;

    function watchRubricLifecycle(rubricId) {
        // #application survives SpeedGrader's SPA navigation; body is the
        // fallback. Either outlives the rubric panel itself.
        const anchor = document.getElementById('application') || document.body;

        let wasMounted = !!getRubricView();

        // Delegated at the document level: the Save button lives inside the
        // panel that is about to unmount, so binding to it directly would mean
        // re-binding on every mount. Capture phase runs before React's own
        // handler, guaranteeing the scores are read while still in the DOM.
        document.addEventListener('click', function (e) {
            if (!e.target || !e.target.closest) return;

            if (e.target.closest(SEL.saveButton)) {
                _pendingCapture = captureScores(rubricId);
            } else if (e.target.closest(SEL.cancelButton)) {
                _pendingCapture = null;
            }
        }, true);

        const observer = new MutationObserver(function () {
            const isMounted = !!getRubricView();
            if (isMounted === wasMounted) return;
            wasMounted = isMounted;

            if (isMounted) {
                // Rubric opened — inject pills once the criterion rows render.
                _pendingCapture = null;
                waitForCriteriaThenInject(rubricId);
            } else {
                // Rubric closed. Pills went with it; only write if Save was the
                // cause (cancel nulls the capture).
                if (!_pendingCapture) return;
                const captured = _pendingCapture;
                _pendingCapture = null;
                writeCheckpoints(captured);
            }
        });

        observer.observe(anchor, { childList: true, subtree: true });

        // The rubric may already be open at init time.
        if (wasMounted) waitForCriteriaThenInject(rubricId);
    }

    // Criterion rows render lazily after the panel mounts, so poll briefly for
    // the first score input rather than assuming they're present.
    function waitForCriteriaThenInject(rubricId) {
        let attempts = 0;
        const poll = setInterval(function () {
            attempts++;
            if (document.querySelector(SEL.criterionScore)) {
                clearInterval(poll);
                injectPills(rubricId);
                updateNoticeState(rubricId);
            } else if (attempts > 20) {
                clearInterval(poll); // give up after ~2s
            }
        }, 100);
    }

    // =========================================================================
    // STUDENT NAVIGATION
    // SpeedGrader uses pushState; content scripts don't re-run on in-app
    // navigation. The rubric ID and criteria don't change between students of
    // the same assignment, so only the injected UI needs resetting.
    // =========================================================================

    function watchStudentNavigation(rubricId) {
        let lastStudentId = new URLSearchParams(window.location.search).get('student_id');

        const origPushState = history.pushState.bind(history);
        history.pushState = function (...args) {
            origPushState(...args);
            onNavigate();
        };
        window.addEventListener('popstate', onNavigate);

        function onNavigate() {
            const newStudentId = new URLSearchParams(window.location.search).get('student_id');
            if (newStudentId === lastStudentId) return;
            lastStudentId = newStudentId;

            // Discard any capture in flight — it belongs to the previous student.
            _pendingCapture = null;

            setTimeout(function () {
                removePills();
                loadMappings(function () {
                    updateNoticeState(rubricId);
                    if (getRubricView()) waitForCriteriaThenInject(rubricId);
                });
            }, 600);
        }
    }

    // =========================================================================
    // INIT
    // Async: the rubric ID, checkpoint status, and criteria all come from the
    // assignment API now — none of them are in the DOM.
    // =========================================================================

    function init() {
        fetchContext().then(function (ctx) {
            if (!ctx) return; // not a checkpointed assignment, or no rubric
            _ctx = ctx;

            // Resolve the course code before wiring anything up: a mapping can
            // be saved as soon as pills exist, and detectCourseName() reads the
            // cached value synchronously. Deliberately after the is_checkpointed
            // gate so ordinary assignments cost no extra request.
            return fetchCourseCode(ctx.courseId).then(function () {
                loadMappings(function () {
                    updateNoticeState(_ctx.rubricId);
                    watchRubricLifecycle(_ctx.rubricId);
                    watchStudentNavigation(_ctx.rubricId);
                });
            });
        });
    }

})();
